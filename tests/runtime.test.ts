import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TurnEventSchema, TurnSchema } from "@dexter/contracts";
import { ClaudeCliDriver, CodexAppServerDriver } from "@dexter/engines";
import {
  ConversationRuntime, HostError, HostStore, MAX_TURN_OUTPUT_CHARS, SCHEMA_VERSION, type RuntimeDriver, type RuntimeOptions,
} from "@dexter/hub";
import { delay, FakeEngine, SECRET_STDERR } from "./fixtures/runtime-fake-engine.js";

type Ctx = { after: (fn: () => void | Promise<void>) => void };
const CRASH_WORKER = fileURLToPath(new URL("./fixtures/runtime-crash-worker.js", import.meta.url));

// Compile-time proof that the real drivers fit the runtime seam without the hub depending on engines.
const _seam: RuntimeDriver[] = [new ClaudeCliDriver(), new CodexAppServerDriver()];
void _seam;

function tempDir(t: Ctx): string {
  const dir = mkdtempSync(join(tmpdir(), "dexter-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function code(expected: string) {
  return (error: unknown) => error instanceof HostError && error.code === expected;
}
function start(t: Ctx, dir = tempDir(t), extra: Partial<RuntimeOptions> = {}, engine = new FakeEngine()) {
  const store = new HostStore({ dataDir: dir });
  const runtime = new ConversationRuntime({ store, drivers: [engine], abortGraceMs: 100, ...extra });
  t.after(() => runtime.shutdown({ graceMs: 200 }));
  return { dir, store, runtime, engine };
}
function seed(store: HostStore, engine: "claude" | "codex" = "claude") {
  const bot = store.createBot({ name: "General", profileId: "personal", engine });
  return { bot, thread: store.createThread(bot.id) };
}

test("malformed runtime admission returns a safe typed refusal before creating a turn or opening a driver", async (t) => {
  const { store, runtime, engine } = start(t);
  const { thread } = seed(store);
  for (const input of [
    { clientRequestId: "extra-field", content: "synthetic-private-value", extra: true },
    { clientRequestId: "empty-content", content: "" },
  ]) {
    assert.throws(() => runtime.startTurn(thread.id, input), (error: unknown) =>
      error instanceof HostError && error.code === "invalid_input"
      && !error.message.includes("synthetic-private-value")
      && (!("extra" in input) || error.message === "Turn input is invalid."));
  }
  assert.equal(store.listTurnsByState("queued").length, 0);
  assert.equal(store.listTurnsByState("running").length, 0);
  assert.equal(store.listMessages(thread.id).length, 0);
  assert.equal(engine.opens.length, 0);
  assert.equal(engine.turns.length, 0);
});

function databaseBytes(dir: string): string {
  return readdirSync(dir).filter((name) => name.startsWith("dexter.sqlite"))
    .map((name) => readFileSync(join(dir, name)).toString("latin1")).join("");
}

test("streams asynchronously, persists replayable deltas and one durable assistant message", async (t) => {
  const { store, runtime } = start(t);
  const { thread } = seed(store);
  const notices: string[] = [];
  runtime.subscribe((notice) => notices.push(notice.state));
  const { turn, created } = runtime.startTurn(thread.id, { clientRequestId: "r1", content: "echo:hello durable world" });
  assert.equal(created, true);
  assert.equal(turn.state, "queued");
  // Accepted input is committed before any driver work.
  assert.equal(store.listMessages(thread.id).length, 1);
  const done = await runtime.waitForTurn(turn.id);
  assert.equal(done.state, "completed");
  assert.equal(done.code, null);
  const events = runtime.listTurnEvents({ turnId: turn.id });
  assert.deepEqual(events.map((e) => e.kind), ["turn.queued", "turn.started", "text.delta", "text.delta", "text.delta", "turn.completed"]);
  const streamed = events.filter((e) => e.kind === "text.delta").map((e) => e.text).join("");
  assert.equal(streamed, "hello durable world");
  const messages = store.listMessages(thread.id);
  assert.deepEqual(messages.map((m) => [m.role, m.content]), [["user", "echo:hello durable world"], ["assistant", streamed]]);
  assert.equal(done.outputMessageId, messages[1]!.id);
  // Replay from any cursor.
  assert.deepEqual(runtime.listTurnEvents({ threadId: thread.id }, events[2]!.cursor).map((e) => e.cursor), events.slice(3).map((e) => e.cursor));
  assert.deepEqual(notices, ["queued", "running", "completed"]);
  // Runtime records satisfy the public contracts the HTTP layer serves.
  assert.deepEqual(TurnSchema.parse(done), done);
  for (const event of events) assert.deepEqual(TurnEventSchema.parse(event), event);
  const status = JSON.stringify(runtime.status());
  assert.ok(!status.includes("hello") && !status.includes("fake-cursor"));
  assert.equal(runtime.status().counts?.completed, 1);
});

test("idempotent by thread and clientRequestId, even when requests race", async (t) => {
  const { store, runtime, engine } = start(t);
  const { thread } = seed(store);
  const input = { clientRequestId: "same", content: "echo:once" };
  const [a, b] = await Promise.all([Promise.resolve().then(() => runtime.startTurn(thread.id, input)), Promise.resolve().then(() => runtime.startTurn(thread.id, input))]);
  assert.equal(a.turn.id, b.turn.id);
  assert.deepEqual([a.created, b.created].sort(), [false, true]);
  await runtime.waitForTurn(a.turn.id);
  const replay = runtime.startTurn(thread.id, input);
  assert.equal(replay.created, false);
  assert.equal(replay.turn.state, "completed");
  await delay(20);
  assert.equal(engine.turns.length, 1);
  assert.throws(() => runtime.startTurn(thread.id, { clientRequestId: "same", content: "echo:other" }), code("conflict"));
  assert.throws(() => runtime.startTurn(thread.id, { clientRequestId: "x", content: "" }), code("invalid_input"));
  assert.throws(() => runtime.startTurn(thread.id, { clientRequestId: "x", content: "hi", extra: 1 }), code("invalid_input"));
  assert.throws(() => runtime.startTurn("thr_missing", { clientRequestId: "x", content: "hi" }), code("not_found"));
  assert.equal(store.listMessages(thread.id).length, 2);
});

test("one running turn per thread in FIFO order; different threads run in parallel", async (t) => {
  const { store, runtime, engine } = start(t, undefined, {}, new FakeEngine("claude", 5));
  const { bot, thread } = seed(store);
  const other = store.createThread(bot.id);
  const turns = ["echo:a b c", "echo:d e f", "echo:g h i"].map((content, i) => runtime.startTurn(thread.id, { clientRequestId: `q${i}`, content }).turn);
  const parallel = runtime.startTurn(other.id, { clientRequestId: "p", content: "echo:x y z" }).turn;
  assert.deepEqual(turns.slice(1).map((turn) => runtime.getTurn(turn.id).state), ["queued", "queued"]);
  for (const turn of [...turns, parallel]) assert.equal((await runtime.waitForTurn(turn.id)).state, "completed");
  assert.equal(engine.maxPerThread, 1);
  assert.equal(engine.maxGlobal, 2);
  assert.deepEqual(engine.turns.filter((x) => x.threadId === thread.id).map((x) => x.turnId), turns.map((x) => x.id));
  // One driver session per thread, reused across its turns.
  assert.equal(engine.opens.length, 2);
});

test("restart keeps output and resumes the engine from the persisted native cursor", async (t) => {
  const dir = tempDir(t);
  const first = new FakeEngine();
  const store = new HostStore({ dataDir: dir });
  const runtime = new ConversationRuntime({ store, drivers: [first] });
  const { thread } = seed(store);
  const turn = runtime.startTurn(thread.id, { clientRequestId: "r1", content: "echo:remember me" }).turn;
  await runtime.waitForTurn(turn.id);
  const cursor = store.getThreadSession(thread.id)!.nativeCursor;
  assert.equal(cursor, "fake-cursor-1");
  await runtime.shutdown();

  const { store: reopened, runtime: again, engine } = start(t, dir);
  const restored = again.getTurn(turn.id);
  assert.equal(restored.state, "completed");
  assert.equal(reopened.listMessages(thread.id)[1]!.content, "remember me");
  assert.equal(again.listTurnEvents({ turnId: turn.id }).at(-1)!.kind, "turn.completed");
  const next = again.startTurn(thread.id, { clientRequestId: "r2", content: "echo:and again" }).turn;
  assert.equal((await again.waitForTurn(next.id)).state, "completed");
  assert.deepEqual(engine.opens, [{ threadId: thread.id, cursor }]);
});

test("cursor is saved only by completed turns and a failed session is reopened from the last good cursor", async (t) => {
  const { store, runtime, engine } = start(t);
  const { thread } = seed(store);
  const failed = runtime.startTurn(thread.id, { clientRequestId: "f", content: "fail:engine_failed" }).turn;
  assert.equal((await runtime.waitForTurn(failed.id)).state, "failed");
  assert.equal(store.getThreadSession(thread.id)!.nativeCursor, null);
  const ok = runtime.startTurn(thread.id, { clientRequestId: "ok", content: "echo:fine" }).turn;
  await runtime.waitForTurn(ok.id);
  assert.equal(store.getThreadSession(thread.id)!.nativeCursor, "fake-cursor-2");
  const again = runtime.startTurn(thread.id, { clientRequestId: "f2", content: "fail:usage_limit" }).turn;
  assert.equal((await runtime.waitForTurn(again.id)).code, "usage_limit");
  const after = runtime.startTurn(thread.id, { clientRequestId: "ok2", content: "echo:back" }).turn;
  await runtime.waitForTurn(after.id);
  assert.deepEqual(engine.opens.map((o) => o.cursor), [undefined, undefined, "fake-cursor-2"]);
  assert.equal(engine.closes, 2);
});

test("cancel works without the caller, for queued and running turns", async (t) => {
  const { store, runtime, engine } = start(t);
  const { thread } = seed(store);
  const running = runtime.startTurn(thread.id, { clientRequestId: "h", content: "hang" }).turn;
  const queued = runtime.startTurn(thread.id, { clientRequestId: "q", content: "echo:later" }).turn;
  while (runtime.listTurnEvents({ turnId: running.id }).every((e) => e.kind !== "text.delta")) await delay(2);
  assert.equal(runtime.cancelTurn(queued.id).state, "interrupted");
  assert.equal(runtime.getTurn(queued.id).code, "cancelled");
  runtime.cancelTurn(running.id);
  const done = await runtime.waitForTurn(running.id);
  assert.deepEqual([done.state, done.code, done.outputMessageId], ["interrupted", "cancelled", null]);
  assert.deepEqual(engine.interrupts, [running.id]);
  assert.equal(runtime.cancelTurn(running.id).state, "interrupted");
  assert.equal(engine.turns.length, 1);
  // Partial output stays on the replayable stream; no assistant message is invented.
  assert.equal(store.listMessages(thread.id).filter((m) => m.role === "assistant").length, 0);
});

test("a driver that ignores abort ends unknown, never interrupted", async (t) => {
  const { store, runtime } = start(t);
  const { thread } = seed(store);
  const turn = runtime.startTurn(thread.id, { clientRequestId: "d", content: "deaf" }).turn;
  while (runtime.listTurnEvents({ turnId: turn.id }).every((e) => e.kind !== "text.delta")) await delay(2);
  runtime.cancelTurn(turn.id);
  const done = await runtime.waitForTurn(turn.id);
  assert.deepEqual([done.state, done.code], ["unknown", "driver_unresponsive"]);
});

test("failures are normalized, never persist raw errors, and produce exactly one terminal", async (t) => {
  const { dir, store, runtime, engine } = start(t);
  const { bot, thread } = seed(store);
  const outcome = async (content: string, clientRequestId: string, on = thread) => {
    const turn = runtime.startTurn(on.id, { clientRequestId, content }).turn;
    const done = await runtime.waitForTurn(turn.id);
    const terminals = runtime.listTurnEvents({ turnId: turn.id }).filter((e) => /^turn\.(completed|interrupted|failed|unknown)$/.test(e.kind));
    assert.equal(terminals.length, 1, content);
    return [done.state, done.code];
  };
  assert.deepEqual(await outcome("throw", "t1"), ["failed", "engine_failed"]);
  assert.deepEqual(await outcome("fail:rate_limited", "t2"), ["failed", "rate_limited"]);
  assert.deepEqual(await outcome("fail-secret", "t3"), ["failed", "engine_failed"]);
  assert.deepEqual(await outcome("end", "t4"), ["failed", "protocol_error"]);
  assert.deepEqual(await outcome("foreign", "t5"), ["failed", "protocol_error"]);
  assert.deepEqual(await outcome("double", "t6"), ["completed", null]);
  assert.equal(store.listMessages(thread.id).at(-1)!.content, "once");
  // Fresh threads so the driver has to open a session.
  engine.failOpen = "authentication_required";
  assert.deepEqual(await outcome("echo:hi", "t7", store.createThread(bot.id)), ["failed", "authentication_required"]);
  engine.failOpen = null;
  engine.cursorOverride = "../../etc/passwd";
  const tampered = store.createThread(bot.id);
  assert.deepEqual(await outcome("echo:hi", "t8", tampered), ["completed", null]);
  assert.equal(store.getThreadSession(tampered.id)!.nativeCursor, null);
  assert.ok(!databaseBytes(dir).includes(SECRET_STDERR.slice(-24)));
  // A thread with no driver for its engine fails safely instead of hanging.
  const codexBot = store.createBot({ name: "C", profileId: "personal", engine: "codex" });
  const codexThread = store.createThread(codexBot.id);
  const orphan = runtime.startTurn(codexThread.id, { clientRequestId: "n", content: "echo:x" }).turn;
  const orphaned = await runtime.waitForTurn(orphan.id);
  assert.deepEqual([orphaned.state, orphaned.code], ["failed", "no_driver"]);
});

test("output is clipped to the message limit and the deltas match the stored message", async (t) => {
  const { store, runtime } = start(t);
  const { thread } = seed(store);
  const turn = runtime.startTurn(thread.id, { clientRequestId: "big", content: `big:${MAX_TURN_OUTPUT_CHARS + 5_000}` }).turn;
  const done = await runtime.waitForTurn(turn.id);
  assert.equal(done.state, "completed");
  assert.equal(done.outputChars, MAX_TURN_OUTPUT_CHARS);
  assert.equal(done.outputTruncated, true);
  const message = store.listMessages(thread.id).at(-1)!;
  const deltas = runtime.listTurnEvents({ turnId: turn.id }, 0, 500).filter((e) => e.kind === "text.delta").map((e) => e.text).join("");
  assert.equal(message.content.length, MAX_TURN_OUTPUT_CHARS);
  assert.equal(deltas, message.content);
});

test("SIGKILL during a running turn leaves it unknown and the input is never re-sent", async (t) => {
  const dir = tempDir(t);
  const effectFile = join(dir, "effects.log");
  const setup = new HostStore({ dataDir: dir });
  const { thread } = seed(setup);
  setup.close();
  const result = await new Promise<{ signal: NodeJS.Signals | null; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [CRASH_WORKER, dir, thread.id, effectFile], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (_code, signal) => resolve({ signal, stdout }));
  });
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.stdout, "accepted\n");
  const inferences = (): number => existsSync(effectFile) ? readFileSync(effectFile, "utf8").split("\n").filter(Boolean).length : 0;
  assert.equal(inferences(), 1);

  const { store, runtime, engine } = start(t, dir);
  const [turn] = runtime.listTurns(thread.id);
  assert.deepEqual([turn!.state, turn!.code], ["unknown", "host_interrupted"]);
  assert.deepEqual(runtime.listTurnEvents({ turnId: turn!.id }).map((e) => e.kind), ["turn.queued", "turn.started", "text.delta", "turn.unknown"]);
  const replay = runtime.startTurn(thread.id, { clientRequestId: "crash-1", content: "say something" });
  assert.deepEqual([replay.created, replay.turn.state], [false, "unknown"]);
  await delay(30);
  assert.equal(engine.turns.length, 0);
  assert.equal(inferences(), 1);
  assert.equal(store.listMessages(thread.id).filter((m) => m.role === "assistant").length, 0);
  assert.equal(store.getThreadSession(thread.id)!.nativeCursor, null);
});

test("queued turns from a previous process are held until explicitly resumed", async (t) => {
  const dir = tempDir(t);
  const setup = new HostStore({ dataDir: dir });
  const { thread } = seed(setup);
  const stranded = setup.createTurn(thread.id, { clientRequestId: "old", content: "echo:old" }).turn;
  setup.close();
  const { runtime, engine } = start(t, dir);
  await delay(20);
  assert.equal(runtime.getTurn(stranded.id).state, "queued");
  assert.equal(runtime.status().heldQueuedTurns, 1);
  assert.throws(() => runtime.startTurn(thread.id, { clientRequestId: "new", content: "echo:new" }), code("conflict"));
  assert.equal(runtime.resumeQueued(thread.id), 1);
  assert.equal((await runtime.waitForTurn(stranded.id)).state, "completed");
  assert.equal(engine.turns.length, 1);
  const fresh = runtime.startTurn(thread.id, { clientRequestId: "new", content: "echo:new" }).turn;
  assert.equal((await runtime.waitForTurn(fresh.id)).state, "completed");
});

test("a thread bound to one engine refuses a different engine", async (t) => {
  const { store, runtime } = start(t);
  const { bot, thread } = seed(store);
  await runtime.waitForTurn(runtime.startTurn(thread.id, { clientRequestId: "a", content: "echo:a" }).turn.id);
  const raw = new DatabaseSync(store.databasePath);
  raw.prepare("UPDATE bots SET engine = 'codex' WHERE id = ?").run(bot.id);
  raw.close();
  assert.throws(() => runtime.startTurn(thread.id, { clientRequestId: "b", content: "echo:b" }), code("conflict"));
  assert.throws(() => new ConversationRuntime({ store, drivers: [new FakeEngine(), new FakeEngine()] }), code("invalid_input"));
});

test("shutdown drains running turns before releasing the store lease", async (t) => {
  const dir = tempDir(t);
  const store = new HostStore({ dataDir: dir });
  const engine = new FakeEngine();
  const runtime = new ConversationRuntime({ store, drivers: [engine] });
  const { thread } = seed(store);
  const running = runtime.startTurn(thread.id, { clientRequestId: "h", content: "hang" }).turn;
  const queued = runtime.startTurn(thread.id, { clientRequestId: "q", content: "echo:q" }).turn;
  while (runtime.listTurnEvents({ turnId: running.id }).every((e) => e.kind !== "text.delta")) await delay(2);
  await runtime.shutdown({ graceMs: 1_000 });
  assert.equal(runtime.status().state, "closed");
  assert.throws(() => runtime.startTurn(thread.id, { clientRequestId: "late", content: "echo:x" }));
  const reopened = new HostStore({ dataDir: dir }); // lease released only after the drain
  t.after(() => reopened.close());
  assert.deepEqual([reopened.getTurn(running.id).state, reopened.getTurn(running.id).code], ["interrupted", "shutdown"]);
  assert.equal(reopened.getTurn(queued.id).state, "queued");
  assert.equal(engine.turns.length, 1);
  assert.ok(engine.closes >= 1);
});

test("schema v1 databases migrate in place without losing data, only through the explicit owner upgrade", (t) => {
  const dir = tempDir(t);
  const first = new HostStore({ dataDir: dir });
  const { thread } = seed(first);
  first.appendMessage(thread.id, { clientMessageId: "keep", content: "v1 content" });
  first.close();
  const raw = new DatabaseSync(join(dir, "dexter.sqlite"));
  raw.exec("DROP TRIGGER host_authority_no_delete; DROP TRIGGER host_authority_revoked_final; DROP TRIGGER host_authority_forward; DROP TABLE host_authority; DROP TRIGGER client_enrollment_no_update; DROP TRIGGER client_enrollment_no_delete; DROP TABLE client_device_enrollments; DROP TABLE turn_events; DROP TABLE turns; DROP TABLE thread_sessions; PRAGMA user_version = 1;");
  raw.close();
  // Schema 4: a legacy file never becomes a writer by being opened; the owner-local upgrade is explicit.
  assert.throws(() => new HostStore({ dataDir: dir }), (error) => error instanceof HostError && error.code === "conflict");
  const store = new HostStore({ dataDir: dir, authorityBootstrap: "legacy_upgrade" });
  t.after(() => store.close());
  assert.equal(SCHEMA_VERSION, 4);
  assert.equal(store.summary().schemaVersion, 4);
  assert.equal(store.authorityStatus().provenance, "legacy_upgrade");
  assert.equal(store.listMessages(thread.id)[0]!.content, "v1 content");
  assert.equal(store.createTurn(thread.id, { clientRequestId: "after", content: "hi" }).turn.state, "queued");
});
