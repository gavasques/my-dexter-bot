import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { JsonValue } from "@dexter/contracts";
import { HostStore } from "@dexter/hub";
import { CapabilityGateway, prepareMcpTurn } from "@dexter/gateway";
import { ClaudeCliDriver } from "@dexter/engines";
import { checkMcpDefinition, inspectMcpMetadata, McpUpstreamSession, NativeMcpRuntime, type McpRuntimeHost } from "@dexter/connectors";

// Deliberately load the same compiled module instances that the real connector/runtime uses.
// Importing a second emitted source copy would hide process-wide cache poisoning.
const nativeSchema = await import(pathToFileURL(resolve("packages/connectors/dist/mcp/schema.js")).href) as typeof import("../packages/connectors/src/mcp/schema.js");
const assertSupportedMcpSchema: typeof import("../packages/connectors/src/mcp/schema.js").assertSupportedMcpSchema = nativeSchema.assertSupportedMcpSchema;
const { validateNativeMcpArguments, validateNativeMcpOutput } = nativeSchema;
const { checkedMcpPattern, mcpPatternCacheStats } = await import(pathToFileURL(resolve("packages/connectors/dist/mcp/linear-regexp.js")).href) as typeof import("../packages/connectors/src/mcp/linear-regexp.js");
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
  const host: McpRuntimeHost = { runsOn: "owner_mac", stdioRoot: "/private/tmp/dexter-r4-unused-stdio", fetch, secretValues: () => [] };
  return { host, calls, requests: () => requests, add(id: string, tools: Tool[], result: (name: string) => Record<string, unknown> = () => healthyResult) { servers.set(id, { tools, result }); } };
}
function runtimeLab(t: TestContext, peer: ReturnType<typeof peers>) {
  const dir = mkdtempSync(join(tmpdir(), "dexter-r4-native-"));
  let store!: HostStore, runtime!: NativeMcpRuntime, gateway!: CapabilityGateway, open = false, sequence = 0;
  const reopen = () => { store = new HostStore({ dataDir: dir }); runtime = new NativeMcpRuntime({ host: peer.host }); gateway = new CapabilityGateway({ store, broker: runtime.broker, adapter: runtime.adapter }); runtime.bind(store, gateway); open = true; };
  const close = async () => { if (!open) return; open = false; await runtime.close(); gateway.close(); store.close(); };
  reopen();
  t.after(async () => { await close(); rmSync(dir, { recursive: true, force: true }); });
  const turn = (botId: string) => { const thread = store.createThread(botId); const { turn } = store.createTurn(thread.id, { clientRequestId: `r4-${++sequence}`, content: "Synthetic validation regression" }); store.claimNextTurn(thread.id); return turn; };
  const select = async (id: string, botId: string, toolNames: string[], large = false) => {
    runtime.admin.addServer({ definition: definition(id, large) }); const discovery = await runtime.admin.discover(id);
    assert.equal(discovery.server.status, "ready"); runtime.admin.setBotSelection(id, botId, { toolIds: toolNames.map(name => `mcp.${id}.${name}`), policy: "ask" });
    const connection = gateway.registry.listConnections("work").find(c => c.toolkit === `mcp-${id}`)!; assert.ok(connection);
    for (const name of toolNames) store.setGrant({ botId, tool: `mcp.${id}.${name}`, destination: connection.id, policy: "allow" });
    return connection.id;
  };
  return { dir, reopen, close, turn, select, get store() { return store; }, get runtime() { return runtime; }, get gateway() { return gateway; } };
}
let hostile: { schema: Record<string, unknown>; value: Record<string, JsonValue>; result: Record<string, unknown> } | undefined;
function hostileResult() {
  if (hostile) return hostile;
  let seed = 99;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const properties: Record<string, unknown> = {}, value: Record<string, JsonValue> = {};
  // This is the reviewer's accepted 7-pattern / 32,500-value single-result adversary.
  // Each individual string matches; failure must come from one shared top-level work bound.
  for (let digit = 0; digit < 7; digit++) {
    const d = String(digit), branches = Array.from({ length: 15 }, (_, j) => "\\d".repeat(j) + d + "\\d".repeat(14 - j));
    const pattern = `^(?:${branches.join("|")})$`; checkedMcpPattern(pattern);
    properties[`p${digit}`] = { type: "array", items: { type: "string", pattern } };
    value[`p${digit}`] = Array.from({ length: 32_500 }, () => { let item = ""; for (let k = 0; k < 15; k++) item += random() & 1 ? d : "9"; return item.includes(d) ? item : d + item.slice(1); });
  }
  hostile = { schema: { type: "object", properties }, value, result: { content: [{ type: "text", text: "synthetic" }], structuredContent: value } };
  return hostile;
}
const reportTool = (): Tool => ({ name: "report", description: "Synthetic report", inputSchema: emptyInput, outputSchema: hostileResult().schema });

test("R4-01/03: default result bound rejects the original 3.8 MiB attack before schema validators; another server remains usable", async () => {
  const attack = hostileResult(), bytes = Buffer.byteLength(JSON.stringify(attack.result)); assert.ok(bytes > 3_700_000 && bytes < 4 * 1024 * 1024);
  const peer = peers(); peer.add("hostile", [reportTool()], () => attack.result); peer.add("healthy", [healthyTool]);
  const bad = await McpUpstreamSession.open(definition("hostile"), {}, peer.host), good = await McpUpstreamSession.open(definition("healthy"), {}, peer.host);
  try {
    await bad.listTools(); await good.listTools();
    const start = performance.now(); await assert.rejects(bad.callTool("report", {}), code("response_too_large", "possible")); const elapsed = performance.now() - start;
    assert.ok(elapsed < 1500, `raw envelope rejected in ${elapsed} ms`);
    await good.callTool("healthy", { value: "after" });
    assert.deepEqual(peer.calls.map(call => `${call.server}.${call.name}`), ["hostile.report", "healthy.healthy"]);
    console.log(JSON.stringify({ probe: "r4-default-result-first", bytes, elapsed }));
  } finally { await bad.close(); await good.close(); }
});

test("R4-03: discarded upstream fields count toward the full result envelope before normalization", async () => {
  const peer = peers(); peer.add("envelope", [healthyTool], () => ({ ...healthyResult, _meta: { diagnostic: "z".repeat(1024 * 1024) }, requestState: "synthetic-opaque-state" }));
  const session = await McpUpstreamSession.open(definition("envelope"), {}, peer.host);
  try { await session.listTools(); await assert.rejects(session.callTool("healthy", { value: "before" }), code("response_too_large", "possible")); assert.equal(peer.calls.length, 1); }
  finally { await session.close(); }
});

test("R4-01: one accepted large result exhausts only its validation budget; gateway receipt, other server, rediscovery and restart remain sound", async t => {
  const peer = peers(); peer.add("adversary", [reportTool()], () => hostileResult().result); peer.add("benign", [healthyTool]);
  const h = runtimeLab(t, peer), bot = h.store.createBot({ name: "Synthetic", profileId: "work", engine: "claude" });
  const badConnection = await h.select("adversary", bot.id, ["report"], true), goodConnection = await h.select("benign", bot.id, ["healthy"]);
  const grant = h.store.getGrant(bot.id, "mcp.benign.healthy", goodConnection)!;
  const token = h.gateway.issueCapability({ turnId: h.turn(bot.id).id }).token;
  const input = { tool: "mcp.adversary.report", connectionId: badConnection, callId: "one-hostile-result", arguments: {} };
  const start = performance.now(), failed = await h.gateway.call(token, input), elapsed = performance.now() - start;
  assert.equal(failed.status, "unknown"); assert.equal(failed.result, null, "gateway exposes diagnostics through the canonical receipt rather than uncertain payload");
  const failure = h.store.getAction(failed.actionId).result as Record<string, JsonValue>;
  assert.equal(failure.code, "validation_resource_limit"); assert.equal(failure.phase, "after_dispatch"); assert.equal(failure.effectDispatched, true);
  assert.ok(elapsed < 2000, `aggregate validation work bounded in ${elapsed} ms`);
  assert.deepEqual(await h.gateway.call(token, input), failed); assert.equal(peer.calls.filter(call => call.server === "adversary").length, 1, "unknown result replay never redispatches");
  assert.equal((await h.gateway.call(token, { tool: "mcp.benign.healthy", connectionId: goodConnection, callId: "healthy-after", arguments: { value: "after" } })).status, "succeeded");
  for (let i = 0; i < 140; i++) validateNativeMcpArguments({ type: "string", pattern: `^r${i}[a-z]{1,8}$` }, `r${i}safe`);
  assert.ok(mcpPatternCacheStats().live <= 32);
  const rediscovered = await h.runtime.admin.discover("benign"); assert.deepEqual(rediscovered.tools.map(tool => tool.state), ["publishable"]);
  assert.deepEqual(h.store.getGrant(bot.id, "mcp.benign.healthy", goodConnection), grant); assert.equal(h.runtime.admin.quarantineStatus("benign"), null);
  assert.equal(h.gateway.registry.getTool("mcp.benign.healthy")!.status, "active");
  await h.close(); const beforeReopen = peer.requests(); h.reopen(); assert.equal(peer.requests(), beforeReopen, "restart does not secretly rediscover");
  assert.equal(h.gateway.registry.getTool("mcp.benign.healthy")!.status, "active", "healthy persisted publication survives restart before discovery");
  assert.deepEqual(h.runtime.admin.botSelection("benign", bot.id).toolIds, ["mcp.benign.healthy"]); assert.deepEqual(h.store.getGrant(bot.id, "mcp.benign.healthy", goodConnection), grant);
  const db = new DatabaseSync(join(h.dir, "native-mcp.sqlite"), { readOnly: true });
  try { assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'mcp-quarantine:%'").get()!.n), 0); }
  finally { db.close(); }
  const fresh = h.gateway.issueCapability({ turnId: h.turn(bot.id).id }).token;
  assert.equal((await h.gateway.call(fresh, { tool: "mcp.benign.healthy", connectionId: goodConnection, callId: "healthy-after-restart", arguments: { value: "restart" } })).status, "succeeded");
  assert.deepEqual((await h.runtime.admin.discover("benign")).tools.map(tool => tool.state), ["publishable"]);
  console.log(JSON.stringify({ probe: "r4-budget-isolation-restart", elapsed, cache: mcpPatternCacheStats(), upstreamCalls: peer.calls.length }));
});

test("R4-01: aggregate work is shared across matching array items and resets for every top-level validation", () => {
  const attack = hostileResult(); assertSupportedMcpSchema(attack.schema);
  for (let i = 0; i < 2; i++) {
    assert.throws(() => validateNativeMcpOutput(attack.schema, attack.value), code("validation_resource_limit", "possible"));
    validateNativeMcpArguments({ type: "string", pattern: "^healthy_[a-z]{1,12}$" }, "healthy_after");
    validateNativeMcpOutput({ type: "string", pattern: "^healthy_[a-z]{1,12}$" }, "healthy_after");
  }
  assertSupportedMcpSchema(attack.schema); assert.ok(mcpPatternCacheStats().live <= mcpPatternCacheStats().limit);
});

test("R4-01: early-success branches still share the full-string scan budget instead of multiplying uncharged work", () => {
  const schema = { type: "string", allOf: Array.from({ length: 40 }, () => ({ pattern: "^a" })) };
  assertSupportedMcpSchema(schema);
  const value = "a".repeat(256 * 1024), start = performance.now();
  assert.throws(() => validateNativeMcpOutput(schema, value), code("validation_resource_limit", "possible"));
  assert.ok(performance.now() - start < 1000);
  validateNativeMcpOutput({ type: "string", pattern: "^healthy$" }, "healthy");
});

test("R4-03: known URL format validates input/output in under 100 ms at 256 KiB and stays bounded at the transport limit", () => {
  const schema = { type: "string", format: "url" }; assertSupportedMcpSchema(schema);
  const measurements: Record<string, number> = {};
  for (const [direction, validate] of [["input", validateNativeMcpArguments], ["output", validateNativeMcpOutput]] as const) {
    const value = "http://" + ":".repeat(256 * 1024 - 7), start = performance.now();
    assert.throws(() => validate(schema, value), code(direction === "input" ? "input_schema_invalid" : "output_schema_invalid"));
    measurements[direction] = performance.now() - start; assert.ok(measurements[direction]! < 100, `${direction} URL 256 KiB: ${measurements[direction]} ms`);
  }
  const start = performance.now(); assert.throws(() => validateNativeMcpOutput(schema, "http://" + ":".repeat(4 * 1024 * 1024 - 7)), code("output_schema_invalid", "possible")); measurements.transport = performance.now() - start;
  assert.ok(measurements.transport < 1000, `transport-sized URL: ${measurements.transport} ms`);
  for (const valid of ["https://example.test", "HTTP://user:pass@example.test:8080/a?x=1#part", "ftp://example.test/a", "https://8.8.8.8/a", "https://éxample.test/a", "http://u/x@a.com"]) { validateNativeMcpArguments(schema, valid); validateNativeMcpOutput(schema, valid); }
  for (const invalid of ["http://", "mailto:person@example.test", "http://localhost", "http://10.0.0.1/a", "https://-bad.example/a", "https://example.test:9/a", "https://example.test?x=1", "https://example.test/a b", "https://example.test/\n", "http://a--b.com", "http://1.002.003.4"]) { assert.throws(() => validateNativeMcpArguments(schema, invalid), code("input_schema_invalid")); assert.throws(() => validateNativeMcpOutput(schema, invalid), code("output_schema_invalid", "possible")); }
  console.log(JSON.stringify({ probe: "r4-url-linear", measurements }));
});

test("R4-03: session rejects invalid URL input before dispatch, output after dispatch, and then accepts a valid known-format result", async () => {
  const schema = { type: "object", properties: { url: { type: "string", format: "url" } }, required: ["url"], additionalProperties: false };
  let url = "http://" + ":".repeat(64 * 1024);
  const peer = peers(); peer.add("urls", [{ name: "url", description: "Synthetic URL", inputSchema: schema, outputSchema: schema }], () => ({ content: [], structuredContent: { url } }));
  const session = await McpUpstreamSession.open(definition("urls"), {}, peer.host);
  try {
    await session.listTools(); await assert.rejects(session.callTool("url", { url: "not a URL" }), code("input_schema_invalid", "none")); assert.equal(peer.calls.length, 0);
    await assert.rejects(session.callTool("url", { url: "https://example.test/a" }), code("output_schema_invalid", "possible")); assert.equal(peer.calls.length, 1);
    url = "https://example.test/a"; await session.callTool("url", { url }); assert.equal(peer.calls.length, 2);
  } finally { await session.close(); }
});

test("R4-02/07: placeholder and query adversaries at 256 KiB scan under 100 ms; exemptions are finite, case-sensitive, and custody never bypasses", () => {
  const measurements: number[] = [];
  for (const prefix of ["Bearer YOUR_", "https://example.test/?access_token=YOUR_"]) {
    const remaining = 256 * 1024 - prefix.length, value = prefix + "KEY".repeat(Math.floor(remaining / 3)) + "K".repeat(remaining % 3);
    const start = performance.now(), result = inspectMcpMetadata(value), elapsed = performance.now() - start; measurements.push(elapsed);
    assert.equal(result.bytes, 256 * 1024); assert.equal(result.safe, false); assert.equal(result.reason, "credential_material"); assert.ok(elapsed < 100, `placeholder 256 KiB: ${elapsed} ms`);
  }
  for (const value of ["Bearer YOUR_ACCESS_TOKEN_HERE", "sk-xxxxxxxxxxxxxxxxxxxxxxxx", "ghp_XXXXXXXXXXXXXXXXXXXXXXXX", "https://example.test/?access_token=example-token"]) { assert.equal(inspectMcpMetadata(value).safe, true, value); assert.equal(inspectMcpMetadata(value, [value]).safe, false, "known custody secret precedes example handling"); }
  const entropy = "9f8Kq2LmZx7Rt4Vb1Nc6Hs3Jd5Wp0Ye8";
  for (const value of [`Bearer example-${entropy}`, `Bearer YOUR_API_KEY_${entropy}`, `Bearer your_api_key_${entropy}`, `Bearer SYNTHETIC-CREDENTIAL-CANARY-123456789`, `ghp_dummy_${entropy}`, `sk-synthetic-${entropy}`, `sk-proj-YOUR_KEY${entropy}`, `AKIAplaceholder_${entropy}`, `https://example.test/?access_token=example-${entropy}`, "https://example.test/?access_token=EXAMPLE-TOKEN"]) assert.equal(inspectMcpMetadata(value).safe, false, value);
  console.log(JSON.stringify({ probe: "r4-placeholders-linear", measurements }));
});

test("R4-07: credential-shaped example siblings quarantine individually before persistence while the selected healthy tool dispatches", async t => {
  const canary = "Bearer example-9f8Kq2LmZx7Rt4Vb1Nc6Hs3Jd5Wp0Ye8", peer = peers();
  peer.add("mixed", [healthyTool, { ...healthyTool, name: "bad", description: canary }, { ...healthyTool, name: "sample", description: "Bearer YOUR_ACCESS_TOKEN_HERE" }]);
  const h = runtimeLab(t, peer), bot = h.store.createBot({ name: "Synthetic", profileId: "work", engine: "claude" });
  const connectionId = await h.select("mixed", bot.id, ["healthy"]), discovered = await h.runtime.admin.discover("mixed");
  assert.deepEqual(discovered.tools.map(tool => [tool.id, tool.state]).sort(), [["mcp.mixed.bad", "unsupported_schema"], ["mcp.mixed.healthy", "publishable"], ["mcp.mixed.sample", "publishable"]]);
  assert.equal(h.runtime.admin.quarantineStatus("mixed"), null); assert.ok(!JSON.stringify(discovered).includes(canary));
  const token = h.gateway.issueCapability({ turnId: h.turn(bot.id).id }).token;
  assert.equal((await h.gateway.call(token, { tool: "mcp.mixed.healthy", connectionId, callId: "safe-sibling", arguments: { value: "okay" } })).status, "succeeded");
  for (const suffix of ["", "-wal"]) { try { assert.ok(!readFileSync(join(h.dir, `native-mcp.sqlite${suffix}`)).includes(Buffer.from(canary))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
});

test("R4-05: POSIX class spellings refuse and accepted epsilon/assertion/filesystem patterns equal ECMAScript-u", () => {
  for (const pattern of ["^[[:alpha:]x[a]$", "[[:digit:]]", "[[=a=]]", "[[.a.]]", "[^[:alpha:]x[a]", "a|", "|a", "(?:a|b)"]) {
    assert.throws(() => checkedMcpPattern(pattern)); assert.throws(() => assertSupportedMcpSchema({ type: "string", pattern }), code("schema_unsupported"));
  }
  const patterns = ["^a|b$", "^(?:|a)$", "^(?:a|)$", "^(?:a|b)$", "^a?$", "^ab*$", "^(asc|desc)$", "^.{1,64}$", "^\\S+$", "^\\s+$", "[a-z0-9_.-]+", "^[a-z0-9_-]{1,64}$", "^\\d{0,30}\\d{0,30}$", "^\\u{1f600}$", "^[\\[a]$", "^[^abc]+$"];
  const values = ["", "a", "b", "ab", "ba", "a\n", "\nb", "cba", "asc", "desc", "ascending", "[", "a.ts", "/tmp/a.ts", ".", "x".repeat(64), "x".repeat(65), "hello_123", " ", "\u00a0", "\ufeff", "😀", "\ud800", "é", "\u0000"];
  let comparisons = 0;
  for (const pattern of patterns) { const schema = { type: "string", pattern }, ecma = new RegExp(pattern, "u"); assertSupportedMcpSchema(schema);
    for (const value of values) { if (ecma.test(value) && value !== "\ud800") validateNativeMcpArguments(schema, value); else assert.throws(() => validateNativeMcpArguments(schema, value), code("input_schema_invalid"), `${pattern}: ${JSON.stringify(value)}`); comparisons++; }
  }
  const fsSchema = { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, excludePatterns: { type: "array", items: { type: "string" }, default: [] } }, required: ["path", "pattern"], additionalProperties: false, $schema: "http://json-schema.org/draft-07/schema#" };
  const input = { path: "/synthetic", pattern: "*.ts" }; validateNativeMcpArguments(fsSchema, input); assert.deepEqual(input, { path: "/synthetic", pattern: "*.ts" });
  console.log(JSON.stringify({ probe: "r4-ecmascript-differential", comparisons }));
});

test("R4-04: bounded enumNames is annotation only; schema bytes, definition hash and real native input/output contracts are preserved", async () => {
  const schema = { type: "object", properties: { choice: { type: "string", enum: ["a", "b"], enumNames: ["First", "Second"], default: "a" }, count: { type: "integer", default: 3 } }, required: ["choice", "count"], additionalProperties: false };
  const tool: Tool = { name: "healthy", description: "Synthetic annotation", inputSchema: schema, outputSchema: schema }, original = JSON.stringify(tool), hash = toolDefinitionHash(tool), sha = createHash("sha256").update(original).digest("hex");
  assertSupportedMcpSchema(schema); validateNativeMcpArguments(schema, { choice: "a", count: 2 }); validateNativeMcpOutput(schema, { choice: "b", count: 3 });
  for (const input of [{ choice: "First", count: 2 }, { choice: "a", count: "2" }, { choice: "a" }]) assert.throws(() => validateNativeMcpArguments(schema, input), code("input_schema_invalid"));
  const missing: Record<string, unknown> = {}; assert.throws(() => validateNativeMcpArguments(schema, missing), code("input_schema_invalid")); assert.deepEqual(missing, {}, "annotation never applies defaults");
  for (const enumNames of ["First", [1], Array.from({ length: 257 }, () => "label"), ["x".repeat(2049)]]) assert.throws(() => assertSupportedMcpSchema({ type: "string", enum: ["a"], enumNames }), code("schema_unsupported"));
  const peer = peers(); peer.add("annotations", [tool], () => ({ content: [], structuredContent: { choice: "a", count: 4 } }));
  const session = await McpUpstreamSession.open(definition("annotations"), {}, peer.host);
  try { const listed = await session.listTools(); assert.equal(listed[0]!.definitionHash, hash); await session.callTool("healthy", { choice: "a", count: 4 }); }
  finally { await session.close(); }
  assert.equal(JSON.stringify(tool), original); assert.equal(toolDefinitionHash(tool), hash); assert.equal(createHash("sha256").update(JSON.stringify(tool)).digest("hex"), sha);
});

test("R4-01 first-party driver: real Claude driver and MCP turn wrapper carry uncertain attack receipt then a healthy other-server result", { timeout: 15_000, skip: process.platform === "win32" }, async t => {
  const peer = peers(); peer.add("driverbad", [reportTool()], () => hostileResult().result); peer.add("drivergood", [healthyTool]);
  const h = runtimeLab(t, peer), bot = h.store.createBot({ name: "Synthetic driver", profileId: "work", engine: "claude" });
  await h.select("driverbad", bot.id, ["report"], true); await h.select("drivergood", bot.id, ["healthy"]);
  const turn = h.turn(bot.id), lease = await prepareMcpTurn({ store: h.store, gateway: h.gateway, turnId: turn.id, wrapperPath: resolve("packages/cli/dist/mcp-stdio.js") });
  t.after(async () => { lease.stop(); await lease.whenDrained(); });
  const script = join(h.dir, "synthetic-claude.mjs");
  // The fake CLI only replaces the external inference process. The driver, lease, wrapper,
  // gateway, persistent receipts, native connector and schema validators are production code.
  writeFileSync(script, `import { spawn } from 'node:child_process'; import { createInterface } from 'node:readline';
const argv=process.argv.slice(2),send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
if(argv.includes('--version')){console.log('synthetic 2.1.296');process.exit(0)}
if(argv.includes('auth')){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));process.exit(0)}
createInterface({input:process.stdin}).once('line',async()=>{let child;try{
 const config=JSON.parse(argv[argv.indexOf('--mcp-config')+1]),server=config.mcpServers.dexter_gateway;
 child=spawn(server.command,server.args,{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin'}});child.stderr.resume();let seq=0;const waits=new Map();
 createInterface({input:child.stdout}).on('line',line=>{const msg=JSON.parse(line);if(waits.has(msg.id)){waits.get(msg.id)(msg);waits.delete(msg.id)}});
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>reject(Error('synthetic RPC deadline')),5000);waits.set(id,msg=>{clearTimeout(timer);msg.error?reject(Error(JSON.stringify(msg.error))):resolve(msg.result)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\\n')});
 await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'synthetic-claude',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\\n');
 const sid=argv[argv.indexOf('--session-id')+1];send({type:'system',subtype:'init',session_id:sid,mcp_servers:[{name:'dexter_gateway',status:'connected'}]});
 const listed=await rpc('tools/list');if(!listed.tools.some(t=>t.name==='dx_catalog_search'))throw Error('first-party directory absent');
 for(const [query,callId,input] of [['mcp.driverbad.report','driver-hostile',{}],['mcp.drivergood.healthy','driver-healthy',{value:'after'}]]){
  const found=(await rpc('tools/call',{name:'dx_catalog_search',arguments:{query,limit:1}})).structuredContent.tools[0];if(!found)throw Error('scoped tool absent');
  const result=await rpc('tools/call',{name:'dx_catalog_call',arguments:{alias:found.alias,callId,input}});send({type:'user',session_id:sid,message:{role:'user',content:[{type:'tool_result',tool_use_id:callId,content:JSON.stringify(result.structuredContent)}]}});
 }
 child.stdin.end();await new Promise(resolve=>child.once('close',resolve));send({type:'result',subtype:'success',result:'Synthetic regression completed',usage:{}});
}catch(error){child?.kill('SIGTERM');send({type:'result',subtype:'error_during_execution',is_error:true,errors:[String(error)]})}});
`, { mode: 0o600 });
  const driver = new ClaudeCliDriver({ command: process.execPath, prefixArgs: [script], localMcpServer: lease.nativeServer, allowedMcpTools: lease.allowedMcpTools, requestTimeoutMs: 8000, killGraceMs: 50 });
  let session: Awaited<ReturnType<ClaudeCliDriver["open"]>> | undefined;
  const events = [];
  try { session = await driver.open(turn.threadId); for await (const event of driver.turn(session, turn.id, "Synthetic native validation", new AbortController().signal)) events.push(event); }
  finally { if (session) await driver.close(session); lease.stop(); await lease.whenDrained(); }
  assert.equal(events.at(-1)?.type, "turn.completed", JSON.stringify(events));
  const observed = events.filter(event => event.type === "tool.result.observed"); assert.deepEqual(observed.map(event => event.status), ["unknown", "succeeded"]);
  const failed = h.store.getAction(observed[0]!.actionId); assert.equal((failed.result as Record<string, JsonValue>).code, "validation_resource_limit"); assert.equal((failed.result as Record<string, JsonValue>).phase, "after_dispatch");
  assert.deepEqual(peer.calls.map(call => `${call.server}.${call.name}`), ["driverbad.report", "drivergood.healthy"]);
  assert.equal(h.store.getAction(observed[1]!.actionId).state, "succeeded");
});


test("R4 follow-up: all four declared dialects preserve HTTPS draft07 schema identity/hash and enforce native validation", async () => {
  const dialects = ["http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft-07/schema#", "https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2020-12/schema#"];
  for (const [index, dialect] of dialects.entries()) {
    const schema = { $schema: dialect, type: "object", properties: { name: { type: "string", pattern: "^[a-z]{1,16}$" }, choice: { type: "string", enum: ["a", "b"], enumNames: ["First", "Second"] } }, required: ["name", "choice"], additionalProperties: false };
    const tool: Tool = { name: "healthy", description: "Synthetic declared dialect", inputSchema: schema, outputSchema: schema };
    const bytes = JSON.stringify(schema), original = JSON.stringify(tool), hash = toolDefinitionHash(tool), sha = createHash("sha256").update(original).digest("hex");
    assertSupportedMcpSchema(schema);
    validateNativeMcpArguments(schema, { name: "healthy", choice: "a" });
    validateNativeMcpOutput(schema, { name: "healthy", choice: "b" });
    for (const invalid of [{ name: "UPPER", choice: "a" }, { name: 7, choice: "a" }, { name: "healthy", choice: "First" }, { name: "healthy", choice: "a", extra: true }, { name: "healthy" }]) {
      assert.throws(() => validateNativeMcpArguments(schema, invalid), code("input_schema_invalid", "none"));
      assert.throws(() => validateNativeMcpOutput(schema, invalid), code("output_schema_invalid", "possible"));
    }
    for (const invalidSchema of [{ ...schema, type: 42 }, { ...schema, properties: { name: { type: "not-a-type" } } }, { ...schema, unknownValidationKeyword: true }, { ...schema, properties: { name: { type: "string", pattern: "^(a+)+$" } } }]) assert.throws(() => assertSupportedMcpSchema(invalidSchema), code("schema_unsupported"));
    const peer = peers(), id = `dialect${index}`;
    peer.add(id, [tool], () => ({ content: [], structuredContent: { name: "healthy", choice: "b" } }));
    const session = await McpUpstreamSession.open(definition(id), {}, peer.host);
    try {
      const listed = await session.listTools(); assert.equal(listed[0]!.definitionHash, hash);
      assert.deepEqual(listed[0]!.inputSchema, schema); assert.deepEqual(listed[0]!.outputSchema, schema);
      await session.callTool("healthy", { name: "healthy", choice: "a" }); assert.equal(peer.calls.length, 1);
      await assert.rejects(session.callTool("healthy", { name: "UPPER", choice: "a" }), code("input_schema_invalid", "none")); assert.equal(peer.calls.length, 1);
    } finally { await session.close(); }
    assert.equal(JSON.stringify(schema), bytes); assert.equal(JSON.stringify(tool), original);
    assert.equal(toolDefinitionHash(tool), hash); assert.equal(createHash("sha256").update(JSON.stringify(tool)).digest("hex"), sha);
  }
  for (const dialect of ["https://json-schema.org/draft-07/schema", "http://json-schema.org/draft-07/schema", "https://json-schema.org/draft-07/schema#unknown", "https://json-schema.org/draft-06/schema#", "http://json-schema.org/draft/2020-12/schema", "https://unsupported.example.test/schema"]) assert.throws(() => assertSupportedMcpSchema({ $schema: dialect, type: "string" }), code("schema_unsupported"));
  console.log(JSON.stringify({ probe: "r4-four-dialect-identity", dialects: dialects.length }));
});
