import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { EngineId, JsonValue } from "@dexter/contracts";
import type { EngineDriver, EngineEvent, EngineSession } from "@dexter/engines";
import { HostStore } from "@dexter/hub";
import { HostServices } from "../packages/cli/src/host-services.js";
import type { WorkspaceNativeOptions } from "../packages/cli/src/workspace-driver.js";
import { gatewayReceiptEvidence, LOCAL_MCP_CLIENT_TIMEOUT_MS } from "../packages/engines/src/mcp-options.js";
import { SEND, SERVICE_ORIGIN, remapFetch, serviceLab } from "./fixtures/connections-lab.js";

const task = "Send the exact synthetic message and connect Gmail for the rest of this task.";
const input = { recipient: "owner@example.test", body: "One synthetic message." };
type Receipt = { actionId: string; requestHash: string; status: string; result: any; hostContinuation?: boolean };
let accelerateSetupDeadline = false;
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!check()) { if (Date.now() > deadline) throw new Error("own late-setup fixture deadline"); await new Promise<void>(done => setTimeout(done, 5)); }
}

/** Real SDK, child wrapper and host lease; only provider inference is scripted. */
class LateSetupEngine implements EngineDriver {
  readonly capabilities = { resume: true, interrupt: true, fork: false, steer: false };
  readonly client = new Client({ name: "late-setup-regression", version: "1" });
  readonly receipts: Receipt[] = [];
  failure: unknown;
  constructor(readonly id: EngineId, readonly options: WorkspaceNativeOptions, readonly freshCallId: boolean) {}
  async status() { return { engine: this.id, installed: true, version: "synthetic", authentication: "authenticated" as const, billing: "subscription" as const }; }
  async open(threadId: string): Promise<EngineSession> {
    assert.ok(this.options.localMcpServer);
    await this.client.connect(new StdioClientTransport({ ...this.options.localMcpServer, args: [...this.options.localMcpServer.args], stderr: "pipe" }));
    return { threadId, nativeCursor: randomUUID() };
  }
  async call(name: string, callId: string, values: Record<string, unknown>): Promise<Receipt> {
    const searched = await this.client.callTool({ name: "dx_catalog_search", arguments: { query: name, limit: 20 } });
    const tool = (searched.structuredContent as { tools: Array<{ alias: string; title: string }> }).tools.find(t => t.title === name);
    assert.ok(tool, `${name} must be admitted by the host`);
    let result;
    if (name === "dexter.harness.connections.request") accelerateSetupDeadline = true;
    try { result = await this.client.callTool({ name: "dx_catalog_call", arguments: { alias: tool.alias, callId, input: values } }, { timeout: 8_000 }); }
    finally { accelerateSetupDeadline = false; }
    assert.equal(result.isError, false, JSON.stringify(result));
    const receipt = result.structuredContent as unknown as Receipt;
    this.receipts.push(receipt); return receipt;
  }
  async *turn(session: EngineSession, turnId: string, content: string): AsyncIterable<EngineEvent> {
    const identity = { threadId: session.threadId, turnId };
    try {
      if (content.includes("HOST CONNECTION SETUP RESULT")) {
        assert.ok(content.includes(task));
        await this.call(SEND.name, this.freshCallId ? "fresh-model-call" : "original-write", input);
      } else if (content.includes("Host tool continuation.")) {
        assert.ok(content.includes('"state":"denied"'), "only a non-workflow denial receives this generic test continuation");
        assert.ok(content.includes(task));
      } else {
        await this.call(SEND.name, "original-write", input);
        const catalog = (await this.call("dexter.harness.connections.catalog", "catalog", {})).result;
        const status = (await this.call("dexter.harness.status", "status", {})).result;
        const receipt = await this.call("dexter.harness.connections.request", "late-setup", { request_json: JSON.stringify({
          clientRequestId: randomUUID(), expectedBotRevision: status.bot.revision,
          target: { kind: "managed", serviceId: "gmail", catalogPin: catalog.pin },
        }) });
        assert.equal(receipt.status, "pending"); assert.equal(receipt.hostContinuation, true);
      }
      for (const receipt of this.receipts) for (const evidence of gatewayReceiptEvidence(receipt)) yield { type: "tool.result.observed", ...identity, ...evidence };
      yield { type: "text.delta", ...identity, text: "Synthetic confirmed receipt." };
      yield { type: "turn.completed", ...identity, usage: null };
    } catch (error) { this.failure = error; throw error; }
  }
  async respondToTool(_session: EngineSession, _turnId: string, _id: string, _value: JsonValue) {}
  async interrupt() { await this.client.close(); }
  async close() { await this.client.close(); }
}

test("late denied setup keeps the generic denial receipt and never creates a workflow", { timeout: 20_000 }, async t => {
  const f = await fixture(t, "claude"), originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: (...args: any[]) => void, ms?: number, ...args: any[]) =>
    originalSetTimeout(fn, accelerateSetupDeadline && ms === 290_000 && fn.toString().includes("request.responded") ? 1_000 : ms, ...args)) as typeof setTimeout;
  let origin!: ReturnType<HostStore["getTurn"]>;
  try {
    origin = f.services.runtime!.startTurn(f.thread.id, { clientRequestId: randomUUID(), content: task }).turn;
    assert.equal((await f.services.runtime!.waitForTurn(origin.id)).state, "completed", String(f.engines[0]?.failure));
    await until(() => f.services.runtime!.status().pending.sessions === 0);
  } finally { globalThis.setTimeout = originalSetTimeout; }
  const action = f.store.listActions("awaiting_approval").find(a => a.request.tool === "dexter.harness.connections.request")!;
  f.services.runtime!.decideAction(action.id, { decision: "deny", requestHash: action.requestHash });
  assert.equal((await f.services.runtime!.waitForOwnerAction(action.id)).state, "denied");
  const continuation = f.store.toolActionOrigin(action.id)!.continuationTurnId!; assert.ok(continuation);
  assert.equal((await f.services.runtime!.waitForTurn(continuation)).state, "completed", String(f.engines[1]?.failure));
  assert.equal(f.store.connectionWorkflows().length, 0); assert.equal(f.store.listTurns(f.thread.id).length, 2);
  assert.equal(f.svc.composio.count("POST", "/api/v3.1/tools/execute/GMAIL_SEND_EMAIL"), 1);
});

async function fixture(t: TestContext, engine: EngineId, freshCallId = false) {
  const svc = await serviceLab(t), dir = mkdtempSync(join(tmpdir(), "dx-late-setup-"));
  const seed = new HostStore({ dataDir: dir }), identity = { installationId: seed.hostId, ownerId: seed.ownerId }; seed.close();
  const capability = svc.issue(identity), engines: LateSetupEngine[] = [];
  const services = new HostServices({ dataDir: dir, enableEngines: true, enableMcp: true, enableGroups: false, enableWorkspaceTools: false,
    connections: { credentialRef: "synthetic-late-setup", platform: { origin: SERVICE_ORIGIN,
      capability: () => capability, fetch: remapFetch({ [SERVICE_ORIGIN]: svc.url }), limits: { timeoutMs: 2_000 } } },
    makeDriver(id, options) { const driver = new LateSetupEngine(id, options, freshCallId); if (options.localMcpServer) engines.push(driver); return driver; } });
  t.after(async () => { await services.shutdown({ graceMs: 3_000 }); rmSync(dir, { recursive: true, force: true }); });
  const store = services.store, bot = store.createBot({ name: "Synthetic late setup", profileId: "default", engine }), thread = store.createThread(bot.id);
  const catalog = await services.connectionsHttp.catalog();
  const login = { expectedHostID: store.hostId, clientRequestId: randomUUID(), serviceId: "gmail", catalogPin: catalog.pin,
    profileId: bot.profileId, label: "Synthetic existing account", replacesAccountId: null };
  await services.connectionsHttp.startAuthorization(login);
  const ref = [...svc.composio.accounts.keys()][0]!; svc.composio.complete(ref, "Synthetic owner", "owner@example.test");
  await services.connectionsHttp.callback(login.clientRequestId, { expectedHostID: store.hostId, outcome: "returned", providerAccountRef: null });
  const authorization = await services.connectionsHttp.authorization(login.clientRequestId), account = await services.connectionsHttp.account(authorization.accountId!);
  services.connectionsHttp.setAccess(account.id, { expectedHostID: store.hostId, clientRequestId: randomUUID(), expectedRevision: account.revision,
    botId: bot.id, enabled: true, toolNames: [SEND.name] });
  // Synthetic owner policy, not an inferred grant from login or the workflow.
  for (const connectionId of (await services.connectionsHttp.account(account.id)).gatewayConnectionIds)
    store.setGrant({ botId: bot.id, tool: SEND.name, destination: connectionId, policy: "allow" });
  return { svc, dir, services, store, bot, thread, engines };
}

for (const engine of ["claude", "codex", "grok", "muse", "antigravity"] as const) for (const fresh of engine === "claude" ? [false, true] : [false]) {
  test(`${engine}: late exact setup approval owns one continuation, ${fresh ? "fresh" : "same"} model call replays one effect and bridge keeps its timeout margin`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, engine, fresh);
    const originalSetTimeout = globalThis.setTimeout, bridgeTimeouts: number[] = [];
    // Accelerate only the production bridge deadline; all other host/SDK timers stay real.
    // The actual pending-receipt callback executes, so the action survives a finished engine turn.
    globalThis.setTimeout = ((fn: (...args: any[]) => void, ms?: number, ...args: any[]) => {
      if ((ms === 290_000 || ms === 300_000) && fn.toString().includes("request.responded")) {
        bridgeTimeouts.push(ms); return originalSetTimeout(fn, accelerateSetupDeadline ? 1_000 : ms, ...args);
      }
      return originalSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout;
    let origin!: ReturnType<HostStore["getTurn"]>;
    try {
      origin = f.services.runtime!.startTurn(f.thread.id, { clientRequestId: randomUUID(), content: task }).turn;
      assert.equal((await f.services.runtime!.waitForTurn(origin.id)).state, "completed", String(f.engines[0]?.failure));
      await until(() => f.services.runtime!.status().pending.sessions === 0);
    } finally { globalThis.setTimeout = originalSetTimeout; }
    assert.ok(bridgeTimeouts.length > 0, "measured real gateway RPC deadlines");
    assert.ok(bridgeTimeouts.every(ms => ms === 290_000 && ms < LOCAL_MCP_CLIENT_TIMEOUT_MS), "all five host bridges finish 10 s before the declared native client budget");
    const approval = f.store.listActions("awaiting_approval").find(a => a.request.tool === "dexter.harness.connections.request")!;
    assert.ok(approval); assert.equal(f.store.getTurn(origin.id).state, "completed");
    f.services.runtime!.decideAction(approval.id, { decision: "allow", requestHash: approval.requestHash });
    assert.equal((await f.services.runtime!.waitForOwnerAction(approval.id)).state, "succeeded");
    const workflow = f.services.connectionWorkflows.list().requests.find(w => w.actionId === approval.id)!;
    assert.ok(workflow); assert.equal(f.store.toolActionOrigin(approval.id)?.continuationTurnId, null);
    assert.equal(f.store.listTurns(f.thread.id).length, 1, "late approval does not create C1");
    assert.equal(f.engines.length, 1, "no engine is launched before exact setup completion");
    const choices = f.services.connectionWorkflows.choices(workflow.id), choice = choices.choices[0]!;
    const completion = { expectedHostID: f.store.hostId, clientRequestId: randomUUID(), expectedRevision: workflow.revision,
      selections: [{ connectionId: choice.connectionId, expectedRevision: choice.expectedRevision,
        tools: choice.tools.filter(t => t.enabled).map(({ name, manifestHash }) => ({ name, manifestHash })) }] };
    const ready = f.services.connectionWorkflows.complete(workflow.id, completion);
    assert.deepEqual(f.services.connectionWorkflows.complete(workflow.id, completion), ready, "completion replay never schedules another engine turn");
    assert.equal((await f.services.runtime!.waitForTurn(ready.continuationTurnId!)).state, "completed", String(f.engines[1]?.failure));
    await until(() => f.services.runtime!.status().pending.sessions === 0);
    assert.equal(f.store.listTurns(f.thread.id).length, 2, "only O and the sole setup continuation exist");
    assert.equal(f.engines.length, 2);
    const first = f.engines[0]!.receipts.find(r => r.actionId.startsWith("act_") && r.status === "succeeded")!, replay = f.engines[1]!.receipts[0]!;
    assert.equal(replay.actionId, first.actionId); assert.equal(replay.requestHash, first.requestHash); assert.equal(replay.status, "succeeded");
    assert.equal(f.svc.composio.count("POST", "/api/v3.1/tools/execute/GMAIL_SEND_EMAIL"), 1, "effects=1 for same and fresh model call IDs");
  });
}
