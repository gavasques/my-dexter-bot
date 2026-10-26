import {
  CONNECTIONS_PLATFORM_INSTALLATION_HEADER, PlatformAccountSchema, PlatformAttemptSchema, PlatformAuthorizationResponseSchema, PlatformCatalogSchema,
  PlatformDisconnectResultSchema, PlatformExecutionResultSchema,
  type JsonValue, type PlatformAccount, type PlatformAttempt, type PlatformAuthorizationRequest, type PlatformAuthorizationResponse,
  type PlatformCatalog, type PlatformDisconnectResult, type PlatformExecutionRequest,
} from "@dexter/contracts";
import { ConnectorError } from "./errors.js";
import { checkAuthHeaders, checkLimits, checkOrigin, requestJson, type FetchLike, type HttpLimits } from "./http.js";

/**
 * Host-side client of the TRUSTED connections service (contract `connections-platform.ts`). The host never talks to a
 * provider directly on this route and never holds a provider project key: it presents a limited installation capability.
 *
 * Status mapping (bodies of non-2xx responses are discarded unread):
 *   400/401/403/404/409/422/429/503 → refused before any provider write (`not_applied`)
 *   412 → the trusted catalog changed (`not_applied`)
 *   502/500/504, transport failure, timeout or an invalid body → the provider write may have happened (`unknown`)
 */
export type PlatformOutcome = "not_applied" | "unknown";
export class ConnectionsPlatformError extends Error {
  constructor(readonly code: "refused" | "not_found" | "catalog_changed" | "unauthorized" | "rate_limited" | "unavailable" | "conflict" | "unknown",
    readonly outcome: PlatformOutcome) {
    super(`connections platform: ${code}`);
    this.name = "ConnectionsPlatformError";
  }
}
export interface ConnectionsPlatformClientOptions {
  origin: string;
  installationId: string;
  /** Private installation capability provider (trusted embedding). Called per request; never logged or persisted. */
  capability: () => string;
  fetch: FetchLike;
  limits?: Partial<HttpLimits>;
}
const CAPABILITY = /^[A-Za-z0-9._~+/=-]{32,512}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const AUTH_HEADERS: ReadonlySet<string> = new Set(["authorization"]);

function classify(error: unknown): ConnectionsPlatformError {
  if (error instanceof ConnectionsPlatformError) return error;
  if (error instanceof ConnectorError) {
    if (["invalid_config", "origin_refused", "config_missing", "arguments_refused", "auth_refused", "request_too_large"].includes(error.code))
      return new ConnectionsPlatformError("refused", "not_applied");
    if (error.code === "upstream_status") {
      switch (error.status) {
        case 400: case 422: return new ConnectionsPlatformError("refused", "not_applied");
        case 401: case 403: return new ConnectionsPlatformError("unauthorized", "not_applied");
        case 404: return new ConnectionsPlatformError("not_found", "not_applied");
        case 409: return new ConnectionsPlatformError("conflict", "not_applied");
        case 412: return new ConnectionsPlatformError("catalog_changed", "not_applied");
        case 429: return new ConnectionsPlatformError("rate_limited", "not_applied");
        case 503: return new ConnectionsPlatformError("unavailable", "not_applied");
        default: return new ConnectionsPlatformError("unknown", "unknown");
      }
    }
  }
  return new ConnectionsPlatformError("unknown", "unknown");
}

export class ConnectionsPlatformClient {
  readonly origin: string;
  readonly host: string;
  readonly #installationId: string;
  readonly #capability: () => string;
  readonly #fetch: FetchLike;
  readonly #limits: HttpLimits;

  constructor(options: ConnectionsPlatformClientOptions) {
    if (typeof options?.fetch !== "function" || typeof options.capability !== "function" || typeof options.installationId !== "string" || !ID.test(options.installationId))
      throw new ConnectorError("invalid_config");
    this.origin = checkOrigin(options.origin);
    this.host = new URL(this.origin).hostname;
    this.#installationId = options.installationId;
    this.#capability = options.capability;
    this.#fetch = options.fetch;
    this.#limits = checkLimits(options.limits);
    Object.freeze(this);
  }

  /** Header set released by the host broker for gateway executions. The value never reaches engines or responses. */
  authorizationHeaders(): Record<string, string> {
    let value: unknown;
    try { value = this.#capability(); } catch { throw new ConnectorError("config_missing"); }
    if (typeof value !== "string" || !CAPABILITY.test(value)) throw new ConnectorError("config_missing");
    return { authorization: `Bearer ${value}` };
  }
  secretValues(): string[] {
    try { const value = this.#capability(); return typeof value === "string" && CAPABILITY.test(value) ? [value] : []; } catch { return []; }
  }

  async #call(method: "GET" | "POST", path: string, body: JsonValue | undefined, signal: AbortSignal | undefined, headers?: Readonly<Record<string, string>>): Promise<unknown> {
    try {
      const auth = headers ? checkAuthHeaders(headers, AUTH_HEADERS) : this.authorizationHeaders();
      const response = await requestJson(this.#fetch, this.origin, this.#limits, {
        method, path, headers: { ...auth, [CONNECTIONS_PLATFORM_INSTALLATION_HEADER]: this.#installationId },
        ...(body === undefined ? {} : { body }), ...(signal ? { signal } : {}),
      });
      return response.body;
    } catch (error) { throw classify(error); }
  }
  #parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ConnectionsPlatformError("unknown", "unknown");
    return parsed.data;
  }

  /** Read-only. */
  async catalog(signal?: AbortSignal): Promise<PlatformCatalog> {
    return this.#parse(PlatformCatalogSchema, await this.#call("GET", "/v1/catalog", undefined, signal));
  }
  /** Provider write (authorization link). Never retried; an unknown outcome is reconciled through `authorization`. */
  async startAuthorization(request: PlatformAuthorizationRequest, signal?: AbortSignal): Promise<PlatformAuthorizationResponse> {
    return this.#parse(PlatformAuthorizationResponseSchema, await this.#call("POST", "/v1/authorizations", request as unknown as JsonValue, signal));
  }
  /** Read-only reconciliation by the original request id. Null when the service never recorded it. */
  async authorization(requestId: string, signal?: AbortSignal): Promise<PlatformAttempt | null> {
    if (!ID.test(requestId)) throw new ConnectionsPlatformError("refused", "not_applied");
    try { return this.#parse(PlatformAttemptSchema, await this.#call("GET", `/v1/authorizations/${encodeURIComponent(requestId)}`, undefined, signal)); }
    catch (error) { if (error instanceof ConnectionsPlatformError && error.code === "not_found") return null; throw error; }
  }
  /** Read-only live account state. */
  async account(accountRef: string, signal?: AbortSignal): Promise<PlatformAccount> {
    if (!REF.test(accountRef)) throw new ConnectionsPlatformError("refused", "not_applied");
    return this.#parse(PlatformAccountSchema, await this.#call("GET", `/v1/accounts/${encodeURIComponent(accountRef)}`, undefined, signal));
  }
  /** Provider write (delete + revocation request), deduplicated by the service per request id. */
  async disconnect(accountRef: string, requestId: string, signal?: AbortSignal): Promise<PlatformDisconnectResult> {
    if (!REF.test(accountRef) || !ID.test(requestId)) throw new ConnectionsPlatformError("refused", "not_applied");
    return this.#parse(PlatformDisconnectResultSchema, await this.#call("POST", `/v1/accounts/${encodeURIComponent(accountRef)}/disconnect`, { requestId }, signal));
  }
  /** Gateway execution with broker-released headers only. One request; any doubt is unknown upstream. */
  async execute(request: PlatformExecutionRequest, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<JsonValue> {
    const result = this.#parse(PlatformExecutionResultSchema, await this.#call("POST", "/v1/executions", request as unknown as JsonValue, signal, headers));
    if (result.requestId !== request.requestId) throw new ConnectionsPlatformError("unknown", "unknown");
    return result.data as JsonValue;
  }
}
