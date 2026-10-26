import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  discoverAuthorizationServerMetadata, discoverOAuthServerInfo, exchangeAuthorization, OAuthError, OAuthErrorCode, refreshAuthorization, registerClient, startAuthorization,
  type AuthorizationServerMetadata, type FetchLike, type OAuthClientInformationMixed, type OAuthTokens,
} from "@modelcontextprotocol/client";
import { LOOPBACK_HOSTS, type McpServerDefinition } from "./definition.js";
import { McpConnectorError, type McpErrorCode } from "./errors.js";

/** Session credential key under which the OAuth access token is handed to the MCP session (never a definition slot). */
export const MCP_OAUTH_ACCESS_KEY = "oauth.access_token";

/**
 * Tokens of one server, bound to the issuer that minted them and to the pinned resource they may be sent to. Every
 * secret field lives only in process memory and in the trusted token store. Never in a definition, preview, log,
 * error, admin answer or engine-visible value.
 */
export interface McpOAuthTokens {
  serverId: string;
  /** Pinned MCP endpoint of the definition (the only place the access token is ever sent). */
  resource: string;
  /** RFC 8707 resource indicator sent to the authorization server (PRM `resource`, or the endpoint). */
  resourceIndicator: string;
  /** Validated issuer (RFC 8414 echo). Refresh re-discovers it and requires the same token endpoint. */
  issuer: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string | null;
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms, or null when the server gave no lifetime. */
  expiresAt: number | null;
  scope: string | null;
}

/**
 * Trusted custody of OAuth tokens (async: Keychain on the Mac, the operator's encrypted file on a VPS). The default is
 * process memory only (`MemoryMcpOAuthTokenStore`): tokens are lost on restart and the owner authorizes again. There
 * is no plaintext token file and nothing is read from personal OAuth stores or other apps' authfiles.
 */
export interface McpOAuthTokenStore {
  load(serverId: string): Promise<McpOAuthTokens | null>;
  save(tokens: McpOAuthTokens): Promise<void>;
  remove(serverId: string): Promise<void>;
}
export class MemoryMcpOAuthTokenStore implements McpOAuthTokenStore {
  readonly #tokens = new Map<string, McpOAuthTokens>();
  async load(serverId: string): Promise<McpOAuthTokens | null> { const t = this.#tokens.get(serverId); return t ? { ...t } : null; }
  async save(tokens: McpOAuthTokens): Promise<void> { this.#tokens.set(tokens.serverId, Object.freeze({ ...tokens })); }
  async remove(serverId: string): Promise<void> { this.#tokens.delete(serverId); }
}

export interface McpOAuthOptions {
  store?: McpOAuthTokenStore;
  /** Network fetch for discovery, registration and token requests. Default: globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** How long a started authorization waits for its callback. Default 10 minutes, max 30. */
  flowTimeoutMs?: number;
  /** Fixed loopback callback port for a pre-registered client that does not accept any port. Default: ephemeral. */
  callbackPort?: number;
  clientName?: string;
}
export interface McpOAuthStart {
  /** Authorization request to open in the owner's browser. Carries state and the PKCE challenge, never a secret. */
  authorizationUrl: string;
  /** Validated issuer origin, shown to the owner before approving. */
  issuer: string;
  expiresAt: number;
}
export interface McpOAuthState {
  state: "none" | "authorizing" | "authorized" | "expired";
  issuer: string | null;
  expiresAt: number | null;
  /** Fixed code of the last failed authorization or refresh, if any. */
  lastError: McpErrorCode | null;
}

const MAX_BODY = 256 * 1024;
const TOKEN = /^[\x21-\x7e]{1,8192}$/;
const SCOPE = /^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/;
const CLIENT_ID = /^[\x21-\x7e]{1,512}$/;
const EXPIRY_SKEW_MS = 30_000;
const CALLBACK_PATH = "/oauth/callback";

const fixed = (code: McpErrorCode): McpConnectorError => new McpConnectorError(code);
/** Pinned resource of a definition: the validated endpoint (no userinfo, query or fragment). */
export function oauthResourceOf(definition: McpServerDefinition): string {
  if (definition.auth !== "oauth" || definition.transport.type !== "streamable_http") throw fixed("oauth_unavailable");
  return new URL(definition.transport.url).href;
}

/**
 * Fetch for OAuth discovery, registration and token requests: https only (plain http only on loopback, and only when
 * the pinned resource itself is loopback), no userinfo, never follows a redirect, no cookies, bounded body. Errors are
 * fixed codes: an authorization server's error text never reaches a log or the owner verbatim.
 */
function oauthFetch(base: typeof globalThis.fetch, allowLoopbackHttp: boolean): FetchLike {
  return async (input, init) => {
    let url: URL;
    try { url = new URL(input instanceof URL ? input.href : String(input)); } catch { throw fixed("origin_refused"); }
    const loopback = LOOPBACK_HOSTS.has(url.hostname);
    if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && loopback && allowLoopbackHttp))) throw fixed("origin_refused");
    let response: Response;
    try {
      response = await base(url.href, { ...init, redirect: "manual", cache: "no-store", credentials: "omit" });
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      throw fixed("transport_failed");
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      try { await response.body?.cancel(); } catch { /* discarded */ }
      throw fixed("upstream_redirect");
    }
    const declared = Number(response.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      try { await response.body?.cancel(); } catch { /* discarded */ }
      throw fixed("response_too_large");
    }
    const body = new Uint8Array(await boundedBody(response));
    return new Response(response.status === 204 || response.status === 304 ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
async function boundedBody(response: Response): Promise<ArrayBuffer> {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) { try { await reader.cancel(); } catch { /* discarded */ } throw fixed("response_too_large"); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out.buffer;
}

function endpointAllowed(raw: unknown, allowLoopbackHttp: boolean): boolean {
  if (typeof raw !== "string") return false;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.username || url.password || url.hash) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && allowLoopbackHttp && LOOPBACK_HOSTS.has(url.hostname));
}

/** Authorization server metadata the flow accepts: issuer echoed (checked by the SDK), PKCE S256 advertised, code flow. */
function checkMetadata(metadata: AuthorizationServerMetadata | undefined, allowLoopbackHttp: boolean): AuthorizationServerMetadata {
  if (!metadata || typeof metadata.issuer !== "string" || !endpointAllowed(metadata.issuer, allowLoopbackHttp)) throw fixed("oauth_metadata_invalid");
  // MCP authorization: a client must refuse when S256 is not advertised (absence included).
  if (!Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes("S256")) throw fixed("oauth_metadata_invalid");
  if (!Array.isArray(metadata.response_types_supported) || !metadata.response_types_supported.includes("code")) throw fixed("oauth_metadata_invalid");
  if (!endpointAllowed(metadata.authorization_endpoint, allowLoopbackHttp) || !endpointAllowed(metadata.token_endpoint, allowLoopbackHttp)) throw fixed("oauth_metadata_invalid");
  if (metadata.registration_endpoint !== undefined && !endpointAllowed(metadata.registration_endpoint, allowLoopbackHttp)) throw fixed("oauth_metadata_invalid");
  return metadata;
}

/** The PRM `resource` must be the pinned endpoint or a path prefix of it, on the same origin. */
function resourceIndicator(pinned: URL, advertised: unknown): string {
  if (advertised === undefined) return pinned.href;
  if (typeof advertised !== "string") throw fixed("oauth_metadata_invalid");
  let r: URL;
  try { r = new URL(advertised); } catch { throw fixed("oauth_metadata_invalid"); }
  if (r.origin !== pinned.origin || r.search || r.hash || !pinned.href.startsWith(r.href.replace(/\/$/, ""))) throw fixed("oauth_metadata_invalid");
  return r.href;
}

function tokensOf(raw: OAuthTokens, now: number): { accessToken: string; refreshToken: string | null; expiresAt: number | null; scope: string | null } {
  if (typeof raw?.access_token !== "string" || !TOKEN.test(raw.access_token)) throw fixed("oauth_flow_failed");
  // Bearer only: a DPoP- or otherwise-bound token would be attached wrongly.
  if (typeof raw.token_type !== "string" || raw.token_type.toLowerCase() !== "bearer") throw fixed("oauth_flow_failed");
  const refresh = raw.refresh_token;
  if (refresh !== undefined && (typeof refresh !== "string" || !TOKEN.test(refresh))) throw fixed("oauth_flow_failed");
  const expiresIn = raw.expires_in;
  if (expiresIn !== undefined && (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn < 0)) throw fixed("oauth_flow_failed");
  const scope = typeof raw.scope === "string" && SCOPE.test(raw.scope) && raw.scope.length <= 1024 ? raw.scope : null;
  return { accessToken: raw.access_token, refreshToken: refresh ?? null, expiresAt: expiresIn === undefined ? null : now + Math.floor(expiresIn * 1000), scope };
}

const PAGE = (title: string): string =>
  `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Dexter</title><body><p>${title}</p></body></html>`;
const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

interface Flow {
  serverId: string;
  server: Server;
  state: string;
  timer: NodeJS.Timeout;
  expiresAt: number;
  issuer: string;
  done: boolean;
  completion: Promise<void>;
  settle: () => void;
}

/**
 * Minimal local OAuth 2.1 client for native MCP servers, on the official SDK helpers: RFC 9728 protected-resource and
 * RFC 8414 authorization-server discovery (issuer echo validated), PKCE S256 (required), random state checked in
 * constant time, RFC 8707 resource indicator, RFC 9207 `iss` checked when the server supports it, optional dynamic
 * client registration (public client, `none` auth) or an owner-supplied client id, and a one-shot loopback callback
 * on 127.0.0.1 (RFC 8252) that answers fixed pages and never echoes parameters.
 *
 * The owner approves in their own browser; nothing here approves a grant, and an authorization grants no bot anything
 * (bot tools still need selection with `ask`). Tokens go to the trusted token store and process memory only, and are
 * attached only to the definition's pinned endpoint by the MCP session.
 */
export class McpOAuthClient {
  readonly #store: McpOAuthTokenStore;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #flowTimeoutMs: number;
  readonly #callbackPort: number;
  readonly #clientName: string;
  readonly #tokens = new Map<string, McpOAuthTokens>();
  readonly #flows = new Map<string, Flow>();
  readonly #errors = new Map<string, McpErrorCode>();
  readonly #refreshing = new Map<string, Promise<void>>();
  readonly #generation = new Map<string, number>();
  #closed = false;

  constructor(options: McpOAuthOptions = {}) {
    const timeout = options.flowTimeoutMs ?? 10 * 60_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 30 * 60_000) throw new McpConnectorError("invalid_definition", "flowTimeoutMs");
    const port = options.callbackPort ?? 0;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new McpConnectorError("invalid_definition", "callbackPort");
    const name = options.clientName ?? "Dexter";
    if (typeof name !== "string" || !/^[\x20-\x7e]{1,64}$/.test(name)) throw new McpConnectorError("invalid_definition", "clientName");
    this.#store = options.store ?? new MemoryMcpOAuthTokenStore();
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#flowTimeoutMs = timeout;
    this.#callbackPort = port;
    this.#clientName = name;
  }

  status(definition: McpServerDefinition): McpOAuthState {
    const id = definition.id;
    const lastError = this.#errors.get(id) ?? null;
    const flow = this.#flows.get(id);
    if (flow && !flow.done) return { state: "authorizing", issuer: flow.issuer, expiresAt: flow.expiresAt, lastError };
    const t = this.#bound(definition);
    if (!t) return { state: "none", issuer: null, expiresAt: null, lastError };
    const expired = t.expiresAt !== null && this.#now() >= t.expiresAt - EXPIRY_SKEW_MS;
    return { state: expired ? "expired" : "authorized", issuer: t.issuer, expiresAt: t.expiresAt, lastError };
  }

  /**
   * Starts an authorization for an `oauth` definition: discovery, client (owner id or dynamic registration), PKCE and
   * the loopback callback. Returns the URL the owner opens. A previous pending flow for the server is cancelled.
   */
  async begin(definition: McpServerDefinition, input: { clientId?: string; scope?: string } = {}, signal?: AbortSignal): Promise<McpOAuthStart> {
    if (this.#closed) throw fixed("closed");
    const pinned = new URL(oauthResourceOf(definition));
    if (input.clientId !== undefined && (typeof input.clientId !== "string" || !CLIENT_ID.test(input.clientId))) throw fixed("invalid_request");
    if (input.scope !== undefined && (typeof input.scope !== "string" || input.scope.length > 1024 || !SCOPE.test(input.scope))) throw fixed("invalid_request");
    this.#cancel(definition.id);
    const generation = this.#bump(definition.id);
    const allowLoopbackHttp = pinned.protocol === "http:";
    const fetchFn = oauthFetch(this.#fetch, allowLoopbackHttp);
    try {
      let info;
      try { info = await discoverOAuthServerInfo(pinned, { fetchFn }); } catch { throw fixed("oauth_metadata_invalid"); }
      if (signal?.aborted) throw fixed("aborted");
      const metadata = checkMetadata(info.authorizationServerMetadata, allowLoopbackHttp);
      const indicator = resourceIndicator(pinned, info.resourceMetadata?.resource);
      const advertised = info.resourceMetadata?.scopes_supported;
      const scope = input.scope ?? (Array.isArray(advertised) && advertised.every((s) => typeof s === "string" && SCOPE.test(s)) && advertised.length > 0 ? advertised.join(" ") : undefined);
      if (scope !== undefined && (scope.length > 1024 || !SCOPE.test(scope))) throw fixed("oauth_metadata_invalid");

      const { server, redirect } = await this.#listen();
      try {
        let client: OAuthClientInformationMixed;
        if (input.clientId !== undefined) client = { client_id: input.clientId };
        else if (metadata.registration_endpoint) {
          try {
            client = await registerClient(metadata.issuer, {
              metadata, fetchFn, ...(scope === undefined ? {} : { scope }),
              clientMetadata: {
                client_name: this.#clientName, redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"], token_endpoint_auth_method: "none",
              },
            });
          } catch { throw fixed("oauth_client_required"); }
          if (typeof client.client_id !== "string" || !CLIENT_ID.test(client.client_id)) throw fixed("oauth_client_required");
          const secret = (client as { client_secret?: unknown }).client_secret;
          if (secret !== undefined && (typeof secret !== "string" || !TOKEN.test(secret))) throw fixed("oauth_client_required");
        } else throw fixed("oauth_client_required");
        if (signal?.aborted || this.#closed || this.#generation.get(definition.id) !== generation) throw fixed("aborted");

        const state = randomBytes(32).toString("base64url");
        let started;
        try {
          started = await startAuthorization(metadata.issuer, { metadata, clientInformation: client, redirectUrl: redirect, state, resource: indicator, ...(scope === undefined ? {} : { scope }) });
        } catch { throw fixed("oauth_metadata_invalid"); }
        const expiresAt = this.#now() + this.#flowTimeoutMs;
        let settle!: () => void;
        const completion = new Promise<void>((resolve) => { settle = resolve; });
        const flow: Flow = {
          serverId: definition.id, server, state, expiresAt, issuer: metadata.issuer, done: false, completion, settle,
          timer: setTimeout(() => { this.#finish(flow, "oauth_expired"); }, this.#flowTimeoutMs),
        };
        flow.timer.unref();
        const verifier = started.codeVerifier;
        server.on("request", (req, res) => {
          const answer = (status: number, text: string): void => {
            res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" }).end(PAGE(text));
          };
          const port = (server.address() as AddressInfo).port;
          let url: URL;
          try { url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`); } catch { answer(400, "Pedido inválido."); return; }
          // Exact host (DNS rebinding) and path; GET only; a request without the flow's state never touches it.
          if (req.method !== "GET" || req.headers.host !== `127.0.0.1:${port}` || url.pathname !== CALLBACK_PATH) { answer(404, "Não encontrado."); return; }
          const got = url.searchParams.get("state");
          if (flow.done || got === null || !sameSecret(got, state)) { answer(400, "Autorização não reconhecida."); return; }
          flow.done = true;
          const error = url.searchParams.get("error");
          const code = url.searchParams.get("code");
          if (error !== null || code === null || code.length === 0 || code.length > 4096) {
            answer(400, "Autorização não concluída. Volte ao Dexter.");
            this.#finish(flow, error !== null ? "oauth_denied" : "oauth_flow_failed");
            return;
          }
          const iss = url.searchParams.get("iss") ?? undefined;
          void exchangeAuthorization(metadata.issuer, {
            metadata, clientInformation: client, authorizationCode: code, codeVerifier: verifier, redirectUri: redirect, resource: indicator, fetchFn,
            ...(iss === undefined ? {} : { iss }),
          }).then(async (raw) => {
            const t = tokensOf(raw, this.#now());
            if (this.#closed || this.#generation.get(definition.id) !== generation) throw fixed("aborted");
            const record: McpOAuthTokens = Object.freeze({
              serverId: definition.id, resource: pinned.href, resourceIndicator: indicator, issuer: metadata.issuer, tokenEndpoint: metadata.token_endpoint,
              clientId: client.client_id, clientSecret: typeof (client as { client_secret?: unknown }).client_secret === "string" ? (client as { client_secret: string }).client_secret : null,
              ...t,
            });
            await this.#store.save(record);
            if (this.#closed || this.#generation.get(definition.id) !== generation) { await this.#store.remove(definition.id).catch(() => undefined); throw fixed("aborted"); }
            this.#tokens.set(definition.id, record);
            answer(200, "Autorização recebida. Você pode fechar esta janela e voltar ao Dexter.");
            this.#finish(flow, null);
          }).catch((e: unknown) => {
            answer(400, "Autorização não concluída. Volte ao Dexter.");
            this.#finish(flow, e instanceof McpConnectorError && e.code === "aborted" ? "aborted" : "oauth_flow_failed");
          });
        });
        this.#flows.set(definition.id, flow);
        this.#errors.delete(definition.id);
        return { authorizationUrl: started.authorizationUrl.href, issuer: metadata.issuer, expiresAt };
      } catch (error) {
        server.closeAllConnections();
        server.close();
        throw error;
      }
    } catch (error) {
      const e = error instanceof McpConnectorError ? error : fixed("oauth_flow_failed");
      if (e.code !== "aborted") this.#errors.set(definition.id, e.code);
      throw e;
    }
  }

  /** Resolves when the pending flow (if any) ends, successfully or not. Tests and the UI's poll use it. */
  async settled(serverId: string): Promise<void> { await this.#flows.get(serverId)?.completion; }

  /** Loads tokens from the trusted store (explicit owner action), refreshing them when expired. */
  async restore(definition: McpServerDefinition): Promise<McpOAuthState> {
    if (this.#closed) throw fixed("closed");
    const generation = this.#generation.get(definition.id) ?? 0;
    if (!this.#tokens.has(definition.id)) {
      let loaded: McpOAuthTokens | null;
      try { loaded = await this.#store.load(definition.id); } catch { throw fixed("custody_unavailable"); }
      if (this.#closed || (this.#generation.get(definition.id) ?? 0) !== generation) throw fixed("aborted");
      if (loaded && this.#valid(loaded, definition)) this.#tokens.set(definition.id, Object.freeze({ ...loaded }));
    }
    const t = this.#bound(definition);
    if (t && t.expiresAt !== null && this.#now() >= t.expiresAt - EXPIRY_SKEW_MS && t.refreshToken) await this.refresh(definition);
    return this.status(definition);
  }

  /**
   * Access token for the definition's pinned endpoint, or null (no authorization, another resource, or expired). With
   * `refreshExpired` (gateway calls only), an expired token with a refresh token starts one background refresh; the
   * current call still fails closed.
   */
  access(definition: McpServerDefinition, refreshExpired = false): string | null {
    const t = this.#bound(definition);
    if (!t) return null;
    if (t.expiresAt !== null && this.#now() >= t.expiresAt - EXPIRY_SKEW_MS) {
      if (refreshExpired && t.refreshToken && !this.#closed) void this.refresh(definition).catch(() => undefined);
      return null;
    }
    return t.accessToken;
  }

  /** Refresh against the same issuer and token endpoint (re-discovered and compared). invalid_grant drops the tokens. */
  refresh(definition: McpServerDefinition): Promise<void> {
    const id = definition.id;
    const running = this.#refreshing.get(id);
    if (running) return running;
    const t = this.#bound(definition);
    if (!t?.refreshToken) return Promise.reject(fixed("needs_auth"));
    const generation = this.#generation.get(id) ?? 0;
    const allowLoopbackHttp = new URL(t.resource).protocol === "http:";
    const fetchFn = oauthFetch(this.#fetch, allowLoopbackHttp);
    // Registered before it runs (later microtask), so the cleanup by identity always finds it.
    const task: Promise<void> = Promise.resolve().then(async () => {
      try {
        let metadata: AuthorizationServerMetadata;
        try { metadata = checkMetadata(await discoverAuthorizationServerMetadata(t.issuer, { fetchFn }), allowLoopbackHttp); } catch { throw fixed("oauth_metadata_invalid"); }
        if (metadata.issuer !== t.issuer || metadata.token_endpoint !== t.tokenEndpoint) throw fixed("oauth_metadata_invalid");
        let raw: OAuthTokens;
        try {
          raw = await refreshAuthorization(t.issuer, {
            metadata, refreshToken: t.refreshToken!, resource: t.resourceIndicator, fetchFn,
            clientInformation: { client_id: t.clientId, ...(t.clientSecret === null ? {} : { client_secret: t.clientSecret }) },
          });
        } catch (error) {
          // The grant is gone (revoked/expired refresh token): forget it, the owner authorizes again.
          if (error instanceof OAuthError && error.code === OAuthErrorCode.InvalidGrant) {
            await this.#forget(id, generation);
            throw fixed("needs_auth");
          }
          throw fixed("oauth_flow_failed");
        }
        const next = tokensOf(raw, this.#now());
        if (this.#closed || (this.#generation.get(id) ?? 0) !== generation) throw fixed("aborted");
        const record: McpOAuthTokens = Object.freeze({ ...t, ...next, refreshToken: next.refreshToken ?? t.refreshToken });
        await this.#store.save(record);
        if (this.#closed || (this.#generation.get(id) ?? 0) !== generation) throw fixed("aborted");
        this.#tokens.set(id, record);
        this.#errors.delete(id);
      } catch (error) {
        const e = error instanceof McpConnectorError ? error : fixed("oauth_flow_failed");
        if (e.code !== "aborted") this.#errors.set(id, e.code);
        throw e;
      } finally {
        if (this.#refreshing.get(id) === task) this.#refreshing.delete(id);
      }
    });
    this.#refreshing.set(id, task);
    return task;
  }

  /** Drops tokens from memory only (lock): they stay in the trusted store for a later restore. */
  lock(serverId: string): void {
    this.#cancel(serverId);
    this.#bump(serverId);
    this.#tokens.delete(serverId);
  }

  /** Removes the authorization: memory and trusted store. Remote revocation at the issuer is not attempted. */
  async disconnect(serverId: string): Promise<void> {
    this.lock(serverId);
    this.#errors.delete(serverId);
    try { await this.#store.remove(serverId); } catch { throw fixed("custody_unavailable"); }
  }

  secretValues(): string[] {
    return [...this.#tokens.values()].flatMap((t) => [t.accessToken, `Bearer ${t.accessToken}`, ...(t.refreshToken ? [t.refreshToken] : []), ...(t.clientSecret ? [t.clientSecret] : [])]);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const id of [...this.#flows.keys()]) this.#cancel(id);
    await Promise.allSettled([...this.#refreshing.values()]);
    this.#tokens.clear();
  }

  get pendingFlows(): number { return [...this.#flows.values()].filter((f) => !f.done).length; }

  // ---- internals -------------------------------------------------------------------------------

  #bound(definition: McpServerDefinition): McpOAuthTokens | null {
    const t = this.#tokens.get(definition.id);
    return t && this.#valid(t, definition) ? t : null;
  }
  /** Tokens are usable only for the same server and the same pinned endpoint they were issued for. */
  #valid(t: McpOAuthTokens, definition: McpServerDefinition): boolean {
    let resource: string;
    try { resource = oauthResourceOf(definition); } catch { return false; }
    return t.serverId === definition.id && t.resource === resource && typeof t.accessToken === "string" && TOKEN.test(t.accessToken)
      && typeof t.issuer === "string" && typeof t.tokenEndpoint === "string" && typeof t.clientId === "string";
  }
  #bump(id: string): number {
    const next = (this.#generation.get(id) ?? 0) + 1;
    this.#generation.set(id, next);
    return next;
  }
  async #forget(id: string, generation: number): Promise<void> {
    if ((this.#generation.get(id) ?? 0) !== generation) return;
    this.#tokens.delete(id);
    try { await this.#store.remove(id); } catch { /* memory already dropped; custody reports on the next load */ }
  }
  async #listen(): Promise<{ server: Server; redirect: string }> {
    const server = createServer();
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.#callbackPort, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
    } catch { throw fixed("oauth_unavailable"); }
    server.unref();
    return { server, redirect: `http://127.0.0.1:${(server.address() as AddressInfo).port}${CALLBACK_PATH}` };
  }
  #finish(flow: Flow, error: McpErrorCode | null): void {
    flow.done = true;
    clearTimeout(flow.timer);
    if (error !== null && error !== "aborted") this.#errors.set(flow.serverId, error);
    // Let the fixed answer page flush before the listener goes away.
    setImmediate(() => { flow.server.closeAllConnections(); flow.server.close(); });
    flow.settle();
  }
  #cancel(id: string): void {
    const flow = this.#flows.get(id);
    if (!flow) return;
    this.#flows.delete(id);
    if (!flow.done) this.#finish(flow, "aborted");
    else { flow.server.closeAllConnections(); flow.server.close(); }
  }
}
