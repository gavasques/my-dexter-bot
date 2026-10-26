import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HostStore } from "@dexter/hub";
import { AI_MEMORY_RESERVED_OPEN_PROJECTS, AiMemoryHttpError, type AiMemoryCallOptions, type AiMemoryHttpClient, type AiMemoryPageRead, type AiMemoryPageRef } from "./ai-memory-http.js";
import { rejectSymlink } from "./filesystem.js";
import { sha256 } from "./repository.js";
import { ContextError, type MemoryPage } from "./types.js";

/**
 * Host-side outbox that mirrors ACTIVE canonical ContextHost memory pages into ai-memory v2.5.2.
 *
 * ContextHost (SQLite + Git) stays the authority; ai-memory is only a search index. The outbox lives in its own
 * SQLite file, so creating a page and queueing its job are NOT atomic: every flush (and every restart) re-enumerates
 * active canonical pages to discover missing intents. Job lifecycle:
 *   queued → inflight (persisted under the writer fence BEFORE any write) → confirmed (exact GET hash only)
 *   inflight that times out, fails, restarts or acks without a visible page → unknown (never rewritten automatically)
 *   unknown → confirmed when an exact GET matches; → conflict when it differs; stays unknown while missing
 *   queued whose page was deactivated before dispatch → withdrawn. Upstream pages are never deleted here.
 *
 * Isolation: no network request at all unless the client carries an owner-exclusive deployment attestation bound to
 * this origin, installation and owner (see `AiMemoryHttpOptions.isolation`). Owner-global maps to the nonreserved
 * `owner-global` project (outbox schema 2). Canonical pages still pinned to the old reserved `_global` project are
 * reported as `legacy` and never indexed or re-pointed. A schema-1 outbox holding reserved-project pins opens read-only
 * (`blocked: "legacy_reserved_mapping"`): nothing is rewritten, replayed, deleted or confirmed automatically.
 */
export type AiMemoryJobState = "queued" | "inflight" | "confirmed" | "unknown" | "conflict" | "withdrawn";
export interface AiMemorySyncJob extends AiMemoryPageRef { memoryId: string; sha256: string; locale: string; scopeKey: string; state: AiMemoryJobState; attempts: number; createdAt: number; updatedAt: number }
export interface AiMemoryFlushReport {
  backend: "verified" | "unavailable" | "not_contacted";
  discovered: number; rejected: number; writes: number;
  confirmed: number; unknown: number; conflict: number; withdrawn: number; truncated: boolean;
  /** Active canonical pages still pinned to the pre-v2 reserved `_global` location; never queued. */
  legacy: number;
}
export interface AiMemorySyncStatus {
  health: "unverified" | "healthy" | "degraded" | "blocked";
  /** Why flush refuses before any network request; null when indexing may run. */
  blocked: null | "isolation_unattested" | "legacy_reserved_mapping";
  isolation: "owner_exclusive_deployment" | "unattested";
  /** From the last completed discovery in this controller; null before one ran. */
  legacyReservedPages: number | null;
  backend: { name: "ai-memory"; version: "2.5.2"; protocolVersion: "2024-11-05"; verifiedAt: number } | null;
  lastConfirmedAt: number | null;
  /** v2.5.2 `/api/v1/search` is FTS5-only; nothing here measures retrieval quality. */
  search: "fts_only";
  counts: Record<AiMemoryJobState, number>;
}
/** The only ContextHost surface the outbox needs (trusted owner read). */
export type AiMemorySyncSource = Pick<import("./context.js").ContextHost, "activeMemoryPagesForSync">;
export interface AiMemorySyncOptions { maxJobsPerFlush?: number; maxDiscoveredPerFlush?: number }

type Row = Record<string, unknown>;
const STATES: readonly AiMemoryJobState[] = ["queued", "inflight", "confirmed", "unknown", "conflict", "withdrawn"];
const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE jobs (memory_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, project TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL,
  locale TEXT NOT NULL, scope_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','inflight','confirmed','unknown','conflict','withdrawn')),
  attempts INTEGER NOT NULL, dispatch_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`;
class BackendUnavailable extends Error {}

export class AiMemorySync {
  readonly databasePath: string;
  readonly #store: HostStore;
  readonly #source: AiMemorySyncSource;
  readonly #client: AiMemoryHttpClient;
  readonly #db: DatabaseSync;
  readonly #namespace: string;
  readonly #maxJobs: number;
  readonly #maxDiscovered: number;
  readonly #abort = new AbortController();
  #flight: Promise<AiMemoryFlushReport> | null = null;
  #closed = false;
  #verified: AiMemorySyncStatus["backend"] = null;
  #lastConfirmedAt: number | null = null;
  #degraded = false;
  #legacyOutbox = false;
  #legacyPages: number | null = null;

  constructor(store: HostStore, source: AiMemorySyncSource, client: AiMemoryHttpClient, options: AiMemorySyncOptions = {}) {
    this.#store = store; this.#source = source; this.#client = client;
    this.#maxJobs = options.maxJobsPerFlush ?? 50;
    this.#maxDiscovered = options.maxDiscoveredPerFlush ?? 10_000;
    if (!Number.isInteger(this.#maxJobs) || this.#maxJobs < 1 || this.#maxJobs > 1_000 || !Number.isInteger(this.#maxDiscovered) || this.#maxDiscovered < 1 || this.#maxDiscovered > 100_000) throw new ContextError("invalid_input");
    // A present attestation must name this installation and owner; the client already bound it to its origin.
    if (client.isolation && (client.isolation.installationId !== store.hostId || client.isolation.ownerId !== store.ownerId || client.isolation.origin !== client.origin)) {
      throw new ContextError("conflict", "ai-memory isolation attestation names another installation, owner or origin");
    }
    this.#namespace = `dx-${sha256(`${store.hostId}/${store.ownerId}`).slice(0, 24)}`;
    this.databasePath = join(dirname(store.databasePath), "ai-memory-outbox.sqlite");
    this.#db = store.withWriterLease(() => {
      this.#checkFiles();
      const db = new DatabaseSync(this.databasePath, { timeout: 5_000 });
      try {
        chmodSync(this.databasePath, 0o600);
        db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
        db.exec("BEGIN IMMEDIATE");
        if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get()) {
          db.exec(SCHEMA);
          const put = db.prepare("INSERT INTO meta (key,value) VALUES (?,?)");
          put.run("schema", "2"); put.run("installation", store.hostId); put.run("owner", store.ownerId); put.run("origin", client.origin);
        }
        if (this.#schema(db) === "1") {
          this.#checkMeta(db, "1");
          const reserved = AI_MEMORY_RESERVED_OPEN_PROJECTS.map(() => "?").join(",");
          if (Number((db.prepare(`SELECT count(*) AS n FROM jobs WHERE project IN (${reserved})`).get(...AI_MEMORY_RESERVED_OPEN_PROJECTS) as Row).n) > 0) {
            // Pre-v2 pins to an always-Open project: quarantine read-only. No state change, replay or re-pointing.
            db.exec("ROLLBACK"); this.#legacyOutbox = true; this.#checkFiles(); return db;
          }
          db.prepare("UPDATE meta SET value='2' WHERE key='schema'").run(); // no reserved pins: every row keeps its exact meaning
        }
        this.#checkMeta(db);
        // No in-flight write can survive a restart: its outcome is unknown and is reconciled only by exact GET.
        db.prepare("UPDATE jobs SET state='unknown', dispatch_id=NULL, updated_at=? WHERE state='inflight'").run(store.now());
        db.exec("COMMIT");
        this.#checkFiles();
        return db;
      } catch (error) { try { db.exec("ROLLBACK"); } catch { /* not in a transaction */ } db.close(); throw error; }
    });
  }

  #checkFiles(): void {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const stat = rejectSymlink(`${this.databasePath}${suffix}`);
      if (stat && (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()))) throw new ContextError("tampered");
      if (stat && (stat.mode & 0o077) !== 0) chmodSync(`${this.databasePath}${suffix}`, 0o600);
    }
  }
  #schema(db: DatabaseSync): unknown { return (db.prepare("SELECT value FROM meta WHERE key='schema'").get() as Row | undefined)?.value; }
  #checkMeta(db: DatabaseSync, schema = "2"): void {
    const get = (key: string) => (db.prepare("SELECT value FROM meta WHERE key=?").get(key) as Row | undefined)?.value;
    if (get("schema") !== schema || get("installation") !== this.#store.hostId || get("owner") !== this.#store.ownerId || get("origin") !== this.#client.origin) {
      throw new ContextError("conflict", "ai-memory outbox belongs to another installation, owner or backend origin");
    }
  }
  /** Synchronous outbox mutation under the canonical host writer fence. Never calls ContextHost or HostStore writes. */
  #fence<T>(operation: () => T): T {
    if (this.#closed || this.#legacyOutbox) throw new ContextError("conflict");
    return this.#store.withWriterLease(() => {
      this.#checkFiles();
      this.#db.exec("BEGIN IMMEDIATE");
      try { this.#checkMeta(this.#db); const result = operation(); this.#db.exec("COMMIT"); return result; }
      catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    });
  }

  /** Expected immutable service location for a canonical page; anything else is a foreign scope and never imported. */
  #expected(page: MemoryPage): AiMemoryPageRef | null {
    const s = page.scope; const path = `notes/${page.id}.md`;
    const expected = s.kind === "global" ? { workspace: `${this.#namespace}-global`, project: "owner-global" }
      : s.kind === "team" ? { workspace: `${this.#namespace}-${s.teamId}`, project: "_team" }
      : s.kind === "bot" || s.kind === "confidential" ? { workspace: this.#namespace, project: `${s.kind}-${s.botId}` } : null;
    if (!expected || page.classification !== "context" || !page.active || page.service.workspace !== expected.workspace || page.service.project !== expected.project || page.service.path !== path) return null;
    return { ...expected, path };
  }
  /** Active global page created before the owner-global mapping: canonical, but its stored location is always-Open upstream. */
  #legacyGlobal(page: MemoryPage): boolean {
    return page.scope.kind === "global" && page.active && page.service.workspace === `${this.#namespace}-global` && page.service.project === "_global" && page.service.path === `notes/${page.id}.md`;
  }
  static #scopeKey(page: MemoryPage): string {
    const s = page.scope; return s.kind === "global" ? "global" : s.kind === "team" ? `team:${s.teamId}` : `${s.kind}:${s.botId}`;
  }
  #job(memoryId: string): Row | undefined { return this.#db.prepare("SELECT * FROM jobs WHERE memory_id=?").get(memoryId) as Row | undefined; }
  static #toJob(row: Row): AiMemorySyncJob {
    return { memoryId: row.memory_id as string, workspace: row.workspace as string, project: row.project as string, path: row.path as string, sha256: row.hash as string,
      locale: row.locale as string, scopeKey: row.scope_key as string, state: row.state as AiMemoryJobState, attempts: row.attempts as number,
      createdAt: row.created_at as number, updatedAt: row.updated_at as number };
  }

  jobs(): AiMemorySyncJob[] {
    if (this.#closed) throw new ContextError("conflict");
    return (this.#db.prepare("SELECT * FROM jobs ORDER BY created_at, memory_id").all() as Row[]).map(AiMemorySync.#toJob);
  }
  status(): AiMemorySyncStatus {
    if (this.#closed) throw new ContextError("conflict");
    const counts = Object.fromEntries(STATES.map(state => [state, 0])) as Record<AiMemoryJobState, number>;
    for (const row of this.#db.prepare("SELECT state, count(*) AS n FROM jobs GROUP BY state").all() as Row[]) counts[row.state as AiMemoryJobState] = Number(row.n);
    const blocked = this.#blocked();
    const healthy = blocked === null && this.#verified !== null && this.#lastConfirmedAt !== null && !this.#degraded && !this.#legacyPages && counts.unknown === 0 && counts.conflict === 0 && counts.inflight === 0;
    const health = blocked !== null ? "blocked" : healthy ? "healthy" : this.#degraded || !!this.#legacyPages || counts.unknown + counts.conflict > 0 ? "degraded" : "unverified";
    return { health, blocked, isolation: this.#client.isolation ? "owner_exclusive_deployment" : "unattested", legacyReservedPages: this.#legacyPages,
      backend: this.#verified, lastConfirmedAt: this.#lastConfirmedAt, search: "fts_only", counts };
  }
  #blocked(): AiMemorySyncStatus["blocked"] {
    return this.#legacyOutbox ? "legacy_reserved_mapping" : this.#client.isolation === null ? "isolation_unattested" : null;
  }

  /** Single-flight per controller: concurrent callers share one run. Network awaits never happen inside the writer fence. */
  flush(): Promise<AiMemoryFlushReport> {
    if (this.#closed) return Promise.reject(new ContextError("conflict"));
    // Refused before discovery or any request: indexing needs a supported isolation assurance and a v2 outbox.
    const blocked = this.#blocked();
    if (blocked === "legacy_reserved_mapping") return Promise.reject(new ContextError("conflict", "ai-memory outbox holds pre-v2 reserved _global pins; owner migration required"));
    if (blocked === "isolation_unattested") return Promise.reject(new ContextError("forbidden", "ai-memory indexing requires a trusted owner-exclusive deployment attestation"));
    this.#flight ??= this.#run().finally(() => { this.#flight = null; });
    return this.#flight;
  }
  /**
   * Aborts this controller's own requests, waits for the running flush to persist their (unknown) outcomes, then closes
   * the outbox. Rejects — after releasing the file — if that work could not be settled under the writer fence; callers
   * must not treat a rejected close as a clean shutdown.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#abort.abort();
    let failure: unknown = null;
    if (this.#flight) { try { await this.#flight; } catch (error) { failure = error; } }
    const stranded = Number((this.#db.prepare("SELECT count(*) AS n FROM jobs WHERE state='inflight'").get() as Row).n);
    this.#closed = true;
    this.#store.withWriterLease(() => this.#db.close());
    if (failure !== null) throw failure;
    if (stranded > 0) throw new ContextError("conflict", "ai-memory outbox closed with in-flight jobs; they become unknown on reopen");
  }

  async #run(): Promise<AiMemoryFlushReport> {
    const report: AiMemoryFlushReport = { backend: "not_contacted", discovered: 0, rejected: 0, writes: 0, confirmed: 0, unknown: 0, conflict: 0, withdrawn: 0, truncated: false, legacy: 0 };
    this.#discover(report);
    const pending = (state: AiMemoryJobState) => (this.#db.prepare("SELECT memory_id FROM jobs WHERE state=? ORDER BY created_at, memory_id LIMIT ?").all(state, this.#maxJobs) as Row[]).map(row => row.memory_id as string);
    if (pending("unknown").length === 0 && pending("queued").length === 0) return report;
    const call: AiMemoryCallOptions = { signal: this.#abort.signal };
    try {
      const server = await this.#client.initialize(call);
      this.#verified = { ...server, verifiedAt: this.#store.now() }; report.backend = "verified";
      for (const memoryId of pending("unknown")) await this.#reconcile(memoryId, report, call);
      for (const memoryId of pending("queued")) await this.#dispatch(memoryId, report, call);
      this.#degraded = false;
    } catch (error) {
      this.#degraded = true;
      if (error instanceof BackendUnavailable || error instanceof AiMemoryHttpError) { report.backend = "unavailable"; return report; }
      throw error;
    }
    return report;
  }

  /** Enumerates active canonical pages outside the fence, then records missing intents synchronously inside it. */
  #discover(report: AiMemoryFlushReport): void {
    let after: string | undefined;
    for (let seen = 0; ;) {
      if (seen >= this.#maxDiscovered) { report.truncated = true; this.#legacyPages = Math.max(this.#legacyPages ?? 0, report.legacy); return; }
      const pages = this.#source.activeMemoryPagesForSync(after === undefined ? { limit: 100 } : { after, limit: 100 });
      seen += pages.length;
      this.#fence(() => {
        const now = this.#store.now();
        for (const page of pages) {
          const target = this.#expected(page);
          if (!target) { if (this.#legacyGlobal(page)) report.legacy += 1; else report.rejected += 1; continue; }
          const hash = sha256(page.markdown); const existing = this.#job(page.id);
          if (!existing) {
            this.#db.prepare("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,'queued',0,NULL,?,?)").run(page.id, target.workspace, target.project, target.path, hash, page.locale, AiMemorySync.#scopeKey(page), now, now);
            report.discovered += 1;
          } else if (existing.workspace !== target.workspace || existing.project !== target.project || existing.path !== target.path || existing.hash !== hash) {
            // Canonical pages are immutable; a changed pin is tampering. Freeze it, never rewrite.
            this.#db.prepare("UPDATE jobs SET state='conflict', dispatch_id=NULL, updated_at=? WHERE memory_id=? AND state<>'inflight'").run(now, page.id);
          }
        }
      });
      if (pages.length < 100) { this.#legacyPages = report.legacy; return; }
      after = pages[pages.length - 1]!.id;
    }
  }
  /** Current source authority: the page must still be active with the job's exact pinned location and hash. */
  #authority(row: Row): { page: MemoryPage; ref: AiMemoryPageRef } | "inactive" | "changed" {
    const page = this.#source.activeMemoryPagesForSync({ ids: [row.memory_id as string], limit: 1 })[0];
    if (!page) return "inactive";
    const ref = this.#expected(page);
    if (!ref || ref.workspace !== row.workspace || ref.project !== row.project || ref.path !== row.path || sha256(page.markdown) !== row.hash) return "changed";
    return { page, ref };
  }
  #transition(memoryId: string, from: AiMemoryJobState, to: AiMemoryJobState, pin: Row, extra: { dispatchId?: string } = {}): boolean {
    return this.#fence(() => {
      const changed = this.#db.prepare(`UPDATE jobs SET state=?, updated_at=?, dispatch_id=?, attempts=attempts+? WHERE memory_id=? AND state=?
        AND workspace=? AND project=? AND path=? AND hash=? AND (dispatch_id IS ? OR ? IS NULL)`)
        .run(to, this.#store.now(), to === "inflight" ? extra.dispatchId ?? null : null, to === "inflight" ? 1 : 0, memoryId, from,
          pin.workspace as string, pin.project as string, pin.path as string, pin.hash as string,
          from === "inflight" ? extra.dispatchId ?? null : null, from === "inflight" ? extra.dispatchId ?? null : null);
      return Number(changed.changes) === 1;
    });
  }
  #settle(read: AiMemoryPageRead, hash: string): "confirmed" | "conflict" | "unknown" {
    if (read.kind === "missing") return "unknown";
    if (read.sha256 === hash) { this.#lastConfirmedAt = this.#store.now(); return "confirmed"; }
    return "conflict";
  }
  async #read(ref: AiMemoryPageRef, call: AiMemoryCallOptions): Promise<AiMemoryPageRead> {
    try { return await this.#client.getPage(ref, call); } catch { throw new BackendUnavailable(); }
  }

  /** Unknown outcome: exact GET only. Missing stays unknown (a late upstream effect may still land); never writes. */
  async #reconcile(memoryId: string, report: AiMemoryFlushReport, call: AiMemoryCallOptions): Promise<void> {
    const pin = this.#job(memoryId);
    if (!pin || pin.state !== "unknown") return;
    const read = await this.#read({ workspace: pin.workspace as string, project: pin.project as string, path: pin.path as string }, call);
    const outcome = this.#settle(read, pin.hash as string);
    if (outcome === "unknown") { report.unknown += 1; return; }
    if (this.#transition(memoryId, "unknown", outcome, pin)) report[outcome] += 1;
  }

  async #dispatch(memoryId: string, report: AiMemoryFlushReport, call: AiMemoryCallOptions): Promise<void> {
    const pin = this.#job(memoryId);
    if (!pin || pin.state !== "queued") return;
    let authority = this.#authority(pin);
    if (authority === "inactive") { if (this.#transition(memoryId, "queued", "withdrawn", pin)) report.withdrawn += 1; return; }
    if (authority === "changed") { if (this.#transition(memoryId, "queued", "conflict", pin)) report.conflict += 1; return; }
    const ref = authority.ref;
    // Fresh queued job: an existing exact page needs no write; a differing page is a conflict; only "missing" may write once.
    const before = await this.#read(ref, call);
    if (before.kind === "found") {
      const outcome = this.#settle(before, pin.hash as string);
      if (this.#transition(memoryId, "queued", outcome, pin)) report[outcome as "confirmed" | "conflict"] += 1;
      return;
    }
    if (this.#abort.signal.aborted) return;
    // Post-await: recheck source authority synchronously, then claim the job under the fence before any network effect.
    authority = this.#authority(pin);
    if (authority === "inactive") { if (this.#transition(memoryId, "queued", "withdrawn", pin)) report.withdrawn += 1; return; }
    if (authority === "changed") { if (this.#transition(memoryId, "queued", "conflict", pin)) report.conflict += 1; return; }
    const dispatchId = randomUUID();
    if (!this.#transition(memoryId, "queued", "inflight", pin, { dispatchId })) return; // another controller owns it
    report.writes += 1;
    let outcome: "confirmed" | "conflict" | "unknown" = "unknown";
    try { await this.#client.writePage(authority.ref, authority.page.markdown, call); } catch { /* ambiguous: verify below, never retry */ }
    try { outcome = this.#settle(await this.#client.getPage(authority.ref, call), pin.hash as string); } catch { outcome = "unknown"; }
    // Persist under a fresh fence; if the writer was lost this throws and the row stays inflight → unknown on reopen.
    if (this.#transition(memoryId, "inflight", outcome, pin, { dispatchId })) report[outcome] += 1;
    if (outcome === "unknown" && this.#abort.signal.aborted) throw new BackendUnavailable();
  }
}
