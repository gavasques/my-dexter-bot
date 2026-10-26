import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dispatchAction, HostError, HostStore } from "@dexter/hub";
import type { JsonValue, ToolRequest } from "@dexter/contracts";

type Ctx = { after: (fn: () => void) => void };
const WORKER = fileURLToPath(new URL("./fixtures/crash-worker.js", import.meta.url));

function tempDir(t: Ctx): string {
  const dir = mkdtempSync(join(tmpdir(), "dexter-dispatch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function code(expected: string) {
  return (error: unknown) => error instanceof HostError && error.code === expected;
}
/** Creates bot, thread, allow grant and one ready action, then returns the ids. */
function seedReady(store: HostStore, policy: "allow" | "ask" = "allow") {
  const bot = store.createBot({ name: "General", profileId: "personal", engine: "codex" });
  const thread = store.createThread(bot.id);
  store.setGrant({ botId: bot.id, tool: "files.write", destination: "host", policy });
  const action = store.requestAction({
    botId: bot.id, threadId: thread.id, tool: "files.write", destination: "host",
    arguments: { path: "notes.md", text: "hello" }, idempotencyKey: "write-1",
  });
  return { bot, thread, action };
}
function effects(file: string): number {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
}
function run(args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, ...args], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (exitCode, signal) => resolve({ code: exitCode, signal, stdout }));
  });
}
function databaseBytes(dir: string): string {
  return readdirSync(dir).filter((name) => name.startsWith("dexter.sqlite"))
    .map((name) => readFileSync(join(dir, name)).toString("latin1")).join("");
}

test("dispatch executes the stored request once and records a redacted result", async (t) => {
  const dir = tempDir(t);
  const store = new HostStore({ dataDir: dir });
  t.after(() => store.close());
  const { action } = seedReady(store);
  const seen: ToolRequest[] = [];
  const done = await dispatchAction(store, action.id, async (request) => {
    seen.push(request);
    return { ok: true, nested: { accessToken: "upstream-secret-value" } };
  });
  assert.equal(done.state, "succeeded");
  assert.deepEqual(seen, [action.request]);
  assert.deepEqual(done.result, { nested: { accessToken: "[redacted]" }, ok: true });
  assert.ok(!databaseBytes(dir).includes("upstream-secret-value"));
  await assert.rejects(dispatchAction(store, action.id, async () => null), code("conflict"));
  assert.equal(seen.length, 1);
  assert.deepEqual(store.listEvents().map((e) => e.kind).slice(-3), ["action.created", "action.started", "action.succeeded"]);
});

test("concurrent dispatches of the same action run the executor once", async (t) => {
  const store = new HostStore({ dataDir: tempDir(t) });
  t.after(() => store.close());
  const { action } = seedReady(store);
  let calls = 0;
  const executor = async (): Promise<JsonValue> => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return "ok"; };
  const outcomes = await Promise.allSettled([dispatchAction(store, action.id, executor), dispatchAction(store, action.id, executor)]);
  assert.equal(calls, 1);
  assert.deepEqual(outcomes.map((o) => o.status).sort(), ["fulfilled", "rejected"]);
});

test("executor errors become unknown without persisting the error message", async (t) => {
  const dir = tempDir(t);
  const store = new HostStore({ dataDir: dir });
  t.after(() => store.close());
  const { action } = seedReady(store);
  const failed = await dispatchAction(store, action.id, async () => { throw new Error("leaked-executor-detail sk-live-123"); });
  assert.equal(failed.state, "unknown");
  assert.equal(failed.reason, "executor_error");
  assert.equal(failed.result, null);
  assert.ok(!databaseBytes(dir).includes("leaked-executor-detail"));
  await assert.rejects(dispatchAction(store, action.id, async () => "again"), code("conflict"));
});

test("approval waits are revalidated: revocation before dispatch never reaches the executor", async (t) => {
  const store = new HostStore({ dataDir: tempDir(t) });
  t.after(() => store.close());
  const { bot, action } = seedReady(store, "ask");
  await assert.rejects(dispatchAction(store, action.id, async () => "x"), code("conflict"));
  store.decideAction(action.id, { decision: "allow", requestHash: action.requestHash });
  store.setGrant({ botId: bot.id, tool: "files.write", destination: "host", policy: "deny" });
  let called = false;
  await assert.rejects(dispatchAction(store, action.id, async () => { called = true; return "x"; }), code("conflict"));
  assert.equal(called, false);
  assert.equal(store.getAction(action.id).state, "blocked");
});

test("a revocation during execution does not falsify an effect that already happened", async (t) => {
  const store = new HostStore({ dataDir: tempDir(t) });
  t.after(() => store.close());
  const { bot, action } = seedReady(store);
  const done = await dispatchAction(store, action.id, async () => {
    store.setGrant({ botId: bot.id, tool: "files.write", destination: "host", policy: "deny" });
    return "written";
  });
  assert.equal(done.state, "succeeded");
});

for (const mode of ["crash", "exit"] as const) {
  test(`a worker that ${mode === "crash" ? "is killed" : "exits"} mid-effect is recovered as unknown and never re-run`, async (t) => {
    const dir = tempDir(t);
    const effectFile = join(dir, "effects.log");
    const setup = new HostStore({ dataDir: dir });
    const { action } = seedReady(setup);
    setup.close();

    const exit = await run([mode, dir, action.id, effectFile]);
    if (mode === "crash") assert.equal(exit.signal, "SIGKILL"); else assert.equal(exit.code, 3);
    assert.equal(effects(effectFile), 1);

    const store = new HostStore({ dataDir: dir });
    t.after(() => store.close());
    const recovered = store.getAction(action.id);
    assert.equal(recovered.state, "unknown");
    assert.equal(recovered.reason, "host_interrupted");
    assert.equal(store.listEvents().at(-1)?.kind, "action.unknown");
    await assert.rejects(dispatchAction(store, action.id, async () => "again"), code("conflict"));
    store.close();
    assert.equal((await run(["try-open", dir])).stdout.trim(), "opened");
    assert.equal(effects(effectFile), 1);
  });
}

test("a live writer process excludes others until it dies, then its lease is reclaimed", async (t) => {
  const dir = tempDir(t);
  new HostStore({ dataDir: dir }).close();
  const holder = spawn(process.execPath, [WORKER, "hold", dir], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { holder.kill("SIGKILL"); });
  await new Promise<void>((resolve, reject) => {
    holder.stdout.on("data", (chunk: Buffer) => { if (chunk.toString().includes("ready")) resolve(); });
    holder.on("exit", () => reject(new Error("holder exited early")));
  });
  assert.throws(() => new HostStore({ dataDir: dir }), code("host_locked"));
  assert.equal((await run(["try-open", dir])).stdout.trim(), "host_locked");

  const exited = new Promise((resolve) => holder.on("exit", resolve));
  holder.kill("SIGKILL");
  await exited;
  const store = new HostStore({ dataDir: dir });
  assert.equal(store.summary().lease.pid, process.pid);
  assert.equal((await run(["try-open", dir])).stdout.trim(), "host_locked");
  store.close();
});
