import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HostStore } from "@dexter/hub";
import { CapabilityGateway, SyntheticCredentialBroker } from "@dexter/gateway";
import {
  McpConnectorError, McpServerInventory, McpToolAdapter, McpToolCatalog, checkMcpDefinition, mcpConnectInput, mcpLogicalHost,
  previewClaudeMcpJson, previewCodexToml, probeMcpServer, validateNativeMcpArguments, type McpRuntimeHost, type McpServerDefinition,
} from "@dexter/connectors";

// Synthetic values only. No real account, key, config file, CLI or network beyond 127.0.0.1.
const SECRET = "synthetic-mcp-token-5f1e2d9c";
const HTTP_SECRET = "synthetic-mcp-bearer-77ab31";
const CANARY = ["canary-literal-env-91x", "ghp_canaryTOKEN0123456789abcdefABCDEF", "canary-header-value-4kq", "canary-query-zz8", "canary-userinfo-pw1"];
const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-fake-stdio-server.js", import.meta.url));
type Ctx = { after: (fn: () => void | Promise<void>) => void };

const noLeak = (value: unknown, needles: readonly string[] = CANARY): void => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const needle of needles) assert.ok(!text.includes(needle), "secret-like input leaked into the output");
};
const code = (expected: string) => (e: unknown) => e instanceof McpConnectorError && e.code === expected;
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (cond: () => boolean, ms = 3000): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (cond()) return true;
  return cond();
};

// ---- import preview ------------------------------------------------------------------------------

test("mcp import: Claude mcpServers preview keeps origin/name/transport, turns every value into a secret slot, never returns values", () => {
  const text = JSON.stringify({
    oauthAccount: { emailAddress: "someone@example.test" }, // other top-level content is ignored unread
    mcpServers: {
      "GitHub Tools": { command: "npx", args: ["-y", "@example/github-mcp"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", PLAIN: CANARY[0] } },
      leaky: { command: "/usr/local/bin/srv", args: ["--api-key", CANARY[1]] },
      remote: { type: "http", url: "https://mcp.example.test/v1/mcp", headers: { Authorization: "Bearer ${API_TOKEN}", "X-Static": CANARY[2] } },
      queried: { type: "http", url: `https://user:${CANARY[4]}@mcp.example.test/mcp?key=${CANARY[3]}` },
      legacy: { type: "sse", url: "https://sse.example.test/sse" },
      helper: { type: "http", url: "https://h.example.test/mcp", headersHelper: "/usr/local/bin/print-token" },
      oauthy: { type: "http", url: "https://o.example.test/mcp", oauth: { clientId: "client-x" } },
      broken: "nope",
      spaced: { command: "/Applications/Dexter Local.app/Contents/Helpers/dexter-node", args: ["/opt/tools/server.mjs"] },
      shellLine: { command: "npx --yes server" },
    },
  });
  const preview = previewClaudeMcpJson(text);
  noLeak(preview);
  noLeak(preview, ["someone@example.test", "client-x"]);
  const by = Object.fromEntries(preview.servers.map((s) => [s.sourceName, s]));

  const gh = by["GitHub Tools"]!;
  assert.equal(gh.transport, "stdio");
  assert.equal(gh.status, "needs_credentials");
  assert.equal(gh.proposedId, "github-tools");
  assert.deepEqual(gh.credentialSlots.map((s) => [s.name, s.from]), [["GITHUB_TOKEN", "env_reference"], ["PLAIN", "literal_value"]]);
  assert.ok(gh.notes.includes("bare_command_resolves_only_in_searchPath"));
  assert.ok(gh.draft, "a draft is built");
  assert.equal(gh.draft!.runsOn, "owner_mac", "a local server stays on the Mac");
  assert.equal(gh.draft!.auth, "broker");
  assert.deepEqual(gh.draft!.source, { format: "claude_json", name: "GitHub Tools" });
  assert.deepEqual(Object.values((gh.draft!.transport as { env: object }).env).map((v) => (v as { kind: string }).kind), ["secret", "secret"]);

  assert.equal(by.leaky!.status, "needs_review");
  assert.deepEqual(by.leaky!.redactedArgs, [1]);
  assert.equal(by.leaky!.draft, null);

  const remote = by.remote!;
  assert.equal(remote.transport, "streamable_http");
  assert.equal(remote.endpoint, "https://mcp.example.test/v1/mcp");
  assert.deepEqual(remote.draft!.transport, {
    type: "streamable_http", url: "https://mcp.example.test/v1/mcp",
    headers: { authorization: { kind: "secret", key: "header.authorization", prefix: "Bearer " }, "x-static": { kind: "secret", key: "header.x-static" } },
  });
  assert.equal(remote.draft!.runsOn, "any");

  assert.equal(by.queried!.status, "needs_review");
  assert.equal(by.queried!.endpoint, "https://mcp.example.test/mcp");
  assert.equal(by.legacy!.status, "unsupported");
  assert.equal(by.helper!.status, "needs_review");
  assert.ok(by.helper!.notes.includes("headers_helper_is_a_command_not_executed"));
  assert.equal(by.oauthy!.status, "needs_auth");
  assert.equal(by.oauthy!.draft!.auth, "oauth");
  assert.equal(by.broken!.status, "invalid");
  assert.equal(by.spaced!.status, "ready_for_review");
  assert.equal((by.spaced!.draft!.transport as { command: string }).command, "/Applications/Dexter Local.app/Contents/Helpers/dexter-node");
  assert.equal(by.shellLine!.status, "needs_review");
  assert.equal(by.shellLine!.draft, null);
});

test("mcp import: Codex mcp_servers TOML preview (stdio env/env_vars, http bearer and headers, filters, timeouts)", () => {
  const toml = `
model = "o4" # unrelated settings are parsed and ignored
[profiles.fast]
model = "x"

[mcp_servers.docs]
command = "/opt/tools/docs-mcp"
args = ["--stdio"]
env = { DOCS_KEY = "${CANARY[0]}" }
env_vars = ["DOCS_ORG"]
enabled_tools = ["search", "fetch"]
startup_timeout_sec = 20
tool_timeout_sec = 90.5

[mcp_servers.remote]
url = "https://mcp.example.test/mcp"
bearer_token_env_var = "REMOTE_TOKEN"
http_headers = { "X-Team" = "${CANARY[2]}" }
enabled = false

[mcp_servers.weird]
url = "https://a.example.test/mcp"
command = "x"
`;
  const preview = previewCodexToml(toml);
  noLeak(preview);
  const [docs, remote, weird] = preview.servers;
  assert.equal(docs!.sourceName, "docs");
  assert.equal(docs!.status, "needs_credentials");
  assert.deepEqual(docs!.credentialSlots.map((s) => [s.name, s.from]), [["DOCS_KEY", "literal_value"], ["DOCS_ORG", "forwarded_env"]]);
  assert.deepEqual(docs!.draft!.enabledTools, ["search", "fetch"]);
  assert.equal(docs!.draft!.limits.connectTimeoutMs, 20_000);
  assert.equal(docs!.draft!.limits.callTimeoutMs, 90_500);
  assert.equal(docs!.draft!.source.format, "codex_toml");
  assert.equal(remote!.enabled, false);
  assert.deepEqual((remote!.draft!.transport as { headers: object }).headers, {
    "x-team": { kind: "secret", key: "header.x-team" }, authorization: { kind: "secret", key: "header.authorization", prefix: "Bearer " },
  });
  assert.equal(weird!.status, "invalid");
});

test("mcp import: invalid or incompatible content fails with fixed, secret-free messages", () => {
  const bad: [() => unknown, string][] = [
    [() => previewClaudeMcpJson(`{"mcpServers": {"a": {"env": {"K": "${CANARY[0]}"}}`), "import_invalid"],
    [() => previewClaudeMcpJson(`[1,2]`), "import_invalid"],
    [() => previewClaudeMcpJson(`{"servers": {}}`), "import_unsupported"],
    [() => previewCodexToml(`[mcp_servers.a]\ncommand = "${CANARY[1]}\n`), "import_invalid"],
    [() => previewCodexToml(`model = "x"\n`), "import_unsupported"],
  ];
  for (const [fn, expected] of bad) {
    assert.throws(fn, (e: unknown) => {
      assert.ok(e instanceof McpConnectorError && e.code === expected, `expected ${expected}`);
      noLeak(e.message);
      return true;
    });
  }
});

test("mcp definition: destination pinned and environment closed", () => {
  const base = { id: "srv", name: "Srv", runsOn: "any", auth: "none", transport: { type: "streamable_http", url: "https://mcp.example.test/mcp" } };
  assert.equal(checkMcpDefinition(base).transport.type, "streamable_http");
  const refused: unknown[] = [
    { ...base, transport: { type: "streamable_http", url: "http://mcp.example.test/mcp" } }, // plain http off loopback
    { ...base, transport: { type: "streamable_http", url: "https://mcp.example.test/mcp?key=v" } },
    { ...base, transport: { type: "streamable_http", url: "https://u:p@mcp.example.test/mcp" } },
    { ...base, transport: { type: "streamable_http", url: "https://mcp.example.test/mcp", headers: { "mcp-session-id": { kind: "literal", value: "x" } } } },
    { ...base, runsOn: "any", transport: { type: "stdio", command: "/bin/echo" } }, // a local process is never "anywhere"
    { ...base, runsOn: "owner_mac", transport: { type: "stdio", command: "/bin/echo", env: { HOME: { kind: "literal", value: "/Users/x" } } } },
    { ...base, runsOn: "owner_mac", transport: { type: "stdio", command: "/bin/echo", env: { DYLD_INSERT_LIBRARIES: { kind: "literal", value: "x" } } } },
    { ...base, runsOn: "owner_mac", transport: { type: "stdio", command: "sh -c x" } },
    { ...base, auth: "none", transport: { type: "streamable_http", url: "https://mcp.example.test/mcp", headers: { authorization: { kind: "secret", key: "k" } } } },
    { ...base, auth: "oauth", runsOn: "owner_mac", transport: { type: "stdio", command: "/bin/echo" } },
  ];
  for (const d of refused) assert.throws(() => checkMcpDefinition(d), code("invalid_definition"));
  assert.equal(checkMcpDefinition({ ...base, transport: { type: "streamable_http", url: "http://127.0.0.1:9/mcp" } }).transport.type, "streamable_http");
});

// ---- stdio end to end through the gateway ---------------------------------------------------------

function hub(t: Ctx) {
  const dir = mkdtempSync(join(tmpdir(), "dexter-mcp-"));
  const stdioRoot = join(dir, "mcp-stdio");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new HostStore({ dataDir: join(dir, "host") });
  const bot = store.createBot({ name: "Ops", profileId: "work", engine: "claude" });
  const sibling = store.createBot({ name: "Ops 2", profileId: "work", engine: "codex" });
  let n = 0;
  const cap = (gateway: CapabilityGateway, botId: string): string => {
    const thread = store.createThread(botId);
    const { turn } = store.createTurn(thread.id, { clientRequestId: `req-${++n}`, content: "go" });
    store.claimNextTurn(thread.id);
    return gateway.issueCapability({ turnId: turn.id }).token;
  };
  return { dir, stdioRoot, store, bot, sibling, cap };
}

function stdioDefinition(over: Record<string, unknown> = {}): McpServerDefinition {
  return checkMcpDefinition({
    id: "fake-stdio", name: "Fake stdio", runsOn: "owner_mac", auth: "broker",
    transport: { type: "stdio", command: process.execPath, args: [FIXTURE, "--grandchild"], env: { API_TOKEN: { kind: "secret", key: "env.api_token" } } },
    readOnlyTools: [], limits: { callTimeoutMs: 800, connectTimeoutMs: 10_000, maxResultBytes: 100_000 }, ...over,
  });
}

test("mcp stdio: probe, plan, register, grant, call through the gateway; clean env, scrubbed secret, pinned definition, cleanup", async (t) => {
  const h = hub(t);
  process.env.DEXTER_PARENT_CANARY = "parent-only";
  t.after(() => { delete process.env.DEXTER_PARENT_CANARY; });
  const def = stdioDefinition();
  const mac: McpRuntimeHost = { runsOn: "owner_mac", stdioRoot: h.stdioRoot };
  const credential = { "env.api_token": SECRET };

  const probe = await probeMcpServer(def, credential, mac);
  assert.equal(probe.state, "ready");
  if (probe.state !== "ready") return;
  const plan = Object.fromEntries(probe.tools.map((p) => [p.mcpName, p]));
  assert.equal(plan.echo_text!.status, "publishable");
  assert.equal(plan.echo_text!.manifest!.name, "mcp.fake-stdio.echo_text");
  assert.deepEqual(plan.echo_text!.argumentNames, { text: "text", pageSize: "pageSize" });
  assert.equal(plan.claims_read_only!.manifest!.effect, "write", "upstream readOnlyHint never relaxes the effect");
  assert.deepEqual(plan.claims_read_only!.upstreamHints, { readOnlyHint: true, destructiveHint: false });
  assert.equal(plan.run_shell!.status, "refused_by_policy");
  assert.equal(plan.nested!.status, "publishable", "native validator preserves supported original nested JSON Schema");
  // Probe closed its child: the grandchild of the probe's process group is gone too.
  const probeGrandchild = Number(readFileSync(join(h.stdioRoot, def.id, "grandchild.pid"), "utf8"));
  assert.ok(await until(() => !alive(probeGrandchild)), "probe left a grandchild running");

  const catalog = new McpToolCatalog(def.id, probe.tools);
  const adapter = new McpToolAdapter({ servers: new McpServerInventory([def]), catalog, host: mac });
  const broker = new SyntheticCredentialBroker();
  const gateway = new CapabilityGateway({ store: h.store, broker, adapter });
  gateway.setNativeMcpArgumentValidator(validateNativeMcpArguments);
  t.after(async () => { await adapter.close(); gateway.close(); h.store.close(); });
  for (const p of probe.tools) if (p.manifest) gateway.registerTool(p.manifest);
  broker.put("cred-fake", { headers: credential, allowedHosts: [mcpLogicalHost(def.id)] });
  const conn = gateway.connectAccount(mcpConnectInput(def, { profileId: "work", label: "Fake", credentialRef: "cred-fake" }));

  // Inventory + connection grant nothing.
  const token = h.cap(gateway, h.bot.id);
  assert.deepEqual(gateway.listTools(token), []);
  await assert.rejects(gateway.call(token, { tool: "mcp.fake-stdio.echo_text", connectionId: conn.id, callId: "c0", arguments: { text: "hi" } }));

  h.store.setGrant({ botId: h.bot.id, tool: "mcp.fake-stdio.echo_text", destination: conn.id, policy: "allow" });
  h.store.setGrant({ botId: h.bot.id, tool: "mcp.fake-stdio.claims_read_only", destination: conn.id, policy: "ask" });
  h.store.setGrant({ botId: h.bot.id, tool: "mcp.fake-stdio.slow", destination: conn.id, policy: "allow" });
  h.store.setGrant({ botId: h.bot.id, tool: "mcp.fake-stdio.big", destination: conn.id, policy: "allow" });
  const token2 = h.cap(gateway, h.bot.id);
  assert.deepEqual(gateway.listTools(token2).map((v) => [v.name, v.requiresApproval]).sort(), [
    ["mcp.fake-stdio.big", false], ["mcp.fake-stdio.claims_read_only", true], ["mcp.fake-stdio.echo_text", false], ["mcp.fake-stdio.slow", false],
  ]);

  const result = await gateway.call(token2, { tool: "mcp.fake-stdio.echo_text", connectionId: conn.id, callId: "c1", arguments: { text: "hi", pageSize: 3 } });
  assert.equal(result.status, "succeeded");
  const out = result.result as { isError: boolean; content: { text: string }[]; structuredContent: Record<string, unknown> };
  assert.equal(out.isError, false);
  assert.equal(out.content[0]!.text, "echo:hi");
  assert.equal(out.structuredContent.pageSize, 3, "original upstream argument identity is preserved");
  assert.notEqual(out.structuredContent.token, null, "secret reached the child environment");
  noLeak(result, [SECRET]);
  // macOS itself adds __CF_USER_TEXT_ENCODING to every process; nothing else comes from the host process.
  const envNames = (out.structuredContent.envNames as string[]).filter((n) => n !== "__CF_USER_TEXT_ENCODING");
  assert.deepEqual(envNames, ["API_TOKEN", "HOME", "PATH", "TMPDIR"], "nothing inherited from the host process");
  assert.equal(out.structuredContent.home, join(h.stdioRoot, def.id));
  const calls = (): { call?: string; list?: boolean; cancelled?: unknown; argumentNames?: string[] }[] =>
    readFileSync(join(h.stdioRoot, def.id, "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(calls().filter((c) => c.call).map((c) => [c.call, c.argumentNames]), [["echo_text", ["pageSize", "text"]]]);

  // Approval policy is the hub's: an "ask" tool waits, whatever the server claims about itself.
  const asked = await gateway.call(token2, { tool: "mcp.fake-stdio.claims_read_only", connectionId: conn.id, callId: "c2", arguments: {} });
  assert.equal(asked.status, "awaiting_approval");
  assert.ok(!calls().some((c) => c.call === "claims_read_only"));

  // A sibling bot with no grant is refused by the gateway before the adapter.
  await assert.rejects(gateway.call(h.cap(gateway, h.sibling.id), { tool: "mcp.fake-stdio.echo_text", connectionId: conn.id, callId: "c3", arguments: { text: "x" } }));

  // Timeout: bounded, cancellation sent upstream, recorded as unknown (never retried).
  const slow = await gateway.call(token2, { tool: "mcp.fake-stdio.slow", connectionId: conn.id, callId: "c4", arguments: {} });
  assert.equal(slow.status, "unknown");
  assert.ok(await until(() => calls().some((c) => c.cancelled !== undefined)), "cancellation reached the server");

  // Output bound.
  const big = await gateway.call(token2, { tool: "mcp.fake-stdio.big", connectionId: conn.id, callId: "c5", arguments: {} });
  assert.equal(big.status, "unknown");

  // Rug pull: the published definition changes after review; the adapter refuses before calling.
  writeFileSync(join(h.stdioRoot, def.id, "rugpull"), "1");
  const before = calls().filter((c) => c.call === "echo_text").length;
  const pulled = await gateway.call(token2, { tool: "mcp.fake-stdio.echo_text", connectionId: conn.id, callId: "c6", arguments: { text: "again" } });
  assert.equal(pulled.status, "unknown");
  assert.equal(calls().filter((c) => c.call === "echo_text").length, before, "changed tool was never called");
  rmSync(join(h.stdioRoot, def.id, "rugpull"));

  // Close terminates the server and its process group.
  const pidFile = join(h.stdioRoot, def.id, "grandchild.pid");
  const grandchild = Number(readFileSync(pidFile, "utf8"));
  assert.ok(alive(grandchild));
  await adapter.close();
  assert.equal(adapter.openSessions, 0);
  assert.ok(await until(() => !alive(grandchild)), "grandchild survived close");
});

test("mcp stdio: a Mac-local server is never started on the cloud host, and a missing secret refuses without spawning", async (t) => {
  const h = hub(t);
  const def = stdioDefinition();
  const cloud: McpRuntimeHost = { runsOn: "cloud", stdioRoot: h.stdioRoot };
  assert.deepEqual(await probeMcpServer(def, { "env.api_token": SECRET }, cloud), { state: "unavailable_here" });
  assert.deepEqual(await probeMcpServer(def, {}, { runsOn: "owner_mac", stdioRoot: h.stdioRoot }), { state: "failed", code: "credential_missing" });
  assert.ok(!existsSync(join(h.stdioRoot, def.id, "calls.log")), "nothing was spawned");
});

// ---- Streamable HTTP over loopback ----------------------------------------------------------------

interface Seen { path: string; auth: string | null; method: string }
async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void, t: Ctx): Promise<{ server: Server; port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); });
    req.on("end", () => { seen.push({ path: req.url ?? "", auth: req.headers.authorization ?? null, method: req.method ?? "" }); handler(req, res, body); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { server, port: (server.address() as AddressInfo).port, seen };
}
function fakeHttpMcp(other: number) {
  return (req: IncomingMessage, res: ServerResponse, body: string): void => {
    if (req.url === "/redirect") { res.writeHead(307, { location: `http://127.0.0.1:${other}/mcp` }).end(); return; }
    if (req.headers.authorization !== `Bearer ${HTTP_SECRET}`) { res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="x"' }).end(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const msg = JSON.parse(body) as { id?: number; method: string; params?: Record<string, unknown> };
    if (msg.id === undefined) { res.writeHead(202).end(); return; }
    const reply = (result: unknown): void => { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })); };
    if (msg.method === "initialize") reply({ protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-http", version: "1" } });
    else if (msg.method === "tools/list") reply({ tools: [{ name: "lookup", description: "Look up", inputSchema: { type: "object", properties: { q: { type: "string", maxLength: 50 } }, required: ["q"] } }] });
    else if (msg.method === "tools/call") reply({ content: [{ type: "text", text: `found:${String((msg.params?.arguments as { q?: string }).q)} auth=${String(req.headers.authorization)}` }] });
    else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } }));
  };
}
const httpDefinition = (port: number, path = "/mcp", over: Record<string, unknown> = {}): McpServerDefinition => checkMcpDefinition({
  id: "fake-http", name: "Fake HTTP", runsOn: "any", auth: "broker",
  transport: { type: "streamable_http", url: `http://127.0.0.1:${port}${path}`, headers: { authorization: { kind: "secret", key: "header.authorization", prefix: "Bearer " } } },
  ...over,
});

test("mcp http: loopback Streamable HTTP through the gateway; pinned origin, no redirect, needs_auth without fallback", async (t) => {
  const h = hub(t);
  const elsewhere = await listen((_req, res) => { res.writeHead(200, { "content-type": "application/json" }).end("{}"); }, t);
  const upstream = await listen(fakeHttpMcp(elsewhere.port), t);
  const host: McpRuntimeHost = { runsOn: "owner_mac", stdioRoot: h.stdioRoot };
  const def = httpDefinition(upstream.port);
  const credential = { "header.authorization": HTTP_SECRET };

  const probe = await probeMcpServer(def, credential, host);
  assert.equal(probe.state, "ready");
  if (probe.state !== "ready") return;
  const adapter = new McpToolAdapter({ servers: new McpServerInventory([def]), catalog: new McpToolCatalog(def.id, probe.tools), host });
  const broker = new SyntheticCredentialBroker();
  const gateway = new CapabilityGateway({ store: h.store, broker, adapter });
  gateway.setNativeMcpArgumentValidator(validateNativeMcpArguments);
  t.after(async () => { await adapter.close(); gateway.close(); h.store.close(); });
  gateway.registerTool(probe.tools[0]!.manifest!);
  broker.put("cred-http", { headers: credential, allowedHosts: [mcpLogicalHost(def.id)] });
  const conn = gateway.connectAccount(mcpConnectInput(def, { profileId: "work", label: "HTTP", credentialRef: "cred-http" }));
  h.store.setGrant({ botId: h.bot.id, tool: "mcp.fake-http.lookup", destination: conn.id, policy: "allow" });
  const r = await gateway.call(h.cap(gateway, h.bot.id), { tool: "mcp.fake-http.lookup", connectionId: conn.id, callId: "h1", arguments: { q: "abc" } });
  assert.equal(r.status, "succeeded");
  assert.match(JSON.stringify(r.result), /found:abc/);
  noLeak(r, [HTTP_SECRET]);
  assert.ok(upstream.seen.every((s) => s.path === "/mcp" || s.path === "/redirect"));

  // Wrong credential: needs_auth, and nothing else is tried.
  const before = upstream.seen.length;
  assert.deepEqual(await probeMcpServer(def, { "header.authorization": "wrong" }, host), { state: "needs_auth" });
  assert.equal(upstream.seen.length - before, 1, "one request, no retry, no OAuth discovery");
  // OAuth-declared server: needs_auth before any request.
  const n = upstream.seen.length;
  assert.deepEqual(await probeMcpServer(httpDefinition(upstream.port, "/mcp", { auth: "oauth", transport: { type: "streamable_http", url: `http://127.0.0.1:${upstream.port}/mcp` } }), {}, host), { state: "needs_auth" });
  assert.equal(upstream.seen.length, n);
  // Redirect to another origin: refused; the credential never reaches the other server.
  const redirected = await probeMcpServer(httpDefinition(upstream.port, "/redirect"), credential, host);
  assert.equal(redirected.state, "failed");
  assert.equal(elsewhere.seen.length, 0);
});
