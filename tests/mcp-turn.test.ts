import { inspect, format } from 'node:util';
import { createServer } from 'node:net';
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, lstatSync, existsSync, readFileSync, rmSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { HostStore, HostError } from "@dexter/hub";
import { CapabilityGateway, SyntheticCredentialBroker, prepareMcpTurn, type McpTurnLease, type AdapterCall } from "@dexter/gateway";
import type { JsonValue } from "@dexter/contracts";
const wrapperPath = resolve("packages/cli/dist/mcp-stdio.js");
const SECRET = "synthetic-turn-credential-9cf73";
const HOST = "backend.example.test";
const tool = { name: "slack.send", toolkit: "slack", upstreamSlug: "SLACK_SEND", version: "v1", description: "Send", upstreamHost: HOST, effect: "write", destinationArgument: "channel", inputSchema: { type: "object", additionalProperties: false, required: ["channel", "text"], properties: { channel: { type: "string", maxLength: 12, enum: ["C-ops"] }, text: { type: "string", maxLength: 100 } } } };
const args = { channel: "C-ops", text: "hello" };
type Msg = { id?: number; result?: any; error?: { code: number; message: string } };
const tick = () => new Promise<void>(resolveDone => setImmediate(resolveDone));
const deadline = async <T>(promise: Promise<T>, ms = 3_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("test deadline")), ms); })]); }
  finally { clearTimeout(timer); }
};
function child(t: { after(fn: () => void | Promise<void>): void }, argv: readonly string[]) {
  const processChild = spawn(process.execPath, [...argv], { env: { PATH: "/usr/bin:/bin" }, stdio: "pipe", shell: false });
  let stderr = ""; let stdout = ""; let buffer = ""; let sequence = 0;
  const messages: Msg[] = []; const waiters = new Map<number, (msg: Msg) => void>();
  processChild.stderr.on("data", value => { stderr += value.toString(); });
  processChild.stdout.on("data", value => {
    stdout += value.toString(); buffer += value.toString();
    while (buffer.includes("\n")) {
      const n = buffer.indexOf("\n"); const msg: Msg = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1); messages.push(msg);
      if (msg.id !== undefined) { waiters.get(msg.id)?.(msg); waiters.delete(msg.id); }
    }
  });
  const exited = new Promise<number | null>(resolveDone => processChild.once("close", code => resolveDone(code)));
  processChild.stdin.on("error", () => {});
  t.after(async () => { processChild.kill("SIGTERM"); try { await deadline(exited); } catch { processChild.kill("SIGKILL"); await deadline(exited); } });
  const send = (value: unknown) => processChild.stdin.write(`${JSON.stringify(value)}\n`);
  const rpc = (method: string, params?: unknown): Promise<Msg> => {
    const id = ++sequence; const response = new Promise<Msg>(resolveDone => waiters.set(id, resolveDone));
    send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }); return deadline(response);
  };
  const init = async () => { assert.equal((await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "child-fixture", version: "1" } })).result.protocolVersion, "2025-11-25"); send({ jsonrpc: "2.0", method: "notifications/initialized", params: { _meta: { "claudecode/toolUseId": "fixture" } } }); };
  return { process: processChild, exited, messages, rpc, send, init, stderr: () => stderr, stdout: () => stdout };
}
function setup(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = mkdtempSync(join(tmpdir(), "dexter-turn-test-"));
  const store = new HostStore({ dataDir: dir }); const broker = new SyntheticCredentialBroker();
  broker.put("cred", { headers: { authorization: SECRET }, allowedHosts: [HOST] });
  const calls: AdapterCall[] = []; let execute: (signal: AbortSignal) => Promise<JsonValue> = async () => ({ ok: true, accidentalEcho: SECRET });
  const gateway = new CapabilityGateway({ store, broker, adapter: { async execute(call, _auth, context) { calls.push(call); return execute(context.signal); } } });
  gateway.registerTool(tool);
  const bot = store.createBot({ name: "Ops", profileId: "work", engine: "claude" });
  const connection = gateway.connectAccount({ profileId: "work", toolkit: "slack", label: "Work", upstreamAccountRef: "ca_work", credentialRef: "cred", allowedHosts: [HOST] });
  const thread = store.createThread(bot.id); const { turn } = store.createTurn(thread.id, { clientRequestId: "fixture", content: "synthetic" });
  store.claimNextTurn(thread.id);
  const leases: McpTurnLease[] = [];
  const tokens: string[] = []; const issue = gateway.issueCapability.bind(gateway);
  gateway.issueCapability = input => { const issued = issue(input); tokens.push(issued.token); return issued; };
  const prepare = async (extra: Record<string, unknown> = {}) => { const lease = await prepareMcpTurn({ store, gateway, turnId: turn.id, wrapperPath, ...extra }); leases.push(lease); return lease; };
  const grant = (policy: "allow" | "ask" | "deny") => store.setGrant({ botId: bot.id, tool: tool.name, destination: connection.id, policy });
  t.after(async () => { for (const lease of leases) await deadline(lease.whenDrained()); gateway.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, gateway, bot, connection, thread, turn, calls, tokens, leases, prepare, grant, setExecute: (fn: typeof execute) => { execute = fn; } };
}
const call = (c: ReturnType<typeof child>, name: string, callId: string, input: unknown = args) => c.rpc("tools/call", { name, arguments: { callId, input } });
const discoveryParams = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "sibling-probe-fixture", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } };

if (process.platform !== "win32") {
  test("real Unix lease attaches its original issued scope only to the trusted overflow sink",async t=>{
    const f=setup(t);f.grant("allow");f.setExecute(async()=>({data:"synthetic-overflow ".repeat(4000)}));let captured:any;
    const lease=await f.prepare({bridgeLimits:{maxOutputTokens:500},artifactSink:async(input:unknown)=>{captured=input;return {artifactId:"lease-owned-overflow"};}});
    const client=new Client({name:"artifact-scope-lease-fixture",version:"1"});t.after(async()=>{await client.close();});
    await deadline(client.connect(new StdioClientTransport({command:lease.nativeServer.command,args:[...lease.nativeServer.args],env:{PATH:"/usr/bin:/bin"},stderr:"pipe"})));
    const listed=await client.listTools(),entry=listed.tools.find(item=>/^dx_[a-f0-9]{24}$/.test(item.name))!;
    const result=await client.callTool({name:entry.name,arguments:{callId:"scope-overflow-once",input:args}});
    const projected=result.structuredContent as {actionId:string;requestHash:string;result:{artifact:{artifactId:string}}};
    assert.equal(result.isError,false);assert.equal(projected.result.artifact.artifactId,"lease-owned-overflow");
    assert.deepEqual(captured.originScope,lease.scope);assert(Object.isFrozen(captured.originScope));assert.equal(f.tokens.length,1);
    assert.equal(captured.actionId,projected.actionId);assert.equal(captured.requestHash,projected.requestHash);
    assert.equal(f.store.getAction(projected.actionId).request.threadId,lease.scope.threadId);assert.equal(f.calls.length,1);
    assert(!JSON.stringify(result).includes(lease.scope.ownerId),"trusted scope is not part of the MCP output");
    await client.close();await deadline(lease.whenDrained());
  });
  for (const era of ["legacy", "pin", "auto"] as const) test(`real SDK 2.3.1 base stdio ${era} negotiates its Unix lease then executes exactly once`, async t => {
    const f = setup(t); f.grant("allow"); const lease = await f.prepare();
    const client = new Client({ name: "real-base-stdio-fixture", version: "1" }, era === "legacy" ? {} : {
      versionNegotiation: { mode: era === "auto" ? "auto" : { pin: "2026-07-28" } } });
    // Use the SDK's exact base class: it spawns a disposable discovery sibling, unlike a subclass/custom transport.
    const transport = new StdioClientTransport({ command: lease.nativeServer.command, args: [...lease.nativeServer.args], env: { PATH: "/usr/bin:/bin" }, stderr: "pipe" });
    let stderr = ""; transport.stderr?.on("data", value => { stderr += value.toString(); });
    t.after(async () => { await client.close(); });
    await deadline(client.connect(transport), 5_000);
    assert.equal(f.tokens.length, 1, "sibling replacement retains the original expiry and facade target snapshot");
    assert.equal(client.getNegotiatedProtocolVersion(), era === "legacy" ? "2025-11-25" : "2026-07-28");
    assert.equal(f.calls.length, 0); assert.equal(f.store.listActions().length, 0, "discovery admits no logical effect");
    const listed = await client.listTools(); const mcp = listed.tools.find(item => /^dx_[a-f0-9]{24}$/.test(item.name))!;
    const input = { name: mcp.name, arguments: { callId: "real-stdio-once", input: args } };
    const result = await client.callTool(input); assert.equal(result.isError, false);
    assert.equal((result.structuredContent as { status: string }).status, "succeeded");
    assert.deepEqual(await client.callTool(input), result); assert.equal(f.calls.length, 1);
    await client.close(); await deadline(lease.whenDrained());
    assert.equal(transport.pid, null); assert.equal(stderr, ""); assert(!existsSync(lease.socketPath));
    for (const token of f.tokens) assert.throws(() => f.gateway.listTools(token), "probe, session and base capabilities end with the lease");
    const reconnect = child(t, lease.nativeServer.args); assert.equal(await deadline(reconnect.exited), 1); assert.equal(f.calls.length, 1);
  });

  test("disposable discovery grants one replacement only; a second probe cannot reopen the lease", async t => {
    const f = setup(t); const lease = await f.prepare();
    const probe = child(t, lease.nativeServer.args); assert.equal((await probe.rpc("server/discover", discoveryParams)).result.resultType, "complete");
    probe.process.stdin.end(); await deadline(probe.exited).catch(() => { throw new Error(`first probe EOF did not exit; lease stopped=${lease.isStopped}`); });
    const second = child(t, lease.nativeServer.args); assert.equal((await second.rpc("server/discover", discoveryParams)).result.resultType, "complete");
    second.process.stdin.end(); await deadline(second.exited).catch(() => { throw new Error(`second probe EOF did not exit; lease stopped=${lease.isStopped}`); }); await deadline(lease.whenDrained());
    assert.equal(f.calls.length, 0); assert.equal(f.store.listActions().length, 0);
    const third = child(t, lease.nativeServer.args); assert.equal(await deadline(third.exited), 1);
  });

  for (const extra of ["request", "notification", "partial", "metadata", "invalid"] as const) test(`discovery followed by ${extra} is terminal at EOF, never a reusable probe`, async t => {
    const f = setup(t); const lease = await f.prepare(); const c = child(t, lease.nativeServer.args);
    if (extra === "metadata") await c.rpc("server/discover", { _meta: { ...discoveryParams._meta, extra: "synthetic" } });
    else if (extra === "invalid") { const response = await c.rpc("server/discover", { _meta: { ...discoveryParams._meta, "io.modelcontextprotocol/clientInfo": {} } }); assert.equal(response.error?.code, -32602); }
    else {
      await c.rpc("server/discover", discoveryParams);
      if (extra === "request") await c.rpc("tools/list", discoveryParams);
      if (extra === "notification") c.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      if (extra === "partial") c.process.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/call"');
    }
    c.process.stdin.end(); await deadline(c.exited); await deadline(lease.whenDrained());
    const reconnect = child(t, lease.nativeServer.args); assert.equal(await deadline(reconnect.exited), 1); assert.equal(f.calls.length, 0);
  });

  test("Stop during disposable probe replacement window revokes immediately without admitting another socket", async t => {
    const f = setup(t); const controller = new AbortController(), lease = await f.prepare({ signal: controller.signal });
    const c = child(t, lease.nativeServer.args); await c.rpc("server/discover", discoveryParams); c.process.stdin.end(); await deadline(c.exited);
    controller.abort(); await deadline(lease.whenDrained());
    const reconnect = child(t, lease.nativeServer.args); assert.equal(await deadline(reconnect.exited), 1); assert.equal(f.calls.length, 0);
    for (const token of f.tokens) assert.throws(() => f.gateway.listTools(token));
  });

  test("revoked original capability is not recreated for the disposable sibling's session", async t => {
    const f = setup(t); const lease = await f.prepare();
    const c = child(t, lease.nativeServer.args); await c.rpc("server/discover", discoveryParams); c.process.stdin.end(); await deadline(c.exited);
    f.gateway.revokeTurnCapabilities(f.turn.id);
    const next = child(t, lease.nativeServer.args); assert.equal(await deadline(next.exited), 0); assert.equal(next.stdout(), "");
    await deadline(lease.whenDrained()); assert.equal(f.tokens.length, 1); assert.equal(f.calls.length, 0);
  });

  test("disposable sibling replacement window expires after five seconds without effects", { timeout: 8_000 }, async t => {
    const f = setup(t); const lease = await f.prepare();
    const c = child(t, lease.nativeServer.args); await c.rpc("server/discover", discoveryParams); c.process.stdin.end(); await deadline(c.exited);
    assert.equal(lease.isStopped, false);
    await new Promise<void>(resolveDone => setTimeout(resolveDone, 5_100));
    assert.equal(lease.isStopped, true); await deadline(lease.whenDrained());
    const late = child(t, lease.nativeServer.args); assert.equal(await deadline(late.exited), 1); assert.equal(f.calls.length, 0);
    assert.throws(() => f.gateway.listTools(f.tokens[0]!));
  });

  test("turn lease + actual Node stdio wrapper exposes only granted tools and contains no token/header config", async t => {
    const f = setup(t); const lease = await f.prepare();
    assert.equal(lstatSync(dirname(lease.socketPath)).mode & 0o777, 0o700); assert.equal(lstatSync(lease.socketPath).mode & 0o777, 0o600); assert.equal(lstatSync(lease.configPath).mode & 0o777, 0o600);
    assert.equal(lstatSync(lease.configPath).uid, process.getuid!()); assert.ok(lease.socketPath.length < 100); assert.ok(lease.nativeServer.command.startsWith("/"));
    const config = JSON.parse(readFileSync(lease.configPath, "utf8"));
    assert.deepEqual(Object.keys(config.mcpServers), ["dexter_gateway"]); assert.equal(config.mcpServers.dexter_gateway.env, undefined); assert.equal(config.mcpServers.dexter_gateway.headers, undefined);
    const exposed = JSON.stringify([config, lease, lease.nativeServer, lease.allowedMcpTools]);
    assert.ok(!exposed.includes(SECRET)); for (const token of f.tokens) assert.ok(!exposed.includes(token)); assert.deepEqual(lease.allowedMcpTools, ["mcp__dexter_gateway__dx_catalog_search", "mcp__dexter_gateway__dx_catalog_describe", "mcp__dexter_gateway__dx_catalog_call"]);
    const c = child(t, lease.nativeServer.args); for (const token of f.tokens) assert.ok(!c.process.spawnargs.join(" ").includes(token));
    await c.init(); assert.deepEqual((await c.rpc("tools/list")).result.tools.filter((tool: {name:string}) => /^dx_[a-f0-9]{24}$/.test(tool.name)), []);
    f.grant("allow"); const [mcp] = (await c.rpc("tools/list")).result.tools.filter((tool: {name:string}) => /^dx_[a-f0-9]{24}$/.test(tool.name));
    assert.equal((await call(c, mcp.name, "send")).result.structuredContent.status, "succeeded");
    assert.equal((await call(c, mcp.name, "send")).result.structuredContent.status, "succeeded"); assert.equal(f.calls.length, 1);
    assert.equal((await call(c, mcp.name, "secret", { ...args, text: SECRET })).result.isError, true);
    assert.equal(f.calls.length, 1); assert.equal(c.stderr(), ""); assert.ok(!c.stdout().includes(SECRET)); for (const token of f.tokens) assert.ok(!c.stdout().includes(token));
    c.process.stdin.end(); assert.equal(await deadline(c.exited), 0); await lease.whenDrained();
    assert.ok(!existsSync(lease.configPath)); assert.ok(!existsSync(lease.socketPath)); assert.ok(!existsSync(dirname(lease.socketPath)));
    assert.throws(() => f.gateway.listTools(f.tokens[0]!));
  });

  test("actual wrapper approval polling and grant revocation never dispatch an old approved action", async t => {
    const f = setup(t); f.grant("ask"); const lease = await f.prepare();
    assert.equal(lease.allowedMcpTools.length, 4); assert.ok(lease.allowedMcpTools[0]!.length <= 64);
    const c = child(t, lease.nativeServer.args); await c.init(); const [mcp] = (await c.rpc("tools/list")).result.tools.filter((tool: {name:string}) => /^dx_[a-f0-9]{24}$/.test(tool.name));
    const response=call(c,mcp.name,"ask");
    let pending;
    while(!(pending=f.store.listActions("awaiting_approval")[0]))await tick();
    f.store.decideAction(pending.id, { decision: "allow", requestHash: pending.requestHash });
    f.grant("deny"); const blocked = (await response).result.structuredContent;
    assert.equal(blocked.status, "blocked"); assert.equal(blocked.reason, "permission_changed"); assert.equal(f.calls.length, 0);
    assert.deepEqual((await c.rpc("tools/list")).result.tools.filter((tool: {name:string}) => /^dx_[a-f0-9]{24}$/.test(tool.name)), []);
    lease.stop(); assert.equal(await deadline(c.exited), 0); await lease.whenDrained();
  });

  test("single-connection lease rejects a second wrapper and never reconnects after EOF", async t => {
    const f = setup(t); const lease = await f.prepare(); const first = child(t, lease.nativeServer.args); await first.init();
    const second = child(t, lease.nativeServer.args); assert.equal(await deadline(second.exited), 0); assert.equal(second.stdout(), "");
    assert.deepEqual((await first.rpc("ping")).result, {});
    first.process.stdin.end(); await deadline(first.exited); await lease.whenDrained();
    const reconnect = child(t, lease.nativeServer.args); assert.equal(await deadline(reconnect.exited), 1); assert.equal(reconnect.stderr(), "MCP local transport unavailable.\n");
    assert.equal(f.calls.length, 0);
  });

  test("lease EOF cancels execution but retains resources/writer until an uncooperative effect settles", async t => {
    const f = setup(t); f.grant("allow"); const lease = await f.prepare(); const c = child(t, lease.nativeServer.args); await c.init(); const [mcp] = (await c.rpc("tools/list")).result.tools.filter((tool: {name:string}) => /^dx_[a-f0-9]{24}$/.test(tool.name));
    let release: () => void = () => {}; let signal: AbortSignal | undefined;
    f.setExecute(abort => { signal = abort; return new Promise(resolveDone => { release = () => resolveDone({ ok: true }); }); });
    c.send({ jsonrpc: "2.0", id: 90, method: "tools/call", params: { name: mcp.name, arguments: { callId: "effect", input: args } } });
    for (let n = 0; n < 100 && f.calls.length === 0; n++) await tick(); assert.equal(f.calls.length, 1);
    c.process.stdin.end(); await deadline(c.exited); assert.equal(signal?.aborted, true);
    let drained = false; const draining = lease.whenDrained().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    assert.ok(existsSync(lease.configPath)); assert.equal(f.store.summary().lease.pid, process.pid);
    release(); await deadline(draining); assert.equal(f.store.listActions()[0]?.state, "succeeded"); assert.equal(f.calls.length, 1); assert.equal(drained, true);
    assert.ok(!existsSync(lease.configPath));
  });

  test("wrapper refuses foreign/nonprivate paths and oversized input with fixed errors", async t => {
    const f = setup(t); const lease = await f.prepare(); chmodSync(dirname(lease.socketPath), 0o755);
    const unsafe = child(t, lease.nativeServer.args); assert.equal(await deadline(unsafe.exited), 1); assert.equal(unsafe.stderr(), "MCP local transport unavailable.\n"); assert.equal(unsafe.stdout(), "");
    chmodSync(dirname(lease.socketPath), 0o700);
    const missing = child(t, [wrapperPath, "/tmp/no-such-dexter-mcp.sock"]); assert.equal(await deadline(missing.exited), 1); assert.equal(missing.stderr(), "MCP local transport unavailable.\n");
    const c = child(t, lease.nativeServer.args); await c.init(); c.process.stdin.write("x".repeat(256 * 1024 + 1));
    assert.equal(await deadline(c.exited), 1); assert.equal(c.stderr(), "MCP local transport unavailable.\n"); assert.ok(!c.stdout().includes("xxxx"));
    await lease.whenDrained(); assert.equal(f.calls.length, 0);
  });

  test("fenced/queued/aborted setup creates no capability or endpoint and owner-scoped identity is derived", async t => {
    const f = setup(t); const raw = new DatabaseSync(f.store.databasePath); raw.exec("UPDATE host_lease SET token = 'fenced'"); raw.close();
    await assert.rejects(f.prepare(), error => error instanceof HostError && error.code === "host_locked"); assert.equal(f.tokens.length, 0);
    const other = setup(t); const aborted = new AbortController(); aborted.abort(); await assert.rejects(other.prepare({ signal: aborted.signal })); assert.equal(other.tokens.length, 0);
    const queued = other.store.createTurn(other.thread.id, { clientRequestId: "queued", content: "x" }); await assert.rejects(other.prepare({ turnId: queued.turn.id })); assert.equal(other.tokens.length, 0);
    const lease = await other.prepare(); assert.equal(lease.scope.ownerId, other.store.ownerId); assert.equal(lease.scope.botId, other.bot.id); assert.equal(lease.scope.turnId, other.turn.id);
    const c = child(t, lease.nativeServer.args); await c.init(); c.process.stdin.end(); await deadline(c.exited); await lease.whenDrained();
  });

  test("lease cleanup removes only created files and retains unexpected additions", async t => {
    const f = setup(t); const lease = await f.prepare(); lease.stop();
    const foreign = join(dirname(lease.socketPath), "foreign.txt"); writeFileSync(foreign, "preserve");
    await assert.rejects(lease.whenDrained(), /MCP cleanup incomplete/); assert.equal(readFileSync(foreign, "utf8"), "preserve");
    rmSync(foreign); rmSync(dirname(lease.socketPath), { recursive: true, force: true });
    // This test explicitly inspected and cleaned the retained files. Do not retry the expected failed cleanup in after().
    f.leases.splice(f.leases.indexOf(lease), 1);
  });
}

if (process.platform !== "win32") {
  test("actual wrapper cancellation yields a terminal unknown receipt and polling never repeats its effect", async t => {
    const f = setup(t); f.grant("allow"); const lease = await f.prepare(); const c = child(t, lease.nativeServer.args);
    await c.init(); const [mcp] = (await c.rpc("tools/list")).result.tools.filter((tool: {name:string}) => /^dx_[a-f0-9]{24}$/.test(tool.name));
    f.setExecute(signal => new Promise((_resolveDone, reject) => { signal.addEventListener("abort", () => reject(new Error(`cancelled after effect ${SECRET}`)), { once: true }); }));
    c.send({ jsonrpc: "2.0", id: 60, method: "tools/call", params: { name: mcp.name, arguments: { callId: "cancel", input: args } } });
    for (let n = 0; n < 100 && f.calls.length === 0; n++) await tick(); assert.equal(f.calls.length, 1);
    c.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 60, reason: SECRET } });
    for (let n = 0; n < 100 && f.store.listActions()[0]?.state !== "unknown"; n++) await tick();
    assert.equal(f.store.listActions()[0]?.state, "unknown");
    assert.equal((await call(c, mcp.name, "cancel")).result.structuredContent.status, "unknown"); assert.equal(f.calls.length, 1);
    assert.ok(!c.messages.some(message => message.id === 60)); assert.ok(!c.stdout().includes(SECRET)); assert.equal(c.stderr(), "");
    c.process.stdin.end(); await deadline(c.exited); await lease.whenDrained();
  });
}

if (process.platform !== 'win32') {
 for (const replacement of ['file','listener']) test('lease preserves replacement published endpoint on libuv close: '+replacement,async t=>{
  const f=setup(t);const lease=await f.prepare();const original=join(dirname(lease.socketPath),'original.sock');renameSync(lease.socketPath,original);
  let listener: ReturnType<typeof createServer>|undefined;
  if(replacement==='file')writeFileSync(lease.socketPath,'preserve',{mode:0o600});else{listener=createServer();await new Promise<void>((resolveDone,reject)=>{listener!.once('error',reject);listener!.listen(lease.socketPath,resolveDone)});chmodSync(lease.socketPath,0o600)}
  const inode=lstatSync(lease.socketPath).ino;lease.stop();await assert.rejects(lease.whenDrained(),/MCP cleanup resource changed/);assert.equal(lstatSync(lease.socketPath).ino,inode);if(replacement==='file')assert.equal(readFileSync(lease.socketPath,'utf8'),'preserve');
  if(listener)await new Promise<void>(resolveDone=>listener!.close(()=>resolveDone()));
  rmSync(dirname(lease.socketPath),{recursive:true,force:true});f.leases.splice(f.leases.indexOf(lease),1);
 });
 test('lease inspect and console formatting never expose capability or broker secret even while connected',async t=>{
  const f=setup(t);const lease=await f.prepare();const c=child(t,lease.nativeServer.args);await c.init();
  const diagnostics=[inspect(lease,{depth:20,showHidden:true}),format('%o',lease),JSON.stringify(lease)].join('\n');for(const token of f.tokens)assert(!diagnostics.includes(token));assert(!diagnostics.includes(SECRET));c.process.stdin.end();await deadline(c.exited);await lease.whenDrained();
 });
}
