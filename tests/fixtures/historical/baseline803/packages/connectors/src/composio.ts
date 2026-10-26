import type { JsonValue } from "@dexter/contracts";
import type { AdapterCall, InjectedAuth, UpstreamAdapter } from "@dexter/gateway";
import { ConnectorError } from "./errors.js";
import { checkAuthHeaders, checkLimits, checkOrigin, requestJson, type FetchLike, type HttpLimits } from "./http.js";

/** Official Composio API origin. Any other origin must be set explicitly by trusted host configuration. */
export const COMPOSIO_ORIGIN = "https://backend.composio.dev";
/** Project-key header only. The organization-wide `x-user-api-key` is refused unless the host opts in. */
export const COMPOSIO_DEFAULT_AUTH_HEADERS: readonly string[] = Object.freeze(["x-api-key"]);

type Scope = AdapterCall["scope"];

export interface ComposioToolPin {
  /** Upstream tool slug (e.g. SLACK_SEND_MESSAGE). Never a meta tool. */
  slug: string;
  /**
   * Exact upstream version (`YYYYMMDD_NN`). The gateway manifest must carry the same version, and it is sent as
   * `version` on every execute: `latest` and any other floating value are refused.
   */
  version: string;
}
/**
 * Trusted binding of one bot over one gateway connection: user namespace, pinned connected account and versioned
 * tool allowlist. Everything here comes from trusted host configuration or a verified admin response; nothing is
 * derived from a call's arguments or slug. The optional Session id records an admin-provisioned Session; execution
 * does not route through it (see ComposioToolAdapter).
 */
export interface ComposioBotSession {
  installationId: string;
  ownerId: string;
  profileId: string;
  botId: string;
  /** Gateway connection id (hub grant destination) this session serves. */
  connectionId: string;
  toolkit: string;
  /** Composio `user_id`: `dx:<installation>:<owner>:<profile>`, the same namespace the gateway derives. */
  upstreamUserId: string;
  /** Pinned Composio connected account (`ca_...`). Sent as `connected_account_id` on every execute. */
  connectedAccountId: string;
  /** Optional Composio Session id from provisioning. Trusted-only metadata: never shown to engines, never routed. */
  sessionId?: string;
  tools: readonly ComposioToolPin[];
}
/** Trusted lookup of the binding for one capability scope and connection. */
export interface ComposioSessionSource {
  find(scope: Scope, connectionId: string): ComposioBotSession | null;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const TOOLKIT = /^[a-z][a-z0-9_-]{0,63}$/;
const SLUG = /^[A-Z][A-Z0-9_]{0,127}$/;
/** Composio's published version format (`YYYYMMDD_NN`). `latest` and other floating tags never match. */
const VERSION = /^[0-9]{8}_[0-9]{2}$/;
const UPSTREAM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_TOOLS = 64;
/** Composio meta/helper tools and anything able to search, pick, execute or proxy other tools, accounts or code. */
const META_SLUG = /^COMPOSIO_|(?:^|_)(?:MULTI_EXECUTE|EXECUTE_TOOL|REMOTE_WORKBENCH|REMOTE_BASH|WORKBENCH|PROXY|PROXY_EXECUTE|RUN_CODE|EXEC|EVAL|SHELL|BASH|MANAGE_CONNECTIONS|SEARCH_TOOLS|GET_TOOL_SCHEMAS|USE_SKILL|WAIT_FOR_CONNECTIONS)(?:_|$)/;
/**
 * Argument names that would select principal, account, tool, session or auth upstream. Defense in depth: the
 * arguments are nested under `arguments`, and the gateway manifest already refuses these names.
 */
const RESERVED_ARGUMENTS = new Set([
  "account", "accounts", "user_id", "entity_id", "connected_account_id", "connected_accounts", "tool_slug", "tools",
  "toolkit", "toolkits", "session_id", "auth_config_id", "auth_configs", "custom_auth_params", "custom_connection_data",
]);

export function isMetaSlug(slug: string): boolean {
  return META_SLUG.test(slug);
}
export function composioUserId(installationId: string, ownerId: string, profileId: string): string {
  return `dx:${installationId}:${ownerId}:${profileId}`;
}
const key = (s: { installationId: string; ownerId: string; profileId: string; botId: string }, connectionId: string): string =>
  [s.installationId, s.ownerId, s.profileId, s.botId, connectionId].join("\u0000");

function checkPins(tools: unknown): ComposioToolPin[] {
  if (!Array.isArray(tools) || tools.length === 0 || tools.length > MAX_TOOLS) throw new ConnectorError("invalid_config");
  const seen = new Set<string>();
  return tools.map((pin) => {
    if (typeof pin !== "object" || pin === null) throw new ConnectorError("invalid_config");
    const { slug, version } = pin as Record<string, unknown>;
    if (typeof slug !== "string" || !SLUG.test(slug) || isMetaSlug(slug)) throw new ConnectorError("invalid_config");
    if (typeof version !== "string" || !VERSION.test(version)) throw new ConnectorError("invalid_config");
    if (seen.has(slug)) throw new ConnectorError("invalid_config");
    seen.add(slug);
    return Object.freeze({ slug, version });
  });
}
function checkSession(entry: ComposioBotSession): ComposioBotSession {
  if (typeof entry !== "object" || entry === null) throw new ConnectorError("invalid_config");
  for (const field of ["installationId", "ownerId", "profileId", "botId", "connectionId"] as const) {
    if (typeof entry[field] !== "string" || !ID.test(entry[field])) throw new ConnectorError("invalid_config");
  }
  if (typeof entry.toolkit !== "string" || !TOOLKIT.test(entry.toolkit)) throw new ConnectorError("invalid_config");
  if (typeof entry.connectedAccountId !== "string" || !UPSTREAM_ID.test(entry.connectedAccountId)) throw new ConnectorError("invalid_config");
  if (entry.sessionId !== undefined && (typeof entry.sessionId !== "string" || !UPSTREAM_ID.test(entry.sessionId))) throw new ConnectorError("invalid_config");
  // The upstream user is never free-form: it is the namespace of this exact installation/owner/profile.
  if (entry.upstreamUserId !== composioUserId(entry.installationId, entry.ownerId, entry.profileId)) throw new ConnectorError("invalid_config");
  return Object.freeze({
    installationId: entry.installationId, ownerId: entry.ownerId, profileId: entry.profileId, botId: entry.botId,
    connectionId: entry.connectionId, toolkit: entry.toolkit, upstreamUserId: entry.upstreamUserId,
    connectedAccountId: entry.connectedAccountId, ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
    tools: Object.freeze(checkPins(entry.tools)),
  });
}

/**
 * Immutable, in-memory set of bot bindings supplied by the trusted owner at construction. There is no method
 * to add, change or remove an entry: a new configuration is a new directory. It persists nothing; durable
 * storage of session metadata (fenced by HostStore.withWriterLease) is not implemented yet.
 */
export class ComposioSessionDirectory implements ComposioSessionSource {
  private readonly entries: ReadonlyMap<string, ComposioBotSession>;

  constructor(sessions: readonly ComposioBotSession[]) {
    const entries = new Map<string, ComposioBotSession>();
    const sessionIds = new Set<string>();
    for (const raw of sessions) {
      const entry = checkSession(raw);
      const k = key(entry, entry.connectionId);
      // One binding per bot+connection, and a recorded Session is never shared between bots.
      if (entries.has(k) || (entry.sessionId !== undefined && sessionIds.has(entry.sessionId))) throw new ConnectorError("invalid_config");
      entries.set(k, entry);
      if (entry.sessionId !== undefined) sessionIds.add(entry.sessionId);
    }
    this.entries = entries;
    Object.freeze(this);
  }
  find(scope: Scope, connectionId: string): ComposioBotSession | null {
    return this.entries.get(key(scope, connectionId)) ?? null;
  }
  get size(): number { return this.entries.size; }
}

export interface ComposioAdapterOptions {
  sessions: ComposioSessionSource;
  fetch: FetchLike;
  /** Trusted configuration only. Default and recommended: COMPOSIO_ORIGIN. */
  origin?: string;
  /** Credential header names the adapter may forward. Default: x-api-key only. */
  authHeaders?: readonly string[];
  limits?: Partial<HttpLimits>;
}

/**
 * G3 UpstreamAdapter for versioned direct execution (`POST /api/v3.1/tools/execute/{tool_slug}`).
 *
 * Every request carries the exact pinned `version`, the namespaced `user_id` and the pinned
 * `connected_account_id`, all from the trusted binding keyed by the gateway-frozen scope and connection; the call
 * only supplies validated arguments. Composio Sessions are not used to execute because they always run the
 * latest published tool version. Note that the project API key itself is project-wide: the limits of any Session
 * do not bound it on this endpoint. Authority comes from the gateway manifest and grants plus the checks here.
 * Headers come from the broker for this call and go only to the fixed origin. One request, never retried: any
 * transport or upstream doubt throws a fixed error and the gateway records the action as unknown.
 */
export class ComposioToolAdapter implements UpstreamAdapter {
  private readonly sessions: ComposioSessionSource;
  private readonly fetchImpl: FetchLike;
  private readonly origin: string;
  private readonly host: string;
  private readonly authHeaders: ReadonlySet<string>;
  private readonly limits: HttpLimits;

  constructor(options: ComposioAdapterOptions) {
    if (typeof options.fetch !== "function" || typeof options.sessions?.find !== "function") throw new ConnectorError("invalid_config");
    this.sessions = options.sessions;
    this.fetchImpl = options.fetch;
    this.origin = checkOrigin(options.origin ?? COMPOSIO_ORIGIN);
    this.host = new URL(this.origin).hostname;
    const names = options.authHeaders ?? COMPOSIO_DEFAULT_AUTH_HEADERS;
    if (names.length === 0 || names.some((n) => typeof n !== "string" || !/^[a-z0-9-]{1,64}$/.test(n))) throw new ConnectorError("invalid_config");
    this.authHeaders = new Set(names);
    this.limits = checkLimits(options.limits);
  }

  async execute(call: AdapterCall, auth: InjectedAuth, context: { signal: AbortSignal }): Promise<JsonValue> {
    // Everything below up to the request is a refusal before any byte leaves the process.
    if (call.host !== this.host) throw new ConnectorError("origin_refused");
    const binding = this.sessions.find(call.scope, call.connectionId);
    if (!binding) throw new ConnectorError("config_missing");
    if (binding.installationId !== call.scope.installationId || binding.ownerId !== call.scope.ownerId
      || binding.profileId !== call.scope.profileId || binding.botId !== call.scope.botId || binding.connectionId !== call.connectionId
      || binding.toolkit !== call.toolkit || binding.upstreamUserId !== call.upstreamUserId
      || binding.connectedAccountId !== call.upstreamAccountRef) throw new ConnectorError("scope_mismatch");
    const pin = binding.tools.find((p) => p.slug === call.upstreamSlug && p.version === call.version);
    if (isMetaSlug(call.upstreamSlug) || !pin || !VERSION.test(pin.version)) throw new ConnectorError("tool_not_allowed");
    const args = call.arguments;
    if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ConnectorError("arguments_refused");
    if (Object.keys(args).some((name) => RESERVED_ARGUMENTS.has(name.toLowerCase()))) throw new ConnectorError("arguments_refused");
    const headers = checkAuthHeaders(auth.headers, this.authHeaders);

    const response = await requestJson(this.fetchImpl, this.origin, this.limits, {
      method: "POST",
      path: `/api/v3.1/tools/execute/${encodeURIComponent(pin.slug)}`,
      headers,
      // Version, user and account always explicit: omitting `version` would run the latest upstream release and
      // omitting the account would let upstream pick one of the user's accounts.
      body: {
        arguments: args as Record<string, JsonValue>, version: pin.version,
        user_id: binding.upstreamUserId, connected_account_id: binding.connectedAccountId,
      },
      signal: context.signal,
    });
    return readExecuteResult(response.body);
  }
}

/** @deprecated Former name, kept for compatibility. It now executes through the versioned direct endpoint. */
export const ComposioSessionAdapter = ComposioToolAdapter;
/** @deprecated Former name, kept for compatibility. */
export type ComposioSessionAdapter = ComposioToolAdapter;
/** Semantic alias: the directory holds per-bot bindings; a Session id is optional metadata. */
export const ComposioBotDirectory = ComposioSessionDirectory;
export type ComposioBotDirectory = ComposioSessionDirectory;
export type ComposioBotBinding = ComposioBotSession;

/** Top-level fields of the documented execute response. Anything else is an unknown schema and fails closed. */
const EXECUTE_RESPONSE_FIELDS = new Set(["data", "error", "successful", "session_info", "log_id"]);

/**
 * Accepts only the documented shape with `successful: true` and no error, and returns `data`. Unknown fields
 * (for example an echoed account, version or routing hint the documented schema does not have) are refused
 * rather than interpreted; `session_info` and `log_id` are upstream metadata and never reach the engine.
 */
function readExecuteResult(body: unknown): JsonValue {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ConnectorError("response_invalid");
  const r = body as Record<string, unknown>;
  if (Object.keys(r).some((name) => !EXECUTE_RESPONSE_FIELDS.has(name))) throw new ConnectorError("response_invalid");
  if (r.error !== undefined && r.error !== null && r.error !== "") throw new ConnectorError("upstream_error");
  if (r.successful !== true) throw new ConnectorError("upstream_error");
  if (r.session_info !== undefined && r.session_info !== null && obj(r.session_info) === null) throw new ConnectorError("response_invalid");
  if (!("data" in r)) throw new ConnectorError("response_invalid");
  return (r.data ?? null) as JsonValue;
}

// ---- admin provisioning (owner surface, never reachable from an engine) -----------------------------

export interface ProvisionSessionInput {
  installationId: string;
  ownerId: string;
  profileId: string;
  botId: string;
  connectionId: string;
  toolkit: string;
  connectedAccountId: string;
  tools: readonly ComposioToolPin[];
}
export interface ComposioAdminOptions {
  fetch: FetchLike;
  origin?: string;
  authHeaders?: readonly string[];
  limits?: Partial<HttpLimits>;
}

/**
 * Optional admin surface. Creates a restricted Session per bot (`POST /api/v3.1/tool_router/session`): one toolkit, an explicit tool
 * allowlist preloaded as direct tools, the pinned connected account, and every meta capability off
 * (search, multi-execute, connection management, workbench/sandbox, proxy execute, multi-account, instant
 * account). The server's returned config is verified field by field; any widening fails closed.
 *
 * Execution does not route through this Session (it would run the latest tool version), and its limits do not
 * bound the project API key on the direct execute endpoint. It is kept as an audited per-bot record of the
 * intended toolkit/account/allowlist, and for a future Session-based path once upstream supports pinned versions.
 *
 * Contract built from the public API reference (2026-10-07) and exercised only against synthetic transports.
 * It has not been validated against a live Composio project. It never requests or returns MCP headers.
 */
export class ComposioAdminClient {
  private readonly fetchImpl: FetchLike;
  private readonly origin: string;
  private readonly authHeaders: ReadonlySet<string>;
  private readonly limits: HttpLimits;

  constructor(options: ComposioAdminOptions) {
    if (typeof options.fetch !== "function") throw new ConnectorError("invalid_config");
    this.fetchImpl = options.fetch;
    this.origin = checkOrigin(options.origin ?? COMPOSIO_ORIGIN);
    const names = options.authHeaders ?? COMPOSIO_DEFAULT_AUTH_HEADERS;
    if (names.length === 0 || names.some((n) => typeof n !== "string" || !/^[a-z0-9-]{1,64}$/.test(n))) throw new ConnectorError("invalid_config");
    this.authHeaders = new Set(names);
    this.limits = checkLimits(options.limits);
  }

  /** Not retried: on an ambiguous failure the owner must inspect upstream before provisioning again. */
  async createBotSession(input: ProvisionSessionInput, auth: InjectedAuth, options: { signal?: AbortSignal } = {}): Promise<ComposioBotSession & { sessionId: string }> {
    const upstreamUserId = composioUserId(input.installationId, input.ownerId, input.profileId);
    // Validates every field (ids, toolkit, account, pins) before any request; the session id is a placeholder.
    checkSession({ ...input, upstreamUserId, sessionId: "pending", tools: input.tools });
    const pins = checkPins(input.tools);
    const slugs = pins.map((p) => p.slug);
    const headers = checkAuthHeaders(auth.headers, this.authHeaders);
    const body: JsonValue = {
      user_id: upstreamUserId,
      toolkits: { enable: [input.toolkit] },
      tools: { [input.toolkit]: { enable: slugs } },
      connected_accounts: { [input.toolkit]: [input.connectedAccountId] },
      preload: { tools: slugs },
      manage_connections: { enable: false },
      workbench: { enable: false },
      proxy_execute: { enable: false },
      multi_account: { enable: false },
      search: { enable: false },
      execute: { enable_multi_execute: false },
      instant: false,
    };
    const response = await requestJson(this.fetchImpl, this.origin, this.limits, {
      method: "POST", path: "/api/v3.1/tool_router/session", headers, body, ...(options.signal ? { signal: options.signal } : {}),
    });
    const sessionId = verifySessionResponse(response.body, { upstreamUserId, toolkit: input.toolkit, slugs, account: input.connectedAccountId });
    return checkSession({ ...input, upstreamUserId, sessionId, tools: pins }) as ComposioBotSession & { sessionId: string };
  }
}

function sameSet(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length || !value.every((v) => typeof v === "string")) return false;
  const a = [...value].sort();
  const b = [...expected].sort();
  return a.every((v, i) => v === b[i]);
}
function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function verifySessionResponse(body: unknown, expected: { upstreamUserId: string; toolkit: string; slugs: string[]; account: string }): string {
  const fail = (): never => { throw new ConnectorError("session_policy_mismatch"); };
  const r = obj(body) ?? fail();
  const sessionId = r.session_id;
  if (typeof sessionId !== "string" || !UPSTREAM_ID.test(sessionId)) fail();
  const config = obj(r.config) ?? fail();
  if (config.user_id !== expected.upstreamUserId) fail();
  if (!sameSet(obj(config.toolkits)?.enabled, [expected.toolkit])) fail();
  const tools = obj(config.tools) ?? fail();
  if (Object.keys(tools).length !== 1 || !sameSet(obj(tools[expected.toolkit])?.enabled, expected.slugs)) fail();
  const accounts = obj(config.connected_accounts) ?? fail();
  if (Object.keys(accounts).length !== 1 || !sameSet(accounts[expected.toolkit], [expected.account])) fail();
  // Every meta capability must be reported off. A missing block is treated as the (permissive) default.
  if (obj(config.manage_connections)?.enabled !== false) fail();
  const workbench = obj(config.workbench) ?? fail();
  if (workbench.enable !== false || workbench.proxy_execution_enabled === true) fail();
  if (obj(config.search)?.enable !== false) fail();
  if (obj(config.execute)?.enable_multi_execute !== false) fail();
  if (config.proxy_execute !== undefined && obj(config.proxy_execute)?.enable !== false) fail();
  if (config.multi_account !== undefined && obj(config.multi_account)?.enable !== false) fail();
  if (config.instant !== false) fail();
  if (config.auth_configs !== undefined && config.auth_configs !== null && Object.keys(obj(config.auth_configs) ?? fail()).length > 0) fail();
  const preload = obj(config.preload);
  if (preload && preload.tools !== undefined && !sameSet(preload.tools, expected.slugs)) fail();
  // The session's exposed tools must be exactly inside the allowlist: no meta or helper tool.
  const exposed = r.tool_router_tools;
  if (exposed !== undefined) {
    if (!Array.isArray(exposed) || exposed.some((slug) => typeof slug !== "string" || isMetaSlug(slug) || !expected.slugs.includes(slug))) fail();
  }
  if (obj(r.experimental)?.custom_tools !== undefined || obj(r.experimental)?.custom_toolkits !== undefined) {
    const exp = obj(r.experimental)!;
    if ((Array.isArray(exp.custom_tools) && exp.custom_tools.length > 0) || (Array.isArray(exp.custom_toolkits) && exp.custom_toolkits.length > 0)) fail();
  }
  return sessionId as string;
}
