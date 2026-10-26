import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { HostStore } from "@dexter/hub";
import { createHostApp } from "@dexter/hub/http";
import { CapabilityGateway, checkManifest, type ToolManifest } from "@dexter/gateway";
import { ConnectionsRuntime, type FetchLike } from "@dexter/connectors";
import { ConnectionsPlatformService, createConnectionsServiceApp, type ServiceCatalogConfig, type ServicePrincipal } from "../../packages/connections-service/src/index.js";
import { connectionsHttpPort } from "../../packages/cli/src/connections-services.js";

/**
 * Synthetic connections lab: a fake Composio REST v3.1 server, the trusted connections service and the user's host, each
 * on its own random 127.0.0.1 port (never 4317/4318), talking real HTTP. Clients keep their https origin pins; only the
 * socket target is remapped. Shapes follow the official OpenAPI (`backend.composio.dev/api/v3.1/openapi.json`).
 * No real provider, account, key, login or inference.
 */
export const COMPOSIO_KEY = "synthetic-composio-project-key-0001";
export const COMPOSIO_ORIGIN = "https://backend.composio.dev";
export const SERVICE_ORIGIN = "https://connections.dexter.test";
export const SERVICE_HOST = "connections.dexter.test";
export const LINK_ORIGIN = "https://connect.composio.test";
export const VERSION = "20260901_00";
export const ACCESS_TOKEN = "ya29.SYNTHETIC-ACCESS-TOKEN-NEVER-LEAK";
export const REFRESH_TOKEN = "1//SYNTHETIC-REFRESH-TOKEN-NEVER-LEAK";
export const READ: ToolManifest = checkManifest({ name: "gmail.read", toolkit: "gmail", upstreamSlug: "GMAIL_FETCH_EMAILS", version: VERSION, description: "Ler e-mails recentes",
  upstreamHost: SERVICE_HOST, effect: "read", destinationArgument: null, destinationOrigins: null,
  inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", maxLength: 64 } } } });
export const SEND: ToolManifest = checkManifest({ name: "gmail.send", toolkit: "gmail", upstreamSlug: "GMAIL_SEND_EMAIL", version: VERSION, description: "Enviar e-mail",
  upstreamHost: SERVICE_HOST, effect: "write", destinationArgument: "recipient", destinationOrigins: null,
  inputSchema: { type: "object", additionalProperties: false, required: ["recipient", "body"], properties: {
    recipient: { type: "string", maxLength: 64, enum: ["owner@example.test"] }, body: { type: "string", maxLength: 512 } } } });
export const IDENTITY_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
export const CATALOG: ServiceCatalogConfig[] = [{ serviceId: "gmail", displayName: "Gmail", description: "E-mail do Google.", provider: "composio", toolkit: "gmail",
  toolkitVersion: VERSION, authConfigId: "ac_gmail_synthetic", identity: "provider_verified", verification: "unproven", tools: [READ, SEND],
  identityProbe: { endpoint: IDENTITY_ENDPOINT, method: "GET", field: "emailAddress", kind: "email" } }];
/** Label-only variant (wave-1 behaviour): no reviewed identity probe. */
export const LABEL_CATALOG: ServiceCatalogConfig[] = [{ ...CATALOG[0]!, identity: "provider_display_name", identityProbe: null }];

/** Keeps the client's https origin pin and Response.url empty; only the socket target changes. */
export function remapFetch(map: Record<string, string>, spy?: (url: string, init: RequestInit) => void): FetchLike {
  return async (url, init) => {
    spy?.(url, init);
    const parsed = new URL(url), target = map[parsed.origin];
    if (!target) throw new Error("unmapped synthetic origin");
    const response = await fetch(target + parsed.pathname + parsed.search, init);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
export async function listen(app: Hono<any>): Promise<{ url: string; close(): Promise<void> }> {
  return await new Promise(resolve => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, info => {
      resolve({ url: `http://127.0.0.1:${info.port}`, close: () => new Promise<void>(done => { (server as Server).closeAllConnections?.(); server.close(() => done()); }) });
    });
  });
}

export interface FakeAccount { id: string; toolkit: string; authConfigId: string; userId: string; alias: string; status: string; displayName: string | null; disabled: boolean; createdAt: string; email: string | null }
type Fault = "drop" | "500" | "429";
/** Fake Composio REST v3.1 (documented request/response shapes only). */
export class FakeComposio {
  readonly accounts = new Map<string, FakeAccount>();
  readonly requests: Array<{ method: string; path: string; query: Record<string, string[]>; apiKey: string | undefined; body: unknown }> = [];
  readonly faults: Partial<Record<"link" | "delete" | "execute" | "list" | "get" | "proxy", Fault>> = {};
  /** Published current-user endpoint per toolkit (what Composio's toolkit metadata returns). */
  readonly identityEndpoints = new Map<string, string | null>([["gmail", IDENTITY_ENDPOINT]]);
  readonly authConfigs = new Map([["ac_gmail_synthetic", "gmail"]]);
  #server: Server | null = null;
  #counter = 0;
  url = "";
  async start(): Promise<void> {
    this.#server = createServer((req, res) => { void this.#handle(req, res); });
    await new Promise<void>(resolve => this.#server!.listen(0, "127.0.0.1", () => resolve()));
    this.url = `http://127.0.0.1:${(this.#server!.address() as AddressInfo).port}`;
  }
  async close(): Promise<void> { await new Promise<void>(done => { this.#server?.closeAllConnections(); this.#server?.close(() => done()); }); }
  /** The owner finished the hosted page: the provider stores credentials and reports ACTIVE. */
  complete(id: string, displayName: string | null = "Conta Sintética", email: string | null = null): void {
    const a = this.accounts.get(id)!; a.status = "ACTIVE"; a.displayName = displayName; a.email = email;
  }
  set(id: string, status: string): void { this.accounts.get(id)!.status = status; }
  count(method: string, prefix: string): number { return this.requests.filter(r => r.method === method && r.path.startsWith(prefix)).length; }
  #json(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
  #view(a: FakeAccount): Record<string, unknown> {
    const now = new Date().toISOString();
    return { toolkit: { slug: a.toolkit }, auth_config: { id: a.authConfigId, auth_scheme: "OAUTH2", is_composio_managed: true, is_disabled: false }, id: a.id,
      authScheme: "OAUTH2", word_id: `${a.toolkit}_red-castle`, alias: a.alias, user_id: a.userId, status: a.status, experimental: { account_type: "PRIVATE" },
      created_at: a.createdAt, updated_at: now, state: { authScheme: "OAUTH2", val: { status: a.status, ...(a.displayName ? { displayName: a.displayName } : {}),
        access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, token_type: "Bearer" } }, data: { access_token: ACCESS_TOKEN }, status_reason: null, is_disabled: a.disabled, params: {} };
  }
  #fault(name: keyof FakeComposio["faults"], res: ServerResponse): Fault | undefined {
    const fault = this.faults[name]; delete this.faults[name];
    if (fault === "500") this.#json(res, 500, { error: { message: "synthetic", code: 500, slug: "internal", status: 500 } });
    if (fault === "429") this.#json(res, 429, { error: { message: "synthetic", code: 429, slug: "rate_limited", status: 429 } });
    return fault;
  }
  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url!, "http://synthetic"), query: Record<string, string[]> = {};
    for (const [k, v] of url.searchParams) (query[k] ??= []).push(v);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const apiKey = req.headers["x-api-key"] as string | undefined;
    this.requests.push({ method: req.method!, path: url.pathname, query, apiKey, body });
    if (apiKey !== COMPOSIO_KEY) return this.#json(res, 401, { error: { message: "unauthorized", code: 401, slug: "unauthorized", status: 401 } });
    const drop = () => { res.socket?.destroy(); };
    const path = url.pathname;
    if (req.method === "POST" && path === "/api/v3.1/connected_accounts/link") {
      const b = body as Record<string, string>;
      if (Object.keys(b).sort().join() !== "alias,auth_config_id,callback_url,user_id" || !this.authConfigs.has(b.auth_config_id!))
        return this.#json(res, 400, { error: { message: "bad", code: 400, slug: "bad_request", status: 400 } });
      const fault = this.faults.link;
      if (fault === "500" || fault === "429") { this.#fault("link", res); return; }
      if ([...this.accounts.values()].some(a => a.userId === b.user_id && a.alias === b.alias))
        return this.#json(res, 400, { error: { message: "alias", code: 400, slug: "alias_conflict", status: 400 } });
      const id = `ca_${++this.#counter}${randomBytes(4).toString("hex")}`;
      this.accounts.set(id, { id, toolkit: this.authConfigs.get(b.auth_config_id!)!, authConfigId: b.auth_config_id!, userId: b.user_id!, alias: b.alias!, status: "INITIATED",
        displayName: null, disabled: false, createdAt: new Date().toISOString(), email: null });
      if (this.#fault("link", res) === "drop") return drop();
      const token = `lk_${randomBytes(12).toString("hex")}`;
      return this.#json(res, 201, { link_token: token, redirect_url: `${LINK_ORIGIN}/link/${token}`, expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        connected_account_id: id, experimental: { account_type: "PRIVATE" } });
    }
    if (req.method === "GET" && path === "/api/v3.1/connected_accounts") {
      const listFault = this.#fault("list", res);
      if (listFault === "drop") return drop();
      if (listFault) return;
      let items = [...this.accounts.values()];
      if (query.user_ids) items = items.filter(a => query.user_ids!.includes(a.userId));
      if (query.toolkit_slugs) items = items.filter(a => query.toolkit_slugs!.includes(a.toolkit));
      if (query.connected_account_ids) items = items.filter(a => query.connected_account_ids!.includes(a.id));
      return this.#json(res, 200, { items: items.map(a => this.#view(a)), next_cursor: null, total_pages: 1, current_page: 1, total_items: items.length });
    }
    const one = /^\/api\/v3\.1\/connected_accounts\/([A-Za-z0-9_-]+)$/.exec(path);
    if (one && req.method === "GET") {
      const a = this.accounts.get(one[1]!);
      return a ? this.#json(res, 200, this.#view(a)) : this.#json(res, 404, { error: { message: "absent", code: 404, slug: "not_found", status: 404 } });
    }
    if (one && req.method === "DELETE") {
      const a = this.accounts.get(one[1]!);
      if (!a) return this.#json(res, 404, { error: { message: "absent", code: 404, slug: "not_found", status: 404 } });
      const fault = this.faults.delete;
      if (fault === "500" || fault === "429") { this.#fault("delete", res); return; }
      this.accounts.delete(a.id);
      if (this.#fault("delete", res) === "drop") return drop();
      return this.#json(res, 200, { success: true, ...(url.searchParams.get("revoke_on_delete") === "true" ? { revoke_job_id: "job_synthetic" } : {}) });
    }
    const kit = /^\/api\/v3\.1\/toolkits\/([a-z0-9_-]+)$/.exec(path);
    if (kit && req.method === "GET") {
      const endpoint = this.identityEndpoints.get(kit[1]!);
      return this.#json(res, 200, { slug: kit[1], name: kit[1], type: "native", enabled: true, base_url: "https://gmail.googleapis.com",
        ...(endpoint ? { get_current_user_endpoint: endpoint, get_current_user_endpoint_method: "GET" } : {}), meta: { description: "synthetic" } });
    }
    if (req.method === "POST" && path === "/api/v3.1/tools/execute/proxy") {
      const b = body as Record<string, unknown>, a = this.accounts.get(b.connected_account_id as string);
      if (Object.keys(b).sort().join() !== "connected_account_id,endpoint,method" || b.method !== "GET" || !a || a.status !== "ACTIVE")
        return this.#json(res, 400, { error: { message: "bad", code: 400, slug: "bad_request", status: 400 } });
      const fault = this.faults.proxy;
      if (fault === "500" || fault === "429") { this.#fault("proxy", res); return; }
      if (this.#fault("proxy", res) === "drop") return drop();
      if (b.endpoint !== this.identityEndpoints.get(a.toolkit)) return this.#json(res, 200, { status: 404, data: null, headers: {} });
      return this.#json(res, 200, { status: a.email ? 200 : 401, data: a.email ? { emailAddress: a.email, messagesTotal: 3 } : { error: "unauthorized" }, headers: { "content-type": "application/json" } });
    }
    const exec = /^\/api\/v3\.1\/tools\/execute\/([A-Z0-9_]+)$/.exec(path);
    if (exec && req.method === "POST") {
      const b = body as Record<string, unknown>, a = this.accounts.get(b.connected_account_id as string);
      if (Object.keys(b).sort().join() !== "arguments,connected_account_id,user_id,version" || !a || a.userId !== b.user_id || a.status !== "ACTIVE")
        return this.#json(res, 400, { error: { message: "bad", code: 400, slug: "bad_request", status: 400 } });
      const fault = this.faults.execute;
      if (fault === "500" || fault === "429") { this.#fault("execute", res); return; }
      if (this.#fault("execute", res) === "drop") return drop();
      return this.#json(res, 200, { data: { slug: exec[1], version: b.version, echo: b.arguments }, error: null, successful: true, log_id: "log_synthetic" });
    }
    return this.#json(res, 404, { error: { message: "route", code: 404, slug: "not_found", status: 404 } });
  }
}

export interface ServiceLab {
  composio: FakeComposio; service: ConnectionsPlatformService; url: string; dir: string;
  capabilities: Map<string, ServicePrincipal>;
  issue(principal: ServicePrincipal): string;
  /** `between` runs while the service is stopped (e.g. to rewrite its database for a migration proof). */
  restart(between?: () => void | Promise<void>): Promise<void>;
  setCatalog(catalog: ServiceCatalogConfig[]): void;
}
export async function serviceLab(t: TestContext, options: { catalog?: ServiceCatalogConfig[]; clock?: () => number } = {}): Promise<ServiceLab> {
  const composio = new FakeComposio(); await composio.start();
  const dir = mkdtempSync(join(tmpdir(), "dx-connections-service-"));
  const capabilities = new Map<string, ServicePrincipal>();
  let catalog = options.catalog ?? CATALOG;
  const make = () => new ConnectionsPlatformService({ dataDir: dir, publicOrigin: SERVICE_ORIGIN, catalog,
    composio: { fetch: remapFetch({ [COMPOSIO_ORIGIN]: composio.url }), apiKey: () => COMPOSIO_KEY, authorizationOrigins: [LINK_ORIGIN], limits: { timeoutMs: 5_000 } },
    installations: { resolve: capability => capabilities.get(capability) ?? null }, ...(options.clock ? { clock: options.clock } : {}) });
  let service = make(), http = await listen(createConnectionsServiceApp(service));
  const lab: ServiceLab = {
    composio, get service() { return service; }, get url() { return http.url; }, dir, capabilities,
    issue: principal => { const capability = randomBytes(32).toString("base64url"); capabilities.set(capability, principal); return capability; },
    restart: async between => { await http.close(); service.close(); await between?.(); service = make(); http = await listen(createConnectionsServiceApp(service)); },
    setCatalog: next => { catalog = next; },
  } as ServiceLab;
  t.after(async () => { await http.close(); service.close(); await composio.close(); rmSync(dir, { recursive: true, force: true }); });
  return lab;
}

export interface HostLab {
  store: HostStore; gateway: CapabilityGateway; runtime: ConnectionsRuntime; url: string; dir: string; capability: string;
  hostFetchFault: { dropNextResponse: boolean };
  api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }>;
  /** `between` runs while the host is closed (e.g. to rewrite connections.sqlite for a migration proof). */
  reopen(between?: () => void | Promise<void>): Promise<void>;
  cap(botId: string): { token: string };
}
export async function hostLab(t: TestContext, service: ServiceLab, dir = mkdtempSync(join(tmpdir(), "dx-connections-host-"))): Promise<HostLab> {
  let store = new HostStore({ dataDir: dir });
  const capability = service.issue({ installationId: store.hostId, ownerId: store.ownerId });
  const fault = { dropNextResponse: false };
  // Lost ACK between host and service: the service processes the request, the response never reaches the host.
  // Resolved per request: a restarted service listens on a new random port.
  const base = remapFetch({ get [SERVICE_ORIGIN]() { return service.url; } });
  const hostFetch: FetchLike = async (url, init) => {
    const response = await base(url, init);
    if (fault.dropNextResponse) { fault.dropNextResponse = false; await response.body?.cancel(); throw new TypeError("synthetic connection reset"); }
    return response;
  };
  const open = () => {
    const runtime = new ConnectionsRuntime({ identity: { installationId: store.hostId, ownerId: store.ownerId }, credentialRef: "cred-connections",
      platform: { origin: SERVICE_ORIGIN, capability: () => capability, fetch: hostFetch, limits: { timeoutMs: 5_000 } } });
    const gateway = new CapabilityGateway({ store, broker: runtime.broker, adapter: runtime.adapter });
    runtime.bind(store, gateway);
    return { runtime, gateway };
  };
  let parts = open(), http = await listen(createHostApp(store, { connections: connectionsHttpPort(() => parts.runtime.admin) }));
  const lab: HostLab = {
    get store() { return store; }, get gateway() { return parts.gateway; }, get runtime() { return parts.runtime; }, get url() { return http.url; }, dir, capability,
    hostFetchFault: fault,
    api: async (method, path, body) => {
      const response = await fetch(http.url + path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, json: await response.json() };
    },
    reopen: async between => {
      await http.close(); await parts.runtime.close(); parts.gateway.close(); store.close();
      await between?.();
      store = new HostStore({ dataDir: dir }); parts = open();
      http = await listen(createHostApp(store, { connections: connectionsHttpPort(() => parts.runtime.admin) }));
    },
    cap: botId => {
      const thread = store.createThread(botId), turn = store.createTurn(thread.id, { clientRequestId: `turn-${randomBytes(4).toString("hex")}`, content: "synthetic" }).turn;
      store.claimNextTurn(thread.id);
      return parts.gateway.issueCapability({ turnId: turn.id });
    },
  } as HostLab;
  t.after(async () => { await http.close(); await parts.runtime.close().catch(() => undefined); parts.gateway.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return lab;
}
