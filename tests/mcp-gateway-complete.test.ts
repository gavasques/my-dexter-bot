import { deflateSync } from "node:zlib";
import { validatePng } from "@dexter/hub";
import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { Client, type Transport, type JSONRPCMessage } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { GatewayMcpBridge, GatewayError, MCP_MODERN_VERSION, MCP_DIRECTORY_ALIASES, gatewayToolAlias, estimateCatalogTokens, directoryToolDefinitions, planCatalogExposure, searchCatalog, projectMcpOutcome,
  encodeMcpHeaderValue, decodeMcpHeaderValue, buildModernMcpHeaders, validateModernMcpHeaders, mcpHeaderAnnotations, McpProtocolError, McpMrtrVault, classifyMcpEraProbe,
  skillConnectionEligibility, projectCatalogTool, type TurnToolSurface, type ToolView, type GatewayCallResult, type GatewayMcpOptions, type MrtrBinding } from "@dexter/gateway";

const view = (n: number, account = "Account A"): ToolView => ({ name: `native.${n}.read`, description: `Read synthetic document ${n}`, effect: "read", inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 8192 } }, required: [], additionalProperties: false }, connectionId: `connection_${n}`, connectionLabel: account, requiresApproval: false });
const receipt: GatewayCallResult = { actionId: "act_synthetic", requestHash: "a".repeat(64), status: "succeeded", reason: null, result: { ok: true } };
const meta = { "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION, "io.modelcontextprotocol/clientInfo": { name: "synthetic", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
function fixture(t: { after(fn: () => void | Promise<void>): void }, options: Partial<GatewayMcpOptions> = {}) {
  const input = new PassThrough(), output = new PassThrough(); let views: ToolView[] = [view(1)], active = true, calls = 0, result: GatewayCallResult = receipt;
  const requests: unknown[] = [], messages: any[] = []; let tail = "", seq = 0;
  const surface: TurnToolSurface = {
    issueCapability: () => ({ token: "host-memory-only", scope: { installationId: "host", ownerId: "owner", profileId: "profile", botId: "bot", threadId: "thread", turnId: "turn", expiresAt: Date.now() + 60_000 } }),
    listTools: () => { if (!active) throw new GatewayError("unauthorized", "revoked"); return views; }, revokeCapability: () => { active = false; },
    call: async (_token, raw) => { requests.push(raw); const target = raw as {tool:string;connectionId:string}; if (!views.some(v => v.name === target.tool && v.connectionId === target.connectionId)) throw new GatewayError("forbidden", "revoked"); calls++; return result; },
  };
  const bridge = new GatewayMcpBridge({ gateway: surface, capability: "host-memory-only", input, output, ...options });
  const pending = new Map<number, { resolve(value: any): void; timer: ReturnType<typeof setTimeout> }>();
  output.on("data", chunk => { tail += chunk.toString(); while (tail.includes("\n")) { const end = tail.indexOf("\n"), message = JSON.parse(tail.slice(0, end)); tail = tail.slice(end + 1); messages.push(message); const waiter = pending.get(message.id); if (waiter) { clearTimeout(waiter.timer); pending.delete(message.id); waiter.resolve(message); } } });
  const send = (message: unknown) => input.write(JSON.stringify(message) + "\n");
  const rpc = (method: string, params: Record<string, unknown> = {}, modern = true): Promise<any> => { const id = ++seq; return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("synthetic response deadline")), 3000); pending.set(id, { resolve, timer }); send({ jsonrpc: "2.0", id, method, params: modern ? { ...params, _meta: meta } : params }); }); };
  const transport: Transport = { start: async () => {}, send: async message => { send(message); }, close: async () => { bridge.close(); transport.onclose?.(); } };
  output.on("data", chunk => { for (const line of chunk.toString().trim().split("\n")) if (line) transport.onmessage?.(JSON.parse(line) as JSONRPCMessage); });
  t.after(async () => { bridge.close(); await bridge.whenDrained(); for (const waiter of pending.values()) clearTimeout(waiter.timer); });
  return { bridge, rpc, send, transport, messages, requests, calls: () => calls, setViews: (next: ToolView[]) => { views = next; }, setResult: (next: GatewayCallResult) => { result = next; }, revoke: () => { active = false; } };
}

test("stable opaque aliases preserve all account bindings and direct exposure uses tokens, not tool count", () => {
  const views = Array.from({ length: 30 }, (_, n) => view(n)); const reordered = [...views].reverse();
  const a = planCatalogExposure(views, { tokenBudget: 1800, maxTools: 128, pinnedAliases: [gatewayToolAlias(view(4))] });
  const b = planCatalogExposure(reordered, { tokenBudget: 1800, maxTools: 128, pinnedAliases: [gatewayToolAlias(view(4))] });
  assert.deepEqual(a, b); assert.equal(a.directory, true); assert.equal(a.direct.length + a.deferred.length, 30); assert(a.deferred.length > 0);
  assert.notEqual(gatewayToolAlias(view(1)), gatewayToolAlias({ ...view(1), connectionId: "another_account" }));
  const huge = { ...view(100), description: "long ".repeat(5000) }; assert.equal(planCatalogExposure([huge], { tokenBudget: 1800 }).deferred.length, 1);
  assert.throws(() => planCatalogExposure([], { tokenBudget: 256 }), /directory exceeds/); assert.throws(() => planCatalogExposure([], { maxTools: 1 }), /Invalid catalog/);
});

test("directory search/describe/call uses CURRENT bot grants and one exact dispatch envelope", async t => {
  const f = fixture(t, { catalogTokenBudget: 1500 }); const views = Array.from({ length: 50 }, (_, n) => view(n)); f.setViews(views);
  const listed = (await f.rpc("tools/list")).result.tools; assert(listed.length > 3); assert.deepEqual(listed.filter((x:any)=>MCP_DIRECTORY_ALIASES.includes(x.name)).map((x: any) => x.name), [...MCP_DIRECTORY_ALIASES]); assert(estimateCatalogTokens(listed)<=1500);
  const found = (await f.rpc("tools/call", { name: "dx_catalog_search", arguments: { query: "native.12", limit: 1 } })).result.structuredContent.tools[0];
  assert.equal(found.alias, gatewayToolAlias(view(12))); assert.equal(f.calls(), 0);
  const described = (await f.rpc("tools/call", { name: "dx_catalog_describe", arguments: { alias: found.alias } })).result.structuredContent;
  assert.deepEqual(described.inputSchema.properties.input, view(12).inputSchema); assert.equal(f.calls(), 0);
  const called = await f.rpc("tools/call", { name: "dx_catalog_call", arguments: { alias: found.alias, callId: "one-logical-call", input: { text: "synthetic" } } });
  assert.equal(called.result.structuredContent.actionId, receipt.actionId); assert.deepEqual(f.requests[0], { tool: view(12).name, connectionId: view(12).connectionId, callId: "one-logical-call", arguments: { text: "synthetic" } });
  f.setViews([view(40)]); assert.equal((await f.rpc("tools/call", { name: "dx_catalog_call", arguments: { alias: found.alias, callId: "new", input: {} } })).error.code, -32602); assert.equal(f.calls(), 1);
  assert.equal(searchCatalog([view(40)], "native.12").length, 0);
  assert.equal((await f.rpc("tools/call", { name: "dx_catalog_call", arguments: { alias: gatewayToolAlias(view(40)), callId: "new", input: {}, accountId: "other" } })).error.code, -32602);
});

for (const mode of ["legacy", "auto", "pin"] as const) test(`actual MCP SDK 2.3.1 ${mode} connects and calls the bridge without credentials or network`, async t => {
  const f = fixture(t); const client = new Client({ name: "actual-sdk-synthetic", version: "1" }, { capabilities: {}, ...(mode === "legacy" ? {} : { versionNegotiation: { mode: mode === "auto" ? "auto" as const : { pin: MCP_MODERN_VERSION } } }) });
  t.after(() => client.close()); await client.connect(f.transport);
  const listed = await client.listTools(); assert.equal(listed.tools.length, 4);
  const called = await client.callTool({ name: gatewayToolAlias(view(1)), arguments: { callId: "sdk-call", input: {} } });
  assert.equal(called.isError, false); assert.equal((called.structuredContent as any).actionId, receipt.actionId); assert.equal(f.calls(), 1);
});

test("modern discovery/version/metadata refuses invalid requests before any effect and never switches legacy", async t => {
  const f = fixture(t); const discovery = (await f.rpc("server/discover")).result;
  assert.equal(discovery.resultType, "complete"); assert.deepEqual(discovery.supportedVersions, [MCP_MODERN_VERSION, "2025-11-25"]); assert.equal(discovery.cacheScope, "private"); assert.equal(discovery.ttlMs, 0);
  const unsupported = await f.rpc("tools/list", { _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } });
  // rpc's standard metadata intentionally wins over a caller-provided _meta; exercise the malformed wire directly.
  f.send({ jsonrpc: "2.0", id: 555, method: "tools/list", params: { _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.messages.find(m => m.id === 555).error.code, -32022); assert.equal(f.calls(), 0); assert(unsupported.result);
  f.send({ jsonrpc: "2.0", id: 556, method: "tools/call", params: { name: gatewayToolAlias(view(1)), arguments: { callId: "invalid", input: {} }, _meta: { "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION } } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.messages.find(m => m.id === 556).error.code, -32602); assert.equal(f.calls(), 0);
  assert.equal(classifyMcpEraProbe("server/discover", { error: { code: -32022 } }), "modern"); assert.equal(classifyMcpEraProbe("server/discover", { error: { code: -32601 } }), "legacy"); assert.equal(classifyMcpEraProbe("tools/call", { error: { code: -32601 } }), "refuse");
});

test("modern subscriptions acknowledge ID before filtered notifications and cancellation retains no authority", async t => {
  const f = fixture(t); f.send({ jsonrpc: "2.0", id: "sub:1", method: "subscriptions/listen", params: { _meta: meta, notifications: { toolsListChanged: true, promptsListChanged: true } } });
  await new Promise(resolve => setTimeout(resolve, 20)); const ack = f.messages.find(m => m.method === "notifications/subscriptions/acknowledged");
  assert.deepEqual(ack.params.notifications, { toolsListChanged: true }); assert.equal(ack.params._meta["io.modelcontextprotocol/subscriptionId"], "sub:1");
  f.setViews([view(2)]);
  const deadline = Date.now() + 2000;
  while (!f.messages.some(m => m.method === "notifications/tools/list_changed") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  const notice = f.messages.find(m => m.method === "notifications/tools/list_changed"); assert(notice, "bounded metadata notification arrives within the 1s polling interval plus scheduling margin"); assert.equal(notice.params._meta["io.modelcontextprotocol/subscriptionId"], "sub:1");
  f.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "sub:1" } }); await f.bridge.whenDrained(); assert.equal(f.calls(), 0);
});

test("tool semantic failure is preserved at top level while canonical transport receipt stays unchanged", async () => {
  for (const payload of [{ isError: true, content: [{ type: "text", text: "business failure" }] }, { commandOutcome: "failed" }]) {
    const original = { ...receipt, result: payload }; const projected = await projectMcpOutcome(original, { maxBytes: 8192, maxTokens: 8192, maxBlocks: 4 });
    assert.equal(projected.isError, true); assert.deepEqual(projected.structuredContent, original); assert.equal(projected.structuredContent.status, "succeeded");
  }
});

test("wire semantic isError and post-admission exceptions preserve the real receipt instead of announcing a refusal", async t => {
  const f = fixture(t); const original = { ...receipt, result: { isError: true, content: [{ type: "text", text: "synthetic semantic error" }] } }; f.setResult(original);
  const reply = await f.rpc("tools/call", { name: gatewayToolAlias(view(1)), arguments: { callId: "semantic", input: {} } }); assert.equal(reply.result.isError, true); assert.deepEqual(reply.result.structuredContent, original);
  const after = fixture(t, { settleApproval: async () => { throw new Error("raw synthetic upstream data must not leak"); } });
  const failed = (await after.rpc("tools/call", { name: gatewayToolAlias(view(1)), arguments: { callId: "lost-receipt-ack", input: {} } })).result;
  assert.equal(failed.isError, true); assert.equal(failed.structuredContent.outcome, "unknown_after_admission"); assert.equal(failed.structuredContent.actionId, receipt.actionId); assert.equal(failed.structuredContent.requestHash, receipt.requestHash); assert.equal(failed.structuredContent.consultReceipt, true); assert(!JSON.stringify(failed).includes("raw synthetic"));
});

test("bounded multimodal/resource output persists sanitized overflow only through receipt-owned artifact sink", async () => {
  const original = { ...receipt, result: { content: [{ type: "image", mimeType: "image/png", data: "synthetic-base64" }, { type: "resource_link", uri: "https://never-fetch.example.test/private", name: "data only" }], structuredContent: { table: [1, 2] } } };
  const full = await projectMcpOutcome(original, { maxBytes: 8192, maxTokens: 8192, maxBlocks: 5 }); assert.equal(full.content.length, 2); assert(JSON.stringify(full.content).includes("https://never-fetch.example.test/private"),"resource link remains a textual reference"); assert.equal(full.structuredContent.actionId,original.actionId); assert(!JSON.stringify(full.structuredContent).includes("synthetic-base64")); assert(!JSON.stringify(full.content.filter((x:any)=>x.type==="text")).includes("synthetic-base64"));
  let stored: unknown; const small = await projectMcpOutcome({ ...original, result: { data: "x".repeat(6000), isError: true } }, { maxBytes: 1024, maxTokens: 300, maxBlocks: 1 }, async input => { stored = input; return { artifactId: "artifact_receipt_bound" }; });
  assert.equal((stored as any).actionId, receipt.actionId); assert.equal((stored as any).requestHash, receipt.requestHash); assert.equal(small.isError, true); assert.equal(small.structuredContent.status, "succeeded"); assert.equal((small.structuredContent.result as any).artifact.artifactId, "artifact_receipt_bound");
});

test("overflow sink scope is copied from trusted host configuration, never provider payload or MCP input", async t => {
  const scope = { installationId:"trusted-host-8ac1",ownerId:"trusted-owner-8ac1",profileId:"trusted-profile-8ac1",botId:"trusted-bot-8ac1",threadId:"trusted-thread-8ac1",turnId:"trusted-turn-8ac1",expiresAt:Date.now()+60_000 };
  const originalScope={...scope};let captured:any;
  const options:Partial<GatewayMcpOptions>={artifactScope:scope,maxOutputBytes:4096,maxOutputTokens:500,artifactSink:async input=>{captured=input;return {artifactId:"synthetic-read-overflow"};}};
  const f=fixture(t,options);
  scope.botId="mutated-host-option";options.artifactSink=async()=>{throw Error("mutated sink must not run");};
  const original={...receipt,actionId:`harness-read-${receipt.requestHash.slice(0,24)}`,result:{originScope:{botId:"provider-selected-bot"},data:"synthetic ".repeat(6000)}};
  f.setResult(original);
  const envelope={name:gatewayToolAlias(view(1)),arguments:{callId:"read-overflow",input:{}}};
  const projected=(await f.rpc("tools/call",envelope)).result;
  assert.equal(projected.isError,false);assert.equal(projected.structuredContent.actionId,original.actionId);
  assert.equal(projected.structuredContent.requestHash,original.requestHash);assert.equal(projected.structuredContent.result.artifact.artifactId,"synthetic-read-overflow");
  assert.deepEqual(captured.originScope,originalScope);assert(Object.isFrozen(captured.originScope));
  assert.deepEqual(captured.content,original.result);assert.equal(captured.actionId,original.actionId);
  assert(!JSON.stringify(projected).includes(originalScope.turnId),"trusted origin scope must never enter wire output");
  const refused=await f.rpc("tools/call",{...envelope,arguments:{...envelope.arguments,originScope:originalScope}});
  assert.equal(refused.error.code,-32602);assert.equal(f.calls(),1);
  assert.throws(()=>fixture(t,{artifactScope:{...originalScope,capability:"forged"} as never}),/Invalid MCP artifact scope/);
});

test("HTTP header/body mirror supports UTF8/sentinel and rejects divergences or reserved annotations", () => {
  const schema = { type: "object", properties: { greeting: { type: "string", "x-mcp-header": "Greeting" }, region: { type: "object", properties: { index: { type: "integer", "x-mcp-header": "Index" } } } } };
  const request = { method: "tools/call", params: { _meta: meta, name: "天气", arguments: { greeting: "=?base64?literal?=", region: { index: 42 } } } };
  const headers = buildModernMcpHeaders(request, schema); assert.equal(decodeMcpHeaderValue(headers["Mcp-Name"]!), "天气"); assert.equal(decodeMcpHeaderValue(headers["Mcp-Param-Greeting"]!), "=?base64?literal?="); validateModernMcpHeaders(request, headers, schema);
  for (const v of ["Hello, 世界", " padded ", "line1\nline2", "=?base64?literal?=", "safe"]) assert.equal(decodeMcpHeaderValue(encodeMcpHeaderValue(v)), v);
  assert.throws(() => validateModernMcpHeaders(request, { ...headers, "Mcp-Name": "wrong" }, schema), (e: unknown) => e instanceof McpProtocolError && e.code === -32020);
  for (const invalid of [{ type: "string", "x-mcp-header": "Authorization" }, { type: "number", "x-mcp-header": "Number" }, { type: "string", "x-mcp-header": "Bad\nName" }]) assert.throws(() => mcpHeaderAnnotations({ type: "object", properties: { field: invalid } }));
  assert.throws(() => mcpHeaderAnnotations({ oneOf: [{ type: "object", properties: { field: { type: "string", "x-mcp-header": "Nested" } } }] }));
  assert.throws(() => decodeMcpHeaderValue("=?base64?%%%?=")); assert.throws(() => decodeMcpHeaderValue("raw\nheader"));
});

test("private MRTR vault binds principal/action/account/hash/pin, new RPC ID, TTL, revocation and single use", () => {
  let now = 1000; const vault = new McpMrtrVault(() => now, 100, 2);
  const binding: MrtrBinding = { principal: "host:owner:profile:bot:thread", connectionId: "connection", logicalCallId: "act:call", method: "tools/call", requestHash: "a".repeat(64), pin: "revision:1" };
  const state = "opaque upstream bytes==without parsing"; const handle = vault.issue(binding, state, 1);
  assert(!handle.includes(state)); assert.throws(() => vault.consume(handle, { ...binding, principal: "another" }, 2, () => true)); assert.throws(() => vault.consume(handle, { ...binding, pin: "revision:2" }, 2, () => true));
  assert.throws(() => vault.consume(handle, binding, 1, () => true)); assert.throws(() => vault.consume(handle, binding, 2, () => false));
  const consumed = vault.consume(handle, binding, 2, () => true); assert.deepEqual(consumed, { requestState: state, rounds: 1 }); assert.throws(() => vault.consume(handle, binding, 3, () => true));
  assert.throws(() => vault.consume(handle.slice(0, -1) + (handle.endsWith("A") ? "B" : "A"), binding, 3, () => true));
  const expiring = vault.issue(binding, state, 10); now += 101; assert.throws(() => vault.consume(expiring, binding, 11, () => true));
  const stopped = vault.issue(binding, state, 20); vault.revoke(); assert.throws(() => vault.consume(stopped, binding, 21, () => true)); assert.throws(() => vault.issue(binding, state, 30, 2));
});

test("skill dependencies show missing access while operational guidance remains available", () => {
  assert.deepEqual(skillConnectionEligibility([view(1).name, "missing"], [view(1)]), { eligible: false, missingTools: ["missing"], guidanceAvailable: true });
});

test("embedded local refs retain the original schema root and exact upstream metadata without narrowing", () => {
  const original = { type: "object", $defs: { label: { type: "string", minLength: 2 } }, properties: { label: { $ref: "#/$defs/label" } }, required: ["label"], additionalProperties: true };
  const tool = projectCatalogTool({ ...view(1), inputSchema: original }) as any;
  assert.deepEqual(tool._meta["com.dexter.mcp/originalInputSchema"], original); assert.equal((original as any).$id, undefined);
  const validator = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
  for (const input of [{ label: "ok", extra: 1 }, { label: "a" }, { label: 3 }, {}]) {
    const expected = typeof (input as any).label === "string" && (input as any).label.length >= 2;
    assert.equal(validator({ callId: "one", input }).valid, expected);
  }
});


test("OR07 ten schemas just over budget retain nine direct tools with exact combined token accounting",()=>{
 const views=Array.from({length:10},(_,n)=>view(n)),full=[...directoryToolDefinitions(),...views.map(projectCatalogTool)];
 const budget=estimateCatalogTokens(full)-1,plan=planCatalogExposure(views,{tokenBudget:budget,pinnedToolNames:[views[9]!.name]});
 assert.equal(plan.direct.length,9);assert.equal(plan.deferred.length,1);assert(plan.direct.some(v=>v.name===views[9]!.name));
 assert.equal(plan.estimatedTokens,estimateCatalogTokens([...directoryToolDefinitions(),...plan.direct.map(projectCatalogTool)]));
 assert(plan.estimatedTokens<=budget);assert.deepEqual(plan,planCatalogExposure([...views].reverse(),{tokenBudget:budget,pinnedToolNames:[views[9]!.name]}));
});

test("OR06 50KiB text returns a bounded preview and receipt-bound recoverable original without an effect retry",async()=>{
 const original={...receipt,result:{data:"synthetic-data ".repeat(4000)}},stored:unknown[]=[];
 const projected=await projectMcpOutcome(original,{maxBytes:1024*1024,maxTokens:8000,maxBlocks:8},async input=>{stored.push(input);return {artifactId:"acl-original",sha256:"b".repeat(64)};});
 const result=projected.structuredContent.result as any;assert.equal(result.truncated,"mcp_result_budget");assert(result.preview.includes("synthetic-data"));assert(result.preview.length>1000&&result.preview.length<JSON.stringify(original.result).length);
 assert.equal(projected.structuredContent.actionId,original.actionId);assert.equal(projected.structuredContent.requestHash,original.requestHash);assert.equal(projected.structuredContent.status,original.status);assert.equal(result.artifact.artifactId,"acl-original");
 assert.deepEqual((stored[0] as any).content,original.result);assert.equal(stored.length,1);assert.equal(projected.isError,false);assert(Buffer.byteLength((projected.content[0] as any).text)<=24000);
 assert.deepEqual(JSON.parse((projected.content[0] as any).text),projected.structuredContent);
});

test("OR06 200KiB image is one rich block, never base64 in text/receipt, and unsupported drivers get no binary",async()=>{
 const crc=(bytes:Buffer)=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;};
 const chunk=(name:string,data:Buffer)=>{const body=Buffer.concat([Buffer.from(name),data]),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc(body));return Buffer.concat([size,body,sum]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
 const begin=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(Buffer.from([0,10,20,30,255])))]),end=chunk("IEND",Buffer.alloc(0));
 const text=Buffer.alloc(200*1024-begin.length-end.length-12,65);text[0]=120;text[1]=0;
 const png=Buffer.concat([begin,chunk("tEXt",text),end]);assert.equal(png.length,200*1024);assert.equal(validatePng(png).width,1);
 const binary=png.toString("base64"),image={type:"image",mimeType:"image/png",data:binary};
 const original={...receipt,result:{content:[image]}};
 for(const multimodal of [true,false]){
  const projected=await projectMcpOutcome(original,{maxBytes:1024*1024,maxTokens:8000,maxBlocks:8,multimodal},async()=>({artifactId:"image-acl"}));
  assert.equal(projected.content.filter((b:any)=>b.type==="image").length,multimodal?1:0);
  assert(!JSON.stringify(projected.content.filter((b:any)=>b.type==="text")).includes(binary));assert(!JSON.stringify(projected.structuredContent).includes(binary));
  assert.equal(projected.content.filter((b:any)=>b.data===binary).length,multimodal?1:0);
  if(multimodal)assert.deepEqual(projected.content[1],image);else assert(!JSON.stringify(projected).includes(binary));
  assert.equal(projected.structuredContent.requestHash,receipt.requestHash);assert.equal(projected.structuredContent.status,"succeeded");
 }
});
