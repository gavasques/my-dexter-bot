import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { JsonValue } from "@dexter/contracts";
import { canonicalJson } from "@dexter/hub";
import { DeviceError } from "./errors.js";
import { privateDatabasePath, privateDirectory, sealDatabase } from "./files.js";
import type { DeviceReceipt } from "./wire.js";

export const JOURNAL_DATABASE_FILE = "journal.sqlite";
const SCHEMA_VERSION = 1;
const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE lease (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, token TEXT NOT NULL) STRICT;
CREATE TABLE receipts (
  host_id TEXT NOT NULL, action_id TEXT NOT NULL, request_hash TEXT NOT NULL, nonce TEXT NOT NULL, tool TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'unknown')),
  result TEXT, result_sha256 TEXT, code TEXT, acked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (host_id, action_id)
) STRICT;
`;
type Row = Record<string, unknown>;

export interface JournalBinding { installationId: string; ownerId: string; deviceId: string }
export type BeginResult =
  | { kind: "new" }
  | { kind: "existing"; receipt: DeviceReceipt }
  | { kind: "conflict" };

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/**
 * The daemon's durable receipt journal, keyed by (host installation, action id). A `started` row is
 * committed (synchronous=FULL) before any effect; on reopen every `started` row becomes `unknown` and is
 * never executed again. It holds receipts only: no conversation, memory, engine state or credentials.
 * Result bodies are kept only until the host acknowledges them; afterwards only their SHA-256 remains.
 * One process per journal: a live holder of the lease makes a second daemon fail closed.
 */
export class DaemonJournal {
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private readonly token = randomBytes(16).toString("hex");
  private closed = false;

  constructor(dataDir: string, readonly binding: JournalBinding, private readonly clock: () => number = Date.now) {
    privateDirectory(dataDir, false);
    this.databasePath = join(dataDir, JOURNAL_DATABASE_FILE);
    privateDatabasePath(this.databasePath);
    this.db = new DatabaseSync(this.databasePath, { timeout: 5_000 });
    try {
      sealDatabase(this.databasePath);
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      this.immediate(() => {
        const hasMeta = this.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
        if (!hasMeta) {
          this.db.exec(SCHEMA);
          const insert = this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
          insert.run("schema_version", String(SCHEMA_VERSION));
          insert.run("installation_id", binding.installationId);
          insert.run("owner_id", binding.ownerId);
          insert.run("device_id", binding.deviceId);
        }
        const meta = (key: string): unknown => (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined)?.value;
        if (meta("schema_version") !== String(SCHEMA_VERSION)) throw new DeviceError("conflict", "unsupported journal schema");
        if (meta("installation_id") !== binding.installationId || meta("owner_id") !== binding.ownerId || meta("device_id") !== binding.deviceId) {
          throw new DeviceError("conflict", "journal belongs to another installation, owner or device");
        }
        const lease = this.db.prepare("SELECT pid FROM lease WHERE id = 1").get() as Row | undefined;
        if (lease && (Number(lease.pid) === process.pid || pidAlive(Number(lease.pid)))) throw new DeviceError("conflict", "journal is held by a running daemon");
        this.db.prepare("INSERT INTO lease (id, pid, token) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET pid = excluded.pid, token = excluded.token")
          .run(process.pid, this.token);
        // A start without a recorded end may or may not have had its effect: unknown, never re-run.
        this.db.prepare("UPDATE receipts SET status = 'unknown', code = 'daemon_interrupted', acked = 0, updated_at = ? WHERE status = 'started'")
          .run(this.clock());
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.immediate(() => { this.db.prepare("DELETE FROM lease WHERE id = 1 AND token = ?").run(this.token); }); } finally { this.db.close(); }
  }

  /** Durably records the start before the effect, or returns what is already known about this action. */
  begin(input: { hostId: string; actionId: string; requestHash: string; nonce: string; tool: string }): BeginResult {
    return this.write(() => {
      const row = this.one("SELECT * FROM receipts WHERE host_id = ? AND action_id = ?", input.hostId, input.actionId);
      if (row) {
        if (row.request_hash !== input.requestHash) return { kind: "conflict" as const };
        if (row.status === "started") {
          // Only reachable if the in-memory in-flight guard was bypassed: never run twice.
          this.db.prepare("UPDATE receipts SET status = 'unknown', code = 'daemon_interrupted', acked = 0, updated_at = ? WHERE host_id = ? AND action_id = ?")
            .run(this.clock(), input.hostId, input.actionId);
          return { kind: "existing" as const, receipt: toReceipt(this.one("SELECT * FROM receipts WHERE host_id = ? AND action_id = ?", input.hostId, input.actionId)!) };
        }
        return { kind: "existing" as const, receipt: toReceipt(row) };
      }
      const now = this.clock();
      this.db.prepare(`INSERT INTO receipts (host_id, action_id, request_hash, nonce, tool, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'started', ?, ?)`).run(input.hostId, input.actionId, input.requestHash, input.nonce, input.tool, now, now);
      return { kind: "new" as const };
    });
  }
  finish(hostId: string, actionId: string, outcome: { status: "completed"; result: JsonValue } | { status: "failed" | "unknown"; code: string }): DeviceReceipt {
    return this.write(() => {
      const row = this.one("SELECT * FROM receipts WHERE host_id = ? AND action_id = ?", hostId, actionId);
      if (!row || row.status !== "started") throw new DeviceError("conflict", "journal entry is not started");
      const now = this.clock();
      if (outcome.status === "completed") {
        const encoded = canonicalJson(outcome.result);
        this.db.prepare("UPDATE receipts SET status = 'completed', result = ?, result_sha256 = ?, updated_at = ? WHERE host_id = ? AND action_id = ?")
          .run(encoded, createHash("sha256").update(encoded).digest("hex"), now, hostId, actionId);
      } else {
        this.db.prepare("UPDATE receipts SET status = ?, code = ?, updated_at = ? WHERE host_id = ? AND action_id = ?")
          .run(outcome.status, outcome.code, now, hostId, actionId);
      }
      return toReceipt(this.one("SELECT * FROM receipts WHERE host_id = ? AND action_id = ?", hostId, actionId)!);
    });
  }
  /** Terminal receipts the host has not acknowledged yet, oldest first. */
  unacked(limit: number): DeviceReceipt[] {
    return this.all("SELECT * FROM receipts WHERE acked = 0 AND status != 'started' AND host_id = ? ORDER BY updated_at, action_id LIMIT ?",
      this.binding.installationId, limit).map(toReceipt);
  }
  /** After the host accepted a receipt: drop the result body, keep status and hash. */
  ack(actionIds: readonly string[]): void {
    if (actionIds.length === 0) return;
    this.write(() => {
      const stmt = this.db.prepare("UPDATE receipts SET acked = 1, result = NULL, updated_at = ? WHERE host_id = ? AND action_id = ? AND status != 'started'");
      for (const id of actionIds) stmt.run(this.clock(), this.binding.installationId, id);
    });
  }
  /** Status only, for tests and diagnostics. */
  entry(actionId: string): { status: string; acked: boolean; code: string | null } | null {
    const row = this.one("SELECT status, acked, code FROM receipts WHERE host_id = ? AND action_id = ?", this.binding.installationId, actionId);
    return row ? { status: row.status as string, acked: Number(row.acked) === 1, code: (row.code as string | null) ?? null } : null;
  }

  private immediate<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private write<T>(fn: () => T): T {
    if (this.closed) throw new DeviceError("unavailable", "journal closed");
    return this.immediate(() => {
      const lease = this.db.prepare("SELECT token FROM lease WHERE id = 1").get() as Row | undefined;
      if (!lease || lease.token !== this.token) throw new DeviceError("conflict", "journal lease lost");
      return fn();
    });
  }
  private one(sql: string, ...params: SQLInputValue[]): Row | undefined {
    if (this.closed) throw new DeviceError("unavailable", "journal closed");
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    if (this.closed) throw new DeviceError("unavailable", "journal closed");
    return this.db.prepare(sql).all(...params) as Row[];
  }
}

function toReceipt(row: Row): DeviceReceipt {
  const status = row.status as string;
  if (status === "completed") {
    const result: JsonValue = row.result === null
      ? { replayed: true, resultSha256: row.result_sha256 as string }
      : (JSON.parse(row.result as string) as JsonValue);
    return { actionId: row.action_id as string, nonce: row.nonce as string, requestHash: row.request_hash as string, status: "completed", result, code: null };
  }
  return {
    actionId: row.action_id as string, nonce: row.nonce as string, requestHash: row.request_hash as string,
    status: status === "failed" ? "failed" : "unknown", result: null, code: (row.code as string | null) ?? "daemon_interrupted",
  };
}
