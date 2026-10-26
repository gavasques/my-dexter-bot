import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { GatewayError } from "./errors.js";
import { checkManifest, manifestHash, type ToolManifest } from "./manifest.js";

export const GATEWAY_DATABASE_FILE = "gateway.sqlite";
const SCHEMA_VERSION = 1;

/**
 * A connected upstream account of one installation/owner/profile. Holds references only: the upstream
 * account id and the broker key of its credential, never credential values. Connecting does not grant
 * any bot anything; access is a hub grant keyed by (bot, tool, connection id).
 */
export interface Connection {
  id: string;
  installationId: string;
  ownerId: string;
  profileId: string;
  toolkit: string;
  label: string;
  /** Upstream connected-account id (e.g. Composio connected_account_id). Not secret, never shown to engines. */
  upstreamAccountRef: string;
  /** Broker key of the credential; the value stays in the broker. */
  credentialRef: string;
  allowedHosts: string[];
  status: "active" | "revoked";
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export interface RegisteredTool {
  manifest: ToolManifest;
  manifestHash: string;
  status: "active" | "retired";
  revision: number;
  updatedAt: number;
}
export interface ConnectInput {
  profileId: string;
  toolkit: string;
  label: string;
  upstreamAccountRef: string;
  credentialRef: string;
  allowedHosts: string[];
}

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE connections (
  id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, owner_id TEXT NOT NULL, profile_id TEXT NOT NULL,
  toolkit TEXT NOT NULL, label TEXT NOT NULL, upstream_account_ref TEXT NOT NULL, credential_ref TEXT NOT NULL,
  allowed_hosts TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  revision INTEGER NOT NULL CHECK (revision > 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE tools (
  name TEXT PRIMARY KEY, toolkit TEXT NOT NULL, manifest TEXT NOT NULL, manifest_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')), revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at INTEGER NOT NULL
) STRICT;
`;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const LABEL = /^[^\u0000-\u001f]{1,120}$/;
const TOOLKIT = /^[a-z][a-z0-9_-]{0,63}$/;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

type Row = Record<string, unknown>;
/**
 * Canonical writer fence of the host (HostStore.withWriterLease): runs a synchronous callback under the hub's
 * BEGIN IMMEDIATE + lease-token check and throws host_locked when the lease is lost or the store is closed.
 * The callback must not call other HostStore writes.
 */
export type WriterLease = <T>(operation: () => T) => T;

/**
 * Durable catalog of pinned tools and connected accounts, stored beside the hub database and bound to its
 * installation and owner. It is not an authority over grants, approvals or action outcomes: those stay in
 * the hub's HostStore. Every change bumps a revision so actions pinned to an older revision never dispatch.
 *
 * Every write, including opening/initialising the file and checking its owner metadata, commits inside the
 * host's writer lease, so a host that lost its lease (or was closed) cannot change the catalog. This is a
 * fence, not a distributed transaction: dispatch still revalidates pins against the registry.
 */
export class GatewayRegistry {
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dataDir: string, readonly installationId: string, readonly ownerId: string,
    private readonly clock: () => number, private readonly lease: WriterLease) {
    if (typeof lease !== "function") throw new GatewayError("invalid_input", "registry requires the host writer lease");
    this.databasePath = join(dataDir, GATEWAY_DATABASE_FILE);
    this.db = lease(() => {
      const db = new DatabaseSync(this.databasePath, { timeout: 5_000 });
      try {
        chmodSync(this.databasePath, 0o600);
        db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      } catch (error) { db.close(); throw error; }
      return db;
    });
    try {
      this.tx(() => {
        const hasMeta = this.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
        if (!hasMeta) {
          this.db.exec(SCHEMA);
          const insert = this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
          insert.run("schema_version", String(SCHEMA_VERSION));
          insert.run("installation_id", installationId);
          insert.run("owner_id", ownerId);
          return;
        }
        const meta = (key: string): string | undefined => (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined)?.value as string | undefined;
        if (meta("schema_version") !== String(SCHEMA_VERSION)) throw new GatewayError("conflict", "unsupported gateway schema version");
        if (meta("installation_id") !== installationId || meta("owner_id") !== ownerId) {
          throw new GatewayError("conflict", "gateway registry belongs to another installation or owner");
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ---- tools ---------------------------------------------------------------------------------

  /** Registers or re-pins a manifest. A changed manifest bumps the revision; an identical one is a no-op. */
  registerTool(input: unknown): RegisteredTool {
    const manifest = checkManifest(input);
    const hash = manifestHash(manifest);
    return this.tx(() => {
      const previous = this.toolRow(manifest.name);
      if (previous && previous.manifest_hash === hash && previous.status === "active") return toTool(previous);
      if (previous && previous.toolkit !== manifest.toolkit) throw new GatewayError("conflict", "a tool name cannot move to another toolkit");
      const revision = previous ? Number(previous.revision) + 1 : 1;
      this.db.prepare(`INSERT INTO tools (name, toolkit, manifest, manifest_hash, status, revision, updated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?) ON CONFLICT (name) DO UPDATE SET manifest = excluded.manifest,
        manifest_hash = excluded.manifest_hash, status = 'active', revision = excluded.revision, updated_at = excluded.updated_at`)
        .run(manifest.name, manifest.toolkit, JSON.stringify(manifest), hash, revision, this.clock());
      return toTool(this.toolRow(manifest.name)!);
    });
  }
  retireTool(name: string): RegisteredTool {
    return this.tx(() => {
      const row = this.toolRow(name);
      if (!row) throw new GatewayError("not_found", "tool not found");
      if (row.status === "retired") return toTool(row);
      this.db.prepare("UPDATE tools SET status = 'retired', revision = revision + 1, updated_at = ? WHERE name = ?").run(this.clock(), name);
      return toTool(this.toolRow(name)!);
    });
  }
  getTool(name: string): RegisteredTool | null {
    const row = this.toolRow(name);
    return row ? toTool(row) : null;
  }
  listTools(): RegisteredTool[] {
    return this.all("SELECT * FROM tools ORDER BY name").map(toTool);
  }

  // ---- connections ---------------------------------------------------------------------------

  connect(input: ConnectInput): Connection {
    const check = (value: unknown, pattern: RegExp, field: string): string => {
      if (typeof value !== "string" || !pattern.test(value)) throw new GatewayError("invalid_input", `${field}: invalid`);
      return value;
    };
    const profileId = check(input.profileId, ID, "profileId");
    const toolkit = check(input.toolkit, TOOLKIT, "toolkit");
    const label = check(input.label, LABEL, "label");
    const upstreamAccountRef = check(input.upstreamAccountRef, ID, "upstreamAccountRef");
    const credentialRef = check(input.credentialRef, ID, "credentialRef");
    if (!Array.isArray(input.allowedHosts) || input.allowedHosts.length === 0 || input.allowedHosts.length > 16) {
      throw new GatewayError("invalid_input", "allowedHosts: invalid");
    }
    const allowedHosts = [...new Set(input.allowedHosts.map((h) => check(h, HOST, "allowedHosts")))].sort();
    return this.tx(() => {
      const now = this.clock();
      const id = `conn_${randomUUID()}`;
      this.db.prepare(`INSERT INTO connections (id, installation_id, owner_id, profile_id, toolkit, label, upstream_account_ref,
          credential_ref, allowed_hosts, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`)
        .run(id, this.installationId, this.ownerId, profileId, toolkit, label, upstreamAccountRef, credentialRef, JSON.stringify(allowedHosts), now, now);
      return toConnection(this.connectionRow(id)!);
    });
  }
  /** Irreversible. A reconnect creates a new connection id, so old grants and pinned actions never apply to it. */
  revokeConnection(id: string): Connection {
    return this.tx(() => {
      const row = this.connectionRow(id);
      if (!row) throw new GatewayError("not_found", "connection not found");
      if (row.status === "revoked") return toConnection(row);
      this.db.prepare("UPDATE connections SET status = 'revoked', revision = revision + 1, updated_at = ? WHERE id = ?").run(this.clock(), id);
      return toConnection(this.connectionRow(id)!);
    });
  }
  getConnection(id: string): Connection | null {
    const row = this.connectionRow(id);
    return row ? toConnection(row) : null;
  }
  listConnections(profileId?: string): Connection[] {
    const rows = profileId === undefined
      ? this.all("SELECT * FROM connections WHERE owner_id = ? ORDER BY created_at, id", this.ownerId)
      : this.all("SELECT * FROM connections WHERE owner_id = ? AND profile_id = ? ORDER BY created_at, id", this.ownerId, profileId);
    return rows.map(toConnection);
  }

  // ---- internals -----------------------------------------------------------------------------

  private toolRow(name: string): Row | undefined { return this.one("SELECT * FROM tools WHERE name = ?", name); }
  private connectionRow(id: string): Row | undefined {
    return this.one("SELECT * FROM connections WHERE id = ? AND installation_id = ? AND owner_id = ?", id, this.installationId, this.ownerId);
  }
  private one(sql: string, ...params: SQLInputValue[]): Row | undefined {
    if (this.closed) throw new GatewayError("unavailable", "gateway registry is closed");
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    if (this.closed) throw new GatewayError("unavailable", "gateway registry is closed");
    return this.db.prepare(sql).all(...params) as Row[];
  }
  /** Registry transaction committed inside the host writer lease; there is no unfenced write path. */
  private tx<T>(fn: () => T): T {
    if (this.closed) throw new GatewayError("unavailable", "gateway registry is closed");
    return this.lease(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const out = fn();
        this.db.exec("COMMIT");
        return out;
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }
}

function toTool(row: Row): RegisteredTool {
  return {
    manifest: JSON.parse(row.manifest as string) as ToolManifest, manifestHash: row.manifest_hash as string,
    status: row.status as RegisteredTool["status"], revision: Number(row.revision), updatedAt: Number(row.updated_at),
  };
}
function toConnection(row: Row): Connection {
  return {
    id: row.id as string, installationId: row.installation_id as string, ownerId: row.owner_id as string,
    profileId: row.profile_id as string, toolkit: row.toolkit as string, label: row.label as string,
    upstreamAccountRef: row.upstream_account_ref as string, credentialRef: row.credential_ref as string,
    allowedHosts: JSON.parse(row.allowed_hosts as string) as string[], status: row.status as Connection["status"],
    revision: Number(row.revision), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}
