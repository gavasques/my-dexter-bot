import type { JsonValue } from "@dexter/contracts";
import { COMPOSIO_ORIGIN, isMetaSlug, readComposioExecuteResult } from "./composio.js";
import { ConnectorError } from "./errors.js";
import { checkLimits, checkOrigin, requestJson, type FetchLike, type HttpLimits } from "./http.js";

/**
 * Composio REST v3.1 connected-account client for the TRUSTED connections service only (never the user's host, app or
 * engine): the project key (`x-api-key`) is read from a private provider at request time and never stored here.
 *
 * Built from the official OpenAPI document `https://backend.composio.dev/api/v3.1/openapi.json` (info.version 3.1.0)
 * and the reference pages for `POST /connected_accounts/link`, `GET /connected_accounts`, `GET /connected_accounts/{id}`,
 * `DELETE /connected_accounts/{id}` and `POST /tools/execute/{tool_slug}`. Exercised against synthetic HTTP transports
 * only; no live Composio project was used.
 *
 * Every call is one request, never retried. Responses are PROJECTED: connection `state.val` carries credential material
 * (tokens, secrets) and is dropped except `displayName`, the documented "Connected as…" label. The raw body is never
 * returned, stored or logged.
 */
export const COMPOSIO_CONNECTION_STATUSES = ["INITIALIZING", "INITIATED", "ACTIVE", "FAILED", "EXPIRED", "INACTIVE", "REVOKED"] as const;
export type ComposioConnectionStatus = typeof COMPOSIO_CONNECTION_STATUSES[number];
export interface ComposioAccountProjection {
  id: string;
  toolkit: string;
  authConfigId: string;
  status: ComposioConnectionStatus;
  disabled: boolean;
  alias: string | null;
  /** `state.val.displayName` when the provider returned one: a label, not a verified email or identity. */
  displayName: string | null;
}
export interface ComposioLink {
  /** Official hosted authorization page. Validated https + allowlisted origin; transient, never persisted here. */
  redirectUrl: string;
  expiresAt: number;
  connectedAccountId: string;
}
export interface ComposioConnectOptions {
  fetch: FetchLike;
  /** Private project-key provider (trusted service configuration). Called per request; the value is never retained. */
  apiKey: () => string;
  origin?: string;
  /** Origins the documented `redirect_url` may use; anything else is refused before reaching the user. */
  authorizationOrigins: readonly string[];
  limits?: Partial<HttpLimits>;
}
/** Whether a failed provider WRITE may have been applied upstream. Unknown is never retried or replaced by a fallback. */
export type ComposioWriteOutcome = "not_applied" | "unknown";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const USER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TOOLKIT = /^[a-z][a-z0-9_-]{0,63}$/;
const SLUG = /^[A-Z][A-Z0-9_]{0,127}$/;
const VERSION = /^\d{8}_\d{2}$/;
const KEY = /^[\x21-\x7e]{8,512}$/;
const STATUS = new Set<string>(COMPOSIO_CONNECTION_STATUSES);
const RESERVED_ARGUMENTS = new Set(["account", "accounts", "user_id", "entity_id", "connected_account_id", "connected_accounts", "tool_slug", "tools",
  "toolkit", "toolkits", "session_id", "auth_config_id", "auth_configs", "custom_auth_params", "custom_connection_data"]);
/** Definitive refusals: the documented error responses of these statuses are returned before any effect. */
const NOT_APPLIED_STATUS = new Set([400, 401, 403, 404, 409, 410, 413, 422, 429]);

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ConnectorError("response_invalid");
  return value as Record<string, unknown>;
}
function wellFormedLabel(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 120) return null;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit < 0x20 || (unit >= 0x7f && unit <= 0x9f)) return null;
    if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return null; }
    else if (unit >= 0xdc00 && unit <= 0xdfff) return null;
  }
  return value;
}
/** Projects one documented connected-account object. Credential-bearing fields are never copied. */
export function projectComposioAccount(raw: unknown): ComposioAccountProjection {
  const r = record(raw);
  const toolkit = record(r["toolkit"]), auth = record(r["auth_config"]);
  const id = r["id"], slug = toolkit["slug"], authConfigId = auth["id"], status = r["status"], disabled = r["is_disabled"], alias = r["alias"];
  if (typeof id !== "string" || !ID.test(id) || typeof slug !== "string" || !TOOLKIT.test(slug) || typeof authConfigId !== "string" || !ID.test(authConfigId)
    || typeof status !== "string" || !STATUS.has(status) || typeof disabled !== "boolean" || (alias !== null && alias !== undefined && typeof alias !== "string"))
    throw new ConnectorError("response_invalid");
  let displayName: string | null = null;
  const state = r["state"];
  if (state !== null && typeof state === "object" && !Array.isArray(state)) {
    const val = (state as Record<string, unknown>)["val"];
    if (val !== null && typeof val === "object" && !Array.isArray(val)) displayName = wellFormedLabel((val as Record<string, unknown>)["displayName"]);
  }
  return Object.freeze({ id, toolkit: slug, authConfigId, status: status as ComposioConnectionStatus, disabled,
    alias: typeof alias === "string" ? alias : null, displayName });
}
/** Classifies a failed WRITE. Only documented pre-effect refusals are `not_applied`; everything else stays unknown. */
export function composioWriteOutcome(error: unknown): ComposioWriteOutcome {
  if (!(error instanceof ConnectorError)) return "unknown";
  if (["invalid_config", "origin_refused", "config_missing", "scope_mismatch", "tool_not_allowed", "arguments_refused", "auth_refused", "request_too_large"].includes(error.code))
    return "not_applied";
  if (error.code === "upstream_status" && error.status !== null && NOT_APPLIED_STATUS.has(error.status)) return "not_applied";
  return "unknown";
}

export class ComposioConnectClient {
  readonly #fetch: FetchLike;
  readonly #apiKey: () => string;
  readonly #origin: string;
  readonly #authorizationOrigins: ReadonlySet<string>;
  readonly #limits: HttpLimits;

  constructor(options: ComposioConnectOptions) {
    if (typeof options?.fetch !== "function" || typeof options.apiKey !== "function" || !Array.isArray(options.authorizationOrigins)
      || options.authorizationOrigins.length < 1 || options.authorizationOrigins.length > 4) throw new ConnectorError("invalid_config");
    this.#fetch = options.fetch;
    this.#apiKey = options.apiKey;
    this.#origin = checkOrigin(options.origin ?? COMPOSIO_ORIGIN);
    this.#authorizationOrigins = new Set(options.authorizationOrigins.map(o => checkOrigin(o)));
    this.#limits = checkLimits(options.limits);
    Object.freeze(this);
  }

  #headers(): Record<string, string> {
    let key: unknown;
    try { key = this.#apiKey(); } catch { throw new ConnectorError("config_missing"); }
    if (typeof key !== "string" || !KEY.test(key)) throw new ConnectorError("config_missing");
    return { "x-api-key": key };
  }

  /** `POST /api/v3.1/connected_accounts/link`. Provider write: one request, outcome classified by `composioWriteOutcome`. */
  async createLink(input: { authConfigId: string; userId: string; callbackUrl: string; alias: string }, signal?: AbortSignal): Promise<ComposioLink> {
    if (!ID.test(input.authConfigId) || !USER.test(input.userId) || !ALIAS.test(input.alias)) throw new ConnectorError("arguments_refused");
    let callback: URL;
    try { callback = new URL(input.callbackUrl); } catch { throw new ConnectorError("arguments_refused"); }
    if (callback.protocol !== "https:" || callback.username || callback.password || callback.hash || input.callbackUrl.length > 1024) throw new ConnectorError("arguments_refused");
    const response = await requestJson(this.#fetch, this.#origin, this.#limits, {
      method: "POST", path: "/api/v3.1/connected_accounts/link", headers: this.#headers(),
      body: { auth_config_id: input.authConfigId, user_id: input.userId, callback_url: input.callbackUrl, alias: input.alias },
      ...(signal ? { signal } : {}),
    });
    const r = record(response.body);
    const redirect = r["redirect_url"], expires = r["expires_at"], account = r["connected_account_id"], token = r["link_token"];
    if (typeof redirect !== "string" || redirect.length > 2048 || typeof expires !== "string" || typeof account !== "string" || !ID.test(account) || typeof token !== "string")
      throw new ConnectorError("response_invalid");
    let url: URL;
    try { url = new URL(redirect); } catch { throw new ConnectorError("response_invalid"); }
    if (url.protocol !== "https:" || url.username || url.password || !this.#authorizationOrigins.has(url.origin)) throw new ConnectorError("response_invalid");
    const expiresAt = Date.parse(expires);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new ConnectorError("response_invalid");
    return Object.freeze({ redirectUrl: url.href, expiresAt, connectedAccountId: account });
  }

  /** `GET /api/v3.1/connected_accounts/{id}`. Read-only. Null when the provider reports it absent (404). */
  async getAccount(id: string, signal?: AbortSignal): Promise<ComposioAccountProjection | null> {
    if (!ID.test(id)) throw new ConnectorError("arguments_refused");
    try {
      const response = await requestJson(this.#fetch, this.#origin, this.#limits, {
        method: "GET", path: `/api/v3.1/connected_accounts/${encodeURIComponent(id)}`, headers: this.#headers(), ...(signal ? { signal } : {}),
      });
      const account = projectComposioAccount(response.body);
      if (account.id !== id) throw new ConnectorError("response_invalid");
      return account;
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "upstream_status" && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Ownership-proving read: `GET /api/v3.1/connected_accounts?user_ids=<user>&connected_account_ids=<id>`. The account
   * response no longer returns `user_id` (deprecated upstream), so membership in the user's filtered list is the proof.
   */
  async findOwnedAccount(input: { userId: string; accountId: string }, signal?: AbortSignal): Promise<ComposioAccountProjection | null> {
    if (!USER.test(input.userId) || !ID.test(input.accountId)) throw new ConnectorError("arguments_refused");
    const query = new URLSearchParams({ user_ids: input.userId, connected_account_ids: input.accountId, limit: "2" });
    const items = await this.#list(query, signal);
    if (items.items.length > 1 || items.items.some(a => a.id !== input.accountId)) throw new ConnectorError("response_invalid");
    return items.items[0] ?? null;
  }

  /**
   * Read-only reconciliation of a lost link-creation ACK by its unique attempt alias. `complete: false` means the bounded
   * page did not settle the question; the caller keeps the outcome unknown.
   */
  async findByAlias(input: { userId: string; toolkit: string; alias: string }, signal?: AbortSignal): Promise<{ account: ComposioAccountProjection | null; complete: boolean }> {
    if (!USER.test(input.userId) || !TOOLKIT.test(input.toolkit) || !ALIAS.test(input.alias)) throw new ConnectorError("arguments_refused");
    const query = new URLSearchParams({ user_ids: input.userId, toolkit_slugs: input.toolkit, limit: "100", order_by: "created_at", order_direction: "desc" });
    const page = await this.#list(query, signal);
    const matches = page.items.filter(a => a.alias === input.alias);
    if (matches.length > 1) throw new ConnectorError("response_invalid");
    return { account: matches[0] ?? null, complete: matches.length === 1 || page.nextCursor === null };
  }

  async #list(query: URLSearchParams, signal?: AbortSignal): Promise<{ items: ComposioAccountProjection[]; nextCursor: string | null }> {
    const response = await requestJson(this.#fetch, this.#origin, this.#limits, {
      method: "GET", path: `/api/v3.1/connected_accounts?${query.toString()}`, headers: this.#headers(), ...(signal ? { signal } : {}),
    });
    const r = record(response.body);
    if (!Array.isArray(r["items"]) || r["items"].length > 100) throw new ConnectorError("response_invalid");
    const next = r["next_cursor"];
    if (next !== undefined && next !== null && typeof next !== "string") throw new ConnectorError("response_invalid");
    return { items: (r["items"] as unknown[]).map(projectComposioAccount), nextCursor: typeof next === "string" && next.length > 0 ? next : null };
  }

  /**
   * `DELETE /api/v3.1/connected_accounts/{id}?revoke_on_delete=true`. Provider write. The documented revoke job is not
   * pollable, so revocation is reported as `requested`, never confirmed. Null when already absent (404).
   */
  async deleteAccount(id: string, signal?: AbortSignal): Promise<{ revocation: "requested" | "not_requested" } | null> {
    if (!ID.test(id)) throw new ConnectorError("arguments_refused");
    try {
      const response = await requestJson(this.#fetch, this.#origin, this.#limits, {
        method: "DELETE", path: `/api/v3.1/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=true`, headers: this.#headers(), ...(signal ? { signal } : {}),
      });
      const r = record(response.body);
      if (r["success"] !== true) throw new ConnectorError("response_invalid");
      const job = r["revoke_job_id"];
      if (job !== undefined && job !== null && typeof job !== "string") throw new ConnectorError("response_invalid");
      return { revocation: typeof job === "string" && job.length > 0 ? "requested" : "not_requested" };
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "upstream_status" && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * `GET /api/v3.1/toolkits/{slug}`: the toolkit's published current-user endpoint (`get_current_user_endpoint` and
   * method). Read-only metadata; it describes where identity lives, never the account owner itself.
   */
  async toolkitIdentityEndpoint(slug: string, signal?: AbortSignal): Promise<{ endpoint: string | null; method: string | null }> {
    if (!TOOLKIT.test(slug)) throw new ConnectorError("arguments_refused");
    const response = await requestJson(this.#fetch, this.#origin, this.#limits, {
      method: "GET", path: `/api/v3.1/toolkits/${encodeURIComponent(slug)}`, headers: this.#headers(), ...(signal ? { signal } : {}),
    });
    const r = record(response.body);
    if (r["slug"] !== slug) throw new ConnectorError("response_invalid");
    const endpoint = r["get_current_user_endpoint"], method = r["get_current_user_endpoint_method"];
    if ((endpoint !== undefined && endpoint !== null && typeof endpoint !== "string") || (method !== undefined && method !== null && typeof method !== "string"))
      throw new ConnectorError("response_invalid");
    return { endpoint: typeof endpoint === "string" && endpoint.length > 0 && endpoint.length <= 2048 ? endpoint : null,
      method: typeof method === "string" && /^[A-Za-z]{3,7}$/.test(method) ? method.toUpperCase() : null };
  }

  /**
   * Identity read through `POST /api/v3.1/tools/execute/proxy` with the EXACT connected account (never the project
   * default), GET only, no extra parameters/headers/body. Returns the proxied status and parsed data; nothing is retained.
   */
  async proxyIdentity(input: { accountId: string; endpoint: string }, signal?: AbortSignal): Promise<{ status: number; data: unknown }> {
    if (!ID.test(input.accountId) || typeof input.endpoint !== "string" || input.endpoint.length < 1 || input.endpoint.length > 2048
      || /[\s\u0000-\u001f]/.test(input.endpoint)) throw new ConnectorError("arguments_refused");
    const response = await requestJson(this.#fetch, this.#origin, this.#limits, {
      method: "POST", path: "/api/v3.1/tools/execute/proxy", headers: this.#headers(),
      body: { connected_account_id: input.accountId, endpoint: input.endpoint, method: "GET" }, ...(signal ? { signal } : {}),
    });
    const r = record(response.body);
    if (typeof r["status"] !== "number" || !Number.isInteger(r["status"])) throw new ConnectorError("response_invalid");
    return { status: r["status"] as number, data: r["data"] ?? null };
  }

  /**
   * `POST /api/v3.1/tools/execute/{tool_slug}` with exact `version`, `user_id` and `connected_account_id`. Provider write
   * for write tools. Meta/helper tools and principal-selecting arguments are refused before any byte leaves.
   */
  async execute(input: { slug: string; version: string; userId: string; accountId: string; arguments: Readonly<Record<string, JsonValue>> }, signal?: AbortSignal): Promise<JsonValue> {
    if (!SLUG.test(input.slug) || isMetaSlug(input.slug)) throw new ConnectorError("tool_not_allowed");
    if (!VERSION.test(input.version) || !USER.test(input.userId) || !ID.test(input.accountId)) throw new ConnectorError("arguments_refused");
    const args = input.arguments;
    if (args === null || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(k => RESERVED_ARGUMENTS.has(k.toLowerCase())))
      throw new ConnectorError("arguments_refused");
    const response = await requestJson(this.#fetch, this.#origin, this.#limits, {
      method: "POST", path: `/api/v3.1/tools/execute/${encodeURIComponent(input.slug)}`, headers: this.#headers(),
      body: { arguments: args as Record<string, JsonValue>, version: input.version, user_id: input.userId, connected_account_id: input.accountId },
      ...(signal ? { signal } : {}),
    });
    return readComposioExecuteResult(response.body);
  }
}
