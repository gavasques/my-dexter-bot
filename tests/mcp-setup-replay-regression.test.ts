import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HostStore, dispatchAction, type ConversationRuntime } from "@dexter/hub";
import { CapabilityGateway, type AdapterCall } from "@dexter/gateway";
import type { ConnectionsAdmin, NativeMcpAdmin } from "@dexter/connectors";
import type { ConnectionWorkflow, McpPrivateInput } from "@dexter/contracts";
import { connectionWorkflows } from "../packages/cli/src/connection-workflows.js";
import { McpPrivateInputCoordinator } from "../packages/cli/src/mcp-private-input.js";

const form = { r1: { method: "elicitation/create", params: { mode: "form", message: "Confirm a synthetic choice.",
  requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"], additionalProperties: false } } } };
const manifest = { name: "fixture.write", toolkit: "fixture", version: "1.0.0", upstreamSlug: "WRITE", upstreamHost: "fixture.example.test",
  description: "Synthetic operation", effect: "write" as const, destinationArgument: null, destinationOrigins: null,
  inputSchema: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const } };

async function setupFixture(t: { after(fn: () => void): void }, uncertain: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "dx-setup-replay-review-")); let now = Date.now();
  const store = new HostStore({ dataDir: dir, clock: () => now });
  let effects = 0;
  const gateway = new CapabilityGateway({ store, broker: { acquire: () => ({ headers: {} }), secretValues: () => [] },
    adapter: { execute: async () => { effects++; if (uncertain) throw new Error("Synthetic lost ACK after dispatch."); return { ok: true }; } } });
  t.after(() => { gateway.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const bot = store.createBot({ name: "Synthetic setup replay", profileId: "default", engine: "claude" }), thread = store.createThread(bot.id);
  const origin = store.createTurn(thread.id, { clientRequestId: randomUUID(), content: "Perform this operation and connect the next service." }).turn;
  store.claimNextTurn(thread.id); gateway.registerTool(manifest);
  const connection = gateway.connectAccount({ profileId: "default", toolkit: "fixture", label: "Synthetic", upstreamAccountRef: "synthetic",
    credentialRef: "fixture", allowedHosts: [manifest.upstreamHost] });
  store.setGrant({ botId: bot.id, tool: manifest.name, destination: connection.id, policy: "allow" });
  const original = await gateway.call(gateway.issueCapability({ turnId: origin.id }).token,
    { callId: "original-effect", tool: manifest.name, connectionId: connection.id, arguments: {} });
  assert.equal(original.status, uncertain ? "unknown" : "succeeded");
  store.setGrant({ botId: bot.id, tool: "dexter.harness.connections.request", destination: "dexter-harness-owner-proposals", policy: "ask" });
  const action = store.requestAction({ botId: bot.id, threadId: thread.id, tool: "dexter.harness.connections.request",
    destination: "dexter-harness-owner-proposals", arguments: {}, idempotencyKey: randomUUID() });
  store.bindToolAction(action.id, origin.id, "setup"); store.decideAction(action.id, { decision: "allow", requestHash: action.requestHash });
  let workflow!: ConnectionWorkflow;
  await dispatchAction(store, action.id, async () => {
    workflow = store.createConnectionWorkflow(action.id, { clientRequestId: randomUUID(), expectedBotRevision: bot.revision,
      target: { kind: "managed", serviceId: "fixture", catalogPin: "a".repeat(64) } });
    return { setupRequestId: workflow.id };
  });
  store.finishTurn(origin.id, "completed", null);
  const tool = gateway.registry.getTool(manifest.name)!;
  const workflows = connectionWorkflows(store, { gateway: () => gateway,
    managed: () => ({ accounts: () => ({ items: [{ gatewayConnectionIds: [connection.id], status: "connected", serviceId: "fixture", profileId: "default",
      tools: [{ name: manifest.name, manifestHash: tool.manifestHash }] }] }) }) as unknown as Readonly<ConnectionsAdmin>,
    native: () => ({}) as Readonly<NativeMcpAdmin>, runtime: () => ({ scheduleConnectionWorkflow() {} }) as unknown as ConversationRuntime });
  const ready = workflows.complete(workflow.id, { expectedHostID: store.hostId, clientRequestId: randomUUID(), expectedRevision: workflow.revision,
    selections: [{ connectionId: connection.id, expectedRevision: connection.revision, tools: [{ name: manifest.name, manifestHash: tool.manifestHash }] }] });
  store.claimNextTurn(thread.id);
  return { store, gateway, original, connection, ready, origin, bot, advance: () => { now++; }, effects: () => effects };
}

for (const uncertain of [false, true]) for (const sameCallId of [true, false]) {
  test(`setup continuation keeps the original ${uncertain ? "unknown" : "succeeded"} receipt with a ${sameCallId ? "same" : "fresh"} model call ID`, async t => {
    const f = await setupFixture(t, uncertain);
    const result = await f.gateway.call(f.gateway.issueCapability({ turnId: f.ready.continuationTurnId! }).token,
      { callId: sameCallId ? "original-effect" : "fresh-engine-call", tool: manifest.name, connectionId: f.connection.id, arguments: {} });
    assert.equal(result.actionId, f.original.actionId);
    assert.equal(result.status, f.original.status);
    assert.equal(result.requestHash, f.original.requestHash);
    assert.equal(f.effects(), 1, "the setup continuation must not dispatch an already terminal effect again");
    assert.equal(f.store.listActions().length, 2, "one original effect plus the exact setup action");
  });
}

test("501 other-bot setup receipts do not hide a new request or remove Stop/continuation authority", async t => {
  const f = await setupFixture(t, false), store = f.store;
  const other = store.createBot({ name: "Synthetic setup history", profileId: "default", engine: "claude" }), thread = store.createThread(other.id);
  const origin = store.createTurn(thread.id, { clientRequestId: randomUUID(), content: "Synthetic setup history." }).turn;
  store.claimNextTurn(thread.id);
  store.setGrant({ botId: other.id, tool: "dexter.harness.connections.request", destination: "dexter-harness-owner-proposals", policy: "ask" });
  const pending = async (botId: string, threadId: string, turnId: string, callId: string) => {
    const action = store.requestAction({ botId, threadId, tool: "dexter.harness.connections.request", destination: "dexter-harness-owner-proposals",
      arguments: {}, idempotencyKey: randomUUID() });
    store.bindToolAction(action.id, turnId, callId); store.decideAction(action.id, { decision: "allow", requestHash: action.requestHash });
    let workflow!: ConnectionWorkflow;
    await dispatchAction(store, action.id, async () => { workflow = store.createConnectionWorkflow(action.id, {
      clientRequestId: randomUUID(), expectedBotRevision: store.getBot(botId).revision,
      target: { kind: "managed", serviceId: "fixture", catalogPin: "a".repeat(64) },
    }); return { setupRequestId: workflow.id }; });
    return workflow;
  };
  f.advance();
  for (let i = 0; i < 501; i++) {
    const historical = await pending(other.id, thread.id, origin.id, `history-${i}`);
    store.cancelConnectionWorkflow(historical.id, { expectedHostID: store.hostId, clientRequestId: randomUUID(), expectedRevision: historical.revision });
  }
  store.finishTurn(origin.id, "completed", null); f.advance();
  const newest = await pending(f.bot.id, f.ready.threadId, f.ready.continuationTurnId!, "latest-setup");
  store.finishTurn(newest.originTurnId, "completed", null);
  assert.ok(store.connectionWorkflows(f.bot.id).some(workflow => workflow.id === newest.id), "filter the bot before applying a global page bound");
  assert.ok(!store.connectionWorkflows().some(workflow => workflow.id === f.ready.id), "the old ready workflow is genuinely outside the global page");
  assert.ok(store.connectionWorkflowContinuations(f.origin.id).includes(f.ready.continuationTurnId!), "continuation authority must not come from a UI page");
  store.withdrawTurnToolActions(newest.originTurnId);
  assert.equal(store.connectionWorkflow(newest.id)?.state, "stopped");
  assert.throws(() => store.completeConnectionWorkflow(newest.id, { expectedHostID: store.hostId, clientRequestId: randomUUID(),
    expectedRevision: newest.revision, selections: f.ready.selections }), (error: { code?: string }) => error.code === "conflict");
  store.withdrawTurnToolActions(f.origin.id);
  assert.equal(store.connectionWorkflow(f.ready.id)?.state, "stopped", "Stop reaches an old setup that is absent from the list page");
  assert.equal(f.effects(), 1);
});

test("a private form remains answerable beyond 500 historical inputs and response UUID dedupe covers the full journal", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dx-form-history-review-")), store = new HostStore({ dataDir: dir });
  let coordinator!: McpPrivateInputCoordinator, captured!: AdapterCall, release!: () => void;
  const admitted = new Promise<void>(resolve => { release = resolve; });
  const gateway = new CapabilityGateway({ store, broker: { acquire: () => ({ headers: {} }), secretValues: () => [] }, adapter: {
    execute: async (call, _auth, context) => { captured = call; release(); await coordinator.request(call, form, context.signal); return { ok: true }; },
  } });
  coordinator = new McpPrivateInputCoordinator(store, () => gateway);
  t.after(() => { coordinator.close(); gateway.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const bot = store.createBot({ name: "Synthetic form history", profileId: "default", engine: "claude" }), thread = store.createThread(bot.id);
  const turn = store.createTurn(thread.id, { clientRequestId: randomUUID(), content: "Synthetic private form operation." }).turn;
  store.claimNextTurn(thread.id); gateway.registerTool(manifest);
  const connection = gateway.connectAccount({ profileId: "default", toolkit: "fixture", label: "Synthetic", upstreamAccountRef: "synthetic",
    credentialRef: "fixture", allowedHosts: [manifest.upstreamHost] });
  store.setGrant({ botId: bot.id, tool: manifest.name, destination: connection.id, policy: "allow" });
  const operation = gateway.call(gateway.issueCapability({ turnId: turn.id }).token,
    { callId: "form-effect", tool: manifest.name, connectionId: connection.id, arguments: {} });
  // A failed assertion may close the own fixture while the original form is still waiting.
  void operation.catch(() => {});
  await admitted;
  const input = coordinator.list().requests.find(entry => entry.actionId === captured.actionId)!; assert.ok(input);
  const reusedRequestId = randomUUID();
  // Valid historical metadata only: no upstream requestState or answered values are persisted.
  for (let i = 0; i < 501; i++) {
    const history: McpPrivateInput = { ...input, id: `a_history_${i.toString().padStart(4, "0")}`, createdAt: input.createdAt - 10_000 + i,
      expiresAt: input.expiresAt - 10_000 + i, revision: 1, state: "pending", responseHash: null, clientRequestId: null };
    store.recordMcpPrivateInput(history);
    store.recordMcpPrivateInput({ ...history, revision: 2, state: "answered", responseHash: "a".repeat(64), clientRequestId: i === 0 ? reusedRequestId : randomUUID() });
  }
  assert.ok(coordinator.get(input.id), "single-ID recovery is independent of the bounded list page");
  const body = { expectedHostID: store.hostId, clientRequestId: reusedRequestId, expectedRevision: input.revision, actionId: input.actionId,
    requestHash: input.requestHash, approval: "approve_exact_input", responses: { r1: { action: "accept", content: { confirm: true } } } };
  assert.throws(() => coordinator.respond(input.id, body), (error: { code?: string }) => error.code === "conflict",
    "a response UUID used outside the visible page cannot be reused for another form");
  const answered = coordinator.respond(input.id, { ...body, clientRequestId: randomUUID() });
  assert.equal(answered.state, "answered"); assert.ok(!("responses" in answered));
  assert.equal((await operation).actionId, input.actionId);
});
