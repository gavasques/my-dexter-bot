import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostStore } from "@dexter/hub";
import { CapabilityGateway, GatewayError, type AdapterCall, type InjectedAuth } from "@dexter/gateway";
import {
  COMPOSIO_ORIGIN, ComposioAdminClient, ComposioBotDirectory, ComposioSessionAdapter, ComposioSessionDirectory, ComposioToolAdapter,
  ConnectorError, OnePasswordBroker,
  composioUserId, type ComposioBotSession, type ComposioSessionSource, type FetchLike, type SecretReader,
} from "@dexter/connectors";

// Synthetic values only. No real account, key, session or network.
const SECRET = "synthetic-composio-project-key-91c4e7";
const OP_REF = "op://Dexter Test/composio/api-key";
const HOST = "backend.composio.dev";
const SESSION_ID = "trs_synthetic_bot1";
const ACCOUNT = "ca_synthetic_work";
const V = "20260901_00";
const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ data, error: null, successful: true, ...extra });

type Ctx = { after: (fn: () => void) => void };
const SEND = {
  name: "slack.send_message", toolkit: "slack", upstreamSlug: "SLACK_SEND_MESSAGE", version: "20260901_00",
  description: "Post a message", upstreamHost: HOST, effect: "write", destinationArgument: "channel", destinationOrigins: null,
  inputSchema: {
    type: "object", additionalProperties: false, required: ["channel", "text"],
    properties: { channel: { type: "string", maxLength: 32, enum: ["C-general"] }, text: { type: "string", maxLength: 200, minLength: 1 } },
  },
} as const;

interface Sent { url: string; init: RequestInit; body: unknown }
type Reply = (sent: Sent) => Response | Promise<Response>;
function fakeFetch(reply: Reply): { fetch: FetchLike; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (url, init) => {
    const entry = { url, init, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
    sent.push(entry);
    return reply(entry);
  };
  return { fetch, sent };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const hangUntilAbort: Reply = (sent) => new Promise((_, reject) => {
  sent.init.signal!.addEventListener("abort", () => reject(new Error(`aborted while holding ${SECRET}`)), { once: true });
});

class MemoryReader implements SecretReader {
  reads: string[] = [];
  value = SECRET;
  async read(ref: string): Promise<string> { this.reads.push(ref); return this.value; }
}
/** Late-bound trusted source: the session map is built after the gateway assigns connection ids. */
class Holder implements ComposioSessionSource {
  dir = new ComposioSessionDirectory([]);
  find(scope: AdapterCall["scope"], connectionId: string) { return this.dir.find(scope, connectionId); }
}

function setup(t: Ctx, reply: Reply) {
  const dir = mkdtempSync(join(tmpdir(), "dexter-connectors-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new HostStore({ dataDir: dir });
  let clock = 1_000_000;
  const reader = new MemoryReader();
  const broker = new OnePasswordBroker({
    reader, ttlMs: 60_000, now: () => clock,
    bindings: [{ credentialRef: "cred-composio", opRef: OP_REF, header: "x-api-key", allowedHosts: [HOST] }],
  });
  const { fetch, sent } = fakeFetch(reply);
  const sessions = new Holder();
  const adapter = new ComposioSessionAdapter({ sessions, fetch, limits: { timeoutMs: 200 } });
  const gateway = new CapabilityGateway({ store, broker, adapter });
  t.after(() => { gateway.close(); store.close(); });
  gateway.registerTool(SEND);
  const bot = store.createBot({ name: "Ops", profileId: "work", engine: "claude" });
  const sibling = store.createBot({ name: "Ops 2", profileId: "work", engine: "codex" });
  const conn = gateway.connectAccount({
    profileId: "work", toolkit: "slack", label: "Work Slack", upstreamAccountRef: ACCOUNT, credentialRef: "cred-composio", allowedHosts: [HOST],
  });
  const entry = (over: Partial<ComposioBotSession> = {}): ComposioBotSession => ({
    installationId: store.hostId, ownerId: store.ownerId, profileId: "work", botId: bot.id, connectionId: conn.id, toolkit: "slack",
    upstreamUserId: composioUserId(store.hostId, store.ownerId, "work"), connectedAccountId: ACCOUNT, sessionId: SESSION_ID,
    tools: [{ slug: "SLACK_SEND_MESSAGE", version: SEND.version }], ...over,
  });
  sessions.dir = new ComposioSessionDirectory([entry()]);
  for (const b of [bot, sibling]) store.setGrant({ botId: b.id, tool: SEND.name, destination: conn.id, policy: "allow" });
  let n = 0;
  const cap = (botId: string) => {
    const thread = store.createThread(botId);
    const { turn } = store.createTurn(thread.id, { clientRequestId: `req-${++n}`, content: "go" });
    store.claimNextTurn(thread.id);
    return gateway.issueCapability({ turnId: turn.id }).token;
  };
  return { dir, store, broker, reader, sent, sessions, gateway, bot, sibling, conn, entry, cap, tick: (ms: number) => { clock += ms; } };
}
const sendArgs = { channel: "C-general", text: "hello" };
const call = (connectionId: string, callId: string, args: Record<string, unknown> = sendArgs) =>
  ({ tool: SEND.name, connectionId, callId, arguments: args });

function scanDir(dir: string, needle: string): string[] {
  return readdirSync(dir).filter((f) => readFileSync(join(dir, f)).includes(Buffer.from(needle)));
}

test("composio: one versioned, account-pinned execute with injected key; result scrubbed; no secret or upstream ids persisted or returned", async (t) => {
  const s = setup(t, () => json(ok({ ok: true, echoed: `key=${SECRET}` }, { log_id: "log_x", session_info: { session_id: SESSION_ID, expires_at: "2026-10-07T13:00:00Z" } })));
  assert.deepEqual((await s.broker.warm()).map((r) => r.ok), [true]);
  assert.deepEqual(s.reader.reads, [OP_REF]);
  const result = await s.gateway.call(s.cap(s.bot.id), call(s.conn.id, "c1"));
  assert.equal(result.status, "succeeded");
  assert.equal(s.sent.length, 1);
  const [req] = s.sent;
  assert.equal(req!.url, `${COMPOSIO_ORIGIN}/api/v3.1/tools/execute/SLACK_SEND_MESSAGE`);
  assert.equal(req!.init.method, "POST");
  assert.equal(req!.init.redirect, "manual");
  assert.equal((req!.init.headers as Record<string, string>)["x-api-key"], SECRET);
  assert.deepEqual(req!.body, {
    arguments: sendArgs, version: SEND.version, user_id: composioUserId(s.store.hostId, s.store.ownerId, "work"), connected_account_id: ACCOUNT,
  });
  const text = JSON.stringify(result);
  for (const leaked of [SECRET, SESSION_ID, ACCOUNT, "log_x", OP_REF]) assert.ok(!text.includes(leaked), `engine result leaks ${leaked}`);
  assert.deepEqual(result.result, { ok: true, echoed: "key=[redacted]" });
  assert.deepEqual(scanDir(s.dir, SECRET), [], "no SQLite/WAL file holds the secret");
  assert.deepEqual(scanDir(s.dir, OP_REF), []);
});

test("composio: cold, expired or revoked credential never reaches the adapter; acquire is synchronous and fail-closed", async (t) => {
  const s = setup(t, () => json(ok({})));
  const token = s.cap(s.bot.id);
  await assert.rejects(s.gateway.call(token, call(s.conn.id, "cold")), (e) => e instanceof GatewayError && e.code === "unavailable");
  await s.broker.warm();
  s.tick(60_000);
  assert.equal(s.broker.acquire("cred-composio", HOST), null);
  await assert.rejects(s.gateway.call(token, call(s.conn.id, "cold")), (e) => e instanceof GatewayError && e.code === "unavailable");
  await s.broker.warm();
  assert.equal((await s.gateway.call(token, call(s.conn.id, "cold"))).status, "succeeded");
  s.broker.revoke("cred-composio");
  await assert.rejects(s.gateway.call(token, call(s.conn.id, "after-revoke")), (e) => e instanceof GatewayError && e.code === "unavailable");
  assert.equal(s.sent.length, 1);
  assert.equal(s.reader.reads.length, 2);
});

test("composio: a session belongs to one bot; a sibling with a grant but no session is refused before any request", async (t) => {
  const s = setup(t, () => json(ok({})));
  await s.broker.warm();
  const r = await s.gateway.call(s.cap(s.sibling.id), call(s.conn.id, "sib"));
  assert.equal(r.status, "unknown");
  assert.equal(s.sent.length, 0);
  // Mis-pinned account, toolkit, user namespace or version: refused before the network.
  for (const over of [{ connectedAccountId: "ca_other" }, { tools: [{ slug: "SLACK_SEND_MESSAGE", version: "20250101_00" }] }, { tools: [{ slug: "SLACK_LIST_CHANNELS", version: SEND.version }] }]) {
    s.sessions.dir = new ComposioSessionDirectory([s.entry(over)]);
    const out = await s.gateway.call(s.cap(s.bot.id), call(s.conn.id, `m-${JSON.stringify(over).length}`));
    assert.equal(out.status, "unknown");
  }
  assert.equal(s.sent.length, 0);
});

test("composio: redirect, 5xx, upstream error and ambiguous replies are unknown and never retried, even on replay", async (t) => {
  const replies: Reply[] = [
    () => new Response(null, { status: 307, headers: { location: "https://evil.test/steal" } }),
    () => json({ error: `internal ${SECRET}` }, 502),
    () => json({ data: null, error: "tool failed", successful: false }),
    () => json({ data: {}, error: null, successful: false }),
    () => json({ data: {}, error: null }),
    // Fields the documented response does not have (e.g. an echoed routing choice) are never interpreted.
    () => json(ok({}, { connected_account_id: "ca_other" })),
    () => json(ok({}, { version: "latest" })),
    () => json(ok({}, { session_info: "trs_other" })),
    () => new Response(`<html>${SECRET}</html>`, { status: 200, headers: { "content-type": "text/html" } }),
  ];
  for (const [i, reply] of replies.entries()) {
    const s = setup(t, reply);
    await s.broker.warm();
    const token = s.cap(s.bot.id);
    const first = await s.gateway.call(token, call(s.conn.id, `amb-${i}`));
    assert.equal(first.status, "unknown", `reply ${i}`);
    const replay = await s.gateway.call(token, call(s.conn.id, `amb-${i}`));
    assert.equal(replay.status, "unknown");
    assert.equal(s.sent.length, 1, "no follow, no retry");
    assert.ok(!JSON.stringify(first).includes(SECRET));
    assert.deepEqual(scanDir(s.dir, SECRET), []);
  }
});

const adapterCall = (over: Partial<AdapterCall> = {}): AdapterCall => ({
  toolkit: "slack", upstreamSlug: "SLACK_SEND_MESSAGE", version: V, host: HOST,
  upstreamUserId: composioUserId("inst", "own", "work"), upstreamAccountRef: ACCOUNT, arguments: { text: "x" },
  idempotencyKey: "gw_x", connectionId: "conn_1",
  scope: { installationId: "inst", ownerId: "own", profileId: "work", botId: "bot_1", threadId: "t", turnId: "u" }, ...over,
});
const directory = (over: Partial<ComposioBotSession> = {}) => new ComposioSessionDirectory([{
  installationId: "inst", ownerId: "own", profileId: "work", botId: "bot_1", connectionId: "conn_1", toolkit: "slack",
  upstreamUserId: composioUserId("inst", "own", "work"), connectedAccountId: ACCOUNT, sessionId: SESSION_ID,
  tools: [{ slug: "SLACK_SEND_MESSAGE", version: V }], ...over,
}]);
const auth: InjectedAuth = { headers: { "x-api-key": SECRET } };
const never = new AbortController().signal;
const code = (expected: string) => (e: unknown) => e instanceof ConnectorError && e.code === expected && !e.message.includes(SECRET);

test("composio adapter: identity, account, tool, args, origin and auth headers are checked before the network", async () => {
  const { fetch, sent } = fakeFetch(() => json(ok({})));
  const adapter = new ComposioSessionAdapter({ sessions: directory(), fetch });
  await assert.rejects(adapter.execute(adapterCall({ host: "evil.test" }), auth, { signal: never }), code("origin_refused"));
  await assert.rejects(adapter.execute(adapterCall({ connectionId: "conn_2" }), auth, { signal: never }), code("config_missing"));
  await assert.rejects(adapter.execute(adapterCall({ scope: { ...adapterCall().scope, botId: "bot_2" } }), auth, { signal: never }), code("config_missing"));
  await assert.rejects(adapter.execute(adapterCall({ upstreamAccountRef: "ca_other" }), auth, { signal: never }), code("scope_mismatch"));
  await assert.rejects(adapter.execute(adapterCall({ upstreamUserId: "dx:inst:own:home" }), auth, { signal: never }), code("scope_mismatch"));
  for (const version of ["20260902_00", "latest", ""]) {
    await assert.rejects(adapter.execute(adapterCall({ version }), auth, { signal: never }), code("tool_not_allowed"));
  }
  await assert.rejects(adapter.execute(adapterCall({ upstreamSlug: "COMPOSIO_MULTI_EXECUTE_TOOL" }), auth, { signal: never }), code("tool_not_allowed"));
  for (const forged of [{ account: "ca_other" }, { user_id: "x" }, { tool_slug: "GMAIL_SEND_EMAIL" }, { session_id: "trs_other" }, { Connected_Accounts: {} }]) {
    await assert.rejects(adapter.execute(adapterCall({ arguments: forged }), auth, { signal: never }), code("arguments_refused"));
  }
  for (const headers of [{ "x-user-api-key": SECRET }, { "x-api-key": `${SECRET}\r\nx-evil: 1` }, { host: "evil.test" }, {}]) {
    await assert.rejects(adapter.execute(adapterCall(), { headers }, { signal: never }), code("auth_refused"));
  }
  assert.equal(sent.length, 0);
  assert.throws(() => new ComposioSessionAdapter({ sessions: directory(), fetch, origin: "http://backend.composio.dev" }), code("invalid_config"));
  assert.throws(() => new ComposioSessionAdapter({ sessions: directory(), fetch, origin: "https://backend.composio.dev/api" }), code("invalid_config"));
});

test("composio adapter: timeout, caller abort, oversized and streamed bodies fail with fixed codes", async () => {
  const run = async (reply: Reply, signal = never, limits = { timeoutMs: 80, maxResponseBytes: 1024 }) => {
    const { fetch } = fakeFetch(reply);
    return new ComposioSessionAdapter({ sessions: directory(), fetch, limits }).execute(adapterCall(), auth, { signal });
  };
  await assert.rejects(run(hangUntilAbort), code("timeout"));
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(run(hangUntilAbort, ac.signal, { timeoutMs: 5_000, maxResponseBytes: 1024 }), code("aborted"));
  await assert.rejects(run(() => json({ data: "x".repeat(10) }, 200, { "content-length": "999999" })), code("response_too_large"));
  const big = () => new Response(new ReadableStream({
    start(c) { for (let i = 0; i < 8; i += 1) c.enqueue(new TextEncoder().encode("x".repeat(512))); c.close(); },
  }), { headers: { "content-type": "application/json" } });
  await assert.rejects(run(big), code("response_too_large"));
  // Headers arrive, body never ends: the same deadline covers the body.
  const stalled = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); } }), { headers: { "content-type": "application/json" } });
  await assert.rejects(run(stalled), code("timeout"));
  await assert.rejects(new ComposioSessionAdapter({ sessions: directory(), fetch: fakeFetch(() => json({})).fetch, limits: { maxRequestBytes: 16 } })
    .execute(adapterCall({ arguments: { text: "y".repeat(64) } }), auth, { signal: never }), code("request_too_large"));
});

test("composio directory: immutable, one session per bot+connection, user namespace derived, meta pins refused", () => {
  const dir = directory();
  assert.ok(Object.isFrozen(dir));
  assert.ok(Object.isFrozen(dir.find(adapterCall().scope, "conn_1")));
  assert.equal((dir as unknown as { add?: unknown }).add, undefined);
  const base = { installationId: "inst", ownerId: "own", profileId: "work", botId: "bot_1", connectionId: "conn_1", toolkit: "slack",
    upstreamUserId: composioUserId("inst", "own", "work"), connectedAccountId: ACCOUNT, sessionId: SESSION_ID, tools: [{ slug: "SLACK_SEND_MESSAGE", version: V }] };
  assert.throws(() => new ComposioSessionDirectory([base, base]), code("invalid_config"));
  assert.throws(() => new ComposioSessionDirectory([base, { ...base, botId: "bot_2" }]), code("invalid_config"), "session shared between bots");
  assert.throws(() => new ComposioSessionDirectory([{ ...base, upstreamUserId: "user_123" }]), code("invalid_config"));
  for (const slug of ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_REMOTE_BASH_TOOL", "SLACK_PROXY_EXECUTE", "COMPOSIO_MANAGE_CONNECTIONS"]) {
    assert.throws(() => new ComposioSessionDirectory([{ ...base, tools: [{ slug, version: V }] }]), code("invalid_config"));
  }
  // Only exact published versions: floating tags and free-form strings are refused at configuration time.
  for (const version of ["latest", "v1", "20260901", "20260901_0", "20260901_00 ", "00000000-00"]) {
    assert.throws(() => new ComposioSessionDirectory([{ ...base, tools: [{ slug: "SLACK_SEND_MESSAGE", version }] }]), code("invalid_config"), version);
  }
  // The Session id is optional routing-free metadata; without it the binding still needs the pinned account and versions.
  const { sessionId: _unused, ...noSession } = base;
  assert.equal(new ComposioSessionDirectory([noSession, { ...noSession, botId: "bot_2" }]).size, 2);
  assert.throws(() => new ComposioSessionDirectory([{ ...noSession, sessionId: "../x" }]), code("invalid_config"));
});

const restricted = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  session_id: SESSION_ID,
  mcp: { type: "http", url: `https://app.composio.dev/tool_router/v3/${SESSION_ID}/mcp` },
  tool_router_tools: ["SLACK_SEND_MESSAGE"],
  config: {
    user_id: composioUserId("inst", "own", "work"), toolkits: { enabled: ["slack"] },
    tools: { slack: { enabled: ["SLACK_SEND_MESSAGE"] } }, connected_accounts: { slack: [ACCOUNT] }, auth_configs: {},
    instant: false, manage_connections: { enabled: false }, workbench: { enable: false, proxy_execution_enabled: false },
    multi_account: { enable: false }, proxy_execute: { enable: false }, preload: { tools: ["SLACK_SEND_MESSAGE"] },
    search: { enable: false }, execute: { enable_multi_execute: false }, ...over,
  },
  config_version: 1, ...top,
});
const provision = { installationId: "inst", ownerId: "own", profileId: "work", botId: "bot_1", connectionId: "conn_1", toolkit: "slack",
  connectedAccountId: ACCOUNT, tools: [{ slug: "SLACK_SEND_MESSAGE", version: V }] };

test("composio admin: creates a per-bot direct-tools session and verifies the server config, failing closed on any widening", async () => {
  const { fetch, sent } = fakeFetch(() => json(restricted(), 201));
  const admin = new ComposioAdminClient({ fetch });
  const session = await admin.createBotSession(provision, auth);
  assert.equal(session.sessionId, SESSION_ID);
  assert.equal(session.upstreamUserId, "dx:inst:own:work");
  assert.ok(!JSON.stringify(session).includes(SECRET));
  assert.ok(!("mcp" in session));
  assert.equal(sent[0]!.url, `${COMPOSIO_ORIGIN}/api/v3.1/tool_router/session`);
  assert.deepEqual(sent[0]!.body, {
    user_id: "dx:inst:own:work", toolkits: { enable: ["slack"] }, tools: { slack: { enable: ["SLACK_SEND_MESSAGE"] } },
    connected_accounts: { slack: [ACCOUNT] }, preload: { tools: ["SLACK_SEND_MESSAGE"] }, manage_connections: { enable: false },
    workbench: { enable: false }, proxy_execute: { enable: false }, multi_account: { enable: false }, search: { enable: false },
    execute: { enable_multi_execute: false }, instant: false,
  });
  // The verified session is directly usable as trusted directory input.
  assert.equal(new ComposioSessionDirectory([session]).size, 1);

  const widened: unknown[] = [
    restricted({ search: { enable: true } }), restricted({ workbench: { enable: true } }),
    restricted({ workbench: { enable: false, proxy_execution_enabled: true } }), restricted({ execute: { enable_multi_execute: true } }),
    restricted({ manage_connections: { enabled: true } }), restricted({ instant: {} }), restricted({ connected_accounts: { slack: ["ca_other"] } }),
    restricted({ toolkits: { enabled: ["slack", "gmail"] } }), restricted({ user_id: "user_123" }), restricted({ multi_account: { enable: true } }),
    restricted({ tools: { slack: { enabled: ["SLACK_SEND_MESSAGE", "SLACK_DELETE_MESSAGE"] } } }), restricted({ search: undefined }),
    restricted({}, { tool_router_tools: ["SLACK_SEND_MESSAGE", "COMPOSIO_SEARCH_TOOLS"] }), restricted({}, { session_id: "../x" }),
    { session_id: SESSION_ID },
  ];
  for (const body of widened) {
    const one = fakeFetch(() => json(body, 201));
    await assert.rejects(new ComposioAdminClient({ fetch: one.fetch }).createBotSession(provision, auth), code("session_policy_mismatch"), JSON.stringify(body).slice(0, 120));
    assert.equal(one.sent.length, 1, "never retried");
  }
  await assert.rejects(admin.createBotSession({ ...provision, tools: [{ slug: "COMPOSIO_MULTI_EXECUTE_TOOL", version: V }] }, auth), code("invalid_config"));
  await assert.rejects(admin.createBotSession(provision, { headers: { "x-user-api-key": SECRET } }), code("auth_refused"));
  assert.equal(sent.length, 1);
});

test("composio adapter: versioned direct execute sends the exact route, version, user and account; never the session route", async () => {
  const { fetch, sent } = fakeFetch(() => json(ok({ ts: "1" }, { log_id: "log_y", session_info: null })));
  const pins = [{ slug: "SLACK_SEND_MESSAGE", version: V }, { slug: "SLACK_LIST_CHANNELS", version: "20251027_03" }];
  const adapter = new ComposioToolAdapter({ sessions: directory({ tools: pins }), fetch });
  assert.equal(ComposioSessionAdapter, ComposioToolAdapter, "former name stays a compatible alias");
  assert.equal(ComposioBotDirectory, ComposioSessionDirectory);
  assert.deepEqual(await adapter.execute(adapterCall(), auth, { signal: never }), { ts: "1" });
  assert.deepEqual(await adapter.execute(adapterCall({ upstreamSlug: "SLACK_LIST_CHANNELS", version: "20251027_03", arguments: {} }), auth, { signal: never }), { ts: "1" });
  assert.deepEqual(sent.map((r) => r.url), [
    `${COMPOSIO_ORIGIN}/api/v3.1/tools/execute/SLACK_SEND_MESSAGE`, `${COMPOSIO_ORIGIN}/api/v3.1/tools/execute/SLACK_LIST_CHANNELS`,
  ]);
  assert.deepEqual(sent.map((r) => r.body), [
    { arguments: { text: "x" }, version: V, user_id: "dx:inst:own:work", connected_account_id: ACCOUNT },
    { arguments: {}, version: "20251027_03", user_id: "dx:inst:own:work", connected_account_id: ACCOUNT },
  ]);
  for (const r of sent) {
    assert.ok(!r.url.includes("tool_router") && !r.url.includes(SESSION_ID), "the Session id never routes execution");
    assert.equal(r.init.method, "POST");
    assert.equal(r.init.redirect, "manual");
    assert.deepEqual(Object.keys(r.init.headers as Record<string, string>).sort(), ["accept", "content-type", "x-api-key"]);
  }
  // A version mismatch between manifest and binding never sends, and a pin with a floating version never loads.
  await assert.rejects(adapter.execute(adapterCall({ upstreamSlug: "SLACK_LIST_CHANNELS", version: V }), auth, { signal: never }), code("tool_not_allowed"));
  assert.equal(sent.length, 2);
  // The documented response shape with anything unexpected fails closed and is not retried.
  for (const reply of [ok({}, { account: "ca_other" }), ok({}, { user_id: "someone" }), ok({}, { tool_slug: "GMAIL_SEND_EMAIL" }), { data: {}, error: null }, [ok({})]]) {
    const one = fakeFetch(() => json(reply));
    await assert.rejects(new ComposioToolAdapter({ sessions: directory(), fetch: one.fetch }).execute(adapterCall(), auth, { signal: never }),
      (e) => e instanceof ConnectorError && (e.code === "response_invalid" || e.code === "upstream_error"), JSON.stringify(reply));
    assert.equal(one.sent.length, 1);
  }
});
