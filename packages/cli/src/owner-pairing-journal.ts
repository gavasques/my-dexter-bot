import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, realpathSync, type Stats } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { HostError } from "@dexter/hub";

/**
 * Dedicated owner pairing journal of this base: `<dataDir>/owner-pairing-offers.sqlite` (excluded from authority
 * checkpoints; no Hub migration). Closed schema bound to the installation/owner, created on the first owner decision.
 *
 * - Schema "1" (offers only) is read as-is and migrated to "2" inside the writer fence before the next write: the
 *   `requests` table gains the `approve`/`reject` operations and a `claim_id`, and `claim_state` holds the claims revision.
 *   Older code refuses schema "2" (no downgrade).
 * - Every owner mutation is reserved here (request + revision bump, optional provisional receipt) BEFORE its registry
 *   effect and finalized with its receipt afterwards. A reserved row that never finalized reads as unknown.
 * - Opened read-only first: a foreign, unsafe or unsupported journal is refused without any write.
 * - Continuity pin: the journal is excluded from checkpoints and could be lost, so it is never the only continuity of
 *   dedupe. `pin()` binds the installation/owner, the canonical authority epoch (HostStore; a checkpoint activation moves
 *   it) and a random instance id written when this journal file was created/migrated. Mutations must name the pin they
 *   were shown: after a restore/activation or a lost journal, a request formed before is refused instead of re-executed.
 */
export const OWNER_PAIRING_OFFERS_DATABASE_FILE = "owner-pairing-offers.sqlite";
export const OWNER_PAIRING_JOURNAL_SCHEMA_VERSION = "2";
export type OwnerPairingOperation = "create" | "cancel" | "approve" | "reject";
export type OwnerPairingDomain = "offers" | "claims";
const NAMESPACE = "owner-pairing-offer-v1";
const MAX_REQUESTS = 2_000;
const RETAIN_RECEIPTS_MS = 7 * 24 * 60 * 60_000;
const META = ["meta", "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT"] as const;
const STATE = ["state", "CREATE TABLE state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL CHECK (revision >= 1), updated_at INTEGER NOT NULL) STRICT"] as const;
const TABLES_V1: ReadonlyArray<readonly [string, string]> = [META,
  ["requests", `CREATE TABLE requests (client_request_id TEXT PRIMARY KEY, operation TEXT NOT NULL CHECK (operation IN ('create', 'cancel')),
  request_hash TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('reserved', 'done')), previous_revision INTEGER NOT NULL CHECK (previous_revision >= 1),
  revision INTEGER NOT NULL CHECK (revision = previous_revision + 1), offer_id TEXT, receipt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT`],
  STATE];
const TABLES_V2: ReadonlyArray<readonly [string, string]> = [META,
  ["claim_state", "CREATE TABLE claim_state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL CHECK (revision >= 1), updated_at INTEGER NOT NULL) STRICT"],
  ["requests", `CREATE TABLE requests (client_request_id TEXT PRIMARY KEY, operation TEXT NOT NULL CHECK (operation IN ('create', 'cancel', 'approve', 'reject')),
  request_hash TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('reserved', 'done')), previous_revision INTEGER NOT NULL CHECK (previous_revision >= 1),
  revision INTEGER NOT NULL CHECK (revision = previous_revision + 1), offer_id TEXT, claim_id TEXT, receipt TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL) STRICT`],
  STATE];
const INSTANCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const normalize = (sql: string): string => sql.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
export type OwnerPairingJournalRow = Record<string, unknown>;
const optionalLstat = (path: string): Stats | null => {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null; throw error; }
};
const domainOf = (operation: OwnerPairingOperation): OwnerPairingDomain => operation === "create" || operation === "cancel" ? "offers" : "claims";
const stateTable = (domain: OwnerPairingDomain): string => domain === "offers" ? "state" : "claim_state";

export interface OwnerPairingJournalOptions {
  dataDir: string;
  identity: () => { hostId: string; ownerId: string };
  now: () => number;
  /** Canonical writer fence (HostStore.withWriterLease) around every journal mutation. */
  writer: <T>(operation: () => T) => T;
  /** Canonical authority generation (HostStore.authorityStatus().epoch). In-process fixtures without a host use 1. */
  authorityEpoch?: () => number;
}

export class OwnerPairingJournal {
  readonly #options: OwnerPairingJournalOptions;
  #db: DatabaseSync | null = null;
  #schema: "1" | "2" | null = null;
  #closed = false;

  /** Pure construction: no file is opened or created here. */
  constructor(options: OwnerPairingJournalOptions) { this.#options = options; }
  get closed(): boolean { return this.#closed; }
  close(): void {
    this.#closed = true;
    if (this.#db) { const db = this.#db; this.#db = null; db.close(); }
  }

  #path(): string {
    if (this.#closed) throw new HostError("device_unavailable", "Owner pairing journal is not available.");
    const data = realpathSync(this.#options.dataDir), stat = lstatSync(data);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HostError("device_unavailable", "Owner pairing journal is not available.");
    return join(data, OWNER_PAIRING_OFFERS_DATABASE_FILE);
  }
  /** Existing journal or null (never creates). */
  #open(): DatabaseSync | null {
    if (this.#db) return this.#db;
    const path = this.#path(), stat = optionalLstat(path);
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new HostError("conflict", "Pairing offer journal is unsafe.");
    const probe = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
    try { this.#verify(probe); } finally { probe.close(); }
    const db = new DatabaseSync(path, { timeout: 5_000 });
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      this.#schema = this.#verify(db);
    } catch (error) { db.close(); throw error; }
    this.#db = db;
    return db;
  }
  #verify(db: DatabaseSync): "1" | "2" {
    const objects = db.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as OwnerPairingJournalRow[];
    const matches = (tables: ReadonlyArray<readonly [string, string]>): boolean => {
      const expected = [...tables].sort((a, b) => a[0].localeCompare(b[0]));
      return objects.length === expected.length && expected.every(([name, sql], i) => objects[i]!.name === name && typeof objects[i]!.sql === "string"
        && normalize(objects[i]!.sql as string) === normalize(sql));
    };
    const meta = Object.fromEntries((db.prepare("SELECT key, value FROM meta").all() as OwnerPairingJournalRow[]).map(row => [String(row.key), String(row.value)]));
    const { hostId, ownerId } = this.#options.identity();
    const keys = Object.keys(meta).sort().join(",");
    if ((keys !== "installation_id,namespace,owner_id,schema_version" && keys !== "installation_id,instance_id,namespace,owner_id,schema_version")
      || meta.installation_id !== hostId || meta.owner_id !== ownerId) throw new HostError("conflict", "Pairing offer journal belongs to another installation.");
    const schema = meta.schema_version === "1" && !("instance_id" in meta) && matches(TABLES_V1) ? "1"
      : meta.schema_version === "2" && INSTANCE.test(meta.instance_id ?? "") && matches(TABLES_V2) ? "2" : null;
    if (!schema || meta.namespace !== NAMESPACE) throw new HostError("conflict", "Pairing offer journal schema is not supported.");
    for (const table of schema === "1" ? ["state"] : ["state", "claim_state"]) {
      const state = db.prepare(`SELECT revision FROM ${table} WHERE id = 1`).get() as OwnerPairingJournalRow | undefined;
      if (!state || !Number.isSafeInteger(Number(state.revision))) throw new HostError("conflict", "Pairing offer journal is inconsistent.");
    }
    return schema;
  }
  /** Creates (schema 2) or migrates (1 → 2) inside the caller's writer fence; returns the open handle. */
  #ensure(): DatabaseSync {
    const existing = this.#open();
    if (existing && this.#schema === "2") return existing;
    const now = this.#options.now();
    if (existing) {
      existing.exec("BEGIN IMMEDIATE");
      try {
        // Rebuild with the widened CHECK; the new table keeps its exact CREATE text (closed-schema verification).
        existing.exec("ALTER TABLE requests RENAME TO requests_v1");
        existing.exec(TABLES_V2.find(([name]) => name === "requests")![1]);
        existing.exec(`INSERT INTO requests (client_request_id, operation, request_hash, state, previous_revision, revision, offer_id, claim_id, receipt, created_at, updated_at)
          SELECT client_request_id, operation, request_hash, state, previous_revision, revision, offer_id, NULL, receipt, created_at, updated_at FROM requests_v1`);
        existing.exec("DROP TABLE requests_v1");
        existing.exec(TABLES_V2.find(([name]) => name === "claim_state")![1]);
        existing.prepare("INSERT INTO claim_state (id, revision, updated_at) VALUES (1, 1, ?)").run(now);
        existing.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(OWNER_PAIRING_JOURNAL_SCHEMA_VERSION);
        existing.prepare("INSERT INTO meta (key, value) VALUES ('instance_id', ?)").run(randomUUID());
        this.#verify(existing);
        existing.exec("COMMIT");
      } catch (error) { if (existing.isTransaction) existing.exec("ROLLBACK"); throw error; }
      this.#schema = "2";
      return existing;
    }
    const path = this.#path(), { hostId, ownerId } = this.#options.identity();
    const db = new DatabaseSync(path, { timeout: 5_000 });
    try {
      chmodSync(path, 0o600);
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
      for (const [, sql] of TABLES_V2) db.exec(sql);
      const put = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      for (const [key, value] of [["schema_version", OWNER_PAIRING_JOURNAL_SCHEMA_VERSION], ["namespace", NAMESPACE], ["installation_id", hostId], ["owner_id", ownerId],
        ["instance_id", randomUUID()]] as const) put.run(key, value);
      db.prepare("INSERT INTO state (id, revision, updated_at) VALUES (1, 1, ?)").run(now);
      db.prepare("INSERT INTO claim_state (id, revision, updated_at) VALUES (1, 1, ?)").run(now);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* not in a transaction */ }
      db.close(); throw error;
    }
    db.close();
    return this.#open()!;
  }
  #tx<T>(operation: (db: DatabaseSync) => T): T {
    return this.#options.writer(() => {
      const db = this.#ensure();
      db.exec("BEGIN IMMEDIATE");
      try { const value = operation(db); db.exec("COMMIT"); return value; }
      catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    });
  }

  /**
   * Continuity pin shown by the owner surfaces and required in every mutation. Materializes (or migrates) the journal under
   * the writer fence, so a pin always names an existing journal instance; a recreated journal gets a new instance.
   */
  pin(): string {
    const db = this.#options.writer(() => this.#ensure());
    const instance = String((db.prepare("SELECT value FROM meta WHERE key = 'instance_id'").get() as OwnerPairingJournalRow).value);
    const { hostId, ownerId } = this.#options.identity(), epoch = this.#options.authorityEpoch?.() ?? 1;
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new HostError("conflict", "Host authority is not active.");
    return createHash("sha256").update(JSON.stringify(["owner-pairing-journal-pin-v1", hostId, ownerId, epoch, instance])).digest("hex");
  }
  /** Refuses a mutation formed under another journal continuity (restore/activation, lost or recreated journal). */
  assertPin(expected: string): void {
    if (expected !== this.pin()) throw new HostError("conflict", "Owner pairing journal changed; re-read the status before deciding again.");
  }
  /** Current revision of one domain (1 before the first decision of that domain, and for a schema "1" journal's claims). */
  revision(domain: OwnerPairingDomain): number {
    const db = this.#open();
    if (!db || (domain === "claims" && this.#schema === "1")) return 1;
    return Number((db.prepare(`SELECT revision FROM ${stateTable(domain)} WHERE id = 1`).get() as OwnerPairingJournalRow).revision);
  }
  row(clientRequestId: string): OwnerPairingJournalRow | null { return this.one("SELECT * FROM requests WHERE client_request_id = ?", clientRequestId); }
  one(sql: string, ...params: SQLInputValue[]): OwnerPairingJournalRow | null {
    const db = this.#open();
    return db ? (db.prepare(sql).get(...params) as OwnerPairingJournalRow | undefined) ?? null : null;
  }
  /** Reserve BEFORE the effect: dedupe row + domain revision bump (+ optional provisional receipt), durable under the writer fence. */
  reserve(input: { clientRequestId: string; operation: OwnerPairingOperation; requestHash: string; expectedRevision: number; offerId: string | null;
    claimId?: string | null; provisional?: (createdAt: number) => string }): number {
    return this.#tx(db => {
      const now = this.#options.now(), table = stateTable(domainOf(input.operation));
      if (db.prepare("SELECT 1 AS x FROM requests WHERE client_request_id = ?").get(input.clientRequestId)) throw new HostError("conflict", "Client request id was already used.");
      const revision = Number((db.prepare(`SELECT revision FROM ${table} WHERE id = 1`).get() as OwnerPairingJournalRow).revision);
      if (revision !== input.expectedRevision) throw new HostError("conflict", "Owner pairing revision changed.");
      db.prepare("DELETE FROM requests WHERE state = 'done' AND created_at < ?").run(now - RETAIN_RECEIPTS_MS);
      if (Number((db.prepare("SELECT COUNT(*) AS n FROM requests").get() as OwnerPairingJournalRow).n) >= MAX_REQUESTS) throw new HostError("conflict", "Pairing offer journal is full.");
      db.prepare(`INSERT INTO requests (client_request_id, operation, request_hash, state, previous_revision, revision, offer_id, claim_id, receipt, created_at, updated_at)
        VALUES (?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?)`).run(input.clientRequestId, input.operation, input.requestHash, revision, revision + 1, input.offerId,
        input.claimId ?? null, input.provisional ? input.provisional(now) : null, now, now);
      db.prepare(`UPDATE ${table} SET revision = ?, updated_at = ? WHERE id = 1`).run(revision + 1, now);
      return now;
    });
  }
  finalize(clientRequestId: string, receiptJson: string, offerId: string | null): void {
    this.#tx(db => {
      const changed = db.prepare("UPDATE requests SET state = 'done', offer_id = COALESCE(?, offer_id), receipt = ?, updated_at = ? WHERE client_request_id = ? AND state = 'reserved'")
        .run(offerId, receiptJson, this.#options.now(), clientRequestId);
      if (Number(changed.changes) !== 1) throw new HostError("conflict", "Pairing offer journal is inconsistent.");
    });
  }
}
