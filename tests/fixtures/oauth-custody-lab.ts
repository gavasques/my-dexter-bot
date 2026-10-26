import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { TestContext } from "node:test";
import { HostStore } from "@dexter/hub";
import { CapabilityGateway } from "@dexter/gateway";
import { NativeMcpRuntime, PrivateChannelMcpOAuthTokenStore } from "@dexter/connectors";
import { AppPrivateMcpOAuthCustodyChannel } from "../../packages/cli/src/mcp-oauth-private-custody.js";
import { bindBrowserUsePrivateInput } from "../../packages/cli/src/browser-use-private-input.js";

/**
 * Synthetic UX-P1-10 lab: loopback OAuth authorization server + MCP resource server (written here), and a fake APP
 * custodian that answers the host's private custody requests with the same rules as the Swift
 * `McpOAuthCustodyResponder` (exact keys, host binding, instance pin/resource isolation, all-generation remove).
 * Frames travel through the real host channel and the real private stdin reader. No Keychain, account or network
 * beyond 127.0.0.1; ports are random.
 */
type Handler = (req: IncomingMessage, res: ServerResponse, url: URL, body: string) => void;
export const json = (res: ServerResponse, status: number, value: unknown): void => { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value)); };
async function listen(t: TestContext, handler: Handler): Promise<number> {
  const server = createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", c => { body += c; });
    req.on("end", () => handler(req, res, new URL(req.url ?? "/", "http://127.0.0.1"), body));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  return (server.address() as AddressInfo).port;
}

export interface OAuthServers {
  issuer(): string; resource(): string; live: Set<string>; mode: { deny: boolean; revoked: boolean };
  counts: { token: number; refresh: number; authorize: number };
  browse(authorizationUrl: string): Promise<number>;
}
export async function oauthServers(t: TestContext): Promise<OAuthServers> {
  const codes = new Map<string, { challenge: string; redirect: string; clientId: string; resource: string }>();
  const live = new Set<string>(), mode = { deny: false, revoked: false }, counts = { token: 0, refresh: 0, authorize: 0 };
  let issued = 0, asPort = 0, rsPort = 0;
  const issuer = () => `http://127.0.0.1:${asPort}`, resource = () => `http://127.0.0.1:${rsPort}/mcp`;
  asPort = await listen(t, (req, res, url, body) => {
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(res, 200, { issuer: issuer(), authorization_endpoint: `${issuer()}/authorize`, token_endpoint: `${issuer()}/token`, registration_endpoint: `${issuer()}/register`,
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"] });
      return;
    }
    if (url.pathname === "/register" && req.method === "POST") { json(res, 201, { ...JSON.parse(body), client_id: `client-${++issued}` }); return; }
    if (url.pathname === "/authorize") {
      counts.authorize++;
      const p = url.searchParams, back = new URL(p.get("redirect_uri")!);
      back.searchParams.set("state", p.get("state")!);
      if (mode.deny) back.searchParams.set("error", "access_denied");
      else {
        const code = `code-${++issued}`;
        codes.set(code, { challenge: p.get("code_challenge")!, redirect: p.get("redirect_uri")!, clientId: p.get("client_id")!, resource: p.get("resource")! });
        back.searchParams.set("code", code);
      }
      res.writeHead(302, { location: back.href }).end();
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const f = new URLSearchParams(body);
      const mint = (): void => {
        const access = `synthetic-oauth-access-${++issued}`, refresh = `synthetic-oauth-refresh-${issued}`;
        live.add(access); live.add(refresh);
        json(res, 200, { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh });
      };
      if (f.get("grant_type") === "authorization_code") {
        counts.token++;
        const c = codes.get(f.get("code") ?? ""); codes.delete(f.get("code") ?? "");
        const verifier = createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url");
        if (!c || c.challenge !== verifier || c.redirect !== f.get("redirect_uri") || c.clientId !== f.get("client_id") || c.resource !== f.get("resource")) { json(res, 400, { error: "invalid_grant" }); return; }
        mint(); return;
      }
      if (f.get("grant_type") === "refresh_token") {
        counts.refresh++;
        if (!mode.revoked && live.has(f.get("refresh_token") ?? "")) { live.delete(f.get("refresh_token")!); mint(); return; }
      }
      json(res, 400, { error: "invalid_grant" });
      return;
    }
    res.writeHead(404).end();
  });
  rsPort = await listen(t, (req, res, url, body) => {
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) { json(res, 200, { resource: resource(), authorization_servers: [issuer()] }); return; }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (url.pathname !== "/mcp" || !bearer || !live.has(bearer)) {
      res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="http://127.0.0.1:${rsPort}/.well-known/oauth-protected-resource/mcp"` }).end(); return;
    }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const msg = JSON.parse(body) as { id?: number; method: string; params?: Record<string, unknown> };
    if (msg.id === undefined) { res.writeHead(202).end(); return; }
    const reply = (result: unknown): void => json(res, 200, { jsonrpc: "2.0", id: msg.id, result });
    if (msg.method === "initialize") reply({ protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "synthetic-oauth", version: "1" } });
    else if (msg.method === "tools/list") reply({ tools: [{ name: "lookup", description: "Look up", inputSchema: { type: "object", properties: { q: { type: "string", maxLength: 50 } }, required: ["q"] } }] });
    else if (msg.method === "tools/call") reply({ content: [{ type: "text", text: `found:${String((msg.params?.arguments as { q?: string }).q)}` }] });
    else json(res, 200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
  });
  return {
    issuer, resource, live, mode, counts,
    browse: async (authorizationUrl: string) => {
      const consent = await fetch(authorizationUrl, { redirect: "manual" });
      return (await fetch(consent.headers.get("location")!, { redirect: "manual" })).status;
    },
  };
}

const TOKEN_KEYS = "accessToken,clientId,clientSecret,expiresAt,issuer,refreshToken,resource,resourceIndicator,scope,serverId,tokenEndpoint";
/** Mirrors the Swift `McpOAuthCustodyResponder` + an in-memory Keychain (one item per host+owner+instance). */
export class FakeAppCustodian {
  readonly items = new Map<string, string>();
  available = true;
  readonly seen: string[] = [];
  answer(request: Record<string, unknown>, readyHostID: string): Record<string, unknown> | null {
    if (request.schema !== "dexter.mcp-oauth-custody-request/1" || request.hostID !== readyHostID || request.v !== 1 || typeof request.requestId !== "string") return null;
    this.seen.push(String(request.type));
    const out: Record<string, unknown> = { schema: "dexter.mcp-oauth-custody-result/1", hostID: readyHostID, v: 1, type: "mcp_oauth_custody.result", requestId: request.requestId };
    const scopeOf = (raw: unknown): string | null => {
      const s = raw as Record<string, unknown> | null;
      return s && Object.keys(s).sort().join() === "installationId,ownerId" && s.installationId === readyHostID ? `${s.installationId}|${s.ownerId}` : null;
    };
    const keyOf = (raw: unknown) => {
      const k = raw as Record<string, unknown> | null;
      if (!k || Object.keys(k).sort().join() !== "installationId,instancePin,ownerId,resource,serverId") return null;
      const scope = scopeOf({ installationId: k.installationId, ownerId: k.ownerId });
      return scope ? { item: `${scope}|${String(k.serverId)}`, pin: k.instancePin as string, resource: k.resource as string, server: k.serverId as string } : null;
    };
    if (!this.available) { out.status = "unavailable"; return out; }
    switch (request.type) {
      case "mcp_oauth_custody.status": if (!scopeOf(request.scope)) return null; out.status = "ok"; out.custody = "data_protection_keychain"; return out;
      case "mcp_oauth_custody.load": {
        const k = keyOf(request.key); if (!k) return null;
        const stored = this.items.get(k.item);
        if (!stored) { out.status = "absent"; return out; }
        const record = JSON.parse(stored) as { instancePin: string; resource: string; tokens: Record<string, unknown> };
        if (record.instancePin !== k.pin || record.resource !== k.resource) { out.status = "absent"; return out; }
        out.status = "ok"; out.tokens = record.tokens; return out;
      }
      case "mcp_oauth_custody.save": {
        const k = keyOf(request.key), tokens = request.tokens as Record<string, unknown> | undefined;
        if (!k || !tokens || Object.keys(tokens).sort().join() !== TOKEN_KEYS || tokens.serverId !== k.server || tokens.resource !== k.resource) return null;
        this.items.set(k.item, JSON.stringify({ v: 1, serverId: k.server, instancePin: k.pin, resource: k.resource, tokens }));
        out.status = "ok"; return out;
      }
      case "mcp_oauth_custody.remove": {
        const scope = scopeOf(request.scope); if (!scope || typeof request.serverId !== "string") return null;
        out.status = this.items.delete(`${scope}|${request.serverId}`) ? "ok" : "absent"; return out;
      }
      default: return null;
    }
  }
}

/** Real channel + real private stdin reader; the app opens custody after ready and answers asynchronously like its run loop. */
export function wire(custodian: FakeAppCustodian, hostID: string) {
  const stdin = new PassThrough(), lines: string[] = [];
  const channel = new AppPrivateMcpOAuthCustodyChannel();
  const vault = { set() {}, async lock() {} };
  const reader = bindBrowserUsePrivateInput(stdin, hostID, vault, () => {}, undefined, channel);
  let opened!: () => void;
  const open = new Promise<void>(resolve => { opened = resolve; });
  channel.arm({ hostID, onOpen: () => opened(), write: line => {
    lines.push(line);
    const answer = custodian.answer(JSON.parse(line) as Record<string, unknown>, hostID);
    if (answer) setImmediate(() => stdin.write(JSON.stringify(answer) + "\n"));
  } });
  stdin.write(JSON.stringify({ schema: "dexter.mcp-oauth-custody-open/1", hostID }) + "\n");
  return { channel, lines, stdin, opened: open, close: async () => { channel.close(); await reader.close(); } };
}

/** NativeMcpRuntime over a HostStore with durable app custody through the private channel. */
export function nativeHost(t: TestContext, custodian: FakeAppCustodian, options: { now?: () => number; dir?: string; privateOrigins?:readonly string[] } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "dx-oauth-custody-"));
  if (!options.dir) t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataDir = join(dir, "host");
  let store!: HostStore, gateway!: CapabilityGateway, runtime!: NativeMcpRuntime, link!: ReturnType<typeof wire>, custody!: PrivateChannelMcpOAuthTokenStore;
  let n = 0;
  const open = async (): Promise<void> => {
    store = new HostStore({ dataDir });
    const current = store;
    let rt: NativeMcpRuntime | null = null;
    custody = new PrivateChannelMcpOAuthTokenStore({ scope: () => ({ installationId: current.hostId, ownerId: current.ownerId }),
      instancePin: id => rt!.admin.instancePin(id), channel: { exchange: (r, s) => link.channel.exchange(r, s) }, timeoutMs: 2_000 });
    runtime = rt = new NativeMcpRuntime({ host: { runsOn: "owner_mac", stdioRoot: join(dataDir, "mcp-stdio"), egressPolicy:{placement:"owner_mac",privateOrigins:options.privateOrigins??[]} }, oauth: { store: custody, ...(options.now ? { now: options.now } : {}) } });
    gateway = new CapabilityGateway({ store, broker: runtime.broker, adapter: runtime.adapter });
    runtime.bind(store, gateway);
    link = wire(custodian, store.hostId);
    await link.opened;
  };
  const close = async (): Promise<void> => { await link.close(); await runtime.close(); gateway.close(); store.close(); };
  const approvedCall = async (botId: string, tool: string, connectionId: string, args: Record<string, string>) => {
    const thread = store.createThread(botId), { turn } = store.createTurn(thread.id, { clientRequestId: `req-${++n}`, content: "go" });
    store.claimNextTurn(thread.id);
    const token = gateway.issueCapability({ turnId: turn.id }).token, input = { tool, connectionId, callId: `c${++n}`, arguments: args };
    const asked = await gateway.call(token, input);
    if (asked.status !== "awaiting_approval") return asked;
    store.decideAction(asked.actionId, { decision: "allow", requestHash: asked.requestHash });
    return gateway.call(token, input);
  };
  const tools = (botId: string) => {
    const thread = store.createThread(botId), { turn } = store.createTurn(thread.id, { clientRequestId: `req-${++n}`, content: "go" });
    store.claimNextTurn(thread.id);
    return gateway.listTools(gateway.issueCapability({ turnId: turn.id }).token);
  };
  return { dataDir, open, close, approvedCall, tools, get store() { return store; }, get gateway() { return gateway; }, get runtime() { return runtime; },
    get custody() { return custody; }, get link() { return link; } };
}
export const until = async (cond: () => boolean, ms = 5000): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 20))) if (cond()) return true;
  return cond();
};
