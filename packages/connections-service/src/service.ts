import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  CONNECTIONS_PLATFORM_VERSION, PlatformAuthorizationRequestSchema, PlatformDisconnectRequestSchema, PlatformExecutionRequestSchema,
  type JsonValue, type PlatformAccount, type PlatformAttempt, type PlatformCatalog, type PlatformCatalogEntry, type PlatformDisconnectResult, type PlatformIdentity,
} from "@dexter/contracts";
import { ComposioConnectClient, composioUserId, composioWriteOutcome, ConnectorError, isMetaSlug, assertSafeMcpMetadata, inspectMcpMetadata, MCP_METADATA_CATALOG_LIMITS, type ComposioAccountProjection, type FetchLike, type HttpLimits } from "@dexter/connectors";
import { checkManifest, type ToolManifest } from "@dexter/gateway";
import { ServiceStore, type Row } from "./store.js";

/** Fixed service error; HTTP status and body are derived from the code only (never provider text). */
export type ServiceErrorCode = "invalid_input" | "unauthorized" | "not_found" | "conflict" | "catalog_changed" | "provider_refused" | "rate_limited"
  | "unavailable" | "outcome_unknown" | "duplicate";
export class ServiceError extends Error {
  constructor(readonly code: ServiceErrorCode) { super(`connections service: ${code}`); this.name = "ServiceError"; }
  get status(): number {
    return { invalid_input: 400, unauthorized: 401, not_found: 404, conflict: 409, duplicate: 409, catalog_changed: 412, provider_refused: 422,
      rate_limited: 429, outcome_unknown: 502, unavailable: 503 }[this.code];
  }
  get outcome(): "not_applied" | "unknown" { return this.code === "outcome_unknown" ? "unknown" : "not_applied"; }
}
/** Identity of a verified installation capability. Never taken from a body or query. */
export interface ServicePrincipal { installationId: string; ownerId: string }
/** Operator-curated, reviewed service entry. `authConfigId` stays inside this service. */
export interface ServiceCatalogConfig {
  serviceId: string;
  displayName: string;
  description: string;
  provider: "composio";
  toolkit: string;
  toolkitVersion: string;
  authConfigId: string;
  /** `provider_verified` requires `identityProbe`; otherwise the provider label (`provider_display_name`) or nothing. */
  identity: "provider_verified" | "provider_display_name" | "unconfirmed";
  /**
   * Operator-reviewed official identity endpoint (UX-P1-11). It must equal the toolkit's published
   * `get_current_user_endpoint`/method at read time, and is read through the Composio proxy with the exact account.
   */
  identityProbe?: ServiceIdentityProbe | null;
  /** `proven` only after an operator-recorded real login + authorized operation for this integration. */
  verification: "unproven" | "proven";
  /** Reviewed Dexter manifests, `upstreamHost` = this service's public host, `version` = `toolkitVersion`. */
  tools: readonly ToolManifest[];
}
export interface ServiceIdentityProbe {
  endpoint: string;
  method: "GET";
  /** Dotted path of one string field in the JSON response (≤4 segments). */
  field: string;
  kind: "email" | "username" | "workspace" | "tenant";
}
export interface ConnectionsPlatformServiceOptions {
  dataDir: string;
  /** Public https origin of this service: callback pages and the manifests' `upstreamHost`. */
  publicOrigin: string;
  composio: { fetch: FetchLike; apiKey: () => string; origin?: string; authorizationOrigins: readonly string[]; limits?: Partial<HttpLimits> };
  /** Trusted capability verifier (operator provisioning; out of scope here). Returns null for unknown/revoked capabilities. */
  installations: { resolve(capability: string): ServicePrincipal | null };
  catalog: readonly ServiceCatalogConfig[];
  clock?: () => number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ATTEMPT = /^att_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LINK_GRACE_MS = 30 * 60 * 1000;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}$/;
const EMAIL = /^[^\s@<>()"',;:\\]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const UNCONFIRMED: PlatformIdentity = Object.freeze({ confirmation: "unconfirmed", value: null, kind: null, source: null });
function identityText(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 254) return null;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit < 0x20 || (unit >= 0x7f && unit <= 0x9f)) return null;
    if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return null; }
    else if (unit >= 0xdc00 && unit <= 0xdfff) return null;
  }
  return value;
}
function probeValue(data: unknown, field: string, kind: ServiceIdentityProbe["kind"]): string | null {
  let current: unknown = data;
  for (const segment of field.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, segment)) return null;
    current = (current as Row)[segment];
  }
  const text = identityText(current);
  if (text === null) return null;
  return kind === "email" ? (EMAIL.test(text) ? text : null) : text;
}
const MAX_LINK_MS = 60 * 60 * 1000;
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Row)[k])}`).join(",")}}`;
}
const sha256 = (value: unknown): string => createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
const fail = (code: ServiceErrorCode): never => { throw new ServiceError(code); };
function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const r = schema.safeParse(value);
  return r.success ? r.data : fail("invalid_input");
}
function providerFailure(error: unknown): ServiceError {
  if (composioWriteOutcome(error) === "unknown") return new ServiceError("outcome_unknown");
  if (error instanceof ConnectorError && error.code === "upstream_status" && error.status === 429) return new ServiceError("rate_limited");
  if (error instanceof ConnectorError && error.code === "config_missing") return new ServiceError("unavailable");
  return new ServiceError("provider_refused");
}

export class ConnectionsPlatformService {
  readonly host: string;
  readonly #origin: string;
  readonly #store: ServiceStore;
  readonly #composio: ComposioConnectClient;
  readonly #installations: ConnectionsPlatformServiceOptions["installations"];
  readonly #entries: ReadonlyMap<string, ServiceCatalogConfig>;
  readonly #catalog: PlatformCatalog;
  readonly #catalogSecrets:()=>readonly string[];
  readonly #pin: string;
  readonly #clock: () => number;
  readonly #inflight = new Set<string>();
  /** Toolkit metadata confirmations (success only) for this process; a mismatch is never cached as success. */
  readonly #identityEndpoints = new Map<string, { endpoint: string | null; method: string | null }>();
  readonly #abort = new AbortController();

  constructor(options: ConnectionsPlatformServiceOptions) {
    let origin: URL;
    try { origin = new URL(options.publicOrigin); } catch { throw new ServiceError("invalid_input"); }
    if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin || origin.port) throw new ServiceError("invalid_input");
    this.#origin = origin.origin; this.host = origin.hostname;
    this.#composio = new ComposioConnectClient({ fetch: options.composio.fetch, apiKey: options.composio.apiKey, authorizationOrigins: options.composio.authorizationOrigins,
      ...(options.composio.origin ? { origin: options.composio.origin } : {}), ...(options.composio.limits ? { limits: options.composio.limits } : {}) });
    if (typeof options.installations?.resolve !== "function") throw new ServiceError("invalid_input");
    this.#installations = options.installations;
    this.#clock = options.clock ?? Date.now;
    const entries = new Map<string, ServiceCatalogConfig>(), names = new Set<string>();
    const services: PlatformCatalogEntry[] = [];
    this.#catalogSecrets=()=>[options.composio.apiKey()];
    let safeCatalog: ServiceCatalogConfig[];
    try { safeCatalog=this.#safeCatalogMetadata(options.catalog); } catch { throw new ServiceError("invalid_input"); }
    for (const raw of safeCatalog) {
      const entry = { ...raw };
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(entry.serviceId) || entries.has(entry.serviceId) || entry.provider !== "composio" || !/^[a-z][a-z0-9_-]{0,63}$/.test(entry.toolkit)
        || !/^\d{8}_\d{2}$/.test(entry.toolkitVersion) || !REF.test(entry.authConfigId) || entry.tools.length < 1 || entry.tools.length > 32) throw new ServiceError("invalid_input");
      const probe = entry.identityProbe ?? null;
      if ((entry.identity === "provider_verified") !== (probe !== null)) throw new ServiceError("invalid_input");
      if (probe && (probe.method !== "GET" || !FIELD.test(probe.field) || !["email", "username", "workspace", "tenant"].includes(probe.kind)
        || typeof probe.endpoint !== "string" || probe.endpoint.length > 2048 || /[\s\u0000-\u001f]/.test(probe.endpoint)
        || !(probe.endpoint.startsWith("/") ? !probe.endpoint.startsWith("//") : (() => { try { const u = new URL(probe.endpoint); return u.protocol === "https:" && !u.username && !u.password && !u.hash; } catch { return false; } })())))
        throw new ServiceError("invalid_input");
      const tools = entry.tools.flatMap(t => {
        let m: ToolManifest;
        try { m=checkManifest(t); } catch { return []; }
        if (m.toolkit !== entry.toolkit || m.version !== entry.toolkitVersion || m.upstreamHost !== this.host || isMetaSlug(m.upstreamSlug) || names.has(m.name)) return [];
        names.add(m.name);
        return [m];
      });
      if (!tools.length) continue;
      entries.set(entry.serviceId, Object.freeze({ ...entry, tools: Object.freeze(tools) }));
      services.push({ serviceId: entry.serviceId, displayName: entry.displayName, description: entry.description, provider: "composio", toolkit: entry.toolkit,
        toolkitVersion: entry.toolkitVersion, authorization: "oauth_link", identity: entry.identity, verification: entry.verification,
        authorizationOrigins: [...options.composio.authorizationOrigins], tools: tools as unknown[] });
    }
    if (entries.size > 64) throw new ServiceError("invalid_input");
    this.#entries = entries;
    this.#catalog = Object.freeze({ version: CONNECTIONS_PLATFORM_VERSION, services });
    this.#pin = sha256(JSON.parse(JSON.stringify(services)));
    this.#store = new ServiceStore(options.dataDir, sha256({ origin: this.#origin, composio: options.composio.origin ?? "default" }));
  }

  /** Verifies the bearer capability and the declared installation. Constant failure for every refusal. */
  authenticate(authorization: string | undefined, installation: string | undefined): ServicePrincipal {
    const match = /^Bearer ([A-Za-z0-9._~+/=-]{32,512})$/.exec(authorization ?? "");
    if (!match || !installation || !ID.test(installation)) return fail("unauthorized");
    let principal: ServicePrincipal | null;
    try { principal = this.#installations.resolve(match[1]!); } catch { return fail("unauthorized"); }
    if (!principal || principal.installationId !== installation || !ID.test(principal.installationId) || !ID.test(principal.ownerId)) return fail("unauthorized");
    return principal;
  }
  #safeCatalogMetadata<T extends ServiceCatalogConfig | PlatformCatalogEntry>(entries: readonly T[]): T[] {
    const secrets=this.#catalogSecrets();
    if (inspectMcpMetadata(entries,secrets,MCP_METADATA_CATALOG_LIMITS).reason === "metadata_limit") throw new ServiceError("invalid_input");
    const safe = entries.flatMap(entry => {
      const {tools,...metadata}=entry;
      if (!inspectMcpMetadata(metadata,secrets).safe) return [];
      const healthy=tools.filter(tool=>inspectMcpMetadata(tool,secrets).safe);
      return healthy.length ? [{...entry,tools:healthy} as T] : [];
    });
    assertSafeMcpMetadata(safe,secrets,MCP_METADATA_CATALOG_LIMITS);
    return safe;
  }
  catalog(): PlatformCatalog { return {...this.#catalog,services:this.#safeCatalogMetadata(this.#catalog.services)}; }
  get pin(): string { return this.#pin; }

  #attemptView(row: Row): PlatformAttempt {
    return {
      version: CONNECTIONS_PLATFORM_VERSION, requestId: row.request_id as string, requestHash: row.request_hash as string, attemptId: row.attempt_id as string,
      serviceId: row.service_id as string, profileId: row.profile_id as string, catalogPin: row.catalog_pin as string, state: row.state as PlatformAttempt["state"],
      reason: (row.reason as PlatformAttempt["reason"]) ?? null, accountRef: (row.account_ref as string | null) ?? null,
      expiresAt: row.expires_at === null ? null : Number(row.expires_at), callback: row.callback as PlatformAttempt["callback"],
      identity: row.state === "active" ? this.#storedIdentity(row) : null,
    };
  }
  #storedIdentity(row: Row): PlatformIdentity {
    const value = (row.identity_value as string | null) ?? null, kind = (row.identity_kind as string | null) ?? null, source = (row.identity_source as string | null) ?? null;
    if (value === null || kind === null || source === null) return UNCONFIRMED;
    return { confirmation: source === "identity_endpoint" ? "provider_verified" : "provider_display_name", value, kind: kind as PlatformIdentity["kind"], source: source as PlatformIdentity["source"] };
  }
  /**
   * UX-P1-11 identity adapter for the Composio route. Verified only when the reviewed probe equals the toolkit's published
   * current-user endpoint/method and the proxied read of THIS account returns a valid value; otherwise the provider label
   * (display name) or `unconfirmed`. Never derived from aliases, labels, account ids or URLs.
   */
  async #identity(entry: ServiceCatalogConfig, accountRef: string, displayName: string | null): Promise<PlatformIdentity> {
    const probe = entry.identityProbe ?? null;
    if (probe) {
      try {
        let published = this.#identityEndpoints.get(entry.toolkit);
        if (!published) {
          published = await this.#composio.toolkitIdentityEndpoint(entry.toolkit, this.#abort.signal);
          if (published.endpoint === probe.endpoint && (published.method ?? "GET") === probe.method) this.#identityEndpoints.set(entry.toolkit, published);
        }
        if (published.endpoint === probe.endpoint && (published.method ?? "GET") === probe.method) {
          const read = await this.#composio.proxyIdentity({ accountId: accountRef, endpoint: probe.endpoint }, this.#abort.signal);
          const value = read.status === 200 ? probeValue(read.data, probe.field, probe.kind) : null;
          if (value !== null) return { confirmation: "provider_verified", value, kind: probe.kind, source: "identity_endpoint" };
        }
      } catch { /* fall back to the weaker, honestly labelled level below */ }
    }
    const label = identityText(displayName);
    return label === null ? UNCONFIRMED : { confirmation: "provider_display_name", value: label, kind: "display_name", source: "provider_label" };
  }
  #attempt(p: ServicePrincipal, requestId: string): Row | undefined {
    return this.#store.one("SELECT * FROM attempts WHERE installation_id=? AND request_id=?", p.installationId, requestId);
  }

  /** One Connect Link per (installation, requestId). The link is returned once and never stored. */
  async startAuthorization(p: ServicePrincipal, raw: unknown): Promise<{ created: boolean; attempt: PlatformAttempt; authorizationURL: string | null }> {
    const input = parse(PlatformAuthorizationRequestSchema, raw);
    const hash = sha256(input);
    const existing = this.#attempt(p, input.requestId);
    if (existing) return existing.request_hash === hash ? { created: false, attempt: this.#attemptView(existing), authorizationURL: null } : fail("conflict");
    if (input.catalogPin !== this.#pin) fail("catalog_changed");
    const entry = this.#safeCatalogMetadata([...this.#entries.values()]).find(entry=>entry.serviceId===input.serviceId) ?? fail("not_found");
    const attemptId = `att_${randomUUID()}`, nonce = randomBytes(32).toString("base64url"), now = this.#clock();
    const userId = composioUserId(p.installationId, p.ownerId, input.profileId), alias = `dx-${attemptId.slice(4)}`;
    const inserted = this.#store.tx(() => {
      if (this.#attempt(p, input.requestId)) return false;
      this.#store.run(`INSERT INTO attempts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'starting',NULL,NULL,'none',NULL,?,?,NULL,NULL)`,
        p.installationId, input.requestId, attemptId, hash, p.ownerId, input.profileId, input.serviceId, input.catalogPin, entry.toolkit, entry.authConfigId,
        userId, alias, sha256(nonce), now, now);
      return true;
    });
    if (!inserted) return this.startAuthorization(p, raw);
    this.#inflight.add(attemptId);
    try {
      let link;
      try {
        link = await this.#composio.createLink({ authConfigId: entry.authConfigId, userId, alias,
          callbackUrl: `${this.#origin}/v1/callback/${attemptId}?state=${nonce}` }, this.#abort.signal);
      } catch (error) {
        const failure = providerFailure(error);
        this.#store.tx(() => this.#store.run("UPDATE attempts SET state=?, reason=?, updated_at=? WHERE attempt_id=? AND state='starting'",
          failure.code === "outcome_unknown" ? "unknown" : "failed", failure.code === "outcome_unknown" ? "outcome_unknown" : "provider_refused", this.#clock(), attemptId));
        throw failure;
      }
      const at = this.#clock();
      if (link.expiresAt <= at || link.expiresAt > at + MAX_LINK_MS) {
        this.#store.tx(() => this.#store.run("UPDATE attempts SET state='unknown', reason='outcome_unknown', account_ref=?, updated_at=? WHERE attempt_id=?", link.connectedAccountId, at, attemptId));
        throw new ServiceError("outcome_unknown");
      }
      const row = this.#store.tx(() => {
        this.#store.run("UPDATE attempts SET state='awaiting_user', account_ref=?, expires_at=?, updated_at=? WHERE attempt_id=? AND state='starting'", link.connectedAccountId, link.expiresAt, at, attemptId);
        this.#store.run("INSERT OR IGNORE INTO accounts VALUES (?,?,?,?,?,?,?,?,'pending',?,?)", link.connectedAccountId, p.installationId, p.ownerId, input.profileId,
          input.serviceId, entry.toolkit, entry.authConfigId, userId, at, at);
        return this.#attempt(p, input.requestId)!;
      });
      return { created: true, attempt: this.#attemptView(row), authorizationURL: link.redirectUrl };
    } finally { this.#inflight.delete(attemptId); }
  }

  /** Read-only reconciliation. Never creates another link. */
  async authorization(p: ServicePrincipal, requestId: string): Promise<PlatformAttempt> {
    if (!ID.test(requestId)) fail("invalid_input");
    const row = this.#attempt(p, requestId) ?? fail("not_found");
    if (["active", "failed", "expired"].includes(row.state as string) || this.#inflight.has(row.attempt_id as string)) return this.#attemptView(row);
    const now = this.#clock(), attemptId = row.attempt_id as string;
    let accountRef = row.account_ref as string | null;
    if (accountRef === null) {
      // Lost link ACK: the unique attempt alias is the only lookup key. Absence settles only after the link window.
      let found;
      try { found = await this.#composio.findByAlias({ userId: row.user_id as string, toolkit: row.toolkit as string, alias: row.alias as string }, this.#abort.signal); }
      catch { return this.#attemptView(row); }
      if (!found.account) {
        if (found.complete && now - Number(row.created_at) > LINK_GRACE_MS)
          this.#store.tx(() => this.#store.run("UPDATE attempts SET state='failed', reason='not_started', updated_at=? WHERE attempt_id=? AND account_ref IS NULL", now, attemptId));
        return this.#attemptView(this.#attempt(p, requestId)!);
      }
      accountRef = found.account.id;
      this.#store.tx(() => {
        this.#store.run("UPDATE attempts SET account_ref=?, updated_at=? WHERE attempt_id=? AND account_ref IS NULL", accountRef, now, attemptId);
        this.#store.run("INSERT OR IGNORE INTO accounts VALUES (?,?,?,?,?,?,?,?,'pending',?,?)", accountRef, p.installationId, p.ownerId, row.profile_id as string,
          row.service_id as string, row.toolkit as string, row.auth_config_id as string, row.user_id as string, now, now);
      });
    }
    let account: ComposioAccountProjection | null;
    try { account = await this.#composio.findOwnedAccount({ userId: row.user_id as string, accountId: accountRef! }, this.#abort.signal); }
    catch { return this.#attemptView(this.#attempt(p, requestId)!); }
    const expired = row.expires_at !== null && now > Number(row.expires_at) + LINK_GRACE_MS;
    const entry = this.#entries.get(row.service_id as string);
    const confirmed = account && account.status === "ACTIVE" && !account.disabled && account.toolkit === row.toolkit && account.authConfigId === row.auth_config_id && entry
      ? await this.#identity(entry, accountRef!, account.displayName) : UNCONFIRMED;
    this.#store.tx(() => {
      const set = (state: string, reason: string | null, identity: PlatformIdentity = UNCONFIRMED) =>
        this.#store.run("UPDATE attempts SET state=?, reason=?, identity_value=?, identity_kind=?, identity_source=?, updated_at=? WHERE attempt_id=? AND state IN ('starting','awaiting_user','unknown')",
          state, reason, identity.value, identity.kind, identity.source, now, attemptId);
      if (!account) { if (expired) set("expired", "link_expired"); return; }
      if (account.toolkit !== row.toolkit || account.authConfigId !== row.auth_config_id) { set("failed", "provider_failed"); return; }
      switch (account.status) {
        case "ACTIVE":
          if (account.disabled) { set("failed", "provider_failed"); return; }
          set("active", null, confirmed);
          this.#store.run("UPDATE accounts SET state='active', updated_at=? WHERE account_ref=? AND installation_id=? AND state='pending'", now, accountRef!, p.installationId);
          return;
        case "FAILED": case "INACTIVE": case "REVOKED": set("failed", "provider_failed"); return;
        case "EXPIRED": set("expired", "link_expired"); return;
        default:
          if (expired) set("expired", "link_expired");
          else if (row.state === "unknown") set("awaiting_user", null);
      }
    });
    return this.#attemptView(this.#attempt(p, requestId)!);
  }

  /** Browser return page. Records a hint for the matching attempt only; never confirms an account or grants anything. */
  callback(attemptId: string, query: { state?: string; status?: string; connected_account_id?: string }): boolean {
    if (!ATTEMPT.test(attemptId) || typeof query.state !== "string" || query.state.length < 16 || query.state.length > 128) return false;
    const row = this.#store.one("SELECT * FROM attempts WHERE attempt_id=?", attemptId);
    if (!row) return false;
    const expected = Buffer.from(row.nonce_hash as string, "hex"), actual = createHash("sha256").update(query.state).digest();
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
    if (query.connected_account_id !== undefined && row.account_ref !== null && query.connected_account_id !== row.account_ref) return false;
    const status = query.status === "success" ? "success" : query.status === "failed" ? "failed" : null;
    if (!status) return false;
    this.#store.tx(() => this.#store.run("UPDATE attempts SET callback=?, updated_at=? WHERE attempt_id=? AND callback='none'", status, this.#clock(), attemptId));
    return true;
  }

  #ownedAccount(p: ServicePrincipal, accountRef: string): Row {
    if (!REF.test(accountRef)) fail("invalid_input");
    // Another installation's account is indistinguishable from an absent one.
    return this.#store.one("SELECT * FROM accounts WHERE account_ref=? AND installation_id=? AND owner_id=?", accountRef, p.installationId, p.ownerId) ?? fail("not_found");
  }
  async account(p: ServicePrincipal, accountRef: string): Promise<PlatformAccount> {
    const row = this.#ownedAccount(p, accountRef), now = this.#clock();
    const view = (state: PlatformAccount["state"], identity: PlatformIdentity): PlatformAccount => ({ version: CONNECTIONS_PLATFORM_VERSION, accountRef, serviceId: row.service_id as string,
      profileId: row.profile_id as string, state, identity, checkedAt: now });
    if (row.state === "deleted") return view("absent", UNCONFIRMED);
    let account: ComposioAccountProjection | null;
    try { account = await this.#composio.findOwnedAccount({ userId: row.user_id as string, accountId: accountRef }, this.#abort.signal); }
    catch { return fail("unavailable"); }
    if (!account) return view("absent", UNCONFIRMED);
    if (account.toolkit !== row.toolkit || account.authConfigId !== row.auth_config_id) return fail("not_found");
    const state = account.status === "ACTIVE" ? (account.disabled ? "needs_reconnect" : "active") : account.status === "REVOKED" ? "revoked"
      : account.status === "INITIATED" || account.status === "INITIALIZING" ? "pending" : "needs_reconnect";
    const entry = this.#entries.get(row.service_id as string);
    // Identity is read only from a usable account; other states report no identity rather than a stale one.
    return view(state, state === "active" && entry ? await this.#identity(entry, accountRef, account.displayName) : UNCONFIRMED);
  }

  /** One delete (with provider revocation request) per (installation, requestId). Unknown outcomes are read, never re-sent. */
  async disconnect(p: ServicePrincipal, accountRef: string, raw: unknown): Promise<PlatformDisconnectResult> {
    const input = parse(PlatformDisconnectRequestSchema, raw);
    const account = this.#ownedAccount(p, accountRef), now = this.#clock();
    const prior = this.#store.one("SELECT * FROM disconnects WHERE installation_id=? AND request_id=?", p.installationId, input.requestId);
    if (prior) {
      if (prior.account_ref !== accountRef) fail("conflict");
      if (prior.state === "done") return JSON.parse(prior.result as string) as PlatformDisconnectResult;
      if (prior.state === "inflight" || this.#inflight.has(`d:${p.installationId}:${input.requestId}`)) fail("outcome_unknown");
      // Unknown delete: read first. Absent settles it; present proves the documented immediate delete did not apply, so the
      // owner's explicit re-send of the SAME request performs it once now. A failed read stays unknown.
      let current: ComposioAccountProjection | null;
      try { current = await this.#composio.getAccount(accountRef, this.#abort.signal); } catch { return fail("outcome_unknown"); }
      if (current === null) {
        const result: PlatformDisconnectResult = { version: CONNECTIONS_PLATFORM_VERSION, requestId: input.requestId, accountRef, upstream: "deleted", revocation: "requested" };
        this.#store.tx(() => {
          this.#store.run("UPDATE disconnects SET state='done', result=?, updated_at=? WHERE installation_id=? AND request_id=?", JSON.stringify(result), now, p.installationId, input.requestId);
          this.#store.run("UPDATE accounts SET state='deleted', updated_at=? WHERE account_ref=?", now, accountRef);
        });
        return result;
      }
      this.#store.tx(() => this.#store.run("UPDATE disconnects SET state='inflight', updated_at=? WHERE installation_id=? AND request_id=? AND state='unknown'", now, p.installationId, input.requestId));
      return this.#delete(p, accountRef, input.requestId, account.state as string, false);
    }
    if (account.state === "deleted") {
      const result: PlatformDisconnectResult = { version: CONNECTIONS_PLATFORM_VERSION, requestId: input.requestId, accountRef, upstream: "already_absent", revocation: "not_requested" };
      this.#store.tx(() => this.#store.run("INSERT INTO disconnects VALUES (?,?,?,'done',?,?,?)", p.installationId, input.requestId, accountRef, JSON.stringify(result), now, now));
      return result;
    }
    this.#store.tx(() => {
      this.#store.run("INSERT INTO disconnects VALUES (?,?,?,'inflight',NULL,?,?)", p.installationId, input.requestId, accountRef, now, now);
      this.#store.run("UPDATE accounts SET state='disconnecting', updated_at=? WHERE account_ref=?", now, accountRef);
    });
    return this.#delete(p, accountRef, input.requestId, account.state as string, true);
  }
  async #delete(p: ServicePrincipal, accountRef: string, requestId: string, previousState: string, release: boolean): Promise<PlatformDisconnectResult> {
    const key = `d:${p.installationId}:${requestId}`;
    this.#inflight.add(key);
    try {
      let deleted;
      try { deleted = await this.#composio.deleteAccount(accountRef, this.#abort.signal); }
      catch (error) {
        const failure = providerFailure(error);
        this.#store.tx(() => {
          if (failure.code === "outcome_unknown" || !release) this.#store.run("UPDATE disconnects SET state='unknown', updated_at=? WHERE installation_id=? AND request_id=?", this.#clock(), p.installationId, requestId);
          else {
            // Not applied: the request id is released so the owner can send the same request again.
            this.#store.run("DELETE FROM disconnects WHERE installation_id=? AND request_id=?", p.installationId, requestId);
            this.#store.run("UPDATE accounts SET state=?, updated_at=? WHERE account_ref=? AND state='disconnecting'", previousState, this.#clock(), accountRef);
          }
        });
        throw failure;
      }
      const result: PlatformDisconnectResult = { version: CONNECTIONS_PLATFORM_VERSION, requestId, accountRef,
        upstream: deleted === null ? "already_absent" : "deleted", revocation: deleted?.revocation ?? "not_requested" };
      this.#store.tx(() => {
        this.#store.run("UPDATE disconnects SET state='done', result=?, updated_at=? WHERE installation_id=? AND request_id=?", JSON.stringify(result), this.#clock(), p.installationId, requestId);
        this.#store.run("UPDATE accounts SET state='deleted', updated_at=? WHERE account_ref=?", this.#clock(), accountRef);
      });
      return result;
    } finally { this.#inflight.delete(key); }
  }

  /** One pinned-version execution per (installation, requestId); a reused id is refused, never re-executed. No payload stored. */
  async execute(p: ServicePrincipal, raw: unknown): Promise<{ version: 1; requestId: string; data: JsonValue }> {
    const input = parse(PlatformExecutionRequestSchema, raw);
    const account = this.#ownedAccount(p, input.accountRef);
    const entry = this.#safeCatalogMetadata([...this.#entries.values()]).find(entry=>entry.serviceId===input.serviceId) ?? fail("not_found");
    if (account.state !== "active" || account.profile_id !== input.profileId || account.service_id !== input.serviceId || account.toolkit !== input.toolkit
      || entry.toolkit !== input.toolkit || input.version !== entry.toolkitVersion || !entry.tools.some(t => t.upstreamSlug === input.slug && t.version === input.version))
      fail("not_found");
    const hash = sha256({ ...input, arguments: sha256(input.arguments) }), now = this.#clock();
    const inserted = this.#store.tx(() => {
      if (this.#store.one("SELECT 1 FROM executions WHERE installation_id=? AND request_id=?", p.installationId, input.requestId)) return false;
      this.#store.run("INSERT INTO executions VALUES (?,?,?,?,'inflight',?,?)", p.installationId, input.requestId, hash, input.accountRef, now, now);
      return true;
    });
    if (!inserted) fail("duplicate");
    const settle = (state: string) => this.#store.tx(() => this.#store.run("UPDATE executions SET state=?, updated_at=? WHERE installation_id=? AND request_id=?", state, this.#clock(), p.installationId, input.requestId));
    let data: JsonValue;
    try {
      data = await this.#composio.execute({ slug: input.slug, version: input.version, userId: account.user_id as string, accountId: input.accountRef,
        arguments: input.arguments as Record<string, JsonValue> }, this.#abort.signal);
    } catch (error) {
      const failure = providerFailure(error);
      settle(failure.code === "outcome_unknown" ? "unknown" : "failed");
      throw failure;
    }
    settle("done");
    return { version: CONNECTIONS_PLATFORM_VERSION, requestId: input.requestId, data };
  }

  close(): void { this.#abort.abort(); this.#store.close(); }
}
