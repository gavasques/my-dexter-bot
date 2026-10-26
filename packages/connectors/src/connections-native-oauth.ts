import { randomUUID } from "node:crypto";
import type { McpOAuthStoreBinding, McpOAuthStoreDurability, McpOAuthTokens, McpOAuthTokenStore } from "./mcp/oauth.js";

/**
 * Durable native MCP OAuth custody (UX-P1-10), host side. The Apple app is the custodian (Data Protection Keychain,
 * exact signed access group); the host reaches it only over the app-owned private channel of its own launcher. This
 * module never stores a token on disk, in defaults, argv, env, logs, events, journals or HTTP.
 *
 * - Scope: installation + owner (both from the canonical store, never from a body). Native MCP instances are owner-level;
 *   profiles/bots reach them only through selections and hub grants, which restore never changes.
 * - Key: scope + server instance + `instancePin` (definition hash + registration generation) + pinned `resource`. A
 *   recreated instance or a changed endpoint never receives older tokens; the custodian answers `absent`.
 * - `remove` deletes every stored generation of that instance (removal, disconnect, invalid grant).
 * - `durability()` is `durable` only after the custodian itself confirmed real custody (`status` exchange). Unverified,
 *   unavailable or refused custody is reported as such and never replaced by a file or another store.
 * - One exchange per call with a deadline; a timed-out SAVE is unknown to the host and is not retried here.
 */
export const MCP_OAUTH_CUSTODY_VERSION = 1 as const;
/** Bounded so one frame always fits the private channel (16 KiB lines). Larger token sets are refused, not truncated. */
export const MCP_OAUTH_CUSTODY_MAX_FRAME_BYTES = 15_000;
export interface McpOAuthCustodyScope { installationId: string; ownerId: string }
export interface McpOAuthCustodyKey extends McpOAuthCustodyScope { serverId: string; instancePin: string; resource: string }
export type McpOAuthCustodyRequest =
  | { v: 1; type: "mcp_oauth_custody.status"; requestId: string; scope: McpOAuthCustodyScope }
  | { v: 1; type: "mcp_oauth_custody.load"; requestId: string; key: McpOAuthCustodyKey }
  | { v: 1; type: "mcp_oauth_custody.save"; requestId: string; key: McpOAuthCustodyKey; tokens: McpOAuthTokens }
  | { v: 1; type: "mcp_oauth_custody.remove"; requestId: string; scope: McpOAuthCustodyScope; serverId: string };
export interface McpOAuthCustodyResponse {
  v: 1; type: "mcp_oauth_custody.result"; requestId: string;
  status: "ok" | "absent" | "refused" | "unavailable";
  /** Only for `load` with `ok`. */
  tokens?: McpOAuthTokens;
  /** Only for `status` with `ok`: the custody the app actually holds. */
  custody?: "data_protection_keychain";
}
/** App-owned private channel. Implemented by the trusted embedding (stdout request line ↔ stdin result frame). */
export interface McpOAuthCustodyChannel { exchange(request: McpOAuthCustodyRequest, signal: AbortSignal): Promise<unknown> }
export class McpOAuthCustodyError extends Error {
  constructor(readonly code: "unavailable" | "refused" | "invalid_response" | "timeout") { super(`mcp oauth custody: ${code}`); this.name = "McpOAuthCustodyError"; }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SERVER = /^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const PIN = /^[0-9a-f]{64}$/;
const TOKEN_KEYS = ["accessToken", "clientId", "clientSecret", "expiresAt", "issuer", "refreshToken", "resource", "resourceIndicator", "scope", "serverId", "tokenEndpoint"];

/** Exact token record shape; values bounded like the OAuth client. */
export function validMcpOAuthCustodyTokens(value: unknown, serverId: string, resource?: string): value is McpOAuthTokens {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const t = value as Record<string, unknown>;
  if (Object.keys(t).sort().join() !== TOKEN_KEYS.join() || t.serverId !== serverId || (resource !== undefined && t.resource !== resource)) return false;
  const str = (k: string, nullable = false) => (nullable && t[k] === null) || (typeof t[k] === "string" && (t[k] as string).length > 0 && (t[k] as string).length <= 8192);
  return ["resource", "resourceIndicator", "issuer", "tokenEndpoint", "clientId", "accessToken"].every(k => str(k)) && ["clientSecret", "refreshToken", "scope"].every(k => str(k, true))
    && (t.expiresAt === null || (typeof t.expiresAt === "number" && Number.isSafeInteger(t.expiresAt) && t.expiresAt >= 0));
}
function validResource(value: string): boolean {
  try { const u = new URL(value); return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password && !u.hash && u.href === value && value.length <= 2048; }
  catch { return false; }
}

export interface PrivateChannelMcpOAuthTokenStoreOptions {
  /** Canonical store identity, resolved late (null until the host store is open). */
  scope: () => McpOAuthCustodyScope | null;
  /** Native instance pin (definition + registration generation) from the runtime. */
  instancePin: (serverId: string) => string;
  channel: McpOAuthCustodyChannel;
  timeoutMs?: number;
}

export class PrivateChannelMcpOAuthTokenStore implements McpOAuthTokenStore {
  readonly #scope: () => McpOAuthCustodyScope | null;
  readonly #pin: (serverId: string) => string;
  readonly #channel: McpOAuthCustodyChannel;
  readonly #timeoutMs: number;
  #state: McpOAuthStoreDurability = "unverified";
  #verifying: Promise<McpOAuthStoreDurability> | null = null;

  constructor(options: PrivateChannelMcpOAuthTokenStoreOptions) {
    if (typeof options?.scope !== "function" || typeof options.instancePin !== "function" || typeof options.channel?.exchange !== "function") throw new McpOAuthCustodyError("refused");
    const timeout = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60_000) throw new McpOAuthCustodyError("refused");
    this.#scope = options.scope; this.#pin = options.instancePin; this.#channel = options.channel; this.#timeoutMs = timeout;
    Object.seal(this);
  }
  /** `durable` only after the custodian confirmed custody. Never inferred from configuration. */
  durability(): McpOAuthStoreDurability { return this.#state; }

  /** Custody handshake (single flight). Unavailable custody can be verified again later (e.g. after the app unlocks). */
  verify(): Promise<McpOAuthStoreDurability> {
    if (this.#state === "durable") return Promise.resolve("durable");
    if (this.#verifying) return this.#verifying;
    const flight = (async (): Promise<McpOAuthStoreDurability> => {
      try {
        const scope = this.#currentScope();
        const response = await this.#exchange({ v: 1, type: "mcp_oauth_custody.status", requestId: randomUUID(), scope });
        this.#state = response.status === "ok" && response.custody === "data_protection_keychain" && response.tokens === undefined ? "durable" : "unavailable";
      } catch { this.#state = "unavailable"; }
      return this.#state;
    })();
    // Cleared by identity after settling (a synchronous failure must not leave a stale flight behind).
    this.#verifying = flight;
    void flight.finally(() => { if (this.#verifying === flight) this.#verifying = null; });
    return flight;
  }
  #currentScope(): McpOAuthCustodyScope {
    let scope: McpOAuthCustodyScope | null;
    try { scope = this.#scope(); } catch { throw new McpOAuthCustodyError("unavailable"); }
    if (!scope || !ID.test(scope.installationId) || !ID.test(scope.ownerId)) throw new McpOAuthCustodyError("unavailable");
    return { installationId: scope.installationId, ownerId: scope.ownerId };
  }
  async #durable(): Promise<McpOAuthCustodyScope> {
    if (this.#state !== "durable" && await this.verify() !== "durable") throw new McpOAuthCustodyError("unavailable");
    return this.#currentScope();
  }
  async #key(serverId: string, resource: string): Promise<McpOAuthCustodyKey> {
    if (!SERVER.test(serverId) || !validResource(resource)) throw new McpOAuthCustodyError("refused");
    const scope = await this.#durable();
    let pin: unknown;
    try { pin = this.#pin(serverId); } catch { throw new McpOAuthCustodyError("unavailable"); }
    if (typeof pin !== "string" || !PIN.test(pin)) throw new McpOAuthCustodyError("unavailable");
    return Object.freeze({ ...scope, serverId, instancePin: pin, resource });
  }
  async #exchange(request: McpOAuthCustodyRequest): Promise<McpOAuthCustodyResponse> {
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > MCP_OAUTH_CUSTODY_MAX_FRAME_BYTES) throw new McpOAuthCustodyError("refused");
    const deadline = AbortSignal.timeout(this.#timeoutMs);
    let raw: unknown;
    try { raw = await this.#channel.exchange(request, deadline); }
    catch { throw new McpOAuthCustodyError(deadline.aborted ? "timeout" : "unavailable"); }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new McpOAuthCustodyError("invalid_response");
    const r = raw as Record<string, unknown>;
    const allowed = new Set(["v", "type", "requestId", "status", "tokens", "custody"]);
    if (r.v !== 1 || r.type !== "mcp_oauth_custody.result" || r.requestId !== request.requestId || !["ok", "absent", "refused", "unavailable"].includes(r.status as string)
      || Object.keys(r).some(k => !allowed.has(k)) || (r.custody !== undefined && r.custody !== "data_protection_keychain")) throw new McpOAuthCustodyError("invalid_response");
    return r as unknown as McpOAuthCustodyResponse;
  }
  async load(serverId: string, binding?: McpOAuthStoreBinding): Promise<McpOAuthTokens | null> {
    if (!binding) throw new McpOAuthCustodyError("refused");
    const key = await this.#key(serverId, binding.resource);
    const response = await this.#exchange({ v: 1, type: "mcp_oauth_custody.load", requestId: randomUUID(), key });
    if (response.status === "absent" && response.tokens === undefined && response.custody === undefined) return null;
    if (response.status !== "ok") throw new McpOAuthCustodyError(response.status === "refused" ? "refused" : "unavailable");
    if (response.custody !== undefined || !validMcpOAuthCustodyTokens(response.tokens, serverId, binding.resource)) throw new McpOAuthCustodyError("invalid_response");
    return { ...response.tokens };
  }
  async save(tokens: McpOAuthTokens): Promise<void> {
    if (!validMcpOAuthCustodyTokens(tokens, tokens?.serverId)) throw new McpOAuthCustodyError("refused");
    const key = await this.#key(tokens.serverId, tokens.resource);
    const response = await this.#exchange({ v: 1, type: "mcp_oauth_custody.save", requestId: randomUUID(), key, tokens: { ...tokens } });
    if (response.status !== "ok" || response.tokens !== undefined || response.custody !== undefined) throw new McpOAuthCustodyError(response.status === "refused" ? "refused" : "unavailable");
  }
  async remove(serverId: string): Promise<void> {
    if (!SERVER.test(serverId)) throw new McpOAuthCustodyError("refused");
    const scope = await this.#durable();
    const response = await this.#exchange({ v: 1, type: "mcp_oauth_custody.remove", requestId: randomUUID(), scope, serverId });
    if ((response.status !== "ok" && response.status !== "absent") || response.tokens !== undefined || response.custody !== undefined)
      throw new McpOAuthCustodyError(response.status === "refused" ? "refused" : "unavailable");
  }
  toJSON() { return { kind: "mcp_oauth_private_channel_store", durability: this.#state }; }
}
