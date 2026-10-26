import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { mcpSetupDiagnostic, readMcpSetupDiagnostic, ToolExecutionFailure, type JsonValue } from "@dexter/contracts";
import { HostStore } from "@dexter/hub";
import { CapabilityGateway, checkNativeMcpSchema, nativeMcpSchemaResourceWeight } from "@dexter/gateway";
import { checkMcpDefinition, McpUpstreamSession, NativeMcpRuntime, type McpRuntimeHost } from "@dexter/connectors";

// Deliberately load the same compiled module instances that the real connector/runtime uses.
// Importing a second emitted source copy would hide process-wide cache poisoning.
const nativeSchema = await import(pathToFileURL(resolve("packages/connectors/dist/mcp/schema.js")).href) as typeof import("../packages/connectors/src/mcp/schema.js");
const assertSupportedMcpSchema: typeof import("../packages/connectors/src/mcp/schema.js").assertSupportedMcpSchema = nativeSchema.assertSupportedMcpSchema;
const { validateNativeMcpArguments, validateNativeMcpOutput } = nativeSchema;
const { linearMcpRegExp, mcpPatternCacheStats } = await import(pathToFileURL(resolve("packages/connectors/dist/mcp/linear-regexp.js")).href) as typeof import("../packages/connectors/src/mcp/linear-regexp.js");
const { toolDefinitionHash } = await import(pathToFileURL(resolve("packages/connectors/dist/mcp/session.js")).href) as typeof import("../packages/connectors/src/mcp/session.js");
type Tool = Record<string, unknown> & { name: string };
const emptyInput = { type: "object", properties: {}, additionalProperties: false };
const healthyTool: Tool = { name: "healthy", description: "Look up a synthetic value", inputSchema: { type: "object", properties: { value: { type: "string", pattern: "^[a-z]{1,16}$" } }, required: ["value"], additionalProperties: false }, outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } };
const healthyResult = { content: [{ type: "text", text: "synthetic" }], structuredContent: { ok: true } };
const code = (expected: string, effect?: string) => (error: unknown): boolean => error instanceof Error && (error as Error & { code?: string }).code === expected && (effect === undefined || (error as Error & { effect?: string }).effect === effect);
function definition(id: string, large = false) {
  return checkMcpDefinition({ id, name: id, transport: { type: "streamable_http", url: `https://${id}.example.test/mcp` }, runsOn: "owner_mac", auth: "none", readOnlyTools: ["healthy", "report", "url"], ...(large ? { limits: { maxResultBytes: 16 * 1024 * 1024 } } : {}) });
}
function peers() {
  const servers = new Map<string, { tools: Tool[]; result(name: string): Record<string, unknown> }>();
  const calls: { server: string; name: string; arguments: unknown }[] = [];
  let requests = 0;
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, "POST", "synthetic POST transport only");
    const server = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).hostname.split(".")[0]!;
    const peer = servers.get(server); assert.ok(peer, `no network fallback for ${server}`);
    const message = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name?: string; arguments?: unknown } }; requests++;
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === "server/discover") return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Synthetic legacy peer" } });
    let result: unknown;
    if (message.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: server, version: "1" } };
    else if (message.method === "tools/list") result = { tools: peer.tools };
    else if (message.method === "tools/call") { const name = message.params!.name!; calls.push({ server, name, arguments: message.params!.arguments }); result = peer.result(name); }
    else result = {};
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  }) as typeof globalThis.fetch;
  const host: McpRuntimeHost = { runsOn: "owner_mac", stdioRoot: "/private/tmp/dexter-r6-unused-stdio", fetch, secretValues: () => [] };
  return { host, calls, requests: () => requests, add(id: string, tools: Tool[], result: (name: string) => Record<string, unknown> = () => healthyResult) { servers.set(id, { tools, result }); } };
}
function runtimeLab(t: TestContext, peer: ReturnType<typeof peers>) {
  const dir = mkdtempSync(join(tmpdir(), "dexter-r6-native-"));
  let store!: HostStore, runtime!: NativeMcpRuntime, gateway!: CapabilityGateway, open = false, sequence = 0;
  const reopen = () => { store = new HostStore({ dataDir: dir }); runtime = new NativeMcpRuntime({ host: peer.host }); gateway = new CapabilityGateway({ store, broker: runtime.broker, adapter: runtime.adapter }); runtime.bind(store, gateway); open = true; };
  const close = async () => { if (!open) return; open = false; await runtime.close(); gateway.close(); store.close(); };
  reopen();
  t.after(async () => { await close(); rmSync(dir, { recursive: true, force: true }); });
  const turn = (botId: string) => { const thread = store.createThread(botId); const { turn } = store.createTurn(thread.id, { clientRequestId: `r6-${++sequence}`, content: "Synthetic validation regression" }); store.claimNextTurn(thread.id); return turn; };
  const select = async (id: string, botId: string, toolNames: string[], large = false) => {
    runtime.admin.addServer({ definition: definition(id, large) }); const discovery = await runtime.admin.discover(id);
    assert.equal(discovery.server.status, "ready"); runtime.admin.setBotSelection(id, botId, { toolIds: toolNames.map(name => `mcp.${id}.${name}`), policy: "ask" });
    const connection = gateway.registry.listConnections("work").find(c => c.toolkit === `mcp-${id}`)!; assert.ok(connection);
    for (const name of toolNames) store.setGrant({ botId, tool: `mcp.${id}.${name}`, destination: connection.id, policy: "allow" });
    return connection.id;
  };
  return { dir, reopen, close, turn, select, get store() { return store; }, get runtime() { return runtime; }, get gateway() { return gateway; } };
}

function fanout(depth: number): Record<string, unknown> {
  const $defs: Record<string, unknown> = {};
  for (let i = 0; i < depth; i++) $defs[`L${i}`] = { allOf: [{ $ref: `#/$defs/L${i + 1}` }, { $ref: `#/$defs/L${i + 1}` }] };
  $defs[`L${depth}`] = { type: "string" };
  return { type: "object", properties: { v: { $ref: "#/$defs/L0" } }, required: ["v"], $defs };
}
const enumOptions = Array.from({ length: 256 }, (_, i) => `option${String(i).padStart(3, "0")}_` + "a".repeat(110));
const workSchema = { type: "object", properties: { values: { type: "array", items: { type: "string", enum: enumOptions } } }, required: ["values"], additionalProperties: false };
const expensive = (n: number): Record<string, JsonValue> => ({ values: Array(n).fill(enumOptions.at(-1)!) });
const reportTool = (input = emptyInput, output: Record<string, unknown> = workSchema): Tool => ({ name: "report", description: "Synthetic bounded report", inputSchema: input, outputSchema: output });

test("R6-01: ref fanout30/40/64 and oversized branches are refused before AJV, without altering schemas", () => {
  const timings = [];
  for (const depth of [30, 40, 64]) {
    const schema = fanout(depth), before = JSON.stringify(schema), start = performance.now();
    assert.throws(() => assertSupportedMcpSchema(schema), code("schema_unsupported", "none"));
    assert.throws(() => checkNativeMcpSchema(schema), code("invalid_input"));
    assert.equal(JSON.stringify(schema), before); const ms = performance.now() - start; assert.ok(ms < 200); timings.push({ depth, ms });
  }
  for (const schema of [
    { anyOf: Array.from({ length: 5000 }, (_, i) => ({ const: `v${i}` })) },
    { oneOf: Array.from({ length: 5000 }, (_, i) => ({ const: `v${i}` })) },
    { type: "string", enum: Array.from({ length: 18000 }, (_, i) => `v${i}`) },
    { type: "object", $defs: { unused: { anyOf: Array.from({ length: 5000 }, () => true) } } },
  ]) {
    const start = performance.now(); assert.throws(() => assertSupportedMcpSchema(schema), code("schema_unsupported"));
    assert.throws(() => checkNativeMcpSchema(schema), code("invalid_input")); assert.ok(performance.now() - start < 200);
  }
  console.log(JSON.stringify({ probe: "r6-static-admission", timings }));
});

test("R6-01: untyped/object/ref-only uniqueness refuses at <=1MiB; primitive uniqueness is linear and exact", () => {
  const values = Array.from({ length: 150000 }, (_, i) => i), bytes = Buffer.byteLength(JSON.stringify(values)); assert.ok(bytes < 1024 * 1024);
  for (const schema of [{ type: "array", uniqueItems: true }, { type: "array", items: { type: "object" }, uniqueItems: true }, { type: "array", $defs: { item: { type: "number" } }, items: { $ref: "#/$defs/item" }, uniqueItems: true }]) {
    const start = performance.now(); assert.throws(() => assertSupportedMcpSchema(schema), code("schema_unsupported", "none"));
    assert.throws(() => validateNativeMcpOutput(schema, values), code("output_schema_invalid", "possible")); assert.ok(performance.now() - start < 200);
  }
  const schema = { type: "array", items: { type: ["string", "number", "boolean", "null"] }, uniqueItems: true }, start = performance.now();
  validateNativeMcpOutput(schema, values); const ms = performance.now() - start; assert.ok(ms < 200, `typed unique ${ms}ms`);
  for (const value of [["__proto__"], ["constructor", "prototype"], [0, "0", false, null]]) validateNativeMcpOutput(schema, value);
  for (const value of [["__proto__", "__proto__"], ["constructor", "constructor"], [0, -0], [false, false]]) assert.throws(() => validateNativeMcpOutput(schema, value), code("output_schema_invalid", "possible"));
  console.log(JSON.stringify({ probe: "r6-unique-linear", bytes, ms }));
});

test("R6-01: structural enum work consumes the same real budget, with fixed pre/post-effect diagnostics", () => {
  assertSupportedMcpSchema(workSchema);
  for (const [direction, n, validate, effect] of [["input", 300, validateNativeMcpArguments, "none"], ["output", 5000, validateNativeMcpOutput, "possible"]] as const) {
    const data = expensive(n), bytes = Buffer.byteLength(JSON.stringify(data)); assert.ok(bytes < (direction === "input" ? 65536 : 1024 * 1024));
    const start = performance.now(); assert.throws(() => validate(workSchema, data), error => {
      assert.ok(code("validation_resource_limit", effect)(error)); const e = error as Error & { detail: unknown; phase: string; cause: unknown };
      assert.equal(e.detail, null); assert.equal(e.phase, direction === "input" ? "pre_dispatch" : "validation");
      assert.ok(e.cause instanceof ToolExecutionFailure); assert.equal(e.cause.phase, direction === "input" ? "before_dispatch" : "after_dispatch"); return true;
    }); const ms = performance.now() - start; assert.ok(ms < 200); console.log(JSON.stringify({ probe: "r6-structural-work", direction, bytes, ms }));
    validateNativeMcpArguments({ type: "string", pattern: "^healthy_[a-z]+$" }, "healthy_after");
  }
  assert.deepEqual(mcpSetupDiagnostic("selection", "validation_resource_limit"), { stage: "selection", code: "validation_resource_limit", recovery: "owner_check_server_limits" });
  assert.equal(readMcpSetupDiagnostic({ stage: "selection", code: "validation_resource_limit", recovery: "correct_input" }), null);
});

test("R6-01: schema identity is finite before hash/cache; acyclic pointers and literal JSON const semantics stay exact", () => {
  assertSupportedMcpSchema({ const: null });
  for (const bad of [Infinity, -Infinity, NaN]) for (const schema of [{ const: bad }, { default: bad }, { enum: [bad] }]) {
    assert.throws(() => assertSupportedMcpSchema(schema), code("schema_unsupported")); assert.throws(() => checkNativeMcpSchema(schema), code("invalid_input"));
  }
  const schema = { type: "object", $defs: { "a/b~c": { type: "string", minLength: 1 } }, properties: { a: { $ref: "#/$defs/a~1b~0c" }, b: { $ref: "#/$defs/a~1b~0c" } }, required: ["a", "b"] };
  validateNativeMcpArguments(schema, { a: "a", b: "b" }); assert.throws(() => validateNativeMcpArguments(schema, { a: "", b: "b" }), code("input_schema_invalid"));
  for (const literal of [{ valueOf: 1 }, { toString: "x" }, { constructor: { x: 1 } }, JSON.parse('{"__proto__":{"safe":true},"nested":[1,"a",null]}')]) {
    const s = { const: literal }; validateNativeMcpOutput(s, structuredClone(literal));
    assert.throws(() => validateNativeMcpOutput(s, {}), code("output_schema_invalid"));
  }
  for (const invalid of [{ $defs: { a: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" }, { $defs: { a: { $id: "nested", type: "string" } } }, { $ref: "#/$defs/missing" }, { $defs: { a: true }, $ref: "#/$defs/%61" }, { $anchor: "root" }, { $async: true }, { enum: [{ a: 1 }] }]) assert.throws(() => assertSupportedMcpSchema(invalid), code("schema_unsupported"));
});

test("R6-02: counted optional repeat and accepted language equal ECMAScript-u including cache eviction", () => {
  const patterns = ["^[a-z]{0,4}$", "^[a-z]{1,4}$", "^a{2,4}b$", "^ab{0,4}c$", "^a{0,2}a{0,2}$", "^a?$", "^[A-Za-z0-9_-]{1,250}$", "^.{1,64}$", "^\\S+$", "^\\d{0,30}\\d{0,30}$", "[a-z0-9_.-]+", "^(?:a|b)$", "^a|b$"];
  const words = ["", "a", "b", "c", "aa", "ab", "ba", "abc", "abbc", "aaaa", "aaaaa", "aab", "aaaab", "abab", "ababab", " ", "\n", "é", "😀", "[", "a.ts", "x".repeat(64), "x".repeat(65)];
  let comparisons = 0;
  for (const p of patterns) { const match = linearMcpRegExp(p, "u"), ecma = new RegExp(p, "u"); for (const value of words) { assert.equal(match.test(value), ecma.test(value), `${p} ${JSON.stringify(value)}`); comparisons++; } }
  for (let i = 0; i < 80; i++) validateNativeMcpArguments({ type: "string", pattern: `^r${i}[a-z]{1,8}$` }, `r${i}safe`);
  for (const p of patterns) for (const value of words) { assert.equal(linearMcpRegExp(p, "u").test(value), new RegExp(p, "u").test(value)); comparisons++; }
  assert.ok(mcpPatternCacheStats().live <= 32); console.log(JSON.stringify({ probe: "r6-repeat-differential", comparisons }));
});

test("R6-02: normal10k IDs pass cap64/128/250 patterns, item bounds, input/output and healthy reuse", () => {
  const times = [];
  for (const cap of [64, 128, 250]) {
    const schema = { type: "object", properties: { ids: { type: "array", minItems: 0, maxItems: 10000, items: { type: "string", pattern: `^[A-Za-z0-9_-]{1,${cap}}$` } } }, required: ["ids"], additionalProperties: false };
    const start = performance.now(); validateNativeMcpOutput(schema, { ids: Array.from({ length: 10000 }, (_, i) => `id_${i.toString(36).padStart(6, "0")}_` + "a".repeat(26)) });
    validateNativeMcpArguments(schema, { ids: Array(10000).fill("id1") }); const ms = performance.now() - start; assert.ok(ms < 300); times.push({ cap, ms });
  }
  console.log(JSON.stringify({ probe: "r6-normal10k", times, note: "direct native hooks; gateway argument node limit remains8192" }));
});

test("R6 MRTR bounds: enum64x200,1042 schema positions and mixed32KiB siblings stay admitted without rewriting/hash changes", () => {
  const choices = Array.from({ length: 64 }, (_, i) => `option${String(i).padStart(2, "0")}_` + "a".repeat(191)); assert.equal(choices[0]!.length, 200);
  const enumSchema = { type: "object", properties: { choice: { type: "string", enum: choices } }, required: ["choice"], additionalProperties: true };
  const many = { type: "object", properties: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`f${i}`, { type: "string", oneOf: Array.from({ length: 64 }, (_, j) => ({ const: `v${j}`, title: String(j) })) }])), required: Array.from({ length: 16 }, (_, i) => `f${i}`), additionalProperties: true };
  const mixed = { type: "object", properties: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`f${i}`, i < 4 ? { type: "string", oneOf: Array.from({ length: 64 }, (_, j) => ({ const: `v${j}`, title: String(j) })) } : { type: "string" }])), required: Array.from({ length: 16 }, (_, i) => `f${i}`), additionalProperties: false };
  const cases = [[enumSchema, { choice: choices.at(-1)! }], [many, Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`f${i}`, "v63"]))], [mixed, Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`f${i}`, i < 4 ? "v63" : "a".repeat(2700)]))]] as const;
  for (const [schema, input] of cases) {
    assert.ok(Buffer.byteLength(JSON.stringify(schema)) < 32768); assert.ok(Buffer.byteLength(JSON.stringify(input)) < 32768);
    const original = JSON.stringify(schema), tool: Tool = { name: "report", inputSchema: schema, outputSchema: schema }, hash = toolDefinitionHash(tool);
    assertSupportedMcpSchema(schema); checkNativeMcpSchema(schema); validateNativeMcpArguments(schema, input); validateNativeMcpOutput(schema, input);
    assert.equal(JSON.stringify(schema), original); assert.equal(toolDefinitionHash(tool), hash);
    assert.throws(() => validateNativeMcpArguments(schema, {}), code("input_schema_invalid"));
  }
  console.log(JSON.stringify({ probe: "r6-mrtr-maximal", cases: cases.map(([s, v]) => ({ schemaBytes: Buffer.byteLength(JSON.stringify(s)), inputBytes: Buffer.byteLength(JSON.stringify(v)), weight: nativeMcpSchemaResourceWeight(s) })) }));
});

test("R6 first-party runtime: static attack sibling refuses, bounded output receipt remains uncertain, healthy other/replay/restart/grants survive", async t => {
  const peer = peers(); peer.add("bad", [reportTool(), { ...reportTool(), name: "exponential", outputSchema: fanout(40) }], () => ({ content: [], structuredContent: expensive(5000) })); peer.add("good", [healthyTool]);
  const h = runtimeLab(t, peer), bot = h.store.createBot({ name: "Synthetic R6", profileId: "work", engine: "claude" });
  const badId = await h.select("bad", bot.id, ["report"]), goodId = await h.select("good", bot.id, ["healthy"]), grant = h.store.getGrant(bot.id, "mcp.good.healthy", goodId);
  assert.deepEqual((await h.runtime.admin.discover("bad")).tools.map(tool => [tool.id, tool.state]), [["mcp.bad.report", "publishable"], ["mcp.bad.exponential", "unsupported_schema"]]);
  const token = h.gateway.issueCapability({ turnId: h.turn(bot.id).id }).token, input = { tool: "mcp.bad.report", connectionId: badId, callId: "bounded-hostile-output", arguments: {} };
  const started = performance.now(), failed = await h.gateway.call(token, input), ms = performance.now() - started;
  assert.equal(failed.status, "unknown"); assert.equal(failed.result, null); const result = h.store.getAction(failed.actionId).result as Record<string, JsonValue>;
  assert.equal(result.code, "validation_resource_limit"); assert.equal(result.phase, "after_dispatch"); assert.equal(result.effectDispatched, true); assert.ok(ms < 1000);
  assert.deepEqual(await h.gateway.call(token, input), failed); assert.equal(peer.calls.filter(c => c.server === "bad").length, 1);
  assert.equal((await h.gateway.call(token, { tool: "mcp.good.healthy", connectionId: goodId, callId: "after-attack", arguments: { value: "after" } })).status, "succeeded");
  assert.deepEqual((await h.runtime.admin.discover("bad")).tools.map(tool => [tool.id, tool.state]), [["mcp.bad.report", "publishable"], ["mcp.bad.exponential", "unsupported_schema"]]);
  assert.equal(h.runtime.admin.quarantineStatus("bad"), null); assert.equal(h.runtime.admin.quarantineStatus("good"), null);
  await h.close(); const before = peer.requests(); h.reopen(); assert.equal(peer.requests(), before);
  assert.deepEqual(h.store.getGrant(bot.id, "mcp.good.healthy", goodId), grant); assert.equal(h.gateway.registry.getTool("mcp.good.healthy")!.status, "active"); assert.equal(h.gateway.registry.getTool("mcp.bad.report")!.status, "active");
  const db = new DatabaseSync(join(h.dir, "native-mcp.sqlite"), { readOnly: true }); try { assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'mcp-quarantine:%'").get()!.n), 0); } finally { db.close(); }
  const fresh = h.gateway.issueCapability({ turnId: h.turn(bot.id).id }).token;
  assert.equal((await h.gateway.call(fresh, { tool: "mcp.good.healthy", connectionId: goodId, callId: "after-restart", arguments: { value: "restart" } })).status, "succeeded");
  console.log(JSON.stringify({ probe: "r6-runtime-isolation", ms, calls: peer.calls.length }));
});

test("R6 first-party gateway: input work refusal retains closed diagnostic and no action/effect", async t => {
  const peer = peers(); peer.add("input", [reportTool(workSchema)]); const h = runtimeLab(t, peer), bot = h.store.createBot({ name: "Synthetic R6", profileId: "work", engine: "claude" });
  const connectionId = await h.select("input", bot.id, ["report"]), token = h.gateway.issueCapability({ turnId: h.turn(bot.id).id }).token;
  await assert.rejects(h.gateway.call(token, { tool: "mcp.input.report", connectionId, callId: "no-effect", arguments: expensive(300) }), error => {
    assert.ok(code("invalid_input")(error)); assert.deepEqual((error as Error & { diagnostic: unknown }).diagnostic, mcpSetupDiagnostic("selection", "validation_resource_limit")); return true;
  }); assert.equal(peer.calls.length, 0);
});

test("R6 Stop: due abort is observed after bounded synchronous input validation and before first tools/call", async () => {
  const input = { type: "object", properties: { ids: { type: "array", items: { type: "string", pattern: "^[A-Za-z0-9_-]{1,250}$" } } }, required: ["ids"], additionalProperties: false };
  const peer = peers(); peer.add("stop", [reportTool(input)], () => ({ content: [], structuredContent: expensive(1) })); peer.add("afterstop", [healthyTool]);
  const stopped = await McpUpstreamSession.open(definition("stop"), {}, peer.host), healthy = await McpUpstreamSession.open(definition("afterstop"), {}, peer.host);
  try {
    await stopped.listTools(); await healthy.listTools(); const control = new AbortController(), timer = setTimeout(() => control.abort(), 0);
    await assert.rejects(stopped.callTool("report", { ids: Array(10000).fill("id1") }, control.signal), error => code("aborted", "none")(error) && (error as { phase: string }).phase === "pre_dispatch"); clearTimeout(timer);
    assert.equal(peer.calls.length, 0); await healthy.callTool("healthy", { value: "after" }); assert.equal(peer.calls.length, 1);
  } finally { await stopped.close(); await healthy.close(); }
});
