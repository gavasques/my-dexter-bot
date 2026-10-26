import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CONNECTIONS_CONTRACT_VERSION, ConnectionAccountIdSchema, ConnectionAuthorizationCallbackSchema, DisconnectConnectionAccountSchema,
  SetConnectionBotAccessSchema, SetConnectionLabelSchema, StartConnectionAuthorizationSchema,
  type ConnectionAccount, type ConnectionAccounts, type ConnectionAuthorization, type ConnectionCatalog, type ConnectionCatalogEntry, type ConnectionReceipt,
  type ConnectionsStatus, type JsonValue, type PlatformAttempt, type PlatformCatalogEntry, type PlatformIdentity, type ConnectionIdentity, type GrantBatch, type GrantBatchReceipt, type ConnectionWorkflow,
} from "@dexter/contracts";
import { checkManifest, manifestHash, type AdapterCall, type CapabilityGateway, type CredentialBroker, type InjectedAuth, type ToolManifest, type UpstreamAdapter, type WriterLease } from "@dexter/gateway";
import { isMetaSlug } from "./composio.js";
import { ConnectionsPlatformClient, ConnectionsPlatformError } from "./connections-platform-client.js";
import { ConnectorError } from "./errors.js";
import type { FetchLike, HttpLimits } from "./http.js";
import {assertSafeMcpMetadata, inspectMcpMetadata, MCP_METADATA_CATALOG_LIMITS} from './mcp/metadata-security.js';
import {ToolExecutionFailure} from '@dexter/contracts';

/**
 * Host runtime of app connections (UX-P1-09), managed route over the TRUSTED connections service.
 *
 * Persistence: `connections.sqlite` beside the canonical store, local schema "1" (no global hub schema change), every
 * write under the host writer lease. It holds no credential, token, code, verifier, header or authorization link.
 * Authorization links live only in process memory until they expire.
 *
 * Authority: connecting records an account and a gateway connection; it grants nothing. Bot access is an explicit owner
 * mutation (expected revision + client request id + receipt) that writes hub grants with policy `ask`/`deny`; the
 * bot's approval mode still applies to every action. Bots never reach this object (owner loopback HTTP only).
 *
 * Unknown outcomes: a provider write whose outcome is unknown stays `unknown` and is reconciled by read-only GETs.
 * Nothing here retries a provider write or falls back to another route/provider.
 */
export type ConnectionsErrorCode = "invalid_input" | "forbidden" | "not_found" | "conflict" | "catalog_changed" | "unavailable" | "outcome_unknown" | "closed";
export class ConnectionsError extends Error {
  constructor(readonly code: ConnectionsErrorCode) { super(`connections: ${code}`); this.name = "ConnectionsError"; }
}
/** Structural subset of HostStore. Grants stay in the hub (the only grant authority). */
export interface ConnectionsHost {
  readonly hostId: string;
  readonly ownerId: string;
  readonly databasePath: string;
  withWriterLease: WriterLease;
  listBots(): Array<{ id: string; profileId: string }>;
  getBot(id: string): { id: string; profileId: string };
  setGrant(input: unknown): unknown;
  applyGrantBatch(input:unknown):GrantBatchReceipt;
  grantBatchReceipt(operationId:string):GrantBatchReceipt|null;
  connectionWorkflow(id:string):ConnectionWorkflow|null;
  getGrant(botId: string, tool: string, destination: string): { policy: "allow" | "ask" | "deny"; expiresAt: number | null; revision:number } | null;
  now(): number;
}
/** Read-only projection source over the native MCP manager (direct route). */
export interface DirectConnectionsSource {
  /** `persistent` only when the durable custodian confirmed custody (UX-P1-10); otherwise `volatile`. */
  persistence(): "volatile" | "persistent";
  list(): Array<{ serverId: string; name: string; state: "connected" | "needs_reconnect" | "unknown"; persisted: boolean;
    /** Validated OAuth issuer (who issued the tokens). Not an account identity. */
    issuer: string | null; gatewayConnectionIds: string[] }>;
}
export interface ConnectionsRuntimeOptions {
  identity: { installationId: string; ownerId: string };
  platform: { origin: string; capability: () => string; fetch: FetchLike; limits?: Partial<HttpLimits> };
  /** Fixed broker reference of the installation capability. Never accepted from the platform or an engine. */
  credentialRef: string;
}
export interface ConnectionsAdmin {
  status(): ConnectionsStatus;
  catalog(): Promise<ConnectionCatalog>;
  startAuthorization(input: unknown): Promise<{ created: boolean; authorization: ConnectionAuthorization }>;
  authorization(clientRequestId: string): Promise<ConnectionAuthorization>;
  callback(clientRequestId: string, input: unknown): Promise<ConnectionAuthorization>;
  accounts(): ConnectionAccounts;
  account(id: string): Promise<ConnectionAccount>;
  setAccess(id: string, input: unknown): ConnectionReceipt;
  setLabel(id: string, input: unknown): ConnectionReceipt;
  disconnect(id: string, input: unknown): Promise<ConnectionReceipt>;
  receipt(clientRequestId: string): ConnectionReceipt | null;
  setupAuthorizations?(id:string):string[];
}

export const CONNECTIONS_DATABASE_FILE = "connections.sqlite";
/** "2" (UX-P1-11): identity kind/source/checkedAt, `identity_mismatch` status and `label` receipts. "1" migrates explicitly. */
export const CONNECTIONS_SCHEMA_VERSION = "3";
const ACCESS_JOURNAL_TABLE=`CREATE TABLE access_journal(client_request_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,expected_revision INTEGER NOT NULL,plan TEXT NOT NULL,input TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('prepared','completed','conflict')),created_at INTEGER NOT NULL) STRICT;`;
const ACCOUNTS_TABLE = (name: string): string => `CREATE TABLE ${name}(
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL, provider TEXT NOT NULL, display_name TEXT NOT NULL, provider_account_ref TEXT NOT NULL UNIQUE,
  profile_id TEXT NOT NULL, toolkit TEXT NOT NULL, toolkit_version TEXT NOT NULL, tools TEXT NOT NULL, gateway_connection_id TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL, identity_confirmation TEXT NOT NULL CHECK(identity_confirmation IN ('provider_verified','provider_display_name','unconfirmed')), identity_value TEXT,
  status TEXT NOT NULL CHECK(status IN ('connected','needs_reconnect','disconnecting','disconnected','replaced','identity_mismatch','unknown')),
  status_checked_at INTEGER, attempt_id TEXT NOT NULL UNIQUE, previous_account_id TEXT, disconnect TEXT, pending_request TEXT,
  revision INTEGER NOT NULL CHECK(revision > 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  identity_kind TEXT, identity_source TEXT, identity_checked_at INTEGER) STRICT;`;
const RECEIPTS_TABLE = (name: string): string => `CREATE TABLE ${name}(client_request_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('access','disconnect','label')),
  account_id TEXT NOT NULL, request_hash TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;`;
const V1_ACCOUNT_COLUMNS = "id, service_id, provider, display_name, provider_account_ref, profile_id, toolkit, toolkit_version, tools, gateway_connection_id, label, identity_confirmation, identity_value, status, status_checked_at, attempt_id, previous_account_id, disconnect, pending_request, revision, created_at, updated_at";
/**
 * Explicit, in-place 1 → 2 (same transaction as the meta bump): rebuilds two tables for their CHECKs, rewrites no meaning.
 * Earlier receipts gain `label: null` (the v2 receipt shape); their request hash and every other field stay byte-equal.
 */
const MIGRATE_1_TO_2 = `${ACCOUNTS_TABLE("accounts_v2")}
INSERT INTO accounts_v2 (${V1_ACCOUNT_COLUMNS}) SELECT ${V1_ACCOUNT_COLUMNS} FROM accounts;
UPDATE accounts_v2 SET identity_kind='display_name', identity_source='provider_label', identity_checked_at=status_checked_at WHERE identity_confirmation='provider_display_name' AND identity_value IS NOT NULL;
DROP TABLE accounts; ALTER TABLE accounts_v2 RENAME TO accounts;
${RECEIPTS_TABLE("receipts_v2")}
INSERT INTO receipts_v2 SELECT client_request_id, kind, account_id, request_hash, json_set(body, '$.label', NULL), created_at FROM receipts;
DROP TABLE receipts; ALTER TABLE receipts_v2 RENAME TO receipts;`;
const SCHEMA = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE catalog_revisions(revision INTEGER PRIMARY KEY CHECK(revision > 0), pin TEXT NOT NULL UNIQUE, body TEXT NOT NULL, fetched_at INTEGER NOT NULL) STRICT;
CREATE TABLE attempts(
  id TEXT PRIMARY KEY, client_request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, service_id TEXT NOT NULL,
  catalog_revision INTEGER NOT NULL, catalog_pin TEXT NOT NULL, profile_id TEXT NOT NULL, label TEXT, replaces_account_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('starting','awaiting_user','verifying','connected','failed','expired','cancelled','mismatch','unknown')),
  reason TEXT, callback TEXT NOT NULL CHECK(callback IN ('none','returned','cancelled')), provider_account_ref TEXT, expires_at INTEGER,
  account_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
${ACCOUNTS_TABLE("accounts")}
${RECEIPTS_TABLE("receipts")}
${ACCESS_JOURNAL_TABLE}
`;
const TERMINAL = new Set(["connected", "failed", "expired", "cancelled", "mismatch"]);
const RECONCILE = new Set(["starting", "awaiting_user", "verifying", "unknown"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CATALOG_TTL_MS = 30_000;
const NOT_STARTED_GRACE_MS = 60_000;
const MAX_LINK_MS = 60 * 60 * 1000;
const MAX_ACCOUNTS = 200;
type Row = Record<string, unknown>;
interface PinnedTool { name: string; hash: string; effect: "read" | "write"; slug: string; version: string; description: string }
interface Snapshot { revision: number; pin: string; services: Array<PlatformCatalogEntry & { manifests: ToolManifest[] }>; fetchedAt: number }

const fail = (code: ConnectionsErrorCode): never => { throw new ConnectionsError(code); };
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Row)[k])}`).join(",")}}`;
}
const sha256 = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
/** Digest that binds `connections.sqlite` to one service configuration (`meta.configuration`); a different one refuses. */
export const connectionsConfigurationDigest = (origin: string, credentialRef: string): string => sha256({ origin, credentialRef });
function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : fail("invalid_input");
}
const text = (value: unknown): string => typeof value === "string" && ID.test(value) ? value : fail("invalid_input");

export class ConnectionsRuntime {
  readonly adapter: UpstreamAdapter;
  readonly broker: CredentialBroker;
  readonly #identity: Readonly<{ installationId: string; ownerId: string }>;
  readonly #platform: ConnectionsPlatformClient;
  readonly #credentialRef: string;
  readonly #abort = new AbortController();
  readonly #work = new Set<Promise<unknown>>();
  readonly #links = new Map<string, { url: string; expiresAt: number }>();
  readonly #reconciles = new Map<string, Promise<ConnectionAuthorization>>();
  /** Attempts whose provider write is in flight in THIS process: a concurrent read must not settle them. */
  readonly #starting = new Set<string>();
  #catalogFlight: Promise<ConnectionCatalog> | null = null;
  #lastFetch: { at: number; ok: boolean } | null = null;
  #store: ConnectionsHost | null = null;
  #gateway: CapabilityGateway | null = null;
  #direct: DirectConnectionsSource | null = null;
  #db: DatabaseSync | null = null;
  #path = "";
  #closing = false;
  #closed = false;
  #closeFlight: Promise<void> | null = null;

  constructor(options: ConnectionsRuntimeOptions) {
    try {
      const keys = Object.keys(options);
      if (keys.some(k => !["identity", "platform", "credentialRef"].includes(k))) throw new Error();
      const identity = JSON.parse(JSON.stringify(options.identity)) as Row;
      if (Object.keys(identity).sort().join() !== "installationId,ownerId") throw new Error();
      this.#identity = Object.freeze({ installationId: text(identity["installationId"]), ownerId: text(identity["ownerId"]) });
      this.#credentialRef = text(options.credentialRef);
      const p = options.platform;
      if (Object.keys(p).some(k => !["origin", "capability", "fetch", "limits"].includes(k))) throw new Error();
      this.#platform = new ConnectionsPlatformClient({ origin: p.origin, installationId: this.#identity.installationId, capability: p.capability, fetch: p.fetch,
        ...(p.limits === undefined ? {} : { limits: JSON.parse(JSON.stringify(p.limits)) as Partial<HttpLimits> }) });
    } catch { throw new ConnectionsError("invalid_input"); }
    this.adapter = Object.freeze({ execute: (call: AdapterCall, auth: InjectedAuth, context: { signal: AbortSignal }) => this.#execute(call, auth, context) });
    this.broker = Object.freeze({
      acquire: (ref: string, host: string): InjectedAuth | null => {
        if (this.#closing || this.#closed || !this.#db || ref !== this.#credentialRef || host !== this.#platform.host) return null;
        // An absent/invalid private capability is "credential unavailable" (the action stays ready), never an exception.
        try { return Object.freeze({ headers: Object.freeze(this.#platform.authorizationHeaders()) }); } catch { return null; }
      },
      secretValues: () => this.#platform.secretValues(),
    });
  }
  get serviceHost(): string { return this.#platform.host; }
  toJSON() { return { kind: "host_connections_runtime", ...this.#identity, state: this.#closed ? "closed" : this.#closing ? "closing" : this.#db ? "bound" : "unbound" }; }

  /** Opens `connections.sqlite` under the writer lease. A different installation/owner/service configuration refuses. */
  bind(store: ConnectionsHost, gateway: CapabilityGateway, direct?: DirectConnectionsSource): void {
    if (this.#closing || this.#closed) fail("closed");
    if (this.#db) fail("conflict");
    if (store.hostId !== this.#identity.installationId || store.ownerId !== this.#identity.ownerId || gateway.registry.installationId !== store.hostId
      || gateway.registry.ownerId !== store.ownerId || dirname(gateway.registry.databasePath) !== dirname(store.databasePath)) fail("conflict");
    this.#path = join(dirname(store.databasePath), CONNECTIONS_DATABASE_FILE);
    const configuration = connectionsConfigurationDigest(this.#platform.origin, this.#credentialRef);
    this.#db = store.withWriterLease(() => {
      this.#files();
      const db = new DatabaseSync(this.#path);
      try {
        chmodSync(this.#path, 0o600);
        db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;");
        const exists = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='meta'").get();
        if (!exists) {
          db.exec(SCHEMA);
          const put = db.prepare("INSERT INTO meta VALUES (?,?)");
          for (const [k, v] of [["schema", CONNECTIONS_SCHEMA_VERSION], ["installation", store.hostId], ["owner", store.ownerId], ["configuration", configuration]] as const) put.run(k, v);
        }
        const get = (key: string) => (db.prepare("SELECT value FROM meta WHERE key=?").get(key) as Row | undefined)?.value;
        if (get("installation") !== store.hostId || get("owner") !== store.ownerId || get("configuration") !== configuration) fail("conflict");
        if (get("schema") === "1") { db.exec(MIGRATE_1_TO_2); db.prepare("UPDATE meta SET value='2' WHERE key='schema'").run(); }
        if(get("schema")==="2"){db.exec(ACCESS_JOURNAL_TABLE);db.prepare("UPDATE meta SET value=? WHERE key='schema'").run(CONNECTIONS_SCHEMA_VERSION);}
        if (get("schema") !== CONNECTIONS_SCHEMA_VERSION) fail("conflict");
        // A provider write interrupted by the previous process is never resumed: it is unknown until a read settles it.
        db.prepare("UPDATE attempts SET state='unknown', reason='outcome_unknown', updated_at=? WHERE state='starting'").run(store.now());
        db.exec("COMMIT");
        this.#files();
        return db;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* not in a transaction */ }
        db.close();
        throw error;
      }
    });
    this.#store = store; this.#gateway = gateway; this.#direct = direct ?? null;
  }
  #files(): void {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      let stat;
      try { stat = lstatSync(this.#path + suffix); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) fail("conflict");
      chmodSync(this.#path + suffix, 0o600);
    }
  }
  #bound(): { store: ConnectionsHost; gateway: CapabilityGateway; db: DatabaseSync } {
    if (this.#closing || this.#closed) fail("closed");
    if (!this.#db || !this.#store || !this.#gateway) return fail("unavailable");
    return { store: this.#store, gateway: this.#gateway, db: this.#db };
  }
  #write<T>(fn: (db: DatabaseSync) => T): T {
    const { store, db } = this.#bound();
    return store.withWriterLease(() => {
      this.#files();
      db.exec("BEGIN IMMEDIATE");
      try { const out = fn(db); db.exec("COMMIT"); return out; }
      catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    });
  }
  #track<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#closing || this.#closed) return Promise.reject(new ConnectionsError("closed"));
    const p = Promise.resolve().then(fn);
    this.#work.add(p);
    void p.then(() => this.#work.delete(p), () => this.#work.delete(p));
    return p;
  }
  #now(): number { return this.#bound().store.now(); }

  get admin(): Readonly<ConnectionsAdmin> {
    this.#bound();
    return Object.freeze({
      status: () => this.#status(),
      catalog: () => this.#catalog(),
      startAuthorization: (input: unknown) => this.#start(input),
      authorization: (id: string) => this.#authorization(text(id)),
      callback: (id: string, input: unknown) => this.#callback(text(id), input),
      accounts: () => this.#accounts(),
      account: (id: string) => this.#account(id),
      setAccess: (id: string, input: unknown) => this.#setAccess(id, input),
      setLabel: (id: string, input: unknown) => this.#setLabel(id, input),
      disconnect: (id: string, input: unknown) => this.#disconnect(id, input),
      receipt: (id: string) => this.#receipt(text(id)),
      setupAuthorizations:(id:string)=>this.#bound().db.prepare("SELECT a.* FROM meta m JOIN attempts a ON m.key='setup_authorization_v1:'||a.client_request_id WHERE m.value=? AND a.state='awaiting_user' ORDER BY a.created_at,a.client_request_id").all(text(id))
        .filter(row=>this.#attemptView(row).linkAvailable).map(row=>row.client_request_id as string),
    });
  }

  // ---- status and catalog ---------------------------------------------------------------------

  #status(): ConnectionsStatus {
    const { db, store } = this.#bound();
    const open = Number((db.prepare("SELECT count(*) AS n FROM attempts WHERE state IN ('starting','awaiting_user','verifying','unknown')").get() as Row).n);
    return { version: CONNECTIONS_CONTRACT_VERSION, hostId: store.hostId, platform: this.#lastFetch === null || this.#lastFetch.ok ? "available" : "unavailable",
      managedProviders: ["composio"], direct: this.#direct ? "native_mcp" : "unconfigured",
      nativeOAuthPersistence: this.#direct ? this.#direct.persistence() : "unconfigured", openAuthorizations: Math.min(open, 10_000) };
  }
  #snapshot(revision?: number): Snapshot | null {
    const { db } = this.#bound();
    const row = (revision === undefined ? db.prepare("SELECT * FROM catalog_revisions ORDER BY fetched_at DESC, revision DESC LIMIT 1").get()
      : db.prepare("SELECT * FROM catalog_revisions WHERE revision=?").get(revision)) as Row | undefined;
    if (!row) return null;
    return { revision: Number(row.revision), pin: row.pin as string, services: JSON.parse(row.body as string) as Snapshot["services"], fetchedAt: Number(row.fetched_at) };
  }
  /** Quarantines contaminated definitions before DB/context; healthy tools and services remain usable. */
  #validateCatalog(raw: { services: PlatformCatalogEntry[] }): Snapshot["services"] {
    const secrets=this.broker.secretValues();
    const aggregate=inspectMcpMetadata(raw,secrets,MCP_METADATA_CATALOG_LIMITS);
    if (aggregate.reason === "metadata_limit") return fail("invalid_input");
    const safeServices = raw.services.flatMap(entry => {
      const {tools,...metadata}=entry;
      if (!inspectMcpMetadata(metadata,secrets).safe) return [];
      const safeTools=tools.filter(tool=>inspectMcpMetadata(tool,secrets).safe);
      return safeTools.length ? [{...entry,tools:safeTools}] : [];
    });
    try { assertSafeMcpMetadata(safeServices,secrets,MCP_METADATA_CATALOG_LIMITS); } catch { return fail("invalid_input"); }
    const names = new Set<string>(), services = new Set<string>();
    return safeServices.flatMap(entry => {
      if (services.has(entry.serviceId)) fail("invalid_input");
      services.add(entry.serviceId);
      const manifests = entry.tools.flatMap(value => {
        let m: ToolManifest;
        try { m = checkManifest(value); } catch { return []; }
        if (m.toolkit !== entry.toolkit || m.version !== entry.toolkitVersion || m.upstreamHost !== this.#platform.host || isMetaSlug(m.upstreamSlug)
          || !/^[A-Z][A-Z0-9_]{0,127}$/.test(m.upstreamSlug) || names.has(m.name)) return [];
        names.add(m.name);
        return [m];
      });
      return manifests.length ? [{ ...entry, tools: [], manifests }] : [];
    });
  }
  #catalogView(snapshot: Snapshot | null, fresh: boolean): ConnectionCatalog {
    const { store } = this.#bound();
    const platform = this.#lastFetch === null ? (snapshot ? "available" : "unavailable") : this.#lastFetch.ok ? "available" : "unavailable";
    const profiles = new Set(store.listBots().map(b => b.profileId));
    return {
      version: CONNECTIONS_CONTRACT_VERSION, hostId: store.hostId, platform, revision: snapshot?.revision ?? 0, pin: snapshot?.pin ?? null,
      fetchedAt: snapshot?.fetchedAt ?? null, freshness: !snapshot ? "never" : fresh ? "fresh" : "stale",
      services: (snapshot?.services ?? []).map((s): ConnectionCatalogEntry => ({
        serviceId: s.serviceId, displayName: s.displayName, description: s.description, route: { kind: "managed", provider: s.provider },
        authorization: s.authorization, identity: s.identity, verification: s.verification,
        tools: s.manifests.map(m => ({ name: m.name, description: m.description.slice(0, 280) || m.name, effect: m.effect })),
        availability: platform !== "available" ? { state: "unavailable", reason: "platform_unavailable" }
          : profiles.size === 0 ? { state: "unavailable", reason: "no_eligible_profile" } : { state: "available", reason: null },
      })),
    };
  }
  #catalog(): Promise<ConnectionCatalog> {
    const now = this.#now();
    if (this.#lastFetch?.ok && now - this.#lastFetch.at < CATALOG_TTL_MS) return Promise.resolve(this.#catalogView(this.#snapshot(), true));
    return this.#catalogFlight ??= this.#track(async () => {
      try {
        let raw;
        try { raw = await this.#platform.catalog(this.#abort.signal); }
        catch { this.#lastFetch = { at: this.#now(), ok: false }; return this.#catalogView(this.#snapshot(), false); }
        const services = this.#validateCatalog(raw);
        const pin = sha256(raw.services);
        const at = this.#now();
        const snapshot = this.#write(db => {
          // One revision per distinct pin, forever: content seen again keeps its revision (attempts pinned to it stay valid).
          // The current snapshot is the most recently fetched one.
          const existing = db.prepare("SELECT revision FROM catalog_revisions WHERE pin=?").get(pin) as Row | undefined;
          let revision: number;
          if (existing) { revision = Number(existing.revision); db.prepare("UPDATE catalog_revisions SET fetched_at=? WHERE revision=?").run(at, revision); }
          else {
            revision = Number((db.prepare("SELECT coalesce(max(revision),0) AS r FROM catalog_revisions").get() as Row).r) + 1;
            db.prepare("INSERT INTO catalog_revisions VALUES (?,?,?,?)").run(revision, pin, JSON.stringify(services), at);
          }
          db.prepare(`DELETE FROM catalog_revisions WHERE revision NOT IN (SELECT revision FROM catalog_revisions ORDER BY fetched_at DESC, revision DESC LIMIT 8)
            AND revision NOT IN (SELECT catalog_revision FROM attempts WHERE state IN ('starting','awaiting_user','verifying','unknown'))`).run();
          return revision;
        });
        this.#lastFetch = { at, ok: true };
        return this.#catalogView(this.#snapshot(snapshot), true);
      } finally { this.#catalogFlight = null; }
    });
  }

  // ---- authorization --------------------------------------------------------------------------

  #attemptRow(clientRequestId: string): Row | undefined {
    return this.#bound().db.prepare("SELECT * FROM attempts WHERE client_request_id=?").get(clientRequestId) as Row | undefined;
  }
  #attemptView(row: Row): ConnectionAuthorization {
    const { store } = this.#bound();
    const link = this.#links.get(row.id as string);
    const live = link && row.state === "awaiting_user" && row.expires_at!==null && Number(row.expires_at)>store.now() && link.expiresAt > store.now() ? link : null;
    const snapshot = this.#snapshot(Number(row.catalog_revision));
    const service = snapshot?.services.find(s => s.serviceId === row.service_id);
    return {
      version: CONNECTIONS_CONTRACT_VERSION, hostId: store.hostId, id: row.id as string, clientRequestId: row.client_request_id as string,
      requestHash: row.request_hash as string, serviceId: row.service_id as string, route: { kind: "managed", provider: service?.provider ?? "composio" },
      catalogRevision: Number(row.catalog_revision), catalogPin: row.catalog_pin as string, profileId: row.profile_id as string,
      state: row.state as ConnectionAuthorization["state"], reason: (row.reason as ConnectionAuthorization["reason"]) ?? null,
      authorizationURL: live?.url ?? null, linkAvailable: live !== null, expiresAt: row.expires_at === null ? null : Number(row.expires_at),
      callback: row.callback as ConnectionAuthorization["callback"], accountId: (row.account_id as string | null) ?? null,
      replacesAccountId: (row.replaces_account_id as string | null) ?? null, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      ...(()=>{const setup=this.#bound().db.prepare("SELECT value FROM meta WHERE key=?").get(`setup_authorization_v1:${row.client_request_id}`) as Row|undefined;return setup?{setupRequestId:setup.value as string}:{};})(),
    };
  }
  #setAttempt(id: string, fields: Row, onlyFrom?: readonly string[]): void {
    this.#write(db => {
      const sets = Object.keys(fields).map(k => `${k}=?`).join(",");
      const guard = onlyFrom ? ` AND state IN (${onlyFrom.map(() => "?").join(",")})` : "";
      db.prepare(`UPDATE attempts SET ${sets}, updated_at=? WHERE id=?${guard}`)
        .run(...(Object.values(fields) as Array<string | number | null>), this.#now(), id, ...(onlyFrom ?? []));
    });
  }
  #profileFor(requested: string | null): string {
    const { store } = this.#bound();
    const profiles = [...new Set(store.listBots().map(b => b.profileId))];
    if (requested !== null) return profiles.includes(requested) ? requested : fail("forbidden");
    if (profiles.length === 0) return fail("forbidden");
    return profiles.length === 1 ? profiles[0]! : fail("invalid_input");
  }

  #start(raw: unknown): Promise<{ created: boolean; authorization: ConnectionAuthorization }> {
    const { store } = this.#bound();
    const input = parse(StartConnectionAuthorizationSchema, raw);
    if (input.expectedHostID !== store.hostId) fail("conflict");
    const requestHash = sha256(input);
    const existing = this.#attemptRow(input.clientRequestId);
    if (existing) {
      if (existing.request_hash !== requestHash) fail("conflict");
      return Promise.resolve({ created: false, authorization: this.#attemptView(existing) });
    }
    let setupProfile:string|null=null;
    if(input.setupRequestId){const setup=store.connectionWorkflow(input.setupRequestId)??fail("conflict");
      if(setup.state!=="awaiting_user"||setup.target.kind!=="managed"||setup.target.serviceId!==input.serviceId||setup.target.catalogPin!==input.catalogPin)fail("conflict");
      setupProfile=store.getBot(setup.botId).profileId;if(input.profileId!==null&&input.profileId!==setupProfile)fail("forbidden");}
    const snapshot = this.#snapshot();
    if (!snapshot || snapshot.pin !== input.catalogPin) fail("catalog_changed");
    const service = snapshot!.services.find(s => s.serviceId === input.serviceId) ?? fail("not_found");
    const profileId = this.#profileFor(setupProfile??input.profileId);
    if (input.replacesAccountId !== null) {
      const old = this.#accountRow(input.replacesAccountId) ?? fail("not_found");
      if (old.service_id !== input.serviceId || old.profile_id !== profileId || !["connected", "needs_reconnect", "identity_mismatch", "unknown"].includes(old.status as string)) fail("conflict");
    }
    const id = `auth_${randomUUID()}`, now = store.now();
    const inserted = this.#write(db => {
      if (db.prepare("SELECT 1 FROM attempts WHERE client_request_id=?").get(input.clientRequestId)) return false;
      db.prepare(`INSERT INTO attempts (id, client_request_id, request_hash, service_id, catalog_revision, catalog_pin, profile_id, label, replaces_account_id,
        state, reason, callback, provider_account_ref, expires_at, account_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,'starting',NULL,'none',NULL,NULL,NULL,?,?)`)
        .run(id, input.clientRequestId, requestHash, input.serviceId, snapshot!.revision, snapshot!.pin, profileId, input.label, input.replacesAccountId, now, now);
      if(input.setupRequestId)db.prepare("INSERT INTO meta(key,value)VALUES(?,?)").run(`setup_authorization_v1:${input.clientRequestId}`,input.setupRequestId);
      return true;
    });
    if (!inserted) {
      const row = this.#attemptRow(input.clientRequestId)!;
      if (row.request_hash !== requestHash) fail("conflict");
      return Promise.resolve({ created: false, authorization: this.#attemptView(row) });
    }
    this.#starting.add(id);
    return this.#track(async () => {
      let response;
      try {
        response = await this.#platform.startAuthorization({ requestId: input.clientRequestId, profileId, serviceId: input.serviceId, catalogPin: snapshot!.pin }, this.#abort.signal);
      } catch (error) {
        const e = error instanceof ConnectionsPlatformError ? error : new ConnectionsPlatformError("unknown", "unknown");
        if (e.outcome === "unknown") { this.#setAttempt(id, { state: "unknown", reason: "outcome_unknown" }, ["starting"]); return fail("outcome_unknown"); }
        const reason = e.code === "catalog_changed" ? "catalog_changed" : e.code === "unavailable" || e.code === "unauthorized" ? "platform_unavailable" : "provider_refused";
        this.#setAttempt(id, { state: "failed", reason }, ["starting"]);
        return { created: true, authorization: this.#attemptView(this.#attemptRow(input.clientRequestId)!) };
      }
      const a = response.attempt, now2 = this.#now();
      let url: URL | null = null;
      try { url = response.authorizationURL === null ? null : new URL(response.authorizationURL); } catch { url = null; }
      const valid = a.requestId === input.clientRequestId && a.serviceId === input.serviceId && a.profileId === profileId && a.catalogPin === snapshot!.pin
        && a.state === "awaiting_user" && a.accountRef !== null && a.expiresAt !== null && a.expiresAt > now2 && a.expiresAt <= now2 + MAX_LINK_MS
        && url !== null && url.protocol === "https:" && !url.username && !url.password && service.authorizationOrigins.includes(url.origin);
      if (!valid) {
        // The service may have created the link: never discard that possibility, reconcile by GET.
        this.#setAttempt(id, { state: "unknown", reason: "outcome_unknown" }, ["starting"]);
        return fail("outcome_unknown");
      }
      this.#links.set(id, { url: url!.href, expiresAt: a.expiresAt! });
      this.#setAttempt(id, { state: "awaiting_user", reason: null, provider_account_ref: a.accountRef, expires_at: a.expiresAt }, ["starting"]);
      return { created: true, authorization: this.#attemptView(this.#attemptRow(input.clientRequestId)!) };
    }).finally(() => { this.#starting.delete(id); });
  }

  #authorization(clientRequestId: string): Promise<ConnectionAuthorization> {
    const row = this.#attemptRow(clientRequestId) ?? fail("not_found");
    if (TERMINAL.has(row.state as string) || !RECONCILE.has(row.state as string) || this.#starting.has(row.id as string)) return Promise.resolve(this.#attemptView(row));
    const active = this.#reconciles.get(clientRequestId);
    if (active) return active;
    const flight = this.#track(() => this.#reconcile(clientRequestId)).finally(() => { if (this.#reconciles.get(clientRequestId) === flight) this.#reconciles.delete(clientRequestId); });
    this.#reconciles.set(clientRequestId, flight);
    return flight;
  }
  /** Read-only provider reconciliation. Never calls a provider write. */
  async #reconcile(clientRequestId: string): Promise<ConnectionAuthorization> {
    const row = this.#attemptRow(clientRequestId)!;
    let attempt: PlatformAttempt | null;
    try { attempt = await this.#platform.authorization(clientRequestId, this.#abort.signal); }
    catch { return this.#attemptView(this.#attemptRow(clientRequestId)!); }
    const id = row.id as string, now = this.#now(), from = ["starting", "awaiting_user", "verifying", "unknown"];
    if (attempt === null) {
      if ((row.state === "unknown" || row.state === "starting") && now - Number(row.created_at) >= NOT_STARTED_GRACE_MS)
        this.#setAttempt(id, { state: "failed", reason: "not_started" }, ["starting", "unknown"]);
      return this.#attemptView(this.#attemptRow(clientRequestId)!);
    }
    if (attempt.requestId !== clientRequestId || attempt.serviceId !== row.service_id || attempt.profileId !== row.profile_id || attempt.catalogPin !== row.catalog_pin) {
      this.#setAttempt(id, { state: "mismatch", reason: "account_mismatch" }, from);
      return this.#attemptView(this.#attemptRow(clientRequestId)!);
    }
    if (attempt.accountRef !== null && row.provider_account_ref !== null && attempt.accountRef !== row.provider_account_ref) {
      this.#setAttempt(id, { state: "mismatch", reason: "account_mismatch" }, from);
      return this.#attemptView(this.#attemptRow(clientRequestId)!);
    }
    const accountRef = (row.provider_account_ref as string | null) ?? attempt.accountRef;
    switch (attempt.state) {
      case "active":
        if (accountRef === null) break;
        this.#confirm(id, accountRef, attempt);
        break;
      case "failed": this.#setAttempt(id, { state: "failed", reason: attempt.reason === "provider_refused" ? "provider_refused" : attempt.reason === "not_started" ? "not_started" : "provider_failed",
        provider_account_ref: accountRef }, from); break;
      case "expired": this.#setAttempt(id, { state: "expired", reason: "link_expired", provider_account_ref: accountRef }, from); break;
      case "awaiting_user":
        if (row.state === "unknown" || row.state === "starting") {
          // Lost ACK: the link was created but never reached the owner; it is not re-served. The account may still complete.
          this.#setAttempt(id, { state: "awaiting_user", reason: "link_not_recoverable", provider_account_ref: accountRef, expires_at: attempt.expiresAt }, ["starting", "unknown"]);
        }
        break;
      default: break; // starting/unknown at the service: keep the current state until a read settles it
    }
    return this.#attemptView(this.#attemptRow(clientRequestId)!);
  }
  /** Account confirmed by the provider read through the trusted service. Creates the gateway connection; grants nothing. */
  #confirm(attemptId: string, accountRef: string, attempt: PlatformAttempt): void {
    const { gateway, store } = this.#bound();
    const row = this.#bound().db.prepare("SELECT * FROM attempts WHERE id=?").get(attemptId) as Row;
    if (!RECONCILE.has(row.state as string)) return;
    const snapshot = this.#snapshot(Number(row.catalog_revision));
    const service = snapshot?.services.find(s => s.serviceId === row.service_id);
    if (!snapshot || !service) { this.#setAttempt(attemptId, { state: "failed", reason: "catalog_changed" }, [...RECONCILE]); return; }
    const existingAccount = this.#bound().db.prepare("SELECT id FROM accounts WHERE provider_account_ref=?").get(accountRef) as Row | undefined;
    if (existingAccount) { this.#setAttempt(attemptId, { state: "mismatch", reason: "account_mismatch" }, [...RECONCILE]); return; }
    const tools: PinnedTool[] = service.manifests.map(m => ({ name: m.name, hash: manifestHash(m), effect: m.effect, slug: m.upstreamSlug, version: m.version, description: m.description }));
    for (const manifest of service.manifests) gateway.registerTool(manifest);
    const label = (row.label as string | null) ?? service.displayName;
    const accountId = `acct_${randomUUID()}`, now = store.now();
    const identity: PlatformIdentity = attempt.identity ?? { confirmation: "unconfirmed", value: null, kind: null, source: null };
    // The name engines see disambiguates several accounts of one service: service · identity, or a short host id.
    const named = identity.value !== null ? `${service.displayName} · ${identity.value}` : "";
    const engineLabel = named.length > 0 && named.length <= 120 ? named : `${label.slice(0, 100)} · ${accountId.slice(5, 13)}`;
    const candidates = gateway.registry.listConnections(row.profile_id as string).filter(c => c.status === "active" && c.toolkit === service.toolkit
      && c.upstreamAccountRef === accountRef && c.credentialRef === this.#credentialRef && c.allowedHosts.length === 1 && c.allowedHosts[0] === this.#platform.host);
    const reuse = this.#write(db => candidates.find(c => !db.prepare("SELECT 1 FROM accounts WHERE gateway_connection_id=?").get(c.id)));
    const connection = reuse ?? gateway.connectAccount({ profileId: row.profile_id as string, toolkit: service.toolkit, label: engineLabel, upstreamAccountRef: accountRef,
      credentialRef: this.#credentialRef, allowedHosts: [this.#platform.host] });
    let replaced: string | null = null;
    try {
      replaced = this.#write(db => {
        const latest = db.prepare("SELECT * FROM attempts WHERE id=?").get(attemptId) as Row;
        if (!RECONCILE.has(latest.state as string)) fail("conflict");
        if (db.prepare("SELECT 1 FROM accounts WHERE provider_account_ref=? OR gateway_connection_id=?").get(accountRef, connection.id)) fail("conflict");
        db.prepare(`INSERT INTO accounts (id, service_id, provider, display_name, provider_account_ref, profile_id, toolkit, toolkit_version, tools, gateway_connection_id,
          label, identity_confirmation, identity_value, status, status_checked_at, attempt_id, previous_account_id, disconnect, pending_request, revision, created_at, updated_at,
          identity_kind, identity_source, identity_checked_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'connected',?,?,?,NULL,NULL,1,?,?,?,?,?)`)
          .run(accountId, service.serviceId, service.provider, service.displayName, accountRef, row.profile_id as string, service.toolkit, service.toolkitVersion,
            JSON.stringify(tools), connection.id, label, identity.confirmation, identity.value, now, attemptId,
            (row.replaces_account_id as string | null) ?? null, now, now, identity.kind, identity.source, identity.value === null ? null : now);
        db.prepare("UPDATE attempts SET state='connected', reason=NULL, provider_account_ref=?, account_id=?, updated_at=? WHERE id=?").run(accountRef, accountId, now, attemptId);
        const previous = row.replaces_account_id as string | null;
        if (!previous) return null;
        const old = db.prepare("SELECT * FROM accounts WHERE id=?").get(previous) as Row | undefined;
        if (!old || !["connected", "needs_reconnect", "identity_mismatch", "unknown"].includes(old.status as string)) return null;
        db.prepare("UPDATE accounts SET status='replaced', revision=revision+1, updated_at=? WHERE id=?").run(now, previous);
        return old.gateway_connection_id as string;
      });
    } catch (error) {
      if (!reuse) { try { gateway.revokeConnection(connection.id); } catch { /* owner recovery of the cross-DB gap */ } }
      if (error instanceof ConnectionsError && error.code === "conflict") return;
      throw error;
    }
    // The replaced account stops locally; its upstream account is not deleted implicitly (explicit disconnect only).
    if (replaced) gateway.revokeConnection(replaced);
  }

  #callback(clientRequestId: string, raw: unknown): Promise<ConnectionAuthorization> {
    const { store } = this.#bound();
    const input = parse(ConnectionAuthorizationCallbackSchema, raw);
    if (input.expectedHostID !== store.hostId) fail("conflict");
    const row = this.#attemptRow(clientRequestId) ?? fail("not_found");
    if (TERMINAL.has(row.state as string)) return Promise.resolve(this.#attemptView(row));
    if (input.outcome === "cancelled") {
      this.#setAttempt(row.id as string, { state: "cancelled", reason: "user_cancelled", callback: "cancelled" }, [...RECONCILE]);
      this.#links.delete(row.id as string);
      return Promise.resolve(this.#attemptView(this.#attemptRow(clientRequestId)!));
    }
    if (input.providerAccountRef !== null && row.provider_account_ref !== null && input.providerAccountRef !== row.provider_account_ref) {
      this.#setAttempt(row.id as string, { state: "mismatch", reason: "account_mismatch", callback: "returned" }, [...RECONCILE]);
      this.#links.delete(row.id as string);
      return Promise.resolve(this.#attemptView(this.#attemptRow(clientRequestId)!));
    }
    this.#setAttempt(row.id as string, { state: row.state === "awaiting_user" ? "verifying" : row.state as string, callback: "returned" }, [...RECONCILE]);
    return this.#authorization(clientRequestId);
  }

  // ---- accounts -------------------------------------------------------------------------------

  #accountRow(id: string): Row | undefined { return this.#bound().db.prepare("SELECT * FROM accounts WHERE id=?").get(id) as Row | undefined; }
  #accountView(row: Row): ConnectionAccount {
    const { store, gateway } = this.#bound();
    const tools = JSON.parse(row.tools as string) as PinnedTool[];
    const connection = gateway.registry.getConnection(row.gateway_connection_id as string);
    const now = store.now();
    const active = connection?.status === "active" && ["connected", "needs_reconnect", "unknown"].includes(row.status as string);
    const bots = store.listBots().filter(b => b.profileId === row.profile_id).slice(0, 500).map(bot => {
      const usable = active ? tools.filter(t => { const g = store.getGrant(bot.id, t.name, connection!.id); return !!g && g.policy !== "deny" && (g.expiresAt === null || now < g.expiresAt); }).length : 0;
      const toolNames=active?tools.filter(t=>{const grant=store.getGrant(bot.id,t.name,row.gateway_connection_id as string);return grant&&grant.policy!=="deny"&&(grant.expiresAt===null||grant.expiresAt>now);}).map(t=>t.name).sort():[];
      return { botId: bot.id, access: usable === 0 ? "disabled" as const : usable === tools.length ? "enabled" as const : "partial" as const,toolNames };
    });
    let identityChanged: boolean | null = null;
    if (row.previous_account_id) {
      // Comparable only at the same level and kind (verified email vs verified email, label vs label).
      const old = this.#accountRow(row.previous_account_id as string);
      if (old && old.identity_value !== null && row.identity_value !== null && old.identity_confirmation === row.identity_confirmation && old.identity_kind === row.identity_kind)
        identityChanged = old.identity_value !== row.identity_value;
    }
    return {
      version: CONNECTIONS_CONTRACT_VERSION, hostId: store.hostId, id: row.id as string, serviceId: row.service_id as string, displayName: row.display_name as string,
      route: { kind: "managed", provider: row.provider as "composio" }, label: row.label as string,
      identity: this.#identityView(row),
      status: row.status as ConnectionAccount["status"], statusCheckedAt: row.status_checked_at === null ? null : Number(row.status_checked_at),
      persistence: "managed_service", manage: "connections", nativeServerId: null, revision: Number(row.revision), profileId: row.profile_id as string,
      tools: tools.map(t => ({ name: t.name, effect: t.effect,manifestHash:t.hash })), bots, previousAccountId: (row.previous_account_id as string | null) ?? null,
      gatewayConnectionIds: [row.gateway_connection_id as string], identityChanged,
      disconnect: row.disconnect === null ? null : JSON.parse(row.disconnect as string) as ConnectionAccount["disconnect"],
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
  }
  #identityView(row: Row): ConnectionIdentity {
    const value = (row.identity_value as string | null) ?? null, kind = (row.identity_kind as string | null) ?? null, source = (row.identity_source as string | null) ?? null;
    const checkedAt = row.identity_checked_at === null || row.identity_checked_at === undefined ? null : Number(row.identity_checked_at);
    if (value === null || kind === null || source === null || row.identity_confirmation === "unconfirmed")
      return { confirmation: "unconfirmed", value: null, kind: null, source: null, issuer: null, checkedAt: null };
    return { confirmation: row.identity_confirmation as ConnectionIdentity["confirmation"], value, kind: kind as ConnectionIdentity["kind"],
      source: source as ConnectionIdentity["source"], issuer: null, checkedAt };
  }
  #directViews(): ConnectionAccount[] {
    const { store } = this.#bound();
    return directConnectionViews(store.hostId, this.#direct, store.now());
  }
  #accounts(): ConnectionAccounts {
    const { db, store } = this.#bound();
    const managed = (db.prepare("SELECT * FROM accounts ORDER BY created_at, id").all() as Row[]).map(r => this.#accountView(r));
    return { version: CONNECTIONS_CONTRACT_VERSION, hostId: store.hostId, items: [...managed, ...this.#directViews()].slice(0, MAX_ACCOUNTS) };
  }
  /** Live read through the trusted service. Upstream revocation/absence closes the local connection (fail closed). */
  #account(rawId: string): Promise<ConnectionAccount> {
    const id = parse(ConnectionAccountIdSchema, rawId);
    if (id.startsWith("mcp_")) return Promise.resolve(this.#directViews().find(v => v.id === id) ?? fail("not_found"));
    const row = this.#accountRow(id) ?? fail("not_found");
    if (row.status === "disconnected" || row.status === "replaced") return Promise.resolve(this.#accountView(row));
    return this.#track(async () => {
      let live;
      try { live = await this.#platform.account(row.provider_account_ref as string, this.#abort.signal); }
      catch (error) {
        if (error instanceof ConnectionsPlatformError && error.code === "not_found" && row.status === "disconnecting") live = null;
        else return this.#accountView(this.#accountRow(id)!);
      }
      const now = this.#now();
      if (live && (live.accountRef !== row.provider_account_ref || live.serviceId !== row.service_id || live.profileId !== row.profile_id))
        return this.#accountView(this.#accountRow(id)!);
      const state = live === null ? "absent" : live.state;
      let revoke: string | null = null;
      this.#write(db => {
        const current = db.prepare("SELECT * FROM accounts WHERE id=?").get(id) as Row;
        if (current.status === "disconnected" || current.status === "replaced") return;
        if (current.status === "disconnecting") {
          // Our pending delete is settled only by absence; the original request then gets its receipt.
          if (state === "absent") this.#settleDisconnect(db, id, { upstream: "deleted", revocation: "requested" });
          else db.prepare("UPDATE accounts SET status_checked_at=? WHERE id=?").run(now, id);
          return;
        }
        if (state === "revoked" || state === "absent") {
          const disconnect = { upstream: state === "absent" ? "already_absent" : "not_requested", revocation: "not_requested" };
          db.prepare("UPDATE accounts SET status='disconnected', disconnect=?, status_checked_at=?, revision=revision+1, updated_at=? WHERE id=?").run(JSON.stringify(disconnect), now, now, id);
          revoke = current.gateway_connection_id as string;
          return;
        }
        if (current.status === "identity_mismatch") { db.prepare("UPDATE accounts SET status_checked_at=? WHERE id=?").run(now, id); return; }
        const status = state === "active" ? "connected" : state === "needs_reconnect" ? "needs_reconnect" : "unknown";
        const seen = live!.identity;
        if (current.identity_confirmation === "provider_verified" && seen.confirmation === "provider_verified"
          && (seen.value !== current.identity_value || seen.kind !== current.identity_kind)) {
          // The provider now verifies ANOTHER identity behind this account: stop it (fail closed); the owner reconnects and re-authorizes bots.
          db.prepare("UPDATE accounts SET status='identity_mismatch', status_checked_at=?, revision=revision+1, updated_at=? WHERE id=?").run(now, now, id);
          revoke = current.gateway_connection_id as string;
          return;
        }
        // A weaker or missing live read never downgrades a verified identity; labels may change; first verification upgrades.
        const adopt = seen.confirmation === "provider_verified" || (seen.confirmation === "provider_display_name" && current.identity_confirmation !== "provider_verified");
        if (adopt) db.prepare("UPDATE accounts SET status=?, identity_confirmation=?, identity_value=?, identity_kind=?, identity_source=?, identity_checked_at=?, status_checked_at=?, updated_at=? WHERE id=?")
          .run(status, seen.confirmation, seen.value, seen.kind, seen.source, now, now, now, id);
        else db.prepare("UPDATE accounts SET status=?, status_checked_at=?, updated_at=? WHERE id=?").run(status, now, now, id);
      });
      if (revoke) this.#bound().gateway.revokeConnection(revoke);
      return this.#accountView(this.#accountRow(id)!);
    });
  }

  #receiptRow(clientRequestId: string): Row | undefined { return this.#bound().db.prepare("SELECT * FROM receipts WHERE client_request_id=?").get(clientRequestId) as Row | undefined; }
  #receipt(clientRequestId: string): ConnectionReceipt | null {
    const row = this.#receiptRow(clientRequestId);
    return row ? JSON.parse(row.body as string) as ConnectionReceipt : this.#settleAccess(clientRequestId);
  }
  #replay(clientRequestId: string, kind: "access" | "disconnect" | "label", accountId: string, hash: string): ConnectionReceipt | null {
    const row = this.#receiptRow(clientRequestId);
    if (!row) return null;
    if (row.kind !== kind || row.account_id !== accountId || row.request_hash !== hash) fail("conflict");
    return JSON.parse(row.body as string) as ConnectionReceipt;
  }

  /** Owner-only CAS. Hub grants are the authority; the receipt records the original request and its result. */
  #setAccess(rawId: string, raw: unknown): ConnectionReceipt {
    const { store, gateway } = this.#bound();
    const id = parse(ConnectionAccountIdSchema, rawId);
    const input = parse(SetConnectionBotAccessSchema, raw);
    if (input.expectedHostID !== store.hostId) fail("conflict");
    if (id.startsWith("mcp_")) fail("forbidden");
    const hash = sha256({ id, ...input });
    const replay = this.#replay(input.clientRequestId, "access", id, hash);
    if (replay) return replay;
    const existing=this.#bound().db.prepare("SELECT * FROM access_journal WHERE client_request_id=?").get(input.clientRequestId) as Row|undefined;
    if(existing){if(existing.account_id!==id||existing.request_hash!==hash)fail("conflict");return this.#settleAccess(input.clientRequestId)??fail("outcome_unknown");}
    // applyGrantBatch is synchronous under the sole writer. Outside that call, a prepared intent is recoverable
    // by a read-only Hub receipt lookup; it must not lock all future owner changes to this account forever.
    for(const pending of this.#bound().db.prepare("SELECT client_request_id FROM access_journal WHERE account_id=? AND phase='prepared'").all(id))
      this.#settleAccess(pending.client_request_id as string);
    const row = this.#accountRow(id) ?? fail("not_found");
    if (Number(row.revision) !== input.expectedRevision) fail("conflict");
    const allowed = input.enabled ? ["connected"] : ["connected", "needs_reconnect", "identity_mismatch", "unknown"];
    if (!allowed.includes(row.status as string)) fail("conflict");
    let bot: { id: string; profileId: string };
    try { bot = store.getBot(input.botId); } catch { return fail("not_found"); }
    if (bot.profileId !== row.profile_id) fail("forbidden");
    const connectionId = row.gateway_connection_id as string, tools = JSON.parse(row.tools as string) as PinnedTool[];
    const selected=new Set(input.enabled?(input.toolNames??tools.map(t=>t.name)):[]);
    if(input.toolNames?.some(name=>!tools.some(t=>t.name===name))||!input.enabled&&!!input.toolNames?.length||input.enabled&&selected.size===0)fail("invalid_input");
    if (gateway.registry.getConnection(connectionId)?.status !== "active") fail("conflict");
    if (input.enabled && tools.some(t => { const reg = gateway.registry.getTool(t.name); return reg?.status !== "active" || reg.manifestHash !== t.hash; })) fail("conflict");
    const plan:GrantBatch={operationId:`connections:${input.clientRequestId}`,grants:tools.map(tool=>{
      const previous=store.getGrant(bot.id,tool.name,connectionId),enabled=selected.has(tool.name),retain=enabled&&previous&&previous.policy!=="deny"&&(previous.expiresAt===null||previous.expiresAt>store.now());
      return {botId:bot.id,tool:tool.name,destination:connectionId,expectedRevision:previous?.revision??0,
        policy:retain?previous.policy:enabled?"ask":"deny",expiresAt:retain?previous.expiresAt:null};})};
    this.#write(db=>{
      if(db.prepare("SELECT 1 FROM access_journal WHERE account_id=? AND phase='prepared'").get(id))fail("outcome_unknown");
      db.prepare("INSERT INTO access_journal VALUES(?,?,?,?,?,?,?,?)").run(input.clientRequestId,id,hash,input.expectedRevision,canonical(plan),canonical(input),"prepared",store.now());});
    // The immutable intent is durable BEFORE the only cross-DB effect. Never blindly repeat this call.
    try{store.applyGrantBatch(plan);}catch{fail("outcome_unknown");}
    return this.#settleAccess(input.clientRequestId)??fail("outcome_unknown");
  }

  /** GET recovery may finish a receipt from an already committed Hub batch. It never writes a grant. */
  #settleAccess(clientRequestId:string):ConnectionReceipt|null {
    const {store,db}=this.#bound();
    const journal=db.prepare("SELECT * FROM access_journal WHERE client_request_id=?").get(clientRequestId) as Row|undefined;
    if(!journal||journal.phase!=="prepared")return null;
    const plan=JSON.parse(journal.plan as string) as GrantBatch,committed=store.grantBatchReceipt(plan.operationId);
    const grantsCurrent=committed&&!committed.grants.some(g=>{const current=store.getGrant(g.botId,g.tool,g.destination);return !current||current.revision!==g.revision||current.policy!==g.policy||current.expiresAt!==g.expiresAt;});
    return this.#write(tx=>{
      const existing=this.#receiptRow(clientRequestId);if(existing)return JSON.parse(existing.body as string) as ConnectionReceipt;
      const row=this.#accountRow(journal.account_id as string),previousRevision=Number(journal.expected_revision);
      const outcome=!committed?"not_applied":!grantsCurrent||!row||Number(row.revision)!==previousRevision?"superseded":"applied";
      const input=JSON.parse(journal.input as string) as {botId:string;enabled:boolean;toolNames?:string[]},now=store.now();
      const receipt:ConnectionReceipt={version:CONNECTIONS_CONTRACT_VERSION,hostId:store.hostId,clientRequestId,kind:"access",accountId:journal.account_id as string,
        requestHash:journal.request_hash as string,previousRevision,revision:outcome==="applied"?previousRevision+1:outcome==="not_applied"?previousRevision:row?Number(row.revision):previousRevision,
        ...(outcome!=="applied"?{accessOutcome:outcome}:{}),
        access:{botId:input.botId,enabled:input.enabled,tools:committed?plan.grants.length:0,...(input.toolNames?{toolNames:input.toolNames}:{})},disconnect:null,label:null,createdAt:now};
      if(outcome==="applied")tx.prepare("UPDATE accounts SET revision=revision+1,updated_at=? WHERE id=?").run(now,journal.account_id as string);
      tx.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(clientRequestId,"access",journal.account_id as string,journal.request_hash as string,JSON.stringify(receipt),now);
      tx.prepare("UPDATE access_journal SET phase=? WHERE client_request_id=?").run(outcome==="applied"?"completed":"conflict",clientRequestId);return receipt;
    });
  }

  /** Owner-editable display name (CAS + receipt). Engines keep the name fixed at confirmation; nothing is granted. */
  #setLabel(rawId: string, raw: unknown): ConnectionReceipt {
    const { store } = this.#bound();
    const id = parse(ConnectionAccountIdSchema, rawId);
    const input = parse(SetConnectionLabelSchema, raw);
    if (input.expectedHostID !== store.hostId) fail("conflict");
    if (id.startsWith("mcp_")) fail("forbidden");
    const hash = sha256({ id, ...input });
    const replay = this.#replay(input.clientRequestId, "label", id, hash);
    if (replay) return replay;
    return this.#write(db => {
      const row = db.prepare("SELECT * FROM accounts WHERE id=?").get(id) as Row | undefined ?? fail("not_found");
      const existing = db.prepare("SELECT body FROM receipts WHERE client_request_id=?").get(input.clientRequestId) as Row | undefined;
      if (existing) return JSON.parse(existing.body as string) as ConnectionReceipt;
      if (Number(row.revision) !== input.expectedRevision || row.status === "disconnected") fail("conflict");
      const now = store.now();
      db.prepare("UPDATE accounts SET label=?, revision=revision+1, updated_at=? WHERE id=?").run(input.label, now, id);
      const receipt: ConnectionReceipt = { version: CONNECTIONS_CONTRACT_VERSION, hostId: store.hostId, clientRequestId: input.clientRequestId, kind: "label", accountId: id,
        requestHash: hash, previousRevision: input.expectedRevision, revision: input.expectedRevision + 1, access: null, disconnect: null, label: input.label, createdAt: now };
      db.prepare("INSERT INTO receipts VALUES (?,?,?,?,?,?)").run(input.clientRequestId, "label", id, hash, JSON.stringify(receipt), now);
      return receipt;
    });
  }

  /**
   * Local revocation first (blocks and drains only this connection's work), then one provider delete. The receipt is
   * written only when the upstream result is known. Unknown: `outcome_unknown`, no receipt; reading the account settles it,
   * or the owner re-sends the SAME request, which the trusted service reconciles by reading before any other delete.
   */
  #disconnect(rawId: string, raw: unknown): Promise<ConnectionReceipt> {
    const { store, gateway } = this.#bound();
    const id = parse(ConnectionAccountIdSchema, rawId);
    const input = parse(DisconnectConnectionAccountSchema, raw);
    if (input.expectedHostID !== store.hostId) fail("conflict");
    if (id.startsWith("mcp_")) fail("forbidden");
    const hash = sha256({ id, ...input });
    const replay = this.#replay(input.clientRequestId, "disconnect", id, hash);
    if (replay) return Promise.resolve(replay);
    const row = this.#accountRow(id) ?? fail("not_found");
    const pending = row.pending_request === null ? null : JSON.parse(row.pending_request as string) as { clientRequestId: string; requestHash: string };
    const resuming = row.status === "disconnecting" && pending?.clientRequestId === input.clientRequestId;
    if (resuming && pending!.requestHash !== hash) fail("conflict");
    if (!resuming) {
      const allowed = ["connected", "needs_reconnect", "identity_mismatch", "unknown"];
      if (Number(row.revision) !== input.expectedRevision || !allowed.includes(row.status as string)) fail("conflict");
      this.#write(db => {
        const latest = db.prepare("SELECT revision, status FROM accounts WHERE id=?").get(id) as Row;
        if (Number(latest.revision) !== input.expectedRevision || !allowed.includes(latest.status as string)) fail("conflict");
        db.prepare("UPDATE accounts SET status='disconnecting', disconnect=NULL, pending_request=?, revision=revision+1, updated_at=? WHERE id=?")
          .run(JSON.stringify({ clientRequestId: input.clientRequestId, requestHash: hash, expectedRevision: input.expectedRevision }), store.now(), id);
      });
    }
    gateway.revokeConnection(row.gateway_connection_id as string);
    return this.#track(async () => {
      let disconnect: { upstream: "deleted" | "already_absent"; revocation: "requested" | "not_requested" };
      try {
        const result = await this.#platform.disconnect(row.provider_account_ref as string, input.clientRequestId, this.#abort.signal);
        if (result.accountRef !== row.provider_account_ref || result.requestId !== input.clientRequestId) throw new ConnectionsPlatformError("unknown", "unknown");
        disconnect = { upstream: result.upstream, revocation: result.revocation };
      } catch (error) {
        const e = error instanceof ConnectionsPlatformError ? error : new ConnectionsPlatformError("unknown", "unknown");
        if (e.code === "not_found") disconnect = { upstream: "already_absent", revocation: "not_requested" };
        else {
          if (e.outcome === "unknown") this.#write(db => db.prepare("UPDATE accounts SET disconnect=?, updated_at=? WHERE id=? AND status='disconnecting'")
            .run(JSON.stringify({ upstream: "unknown", revocation: "unknown" }), store.now(), id));
          // Not applied or unknown: the account stays `disconnecting` (already unusable here); no receipt yet.
          return fail(e.outcome === "unknown" ? "outcome_unknown" : "unavailable");
        }
      }
      return this.#write(db => this.#settleDisconnect(db, id, disconnect) ?? fail("conflict"));
    });
  }
  /** Inside a connections write: disconnected + original receipt of the pending request (idempotent). */
  #settleDisconnect(db: DatabaseSync, id: string, disconnect: { upstream: string; revocation: string }): ConnectionReceipt | null {
    const { store } = this.#bound();
    const current = db.prepare("SELECT * FROM accounts WHERE id=?").get(id) as Row;
    const pending = current.pending_request === null ? null : JSON.parse(current.pending_request as string) as { clientRequestId: string; requestHash: string; expectedRevision: number };
    if (!pending) return null;
    const existing = db.prepare("SELECT body FROM receipts WHERE client_request_id=?").get(pending.clientRequestId) as Row | undefined;
    if (existing) return JSON.parse(existing.body as string) as ConnectionReceipt;
    const now = store.now();
    db.prepare("UPDATE accounts SET status='disconnected', disconnect=?, pending_request=NULL, status_checked_at=?, updated_at=? WHERE id=?").run(JSON.stringify(disconnect), now, now, id);
    const receipt: ConnectionReceipt = { version: CONNECTIONS_CONTRACT_VERSION, hostId: store.hostId, clientRequestId: pending.clientRequestId, kind: "disconnect", accountId: id,
      requestHash: pending.requestHash, previousRevision: pending.expectedRevision, revision: Number(current.revision),
      access: null, disconnect: disconnect as ConnectionReceipt["disconnect"], label: null, createdAt: now };
    db.prepare("INSERT INTO receipts VALUES (?,?,?,?,?,?)").run(pending.clientRequestId, "disconnect", id, pending.requestHash, JSON.stringify(receipt), now);
    return receipt;
  }

  // ---- gateway execution ----------------------------------------------------------------------

  #execute(call: AdapterCall, auth: InjectedAuth, context: { signal: AbortSignal }): Promise<JsonValue> {
    if (this.#closing || this.#closed) return Promise.reject(new ToolExecutionFailure("connection_changed","before_dispatch"));
    try {
      const { store, gateway, db } = this.#bound();
      if (call.host !== this.#platform.host) throw new ConnectorError("origin_refused");
      const row = db.prepare("SELECT * FROM accounts WHERE gateway_connection_id=?").get(call.connectionId) as Row | undefined;
      if (!row || row.status !== "connected") throw new ConnectorError("config_missing");
      if (call.scope.installationId !== store.hostId || call.scope.ownerId !== store.ownerId || call.scope.profileId !== row.profile_id
        || store.getBot(call.scope.botId).profileId !== row.profile_id || call.upstreamAccountRef !== row.provider_account_ref || call.toolkit !== row.toolkit)
        throw new ConnectorError("scope_mismatch");
      const tool = (JSON.parse(row.tools as string) as PinnedTool[]).find(t => t.slug === call.upstreamSlug && t.version === call.version);
      const registered = tool ? gateway.registry.getTool(tool.name) : null;
      if (!tool || isMetaSlug(call.upstreamSlug) || registered?.status !== "active" || registered.manifestHash !== tool.hash) throw new ConnectorError("tool_not_allowed");
      const requestId = `x${createHash("sha256").update(`${call.scope.botId}\u0000${call.connectionId}\u0000${call.idempotencyKey}`).digest("hex")}`;
      const signal = AbortSignal.any([context.signal, this.#abort.signal]);
      return this.#track(async () => {
        try {
          return await this.#platform.execute({ requestId, profileId: row.profile_id as string, accountRef: row.provider_account_ref as string, serviceId: row.service_id as string,
            toolkit: row.toolkit as string, slug: tool.slug, version: tool.version, arguments: call.arguments as Record<string, JsonValue> }, auth.headers, signal);
        } catch (error) {
          if (error instanceof ConnectionsPlatformError && error.outcome === "not_applied") throw new ToolExecutionFailure("connection_changed","before_dispatch");
          throw new ToolExecutionFailure("transport_unavailable","after_dispatch");
        }
      });
    } catch (error) {
      return Promise.reject(new ToolExecutionFailure("connection_changed","before_dispatch"));
    }
  }

  close(): Promise<void> { return this.#closeFlight ??= this.#finishClose(); }
  async #finishClose(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    this.#abort.abort();
    await Promise.allSettled([...this.#work]);
    this.#links.clear();
    if (this.#db && this.#store) {
      const db = this.#db, store = this.#store;
      store.withWriterLease(() => {
        db.exec("BEGIN IMMEDIATE");
        db.prepare("UPDATE attempts SET state='unknown', reason='outcome_unknown' WHERE state='starting'").run();
        db.exec("COMMIT");
        db.close();
      });
    }
    this.#closed = true;
  }
}

/** Read-only projection of native MCP OAuth instances (direct route). Operations stay on `/v1/mcp/*`. */
export function directConnectionViews(hostId: string, direct: DirectConnectionsSource | null, now: number): ConnectionAccount[] {
  if (!direct) return [];
  return direct.list().slice(0, 64).flatMap(server => {
    if (!/^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(server.serverId)) return [];
    const name = server.name.slice(0, 80) || server.serverId;
    // Direct OAuth exposes no account identity endpoint usable with an MCP-bound token: honest `unconfirmed` + ids/issuer.
    return [{
      version: CONNECTIONS_CONTRACT_VERSION, hostId, id: `mcp_${server.serverId}`, serviceId: "mcp", displayName: name, route: { kind: "direct_mcp" as const },
      label: name, identity: { confirmation: "unconfirmed" as const, value: null, kind: null, source: null, issuer: server.issuer, checkedAt: null },
      status: server.state, statusCheckedAt: now,
      persistence: server.persisted ? "app_keychain" as const : "volatile_until_host_restart" as const, manage: "native_mcp" as const,
      nativeServerId: server.serverId, revision: 0, profileId: null, tools: [], bots: [], previousAccountId: null,
      gatewayConnectionIds: server.gatewayConnectionIds.slice(0, 32), identityChanged: null, disconnect: null,
      createdAt: 0, updatedAt: now,
    }];
  });
}

/** Honest admin for a host without a configured connections service: direct projections only, no managed operations. */
export function unconfiguredConnectionsAdmin(host: { hostId: string; now(): number }, direct: DirectConnectionsSource | null): Readonly<ConnectionsAdmin> {
  const unavailable = (): never => { throw new ConnectionsError("unavailable"); };
  return Object.freeze({
    status: (): ConnectionsStatus => ({ version: CONNECTIONS_CONTRACT_VERSION, hostId: host.hostId, platform: "unconfigured", managedProviders: [],
      direct: direct ? "native_mcp" : "unconfigured", nativeOAuthPersistence: direct ? direct.persistence() : "unconfigured", openAuthorizations: 0 }),
    catalog: async (): Promise<ConnectionCatalog> => ({ version: CONNECTIONS_CONTRACT_VERSION, hostId: host.hostId, platform: "unconfigured", revision: 0, pin: null,
      fetchedAt: null, freshness: "never", services: [] }),
    startAuthorization: async () => unavailable(),
    authorization: async () => unavailable(),
    callback: async () => unavailable(),
    accounts: (): ConnectionAccounts => ({ version: CONNECTIONS_CONTRACT_VERSION, hostId: host.hostId, items: directConnectionViews(host.hostId, direct, host.now()) }),
    account: async (id: string) => {
      if (!ConnectionAccountIdSchema.safeParse(id).success) throw new ConnectionsError("invalid_input");
      return directConnectionViews(host.hostId, direct, host.now()).find(v => v.id === id) ?? unavailable();
    },
    setAccess: () => unavailable(),
    setLabel: () => unavailable(),
    disconnect: async () => unavailable(),
    receipt: () => null,
  });
}
