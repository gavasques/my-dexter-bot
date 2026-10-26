import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonValue, ToolRequest } from "@dexter/contracts";
import { ConversationRuntime, HostStore, type Turn } from "@dexter/hub";
import { delay, FakeEngine } from "./fixtures/runtime-fake-engine.js";

// Proves the runtime's tool path with a fake driver. Real drivers still answer respondToTool with
// `unsupported` and the MCP bridge is pending; this is not a real tool integration.

type Ctx = { after: (fn: () => void | Promise<void>) => void };

function setup(t: Ctx, policy: "allow" | "ask" | null = "allow", override?: (request: ToolRequest) => Promise<JsonValue>) {
  const dir = mkdtempSync(join(tmpdir(), "dexter-runtime-tools-"));
  const clock = { now: 1_000_000 };
  const store = new HostStore({ dataDir: dir, clock: () => clock.now, approvalTtlMs: 60_000 });
  const engine = new FakeEngine();
  const executed: ToolRequest[] = [];
  const executor = async (request: ToolRequest): Promise<JsonValue> => { executed.push(request); return { sent: true, token: { accessToken: "upstream" } }; };
  const runtime = new ConversationRuntime({ store, drivers: [engine], executor: override ?? executor, approvalPollMs: 5, abortGraceMs: 100 });
  t.after(async () => { await runtime.shutdown({ graceMs: 200 }); rmSync(dir, { recursive: true, force: true }); });
  const bot = store.createBot({ name: "General", profileId: "personal", engine: "claude" });
  const thread = store.createThread(bot.id);
  if (policy) store.setGrant({ botId: bot.id, tool: "mail.send", destination: "composio", policy });
  const request = (overrides: Partial<ToolRequest> = {}): ToolRequest =>
    ({ botId: bot.id, threadId: thread.id, tool: "mail.send", destination: "composio", arguments: { to: "a@example.com" }, idempotencyKey: "k1", ...overrides });
  const startTool = (clientRequestId: string, requests: ToolRequest[]): Turn =>
    runtime.startTurn(thread.id, { clientRequestId, content: `tool:${JSON.stringify({ requests })}` }).turn;
  const waitAction = async (turnId: string) => {
    for (;;) {
      const event = runtime.listTurnEvents({ turnId }).find((e) => e.kind === "tool.requested");
      if (event) return store.getAction((event.data as { actionId: string }).actionId);
      await delay(2);
    }
  };
  return { store, runtime, engine, executed, bot, thread, request, startTool, waitAction, clock };
}

test("allowed tool requests run once through the dispatcher with the turn's identity", async (t) => {
  const { store, runtime, engine, executed, startTool, request, thread, bot } = setup(t);
  const turn = startTool("t1", [request()]);
  const done = await runtime.waitForTurn(turn.id);
  assert.equal(done.state, "completed");
  assert.equal(executed.length, 1);
  assert.equal(executed[0]!.botId, bot.id);
  assert.equal(executed[0]!.threadId, thread.id);
  assert.ok(executed[0]!.idempotencyKey.startsWith(`${turn.id}/`));
  const response = engine.tools[0]!;
  assert.equal(response.requestId, "k1");
  assert.deepEqual(response.result, { actionId: (response.result as { actionId: string }).actionId, state: "succeeded", reason: null,
    result: { sent: true, token: { accessToken: "[redacted]" } } });
  assert.equal(store.listMessages(thread.id).at(-1)!.content, "[succeeded]");
  const events = runtime.listTurnEvents({ turnId: turn.id });
  assert.deepEqual(events.map((e) => e.kind), ["turn.queued", "turn.started", "tool.requested", "tool.resolved", "text.delta", "turn.completed"]);
  assert.ok(!JSON.stringify(events).includes("a@example.com"));
});

test("engine idempotency keys are scoped per turn and replays never re-execute", async (t) => {
  const { runtime, executed, startTool, request } = setup(t);
  const first = startTool("t1", [request(), request()]);
  await runtime.waitForTurn(first.id);
  assert.equal(executed.length, 1, "same key twice in one turn executes once");
  const second = startTool("t2", [request()]);
  await runtime.waitForTurn(second.id);
  assert.equal(executed.length, 2, "same key in another turn is a different action, not a read of the old one");
});

test("executor errors are unknown and the same request is never re-run", async (t) => {
  let calls = 0;
  const { store, runtime, engine, startTool, request } = setup(t, "allow", async () => { calls += 1; throw new Error("secret upstream detail"); });
  const turn = startTool("t1", [request(), request()]);
  assert.equal((await runtime.waitForTurn(turn.id)).state, "completed");
  assert.equal(calls, 1);
  assert.deepEqual(engine.tools.map((x) => (x.result as { state: string }).state), ["unknown", "unknown"]);
  assert.equal(store.listActions("unknown").length, 1);
});

test("ask policy waits for approval; deny never executes", async (t) => {
  const { runtime, executed, startTool, request, waitAction } = setup(t, "ask");
  const approved = startTool("t1", [request()]);
  const action = await waitAction(approved.id);
  assert.equal(action.state, "awaiting_approval");
  await delay(20);
  assert.equal(executed.length, 0);
  runtime.decideAction(action.id, { decision: "allow", requestHash: action.requestHash });
  assert.equal((await runtime.waitForTurn(approved.id)).state, "completed");
  assert.equal(executed.length, 1);

  const denied = startTool("t2", [request({ idempotencyKey: "k2" })]);
  const pending = await waitAction(denied.id);
  runtime.decideAction(pending.id, { decision: "deny", requestHash: pending.requestHash });
  await runtime.waitForTurn(denied.id);
  assert.equal(executed.length, 1);
  assert.equal(runtime.getTurn(denied.id).state, "completed");
});

test("grant revocation while waiting blocks the action before dispatch", async (t) => {
  const { store, runtime, executed, startTool, request, waitAction, bot } = setup(t, "ask");
  const turn = startTool("t1", [request()]);
  const action = await waitAction(turn.id);
  store.setGrant({ botId: bot.id, tool: "mail.send", destination: "composio", policy: "deny" });
  await runtime.waitForTurn(turn.id);
  assert.equal(store.getAction(action.id).state, "blocked");
  assert.equal(executed.length, 0);
});

test("cancel or approval expiry ends the wait and a late approval can never execute", async (t) => {
  const { store, runtime, executed, startTool, request, waitAction, clock } = setup(t, "ask");
  const cancelled = startTool("t1", [request()]);
  const action = await waitAction(cancelled.id);
  runtime.cancelTurn(cancelled.id);
  const done = await runtime.waitForTurn(cancelled.id);
  assert.deepEqual([done.state, done.code], ["interrupted", "cancelled"]);
  assert.equal(store.getAction(action.id).state, "denied");
  assert.throws(() => runtime.decideAction(action.id, { decision: "allow", requestHash: action.requestHash }));

  const expiring = startTool("t2", [request({ idempotencyKey: "k2" })]);
  const pending = await waitAction(expiring.id);
  clock.now += 60_000;
  await runtime.waitForTurn(expiring.id);
  assert.deepEqual([store.getAction(pending.id).state, store.getAction(pending.id).reason], ["denied", "approval_expired"]);
  assert.equal(executed.length, 0);
});

test("forged identities fail the turn; ungranted tools are refused without effects", async (t) => {
  const { store, runtime, executed, startTool, request } = setup(t);
  const other = store.createBot({ name: "Other", profileId: "personal", engine: "claude" });
  const spoofed = startTool("t1", [request({ botId: other.id })]);
  const done = await runtime.waitForTurn(spoofed.id);
  assert.deepEqual([done.state, done.code], ["failed", "tool_identity_mismatch"]);
  const otherThread = store.createThread(other.id);
  const crossThread = startTool("t2", [request({ threadId: otherThread.id })]);
  assert.equal((await runtime.waitForTurn(crossThread.id)).code, "tool_identity_mismatch");
  assert.equal(store.listActions().length, 0);

  const unknownTool = startTool("t3", [request({ tool: "files.delete" })]);
  assert.equal((await runtime.waitForTurn(unknownTool.id)).state, "completed");
  const resolved = runtime.listTurnEvents({ turnId: unknownTool.id }).find((e) => e.kind === "tool.resolved")!;
  assert.deepEqual(resolved.data, { actionId: null, code: "forbidden", state: "refused" });
  const secret = startTool("t4", [request({ arguments: { apiKey: "nope" } })]);
  await runtime.waitForTurn(secret.id);
  assert.equal(store.listActions().length, 0);
  assert.equal(executed.length, 0);
});
