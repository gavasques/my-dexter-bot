import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonValue, ToolRequest } from "@dexter/contracts";
import {
  ConversationRuntime, HostError, HostStore, ShutdownIncompleteError, type RuntimeOptions, type ToolExecutor, type Turn,
} from "@dexter/hub";
import { delay, FakeEngine } from "./fixtures/runtime-fake-engine.js";
import type { RuntimeSession } from "@dexter/hub";

// Review round 2: the runtime must not release a thread or the writer while this process still has a
// driver stream, session or tool execution in flight, and a recorded abort wins over a late success.

type Ctx = { after: (fn: () => void | Promise<void>) => void };

function setup(t: Ctx, extra: Partial<RuntimeOptions> = {}, engine = new FakeEngine()) {
  const dir = mkdtempSync(join(tmpdir(), "dexter-runtime-drain-"));
  const store = new HostStore({ dataDir: dir });
  const runtime = new ConversationRuntime({ store, drivers: [engine], abortGraceMs: 100, approvalPollMs: 5, ...extra });
  t.after(async () => {
    await runtime.shutdown({ graceMs: 500 }).catch(() => store.close());
    rmSync(dir, { recursive: true, force: true });
  });
  const bot = store.createBot({ name: "General", profileId: "personal", engine: "claude" });
  const thread = store.createThread(bot.id);
  store.setGrant({ botId: bot.id, tool: "mail.send", destination: "composio", policy: "allow" });
  const request: ToolRequest = { botId: bot.id, threadId: thread.id, tool: "mail.send", destination: "composio",
    arguments: { to: "a@example.com" }, idempotencyKey: "k1" };
  const startTool = (clientRequestId: string): Turn =>
    runtime.startTurn(thread.id, { clientRequestId, content: `tool:${JSON.stringify({ requests: [request] })}` }).turn;
  const until = async (check: () => boolean): Promise<void> => { while (!check()) await delay(2); };
  const hasDelta = (turnId: string) => () => runtime.listTurnEvents({ turnId }).some((e) => e.kind === "text.delta");
  const runningAction = () => store.listActions("running")[0];
  return { dir, store, runtime, engine, thread, startTool, until, hasDelta, runningAction };
}

/** Executor that blocks until released, recording whether it saw the abort signal. */
function gatedExecutor(honourAbort: boolean) {
  const seen = { calls: 0, aborted: false };
  let release = (): void => {};
  const executor: ToolExecutor = (_request, { signal }) => {
    seen.calls += 1;
    return new Promise<JsonValue>((resolve, reject) => {
      release = () => resolve({ sent: true });
      signal.addEventListener("abort", () => {
        seen.aborted = true;
        if (honourAbort) reject(new Error("aborted after the request was sent"));
      }, { once: true });
    });
  };
  return { executor, seen, release: () => release() };
}

test("the next turn of a thread starts only after the previous stream's async cleanup", { timeout: 10_000 }, async (t) => {
  const engine = new FakeEngine();
  engine.cleanupMs = 100; // async finally, like a real driver tearing down its process
  const { runtime, thread } = setup(t, {}, engine);
  const a = runtime.startTurn(thread.id, { clientRequestId: "a", content: "echo:first" }).turn;
  const b = runtime.startTurn(thread.id, { clientRequestId: "b", content: "echo:second" }).turn;
  const [doneA, doneB] = [await runtime.waitForTurn(a.id), await runtime.waitForTurn(b.id)];
  assert.deepEqual([doneA.state, doneB.state, doneB.code], ["completed", "completed", null]);
  assert.equal(engine.maxPerThread, 1);
  assert.equal(runtime.status().pending.streams, 0);
});

test("a completion arriving after cancel stays interrupted: no message and no cursor advance", { timeout: 10_000 }, async (t) => {
  const { store, runtime, engine, thread, until, hasDelta } = setup(t);
  const first = runtime.startTurn(thread.id, { clientRequestId: "c0", content: "echo:hello" }).turn;
  await runtime.waitForTurn(first.id);
  const cursor = store.getThreadSession(thread.id)!.nativeCursor;
  const turn = runtime.startTurn(thread.id, { clientRequestId: "c1", content: "gate" }).turn;
  await until(hasDelta(turn.id));
  runtime.cancelTurn(turn.id);
  assert.ok(engine.release(turn.id)); // the driver finishes anyway, inside the abort grace
  const done = await runtime.waitForTurn(turn.id);
  assert.deepEqual([done.state, done.code, done.outputMessageId], ["interrupted", "cancelled", null]);
  assert.equal(store.listMessages(thread.id).filter((m) => m.role === "assistant").length, 1);
  assert.equal(store.getThreadSession(thread.id)!.nativeCursor, cursor);
  const terminals = runtime.listTurnEvents({ turnId: turn.id }).filter((e) => /^turn\.(completed|interrupted|failed|unknown)$/.test(e.kind));
  assert.deepEqual(terminals.map((e) => e.kind), ["turn.interrupted"]);
});

test("a completion arriving after the turn timeout stays failed(timeout)", { timeout: 10_000 }, async (t) => {
  const { store, runtime, engine, thread, until, hasDelta } = setup(t, { turnTimeoutMs: 30 });
  const turn = runtime.startTurn(thread.id, { clientRequestId: "t1", content: "gate" }).turn;
  await until(hasDelta(turn.id));
  await until(() => engine.interrupts.includes(turn.id));
  engine.release(turn.id);
  const done = await runtime.waitForTurn(turn.id);
  assert.deepEqual([done.state, done.code, done.outputMessageId], ["failed", "timeout", null]);
  assert.equal(store.listMessages(thread.id).filter((m) => m.role === "assistant").length, 0);
});

test("shutdown keeps the store and lease while an executor ignores the abort; no second writer meanwhile", { timeout: 10_000 }, async (t) => {
  const gate = gatedExecutor(false);
  const { dir, store, runtime, startTool, until, runningAction } = setup(t, { executor: gate.executor });
  const turn = startTool("t1");
  await until(() => runningAction() !== undefined);
  const action = runningAction()!;

  const started = Date.now();
  const error = await runtime.shutdown({ graceMs: 50 }).then(() => null, (e: unknown) => e);
  assert.ok(Date.now() - started < 1_000, "shutdown does not hang");
  assert.ok(error instanceof ShutdownIncompleteError);
  assert.equal(error.code, "outcome_unknown");
  assert.equal(error.pending.executions, 1);
  assert.equal(runtime.status().state, "draining");
  assert.ok(gate.seen.aborted, "the executor received the cancel signal");
  assert.throws(() => new HostStore({ dataDir: dir }), (e: unknown) => e instanceof HostError && e.code === "host_locked");

  // After the abort grace the turn ends unknown (never a false interrupted); the action is still running.
  const done = await runtime.waitForTurn(turn.id);
  assert.deepEqual([done.state, done.code], ["unknown", "executor_unresponsive"]);
  assert.equal(store.getAction(action.id).state, "running");
  await assert.rejects(runtime.shutdown({ graceMs: 20 }), ShutdownIncompleteError);
  assert.throws(() => new HostStore({ dataDir: dir }), (e: unknown) => e instanceof HostError && e.code === "host_locked");

  gate.release(); // the late effect is still recorded by this writer, not lost or replayed
  await runtime.shutdown({ graceMs: 500 });
  assert.equal(runtime.status().state, "closed");
  const reopened = new HostStore({ dataDir: dir });
  t.after(() => reopened.close());
  assert.equal(reopened.getAction(action.id).state, "succeeded");
  assert.deepEqual([reopened.getTurn(turn.id).state, reopened.getTurn(turn.id).code], ["unknown", "executor_unresponsive"]);
  assert.equal(gate.seen.calls, 1);
});

test("an executor that honours cancel ends unknown, the turn interrupted, and nothing can approve it later", { timeout: 10_000 }, async (t) => {
  const gate = gatedExecutor(true);
  const { store, runtime, startTool, until, runningAction } = setup(t, { executor: gate.executor });
  const turn = startTool("t1");
  await until(() => runningAction() !== undefined);
  const action = runningAction()!;
  runtime.cancelTurn(turn.id);
  const done = await runtime.waitForTurn(turn.id);
  assert.deepEqual([done.state, done.code], ["interrupted", "cancelled"]);
  // A request may already have left: the outcome is unknown, not denied and not retried.
  assert.deepEqual([store.getAction(action.id).state, store.getAction(action.id).reason], ["unknown", "executor_error"]);
  assert.throws(() => runtime.decideAction(action.id, { decision: "allow", requestHash: action.requestHash }));
  assert.equal(gate.seen.calls, 1);
  assert.equal(runtime.status().pending.executions, 0);
  await runtime.shutdown({ graceMs: 200 });
});

test("a stream that survives abort and close blocks its thread and shutdown reports it", { timeout: 10_000 }, async (t) => {
  const { store, runtime, thread, until, hasDelta } = setup(t);
  const zombie = runtime.startTurn(thread.id, { clientRequestId: "z", content: "zombie" }).turn;
  const next = runtime.startTurn(thread.id, { clientRequestId: "n", content: "echo:next" }).turn;
  await until(hasDelta(zombie.id));
  runtime.cancelTurn(zombie.id);
  const done = await runtime.waitForTurn(zombie.id);
  assert.deepEqual([done.state, done.code], ["unknown", "driver_unresponsive"]);
  await until(() => runtime.status().pending.streams === 1);
  await delay(50);
  assert.equal(runtime.getTurn(next.id).state, "queued", "nothing else runs on the thread while the old stream lives");
  const error = await runtime.shutdown({ graceMs: 30 }).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof ShutdownIncompleteError);
  assert.equal(error.pending.streams, 1);
  assert.equal(store.getTurn(next.id).state, "queued", "store still open and the queued input never sent");
});

for (const mode of ["cancel", "timeout"] as const) {
  test(`a tool response that survives ${mode} ends unknown and blocks its thread until it returns`, { timeout: 10_000 }, async (t) => {
    const engine = new FakeEngine();
    let entered = false;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    engine.respondToTool = async (session: RuntimeSession, turnId: string, requestId: string, result: JsonValue) => {
      entered = true;
      await gate;
      await FakeEngine.prototype.respondToTool.call(engine, session, turnId, requestId, result);
    };
    const { dir, store, runtime, thread, startTool, until } = setup(t,
      { executor: async () => ({ sent: true }), abortGraceMs: 20, turnTimeoutMs: mode === "timeout" ? 50 : 1_000 }, engine);
    t.after(() => release());
    const turn = startTool("response-1");
    await until(() => entered);
    if (mode === "cancel") runtime.cancelTurn(turn.id);
    const next = runtime.startTurn(thread.id, { clientRequestId: "response-2", content: "echo:next" }).turn;
    const done = await runtime.waitForTurn(turn.id);
    assert.deepEqual([done.state, done.code, done.outputMessageId], ["unknown", "driver_unresponsive", null]);
    await until(() => runtime.status().pending.turns === 0);
    assert.equal(runtime.status().pending.sessions, 1);
    assert.equal(store.getTurn(next.id).state, "queued");
    assert.equal(engine.turns.length, 1);
    assert.throws(() => new HostStore({ dataDir: dir }), (e: unknown) => e instanceof HostError && e.code === "host_locked");
    assert.equal(store.listActions("succeeded").length, 1);

    release();
    assert.equal((await runtime.waitForTurn(next.id)).state, "completed");
    assert.equal(runtime.getTurn(turn.id).state, "unknown", "late response never rewrites the terminal outcome");
    assert.equal(engine.turns.length, 2, "the old input is never re-sent");
    assert.equal(runtime.status().pending.sessions, 0);
    await runtime.shutdown({ graceMs: 500 });
  });
}
