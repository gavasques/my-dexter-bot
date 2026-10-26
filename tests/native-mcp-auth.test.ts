import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HostStore } from "@dexter/hub";
import { CapabilityGateway } from "@dexter/gateway";
import { McpConnectorError, NativeMcpRuntime, type McpSecretCustody, type NativeMcpRuntimeOptions } from "@dexter/connectors";

// Synthetic values only: in-test custody, loopback OAuth/MCP servers written here, the independent stdio fixture.
// No real account, vault, op CLI, Keychain, authfile, browser or network beyond 127.0.0.1.
const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-fake-stdio-server.js", import.meta.url));
const SECRET_A = "synthetic-broker-value-a1b2c3";
const SECRET_B = "synthetic-broker-value-rotated-d4e5f6";
type Ctx = { after: (fn: () => void | Promise<void>) => void };

const noLeak = (value: unknown, needles: readonly string[]): void => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const needle of needles) assert.ok(!text.includes(needle), "secret material leaked into an owner/engine-visible value");
};
const code = (expected: string) => (e: unknown) => e instanceof McpConnectorError && e.code === expected;
const until = async (cond: () => boolean, ms = 5000): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (cond()) return true;
  return cond();
};

function host(t: Ctx) {
  const dir = mkdtempSync(join(tmpdir(), "dexter-mcp-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataDir = join(dir, "host");
  let store!: HostStore, gateway!: CapabilityGateway, runtime!: NativeMcpRuntime;
  let n = 0;
  const open = (options: Omit<NativeMcpRuntimeOptions, "host">): void => {
    store = new HostStore({ dataDir });
    runtime = new NativeMcpRuntime({ host: { runsOn: "owner_mac", stdioRoot: join(dataDir, "mcp-stdio") }, ...options });
    gateway = new CapabilityGateway({ store, broker: runtime.broker, adapter: runtime.adapter });
    runtime.bind(store, gateway);
  };
  const close = async (): Promise<void> => { await runtime.close(); gateway.close(); store.close(); };
  const capability = (botId: string): string => {
    const thread = store.createThread(botId);
    const { turn } = store.createTurn(thread.id, { clientRequestId: `req-${++n}`, content: "go" });
    store.claimNextTurn(thread.id);
    return gateway.issueCapability({ turnId: turn.id }).token;
  };
  /** One approved call (the test plays the owner approving the `ask`). */
  const approvedCall = async (botId: string, tool: string, connectionId: string, args: Record<string, string>) => {
    const token = capability(botId);
    const input = { tool, connectionId, callId: `c${++n}`, arguments: args };
    const asked = await gateway.call(token, input);
    assert.equal(asked.status, "awaiting_approval");
    store.decideAction(asked.actionId, { decision: "allow", requestHash: asked.requestHash });
    return { run: () => gateway.call(token, input) };
  };
  return { dataDir, open, close, approvedCall, get store() { return store; }, get gateway() { return gateway; }, get runtime() { return runtime; } };
}

test("native MCP broker: custody slots unlocked by the owner, injected only at call time, lock/rotation/restart/remove", async (t) => {
  const h = host(t);
  let value = SECRET_A, failing = false;
  const reads: string[] = [];
  const custody: McpSecretCustody = {
    kind: "synthetic",
    read: async (serverId, key) => {
      reads.push(`${serverId}/${key}`);
      if (failing) throw new Error(`custody failure quoting ${value}`);
      return value;
    },
  };
  h.open({ credentials: { custody } });
  t.after(async () => { try { await h.close(); } catch { /* closed by the test */ } });
  const admin = () => h.runtime.admin;
  const bot = h.store.createBot({ name: "Ops", profileId: "work", engine: "claude" });
  const stdioHome = join(h.dataDir, "mcp-stdio", "fake");
  const ECHO = "mcp.fake.echo_text";

  admin().addServer({ definition: {
    id: "fake", name: "Fake", runsOn: "owner_mac", auth: "broker",
    transport: { type: "stdio", command: process.execPath, args: [FIXTURE], env: { API_TOKEN: { kind: "secret", key: "env.api_token" } } },
    limits: { callTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  } });
  // Stored, locked: listing and status read no custody and start nothing.
  assert.equal(admin().listServers()[0]!.status, "needs_auth");
  assert.deepEqual(admin().credentialStatus("fake"), {
    serverId: "fake", auth: "broker", slots: ["env.api_token"], lastError: null, custody: "synthetic", state: "locked", expiresAt: null, issuer: null,
  });
  assert.deepEqual(reads, []);
  assert.equal(existsSync(stdioHome), false);

  // Explicit discovery unlocks from custody (one read per slot), then lists.
  const found = await admin().discover("fake");
  assert.equal(found.server.status, "ready");
  assert.deepEqual(reads, ["fake/env.api_token"]);
  assert.equal(admin().credentialStatus("fake").state, "unlocked");
  noLeak([found, admin().listServers(), admin().credentialStatus("fake")], [SECRET_A]);

  admin().setBotSelection("fake", bot.id, { toolIds: [ECHO], policy: "ask" });
  const [connection] = h.gateway.registry.listConnections("work").filter((c) => c.toolkit === "mcp-fake");
  assert.ok(connection);
  assert.equal(connection.credentialRef, "mcp-broker:fake");
  // The broker releases only for the server's own logical host and auth-mode reference.
  assert.equal(h.runtime.broker.acquire("mcp-broker:fake", "other.mcp.dexter.internal"), null);
  assert.equal(h.runtime.broker.acquire("mcp-none:fake", "fake.mcp.dexter.internal"), null);

  const first = await (await h.approvedCall(bot.id, ECHO, connection.id, { text: "hi" })).run();
  assert.equal(first.status, "succeeded");
  const token = (first.result as { structuredContent: { token: string | null } }).structuredContent.token;
  assert.ok(token !== null && token !== SECRET_A, "injected into the child env, scrubbed from the result");
  noLeak(first, [SECRET_A]);

  // Lock: values dropped from memory, sessions ended; an approved call stays ready (no effect) until unlocked.
  assert.equal((await admin().lockCredentials("fake")).state, "locked");
  assert.equal(h.runtime.openSessions, 0);
  assert.deepEqual(h.runtime.broker.secretValues(), []);
  const pending = await h.approvedCall(bot.id, ECHO, connection.id, { text: "again" });
  await assert.rejects(pending.run(), (e: unknown) => (e as { code?: string }).code === "unavailable");

  // Rotation: the next unlock reads the new value; the old one is no longer held.
  value = SECRET_B;
  assert.equal((await admin().unlockCredentials("fake")).state, "unlocked");
  const second = await pending.run();
  assert.equal(second.status, "succeeded");
  assert.deepEqual(h.runtime.broker.secretValues(), [SECRET_B]);
  noLeak(second, [SECRET_A, SECRET_B]);

  // Custody failure: fixed code only (the reader's message quoted the value), previous values dropped.
  failing = true;
  await assert.rejects(admin().unlockCredentials("fake"), (e: unknown) => code("custody_unavailable")(e) && !String((e as Error).message).includes(SECRET_B));
  const failed = admin().credentialStatus("fake");
  assert.equal(failed.state, "locked");
  assert.equal(failed.lastError, "custody_unavailable");
  failing = false;

  // Restart: nothing is read from custody or started; selection and pin survive; values stay locked until unlocked.
  const readsBefore = reads.length;
  await h.close();
  h.open({});
  assert.equal(admin().listServers()[0]!.status, "needs_auth");
  assert.equal(admin().credentialStatus("fake").state, "unavailable", "no custody configured on this host");
  assert.equal((await admin().discover("fake")).tools.length, 0);
  await h.close();
  h.open({ credentials: { custody } });
  assert.equal(reads.length, readsBefore, "restore reads no custody");
  assert.deepEqual(admin().botSelection("fake", bot.id).toolIds, [ECHO]);
  assert.equal(admin().credentialStatus("fake").state, "locked");
  assert.equal((await admin().unlockCredentials("fake")).state, "unlocked");
  const [conn2] = h.gateway.registry.listConnections("work").filter((c) => c.toolkit === "mcp-fake" && c.status === "active");
  assert.equal(conn2?.id, connection.id);
  assert.equal((await (await h.approvedCall(bot.id, ECHO, connection.id, { text: "back" })).run()).status, "succeeded");

  // Remove: values dropped, connection revoked.
  await admin().removeServer("fake");
  assert.deepEqual(h.runtime.broker.secretValues(), []);
  assert.equal(h.gateway.registry.getConnection(connection.id)?.status, "revoked");
});

// ---- local OAuth against synthetic loopback servers ----------------------------------------------

interface Seen { origin: "as" | "rs"; path: string; auth: string | null; body: string }
async function listen(t: Ctx, seen: Seen[], origin: Seen["origin"], handler: (req: IncomingMessage, res: ServerResponse, url: URL, body: string) => void): Promise<number> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      seen.push({ origin, path: url.pathname, auth: req.headers.authorization ?? null, body });
      handler(req, res, url, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return (server.address() as AddressInfo).port;
}
const json = (res: ServerResponse, status: number, body: unknown): void => { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)); };

test("native MCP OAuth: PKCE/state/loopback callback, issuer-bound tokens on the pinned endpoint, refresh, revocation, denial, restart", async (t) => {
  const seen: Seen[] = [];
  const mode = { badIssuer: false, noS256: false, deny: false, revoked: false };
  const codes = new Map<string, { clientId: string; challenge: string; redirect: string; resource: string }>();
  const live = new Set<string>();
  let issued = 0, asPort = 0, rsPort = 0;
  const issuer = () => `http://127.0.0.1:${asPort}`;
  const resource = () => `http://127.0.0.1:${rsPort}/mcp`;

  asPort = await listen(t, seen, "as", (req, res, url, body) => {
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(res, 200, {
        issuer: mode.badIssuer ? "http://127.0.0.1:1" : issuer(), authorization_endpoint: `${issuer()}/authorize`, token_endpoint: `${issuer()}/token`,
        registration_endpoint: `${issuer()}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"], authorization_response_iss_parameter_supported: true,
        ...(mode.noS256 ? {} : { code_challenge_methods_supported: ["S256"] }),
      });
      return;
    }
    if (url.pathname === "/register" && req.method === "POST") {
      const meta = JSON.parse(body) as { redirect_uris: string[] };
      json(res, 201, { ...meta, client_id: `client-${++issued}` });
      return;
    }
    if (url.pathname === "/authorize") {
      // The synthetic owner consents (or denies) in "their browser"; nothing in Dexter approves this.
      const p = url.searchParams;
      const back = new URL(p.get("redirect_uri")!);
      back.searchParams.set("state", p.get("state")!);
      if (mode.deny) { back.searchParams.set("error", "access_denied"); back.searchParams.set("iss", issuer()); }
      else {
        assert.equal(p.get("code_challenge_method"), "S256");
        assert.equal(p.get("resource"), resource());
        const c = `code-${++issued}`;
        codes.set(c, { clientId: p.get("client_id")!, challenge: p.get("code_challenge")!, redirect: p.get("redirect_uri")!, resource: p.get("resource")! });
        back.searchParams.set("code", c);
        back.searchParams.set("iss", issuer());
      }
      res.writeHead(302, { location: back.href }).end();
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const f = new URLSearchParams(body);
      const mint = (): void => {
        const access = `synthetic-oauth-access-${++issued}`, refresh = `synthetic-oauth-refresh-${issued}`;
        live.add(access);
        live.add(refresh);
        json(res, 200, { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh });
      };
      if (f.get("grant_type") === "authorization_code") {
        const c = codes.get(f.get("code") ?? "");
        codes.delete(f.get("code") ?? "");
        const verifier = createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url");
        if (!c || c.challenge !== verifier || c.redirect !== f.get("redirect_uri") || c.clientId !== f.get("client_id") || c.resource !== f.get("resource")) {
          json(res, 400, { error: "invalid_grant" });
          return;
        }
        mint();
        return;
      }
      if (f.get("grant_type") === "refresh_token" && !mode.revoked && live.has(f.get("refresh_token") ?? "")) { mint(); return; }
      json(res, 400, { error: "invalid_grant" });
      return;
    }
    res.writeHead(404).end();
  });
  rsPort = await listen(t, seen, "rs", (req, res, url, body) => {
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      json(res, 200, { resource: resource(), authorization_servers: [issuer()], scopes_supported: ["tools.read"] });
      return;
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (url.pathname !== "/mcp" || !bearer || !live.has(bearer) || !bearer.startsWith("synthetic-oauth-access-")) {
      res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="http://127.0.0.1:${rsPort}/.well-known/oauth-protected-resource/mcp"` }).end();
      return;
    }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const msg = JSON.parse(body) as { id?: number; method: string; params?: Record<string, unknown> };
    if (msg.id === undefined) { res.writeHead(202).end(); return; }
    const reply = (result: unknown): void => json(res, 200, { jsonrpc: "2.0", id: msg.id, result });
    if (msg.method === "initialize") reply({ protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-oauth", version: "1" } });
    else if (msg.method === "tools/list") reply({ tools: [{ name: "lookup", description: "Look up", inputSchema: { type: "object", properties: { q: { type: "string", maxLength: 50 } }, required: ["q"] } }] });
    else if (msg.method === "tools/call") reply({ content: [{ type: "text", text: `found:${String((msg.params?.arguments as { q?: string }).q)} auth=${String(req.headers.authorization)}` }] });
    else json(res, 200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
  });

  let clock = Date.now();
  const h = host(t);
  const oauthOptions = { now: () => clock, egressPolicy: { placement: "owner_mac" as const, privateOrigins: [issuer()] } };
  h.open({ oauth: oauthOptions });
  t.after(async () => { try { await h.close(); } catch { /* closed by the test */ } });
  const admin = () => h.runtime.admin;
  const bot = h.store.createBot({ name: "Ops", profileId: "work", engine: "claude" });
  const TOOL = "mcp.remote.lookup";
  const tokens = (): string[] => [...live];
  const browse = async (authorizationUrl: string): Promise<{ status: number; text: string }> => {
    const consent = await fetch(authorizationUrl, { redirect: "manual" });
    const callback = await fetch(consent.headers.get("location")!, { redirect: "manual" });
    return { status: callback.status, text: await callback.text() };
  };

  admin().addServer({ definition: { id: "remote", name: "Remote", runsOn: "any", auth: "oauth", transport: { type: "streamable_http", url: resource() } } });
  assert.equal(admin().listServers()[0]!.status, "needs_auth");
  assert.equal(admin().credentialStatus("remote").state, "unauthorized");
  assert.deepEqual((await admin().discover("remote")).tools, []);
  assert.equal(seen.length, 0, "no request without an authorization");

  // Owner starts the authorization: discovery, dynamic registration, PKCE S256, state, resource indicator, loopback callback.
  const start = await admin().startOAuth("remote", { scope: "tools.read" });
  assert.equal(start.issuer, issuer());
  const authUrl = new URL(start.authorizationUrl);
  assert.equal(authUrl.origin, issuer());
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authUrl.searchParams.get("resource"), resource());
  assert.equal(authUrl.searchParams.get("scope"), "tools.read");
  const redirect = new URL(authUrl.searchParams.get("redirect_uri")!);
  assert.equal(redirect.hostname, "127.0.0.1");
  assert.equal(admin().credentialStatus("remote").state, "authorizing");
  assert.equal(admin().listServers()[0]!.status, "needs_auth");

  // Forged callbacks never touch the flow: wrong state and wrong path.
  const forged = await fetch(`${redirect.href}?code=evil&state=${"x".repeat(43)}`);
  assert.equal(forged.status, 400);
  assert.equal((await fetch(`${redirect.origin}/elsewhere`)).status, 404);
  assert.equal(admin().credentialStatus("remote").state, "authorizing");

  const page = await browse(start.authorizationUrl);
  assert.equal(page.status, 200);
  noLeak(page.text, ["code-", "synthetic-oauth"]);
  assert.ok(await until(() => admin().credentialStatus("remote").state === "unlocked"));
  const status = admin().credentialStatus("remote");
  assert.equal(status.issuer, issuer());
  noLeak([status, admin().listServers()], tokens());
  assert.notEqual(await fetch(redirect.href).then((r) => r.status, () => 0), 200, "one-shot callback listener");

  // Discovery and an approved call with the bearer on the pinned endpoint only; scrubbed from the result.
  const found = await admin().discover("remote");
  assert.equal(found.server.status, "ready");
  admin().setBotSelection("remote", bot.id, { toolIds: [TOOL], policy: "ask" });
  const [connection] = h.gateway.registry.listConnections("work").filter((c) => c.toolkit === "mcp-remote");
  assert.equal(connection!.credentialRef, "mcp-oauth:remote");
  const r1 = await (await h.approvedCall(bot.id, TOOL, connection!.id, { q: "abc" })).run();
  assert.equal(r1.status, "succeeded");
  assert.match(JSON.stringify(r1.result), /found:abc/);
  noLeak(r1, tokens());
  assert.ok(seen.filter((s) => s.origin === "as").every((s) => !(s.auth ?? "").includes("synthetic-oauth-access")), "the access token never goes to the issuer");
  assert.ok(seen.filter((s) => s.auth?.startsWith("Bearer ")).every((s) => s.origin === "rs" && s.path === "/mcp"));

  // Expiry: the call fails closed (stays ready), one background refresh against the same issuer, next call succeeds.
  const before = [...live];
  clock += 2 * 3600_000;
  assert.equal(admin().credentialStatus("remote").state, "expired");
  const pending = await h.approvedCall(bot.id, TOOL, connection!.id, { q: "later" });
  await assert.rejects(pending.run(), (e: unknown) => (e as { code?: string }).code === "unavailable");
  assert.ok(await until(() => admin().credentialStatus("remote").state === "unlocked"));
  assert.ok(live.size > before.length, "refreshed");
  assert.equal((await pending.run()).status, "succeeded");

  // Revoked grant: refresh gets invalid_grant, tokens are forgotten, the owner must authorize again.
  mode.revoked = true;
  clock += 2 * 3600_000;
  const blocked = await h.approvedCall(bot.id, TOOL, connection!.id, { q: "x" });
  await assert.rejects(blocked.run(), (e: unknown) => (e as { code?: string }).code === "unavailable");
  assert.ok(await until(() => admin().credentialStatus("remote").state === "unauthorized"));
  assert.equal(admin().credentialStatus("remote").lastError, "needs_auth");
  mode.revoked = false;

  // Owner denies in the browser: nothing stored.
  mode.deny = true;
  const denied = await browse((await admin().startOAuth("remote", {})).authorizationUrl);
  assert.equal(denied.status, 400);
  assert.ok(await until(() => admin().credentialStatus("remote").lastError === "oauth_denied"));
  assert.equal(admin().credentialStatus("remote").state, "unauthorized");
  mode.deny = false;

  // Authorization server metadata that does not echo its issuer, or lacks S256, is refused before any callback exists.
  mode.badIssuer = true;
  await assert.rejects(admin().startOAuth("remote", {}), code("oauth_metadata_invalid"));
  mode.badIssuer = false;
  mode.noS256 = true;
  await assert.rejects(admin().startOAuth("remote", {}), code("oauth_metadata_invalid"));
  mode.noS256 = false;
  await assert.rejects(admin().startOAuth("remote", { clientSecret: "x" }), code("invalid_request"));

  // Re-authorize, then restart: in-memory tokens are gone (no token file), selection and pins survive, nothing is contacted.
  await browse((await admin().startOAuth("remote", {})).authorizationUrl);
  assert.ok(await until(() => admin().credentialStatus("remote").state === "unlocked"));
  const requests = seen.length;
  await h.close();
  h.open({ oauth: oauthOptions });
  assert.equal(admin().credentialStatus("remote").state, "unauthorized");
  assert.equal(admin().listServers()[0]!.status, "needs_auth");
  assert.deepEqual(admin().botSelection("remote", bot.id).toolIds, [TOOL]);
  assert.equal(seen.length, requests, "restore contacts neither the server nor the issuer");

  // Disconnect after a fresh authorization: tokens dropped from memory and the token store.
  await browse((await admin().startOAuth("remote", {})).authorizationUrl);
  assert.ok(await until(() => admin().credentialStatus("remote").state === "unlocked"));
  assert.equal((await admin().disconnectCredentials("remote")).state, "unauthorized");
  assert.equal((await admin().unlockCredentials("remote")).state, "unauthorized");
  assert.deepEqual(h.runtime.broker.secretValues(), []);
});
