import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { createHash, randomUUID, verify } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { inspect } from "node:util";
import { MAX_TTL_MS, RelayError, bytes, control, controlBytes, digest, envelope, envelopeBytes, id, integer, pin, publicKey, verifyEnvelope,
  type DevicePin, type Delivery, type QueueReceipt } from "./protocol.js";

type Row = Record<string, string | number | null>;
/** A current recipient may ACK an exact receipt this long after its envelope expired, even when its sender retired. */
const ACK_RETENTION_MS = MAX_TTL_MS;
function stat(path: string) {
  try { return lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw new RelayError("unavailable"); }
}
function privatePaths(dir: string, path: string): void {
  const directory = stat(dir), uid = process.getuid?.();
  if (uid === undefined || !directory || directory.isSymbolicLink() || !directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077)) throw new RelayError("forbidden");
  for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    const s = stat(candidate);
    if (s && (s.isSymbolicLink() || !s.isFile() || s.uid !== uid || (s.mode & 0o077))) throw new RelayError("forbidden");
  }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export interface RelayOptions {
  dataDir: string; ownerId: string; installationId: string; clock?: () => number;
  /** Trusted test seam; production defaults to a real process monotonic clock. */
  monotonicClock?: () => number;
  maximumPending?: number; maximumPendingPerRecipient?: number; maximumMarkers?: number;
  /** Trusted offline admin opt-in; legacy live PID/foreign hostname are still refused, never forced. */
  allowOfflineLegacyMigration?: boolean;
}
/** Trusted local owner-admin API. Never expose pin registration or this store directly over HTTP. */
export class RelayStore {
  readonly #db: DatabaseSync;
  readonly #writerLock!: DatabaseSync;
  readonly #token = randomUUID();
  readonly #owner: string;
  readonly #installation: string;
  readonly #clock: () => number;
  readonly #dir: string;
  readonly #path: string;
  readonly #pendingLimit: number;
  readonly #recipientLimit: number;
  readonly #markerLimit: number;
  readonly #monotonic: () => number;
  #anchorFloor = 0;
  #anchorMonotonic = 0;
  #closed = false;
  #instant: number | null = null;

  constructor(options: RelayOptions) {
    id(options.ownerId); id(options.installationId);
    if (typeof options.dataDir !== "string" || options.dataDir.length > 4096 || !isAbsolute(options.dataDir)) throw new RelayError("invalid_input");
    this.#owner = options.ownerId; this.#installation = options.installationId; this.#clock = options.clock ?? Date.now; this.#monotonic = options.monotonicClock ?? (() => performance.now());
    this.#dir = options.dataDir; this.#path = join(options.dataDir, "relay.sqlite");
    this.#pendingLimit = options.maximumPending ?? 1024; this.#recipientLimit = options.maximumPendingPerRecipient ?? Math.min(128, this.#pendingLimit); this.#markerLimit = options.maximumMarkers ?? 100_000;
    integer(this.#pendingLimit, 1, 4096); integer(this.#recipientLimit, 1, this.#pendingLimit); integer(this.#markerLimit, 1, 1_000_000);
    try {
      if (stat(this.#dir) === null) mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      const lockPath = join(this.#dir, "relay-writer.sqlite");
      privatePaths(this.#dir, lockPath);
      if (stat(lockPath) === null) {
        try { writeFileSync(lockPath, "", { flag: "wx", mode: 0o600 }); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      }
      this.#writerLock = new DatabaseSync(lockPath);
      try {
        this.#writerLock.exec("PRAGMA busy_timeout=100; BEGIN EXCLUSIVE;");
      } catch (e) {
        this.#writerLock.close();
        const n = (e as { errcode?: number }).errcode;
        throw new RelayError(n === 5 || n === 6 ? "host_locked" : "unavailable");
      }
      privatePaths(this.#dir, this.#path);
      if (stat(this.#path) === null) writeFileSync(this.#path, "", { flag: "wx", mode: 0o600 });
      this.#db = new DatabaseSync(this.#path);
    } catch (e) {
      try { this.#writerLock!.close(); } catch { /* no acquired lock or already closed */ }
      throw e instanceof RelayError ? e : new RelayError("unavailable");
    }
    let claimed = false;
    try {
      this.#db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;");
      this.transaction(() => {
        const hasIdentity = this.one("SELECT name FROM sqlite_master WHERE type='table' AND name='identity'");
        if (hasIdentity) {
          for (const name of ["lease", "pins", "sequences", "receipts", "queue", "controls"]) {
            if (!this.one("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name)) throw new RelayError("forbidden");
          }
          const identity = this.one("SELECT * FROM identity WHERE id=1"), lease = this.one("SELECT * FROM lease WHERE id=1");
          if (!identity || identity.owner !== this.#owner || identity.installation !== this.#installation || (identity.version !== 1 && identity.version !== 2 && identity.version !== 3)) throw new RelayError("forbidden");
          if (identity.version === 1) {
            if (!options.allowOfflineLegacyMigration || (lease && (lease.hostname !== hostname() || alive(Number(lease.pid))))) throw new RelayError("host_locked");
            // R1 stored no control timestamp: never guess one and silently reopen an old nonce.
            this.#db.exec("ALTER TABLE identity ADD COLUMN time_floor INTEGER NOT NULL DEFAULT 0; ALTER TABLE controls ADD COLUMN issued_at INTEGER NOT NULL DEFAULT 9007199254740991; ALTER TABLE receipts ADD COLUMN digest_version INTEGER NOT NULL DEFAULT 1;");
            this.run("UPDATE identity SET version=2 WHERE id=1");
          }
          if (identity.version === 1 || identity.version === 2) {
            // Preserve old global nonces verbatim: v2 timestamps retain their signed window; v1 is permanent.
            this.#db.exec(`CREATE TABLE controls_v3(device TEXT NOT NULL,generation INTEGER NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,kind TEXT NOT NULL,receipt_id TEXT NOT NULL,issued_at INTEGER NOT NULL,PRIMARY KEY(device,generation,request_id));
              INSERT INTO controls_v3 SELECT '',0,request_id,digest,kind,receipt_id,issued_at FROM controls;
              DROP TABLE controls; ALTER TABLE controls_v3 RENAME TO controls; UPDATE identity SET version=3 WHERE id=1;`);
          }
        } else if (this.one("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1")) throw new RelayError("forbidden");
        this.#db.exec(`CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, installation TEXT NOT NULL, version INTEGER NOT NULL, time_floor INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, pid INTEGER NOT NULL, hostname TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pins(device TEXT PRIMARY KEY, generation INTEGER NOT NULL, key_id TEXT NOT NULL, signing TEXT NOT NULL, encryption TEXT NOT NULL, revoked INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sequences(stream TEXT PRIMARY KEY, last_sequence INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS receipts(cursor INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT UNIQUE NOT NULL, receipt_id TEXT UNIQUE NOT NULL, digest TEXT NOT NULL,
          sender TEXT NOT NULL, sender_generation INTEGER NOT NULL, recipient TEXT NOT NULL, recipient_generation INTEGER NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL, digest_version INTEGER NOT NULL DEFAULT 2);
        CREATE TABLE IF NOT EXISTS queue(cursor INTEGER PRIMARY KEY REFERENCES receipts(cursor), envelope TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS controls(device TEXT NOT NULL,generation INTEGER NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,kind TEXT NOT NULL,receipt_id TEXT NOT NULL,issued_at INTEGER NOT NULL,PRIMARY KEY(device,generation,request_id));
        CREATE INDEX IF NOT EXISTS control_expiry ON controls(issued_at);
        CREATE INDEX IF NOT EXISTS principal_controls ON controls(device,generation,issued_at);
        CREATE INDEX IF NOT EXISTS recipient_queue ON receipts(recipient, cursor);`);
        const identity = this.one("SELECT * FROM identity WHERE id=1");
        if (identity && (identity.owner !== this.#owner || identity.installation !== this.#installation || identity.version !== 3)) throw new RelayError("forbidden");
        if (!identity) this.run("INSERT INTO identity VALUES(1,?,?,3,0)", this.#owner, this.#installation);
        this.run("INSERT OR REPLACE INTO lease VALUES(1,?,?,?)", this.#token, process.pid, hostname());
      }, false);
      claimed = true;
      this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      chmodSync(this.#path, 0o600); privatePaths(this.#dir, this.#path);
      this.#anchorFloor = Number(this.one("SELECT time_floor FROM identity WHERE id=1")!.time_floor);
      if (this.#anchorFloor === 0) { this.#anchorFloor = this.#clock(); integer(this.#anchorFloor); }
      this.#anchorMonotonic = this.monotonic();
    } catch (e) {
      // If initialization claimed our token but a later PRAGMA failed, relinquish only our own token.
      // No messages/effects can have been accepted by this unreturned instance.
      if (claimed) try { this.#db.prepare("DELETE FROM lease WHERE token=?").run(this.#token); } catch { /* preserve foreign leases */ }
      this.#db.close(); this.#writerLock.close(); throw e instanceof RelayError ? e : new RelayError("unavailable");
    }
  }
  get databasePath(): string { return this.#path; }
  toJSON(): object { return { ownerId: this.#owner, installationId: this.#installation, closed: this.#closed }; }
  [inspect.custom](): object { return this.toJSON(); }

  /** Explicit owner approval of out-of-band public pins; no pairing inferred from a body's device ID. */
  registerDevice(value: unknown): void {
    const p = pin(value);
    if (p.ownerId !== this.#owner || p.installationId !== this.#installation) throw new RelayError("forbidden");
    this.transaction(() => {
      const old = this.one("SELECT * FROM pins WHERE device=?", p.deviceId);
      if (old && old.revoked === 0 && Number(old.generation) === p.generation && old.key_id === p.keyId && old.signing === p.signingPublicKey && old.encryption === p.encryptionPublicKey) return;
      if (old && (p.generation !== Number(old.generation) + 1 || old.key_id === p.keyId || old.signing === p.signingPublicKey || old.encryption === p.encryptionPublicKey)) throw new RelayError("conflict");
      if (!old && (p.generation !== 1 || Number(this.one("SELECT COUNT(*) AS n FROM pins")!.n) >= 64)) throw new RelayError("quota");
      this.run("INSERT OR REPLACE INTO pins VALUES(?,?,?,?,?,0)", p.deviceId, p.generation, p.keyId, p.signingPublicKey, p.encryptionPublicKey);
      this.run("UPDATE receipts SET state='stale' WHERE state='pending' AND (sender=? OR recipient=?)", p.deviceId, p.deviceId);
    });
  }
  revokeDevice(deviceId: string): void {
    id(deviceId);
    this.transaction(() => {
      if (!this.one("SELECT device FROM pins WHERE device=?", deviceId)) throw new RelayError("forbidden");
      this.run("UPDATE pins SET revoked=1 WHERE device=?", deviceId);
      this.run("UPDATE receipts SET state='stale' WHERE state='pending' AND (sender=? OR recipient=?)", deviceId, deviceId);
    });
  }
  enqueue(value: unknown): QueueReceipt {
    const e = envelope(value);
    return this.transaction(() => {
      verifyEnvelope(e, this.currentPin(e.senderId), this.currentPin(e.recipientId));
      const hash = digest(e), old = this.one("SELECT * FROM receipts WHERE message_id=?", e.messageId);
      if (old) {
        const expected = old.digest_version === 1 ? createHash("sha256").update(envelopeBytes(e)).update(bytes(e.signature, 64, 64)).digest("hex") : hash;
        if (old.digest !== expected) throw new RelayError("conflict");
        if (old.digest_version === 1) this.run("UPDATE receipts SET digest=?,digest_version=2 WHERE message_id=?", hash, e.messageId);
        return { receiptId: String(old.receipt_id), cursor: Number(old.cursor) };
      }
      const now = this.now();
      if (e.expiresAt <= now || e.createdAt < now - 300_000 || e.createdAt > now + 30_000) throw new RelayError("expired");
      if (Number(this.one("SELECT COUNT(*) AS n FROM receipts")!.n) >= this.#markerLimit || Number(this.one("SELECT COUNT(*) AS n FROM queue")!.n) >= this.#pendingLimit
        || Number(this.one("SELECT COUNT(*) AS n FROM receipts r JOIN queue q USING(cursor) WHERE r.recipient=?", e.recipientId)!.n) >= this.#recipientLimit) throw new RelayError("quota");
      const stream = JSON.stringify([e.senderId, e.senderGeneration, e.recipientId, e.recipientGeneration]);
      const last = this.one("SELECT last_sequence FROM sequences WHERE stream=?", stream);
      if (e.sequence !== (last ? Number(last.last_sequence) : 0) + 1) throw new RelayError("conflict");
      const receiptId = randomUUID();
      this.run("INSERT INTO receipts(message_id,receipt_id,digest,sender,sender_generation,recipient,recipient_generation,expires,state,digest_version) VALUES(?,?,?,?,?,?,?,?,'pending',2)",
        e.messageId, receiptId, hash, e.senderId, e.senderGeneration, e.recipientId, e.recipientGeneration, e.expiresAt);
      const cursor = Number(this.one("SELECT cursor FROM receipts WHERE message_id=?", e.messageId)!.cursor);
      this.run("INSERT INTO queue VALUES(?,?)", cursor, JSON.stringify(e));
      this.run("INSERT INTO sequences VALUES(?,?) ON CONFLICT(stream) DO UPDATE SET last_sequence=excluded.last_sequence", stream, e.sequence);
      return { receiptId, cursor };
    });
  }
  /** Each poll nonce is single-use; retry offline delivery with a fresh signed nonce and the same cursor. */
  poll(value: unknown): { deliveries: Delivery[]; cursor: number } {
    const c = control(value); if (c.kind !== "poll") throw new RelayError("invalid_input");
    return this.transaction(() => {
      const identity = this.authorize(c), hash = this.controlDigest(c);
      if (this.priorControl(c)) throw new RelayError("conflict");
      this.controlTime(c.issuedAt); this.controlQuota("poll", identity);
      const rows = this.#db.prepare(`SELECT r.cursor,r.receipt_id,q.envelope FROM receipts r JOIN queue q USING(cursor)
        JOIN pins s ON s.device=r.sender AND s.generation=r.sender_generation AND s.revoked=0
        WHERE r.recipient=? AND r.recipient_generation=? AND r.state='pending' AND r.expires>? AND r.cursor>? ORDER BY r.cursor LIMIT ?`)
        .all(identity.deviceId, identity.generation, this.now(), c.after, c.limit) as Row[];
      const deliveries = rows.map(r => ({ cursor: Number(r.cursor), receiptId: String(r.receipt_id), envelope: envelope(JSON.parse(String(r.envelope))) }));
      this.run("INSERT INTO controls VALUES(?,?,?,?,?,?,?)", identity.deviceId, identity.generation, c.requestId, hash, c.kind, randomUUID(), c.issuedAt);
      return { deliveries, cursor: deliveries.at(-1)?.cursor ?? c.after };
    });
  }
  ack(value: unknown): { receiptId: string } {
    const c = control(value); if (c.kind !== "ack") throw new RelayError("invalid_input");
    return this.transaction(() => {
      const identity = this.authorize(c), hash = this.controlDigest(c);
      this.controlTime(c.issuedAt);
      const old = this.priorControl(c);
      if (old) {
        const expected = String(old.digest).startsWith("v2:") ? hash : createHash("sha256").update(controlBytes(c)).update(bytes(c.signature,64,64)).digest("hex");
        if (old.digest !== expected || old.kind !== "ack") throw new RelayError("conflict");
        return { receiptId: String(old.receipt_id) };
      }
      this.controlQuota("ack", identity);
      for (const item of c.messages) {
        const row = this.one("SELECT * FROM receipts WHERE message_id=?", item.messageId);
        if (!row || row.receipt_id !== item.receiptId || row.recipient !== identity.deviceId || row.recipient_generation !== identity.generation
          || !["pending", "acked", "expired", "stale"].includes(String(row.state))) throw new RelayError("forbidden");
        this.run("UPDATE receipts SET state='acked' WHERE message_id=? AND state='pending'", item.messageId);
        this.run("DELETE FROM queue WHERE cursor=?", Number(row.cursor));
      }
      const receiptId = randomUUID(); this.run("INSERT INTO controls VALUES(?,?,?,?,?,?,?)", identity.deviceId, identity.generation, c.requestId, hash, c.kind, receiptId, c.issuedAt); return { receiptId };
    });
  }
  /** Bounded owner maintenance removes ciphertext; transactions also prune out-of-window controls while preserving the durable time floor and message markers. */
  cleanup(limit = 100): number {
    integer(limit, 1, 1000);
    return this.transaction(() => {
      const rows = this.#db.prepare("SELECT r.cursor FROM receipts r JOIN queue q USING(cursor) WHERE r.state!='pending' OR r.expires<=? ORDER BY r.cursor LIMIT ?").all(this.now(), limit) as Row[];
      for (const r of rows) {
        this.run("UPDATE receipts SET state='expired' WHERE cursor=? AND state='pending'", Number(r.cursor));
        this.run("DELETE FROM queue WHERE cursor=?", Number(r.cursor));
      }
      return rows.length;
    });
  }
  close(): void {
    if (this.#closed) return;
    try { this.transaction(() => { this.run("DELETE FROM lease WHERE token=?", this.#token); }); }
    finally { this.#closed = true; this.#db.close(); this.#writerLock.close(); }
  }
  private currentPin(deviceId: string): DevicePin {
    const row = this.one("SELECT * FROM pins WHERE device=?", deviceId);
    if (!row || row.revoked !== 0) throw new RelayError("forbidden");
    return { ownerId: this.#owner, installationId: this.#installation, deviceId, generation: Number(row.generation), keyId: String(row.key_id),
      signingPublicKey: String(row.signing), encryptionPublicKey: String(row.encryption) };
  }
  private authorize(c: ReturnType<typeof control>): DevicePin {
    const p = this.currentPin(c.deviceId);
    if (c.ownerId !== this.#owner || c.installationId !== this.#installation || c.generation !== p.generation || c.keyId !== p.keyId
      || !verify(null, controlBytes(c), publicKey(p.signingPublicKey, "ed25519"), bytes(c.signature, 64, 64))) throw new RelayError("forbidden");
    return p;
  }
  private controlDigest(c: ReturnType<typeof control>): string { return "v2:" + createHash("sha256").update(controlBytes(c)).digest("hex"); }
  private now(): number { if (this.#instant === null) throw new RelayError("unavailable"); return this.#instant; }
  private controlTime(time: number): void { if (Math.abs(this.now() - time) > 30_000) throw new RelayError("expired"); }
  /** Read-only operator policy; message and ciphertext caps keep their original meanings. */
  controlPolicy(): { devices: number; pollPerGeneration: number; ackReservePerGeneration: number; globalControls: number } {
    const pollPerGeneration = Math.floor(Math.max(this.#markerLimit, 64) / 64);
    const ackReservePerGeneration = Math.floor(Math.max(this.#pendingLimit, 64) / 64);
    return { devices: 64, pollPerGeneration, ackReservePerGeneration, globalControls: 64 * (pollPerGeneration + ackReservePerGeneration) };
  }
  /** Trusted owner inspection, usable even when wall time needs confirmation. Never returns ciphertext. */
  status(): { timeFloor: number; messages: number; pending: number; controls: number; legacyControls: number } {
    return this.transaction(() => {
      this.assertToken();
      return { timeFloor: Number(this.one("SELECT time_floor FROM identity WHERE id=1")!.time_floor),
        messages: Number(this.one("SELECT COUNT(*) AS n FROM receipts")!.n), pending: Number(this.one("SELECT COUNT(*) AS n FROM queue")!.n),
        controls: Number(this.one("SELECT COUNT(*) AS n FROM controls WHERE device!=''")!.n),
        legacyControls: Number(this.one("SELECT COUNT(*) AS n FROM controls WHERE device=''")!.n) };
    }, false);
  }
  /** Explicit trusted owner CAS confirmation after long downtime; never decreases or resets replay history. */
  acknowledgeClockAdvance(expectedFloor: number, observedWallClock: number): void {
    integer(expectedFloor); integer(observedWallClock);
    this.transaction(() => {
      this.assertToken();
      if (Number(this.one("SELECT time_floor FROM identity WHERE id=1")!.time_floor) !== expectedFloor || this.#clock() !== observedWallClock) throw new RelayError("conflict");
      if (observedWallClock <= expectedFloor) throw new RelayError("invalid_input");
      this.run("UPDATE identity SET time_floor=? WHERE id=1", observedWallClock);
    }, false);
    this.#anchorFloor = observedWallClock; this.#anchorMonotonic = this.monotonic();
  }
  /** Bounded owner compaction ONLY when old envelopes can never authenticate current public pins again.
   * A still-current recipient keeps its exact receipt until ACK_RETENTION_MS after expiry, so its ACK batches stay live. */
  compactRetiredGenerations(limit = 100): number {
    integer(limit, 1, 1000);
    return this.transaction(() => {
      const rows = this.#db.prepare(`SELECT r.* FROM receipts r WHERE
        NOT EXISTS(SELECT 1 FROM pins p WHERE p.device=r.recipient AND p.generation=r.recipient_generation AND p.revoked=0)
        OR (NOT EXISTS(SELECT 1 FROM pins p WHERE p.device=r.sender AND p.generation=r.sender_generation AND p.revoked=0) AND r.expires<=?)
        ORDER BY r.cursor LIMIT ?`).all(this.now() - ACK_RETENTION_MS, limit) as Row[];
      for (const r of rows) {
        this.run("DELETE FROM queue WHERE cursor=?", Number(r.cursor));
        this.run("DELETE FROM receipts WHERE cursor=?", Number(r.cursor));
        this.run("DELETE FROM sequences WHERE stream=?", JSON.stringify([r.sender, r.sender_generation, r.recipient, r.recipient_generation]));
      }
      return rows.length;
    });
  }
  private priorControl(c: ReturnType<typeof control>): Row | undefined {
    return this.one("SELECT * FROM controls WHERE request_id=? AND ((device=? AND generation=?) OR (device='' AND generation=0)) ORDER BY device LIMIT 1", c.requestId, c.deviceId, c.generation);
  }
  private controlQuota(kind: "poll" | "ack", principal: DevicePin): void {
    const policy = this.controlPolicy(), cap = policy.pollPerGeneration + (kind === "ack" ? policy.ackReservePerGeneration : 0);
    if (Number(this.one("SELECT COUNT(*) AS n FROM controls WHERE device=? AND generation=?", principal.deviceId, principal.generation)!.n) >= cap
      || Number(this.one("SELECT COUNT(*) AS n FROM controls WHERE device!=''")!.n) >= policy.globalControls) throw new RelayError("quota");
  }
  private assertToken(): void { if (this.one("SELECT token FROM lease WHERE id=1")?.token !== this.#token) throw new RelayError("host_locked"); }
  private monotonic(): number { const time = this.#monotonic(); if (!Number.isFinite(time) || time < 0) throw new RelayError("unavailable"); return time; }
  private one(sql: string, ...params: SQLInputValue[]): Row | undefined { return this.#db.prepare(sql).get(...params) as Row | undefined; }
  private run(sql: string, ...params: SQLInputValue[]): void { this.#db.prepare(sql).run(...params); }
  private transaction<T>(fn: () => T, fenced = true): T {
    if (this.#closed) throw new RelayError("host_locked");
    try {
      privatePaths(this.#dir, this.#path);
      this.#db.exec("BEGIN IMMEDIATE");
      if (fenced) this.assertToken();
      if (fenced) {
        const clock = this.#clock(); integer(clock);
        const floor = Number(this.one("SELECT time_floor FROM identity WHERE id=1")!.time_floor), monotonic = this.monotonic();
        if (monotonic < this.#anchorMonotonic) throw new RelayError("unavailable");
        if (clock > this.#anchorFloor + (monotonic - this.#anchorMonotonic) + 300_000) throw new RelayError("clock_untrusted");
        this.#instant = Math.max(clock, floor);
        this.run("UPDATE identity SET time_floor=? WHERE id=1", this.#instant);
        this.run("DELETE FROM controls WHERE rowid IN (SELECT rowid FROM controls WHERE issued_at<? OR (device!='' AND NOT EXISTS(SELECT 1 FROM pins p WHERE p.device=controls.device AND p.generation=controls.generation AND p.revoked=0)) ORDER BY issued_at LIMIT 1000)", this.#instant - 30_000);
      }
      this.#db.exec("SAVEPOINT operation");
      let result: T;
      try { result = fn(); }
      catch (e) {
        this.#db.exec("ROLLBACK TO operation; RELEASE operation; COMMIT");
        throw e;
      }
      this.#db.exec("RELEASE operation; COMMIT"); privatePaths(this.#dir, this.#path); return result;
    } catch (e) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw e instanceof RelayError ? e : new RelayError("unavailable");
    } finally { this.#instant = null; }
  }
}
