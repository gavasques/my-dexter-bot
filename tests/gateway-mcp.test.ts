import { inspect, format } from 'node:util';
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { HostStore } from "@dexter/hub";
import { CapabilityGateway, SyntheticCredentialBroker, GatewayMcpBridge, type GatewayMcpOptions, type AdapterCall } from "@dexter/gateway";
import type { JsonValue } from "@dexter/contracts";

type Message = { id: number | string | null; result?: any; error?: { code: number; message: string } };
const HOST = "backend.example.test";
const SECRET = "synthetic-mcp-secret-59d72";
const manifest = { name: "slack.send", toolkit: "slack", upstreamSlug: "SLACK_SEND", version: "v1", description: "Send to the permitted channel", upstreamHost: HOST, effect: "write", destinationArgument: "channel",
  inputSchema: { type: "object", additionalProperties: false, required: ["channel", "text"], properties: { channel: { type: "string", maxLength: 20, enum: ["C-ops"] }, text: { type: "string", maxLength: 100 } } } };
const clean = { channel: "C-ops", text: "hello" };
function setup(t: { after(fn: () => void | Promise<void>): void }, limits: Partial<GatewayMcpOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dexter-mcp-"));
  const store = new HostStore({ dataDir: dir });
  const broker = new SyntheticCredentialBroker();
  broker.put("cred", { headers: { authorization: `Bearer ${SECRET}` }, allowedHosts: [HOST] });
  const calls: AdapterCall[] = [];
  let execute: (call: AdapterCall, signal: AbortSignal) => Promise<JsonValue> = async call => ({ posted: call.arguments, accidentalEcho: SECRET });
  const gateway = new CapabilityGateway({ store, broker, adapter: { async execute(call, _auth, context) { calls.push(call); return execute(call, context.signal); } } });
  gateway.registerTool(manifest);
  const bot = store.createBot({ name: "Ops", profileId: "work", engine: "claude" });
  const work = gateway.connectAccount({ profileId: "work", toolkit: "slack", label: "Work", upstreamAccountRef: "ca_work", credentialRef: "cred", allowedHosts: [HOST] });
  const other = gateway.connectAccount({ profileId: "work", toolkit: "slack", label: "Other", upstreamAccountRef: "ca_other", credentialRef: "cred", allowedHosts: [HOST] });
  const thread = store.createThread(bot.id);
  const { turn } = store.createTurn(thread.id, { clientRequestId: "mcp", content: "synthetic" });
  store.claimNextTurn(thread.id);
  const input = new PassThrough(); const output = limits.output ?? new PassThrough();
  const { token } = gateway.issueCapability({ turnId: turn.id });
  const messages: Message[] = []; let transcript = ""; let rest = "";
  const waiters = new Map<number | string, { resolve: (message: Message) => void; timer: ReturnType<typeof setTimeout> }>();
  output.on("data", chunk => {
    transcript += chunk.toString(); rest += chunk.toString();
    while (rest.includes("\n")) {
      const end = rest.indexOf("\n"); const message: Message = JSON.parse(rest.slice(0, end)); rest = rest.slice(end + 1); messages.push(message);
      if (message.id !== null) { const waiter = waiters.get(message.id); if (waiter) { clearTimeout(waiter.timer); waiters.delete(message.id); waiter.resolve(message); } }
    }
  });
  const bridge = new GatewayMcpBridge({ gateway, capability: token, input, output, ...limits });
  let seq = 0;
  const send = (value: unknown) => input.write(`${JSON.stringify(value)}\n`);
  const rpc = (method: string, params?: unknown): Promise<Message> => {
    const id = ++seq;
    const response = new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(id); reject(new Error("test response timeout")); }, 3000);
      waiters.set(id, { resolve, timer });
    });
    send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return response;
  };
  const init = async () => { const result = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic", version: "1" } }); assert.equal(result.result.protocolVersion, "2025-11-25"); send({ jsonrpc: "2.0", method: "notifications/initialized" }); };
  const list = async () => (await rpc("tools/list")).result.tools.filter((tool: {name:string}) => /^dx_[a-f0-9]{24}$/.test(tool.name));
  const grant = (policy: "ask" | "allow" | "deny") => store.setGrant({ botId: bot.id, tool: manifest.name, destination: work.id, policy });
  const call = (name: string, callId: string, args: unknown = clean) => rpc("tools/call", { name, arguments: { callId, input: args } });
  t.after(async () => { bridge.close(); await bridge.whenDrained(); for (const waiter of waiters.values()) clearTimeout(waiter.timer); gateway.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, broker, gateway, bot, work, other, turn, token, input, output, bridge, messages, rpc, send, init, list, grant, call, calls,
    setExecute: (fn: typeof execute) => { execute = fn; }, transcript: () => transcript };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

for(const success of [false,true])test(`R2 durable delivery follows the actual output write ACK (${success?"success":"failure"})`,async t=>{
  let acknowledge:((error?:Error|null)=>void)|undefined,delivered=0;
  const output=new Writable({write(chunk,_encoding,callback){
    const frame=JSON.parse(chunk.toString()) as Message;
    this.emit("data",chunk);
    if(frame.result?.structuredContent)acknowledge=callback;else callback();
  }});
  const f=setup(t,{output,acknowledgeToolResult:(_input,outcome)=>{
    delivered++;f.store.markToolResultDelivered(outcome.actionId,f.turn.id,outcome.result);
  },settleApproval:async(_input,outcome)=>{
    f.store.recordToolOutcome(outcome.actionId,outcome.result);return outcome;
  }});
  f.grant("allow");await f.init();const [entry]=await f.list();
  const result=await f.call(entry.name,"ack-effect");const id=result.result.structuredContent.actionId;
  assert.equal(f.store.toolActionOrigin(id)?.delivered,false);assert.equal(delivered,0);
  assert(acknowledge);acknowledge(success?null:new Error("synthetic transport failure"));await tick();
  assert.equal(delivered,success?1:0);assert.equal(f.store.toolActionOrigin(id)?.delivered,success);
  f.store.finishTurn(f.turn.id,"completed",null);
  const continuation=f.store.createActionResultTurn(id);
  // Socket write acknowledgement proves transport only; without a provider transcript the host
  // still delivers exactly one durable answer and a new model call cannot repeat the effect.
  assert.equal(f.store.toolActionProgress(id)?.consumedByEngine,false);
  assert(continuation);assert.equal(continuation.state,"queued");
  assert.equal(f.store.replayedContinuationAction(continuation.id,manifest.name,f.work.id,clean)?.id,id);
  assert.equal(f.store.createActionResultTurn(id)?.id,continuation.id);
  assert.equal(f.calls.length,1);
});

test("MCP initialization and granted-only catalog carry pinned schema without connection credentials", async t => {
  const f = setup(t);
  assert.equal((await f.rpc("tools/list")).error?.message, "Initialization required");
  await f.init(); assert.deepEqual(await f.list(), []);
  f.grant("allow"); const tools = await f.list(); assert.equal(tools.length, 1);
  assert.match(tools[0].name, /^dx_[a-f0-9]{24}$/);
  assert.deepEqual(tools[0].inputSchema.properties.input, manifest.inputSchema);
  assert.equal((await f.rpc("ping")).result && Object.keys((await f.rpc("ping")).result).length, 0);
  const result = await f.call(tools[0].name, "send-1");
  assert.equal(result.result.structuredContent.status, "succeeded"); assert.equal(f.calls[0]?.upstreamAccountRef, "ca_work");
  assert.ok(!f.transcript().includes(SECRET)); assert.ok(!f.transcript().includes("ca_work")); assert.ok(!f.transcript().includes(HOST)); assert.ok(!f.transcript().includes(f.token));
  assert.equal(f.calls.length, 1);
});

test("MCP tampering cannot select another principal, connection, URL or known credential", async t => {
  const f = setup(t); f.grant("allow"); await f.init(); const [tool] = await f.list();
  for (const extra of [{ ownerId: "other" }, { connectionId: f.other.id }, { capability: f.token }, { headers: { authorization: SECRET } }]) {
    assert.equal((await f.rpc("tools/call", { name: tool.name, arguments: { callId: "tamper", input: clean, ...extra } })).error?.message, "Invalid params");
  }
  for (const input of [{ ...clean, user_id: "other" }, { ...clean, url: "https://evil.test/" }, { ...clean, channel: "C-secret" }, { ...clean, text: SECRET }]) {
    const reply = await f.call(tool.name, "bad", input); assert.equal(reply.result.isError, true);
  }
  assert.equal((await f.call("dx_unknown", "bad")).error?.message, "Unknown tool");
  assert.equal(f.store.listActions().length, 0); assert.equal(f.calls.length, 0); assert.ok(!f.transcript().includes(SECRET));
  assert.ok(!f.transcript().includes(f.token));
});

test("MCP approval polling, stable callId and grant revocation revalidate gateway authority", async t => {
  const f = setup(t); f.grant("ask"); await f.init(); const [tool] = await f.list();
  const planned = (await f.call(tool.name, "approved")).result.structuredContent;
  assert.equal(planned.status, "awaiting_approval"); assert.equal(f.calls.length, 0);
  assert.equal((await f.call(tool.name, "approved")).result.structuredContent.status, "awaiting_approval");
  f.store.decideAction(planned.actionId, { decision: "allow", requestHash: planned.requestHash });
  assert.equal((await f.call(tool.name, "approved")).result.structuredContent.status, "succeeded");
  assert.equal((await f.call(tool.name, "approved")).result.structuredContent.status, "succeeded"); assert.equal(f.calls.length, 1);
  assert.equal((await f.call(tool.name, "approved", { ...clean, text: "changed" })).result.isError, true);
  const pending = (await f.call(tool.name, "revoked")).result.structuredContent;
  f.store.decideAction(pending.actionId, { decision: "allow", requestHash: pending.requestHash });
  f.grant("deny"); assert.deepEqual(await f.list(), []);
  const blocked = (await f.call(tool.name, "revoked")).result.structuredContent;
  assert.equal(blocked.status, "blocked"); assert.equal(blocked.reason, "permission_changed"); assert.equal(f.calls.length, 1);
  assert.equal((await f.call(tool.name, "fresh")).result.isError, true);
});

test("MCP unknown after effect remains terminal across new JSON-RPC IDs and concurrent replay", async t => {
  const f = setup(t); f.grant("allow"); await f.init(); const [tool] = await f.list();
  f.setExecute(async () => { throw new Error(`after effect with ${SECRET}`); });
  const [a, b] = await Promise.all([f.call(tool.name, "effect"), f.call(tool.name, "effect")]);
  assert.equal(a.result.structuredContent.status, "unknown"); assert.equal(a.result.isError, true);
  assert.equal(a.result.structuredContent.actionId, b.result.structuredContent.actionId);
  assert.equal((await f.call(tool.name, "effect")).result.structuredContent.status, "unknown"); assert.equal(f.calls.length, 1);
  assert.ok(!f.transcript().includes(SECRET));
});

test("MCP timeout and cancellation hold their execution slots until an uncooperative adapter settles", async t => {
  const f = setup(t, { maxInFlight: 1, requestTimeoutMs: 20 }); f.grant("allow"); await f.init(); const [tool] = await f.list();
  let release: () => void = () => {}; let seen: AbortSignal | undefined;
  f.setExecute((_call, signal) => { seen = signal; return new Promise(resolve => { release = () => resolve({ ok: true }); }); });
  const reply = await f.call(tool.name, "slow"); assert.equal(reply.error?.code, -32002); assert.equal(seen?.aborted, true);
  assert.equal((await f.rpc("tools/list")).error?.code, -32001); assert.equal(f.calls.length, 1);
  release(); await f.bridge.whenDrained();
  assert.equal((await f.call(tool.name, "slow")).result.structuredContent.status, "succeeded"); assert.equal(f.calls.length, 1);
  const id = 99; f.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool.name, arguments: { callId: "cancel", input: clean } } });
  f.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: SECRET } });
  assert.equal(seen?.aborted, true); assert.equal((await f.rpc("ping")).error?.code, -32001);
  release(); await f.bridge.whenDrained(); assert.ok(!f.messages.some(message => message.id === id)); assert.ok(!f.transcript().includes(SECRET));
});

test("MCP EOF closes capability and drains in-flight effects without manufacturing an outcome", async t => {
  const f = setup(t); f.grant("allow"); await f.init(); const [tool] = await f.list();
  let release: () => void = () => {}; let signal: AbortSignal | undefined;
  f.setExecute((_call, abort) => { signal = abort; return new Promise(resolve => { release = () => resolve({ ok: true }); }); });
  f.send({ jsonrpc: "2.0", id: 55, method: "tools/call", params: { name: tool.name, arguments: { callId: "eof", input: clean } } });
  assert.equal(f.store.listActions()[0]?.state, "running");
  f.input.end(); await tick(); assert.equal(f.bridge.isClosed, true); assert.equal(signal?.aborted, true);
  assert.throws(() => f.gateway.listTools(f.token));
  let drained = false; void f.bridge.whenDrained().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
  release(); await f.bridge.whenDrained(); assert.equal(f.store.listActions()[0]?.state, "succeeded"); assert.ok(!f.messages.some(message => message.id === 55));
});

test("MCP rejects oversized frames, invalid UTF-8, unsupported methods, bad IDs and malformed JSON without echo", async t => {
  const f = setup(t, { maxLineBytes: 512 }); await f.init();
  assert.equal((await f.rpc("resources/read", { uri: SECRET })).error?.message, "Method not found");
  f.input.write(`{bad ${SECRET}\n`); f.input.write(Buffer.from([0xff, 0x0a]));
  f.send({ jsonrpc: "2.0", id: { raw: SECRET }, method: "ping" });
  f.send([{ jsonrpc: "2.0", id: 9, method: "ping" }]);
  await tick(); assert.equal(f.messages.filter(message => message.error?.code === -32700).length, 2);
  assert.equal(f.messages.filter(message => message.error?.code === -32600).length, 2); assert.ok(!f.transcript().includes(SECRET));
  f.input.write("x".repeat(513)); assert.equal(f.bridge.isClosed, true); assert.equal(f.messages.at(-1)?.error?.message, "Message too large");
  assert.throws(() => f.gateway.listTools(f.token));
});

test("MCP bounded output shuts down a blocked stream and does not persist credentials in transcripts or SQLite", async t => {
  const f = setup(t, { maxOutputBytes: 1024 }); f.grant("allow"); await f.init();
  // A 1 KiB frame cannot contain the directory plus direct schemas. Rejection is explicit, not pressure.
  assert.equal((await f.rpc("tools/list")).error?.code, -32003);
  const before = f.transcript(); assert.ok(f.output instanceof PassThrough); f.output.pause();
  for (let n = 100; n < 500 && !f.bridge.isClosed; n++) { f.send({ jsonrpc: "2.0", id: n, method: "unsupported" }); await tick(); }
  assert.equal(f.bridge.isClosed, true); assert.ok(f.output.writableLength <= 9 * 1024);
  assert.ok(!before.includes(SECRET)); assert.ok(!before.includes(f.token));
  f.gateway.close(); f.store.close();
  const bytes = readdirSync(f.dir).filter(name => name.startsWith("dexter.sqlite") || name.startsWith("gateway.sqlite")).map(name => readFileSync(join(f.dir, name)).toString("latin1")).join("");
  assert.ok(!bytes.includes(SECRET)); assert.ok(!bytes.includes(f.token));
});

test("MCP standard _meta works on initialized, ping, list and calls without becoming identity", async t => {
  const f = setup(t); f.grant("allow");
  const initialized = await f.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic", version: "1" }, _meta: { progressToken: "init" } });
  assert.equal(initialized.result.protocolVersion, "2025-11-25");
  f.send({ jsonrpc: "2.0", method: "notifications/initialized", params: { _meta: { "claudecode/toolUseId": "synthetic-init" } } });
  assert.deepEqual((await f.rpc("ping", { _meta: { progressToken: 42 } })).result, {});
  const tools = (await f.rpc("tools/list", { _meta: { progressToken: "catalog" } })).result.tools;
  const result = await f.rpc("tools/call", { name: tools[0].name, arguments: { callId: "meta", input: clean }, _meta: {
    progressToken: 99, "claudecode/toolUseId": "synthetic-call", connectionId: f.other.id, ownerId: "other", headers: { authorization: SECRET },
  } });
  assert.equal(result.result.structuredContent.status, "succeeded"); assert.equal(f.calls.length, 1); assert.equal(f.calls[0]?.upstreamAccountRef, "ca_work");
  assert.ok(!f.transcript().includes(SECRET)); assert.ok(!f.transcript().includes("synthetic-call"));
  for (const method of ["ping", "tools/list", "tools/call"]) {
    const params = method === "tools/call" ? { name: tools[0].name, arguments: { callId: "invalid-meta", input: clean }, _meta: "not-object" } : { _meta: "not-object" };
    assert.equal((await f.rpc(method, params)).error?.message, "Invalid params");
  }
  assert.equal(f.calls.length, 1);
});

test("MCP a 600 KiB succeeded result remains replayable through a bounded projection", async t => {
  const f = setup(t); f.grant("allow"); await f.init(); const [tool] = await f.list();
  f.setExecute(async () => ({ data: "x".repeat(600 * 1024) }));
  const first = (await f.call(tool.name, "large")).result;
  assert.equal(first.structuredContent.status, "succeeded"); assert.equal(first.structuredContent.result.truncated,"mcp_result_budget");assert.equal(first.structuredContent.result.consultReceipt,true);assert.ok(first.structuredContent.result.preview.length>1000);assert.ok(first.structuredContent.result.preview.length<600*1024);
  assert.deepEqual(JSON.parse(first.content[0].text), first.structuredContent);
  assert.equal(f.bridge.isClosed, false); assert.equal(f.calls.length, 1);
  const stored = f.store.getAction(first.structuredContent.actionId); assert.equal(stored.state, "succeeded");
  assert.equal((stored.result as { data: string }).data.length, 600 * 1024);
  for (let n = 0; n < 2; n++) {
    const replay = (await f.call(tool.name, "large")).result; assert.deepEqual(replay, first);
    assert.equal(f.bridge.isClosed, false); assert.equal(f.calls.length, 1);
  }
  assert.deepEqual((await f.rpc("ping")).result, {});
  // A useful preview is delivered on each replay; the per-frame wire budget, rather than an
  // unrelated total transcript length, bounds those three identical receipt projections.
  for (const frame of f.transcript().trimEnd().split("\n")) assert.ok(Buffer.byteLength(frame) <= 1024 * 1024);
  assert.equal(f.gateway.listTools(f.token).length, 1);
});

test("MCP account label survives clients ignoring title; aliases fit the native prefixed name and collisions fail closed", async t => {
  const f = setup(t); f.grant("allow"); f.store.setGrant({ botId: f.bot.id, tool: manifest.name, destination: f.other.id, policy: "allow" });
  await f.init(); const tools = await f.list(); assert.equal(tools.length, 2);
  assert.notEqual(tools[0].description, tools[1].description);
  assert.ok(tools.some((tool: any) => tool.description.includes("Account: Work.")));
  assert.ok(tools.some((tool: any) => tool.description.includes("Account: Other.")));
  for (const tool of tools) assert.ok(`mcp__dexter_gateway__${tool.name}`.length <= 64);
  // Simulate a truncated hash collision in the existing host-only map; it must never overwrite a target.
  const map = (f.bridge as unknown as { targets: Map<string, { tool: string; connectionId: string }> }).targets;
  const impostor = { tool: "other.tool", connectionId: f.other.id }; map.set(tools[0].name, impostor);
  const result = await f.rpc("tools/list"); assert.equal(result.error?.message, "Tool alias collision");
  assert.equal(map.get(tools[0].name), impostor); assert.equal(f.calls.length, 0);
});

test("MCP oversized catalog response is distinct from queue pressure and keeps capability alive", async t => {
  const f = setup(t, { maxOutputBytes: 1024 }); f.grant("allow");
  f.gateway.registerTool({ ...manifest, description: "d".repeat(1024) }); await f.init();
  const response = await f.rpc("tools/list"); assert.equal(response.error?.code, -32003); assert.equal(response.error?.message, "Response too large");
  assert.equal(f.bridge.isClosed, false); assert.deepEqual((await f.rpc("ping")).result, {});
  assert.equal(f.gateway.listTools(f.token).length, 1);
  assert.throws(() => new GatewayMcpBridge({ gateway: f.gateway, capability: f.token, input: new PassThrough(), output: new PassThrough(), maxOutputBytes: 16 }), /Invalid MCP limit/);
});

class SlowOutput extends Writable {
  delay = 5;
  hold = false;
  release: (() => void) | undefined;
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const complete = () => { this.emit("data", chunk); callback(); };
    if (this.hold) this.release = complete;
    else setTimeout(complete, this.delay);
  }
}

test("MCP parallel large outcomes survive a 5ms async consumer and replay without new effects", async t => {
  for (const [size, count] of [[400 * 1024, 2], [150 * 1024, 4]]) {
    const output = new SlowOutput(); const f = setup(t, { output });
    f.grant("allow"); await f.init(); const [tool] = await f.list();
    f.setExecute(async () => ({ payload: "z".repeat(size!) }));
    const replies = await Promise.all(Array.from({ length: count! }, (_, n) => f.call(tool.name, `parallel-${n}`)));
    for (const reply of replies) {
      assert.equal(reply.result.structuredContent.status, "succeeded");
      assert.equal(reply.result.structuredContent.result.payload.length, size);
    }
    await f.bridge.whenDrained(); assert.equal(f.bridge.isClosed, false); assert.equal(f.calls.length, count);
    assert.equal(f.gateway.listTools(f.token).length, 1);
    assert.equal((await f.call(tool.name, "parallel-0")).result.structuredContent.status, "succeeded");
    assert.equal(f.calls.length, count); await f.bridge.whenDrained(); assert.equal(f.bridge.isClosed, false);
    const queuedBytes = (f.bridge as unknown as { queuedBytes: number }).queuedBytes; assert.equal(queuedBytes, 0);
  }
});

test("MCP drain includes queued delivery while a successful effect waits for a slow consumer", async t => {
  const output = new SlowOutput(); const f = setup(t, { output, outputStallTimeoutMs: 500 });
  f.grant("allow"); await f.init(); const [tool] = await f.list(); output.hold = true;
  const reply = f.call(tool.name, "delivery"); await tick();
  assert.equal(f.store.listActions()[0]?.state, "succeeded"); assert.equal(f.calls.length, 1);
  let drained = false; void f.bridge.whenDrained().then(() => { drained = true; }); await tick();
  assert.equal(drained, false); assert.equal(f.bridge.isClosed, false);
  output.hold = false; output.release?.();
  assert.equal((await reply).result.structuredContent.status, "succeeded"); await f.bridge.whenDrained();
  assert.equal(drained, true); assert.equal(f.bridge.isClosed, false);
});

test("MCP a truly stalled consumer closes after the stall deadline without retrying completed effects", async t => {
  const output = new SlowOutput(); const f = setup(t, { output, outputStallTimeoutMs: 25 });
  f.grant("allow"); await f.init(); const [tool] = await f.list(); output.hold = true;
  f.send({ jsonrpc: "2.0", id: 80, method: "tools/call", params: { name: tool.name, arguments: { callId: "stalled", input: clean } } });
  await f.bridge.whenDrained();
  assert.equal(f.bridge.isClosed, true); assert.equal(output.destroyed, true); assert.equal(f.calls.length, 1);
  assert.equal(f.store.listActions()[0]?.state, "succeeded"); assert.throws(() => f.gateway.listTools(f.token));
  assert.ok(!f.messages.some(message => message.id === 80));
});

test("MCP duplicate human labels have stable nonsecret connection discriminators", async t => {
  const f = setup(t); f.grant("allow");
  const duplicate = f.gateway.connectAccount({ profileId: "work", toolkit: "slack", label: "Work", upstreamAccountRef: "ca_duplicate", credentialRef: "cred", allowedHosts: [HOST] });
  f.store.setGrant({ botId: f.bot.id, tool: manifest.name, destination: duplicate.id, policy: "allow" });
  await f.init(); const tools = await f.list(); assert.equal(tools.length, 2);
  assert.equal(tools[0].title, tools[1].title); assert.notEqual(tools[0].description, tools[1].description);
  for (const tool of tools) { assert.match(tool.description, /^Account: Work\. Connection: [a-f0-9]{12}\./); assert.ok(!tool.description.includes("ca_")); assert.ok(!tool.description.includes("conn_")); }
  assert.deepEqual((await f.list()).map((tool: any) => tool.description), tools.map((tool: any) => tool.description));
});

test("MCP admission reserves response capacity before dispatching a second parallel burst", async t => {
  const output = new SlowOutput(); output.delay = 20;
  const f = setup(t, { output }); f.grant("allow"); await f.init(); const [tool] = await f.list();
  f.setExecute(async () => ({ payload: "x".repeat(500 * 1024) }));
  const first = Array.from({ length: 8 }, (_, n) => f.call(tool.name, `burst-a-${n}`));
  await new Promise(resolveDone => setTimeout(resolveDone, 5));
  assert.equal(f.calls.length, 8);
  const second = Array.from({ length: 8 }, (_, n) => f.call(tool.name, `burst-b-${n}`));
  const [a, b] = await Promise.all([Promise.all(first), Promise.all(second)]);
  assert.ok(a.every(reply => reply.result?.structuredContent.status === "succeeded"));
  assert.ok(b.every(reply => reply.error?.message === "Response capacity unavailable"));
  assert.equal(f.calls.length, 8); assert.equal(f.bridge.isClosed, false); await f.bridge.whenDrained();
  assert.equal(f.store.listActions().length, 8);
  assert.equal((await f.call(tool.name, "burst-a-0")).result.structuredContent.status, "succeeded"); assert.equal(f.calls.length, 8);
  assert.equal((await f.call(tool.name, "burst-b-0")).result.structuredContent.status, "succeeded"); assert.equal(f.calls.length, 9);
  await f.bridge.whenDrained(); assert.equal(f.bridge.isClosed, false);
  const accounting = f.bridge as unknown as { reservedBytes: number; queuedBytes: number };
  assert.equal(accounting.reservedBytes, 0); assert.equal(accounting.queuedBytes, 0);
});

test('bridge inspect and console formatting never expose its capability or credential broker',async t=>{
 const f=setup(t);await f.init();const diagnostics=[inspect(f.bridge,{depth:20,showHidden:true}),format('%o',f.bridge)].join('\n');assert(!diagnostics.includes(f.token));assert(!diagnostics.includes(SECRET));
});
