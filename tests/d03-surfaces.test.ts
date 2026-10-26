import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { APPROVAL_POLICY_SCOPE_VERSION } from "@dexter/contracts";
import { BrowserUseClient, BrowserUseKeyVault } from "@dexter/connectors";
import { CapabilityGateway, SyntheticCredentialBroker } from "@dexter/gateway";
import { HostStore } from "@dexter/hub";
import { createHostApp } from "@dexter/hub/http";
import type { BotExecutionOperation } from "@dexter/contracts";
import { operationFor } from "@dexter/devices";

const cli = (name: string): string => pathToFileURL(resolve(`packages/cli/dist/${name}.js`)).href;
const { HarnessOperationSurface, HARNESS_OPERATION_DESTINATION } = await import(cli("harness-operation-surface")) as typeof import("../packages/cli/dist/harness-operation-surface.js");
const { BotWorkspaceTools } = await import(cli("bot-workspace-tools")) as typeof import("../packages/cli/dist/bot-workspace-tools.js");
const { BrowserUseTurnSurface, BROWSER_USE_DESTINATION } = await import(cli("browser-use-surface")) as typeof import("../packages/cli/dist/browser-use-surface.js");
const { AutomationTurnSurface, AUTOMATION_DESTINATION } = await import(cli("automation-surface")) as typeof import("../packages/cli/dist/automation-surface.js");
const { DeviceTurnSurface } = await import(cli("device-turn-surface")) as typeof import("../packages/cli/dist/device-turn-surface.js");
const { HostServices } = await import(cli("host-services")) as typeof import("../packages/cli/dist/host-services.js");

// Private synthetic host data, workspace effects, provider responses and owned fixture processes only.
const directory = (): string => { const value = realpathSync(mkdtempSync(join(tmpdir(), "dexter-d03-surfaces-"))); chmodSync(value, 0o700); return value; };
const auto = (store: HostStore, botId: string): void => { store.setBotApprovalPolicy(botId, { expectedHostId: store.hostId,
  clientRequestId: randomUUID(), expectedRevision: store.getBotApprovalPolicy(botId).revision, mode: "approve_all", eligibleScopeVersion: APPROVAL_POLICY_SCOPE_VERSION }); };
const running = (store: HostStore, botId: string) => { const thread = store.createThread(botId), { turn } = store.createTurn(thread.id,
  { clientRequestId: randomUUID(), content: "Synthetic D03 surface check" }); assert.equal(store.claimNextTurn(thread.id)?.id, turn.id); return { thread, turn }; };
const base = (store: HostStore): CapabilityGateway => new CapabilityGateway({ store, broker: new SyntheticCredentialBroker(), adapter: { execute: async () => null } });

async function enableExecution(store:HostStore,botId:string,operation:BotExecutionOperation):Promise<void> {
  const app=createHostApp(store),access=store.getBotExecutionAccess(botId);
  const response=await app.request(`/v1/bots/${botId}/execution-access`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({expectedHostId:access.hostId,clientRequestId:randomUUID(),expectedBotRevision:access.botRevision,expectedInventoryHash:access.inventoryHash,scopeVersion:"d03.access.v1",operation,enabled:true})});
  assert.equal(response.status,200);
}

function harness(t: TestContext) {
  const dir = directory(), store = new HostStore({ dataDir: dir }), gateway = base(store), workspace = new BotWorkspaceTools({ dataDir: dir });
  const bot = store.createBot({ name: "Synthetic actor", profileId: "synthetic", engine: "codex" }), live = running(store, bot.id);
  const surface = new HarnessOperationSurface({ store, base: gateway, catalog: async () => [], runtime: () => { throw new Error("unused synthetic runtime"); },
    skills: () => { throw new Error("unused synthetic skills"); }, effectiveSkills: () => [], workspace: () => workspace });
  const token = surface.issueCapability({ turnId: live.turn.id }).token;
  const call = (tool: string, callId: string, args: unknown = {}) => surface.call(token, { connectionId: HARNESS_OPERATION_DESTINATION, tool: "dexter.harness." + tool, callId, arguments: args });
  t.after(async () => { await surface.close(); await workspace.close(); gateway.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, bot, live, surface, token, call };
}

test("D03 surfaces: ask has no effect; enabled writes execute once under owner policy; proposals cannot self-enable", async t => {
  const f = harness(t), tool = "dexter.harness.files.write", file = join(f.dir, "bot-files", f.bot.id, "synthetic.txt");
  await enableExecution(f.store,f.bot.id,"files_write");
  const old = await f.call("files.write", "old-pending", { path: "synthetic.txt", text: "old unapproved text" });
  assert.equal(old.status, "awaiting_approval"); assert.equal(existsSync(file), false);
  auto(f.store, f.bot.id);
  assert.equal((await f.call("files.write", "old-pending", { path: "synthetic.txt", text: "old unapproved text" })).status, "awaiting_approval");
  assert.equal(f.surface.listTools(f.token).find(view => view.name === tool)?.requiresApproval, false);
  const done = await f.call("files.write", "new-write", { path: "synthetic.txt", text: "synthetic effect" });
  assert.equal(done.status, "succeeded"); assert.equal(readFileSync(file, "utf8"), "synthetic effect");
  const action = f.store.getAction(done.actionId);
  assert.equal(action.authorization?.source, "owner_policy"); assert.equal(action.decidedBy, f.store.ownerId);
  assert.equal(action.authorization?.policyReceiptId, f.store.getBotApprovalPolicy(f.bot.id).receiptId);
  assert.equal((await f.call("files.write", "new-write", { path: "synthetic.txt", text: "synthetic effect" })).actionId, done.actionId);
  assert.equal(f.store.listActions().filter(value => value.request.tool === tool).length, 2);
  const fresh = await f.call("terminal.run", "unenabled-first", { runtime: "sh", command: "printf synthetic" });
  const second = await f.call("terminal.run", "unenabled-second", { runtime: "sh", command: "printf synthetic" });
  assert.equal(fresh.status, "awaiting_approval"); assert.equal(second.status, "awaiting_approval");
  assert.equal(f.store.getAction(fresh.actionId).approvalRequirement?.reason,"access_not_enabled");
  assert.equal(f.store.getAction(second.actionId).approvalRequirement?.reason,"access_not_enabled");
  assert.equal(f.surface.listTools(f.token).find(view => view.name === "dexter.harness.terminal.run")?.requiresApproval, true);
  assert.equal(f.store.getGrant(f.bot.id, "dexter.harness.terminal.run", HARNESS_OPERATION_DESTINATION)?.policy, "ask");
  const authority = await f.call("bots.update", "human-only", { expectedRevision: f.bot.revision, name: "Human choice needed" });
  assert.equal(authority.status, "awaiting_approval"); assert.equal(f.store.getBot(f.bot.id).name, f.bot.name);
  await enableExecution(f.store,f.bot.id,"cli");
  const cliEffect=await f.call("cli.run","python-literal-once",{tool:"python3",args:["-c","from pathlib import Path; Path('cli-effect.txt').write_text('synthetic')"],timeout_ms:3000});
  assert.equal(cliEffect.status,"succeeded");assert.equal(f.store.getAction(cliEffect.actionId).authorization?.source,"owner_policy");
  assert.equal(readFileSync(join(f.dir,"bot-files",f.bot.id,"cli-effect.txt"),"utf8"),"synthetic");
  const status = await f.call("status", "policy-read");
  assert.equal((status.result as { approvalPolicy: { mode: string } }).approvalPolicy.mode, "approve_all");
  await assert.rejects(f.call("terminal.run", "model-classification", { runtime: "sh", command: "printf synthetic", forceAsk: false }), error => (error as { code: string }).code === "invalid_input");
});

test("D03 surfaces: already enabled Browser Use executes immediately and restart receipt replay sends no second task; configure stays human", async t => {
  const dir = directory(); let posts = 0, store = new HostStore({ dataDir: dir }), gateway = base(store), vault = new BrowserUseKeyVault();
  const task = "11111111-1111-4111-8111-111111111111", session = "22222222-2222-4222-8222-222222222222";
  const client = new BrowserUseClient({ pollIntervalMs: 1, httpTimeoutMs: 1000, fetch: async (url, init) => {
    const result = init.method === "POST" ? (posts++, { id: task, sessionId: session }) : url.endsWith("/status") ? { id: task, status: "finished", output: "Synthetic browser result", isSuccess: true } : { id: session, status: "stopped" };
    return new Response(JSON.stringify(result), { status: init.method === "POST" ? 202 : 200, headers: { "content-type": "application/json" } });
  } });
  vault.set("synthetic-d03-browser-fixture-value");
  let surface = new BrowserUseTurnSurface({ store, base: gateway, vault, client });
  const bot = store.createBot({ name: "Synthetic browser", profileId: "synthetic", engine: "codex" }), live = running(store, bot.id);
  store.patchBrowserUseSettings({ expectedHostID: store.hostId, expectedRevision: 0, enabled: true,
    bots: { [bot.id]: { enabled: true, allowedDomains: ["example.com"], maxSteps: 3, timeoutSeconds: 30, profileId: null } } });
  auto(store, bot.id); let token = surface.issueCapability({ turnId: live.turn.id }).token;
  const input = { connectionId: BROWSER_USE_DESTINATION, tool: "dexter.browseruse.run", callId: "browser-once", arguments: { task: "Read synthetic fixture", start_url: "https://example.com/" } };
  t.after(async () => { await surface.close(); await vault.lock(); gateway.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(surface.listTools(token).find(view => view.name === input.tool)?.requiresApproval, false);
  const done = await surface.call(token, input); assert.equal(done.status, "succeeded"); assert.equal(posts, 1);
  assert.equal(store.getAction(done.actionId).authorization?.source, "owner_policy");
  await surface.close(); await vault.lock(); gateway.close(); store.close();
  store = new HostStore({ dataDir: dir }); gateway = base(store); vault = new BrowserUseKeyVault(); vault.set("synthetic-d03-browser-fixture-value");
  surface = new BrowserUseTurnSurface({ store, base: gateway, vault, client });
  assert.throws(() => surface.issueCapability({ turnId: live.turn.id }), error => (error as { code: string }).code === "unauthorized");
  assert.equal((await surface.continueOwnerAction(store.getAction(done.actionId))).id, done.actionId); assert.equal(posts, 1);
  const fresh = running(store, bot.id); token = surface.issueCapability({ turnId: fresh.turn.id }).token;
  const revision = store.getBrowserUseConfiguration().revision;
  const configure = await surface.call(token, { connectionId: BROWSER_USE_DESTINATION, tool: "dexter.browseruse.configure", callId: "browser-config-human",
    arguments: { expectedRevision: revision, enabled: true, allowed_domains: ["example.com"], max_steps: 3, timeout_seconds: 30, profile_id: "" } });
  assert.equal(configure.status, "awaiting_approval"); assert.equal(store.getBrowserUseConfiguration().revision, revision); assert.equal(posts, 1);
});

test("D03 surfaces: existing own automation run commits one receipt immediately; schedule authority stays human", async t => {
  const dir = directory(), services = new HostServices({ dataDir: dir, enableEngines: true, enableMcp: true, enableAgenda: true,
    makeDriver: id => ({ id, capabilities: { resume: true, interrupt: true, fork: false, steer: false },
      status: async () => ({ engine: id, installed: true, version: null, authentication: "unknown", billing: "subscription" }),
      open: async threadId => ({ threadId, nativeCursor: "synthetic-only" }), async *turn() { throw new Error("synthetic fixture must not admit inference"); },
      respondToTool: async () => {}, interrupt: async () => {}, close: async () => {} }) });
  const store = services.store, bot = store.createBot({ name: "Synthetic scheduler", profileId: "synthetic", engine: "codex" }), live = running(store, bot.id), port = services.automationsHttp!;
  const schedule = (port.create({ hostId: store.hostId, clientRequestId: randomUUID(), expectedRevision: 0, botId: bot.id, threadId: live.thread.id,
    title: "Synthetic existing task", content: "Synthetic task", when: { kind: "interval", everyMs: 60_000, firstAt: store.now() + 3_600_000 } }) as { schedule: { id: string; revision: number } }).schedule;
  auto(store, bot.id);
  const surface = new AutomationTurnSurface({ store, base: services.gateway!, port: () => port }), token = surface.issueCapability({ turnId: live.turn.id }).token;
  t.after(async () => { await surface.close(); if (store.getTurn(live.turn.id).state === "running") store.finishTurn(live.turn.id, "interrupted", "cancelled"); await services.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const provisional=await surface.call(token,{connectionId:AUTOMATION_DESTINATION,tool:"dexter.automations.run",callId:"unenabled-run",arguments:{schedule_id:schedule.id,expectedRevision:schedule.revision}});
  assert.equal(provisional.status,"awaiting_approval");assert.equal(store.getAction(provisional.actionId).approvalRequirement?.reason,"access_not_enabled");
  await enableExecution(store,bot.id,"automation");
  const input = { connectionId: AUTOMATION_DESTINATION, tool: "dexter.automations.run", callId: "existing-run", arguments: { schedule_id: schedule.id, expectedRevision: schedule.revision } };
  const done = await surface.call(token, input); assert.equal(done.status, "succeeded");
  assert.equal((done.result as { executionConfirmed: boolean }).executionConfirmed, false);
  assert.equal((await surface.call(token, input)).actionId, done.actionId);
  const history = port.history({ hostId: store.hostId, botId: bot.id, scheduleId: schedule.id, limit: 100 }) as { items: unknown[] };
  assert.equal(history.items.length, 1); assert.equal(store.getAction(done.actionId).authorization?.source, "owner_policy");
  const modify = await surface.call(token, { connectionId: AUTOMATION_DESTINATION, tool: "dexter.automations.state", callId: "pause-human",
    arguments: { schedule_id: schedule.id, expectedRevision: schedule.revision, state: "disabled" } });
  assert.equal(modify.status, "awaiting_approval"); assert.equal((port.get(schedule.id) as { state: string }).state, "active");
});

test("D03 surfaces: native names alone stay human; reviewed per-bot selection may execute once without broadening grants", async t => {
  const dir = directory(), services = new HostServices({ dataDir: dir, enableEngines: true, enableMcp: true, nativeMcp: { runsOn: "owner_mac" } });
  t.after(async () => { await services.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const store = services.store, bot = store.createBot({ name: "Synthetic MCP", profileId: "synthetic", engine: "codex" });
  const admin = services.nativeMcpAdmin!, gateway = services.gateway!;
  admin.addServer({ definition: { id: "fake", name: "Synthetic fake", runsOn: "owner_mac", auth: "none",
    transport: { type: "stdio", command: process.execPath, args: [fileURLToPath(new URL("./fixtures/mcp-fake-stdio-server.js", import.meta.url))] }, readOnlyTools: [], limits: { callTimeoutMs: 3000, connectTimeoutMs: 10000 } } });
  await admin.discover("fake", { unlockCredentials: false });
  admin.setBotSelection("fake", bot.id, { toolIds: ["mcp.fake.echo_text"], policy: "ask" });
  auto(store, bot.id); const live = running(store, bot.id), token = gateway.issueCapability({ turnId: live.turn.id }).token;
  const view = gateway.listTools(token).find(tool => tool.name === "mcp.fake.echo_text")!; assert.equal(view.requiresApproval, false);
  const input = { connectionId: view.connectionId, tool: view.name, callId: "selected-once", arguments: { text: "synthetic" } };
  const done = await gateway.call(token, input); assert.equal(done.status, "succeeded"); assert.equal((await gateway.call(token, input)).actionId, done.actionId);
  const calls = readFileSync(join(dir, "mcp-stdio", "fake", "calls.log"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { call?: string });
  assert.equal(calls.filter(call => call.call).length, 1); assert.equal(store.getGrant(bot.id, view.name, view.connectionId)?.policy, "ask");
  const other = store.createBot({ name: "Other bot", profileId: "synthetic", engine: "codex" }), otherLive = running(store, other.id), otherToken = gateway.issueCapability({ turnId: otherLive.turn.id }).token;
  store.setGrant({ botId: other.id, tool: view.name, destination: view.connectionId, policy: "ask" }); auto(store, other.id);
  assert.equal(gateway.listTools(otherToken).find(tool => tool.name === view.name)?.requiresApproval, true, "same native name and manual grant cannot fabricate selection");
  const pending = await gateway.call(otherToken, { ...input, callId: "unselected" }); assert.equal(pending.status, "awaiting_approval");
});


test("D03 surfaces: canonical granted device action executes once; CUA consent status remains human", async t => {
  const dir = directory(), store = new HostStore({ dataDir: dir }); let effects = 0;
  const bot = store.createBot({ name: "Synthetic device bot", profileId: "synthetic", engine: "codex" });
  const device = store.registerDevice({ name: "Owned synthetic device", platform: "macos", capabilities: ["mac.file.append", "mac.cua.status"] });
  const pin = { installationId: store.hostId, ownerId: store.ownerId, deviceId: device.id, fingerprint: "a".repeat(64), generation: 1, revision: 1, status: "active" as const };
  const file = join(dir, "owned-synthetic-effect.txt");
  const surface = new DeviceTurnSurface(store, { installationId: store.hostId, ownerId: store.ownerId, snapshot: () => pin,
    authenticatedPresence: () => "online", operation: operationFor, dispatchBound: async (id, context) => {
      const action = store.claimAction(id); assert.ok(context.guard(action, pin)); assert.equal(context.signal.aborted, false);
      assert.equal(action.request.tool, "mac.file.append", "a consent prompt must never reach this synthetic executor");
      appendFileSync(file, String(action.request.arguments.line) + "\n"); effects++; return store.completeAction(id, { appended: true });
    } });
  t.after(async () => { await surface.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const live = running(store, bot.id), token = surface.issueCapability({ turnId: live.turn.id }).token;
  const route = surface.admin.bindRoute({ botId: bot.id, deviceId: device.id, tool: "mac.file.append" });
  const consentRoute = surface.admin.bindRoute({ botId: bot.id, deviceId: device.id, tool: "mac.cua.status" });
  for (const tool of ["mac.file.append", "mac.cua.status"]) store.setGrant({ botId: bot.id, tool, destination: device.id, policy: "ask" });
  auto(store, bot.id);
  assert.equal(surface.listTools(token).find(view => view.name === "mac.file.append")?.requiresApproval, false);
  assert.equal(surface.listTools(token).find(view => view.name === "mac.cua.status")?.requiresApproval, true);
  const input = { connectionId: route.id, tool: "mac.file.append", callId: "device-once", arguments: { name: "fixture.txt", line: "synthetic effect" } };
  const done = await surface.call(token, input); assert.equal(done.status, "succeeded"); assert.equal(effects, 1);
  assert.equal((await surface.call(token, input)).actionId, done.actionId); assert.equal(readFileSync(file, "utf8"), "synthetic effect\n");
  assert.equal(store.getAction(done.actionId).authorization?.source, "owner_policy");
  const consent = await surface.call(token, { connectionId: consentRoute.id, tool: "mac.cua.status", callId: "consent-human", arguments: {} });
  assert.equal(consent.status, "awaiting_approval"); assert.equal(effects, 1);
});
