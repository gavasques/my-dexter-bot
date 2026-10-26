import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ConnectionWorkflow, ConnectionWorkflowSelection, JsonValue } from "@dexter/contracts";
import type { EngineDriver, EngineEvent, EngineSession } from "@dexter/engines";
import { HostStore, dispatchAction, ConversationRuntime } from "@dexter/hub";
import { SyntheticCredentialBroker, CapabilityGateway } from "@dexter/gateway";
import type { ConnectionsAdmin, NativeMcpAdmin } from "@dexter/connectors";
import { HostServices } from "../packages/cli/src/host-services.js";
import { connectionWorkflows } from "../packages/cli/src/connection-workflows.js";
import type { WorkspaceNativeOptions } from "../packages/cli/src/workspace-driver.js";
import { gatewayReceiptEvidence } from "../packages/engines/src/mcp-options.js";
import {
  ACCESS_TOKEN, COMPOSIO_KEY, REFRESH_TOKEN, SERVICE_ORIGIN, SEND, READ,
  remapFetch, serviceLab,
} from "./fixtures/connections-lab.js";

const originalTask = "Complete the synthetic original task: send one exact message to owner@example.test.";
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function until(check: () => boolean, timeout = 8_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() >= end) throw new Error("composed fixture deadline"); await delay(5); }
}
type Receipt = { actionId: string; status: string; requestHash: string; result: any };
type Era = "legacy" | "pin" | "auto";

/** A scripted engine, but a real SDK client / child process / private Unix gateway lease. */
class SetupEngine implements EngineDriver {
  readonly capabilities = { resume: true, interrupt: true, fork: false, steer: false };
  readonly client: Client;
  readonly inputs: string[] = [];
  readonly receipts: Receipt[] = [];
  readonly exposed: unknown[] = [];
  failure: unknown;
  transport?: StdioClientTransport;
  constructor(readonly id: "claude", readonly options: WorkspaceNativeOptions, readonly era: Era = "legacy") {
    this.client = new Client({ name: "dexter-composed-fixture", version: "1" },
      era === "legacy" ? {} : { versionNegotiation: { mode: era === "auto" ? "auto" : { pin: "2026-07-28" } } });
  }
  async status() { return { engine: this.id, installed: true, version: "synthetic", authentication: "authenticated" as const, billing: "subscription" as const }; }
  async open(threadId: string, cursor?: string): Promise<EngineSession> {
    assert.ok(this.options.localMcpServer);
    this.transport = new StdioClientTransport({ command: this.options.localMcpServer.command,
      args: [...this.options.localMcpServer.args], env: { PATH: "/usr/bin:/bin" }, stderr: "pipe" });
    try {
      await this.client.connect(this.transport);
      assert.equal(this.client.getNegotiatedProtocolVersion(), this.era === "legacy" ? "2025-11-25" : "2026-07-28");
      this.exposed.push(await this.client.listTools());
    }
    catch (error) { this.failure = error; throw error; }
    return { threadId, nativeCursor: cursor ?? randomUUID() };
  }
  async find(name: string) {
    let result;
    try { result = await this.client.callTool({ name: "dx_catalog_search", arguments: { query: name, limit: 20 } }); }
    catch (error) { this.failure = error; throw error; }
    assert.equal(result.isError, false);
    const tools = (result.structuredContent as { tools: Array<{ alias: string; title: string; account: string }> }).tools;
    return tools.find(tool => tool.title === name);
  }
  async call(name: string, callId: string, input: Record<string, unknown>): Promise<Receipt> {
    const tool = await this.find(name); assert.ok(tool, `${name} must be admitted to this turn`);
    const result = await this.client.callTool({ name: "dx_catalog_call", arguments: { alias: tool.alias, callId, input } }, { timeout: 8_000 });
    assert.equal(result.isError, false, JSON.stringify(result));
    const receipt = result.structuredContent as unknown as Receipt;
    this.receipts.push(receipt);
    return receipt;
  }
  async *turn(session: EngineSession, turnId: string, input: string): AsyncIterable<EngineEvent> {
    this.inputs.push(input);
    const identity = { threadId: session.threadId, turnId };
    let receipt: Receipt;
    if (input.includes("HOST CONNECTION SETUP RESULT")) {
      assert.ok(input.includes(originalTask), "continuation retains the exact original task");
      assert.ok(await this.find(SEND.name), "new lease admits the explicitly selected account/tool");
      assert.equal(await this.find(READ.name), undefined, "an unselected tool is not admitted");
      receipt = await this.call(SEND.name, "synthetic-original-effect", { recipient: "owner@example.test", body: "One approved synthetic message." });
      // New JSON-RPC IDs with the original logical call ID retrieve the same receipt.
      assert.deepEqual(await this.call(SEND.name, "synthetic-original-effect", { recipient: "owner@example.test", body: "One approved synthetic message." }), receipt);
    } else {
      const catalog = (await this.call("dexter.harness.connections.catalog", "setup-catalog", {})).result;
      const status = (await this.call("dexter.harness.status", "own-status", {})).result;
      assert.equal(await this.find(SEND.name), undefined, "no account is inferred before login/grants");
      receipt = await this.call("dexter.harness.connections.request", "setup-request", { request_json: JSON.stringify({
        clientRequestId: randomUUID(), expectedBotRevision: status.bot.revision,
        target: { kind: "managed", serviceId: "gmail", catalogPin: catalog.pin },
      }) });
    }
    // Real native drivers derive this event from their provider's explicit tool-result transcript.
    // This fixture uses the same parser on the actual SDK tool result, never assistant prose.
    for (const evidence of gatewayReceiptEvidence(receipt)) yield { type: "tool.result.observed", ...identity, ...evidence };
    yield { type: "text.delta", ...identity, text: input.includes("HOST CONNECTION SETUP RESULT")
      ? "Completed the original task from its confirmed receipt." : "Setup request created; waiting for the owner." };
    yield { type: "turn.completed", ...identity, usage: null };
  }
  async respondToTool(_session: EngineSession, _turnId: string, _id: string, _value: JsonValue) {}
  async interrupt() { await this.client.close(); }
  async close() { await this.client.close(); }
}

async function composed(t: TestContext, era: Era = "legacy") {
  const svc = await serviceLab(t), dir = mkdtempSync(join(tmpdir(), "dx-composed-setup-"));
  const seed = new HostStore({ dataDir: dir }), hostId = seed.hostId, ownerId = seed.ownerId; seed.close();
  const capability = svc.issue({ installationId: hostId, ownerId });
  const engines: SetupEngine[] = [];
  const services = new HostServices({ dataDir: dir, enableEngines: true, enableMcp: true,
    enableGroups: false, enableWorkspaceTools: false,
    connections: { credentialRef: "fixture-connections", platform: { origin: SERVICE_ORIGIN,
      capability: () => capability, fetch: remapFetch({ [SERVICE_ORIGIN]: svc.url }), limits: { timeoutMs: 2_000 } } },
    makeDriver(engine, options) {
      assert.equal(engine, "claude");
      const fixture = new SetupEngine("claude", options, era);
      if (options.localMcpServer) engines.push(fixture);
      return fixture;
    },
  });
  t.after(async () => { await services.shutdown({ graceMs: 3_000 }); rmSync(dir, { recursive: true, force: true }); });
  const store = services.store, bot = store.createBot({ name: "Composed setup", profileId: "default", engine: "claude" }), thread = store.createThread(bot.id);
  const started = services.runtime!.startTurn(thread.id, { clientRequestId: randomUUID(), content: originalTask }).turn;
  await until(() => store.listActions("awaiting_approval").some(a => a.request.tool === "dexter.harness.connections.request")
    || !["queued", "running"].includes(store.getTurn(started.id).state));
  assert.ok(store.listActions("awaiting_approval").length, `setup admission failed: ${String(engines[0]?.failure)}; ${store.getTurn(started.id).code}`);
  const approval = store.listActions("awaiting_approval").find(a => a.request.tool === "dexter.harness.connections.request")!;
  assert.equal(svc.composio.accounts.size, 0, "setup proposal never creates an OAuth account");
  services.runtime!.decideAction(approval.id, { decision: "allow", requestHash: approval.requestHash });
  assert.equal((await services.runtime!.waitForTurn(started.id)).state, "completed");
  await until(() => services.runtime!.status().pending.sessions === 0);
  const workflow = services.connectionWorkflows.list().requests[0]!;
  assert.equal(workflow.originTurnId, started.id); assert.equal(workflow.actionId, approval.id);
  return { svc, dir, services, store, bot, thread, started, engines, workflow, capability };
}

async function login(f: Awaited<ReturnType<typeof composed>>, profileId = f.bot.profileId, afterStart?: () => void) {
  const catalog = await f.services.connectionsHttp.catalog();
  const input = { expectedHostID: f.store.hostId, clientRequestId: randomUUID(), serviceId: "gmail", catalogPin: catalog.pin,
    profileId, label: "Exact synthetic account", replacesAccountId: null, setupRequestId: f.workflow.id };
  const started = await f.services.connectionsHttp.startAuthorization(input);
  const replay = await f.services.connectionsHttp.startAuthorization(input);
  assert.equal(replay.authorization.id, started.authorization.id);
  assert.equal(f.svc.composio.count("POST", "/api/v3.1/connected_accounts/link"), 1);
  afterStart?.();
  const ref = [...f.svc.composio.accounts.keys()][0]!;
  f.svc.composio.complete(ref, "Verified synthetic owner", "owner@example.test");
  await f.services.connectionsHttp.callback(input.clientRequestId, { expectedHostID: f.store.hostId, outcome: "returned", providerAccountRef: null });
  const authorization = await f.services.connectionsHttp.authorization(input.clientRequestId);
  assert.equal(authorization.state, "connected"); assert.equal(authorization.id, started.authorization.id);
  assert.equal(authorization.setupRequestId, f.workflow.id);
  const account = await f.services.connectionsHttp.account(authorization.accountId!);
  assert.equal(account.identity.confirmation, "provider_verified");
  return { input, started, authorization, account, ref };
}

for (const era of ["legacy", "pin", "auto"] as const) test(`${era === "legacy" ? "2025 legacy" : `2026-07-28 ${era}`}: engine → exact setup approval → hosted OAuth → exact tool grant → correlated fresh SDK lease → one effect → receipt → answer`, { timeout: 20_000 }, async t => {
  const f = await composed(t, era), connected = await login(f);
  assert.deepEqual(f.services.connectionWorkflows.choices(f.workflow.id).authorizationRequestIds, [], "completed authorization is no longer a live login request");
  assert.equal((await f.services.connectionsHttp.authorization(connected.input.clientRequestId)).state, "connected");
  assert.equal(connected.authorization.setupRequestId, f.workflow.id, "the historical receipt remains correlated to this setup");
  assert.equal(f.store.listTurns(f.thread.id).length, 1, "successful login alone never resumes or grants");
  assert.equal(f.svc.composio.count("POST", "/api/v3.1/tools/execute/GMAIL_SEND_EMAIL"), 0);
  const accessInput = { expectedHostID: f.store.hostId, clientRequestId: randomUUID(), expectedRevision: connected.account.revision,
    botId: f.bot.id, enabled: true, toolNames: [SEND.name] };
  const access = f.services.connectionsHttp.setAccess(connected.account.id, accessInput);
  assert.deepEqual(f.services.connectionsHttp.setAccess(connected.account.id, accessInput), access);
  const choices = f.services.connectionWorkflows.choices(f.workflow.id);
  assert.equal(choices.choices.length, 1);
  const choice = choices.choices[0]!, selected = choice.tools.filter(tool => tool.enabled);
  assert.deepEqual(selected.map(tool => tool.name), [SEND.name]);
  const complete = { expectedHostID: f.store.hostId, clientRequestId: randomUUID(), expectedRevision: f.workflow.revision,
    selections: [{ connectionId: choice.connectionId, expectedRevision: choice.expectedRevision,
      tools: selected.map(({ name, manifestHash }) => ({ name, manifestHash })) }] };
  const ready = f.services.connectionWorkflows.complete(f.workflow.id, complete);
  assert.deepEqual(f.services.connectionWorkflows.complete(f.workflow.id, complete), ready);
  assert.equal(f.store.getTurn(ready.continuationTurnId!).inputMessageId, f.started.inputMessageId);
  await until(() => f.store.listActions("awaiting_approval").some(a => a.request.tool === SEND.name));
  const effect = f.store.listActions("awaiting_approval").find(a => a.request.tool === SEND.name)!;
  assert.equal(effect.request.destination, choice.connectionId);
  assert.deepEqual(effect.request.arguments.input, { recipient: "owner@example.test", body: "One approved synthetic message." });
  f.services.runtime!.decideAction(effect.id, { decision: "allow", requestHash: effect.requestHash });
  assert.equal((await f.services.runtime!.waitForTurn(ready.continuationTurnId!)).state, "completed");
  await until(() => f.services.runtime!.status().pending.sessions === 0);
  assert.equal(f.store.listTurns(f.thread.id).length, 2, "one setup continuation, no invented chat input or receipt loop");
  assert.equal(f.engines.length, 2, "new tools are attached through a fresh admitted driver lease");
  assert.notEqual(f.engines[0]!.options.localMcpServer!.args[1], f.engines[1]!.options.localMcpServer!.args[1]);
  assert.equal(f.svc.composio.count("POST", "/api/v3.1/tools/execute/GMAIL_SEND_EMAIL"), 1);
  const executed = f.svc.composio.requests.find(request => request.method === "POST" && request.path === "/api/v3.1/tools/execute/GMAIL_SEND_EMAIL")!;
  assert.equal((executed.body as { connected_account_id: string }).connected_account_id, connected.ref, "only the exact owner-selected account executes");
  assert.equal(f.store.toolActionProgress(f.workflow.actionId)?.consumedByEngine, true);
  assert.equal(f.store.getAction(effect.id).state, "succeeded");
  assert.equal(f.store.toolActionProgress(effect.id)?.consumedByEngine, true);
  assert.ok(f.store.turnInput(ready.continuationTurnId!).includes(originalTask));
  assert.ok(f.store.listMessages(f.thread.id).some(message => message.content === "Completed the original task from its confirmed receipt."));
  await until(() => f.engines.every(engine => !existsSync(dirname(engine.options.localMcpServer!.args[1]!))));
  for (const engine of f.engines) {
    assert.equal(existsSync(dirname(engine.options.localMcpServer!.args[1]!)), false, "owned Unix lease drained");
    assert.equal(engine.transport!.pid, null, "the test-owned SDK child process has exited");
  }
  for (const file of readdirSync(f.dir).filter(name => name.includes(".sqlite"))) {
    const bytes = readFileSync(join(f.dir, file));
    for (const secret of [f.capability, COMPOSIO_KEY, ACCESS_TOKEN, REFRESH_TOKEN, "/link/lk_"]) assert.equal(bytes.includes(secret), false, `${file} has no credential/link`);
  }
});

test("Stop before a late OAuth callback keeps the connected account private and never continues the original task", { timeout: 15_000 }, async t => {
  const f = await composed(t), connected = await login(f, f.bot.profileId, () => f.store.withdrawTurnToolActions(f.started.id));
  assert.equal(connected.account.status, "connected", "a real OAuth completion is still recorded honestly");
  assert.equal(f.services.connectionWorkflows.get(f.workflow.id)?.state, "stopped");
  assert.equal(f.store.getGrant(f.bot.id, SEND.name, connected.account.gatewayConnectionIds[0]!), null);
  const choice = f.services.connectionWorkflows.choices(f.workflow.id).choices[0]!;
  assert.throws(() => f.services.connectionWorkflows.complete(f.workflow.id, { expectedHostID: f.store.hostId,
    clientRequestId: randomUUID(), expectedRevision: f.workflow.revision, selections: [{ connectionId: choice.connectionId,
      expectedRevision: choice.expectedRevision, tools: choice.tools.map(({ name, manifestHash }) => ({ name, manifestHash })) }] }));
  assert.equal(f.store.listTurns(f.thread.id).length, 1); assert.equal(f.engines.length, 1);
  assert.equal(f.svc.composio.count("POST", "/api/v3.1/tools/execute/GMAIL_SEND_EMAIL"), 0);
});

test("a setup-bound OAuth request refuses another bot profile before contacting the provider", { timeout: 15_000 }, async t => {
  const f = await composed(t);
  f.store.createBot({ name: "Other profile", profileId: "other", engine: "claude" });
  const catalog = await f.services.connectionsHttp.catalog();
  await assert.rejects(f.services.connectionsHttp.startAuthorization({ expectedHostID: f.store.hostId,
    clientRequestId: randomUUID(), serviceId: "gmail", catalogPin: catalog.pin, profileId: "other", label: null,
    replacesAccountId: null, setupRequestId: f.workflow.id }));
  assert.equal(f.svc.composio.accounts.size, 0); assert.equal(f.store.listTurns(f.thread.id).length, 1);
});

test("revoked exact account/tool access and changed connection revision cannot complete a setup", { timeout: 15_000 }, async t => {
  const f = await composed(t), { account } = await login(f);
  f.services.connectionsHttp.setAccess(account.id, { expectedHostID: f.store.hostId, clientRequestId: randomUUID(),
    expectedRevision: account.revision, botId: f.bot.id, enabled: true, toolNames: [SEND.name] });
  const choice = f.services.connectionWorkflows.choices(f.workflow.id).choices[0]!, selected = choice.tools.find(tool => tool.name === SEND.name)!;
  const body = { expectedHostID: f.store.hostId, clientRequestId: randomUUID(), expectedRevision: f.workflow.revision,
    selections: [{ connectionId: choice.connectionId, expectedRevision: choice.expectedRevision, tools: [{ name: selected.name, manifestHash: selected.manifestHash }] }] };
  f.store.setGrant({ botId: f.bot.id, tool: SEND.name, destination: choice.connectionId, policy: "deny" });
  assert.throws(() => f.services.connectionWorkflows.complete(f.workflow.id, body));
  f.store.setGrant({ botId: f.bot.id, tool: SEND.name, destination: choice.connectionId, policy: "ask" });
  f.services.gateway!.revokeConnection(choice.connectionId);
  assert.throws(() => f.services.connectionWorkflows.complete(f.workflow.id, { ...body, clientRequestId: randomUUID() }));
  assert.equal(f.store.listTurns(f.thread.id).length, 1);
  assert.equal(f.svc.composio.count("POST", "/api/v3.1/tools/execute/GMAIL_SEND_EMAIL"), 0);
});

test("revocation after setup completion is rechecked by the fresh driver before any external effect", { timeout: 15_000 }, async t => {
  const f = await composed(t), { account } = await login(f);
  f.services.connectionsHttp.setAccess(account.id, { expectedHostID: f.store.hostId, clientRequestId: randomUUID(),
    expectedRevision: account.revision, botId: f.bot.id, enabled: true, toolNames: [SEND.name] });
  const choice = f.services.connectionWorkflows.choices(f.workflow.id).choices[0]!, tool = choice.tools.find(item => item.name === SEND.name)!;
  const completed = f.services.connectionWorkflows.complete(f.workflow.id, { expectedHostID: f.store.hostId,
    clientRequestId: randomUUID(), expectedRevision: f.workflow.revision, selections: [{ connectionId: choice.connectionId,
      expectedRevision: choice.expectedRevision, tools: [{ name: tool.name, manifestHash: tool.manifestHash }] }] });
  f.store.setGrant({ botId: f.bot.id, tool: SEND.name, destination: choice.connectionId, policy: "deny" });
  const ended = await f.services.runtime!.waitForTurn(completed.continuationTurnId!);
  assert.notEqual(ended.state, "completed", "the engine cannot manufacture a successful original-task answer after revocation");
  assert.equal(f.svc.composio.count("POST", "/api/v3.1/tools/execute/GMAIL_SEND_EMAIL"), 0);
  assert.equal(f.store.listActions().filter(action => action.request.tool === SEND.name).length, 0);
  assert.equal(f.store.listTurns(f.thread.id).length, 2);
});

async function nativeCoordinator(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "dx-native-setup-coordinator-")), clock = { now: Date.now() };
  const store = new HostStore({ dataDir: dir, clock: () => clock.now });
  const broker = new SyntheticCredentialBroker(); broker.put("cred", { headers: {}, allowedHosts: ["native.test"] });
  let effects = 0;
  const gateway = new CapabilityGateway({ store, broker, adapter: { async execute() { effects++; return { ok: true }; } } });
  const manifest = { ...SEND, name: "mcp.fixture.send", toolkit: "mcp-fixture", upstreamHost: "native.test" };
  gateway.registerTool(manifest);
  const bot = store.createBot({ name: "Native setup", profileId: "default", engine: "claude" }), thread = store.createThread(bot.id);
  const origin = store.createTurn(thread.id, { clientRequestId: randomUUID(), content: originalTask }).turn; store.claimNextTurn(thread.id);
  let pin = "c".repeat(64);
  const runtime = new ConversationRuntime({ store, drivers: [] });
  t.after(async () => { await runtime.shutdown({ closeStore: false }); gateway.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const coordinator = connectionWorkflows(store, { gateway: () => gateway,
    managed: () => ({ accounts: () => ({ items: [] }) }) as unknown as Readonly<ConnectionsAdmin>,
    native: () => ({ instancePin: () => pin }) as unknown as Readonly<NativeMcpAdmin>, runtime: () => runtime });
  store.setGrant({ botId: bot.id, tool: "dexter.harness.connections.request", destination: "dexter-harness-owner-proposals", policy: "ask" });
  const action = store.requestAction({ botId: bot.id, threadId: thread.id, tool: "dexter.harness.connections.request",
    destination: "dexter-harness-owner-proposals", arguments: {}, idempotencyKey: randomUUID() });
  store.bindToolAction(action.id, origin.id, "native-setup"); store.decideAction(action.id, { decision: "allow", requestHash: action.requestHash });
  let workflow!: ConnectionWorkflow;
  assert.equal((await dispatchAction(store, action.id, async () => {
    workflow = await coordinator.request(action.id, { clientRequestId: randomUUID(), expectedBotRevision: bot.revision,
      target: { kind: "native_mcp", serverId: "fixture", instancePin: pin } }); return { requestId: workflow.id };
  })).state, "succeeded");
  store.finishTurn(origin.id, "completed", null);
  const connection = gateway.connectAccount({ profileId: bot.profileId, toolkit: "mcp-fixture", label: "Exact native instance",
    upstreamAccountRef: "native-fixture", credentialRef: "cred", allowedHosts: ["native.test"] });
  store.setGrant({ botId: bot.id, tool: manifest.name, destination: connection.id, policy: "ask" });
  const unrelated = gateway.connectAccount({ profileId: bot.profileId, toolkit: "mcp-other", label: "Other native instance",
    upstreamAccountRef: "native-other", credentialRef: "cred", allowedHosts: ["native.test"] });
  const choices = coordinator.choices(workflow.id);
  const selections: ConnectionWorkflowSelection[] = choices.choices.map(({ connectionId, expectedRevision, tools }) => ({ connectionId, expectedRevision,
    tools: tools.filter(tool => tool.enabled).map(({ name, manifestHash }) => ({ name, manifestHash })) }));
  return { store, gateway, bot, workflow, coordinator, choices, selections, unrelated, clock,
    effects: () => effects, changePin: () => { pin = "d".repeat(64); } };
}

test("native setup choices use the actual mcp-{id} toolkit and refuse other instance, stale pin and schema pin", async t => {
  const f = await nativeCoordinator(t);
  assert.equal(f.choices.choices.length, 1); assert.equal(f.choices.choices[0]!.label, "Exact native instance");
  assert.equal(f.selections[0]!.tools.length, 1, "the native toolkit naming is not silently filtered out");
  const input = { expectedHostID: f.store.hostId, clientRequestId: randomUUID(), expectedRevision: f.workflow.revision, selections: f.selections };
  assert.throws(() => f.coordinator.complete(f.workflow.id, { ...input, selections: [{ ...f.selections[0], connectionId: f.unrelated.id }] }));
  assert.throws(() => f.coordinator.complete(f.workflow.id, { ...input, selections: [{ ...f.selections[0], tools: [{ ...f.selections[0]!.tools[0], manifestHash: "e".repeat(64) }] }] }));
  f.changePin(); assert.throws(() => f.coordinator.complete(f.workflow.id, input));
  assert.equal(f.store.listTurns(f.workflow.threadId).length, 1); assert.equal(f.effects(), 0);
});

test("expired and cancelled native setup requests cannot enqueue late continuations; cancel replay is inert", async t => {
  const f = await nativeCoordinator(t), body = { expectedHostID: f.store.hostId, clientRequestId: randomUUID(), expectedRevision: f.workflow.revision };
  const cancelled = f.coordinator.cancel(f.workflow.id, body); assert.deepEqual(f.coordinator.cancel(f.workflow.id, body), cancelled);
  assert.throws(() => f.coordinator.complete(f.workflow.id, { ...body, clientRequestId: randomUUID(), selections: f.selections }));
  assert.equal(f.store.listTurns(f.workflow.threadId).length, 1); assert.equal(f.effects(), 0);
  const e = await nativeCoordinator(t); e.clock.now = e.workflow.expiresAt + 1;
  assert.equal(e.coordinator.get(e.workflow.id)?.state, "expired");
  assert.throws(() => e.coordinator.complete(e.workflow.id, { expectedHostID: e.store.hostId, clientRequestId: randomUUID(),
    expectedRevision: e.workflow.revision, selections: e.selections }));
  assert.equal(e.store.listTurns(e.workflow.threadId).length, 1); assert.equal(e.effects(), 0);
});
