import { MCP_DIRECTORY_NAMES } from "./fixtures/mcp-directory-client.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { inspect } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { ContextHost, ContextGatewayAdapter, ContextLocalCredentialBroker, contextGatewayManifests, registerContextGatewayTools,
  CONTEXT_GATEWAY_HOST, CONTEXT_GATEWAY_CREDENTIAL_REF, FixtureMemoryAdapter, type MemoryAdapter, type ServiceHit } from "@dexter/context";
import { CapabilityGateway, GatewayMcpBridge, prepareMcpTurn, SyntheticCredentialBroker, type AdapterCall } from "@dexter/gateway";
import { HostStore } from "@dexter/hub";
const gate = () => { let release = () => {}; const promise = new Promise<void>(resolveDone => { release = resolveDone; }); return { promise, release: () => release() }; };
const until = async (check: () => boolean) => { const end = Date.now() + 5_000; while (!check()) { if (Date.now() > end) throw new Error("fixture deadline"); await new Promise(done => setTimeout(done, 2)); } };
function setup(t: TestContext, memory?: MemoryAdapter) {
  const dir = mkdtempSync(join(tmpdir(), "dexter-context-gateway-")); const store = new HostStore({ dataDir: dir });
  const cases: { query: string; locale: string; hits: ServiceHit[] }[] = []; const context = new ContextHost(store, memory ?? new FixtureMemoryAdapter(cases));
  const adapter = new ContextGatewayAdapter({ context, store }); const broker = new ContextLocalCredentialBroker(); const calls: AdapterCall[] = [];
  let rewrite = (call: AdapterCall) => call;
  const gateway = new CapabilityGateway({ store, broker, adapter: { execute(call, auth, execution) { calls.push(call); return adapter.execute(rewrite(call), auth, execution); } } });
  const principal = (name: string) => { const bot = store.createBot({ name, profileId: "work", engine: "claude" }); const thread = store.createThread(bot.id); const turn = store.createTurn(thread.id, { clientRequestId: name, content: "synthetic" }).turn; store.claimNextTurn(thread.id); const capability = gateway.issueCapability({ turnId: turn.id }); return { bot, thread, turn, token: capability.token }; };
  const a = principal("Alpha"); const b = principal("Beta"); const connection = registerContextGatewayTools(gateway, store, "work", adapter);
  const ownTokens: string[] = []; const issue = context.issue.bind(context); context.issue = turnId => { const token = issue(turnId); ownTokens.push(token); return token; };
  const releases: (() => void)[] = [];
  const grant = (name: string, policy: "allow" | "ask" | "deny" = "allow", who = a) => store.setGrant({ botId: who.bot.id, tool: name, destination: connection.id, policy });
  const call = (tool: string, callId: string, args: Record<string, unknown> = {}, who = a, signal?: AbortSignal) => gateway.call(who.token, { tool, connectionId: connection.id, callId, arguments: args }, signal ? { signal } : {});
  t.after(async () => { for (const release of releases) release(); await until(() => adapter.status().pendingCalls === 0); gateway.close(); context.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, context, adapter, broker, gateway, connection, a, b, cases, calls, grant, call, releases, ownTokens, setRewrite: (fn: typeof rewrite) => { rewrite = fn; } };
}
function bridge(t: TestContext, f: ReturnType<typeof setup>) {
  const input = new PassThrough(); const output = new PassThrough(); const capability = f.gateway.issueCapability({ turnId: f.a.turn.id });
  const hostBridge = new GatewayMcpBridge({ gateway: f.gateway, capability: capability.token, input, output }); let seq = 0; let buffer = ""; let transcript = "";
  const waiters = new Map<number, (message: any) => void>();
  output.on("data", chunk => { transcript += chunk.toString(); buffer += chunk.toString(); while (buffer.includes("\n")) { const end = buffer.indexOf("\n"); const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); waiters.get(message.id)?.(message); waiters.delete(message.id); } });
  const rpc = (method: string, params: unknown = {}) => { const id = ++seq; const promise = new Promise<any>(done => waiters.set(id, done)); input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); return promise; };
  const init = async () => { await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "context-fixture", version: "1" } }); input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`); };
  t.after(async () => { hostBridge.close(); await hostBridge.whenDrained(); });
  return { rpc, init, bridge: hostBridge, token: capability.token, transcript: () => transcript };
}

test("local broker releases only the fixed pair, preserves fallback filtering, and hides trusted graphs", t => {
  const f = setup(t); const upstream = new SyntheticCredentialBroker(); upstream.put("remote", { headers: { authorization: "synthetic-remote-secret" }, allowedHosts: ["backend.example.test"] });
  const broker = new ContextLocalCredentialBroker(upstream);
  assert.deepEqual(broker.acquire(CONTEXT_GATEWAY_CREDENTIAL_REF, CONTEXT_GATEWAY_HOST), { headers: {} });
  assert.equal(broker.acquire(CONTEXT_GATEWAY_CREDENTIAL_REF, "backend.example.test"), null); assert.equal(broker.acquire("remote", CONTEXT_GATEWAY_HOST), null);
  assert.equal(broker.acquire("remote", "other.example.test"), null); assert.deepEqual(broker.secretValues(), ["synthetic-remote-secret"]);
  assert.equal(broker.acquire("remote", "backend.example.test")?.headers.authorization, "synthetic-remote-secret");
  assert.equal(inspect(broker, { showHidden: true }).includes("synthetic-remote-secret"), false); assert.equal(inspect(f.adapter, { showHidden: true }).includes("context.sqlite"), false);
  assert.equal(JSON.stringify(f.adapter), "{}"); assert.equal(JSON.stringify(broker), "{}");
  const copy = contextGatewayManifests(); copy[0]!.version = "LATEST"; assert.equal(contextGatewayManifests()[0]!.version, "local-v1");
  assert.equal(registerContextGatewayTools(f.gateway, f.store, "work", f.adapter).id, f.connection.id); assert.equal(f.gateway.registry.listConnections("work").length, 1);
  assert.deepEqual(f.gateway.listTools(f.a.token), []); assert.ok(contextGatewayManifests().every(manifest => f.store.getGrant(f.a.bot.id, manifest.name, f.connection.id) === null));
});

test("actual MCP bridge gates local artifact writes by frozen approval hash and never repeats an effect", async t => {
  const f = setup(t); const mcp = bridge(t, f); await mcp.init(); assert.deepEqual((await mcp.rpc("tools/list")).result.tools.map((t:{name:string})=>t.name), MCP_DIRECTORY_NAMES);
  const empty=(await mcp.rpc("tools/call",{name:"dx_catalog_search",arguments:{query:"context.artifact.create"}})).result; assert.deepEqual(empty.structuredContent.tools,[]);
  const refused=(await mcp.rpc("tools/call",{name:"dx_catalog_call",arguments:{alias:"dx_"+"f".repeat(24),callId:"foreign",input:{}}}));assert.ok(refused.error);assert.equal(f.store.listActions().length,0);
  f.grant("context.artifact.create", "ask"); const [tool] = (await mcp.rpc("tools/list")).result.tools;
  const call = (markdown = "# Approved") => mcp.rpc("tools/call", { name: tool.name, arguments: { callId: "create", input: { markdown, origin: "synthetic label" } } });
  const pending = (await call()).result.structuredContent; assert.equal(pending.status, "awaiting_approval"); assert.equal(f.context.status().activeCapabilities, 0);
  assert.throws(() => f.store.decideAction(pending.actionId, { decision: "allow", requestHash: "wrong" }));
  f.store.decideAction(pending.actionId, { decision: "allow", requestHash: pending.requestHash });
  const done = (await call()).result.structuredContent; assert.equal(done.status, "succeeded"); assert.equal(done.result.untrustedContext, true); assert.equal(done.result.instructionAuthority, "none");
  assert.equal((await call()).result.structuredContent.actionId, done.actionId); assert.equal((await call("# Changed")).result.isError, true); assert.equal(f.calls.length, 1);
  assert.equal(f.context.status().activeCapabilities, 0); for (const token of [...f.ownTokens, mcp.token]) assert.equal(mcp.transcript().includes(token), false);
  for (const suffix of ["", "-wal"]) { let data = ""; try { data = readFileSync(`${f.store.databasePath}${suffix}`).toString("latin1"); } catch {} for (const token of f.ownTokens) assert.equal(data.includes(token), false); }
});

test("scoped bilingual recall and skills return verified data without foreign selectors or implicit confidential reads", async t => {
  const hits: ServiceHit[] = []; const f = setup(t, { implementation: "fixture", targetVersion: "2.5.2", search: async () => hits }); f.grant("context.recall"); f.grant("context.skills");
  const team = f.context.createTeam("Synthetic team"); f.context.assignBot(team, f.a.bot.id);
  const pages = [f.context.createMemory({ scope: { kind: "global" }, locale: "pt-BR", markdown: "# Global", origin: "fixture", classification: "context" }),
    f.context.createMemory({ scope: { kind: "bot", botId: f.a.bot.id }, locale: "pt-BR", markdown: "# Alpha", origin: "fixture", classification: "context" }),
    f.context.createMemory({ scope: { kind: "bot", botId: f.b.bot.id }, locale: "pt-BR", markdown: "# Beta", origin: "fixture", classification: "context" }),
    f.context.createMemory({ scope: { kind: "confidential", botId: f.a.bot.id }, locale: "pt-BR", markdown: "# Explicit private", origin: "fixture", classification: "context" }),
    f.context.createMemory({ scope: { kind: "team", teamId: team }, locale: "pt-BR", markdown: "# Team", origin: "fixture", classification: "context" }),
    f.context.createMemory({ scope: { kind: "global" }, locale: "en-US", markdown: "# English", origin: "fixture", classification: "context" })]; hits.push(...pages.map(page => page.service));
  const recall = async (id: string, extra = {}) => (await f.call("context.recall", id, { query: "fixed", locale: "pt-BR", ...extra })).result as any;
  assert.deepEqual((await recall("normal")).data.map((page: any) => page.markdown), ["# Global", "# Alpha", "# Team"]);
  assert.deepEqual((await recall("explicit", { include_confidential: true })).data.map((page: any) => page.markdown), ["# Global", "# Alpha", "# Explicit private", "# Team"]);
  assert.deepEqual((await recall("english", { locale: "en-US" })).data.map((page: any) => page.markdown), ["# English"]);
  for (const extra of [{ bot_id: f.b.bot.id }, { scope: "global" }, { team_id: team }, { path: "/outside" }, { headers: {} }, { classification: "health" }]) await assert.rejects(f.call("context.recall", "bad-selector", { query: "fixed", locale: "pt-BR", ...extra }));
  const skill = f.context.registerSkill("write", "1.0.0", "# Owner approved skill"); f.context.activateSkill({ kind: "global" }, skill);
  const result = (await f.call("context.skills", "skills")).result as any; assert.equal(result.data[0].sha256, skill.sha256); assert.equal(result.data[0].markdown, "# Owner approved skill"); assert.equal(result.instructionAuthority, "none"); assert.equal(f.context.status().activeCapabilities, 0);
});

test("artifact tools enforce bot ownership, CAS, append-only restore/fork and replay idempotency", async t => {
  const f = setup(t); for (const manifest of contextGatewayManifests()) { f.grant(manifest.name); f.grant(manifest.name, "allow", f.b); }
  const created = await f.call("context.artifact.create", "a", { markdown: "# First", origin: "fixture" }); const first = (created.result as any).data;
  const revised = await f.call("context.artifact.revise", "b", { artifact_id: first.id, expected_revision: 1, markdown: "# Second", origin: "fixture" }); assert.equal((revised.result as any).data.revision, 2);
  assert.equal((await f.call("context.artifact.revise", "stale", { artifact_id: first.id, expected_revision: 1, markdown: "# Stale", origin: "fixture" })).status, "unknown");
  assert.equal((await f.call("context.artifact.read", "foreign", { artifact_id: first.id }, f.b)).status, "unknown");
  const restored = await f.call("context.artifact.restore", "restore", { artifact_id: first.id, expected_revision: 2, from_revision: 1 }); assert.equal((restored.result as any).data.revision, 3);
  const forked = await f.call("context.artifact.fork", "fork", { artifact_id: first.id, revision: 2 }); const fork = (forked.result as any).data; assert.equal(fork.revision, 1); assert.deepEqual(fork.forkedFrom, { artifactId: first.id, revision: 2 });
  const history = await f.call("context.artifact.history", "history", { artifact_id: first.id }); assert.deepEqual((history.result as any).data.map((row: any) => row.revision), [1, 2, 3]);
  assert.equal((await f.call("context.artifact.read", "read", { artifact_id: first.id })).status, "succeeded");
  const before = f.calls.length; assert.equal((await f.call("context.artifact.restore", "restore", { artifact_id: first.id, expected_revision: 2, from_revision: 1 })).actionId, restored.actionId); assert.equal(f.calls.length, before); assert.equal(f.context.status().activeCapabilities, 0);
});

test("same-turn recalls serialize while other turns proceed, and canceled queue churn stays bounded", async t => {
  const holdA = gate(); const holdB = gate(); const queries: string[] = [];
  const f = setup(t, { implementation: "fixture", targetVersion: "2.5.2", async search(request) { queries.push(request.query); if (request.query === "a1") await holdA.promise; if (request.query === "b1") await holdB.promise; return []; } }); f.releases.push(holdA.release, holdB.release); f.grant("context.recall"); f.grant("context.recall", "allow", f.b);
  const first = f.call("context.recall", "a1", { query: "a1", locale: "pt-BR" }); await until(() => queries.length === 1);
  const second = f.call("context.recall", "a2", { query: "a2", locale: "pt-BR" }); const other = f.call("context.recall", "b1", { query: "b1", locale: "pt-BR" }, f.b);
  await until(() => queries.length === 2); assert.deepEqual(queries, ["a1", "b1"]); assert.equal(f.context.status().activeCapabilities, 2);
  for (let n = 0; n < 30; n++) { const abort = new AbortController(); const pending = f.call("context.recall", `cancel-${n}`, { query: "must-not-run", locale: "pt-BR" }, f.a, abort.signal); await until(() => f.adapter.status().pendingCalls === 4); abort.abort(); assert.equal((await pending).status, "unknown"); assert.equal(f.adapter.status().pendingCalls, 3); }
  assert.deepEqual(queries, ["a1", "b1"]); holdA.release(); assert.equal((await first).status, "succeeded"); assert.equal((await second).status, "succeeded"); holdB.release(); assert.equal((await other).status, "succeeded");
  assert.deepEqual(queries, ["a1", "b1", "a2"]); assert.equal(f.context.status().activeCapabilities, 0); assert.deepEqual(f.adapter.status(), { activeTurns: 0, pendingCalls: 0, pendingRevocations: 0 });
});

test("grant ABA while queued blocks a later local write before capability issuance", async t => {
  const hold = gate(); let searches = 0; const f = setup(t, { implementation: "fixture", targetVersion: "2.5.2", async search() { searches++; await hold.promise; return []; } }); f.releases.push(hold.release); f.grant("context.recall"); f.grant("context.artifact.create");
  const first = f.call("context.recall", "hold", { query: "fixed", locale: "pt-BR" }); await until(() => searches === 1);
  const write = f.call("context.artifact.create", "queued-write", { markdown: "# Must not persist", origin: "fixture" }); await until(() => f.adapter.status().pendingCalls === 2);
  f.grant("context.artifact.create", "deny"); f.grant("context.artifact.create", "allow"); hold.release(); assert.equal((await first).status, "succeeded"); assert.equal((await write).status, "unknown"); assert.equal(f.ownTokens.length, 1);
  const db = new DatabaseSync(f.context.databasePath, { readOnly: true }); assert.equal(db.prepare("SELECT count(*) AS n FROM artifacts").get()?.n, 0); db.close();
});

test("recall authorization revocation and noncooperative MCP cancellation discard late content and drain", async t => {
  const hold = gate(); let searches = 0; let hits: ServiceHit[] = []; const f = setup(t, { implementation: "fixture", targetVersion: "2.5.2", async search() { searches++; await hold.promise; return hits; } }); f.releases.push(hold.release); f.grant("context.recall");
  const page = f.context.createMemory({ scope: { kind: "global" }, locale: "pt-BR", markdown: "# Late content", origin: "fixture", classification: "context" }); hits = [page.service];
  const mcp = bridge(t, f); await mcp.init(); const [tool] = (await mcp.rpc("tools/list")).result.tools;
  const pending = mcp.rpc("tools/call", { name: tool.name, arguments: { callId: "read", input: { query: "fixed", locale: "pt-BR" } } }); void pending; await until(() => searches === 1);
  f.context.setRecallGrant(f.a.bot.id, { kind: "global" }, false); f.context.setRecallGrant(f.a.bot.id, { kind: "global" }, true);
  mcp.bridge.close(); let drained = false; const draining = mcp.bridge.whenDrained().then(() => { drained = true; }); await new Promise(done => setTimeout(done, 20)); assert.equal(drained, false); assert.equal(f.context.status().activeCapabilities, 1);
  hold.release(); await draining; assert.equal(f.store.listActions()[0]?.state, "unknown"); assert.equal(f.context.status().activeCapabilities, 0); assert.equal(mcp.transcript().includes("# Late content"), false); assert.equal(searches, 1);
});

test("lost writer refuses late reads, retains only own revoke for later fenced cleanup, and resumes without capability leaks", async t => {
  const hold = gate(); let searches = 0; const f = setup(t, { implementation: "fixture", targetVersion: "2.5.2", async search() { searches++; if (searches === 1) await hold.promise; return []; } }); f.releases.push(hold.release); f.grant("context.recall");
  const pending = f.call("context.recall", "lost", { query: "fixed", locale: "pt-BR" }); const rejected = assert.rejects(pending, (error: any) => error.code === "host_locked"); await until(() => searches === 1);
  const db = new DatabaseSync(f.store.databasePath); const token = db.prepare("SELECT token FROM host_lease WHERE id=1").get()!.token; db.prepare("UPDATE host_lease SET token='synthetic-writer-revocation' WHERE id=1").run();
  try { hold.release(); await rejected; assert.deepEqual(f.adapter.status(), { activeTurns: 0, pendingCalls: 0, pendingRevocations: 1 }); }
  finally { db.prepare("UPDATE host_lease SET token=? WHERE id=1").run(token as string); db.close(); }
  assert.equal((await f.call("context.recall", "fresh", { query: "fixed", locale: "pt-BR" })).status, "succeeded"); assert.equal(f.context.status().activeCapabilities, 0); assert.equal(f.adapter.status().pendingRevocations, 0);
});

test("adapter rejects scope and canonical manifest widening before local capability issuance", async t => {
  const f = setup(t); f.grant("context.skills"); f.setRewrite(call => ({ ...call, scope: { ...call.scope, botId: f.b.bot.id } })); assert.equal((await f.call("context.skills", "forged-bot")).status, "unknown"); assert.equal(f.ownTokens.length, 0);
  f.setRewrite(call => ({ ...call, version: "LATEST" })); assert.equal((await f.call("context.skills", "unpinned")).status, "unknown"); f.setRewrite(call => call);
  const create = contextGatewayManifests().find(manifest => manifest.name === "context.artifact.create")!; f.gateway.registerTool({ ...create, name: "context.fake_read", effect: "read" }); f.grant("context.fake_read");
  assert.equal((await f.call("context.fake_read", "widened", { markdown: "# No effect", origin: "fixture" })).status, "unknown"); assert.equal(f.ownTokens.length, 0);
  f.store.finishTurn(f.a.turn.id, "completed", null); await assert.rejects(f.call("context.skills", "ended")); assert.equal(f.context.status().activeCapabilities, 0);
});

test("real private Node MCP wrapper returns local context receipts without exposing capabilities", async t => {
  const f = setup(t); f.grant("context.artifact.create"); const lease = await prepareMcpTurn({ store: f.store, gateway: f.gateway, turnId: f.a.turn.id, wrapperPath: resolve("packages/cli/dist/mcp-stdio.js") });
  const child = spawn(lease.nativeServer.command, [...lease.nativeServer.args], { env: { PATH: "/usr/bin:/bin" }, shell: false, stdio: "pipe" }); let buffer = ""; let transcript = ""; let seq = 0; const waiters = new Map<number, (value: any) => void>();
  child.stdin.on("error", () => {}); child.stdout.on("data", chunk => { transcript += chunk.toString(); buffer += chunk.toString(); while (buffer.includes("\n")) { const end = buffer.indexOf("\n"); const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); waiters.get(value.id)?.(value); waiters.delete(value.id); } });
  const exited = new Promise(done => child.once("close", done)); const rpc = (method: string, params = {}) => { const id = ++seq; const result = new Promise<any>(done => waiters.set(id, done)); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); return result; };
  try {
    await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "local-context-wrapper", version: "1" } }); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const [tool] = (await rpc("tools/list")).result.tools; const params = { name: tool.name, arguments: { callId: "create", input: { markdown: "# Wrapper artifact", origin: "fixture" } } };
    const first = (await rpc("tools/call", params)).result.structuredContent; assert.equal(first.status, "succeeded"); assert.equal(first.result.data.markdown, "# Wrapper artifact"); assert.equal(first.result.untrustedContext, true);
    assert.equal((await rpc("tools/call", params)).result.structuredContent.actionId, first.actionId); assert.equal(f.calls.length, 1); for (const token of f.ownTokens) assert.equal(transcript.includes(token), false);
  } finally { child.stdin.end(); lease.stop(); await exited; await lease.whenDrained(); }
});

test("per-turn queue accepts at most eight calls and aborted waiters release slots without issuing capabilities", async t => {
  const hold = gate(); let searches = 0; const f = setup(t, { implementation: "fixture", targetVersion: "2.5.2", async search() { searches++; await hold.promise; return []; } }); f.releases.push(hold.release); f.grant("context.recall");
  const first = f.call("context.recall", "active", { query: "fixed", locale: "pt-BR" }); await until(() => searches === 1);
  const controllers = Array.from({ length: 7 }, () => new AbortController()); const queued = controllers.map((abort, index) => f.call("context.recall", `queued-${index}`, { query: "must-not-run", locale: "pt-BR" }, f.a, abort.signal));
  await until(() => f.adapter.status().pendingCalls === 8); assert.equal((await f.call("context.recall", "overflow", { query: "must-not-run", locale: "pt-BR" })).status, "unknown"); assert.equal(f.adapter.status().pendingCalls, 8); assert.equal(f.ownTokens.length, 1);
  for (const abort of controllers) abort.abort(); assert.ok((await Promise.all(queued)).every(result => result.status === "unknown")); assert.equal(f.adapter.status().pendingCalls, 1);
  hold.release(); assert.equal((await first).status, "succeeded"); assert.equal(searches, 1); assert.equal(f.context.status().activeCapabilities, 0); assert.equal(f.adapter.status().activeTurns, 0);
});

test("trusted fallback receives only nonlocal calls; local mismatches never route or acquire remote auth", async t => {
  const f = setup(t); const remoteAuth = Object.freeze({ headers: Object.freeze({ authorization: "synthetic-fallback-only" }) }); let fallbackCalls = 0;
  const adapter = new ContextGatewayAdapter({ context: f.context, store: f.store, fallback: { async execute(_call, auth) { fallbackCalls++; assert.equal(auth, remoteAuth); return { ok: true }; } } });
  adapter.bindGateway(f.gateway);
  const remote: AdapterCall = { toolkit: "remote", host: "backend.example.test", version: "v1", upstreamSlug: "REMOTE_READ", upstreamAccountRef: "synthetic-account", upstreamUserId: "synthetic-owner", connectionId: f.connection.id, idempotencyKey: "synthetic-unused", arguments: {}, scope: { installationId: f.store.hostId, ownerId: f.store.ownerId, botId: f.a.bot.id, profileId: "work", threadId: f.a.thread.id, turnId: f.a.turn.id } };
  assert.deepEqual(await adapter.execute(remote, remoteAuth, { signal: new AbortController().signal }), { ok: true }); assert.equal(fallbackCalls, 1);
  for (const patch of [{ host: CONTEXT_GATEWAY_HOST }, { toolkit: "dexter-context" }]) await assert.rejects(adapter.execute({ ...remote, ...patch }, remoteAuth, { signal: new AbortController().signal }));
  assert.equal(fallbackCalls, 1); assert.equal(f.context.status().activeCapabilities, 0);
});

test("unbound adapters refuse calls and host binding cannot change gateway identity", async t => {
  const f = setup(t); f.grant("context.skills"); assert.equal((await f.call("context.skills", "captured")).status, "succeeded");
  const adapter = new ContextGatewayAdapter({ context: f.context, store: f.store });
  await assert.rejects(adapter.execute(f.calls[0]!, { headers: {} }, { signal: new AbortController().signal })); assert.deepEqual(adapter.status(), { activeTurns: 0, pendingCalls: 0, pendingRevocations: 0 });
  adapter.bindGateway(f.gateway); adapter.bindGateway(f.gateway);
  const other = setup(t); assert.throws(() => adapter.bindGateway(other.gateway)); assert.throws(() => registerContextGatewayTools(other.gateway, f.store, "work", adapter));
});

for (const change of ["connection", "catalog"] as const) test(`queued context write revalidates ${change} after lock wait before mutation`, async t => {
  const hold = gate(); let searches = 0; const f = setup(t, { implementation: "fixture", targetVersion: "2.5.2", async search() { searches++; await hold.promise; return []; } }); f.releases.push(hold.release); f.grant("context.recall"); f.grant("context.artifact.create");
  const first = f.call("context.recall", "hold", { query: "fixed", locale: "pt-BR" }); await until(() => searches === 1);
  const pending = f.call("context.artifact.create", "queued-write", { markdown: "# Must not persist", origin: "fixture" }); await until(() => f.adapter.status().pendingCalls === 2);
  if (change === "connection") f.gateway.revokeConnection(f.connection.id);
  else { f.gateway.retireTool("context.artifact.create"); f.gateway.registerTool(contextGatewayManifests().find(manifest => manifest.name === "context.artifact.create")!); }
  hold.release(); assert.equal((await first).status, change === "connection" ? "unknown" : "succeeded"); assert.equal((await pending).status, "unknown"); assert.equal(f.ownTokens.length, 1);
  const db = new DatabaseSync(f.context.databasePath, { readOnly: true }); assert.equal(db.prepare("SELECT count(*) AS n FROM artifacts").get()?.n, 0); db.close(); assert.equal(f.context.status().activeCapabilities, 0);
});

for (const change of ["context-grant", "catalog", "terminal"] as const) test(`late recall revalidates ${change} without relying on abort and never returns plaintext`, async t => {
  const hold = gate(); let searches = 0; let hits: ServiceHit[] = [];
  const f = setup(t, { implementation: "fixture", targetVersion: "2.5.2", async search() { searches++; await hold.promise; return hits; } }); f.releases.push(hold.release); f.grant("context.recall");
  const page = f.context.createMemory({ scope: { kind: "global" }, locale: "pt-BR", markdown: "# Late private result", origin: "fixture", classification: "context" }); hits = [page.service];
  const pending = f.call("context.recall", "read", { query: "fixed", locale: "pt-BR" }); await until(() => searches === 1);
  if (change === "context-grant") { f.context.setRecallGrant(f.a.bot.id, { kind: "global" }, false); f.context.setRecallGrant(f.a.bot.id, { kind: "global" }, true); }
  else if (change === "catalog") { f.gateway.retireTool("context.recall"); f.gateway.registerTool(contextGatewayManifests().find(manifest => manifest.name === "context.recall")!); }
  else f.store.finishTurn(f.a.turn.id, "completed", null);
  hold.release(); const result = await pending; assert.equal(result.status, "unknown"); assert.equal(result.result, null); assert.equal(f.context.status().activeCapabilities, 0); assert.equal(f.adapter.status().activeTurns, 0);
  if (change !== "terminal") assert.equal((await f.call("context.recall", "read", { query: "fixed", locale: "pt-BR" })).status, "unknown");
  assert.equal(searches, 1);
});
