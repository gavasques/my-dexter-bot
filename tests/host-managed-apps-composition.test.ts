import { mcpDirectoryClient, MCP_DIRECTORY_NAMES } from "./fixtures/mcp-directory-client.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { test, type TestContext } from "node:test";
import { HostServices, type HostServicesOptions } from "../packages/cli/src/host-services.js";
import { HostStore, HostError, ShutdownIncompleteError } from "@dexter/hub";
import type { EngineDriver, NativeMcpServer } from "@dexter/engines";
import type { EngineId } from "@dexter/contracts";
import type { ToolManifest } from "@dexter/gateway";
import type { ManagedAppsProvider } from "@dexter/connectors";
const SECRET = "synthetic-host-managed-secret-53", VERSION = "20260901_00";
const TOOL: ToolManifest = { name: "slack.read", toolkit: "slack", upstreamSlug: "SLACK_READ_MESSAGES", version: VERSION, description: "Read synthetic", upstreamHost: "backend.composio.dev", effect: "read", destinationArgument: "channel", destinationOrigins: null, inputSchema: { type: "object", additionalProperties: false, required: ["channel"], properties: { channel: { type: "string", maxLength: 32, enum: ["approved"] } } } };
const hold = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const locked = (error: unknown) => error instanceof HostError && error.code === "host_locked";
function driver(id: EngineId, work?: () => Promise<void>): EngineDriver {
  return { id, capabilities: { resume: true, interrupt: true, fork: false, steer: false }, async status() { return { engine: id, installed: true, version: "fixture", authentication: "authenticated", billing: "subscription" }; }, async open(threadId) { return { threadId, nativeCursor: "synthetic" }; }, async *turn(session, turnId) { await work?.(); yield { type: "text.delta", threadId: session.threadId, turnId, text: "synthetic reply" }; yield { type: "turn.completed", threadId: session.threadId, turnId, usage: {} }; }, async respondToTool() {}, async interrupt() {}, async close() {} };
}
function fixture(t: TestContext, extra: Partial<HostServicesOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dx-host-managed-"));
  let providers = 0, reads = 0, disposals = 0, requests = 0;
  let fetchWork: (() => Promise<Response>) | null = null, disposeWork: (() => Promise<void>) | null = null;
  const provider: ManagedAppsProvider = { catalog: async () => { providers++; return [TOOL]; }, provision: async req => { providers++; return { installationId: req.installationId, ownerId: req.ownerId, profileId: req.profileId, toolkit: req.toolkit, userId: req.userId, version: req.version, accountId: "ca_host", status: "active" }; }, lookup: async () => null, account: async receipt => receipt };
  const sent: { url: string; body: unknown }[] = [];
  const config: NonNullable<HostServicesOptions["managedApps"]> = { provider, credentialRef: "cred-host", broker: { acquire(ref, host) { reads++; assert.equal(ref, "cred-host"); assert.equal(host, "backend.composio.dev"); return { headers: { "x-api-key": SECRET } }; }, secretValues() { return [SECRET]; } }, fetch: async (url, init) => { requests++; assert.equal((init.headers as Record<string, string>)["x-api-key"], SECRET); sent.push({ url: String(url), body: JSON.parse(String(init.body)) }); return fetchWork ? fetchWork() : Response.json({ data: { value: SECRET, synthetic: true }, error: null, successful: true }); }, disposeOwnedBroker: async () => { disposals++; await disposeWork?.(); } };
  const services = new HostServices({ dataDir: dir, enableEngines: true, enableMcp: true, managedApps: config, makeDriver: engine => driver(engine), ...extra });
  t.after(async () => { await services.shutdown({ graceMs: 30 }).catch(() => undefined); services.gateway?.close(); services.context?.close(); services.store.close(); rmSync(dir, { recursive: true, force: true }); });
  const bot = services.store.createBot({ name: "Fixture", profileId: "work", engine: "claude" });
  const ready = async () => { const admin = services.managedAppsAdmin; const revision = await admin.syncCatalog(0); admin.approveTools(revision, [TOOL.name]); return admin.provision("op1", { profileId: "work", toolkit: "slack", version: VERSION, label: "Work" }); };
  const cap = () => { const thread = services.store.createThread(bot.id); const turn = services.store.createTurn(thread.id, { clientRequestId: "gateway-fixture", content: "synthetic" }).turn; services.store.claimNextTurn(thread.id); return services.gateway!.issueCapability({ turnId: turn.id }); };
  return { dir, config, services, bot, sent, ready, cap, counts: () => ({ providers, reads, disposals, requests }), onFetch(fn: () => Promise<Response>) { fetchWork = fn; }, onDispose(fn: () => Promise<void>) { disposeWork = fn; } };
}
function mcp(server: NativeMcpServer) {
  const child = spawn(server.command, [...server.args], { stdio: "pipe" }); child.stderr.resume();
  let buffer = "", id = 0; const waiters = new Map<number, (reply: any) => void>();
  child.stdout.on("data", chunk => { buffer += chunk.toString(); while (buffer.includes("\n")) { const end = buffer.indexOf("\n"), row = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); waiters.get(row.id)?.(row); waiters.delete(row.id); } });
  const exit = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
  const rpc = (method: string, params: unknown = {}) => { const next = ++id; const promise = new Promise<any>(resolve => waiters.set(next, resolve)); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: next, method, params }) + "\n"); return promise; };
  return { rpc, async init() { await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic", version: "1" } }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); }, async close() { child.stdin.end(); await exit; } };
}
test("invalid managed config and incompatible modes create no files or external effects", () => {
  const dir = mkdtempSync(join(tmpdir(), "dx-managed-invalid-")), absent = join(dir, "absent"); let effects = 0;
  const callback = () => { effects++; throw Error(SECRET); };
  const config = { provider: { catalog: callback, provision: callback, lookup: callback, account: callback }, broker: { acquire: callback, secretValues: callback }, credentialRef: "cred-host", fetch: callback, disposeOwnedBroker: callback };
  try {
    for (const change of [{ origin: "http://backend.composio.dev" }, { identity: { installationId: "forged", ownerId: "forged" } }, { limits: { timeoutMs: 0 } }, { authHeaders: ["authorization"] }, { provider: {} }]) {
      assert.throws(() => new HostServices({ dataDir: absent, enableEngines: true, enableMcp: true, managedApps: { ...config, ...change } as NonNullable<HostServicesOptions["managedApps"]> }), HostError);
      assert.equal(existsSync(absent), false);
    }
    for (const flags of [{ enableEngines: true }, { enableEngines: true, enableMcp: true, upstream: { broker: config.broker, adapter: { execute: callback } } }]) {
      assert.throws(() => new HostServices({ dataDir: absent, ...flags, managedApps: config }), HostError); assert.equal(existsSync(absent), false);
    }
    assert.equal(effects, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("managed config getters are read once and original method receivers remain bound", async t => {
  const s = fixture(t); await s.services.shutdown();
  const dir = join(s.dir, "snapshot"); let origins = 0, methods = 0;
  const provider = { ...s.config.provider, marker: true };
  Object.defineProperty(provider, "catalog", { enumerable: true, get() { methods++; return async function(this: typeof provider) { assert.equal(this.marker, true); return [TOOL]; }; } });
  const config = { ...s.config, provider };
  Object.defineProperty(config, "origin", { enumerable: true, get() { return ++origins === 1 ? "https://backend.composio.dev" : "https://evil.example"; } });
  const services = new HostServices({ dataDir: dir, enableMcp: true, enableEngines: true, managedApps: config, makeDriver: engine => driver(engine) });
  await services.managedAppsAdmin.syncCatalog(0); assert.equal(origins, 1); assert.equal(methods, 1); await services.shutdown();
});
test("trusted admin -> default deny -> pinned gateway result/replay/revoke never persists secret", async t => {
  const s = fixture(t), op = await s.ready(), { token } = s.cap(), gateway = s.services.gateway!;
  assert.equal(s.services.upstreamConfigured, true); assert.ok(Object.isFrozen(s.services.managedAppsAdmin));
  assert.deepEqual(gateway.listTools(token), []);
  const request = { tool: TOOL.name, connectionId: op.connectionId, callId: "call1", arguments: { channel: "approved" } };
  await assert.rejects(gateway.call(token, request));
  s.services.managedAppsAdmin.grant({ operationId: "op1", botId: s.bot.id, tool: TOOL.name, policy: "allow" });
  const result = await gateway.call(token, request); assert.equal(result.status, "succeeded"); assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.equal((await gateway.call(token, request)).actionId, result.actionId); assert.equal(s.counts().requests, 1);
  assert.equal(s.sent[0]!.url, "https://backend.composio.dev/api/v3.1/tools/execute/SLACK_READ_MESSAGES");
  assert.deepEqual(s.sent[0]!.body, { arguments: { channel: "approved" }, version: VERSION, user_id: `dx:${s.services.store.hostId}:${s.services.store.ownerId}:work`, connected_account_id: "ca_host" });
  for (const path of readdirSync(s.dir).filter(name => name.includes(".sqlite")))
    assert.ok(!readFileSync(join(s.dir, path)).includes(SECRET), path);
  assert.ok(!inspect(s.services, { showHidden: true, depth: 8 }).includes(SECRET));
  s.services.managedAppsAdmin.revoke("op1"); await assert.rejects(gateway.call(token, { ...request, callId: "new" }));
});
test("actual wrapper MCP exposes granted alias and scrubbed result without admin or credentials", { timeout: 10000 }, async t => {
  let opens = 0; let services: HostServices; let grantedAlias: string;
  const s = fixture(t, { makeDriver(engine, options) { assert.ok(!JSON.stringify(options).includes(SECRET)); return driver(engine, async () => {
    opens++; assert.ok(options.localMcpServer); const client = mcp(options.localMcpServer);
    try { await client.init(); const tools = (await client.rpc("tools/list")).result.tools as { name: string }[];
      // First-party harness tools share the bridge. The managed app remains one exact, opaque granted alias.
      const directory=mcpDirectoryClient(client.rpc);const resolved=await directory.find(TOOL.name,grantedAlias);assert.equal(resolved.name,grantedAlias);
      assert.deepEqual(tools.filter(tool=>MCP_DIRECTORY_NAMES.includes(tool.name)).map(tool=>tool.name),MCP_DIRECTORY_NAMES);
      assert.ok(tools.every(tool => /^dx_[a-f0-9]{24}$/.test(tool.name)||MCP_DIRECTORY_NAMES.includes(tool.name)), "only capability-scoped aliases, never admin or credential names");
      const params = { channel: "approved" };
      const result = (await directory.call(resolved,"mcp-once",params)).result; assert.equal(result.structuredContent.status, "succeeded"); assert.ok(!JSON.stringify(result).includes(SECRET));
      assert.equal((await directory.call(resolved,"mcp-once",params)).result.structuredContent.actionId, result.structuredContent.actionId);
    } finally { await client.close(); }
  }); } }); services = s.services;
  const operation = await s.ready();
  grantedAlias = `dx_${createHash("sha256").update(`${TOOL.name}\u0000${operation.connectionId}`).digest("hex").slice(0, 24)}`;
  services.managedAppsAdmin.grant({ operationId: "op1", botId: s.bot.id, tool: TOOL.name, policy: "allow" });
  const thread = services.store.createThread(s.bot.id), { turn } = services.runtime!.startTurn(thread.id, { clientRequestId: "mcp1", content: "synthetic" });
  await services.runtime!.waitForTurn(turn.id); assert.equal(services.store.getTurn(turn.id).state, "completed");
  assert.equal(services.runtime!.startTurn(thread.id, { clientRequestId: "mcp1", content: "synthetic" }).created, false);
  assert.equal(opens, 1); assert.equal(s.counts().requests, 1);
  assert.ok(!JSON.stringify(services.store.listMessages(thread.id)).includes(SECRET));
});
test("held fetch and then owned disposal retain writer; shutdown retries reuse cleanup", async t => {
  const s = fixture(t), op = await s.ready(), { token } = s.cap(), waiting = hold<Response>(), disposed = hold<void>();
  s.onFetch(() => waiting.promise); s.onDispose(() => disposed.promise);
  s.services.managedAppsAdmin.grant({ operationId: "op1", botId: s.bot.id, tool: TOOL.name, policy: "allow" });
  const call = s.services.gateway!.call(token, { tool: TOOL.name, connectionId: op.connectionId, callId: "held", arguments: { channel: "approved" } });
  while (!s.counts().requests) await new Promise<void>(resolve => setImmediate(resolve));
  const retained = s.services.managedAppsAdmin;
  await assert.rejects(s.services.shutdown({ graceMs: 5 }), ShutdownIncompleteError);
  assert.throws(() => retained.catalog(), HostError); assert.throws(() => new HostStore({ dataDir: s.dir }), locked); assert.equal(s.counts().disposals, 0);
  waiting.resolve(Response.json({ data: {}, error: null, successful: true })); await call;
  await assert.rejects(s.services.shutdown({ graceMs: 5 }), ShutdownIncompleteError);
  assert.equal(s.counts().disposals, 1); assert.throws(() => new HostStore({ dataDir: s.dir }), locked);
  disposed.resolve(); await s.services.shutdown(); assert.equal(s.counts().disposals, 1);
  const reopened = new HostStore({ dataDir: s.dir }); reopened.close();
});
test("owned disposal rejection permanently quarantines writer and never repeats callback", async t => {
  const s = fixture(t); s.onDispose(async () => { throw Error(SECRET); });
  await assert.rejects(s.services.shutdown(), ShutdownIncompleteError); await assert.rejects(s.services.shutdown(), ShutdownIncompleteError);
  assert.equal(s.counts().disposals, 1); assert.throws(() => new HostStore({ dataDir: s.dir }), locked);
});
test("mixed context+managed routes local grants separately and context registration grants nothing", async t => {
  const s = fixture(t, { context: { ownerExclusiveDeployment: true, memory: { origin: "http://127.0.0.1:1", labLoopbackWithoutAuth: true, fetch: async () => Response.json([]) } } });
  const context = s.services.prepareContextProfile("work"), op = await s.ready(), { token } = s.cap();
  assert.deepEqual(s.services.gateway!.listTools(token), []);
  s.services.managedAppsAdmin.grant({ operationId: "op1", botId: s.bot.id, tool: TOOL.name, policy: "allow" });
  s.services.store.setGrant({ botId: s.bot.id, tool: "context.recall", destination: context.id, policy: "allow" });
  const local = await s.services.gateway!.call(token, { tool: "context.recall", connectionId: context.id, callId: "recall", arguments: { query: "synthetic", locale: "pt-BR" } });
  assert.equal(local.status, "succeeded"); assert.equal(s.counts().reads, 0);
  const remote = await s.services.gateway!.call(token, { tool: TOOL.name, connectionId: op.connectionId, callId: "managed", arguments: { channel: "approved" } });
  assert.equal(remote.status, "succeeded"); assert.equal(s.counts().requests, 1); assert.ok(!JSON.stringify(remote).includes(SECRET));
});
test("constructor bind failure has no async disposal and releases only synchronous initialized resources", async t => {
  const s = fixture(t); await s.ready(); await s.services.shutdown();
  assert.equal(s.counts().disposals, 1);
  assert.throws(() => new HostServices({ dataDir: s.dir, enableMcp: true, enableEngines: true, managedApps: { ...s.config, credentialRef: "different-ref" } }));
  await Promise.resolve(); assert.equal(s.counts().disposals, 1); assert.equal(s.counts().requests, 0);
  const reopened = new HostStore({ dataDir: s.dir }); reopened.close();
});
test("held provider keeps writer and broker owned until its admitted work settles", async t => {
  const s = fixture(t); await s.services.shutdown();
  const waiting = hold<readonly ToolManifest[]>(), entered = hold<void>(); let disposals = 0;
  const services = new HostServices({ dataDir: join(s.dir, "held-provider"), enableMcp: true, enableEngines: true, makeDriver: engine => driver(engine),
    managedApps: { ...s.config, provider: { ...s.config.provider, catalog: async () => { entered.resolve(); return waiting.promise; } }, disposeOwnedBroker: () => { disposals++; } } });
  const admin = services.managedAppsAdmin, request = admin.syncCatalog(0); await entered.promise;
  // Attach before abort so the expected closed/conflict outcome cannot become unhandled.
  const outcome = request.catch(() => undefined);
  await assert.rejects(services.shutdown({ graceMs: 5 }), ShutdownIncompleteError);
  assert.equal(disposals, 0); assert.throws(() => new HostStore({ dataDir: join(s.dir, "held-provider") }), locked);
  assert.throws(() => admin.catalog(), HostError);
  waiting.resolve([TOOL]); await outcome; await services.shutdown(); assert.equal(disposals, 1);
  const reopened = new HostStore({ dataDir: join(s.dir, "held-provider") }); reopened.close();
});
test("caller-owned broker is never disposed and an unconfigured host exposes no admin", async t => {
  const s = fixture(t); await s.services.shutdown();
  const config = { ...s.config }; delete config.disposeOwnedBroker;
  const services = new HostServices({ dataDir: join(s.dir, "caller-owned"), enableMcp: true, enableEngines: true, managedApps: config, makeDriver: engine => driver(engine) });
  await services.shutdown(); assert.equal(s.counts().disposals, 1, "only the explicitly owned original broker was disposed");
  const empty = new HostServices({ dataDir: join(s.dir, "empty") });
  assert.throws(() => empty.managedAppsAdmin, HostError); assert.equal(empty.upstreamConfigured, false); await empty.shutdown();
});
test("shutdown permanently stops admin admission even when runtime drain times out before auxiliary close", { timeout: 10000 }, async t => {
  const entered = hold<void>(), work = hold<void>();
  let services: HostServices | undefined;
  // Release real fixture work before the shared fixture teardown even if an assertion fails.
  t.after(async () => { work.resolve(); await services?.shutdown(); });
  const s = fixture(t, {
    context: { ownerExclusiveDeployment: true, memory: { origin: "http://127.0.0.1:1", labLoopbackWithoutAuth: true, fetch: async () => Response.json([]) } },
    makeDriver: engine => driver(engine, async () => { entered.resolve(); await work.promise; }),
  });
  services = s.services;
  await s.ready();
  const admin = services.managedAppsAdmin, counts = s.counts();
  const thread = services.store.createThread(s.bot.id);
  services.runtime!.startTurn(thread.id, { clientRequestId: "uncooperative-turn", content: "synthetic" });
  await entered.promise;
  const first = services.shutdown({ graceMs: 10 });
  // Admission stops synchronously, before shutdown reaches any await or auxiliary cleanup.
  assert.throws(() => services!.managedAppsAdmin, HostError);
  assert.throws(() => admin.catalog(), HostError);
  await assert.rejects(first, ShutdownIncompleteError);
  assert.throws(() => services!.managedAppsAdmin, HostError);
  assert.throws(() => admin.catalog(), HostError);
  assert.throws(() => admin.syncCatalog(1), HostError);
  assert.throws(() => admin.provision("late", { profileId: "work", toolkit: "slack", version: VERSION, label: "Work" }), HostError);
  assert.throws(() => admin.grant({ operationId: "op1", botId: s.bot.id, tool: TOOL.name, policy: "allow" }), HostError);
  assert.throws(() => services!.prepareContextProfile("late-profile"), HostError);
  assert.deepEqual(s.counts(), counts, "refused administration starts no provider/fetch/credential/disposal work");
  assert.throws(() => new HostStore({ dataDir: s.dir }), locked);
  await assert.rejects(services.shutdown({ graceMs: 10 }), ShutdownIncompleteError);
  assert.throws(() => admin.catalog(), HostError);
  assert.deepEqual(s.counts(), counts);
  work.resolve();
  await services.shutdown();
  assert.equal(s.counts().disposals, 1);
  assert.throws(() => admin.catalog(), HostError);
  const reopened = new HostStore({ dataDir: s.dir }); reopened.close();
});
