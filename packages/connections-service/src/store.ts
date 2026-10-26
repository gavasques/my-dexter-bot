import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Service-side state. No provider key, token, authorization link, callback nonce (only its hash), tool arguments or results.
 * One writer process; every mutation is one BEGIN IMMEDIATE transaction.
 */
export const SERVICE_DATABASE_FILE = "connections-service.sqlite";
/** "2" (UX-P1-11): attempts record identity kind/source. "1" stores are migrated explicitly, in place, once. */
export const SERVICE_SCHEMA_VERSION = "2";
const SCHEMA = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE attempts(
  installation_id TEXT NOT NULL, request_id TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, owner_id TEXT NOT NULL,
  profile_id TEXT NOT NULL, service_id TEXT NOT NULL, catalog_pin TEXT NOT NULL, toolkit TEXT NOT NULL, auth_config_id TEXT NOT NULL, user_id TEXT NOT NULL,
  alias TEXT NOT NULL UNIQUE, nonce_hash TEXT NOT NULL, account_ref TEXT,
  state TEXT NOT NULL CHECK(state IN ('starting','awaiting_user','active','failed','expired','unknown')), reason TEXT, expires_at INTEGER,
  callback TEXT NOT NULL CHECK(callback IN ('none','success','failed')), identity_value TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  identity_kind TEXT, identity_source TEXT,
  PRIMARY KEY(installation_id, request_id)) STRICT;
CREATE TABLE accounts(
  account_ref TEXT PRIMARY KEY, installation_id TEXT NOT NULL, owner_id TEXT NOT NULL, profile_id TEXT NOT NULL, service_id TEXT NOT NULL, toolkit TEXT NOT NULL,
  auth_config_id TEXT NOT NULL, user_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','active','disconnecting','deleted')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE disconnects(
  installation_id TEXT NOT NULL, request_id TEXT NOT NULL, account_ref TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('inflight','done','unknown')),
  result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(installation_id, request_id)) STRICT;
CREATE TABLE executions(
  installation_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, account_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('inflight','done','failed','unknown')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(installation_id, request_id)) STRICT;
`;
export type Row = Record<string, unknown>;

export class ServiceStore {
  readonly path: string;
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(dataDir: string, configuration: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.path = join(dataDir, SERVICE_DATABASE_FILE);
    this.#files();
    this.#db = new DatabaseSync(this.path, { timeout: 5_000 });
    try {
      chmodSync(this.path, 0o600);
      this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      this.tx(() => {
        if (!this.#db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='meta'").get()) {
          this.#db.exec(SCHEMA);
          const put = this.#db.prepare("INSERT INTO meta VALUES (?,?)");
          put.run("schema", SERVICE_SCHEMA_VERSION); put.run("configuration", configuration);
        }
        const get = (k: string) => (this.#db.prepare("SELECT value FROM meta WHERE key=?").get(k) as Row | undefined)?.value;
        if (get("configuration") !== configuration) throw new Error("connections service store belongs to another configuration");
        if (get("schema") === "1") {
          // Explicit 1 → 2: two nullable columns, no row rewritten; earlier identities stay as recorded (label level).
          this.#db.exec("ALTER TABLE attempts ADD COLUMN identity_kind TEXT; ALTER TABLE attempts ADD COLUMN identity_source TEXT;");
          this.#db.prepare("UPDATE attempts SET identity_kind='display_name', identity_source='provider_label' WHERE identity_value IS NOT NULL").run();
          this.#db.prepare("UPDATE meta SET value=? WHERE key='schema'").run(SERVICE_SCHEMA_VERSION);
        }
        if (get("schema") !== SERVICE_SCHEMA_VERSION) throw new Error("connections service store has an unsupported schema");
        // A provider write interrupted by a previous process is never resumed; reads settle it.
        this.#db.prepare("UPDATE attempts SET state='unknown', reason='outcome_unknown' WHERE state='starting'").run();
        this.#db.prepare("UPDATE disconnects SET state='unknown' WHERE state='inflight'").run();
        this.#db.prepare("UPDATE executions SET state='unknown' WHERE state='inflight'").run();
      });
      this.#files();
    } catch (error) { this.#db.close(); throw error; }
  }
  #files(): void {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      let stat;
      try { stat = lstatSync(this.path + suffix); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) throw new Error("connections service store is not a private regular file");
      chmodSync(this.path + suffix, 0o600);
    }
  }
  tx<T>(fn: () => T): T {
    if (this.#closed) throw new Error("connections service store is closed");
    this.#db.exec("BEGIN IMMEDIATE");
    try { const out = fn(); this.#db.exec("COMMIT"); return out; }
    catch (error) { if (this.#db.isTransaction) this.#db.exec("ROLLBACK"); throw error; }
  }
  one(sql: string, ...params: Array<string | number | null>): Row | undefined {
    if (this.#closed) throw new Error("connections service store is closed");
    return this.#db.prepare(sql).get(...params) as Row | undefined;
  }
  run(sql: string, ...params: Array<string | number | null>): number {
    if (this.#closed) throw new Error("connections service store is closed");
    return Number(this.#db.prepare(sql).run(...params).changes);
  }
  close(): void { if (!this.#closed) { this.#closed = true; this.#db.close(); } }
}
