import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonValue } from "@dexter/contracts";
import {
  ConversationRuntime, HostError, HostStore, ShutdownIncompleteError,
  type RuntimeDriver, type RuntimeEngineEvent, type RuntimeOpenContext, type RuntimeOptions, type RuntimeSession,
  type RuntimeSessionReuse,
} from "@dexter/hub";

// G3: drivers declaring `sessionReuse: "turn"` get a fresh session per turn, opened from the last confirmed
// cursor once the turn is running, and always closed (and drained) before the thread moves on.

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
type Ctx = { after: (fn: () => void | Promise<void>) => void };
interface Gate { promise: Promise<void>; release: () => void }
function gate(): Gate {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** Synthetic driver: no engine, no process. Inputs: `echo` completes, `fail` fails, `gate` waits for abort. */
class TurnDriver implements RuntimeDriver {
  readonly id = "claude" as const;
  readonly log: string[] = [];
  readonly opens: Array<{ threadId: string; cursor: string | undefined; context: RuntimeOpenContext | undefined; args: number }> = [];
  readonly open_ = new Set<string>();
  readonly closed = new Set<string>();
  openGate: Gate | null = null;
  closeGate: Gate | null = null;
  closeDelayMs = 0;
  /** A close that fails (asynchronously or synchronously) without having stopped the session. */
  closeFailure: "reject" | "throw" | null = null;
  /** Open result override (e.g. a session for another thread). */
  openResult: ((threadId: string, id: string) => RuntimeSession) | null = null;
  onOpen: (threadId: string, context: RuntimeOpenContext | undefined) => void = () => {};
  readonly sessionReuse?: RuntimeSessionReuse;
  private serial = 0;
  constructor(sessionReuse?: RuntimeSessionReuse) { if (sessionReuse) this.sessionReuse = sessionReuse; }

  async open(threadId: string, nativeCursor?: string, context?: RuntimeOpenContext): Promise<RuntimeSession> {
    this.opens.push({ threadId, cursor: nativeCursor, context, args: arguments.length });
    this.onOpen(threadId, context);
    this.serial += 1;
    const id = `s${this.serial}`;
    this.log.push(`open:${id}:${nativeCursor ?? "-"}`);
    if (this.openGate) await this.openGate.promise;
    this.open_.add(id);
    return this.openResult ? this.openResult(threadId, id) : { threadId, nativeCursor: id };
  }
  async *turn(session: RuntimeSession, turnId: string, input: string, signal: AbortSignal): AsyncGenerator<RuntimeEngineEvent> {
    const { threadId, nativeCursor: id } = session;
    assert.ok(this.open_.has(id) && !this.closed.has(id), "turn runs on an open session");
    this.log.push(`turn:${id}`);
    yield { type: "text.delta", threadId, turnId, text: input };
    if (input === "fail") { yield { type: "turn.failed", threadId, turnId, code: "engine_failed" }; return; }
    if (input === "gate") {
      await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      yield { type: "turn.interrupted", threadId, turnId };
      return;
    }
    yield { type: "turn.completed", threadId, turnId, usage: null };
  }
  async respondToTool(_session: RuntimeSession, _turnId: string, _requestId: string, _result: JsonValue): Promise<void> {}
  async interrupt(): Promise<void> {}
  close(session: RuntimeSession): Promise<void> {
    this.log.push(`close:${session.nativeCursor}`);
    if (this.closeFailure === "throw") throw new Error("close_failed");
    if (this.closeFailure === "reject") return Promise.reject(new Error("close_failed"));
    return this.closeAsync(session);
  }
  private async closeAsync(session: RuntimeSession): Promise<void> {
    if (this.closeDelayMs > 0) await delay(this.closeDelayMs);
    if (this.closeGate) await this.closeGate.promise;
    this.closed.add(session.nativeCursor);
    this.log.push(`closed:${session.nativeCursor}`);
  }
  /** Sessions opened and not yet closed. */
  live(): number { return [...this.open_].filter((id) => !this.closed.has(id)).length; }
}

function setup(t: Ctx, driver: TurnDriver, extra: Partial<RuntimeOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dexter-turn-binding-"));
  const store = new HostStore({ dataDir: dir });
  const runtime = new ConversationRuntime({ store, drivers: [driver], abortGraceMs: 100, approvalPollMs: 5, ...extra });
  t.after(async () => {
    driver.openGate?.release();
    driver.closeGate?.release();
    await runtime.shutdown({ graceMs: 500 }).catch(() => store.close());
    rmSync(dir, { recursive: true, force: true });
  });
  const bot = store.createBot({ name: "General", profileId: "personal", engine: "claude" });
  const thread = store.createThread(bot.id);
  const start = (threadId: string, clientRequestId: string, content: string) =>
    runtime.startTurn(threadId, { clientRequestId, content }).turn;
  const until = async (check: () => boolean): Promise<void> => { while (!check()) await delay(2); };
  return { dir, store, runtime, bot, thread, start, until };
}

test("per-turn driver opens a fresh session for each turn from the last confirmed cursor", { timeout: 10_000 }, async (t) => {
  const driver = new TurnDriver("turn");
  const { store, runtime, thread, start, until } = setup(t, driver);
  const states: string[] = [];
  driver.onOpen = (_threadId, context) => { if (context) states.push(store.getTurn(context.turnId).state); };
  const a = start(thread.id, "a", "echo");
  const b = start(thread.id, "b", "fail");
  const c = start(thread.id, "c", "echo");
  const d = start(thread.id, "d", "echo");
  const done = [await runtime.waitForTurn(a.id), await runtime.waitForTurn(b.id), await runtime.waitForTurn(c.id), await runtime.waitForTurn(d.id)];
  assert.deepEqual(done.map((turn) => turn.state), ["completed", "failed", "completed", "completed"]);
  await until(() => runtime.status().pending.sessions === 0 && runtime.status().pending.turns === 0);

  // One open per turn, with the real (claimed, running) turn id and a live signal.
  assert.deepEqual(driver.opens.map((o) => o.context?.turnId), [a.id, b.id, c.id, d.id]);
  assert.deepEqual(states, ["running", "running", "running", "running"]);
  assert.ok(driver.opens.every((o) => o.context?.signal instanceof AbortSignal && o.args === 3));
  // Cursor only advances on completion: the failed turn's session (s2) is never resumed.
  assert.deepEqual(driver.opens.map((o) => o.cursor), [undefined, "s1", "s1", "s3"]);
  assert.equal(store.getThreadSession(thread.id)!.nativeCursor, "s4");
  // Every session closed, including the completed ones; nothing left open.
  assert.deepEqual([...driver.closed].sort(), ["s1", "s2", "s3", "s4"]);
  assert.equal(driver.live(), 0);
  const status = runtime.status();
  assert.deepEqual([status.openSessions, status.pending.sessions], [0, 0]);
});

test("each per-turn session is closed before the next turn of the thread opens", { timeout: 10_000 }, async (t) => {
  const driver = new TurnDriver("turn");
  const { runtime, thread, start, until } = setup(t, driver);
  driver.closeDelayMs = 40; // async close, like a driver tearing down a process
  const turns = ["a", "b", "c"].map((id) => start(thread.id, id, "echo"));
  for (const turn of turns) assert.equal((await runtime.waitForTurn(turn.id)).state, "completed");
  // The terminal state is visible before the last close settles; that close is pending meanwhile.
  await until(() => runtime.status().pending.sessions === 0 && runtime.status().pending.turns === 0);
  assert.deepEqual(driver.log, [
    "open:s1:-", "turn:s1", "close:s1", "closed:s1",
    "open:s2:s1", "turn:s2", "close:s2", "closed:s2",
    "open:s3:s2", "turn:s3", "close:s3", "closed:s3",
  ]);
});

test("an unresponsive close after a completed turn holds the thread, lease and status until it settles", { timeout: 10_000 }, async (t) => {
  const driver = new TurnDriver("turn");
  const { dir, store, runtime, thread, start, until } = setup(t, driver);
  const hold = gate();
  driver.closeGate = hold;
  const first = start(thread.id, "a", "echo");
  assert.equal((await runtime.waitForTurn(first.id)).state, "completed");
  assert.equal(store.getThreadSession(thread.id)!.nativeCursor, "s1");
  await until(() => runtime.status().pending.turns === 0);
  const status = runtime.status();
  assert.deepEqual([status.openSessions, status.pending.sessions], [0, 1]);

  const second = start(thread.id, "b", "echo");
  await delay(150); // well past abortGraceMs: the close is still pending
  assert.equal(store.getTurn(second.id).state, "queued");
  assert.equal(driver.opens.length, 1);

  const error = await runtime.shutdown({ graceMs: 30 }).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof ShutdownIncompleteError);
  assert.deepEqual([error.pending.sessions, error.pending.turns], [1, 0]);
  assert.throws(() => new HostStore({ dataDir: dir }), (e: unknown) => e instanceof HostError && e.code === "host_locked");

  hold.release();
  await runtime.shutdown({ graceMs: 500 });
  assert.equal(runtime.status().state, "closed");
  assert.deepEqual([...driver.closed], ["s1"]);
  const reopened = new HostStore({ dataDir: dir });
  t.after(() => reopened.close());
  assert.equal(reopened.getTurn(second.id).state, "queued"); // never ran; held for the next process
  assert.equal(runtime.status().pending.sessions, 0);
});

test("an unresponsive close releases the thread to the next turn once it settles", { timeout: 10_000 }, async (t) => {
  const driver = new TurnDriver("turn");
  const { store, runtime, thread, start } = setup(t, driver);
  const hold = gate();
  driver.closeGate = hold;
  const first = start(thread.id, "a", "echo");
  const second = start(thread.id, "b", "echo");
  assert.equal((await runtime.waitForTurn(first.id)).state, "completed");
  await delay(150);
  assert.equal(store.getTurn(second.id).state, "queued");
  driver.closeGate = null;
  hold.release();
  assert.equal((await runtime.waitForTurn(second.id)).state, "completed");
  assert.deepEqual(driver.opens.map((o) => o.cursor), [undefined, "s1"]);
  assert.ok(driver.log.indexOf("closed:s1") < driver.log.indexOf("open:s2:s1"));
});

test("cancel while a per-turn session is opening closes the late session before the thread continues", { timeout: 10_000 }, async (t) => {
  const driver = new TurnDriver("turn");
  const { store, runtime, thread, start, until } = setup(t, driver);
  const opening = gate();
  driver.openGate = opening;
  const turn = start(thread.id, "a", "echo");
  await until(() => driver.opens.length === 1);
  assert.equal(runtime.status().openSessions, 0);
  runtime.cancelTurn(turn.id);
  const done = await runtime.waitForTurn(turn.id);
  assert.deepEqual([done.state, done.code], ["interrupted", "cancelled"]);
  assert.equal(driver.opens[0]!.context!.signal.aborted, true, "open received the turn's signal");
  assert.equal(runtime.status().pending.sessions, 1, "the late open is still pending");

  const next = start(thread.id, "b", "echo");
  await delay(30);
  assert.equal(store.getTurn(next.id).state, "queued");
  driver.openGate = null;
  opening.release();
  assert.equal((await runtime.waitForTurn(next.id)).state, "completed");
  assert.ok(driver.closed.has("s1"), "the late session was closed");
  assert.ok(driver.log.indexOf("closed:s1") < driver.log.indexOf("open:s2:-"));
  assert.ok(!driver.log.includes("turn:s1"), "the late session never ran the cancelled input");
  assert.equal(store.getThreadSession(thread.id)!.nativeCursor, "s2");
});

test("per-turn sessions of different threads run in parallel and are counted while active", { timeout: 10_000 }, async (t) => {
  const driver = new TurnDriver("turn");
  const { store, runtime, bot, thread, start, until } = setup(t, driver);
  const other = store.createThread(bot.id);
  const a = start(thread.id, "a", "gate");
  const b = start(other.id, "b", "gate");
  await until(() => driver.log.filter((line) => line.startsWith("turn:")).length === 2);
  let status = runtime.status();
  assert.deepEqual([status.activeTurns.length, status.openSessions, status.pending.sessions], [2, 2, 0]);
  runtime.cancelTurn(a.id);
  runtime.cancelTurn(b.id);
  assert.equal((await runtime.waitForTurn(a.id)).state, "interrupted");
  assert.equal((await runtime.waitForTurn(b.id)).state, "interrupted");
  await until(() => runtime.status().pending.turns === 0 && runtime.status().pending.sessions === 0);
  status = runtime.status();
  assert.equal(status.openSessions, 0);
  assert.equal(driver.live(), 0);
  assert.deepEqual(new Set(driver.opens.map((o) => o.threadId)), new Set([thread.id, other.id]));
});

test("shutdown during a per-turn turn with a stuck close keeps the lease; a retry finishes after it settles", { timeout: 10_000 }, async (t) => {
  const driver = new TurnDriver("turn");
  const { dir, runtime, thread, start, until } = setup(t, driver);
  const turn = start(thread.id, "a", "gate");
  await until(() => driver.log.includes("turn:s1"));
  const hold = gate();
  driver.closeGate = hold;
  const error = await runtime.shutdown({ graceMs: 50 }).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof ShutdownIncompleteError);
  assert.equal(error.pending.sessions, 1);
  assert.equal(runtime.status().state, "draining");
  assert.deepEqual([runtime.getTurn(turn.id).state, runtime.getTurn(turn.id).code], ["interrupted", "shutdown"]);
  assert.throws(() => new HostStore({ dataDir: dir }), (e: unknown) => e instanceof HostError && e.code === "host_locked");
  await assert.rejects(runtime.shutdown({ graceMs: 20 }), ShutdownIncompleteError);

  hold.release();
  await runtime.shutdown({ graceMs: 500 });
  assert.equal(runtime.status().state, "closed");
  assert.equal(driver.live(), 0);
  const reopened = new HostStore({ dataDir: dir });
  reopened.close();
});

test("drivers without sessionReuse keep one cached session per thread (default unchanged)", { timeout: 10_000 }, async (t) => {
  const driver = new TurnDriver();
  const { runtime, thread, start } = setup(t, driver);
  const turns = ["a", "b", "c"].map((id) => start(thread.id, id, "echo"));
  for (const turn of turns) assert.equal((await runtime.waitForTurn(turn.id)).state, "completed");
  assert.equal(driver.opens.length, 1);
  assert.equal(driver.opens[0]!.args, 3);
  assert.equal(driver.opens[0]!.context?.turnId, turns[0]!.id);
  assert.deepEqual(driver.opens[0]!.context?.selection, { engine: "claude", model: null, reasoningEffort: null, speed: null });
  assert.deepEqual(driver.log, ["open:s1:-", "turn:s1", "turn:s1", "turn:s1"]);
  assert.equal(runtime.status().openSessions, 1);
});

// A close that rejects or throws proves nothing about the session having stopped: background work of the
// driver may still be live. Such sessions are quarantined for the life of the process.

/** Background work a driver keeps running after its failed close (e.g. a child process still writing). */
function liveEffect(ms: number): { live: () => boolean; effects: () => number; done: Promise<void> } {
  let live = true;
  let effects = 0;
  const done = delay(ms).then(() => { effects += 1; live = false; });
  return { live: () => live, effects: () => effects, done };
}

for (const failure of ["reject", "throw"] as const) {
  test(`a per-turn close that ${failure}s after a completed turn quarantines thread, writer and shutdown`, { timeout: 10_000 }, async (t) => {
    const driver = new TurnDriver("turn");
    const { dir, store, runtime, thread, start, until } = setup(t, driver, { abortGraceMs: 10 });
    driver.closeFailure = failure;
    const effect = liveEffect(80);
    const first = start(thread.id, "a", "echo");
    assert.equal((await runtime.waitForTurn(first.id)).state, "completed");
    assert.equal(store.getThreadSession(thread.id)!.nativeCursor, "s1"); // the confirmed cursor still advances
    await until(() => runtime.status().pending.turns === 0);
    assert.deepEqual([runtime.status().openSessions, runtime.status().pending.sessions], [0, 1]);

    const second = start(thread.id, "b", "echo");
    await delay(40);
    assert.ok(effect.live(), "background work outlives the failed close");
    assert.equal(store.getTurn(second.id).state, "queued");
    assert.equal(driver.opens.length, 1, "no new session while the failed one may still be live");
    const error = await runtime.shutdown({ graceMs: 20 }).then(() => null, (e: unknown) => e);
    assert.ok(error instanceof ShutdownIncompleteError);
    assert.deepEqual([error.pending.sessions, error.pending.turns], [1, 0]);
    assert.throws(() => new HostStore({ dataDir: dir }), (e: unknown) => e instanceof HostError && e.code === "host_locked");

    // Nothing proves the drain even once the work happens to end: still quarantined, never closed twice.
    await effect.done;
    await delay(30);
    assert.equal(effect.effects(), 1);
    await assert.rejects(runtime.shutdown({ graceMs: 20 }), ShutdownIncompleteError);
    assert.equal(runtime.status().state, "draining");
    assert.throws(() => new HostStore({ dataDir: dir }), (e: unknown) => e instanceof HostError && e.code === "host_locked");
    assert.equal(store.getTurn(second.id).state, "queued");
    assert.deepEqual(driver.log.filter((line) => line.startsWith("close:")), ["close:s1"]);
    assert.equal(driver.opens.length, 1);
  });
}

test("a failed close quarantines only its own thread; other threads keep running", { timeout: 10_000 }, async (t) => {
  const driver = new TurnDriver("turn");
  const { store, runtime, bot, thread, start, until } = setup(t, driver, { abortGraceMs: 10 });
  driver.closeFailure = "reject";
  assert.equal((await runtime.waitForTurn(start(thread.id, "a", "echo").id)).state, "completed");
  await until(() => driver.log.includes("close:s1"));
  driver.closeFailure = null;
  const stuck = start(thread.id, "b", "echo");
  const other = store.createThread(bot.id);
  assert.equal((await runtime.waitForTurn(start(other.id, "c", "echo").id)).state, "completed");
  await delay(30);
  assert.equal(store.getTurn(stuck.id).state, "queued");
  assert.equal(runtime.status().pending.sessions, 1);
});

test("a failed close of a cached session (failed turn, or shutdown) keeps the thread and the writer", { timeout: 10_000 }, async (t) => {
  const driver = new TurnDriver();
  const { dir, store, runtime, bot, thread, start, until } = setup(t, driver, { abortGraceMs: 10 });
  driver.closeFailure = "reject";
  // A failed turn closes the cached session; the failed close blocks the thread.
  assert.equal((await runtime.waitForTurn(start(thread.id, "a", "fail").id)).state, "failed");
  const next = start(thread.id, "b", "echo");
  await until(() => runtime.status().pending.turns === 0);
  await delay(30);
  assert.equal(store.getTurn(next.id).state, "queued");
  // A completed turn keeps its cached session open; shutdown closes it, and that close throws.
  const other = store.createThread(bot.id);
  assert.equal((await runtime.waitForTurn(start(other.id, "c", "echo").id)).state, "completed");
  driver.closeFailure = "throw";
  const error = await runtime.shutdown({ graceMs: 30 }).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof ShutdownIncompleteError);
  assert.equal(error.pending.sessions, 2);
  assert.throws(() => new HostStore({ dataDir: dir }), (e: unknown) => e instanceof HostError && e.code === "host_locked");
});

test("a late per-turn session whose close fails keeps the thread quarantined", { timeout: 10_000 }, async (t) => {
  const driver = new TurnDriver("turn");
  const { store, runtime, thread, start, until } = setup(t, driver, { abortGraceMs: 10 });
  const opening = gate();
  driver.openGate = opening;
  driver.closeFailure = "reject";
  const turn = start(thread.id, "a", "echo");
  await until(() => driver.opens.length === 1);
  runtime.cancelTurn(turn.id);
  assert.equal((await runtime.waitForTurn(turn.id)).state, "interrupted");
  const next = start(thread.id, "b", "echo");
  driver.openGate = null;
  opening.release();
  await until(() => driver.log.includes("close:s1"));
  await delay(30);
  assert.equal(store.getTurn(next.id).state, "queued");
  assert.equal(runtime.status().pending.sessions, 1);
  await assert.rejects(runtime.shutdown({ graceMs: 20 }), ShutdownIncompleteError);
});

test("an invalid per-turn session fails its turn on time while its hung close holds thread and writer", { timeout: 10_000 }, async (t) => {
  const driver = new TurnDriver("turn");
  const { dir, store, runtime, thread, start, until } = setup(t, driver, { abortGraceMs: 10, turnTimeoutMs: 20 });
  driver.openResult = (_threadId, id) => ({ threadId: "another-thread", nativeCursor: id });
  const hold = gate();
  driver.closeGate = hold;
  const turn = start(thread.id, "a", "echo");
  const done = await runtime.waitForTurn(turn.id, 1_000);
  assert.deepEqual([done.state, done.code], ["failed", "protocol_error"]);
  await until(() => runtime.status().pending.turns === 0);
  assert.equal(runtime.status().pending.sessions, 1);
  driver.openResult = null;
  const next = start(thread.id, "b", "echo");
  await delay(40);
  assert.equal(store.getTurn(next.id).state, "queued");
  await assert.rejects(runtime.shutdown({ graceMs: 20 }), ShutdownIncompleteError);
  assert.throws(() => new HostStore({ dataDir: dir }), (e: unknown) => e instanceof HostError && e.code === "host_locked");

  hold.release();
  await runtime.shutdown({ graceMs: 500 });
  assert.equal(runtime.status().state, "closed");
  assert.ok(driver.closed.has("s1"));
  const reopened = new HostStore({ dataDir: dir });
  reopened.close();
});
