import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, realpathSync, type Stats } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CONNECTIONS_CONFIGURATION_VERSION, CONNECTIONS_PLATFORM_CREDENTIAL_REF, CONNECTIONS_RUNTIME_REASONS,
  ConnectionsConfigurationReceiptSchema, ConnectionsConfigurationSchema, ConnectionsConfigurationStatusSchema, SetConnectionsConfigurationSchema,
  type ConnectionsConfiguration, type ConnectionsConfigurationReceipt, type ConnectionsConfigurationStatus, type SetConnectionsConfiguration,
} from "@dexter/contracts";
import { CONNECTIONS_DATABASE_FILE, connectionsConfigurationDigest } from "@dexter/connectors";
import { HostError } from "@dexter/hub";

/**
 * Owner-private configuration of the trusted connections service: `<dataDir>/connections-configuration.sqlite`, local
 * schema "1", bound to the installation/owner, created on the first owner save (no Hub migration; excluded from
 * authority checkpoints, re-entered by the owner on a destination).
 *
 * METADATA only (origin, enable intent, credential generation, receipts). The installation capability never reaches
 * this file, a receipt, a log or HTTP: it stays in the app's Keychain custody and crosses only the app-owned private
 * pipe into an in-memory vault (`connections-private-custody.ts`). Every mutation runs in the canonical writer fence:
 * CAS by revision, one receipt per client request id (same body → same receipt; other body → conflict). An uncertain
 * outcome is settled by reading the original receipt, never by a second write.
 */
export const CONNECTIONS_CONFIGURATION_DATABASE_FILE = "connections-configuration.sqlite";
export const CONNECTIONS_CONFIGURATION_SCHEMA_VERSION = "1";
const NAMESPACE = "connections-platform-configuration-v1";
const MAX_RECEIPTS = 1_000;
const TABLES: ReadonlyArray<readonly [string, string]> = [
  ["meta", "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT"],
  ["receipts", `CREATE TABLE receipts (client_request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  revision INTEGER NOT NULL CHECK (revision >= 1), receipt TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT`],
  ["state", `CREATE TABLE state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL CHECK (revision >= 1),
  generation INTEGER NOT NULL CHECK (generation >= 0), origin TEXT, enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL, CHECK (enabled = 0 OR origin IS NOT NULL)) STRICT`],
];
const normalize = (sql: string): string => sql.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
type Row = Record<string, unknown>;
const unavailable = (): never => { throw new HostError("device_unavailable", "Connections configuration is not available."); };
const optionalLstat = (path: string): Stats | null => {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null; throw error; }
};
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`).join(",")}}`;
}
/** SHA-256 of the canonical (sorted-key) JSON of the exact request; the Swift SDK hashes the same bytes. */
export const connectionsConfigurationRequestHash = (input: SetConnectionsConfiguration): string =>
  createHash("sha256").update(canonical(input)).digest("hex");

export const DEFAULT_CONNECTIONS_CONFIGURATION: ConnectionsConfiguration = Object.freeze({
  revision: 0, generation: 0, origin: null, enabled: false, credentialRef: CONNECTIONS_PLATFORM_CREDENTIAL_REF, updatedAt: null,
});

function verify(db: DatabaseSync, identity: { hostId: string; ownerId: string }): void {
  const objects = db.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[];
  if (objects.length !== TABLES.length || TABLES.some(([name, sql], i) => objects[i]!.name !== name || typeof objects[i]!.sql !== "string"
    || normalize(objects[i]!.sql as string) !== normalize(sql))) throw new HostError("conflict", "Connections configuration schema is not supported.");
  const meta = Object.fromEntries((db.prepare("SELECT key, value FROM meta").all() as Row[]).map(row => [String(row.key), String(row.value)]));
  if (Object.keys(meta).sort().join(",") !== "installation_id,instance_id,namespace,owner_id,schema_version" || meta.namespace !== NAMESPACE
    || meta.schema_version !== CONNECTIONS_CONFIGURATION_SCHEMA_VERSION || !/^[0-9a-f-]{36}$/.test(meta.instance_id ?? ""))
    throw new HostError("conflict", "Connections configuration schema is not supported.");
  if (meta.installation_id !== identity.hostId || meta.owner_id !== identity.ownerId) throw new HostError("conflict", "Connections configuration belongs to another installation.");
  const rows = db.prepare("SELECT * FROM state").all() as Row[];
  if (rows.length > 1) throw new HostError("conflict", "Connections configuration is inconsistent.");
}
function readState(db: DatabaseSync): ConnectionsConfiguration {
  const row = db.prepare("SELECT revision, generation, origin, enabled, updated_at FROM state WHERE id = 1").get() as Row | undefined;
  if (!row) return DEFAULT_CONNECTIONS_CONFIGURATION;
  const value = { revision: Number(row.revision), generation: Number(row.generation), origin: row.origin === null ? null : String(row.origin),
    enabled: Number(row.enabled) === 1, credentialRef: CONNECTIONS_PLATFORM_CREDENTIAL_REF, updatedAt: Number(row.updated_at) };
  const parsed = ConnectionsConfigurationSchema.safeParse(value);
  if (!parsed.success) throw new HostError("conflict", "Connections configuration is inconsistent.");
  return Object.freeze(parsed.data);
}
/** Existing, safe file only (regular, single link, owner-only mode); null when absent. */
function existingPath(dataDir: string): string | null {
  const data = realpathSync(dataDir), stat = lstatSync(data);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return unavailable();
  const path = join(data, CONNECTIONS_CONFIGURATION_DATABASE_FILE), file = optionalLstat(path);
  if (!file) return null;
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o077) !== 0) throw new HostError("conflict", "Connections configuration is unsafe.");
  return path;
}

/**
 * Read-only startup snapshot (before any writer exists): null when no owner configuration exists. A foreign, unsafe or
 * unsupported file throws (`conflict`); the caller then composes nothing and reports `configuration_unavailable`.
 */
export function readConnectionsConfigurationForStartup(dataDir: string, identity: { hostId: string; ownerId: string }): ConnectionsConfiguration | null {
  const path = existingPath(dataDir);
  if (!path) return null;
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
  try { verify(db, identity); const value = readState(db); return value.revision === 0 ? null : value; } finally { db.close(); }
}
/**
 * Digest the existing `connections.sqlite` was bound to, or null when no runtime ever bound one. Read-only; the runtime
 * refuses to open another configuration, so the owner path checks it before composing or saving another origin.
 */
export function boundConnectionsDigest(dataDir: string): string | null {
  const path = join(realpathSync(dataDir), CONNECTIONS_DATABASE_FILE);
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'configuration'").get() as Row | undefined;
    if (!row || typeof row.value !== "string") throw new HostError("conflict", "Connections state is unreadable.");
    return row.value;
  } finally { db.close(); }
}
export const originBoundElsewhere = (dataDir: string, origin: string): boolean => {
  const bound = boundConnectionsDigest(dataDir);
  return bound !== null && bound !== connectionsConfigurationDigest(origin, CONNECTIONS_PLATFORM_CREDENTIAL_REF);
};

export interface ConnectionsConfigurationLedgerOptions {
  dataDir: string;
  identity: () => { hostId: string; ownerId: string };
  now: () => number;
  /** Canonical writer fence (HostStore.withWriterLease) around every mutation. */
  writer: <T>(operation: () => T) => T;
}
export interface ConnectionsConfigurationCommitContext {
  /** Refuses (throws) when the composed runtime belongs to the embedding or the origin is bound to other connections. */
  admit(next: ConnectionsConfiguration): void;
  /** Whether the running host would keep using another configuration until it restarts. */
  restartRequired(next: ConnectionsConfiguration): boolean;
}

export class ConnectionsConfigurationLedger {
  readonly #options: ConnectionsConfigurationLedgerOptions;
  #db: DatabaseSync | null = null;
  #closed = false;
  /** Pure construction: no file is opened or created here. */
  constructor(options: ConnectionsConfigurationLedgerOptions) { this.#options = options; }
  get dataDir(): string { return this.#options.dataDir; }
  close(): void { this.#closed = true; if (this.#db) { const db = this.#db; this.#db = null; db.close(); } }

  #open(): DatabaseSync | null {
    if (this.#closed) return unavailable();
    if (this.#db) return this.#db;
    const path = existingPath(this.#options.dataDir);
    if (!path) return null;
    const probe = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
    try { verify(probe, this.#options.identity()); } finally { probe.close(); }
    const db = new DatabaseSync(path, { timeout: 5_000 });
    try { db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;"); verify(db, this.#options.identity()); }
    catch (error) { db.close(); throw error; }
    return this.#db = db;
  }
  /** Creates the file inside the caller's writer fence (owner-only mode before any row). */
  #ensure(): DatabaseSync {
    const existing = this.#open();
    if (existing) return existing;
    const path = join(realpathSync(this.#options.dataDir), CONNECTIONS_CONFIGURATION_DATABASE_FILE), { hostId, ownerId } = this.#options.identity();
    const db = new DatabaseSync(path, { timeout: 5_000 });
    try {
      chmodSync(path, 0o600);
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
      for (const [, sql] of TABLES) db.exec(sql);
      const put = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      for (const [key, value] of [["installation_id", hostId], ["owner_id", ownerId], ["namespace", NAMESPACE],
        ["schema_version", CONNECTIONS_CONFIGURATION_SCHEMA_VERSION], ["instance_id", randomUUID()]] as const) put.run(key, value);
      db.exec("COMMIT");
      verify(db, { hostId, ownerId });
    } catch (error) { try { db.exec("ROLLBACK"); } catch { /* none */ } db.close(); throw error; }
    return this.#db = db;
  }

  /** Current persisted configuration (never creates the file). */
  read(): ConnectionsConfiguration { const db = this.#open(); return db ? readState(db) : DEFAULT_CONNECTIONS_CONFIGURATION; }

  /** Original receipt of a client request id, or null (unconfirmed, never "did not happen"). */
  receipt(clientRequestId: string): ConnectionsConfigurationReceipt | null {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(clientRequestId)) throw new HostError("invalid_input", "Invalid client request id.");
    const db = this.#open();
    const row = db?.prepare("SELECT receipt FROM receipts WHERE client_request_id = ?").get(clientRequestId) as Row | undefined;
    return row ? ConnectionsConfigurationReceiptSchema.parse(JSON.parse(String(row.receipt))) : null;
  }

  /** CAS + receipt mutation in the canonical writer fence. Returns the original receipt for an exact replay. */
  commit(raw: unknown, context: ConnectionsConfigurationCommitContext): { receipt: ConnectionsConfigurationReceipt; replayed: boolean } {
    const parsed = SetConnectionsConfigurationSchema.safeParse(raw);
    if (!parsed.success) throw new HostError("invalid_input", "Connections configuration request refused.");
    const input = parsed.data, { hostId, ownerId } = this.#options.identity();
    if (input.expectedHostId !== hostId) throw new HostError("conflict", "This request names another host.");
    if (input.renewCredential && input.origin === null) throw new HostError("invalid_input", "A credential generation needs an origin.");
    const requestHash = connectionsConfigurationRequestHash(input);
    return this.#options.writer(() => {
      const db = this.#ensure();
      db.exec("BEGIN IMMEDIATE");
      try {
        const prior = db.prepare("SELECT request_hash, receipt FROM receipts WHERE client_request_id = ?").get(input.clientRequestId) as Row | undefined;
        if (prior) {
          if (prior.request_hash !== requestHash) throw new HostError("conflict", "This request id was used with another configuration.");
          db.exec("COMMIT");
          return { receipt: ConnectionsConfigurationReceiptSchema.parse(JSON.parse(String(prior.receipt))), replayed: true };
        }
        const current = readState(db);
        if (input.expectedRevision !== current.revision) throw new HostError("conflict", "Connections configuration changed. Refresh before saving.");
        const originChanged = input.origin !== current.origin;
        if (!originChanged && input.enabled === current.enabled && !input.renewCredential) throw new HostError("conflict", "Connections configuration is already current.");
        const committedAt = this.#options.now();
        const next: ConnectionsConfiguration = Object.freeze({
          revision: current.revision + 1,
          generation: input.origin !== null && (originChanged || input.renewCredential) ? current.generation + 1 : current.generation,
          origin: input.origin, enabled: input.enabled, credentialRef: CONNECTIONS_PLATFORM_CREDENTIAL_REF, updatedAt: committedAt,
        });
        context.admit(next);
        const receipt = ConnectionsConfigurationReceiptSchema.parse({ hostId, ownerId, clientRequestId: input.clientRequestId, requestHash,
          previousRevision: current.revision, previousGeneration: current.generation, configuration: next,
          restartRequired: context.restartRequired(next), committedAt });
        db.prepare(`INSERT INTO state (id, revision, generation, origin, enabled, updated_at) VALUES (1, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, generation = excluded.generation, origin = excluded.origin,
          enabled = excluded.enabled, updated_at = excluded.updated_at`).run(next.revision, next.generation, next.origin, next.enabled ? 1 : 0, committedAt);
        db.prepare("INSERT INTO receipts (client_request_id, request_hash, revision, receipt, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(input.clientRequestId, requestHash, next.revision, JSON.stringify(receipt), committedAt);
        db.prepare(`DELETE FROM receipts WHERE client_request_id IN (SELECT client_request_id FROM receipts ORDER BY revision DESC LIMIT -1 OFFSET ${MAX_RECEIPTS})`).run();
        db.exec("COMMIT");
        return { receipt, replayed: false };
      } catch (error) { try { db.exec("ROLLBACK"); } catch { /* committed or none */ } throw error; }
    });
  }
}

/** Environment captured at startup: what this process can compose without a restart into another launch. */
export interface ConnectionsPrivateEnvironment { channel: boolean; mcpEngines: boolean; exclusiveUpstream: boolean }
/** What the running host composed: from this owner configuration (origin + generation), from an embedding, or nothing. */
export type ConnectionsComposition = { source: "owner_private"; origin: string; generation: number } | { source: "external"; origin: string } | null;
export interface ConnectionsCustodyView {
  status(): { state: "absent" | "ready" | "locked"; generation: number | null };
  lastRequest(): ConnectionsConfigurationStatus["privateRequest"];
}

/**
 * Honest `/v1/connections/status` for a service composed from the owner-private configuration: never `available` while
 * the private capability is not held (decided from the custody state; the capability itself is never read here).
 */
export function withPrivateCustodyStatus<P extends { status(): unknown }>(port: P, deps: { composition: () => ConnectionsComposition; custody: ConnectionsCustodyView | null }): P {
  return Object.freeze({ ...port, status: () => {
    const value = port.status() as Record<string, unknown>;
    if (deps.composition()?.source === "owner_private" && deps.custody?.status().state !== "ready" && value && value.platform === "available")
      return { ...value, platform: "unavailable" };
    return value;
  } });
}
/** Pure projection of the running state; never claims connectivity. */
export function connectionsRuntimeState(configuration: ConnectionsConfiguration, composition: ConnectionsComposition,
  environment: ConnectionsPrivateEnvironment, boundElsewhere: (origin: string) => boolean): ConnectionsConfigurationStatus["runtime"] {
  if (composition?.source === "external") return { state: "configured_externally", reason: null, origin: composition.origin, generation: null };
  if (composition?.source === "owner_private") {
    const same = configuration.enabled && configuration.origin === composition.origin && configuration.generation === composition.generation;
    return { state: same ? "active" : "restart_required", reason: null, origin: composition.origin, generation: composition.generation };
  }
  const inactive = (reason: (typeof CONNECTIONS_RUNTIME_REASONS)[number]) => ({ state: "inactive" as const, reason, origin: null, generation: null });
  if (!configuration.enabled || configuration.origin === null) return inactive("disabled");
  if (!environment.channel) return inactive("private_channel_unavailable");
  if (!environment.mcpEngines) return inactive("requires_mcp_engines");
  if (environment.exclusiveUpstream) return inactive("exclusive_upstream");
  if (boundElsewhere(configuration.origin)) return inactive("origin_bound_to_other_connections");
  return { state: "restart_required", reason: null, origin: null, generation: null };
}

/**
 * Owner-loopback HTTP port of this configuration. Composed by the trusted launcher (CLI or operator embedding) with
 * what only it knows: the startup environment, the composition and the private custody (null without the app pipe).
 * Never returns, accepts or logs the capability.
 */
export function connectionsConfigurationHttpPort(deps: {
  ledger: () => ConnectionsConfigurationLedger;
  identity: () => { hostId: string; ownerId: string };
  environment: ConnectionsPrivateEnvironment;
  composition: () => ConnectionsComposition;
  custody: ConnectionsCustodyView | null;
}) {
  const boundElsewhere = (origin: string): boolean => { try { return originBoundElsewhere(deps.ledger().dataDir, origin); } catch { return true; } };
  const status = (): ConnectionsConfigurationStatus => {
    const { hostId, ownerId } = deps.identity(), configuration = deps.ledger().read();
    const custody = deps.custody ? { channel: "app_private_channel" as const, ...deps.custody.status() } : { channel: "unavailable" as const, state: "absent" as const, generation: null };
    return ConnectionsConfigurationStatusSchema.parse({ version: CONNECTIONS_CONFIGURATION_VERSION, hostId, ownerId, configuration,
      runtime: connectionsRuntimeState(configuration, deps.composition(), deps.environment, boundElsewhere), custody,
      privateRequest: deps.custody?.lastRequest() ?? null });
  };
  return Object.freeze({
    status,
    configure(input: unknown): { receipt: ConnectionsConfigurationReceipt; status: ConnectionsConfigurationStatus } {
      const { receipt } = deps.ledger().commit(input, {
        admit: next => {
          if (deps.composition()?.source === "external") throw new HostError("conflict", "Connections are configured by this host's operator.");
          if (next.origin !== null && boundElsewhere(next.origin)) throw new HostError("conflict", "Connections on this host are bound to another service origin.");
        },
        restartRequired: next => connectionsRuntimeState(next, deps.composition(), deps.environment, () => false).state === "restart_required",
      });
      return { receipt, status: status() };
    },
    receipt(clientRequestId: string): ConnectionsConfigurationReceipt | null { return deps.ledger().receipt(clientRequestId); },
  });
}
