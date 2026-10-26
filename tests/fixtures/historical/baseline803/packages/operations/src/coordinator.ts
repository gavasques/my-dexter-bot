import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, type Json } from "./canonical.js";
import { OperationsError, fail } from "./errors.js";
import { entry } from "./files.js";

/**
 * Local trusted authority coordinator: an owner-private SQLite file OUTSIDE every data directory (so it is never part
 * of a snapshot) that records, per installation, the current epoch and directory, every transfer checkpoint and every
 * consumed receipt nonce, all through compare-and-set transactions. It pins the owner's Ed25519 public key; activation
 * receipts must be signed by the matching private key, which stays inside the injected owner signer.
 *
 * Boundary: this is anti-replay and ordering for transfers between directories on hosts that share this coordinator.
 * It is not a distributed consensus service, and a same-uid process that rewrites this file or a data directory is
 * outside its model. Remote authority transfer needs a coordinator reachable from both hosts and is an external gate.
 */
export const COORDINATOR_FILE = "authority-coordinator.sqlite";
export const RECEIPT_PURPOSE = "dexter.g8.activation-receipt";
const SCHEMA = `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE installations (installation_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, epoch INTEGER NOT NULL CHECK (epoch >= 1),
  state TEXT NOT NULL CHECK (state IN ('active', 'transferring')), directory TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE checkpoints (checkpoint_id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES installations(installation_id),
  epoch INTEGER NOT NULL, source_directory TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'captured', 'revoked', 'activating', 'activated', 'aborted')),
  artifact_sha256 TEXT, manifest_sha256 TEXT, destination TEXT, target_sha256 TEXT, receipt_sha256 TEXT, activated_at INTEGER,
  destination_ino TEXT, attempt_token TEXT, attempt_pid INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE UNIQUE INDEX one_open_checkpoint ON checkpoints (installation_id) WHERE state IN ('prepared', 'captured', 'revoked', 'activating');
CREATE TABLE nonces (nonce TEXT PRIMARY KEY, checkpoint_id TEXT NOT NULL REFERENCES checkpoints(checkpoint_id), receipt_sha256 TEXT NOT NULL,
  consumed_at INTEGER NOT NULL) STRICT;
CREATE TABLE history (seq INTEGER PRIMARY KEY AUTOINCREMENT, installation_id TEXT NOT NULL, checkpoint_id TEXT, event TEXT NOT NULL,
  epoch INTEGER NOT NULL, at INTEGER NOT NULL) STRICT;
CREATE TABLE stagings (staging_id TEXT PRIMARY KEY, checkpoint_id TEXT NOT NULL REFERENCES checkpoints(checkpoint_id),
  purpose TEXT NOT NULL CHECK (purpose IN ('capture', 'activation')), parent TEXT NOT NULL, name TEXT NOT NULL, ino TEXT,
  pid INTEGER NOT NULL, receipt_sha256 TEXT, state TEXT NOT NULL CHECK (state IN ('reserved', 'removed')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (parent, name)) STRICT;`;
/** Coordinator schema. 2 adds durable staging ownership; a schema-1 file (never released) is refused. */
export const COORDINATOR_SCHEMA = 2;
const HEX64 = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{64}$/;
const CHECKPOINT_ID = /^ckp_[A-Za-z0-9_-]{16,64}$/;
const STAGING_ID = /^stg_[A-Za-z0-9_-]{24}$/;
type Row = Record<string, unknown>;

/** Owner signer injected through the trusted local boundary. The private key never leaves it. */
export interface OwnerAuthority {
  readonly publicKey: KeyObject;
  sign(message: Buffer): Buffer;
}
/** Persisted authority of a store as reported by `HostStore.authorityStatus()` (structural). */
export interface AuthorityView {
  installationId: string; ownerId: string; epoch: number; state: "active" | "checkpointed" | "revoked"; directory: string; checkpointId: string | null;
}
export interface ActivationReceiptBody {
  v: 1; purpose: typeof RECEIPT_PURPOSE; coordinatorId: string; installationId: string; ownerId: string;
  sourceEpoch: number; checkpointId: string; sourceDirectory: string; artifactSha256: string; manifestSha256: string;
  destination: string; targetSha256: string; issuedAt: number; expiresAt: number; nonce: string;
}
export interface ActivationReceipt { body: ActivationReceiptBody; signature: string }
/** A private plaintext staging directory reserved by name (and inode once created) before anything is written into it. */
export interface StagingRecord {
  stagingId: string; checkpointId: string; purpose: "capture" | "activation"; parent: string; name: string; ino: string | null;
  pid: number; receiptSha256: string | null; state: "reserved" | "removed";
}
export interface CheckpointRecord {
  checkpointId: string; installationId: string; epoch: number; sourceDirectory: string; state: string;
  artifactSha256: string | null; manifestSha256: string | null; destination: string | null; targetSha256: string | null;
  receiptSha256: string | null; activatedAt: number | null; destinationIno: string | null;
}

const receiptMessage = (body: ActivationReceiptBody): Buffer => Buffer.from(`${RECEIPT_PURPOSE}\n${canonicalJson(body as unknown as Json)}`, "utf8");
export const receiptSha256 = (receipt: ActivationReceipt): string =>
  createHash("sha256").update(canonicalJson({ body: receipt.body as unknown as Json, signature: receipt.signature })).digest("hex");
/** Transfer target: the trusted coordinator plus the canonical destination directory. */
export const targetSha256 = (coordinatorId: string, destination: string): string =>
  createHash("sha256").update(canonicalJson({ coordinatorId, destination })).digest("hex");

function canonicalDirectory(path: unknown): string {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path.includes("\0") || path.length > 1024) fail("unsafe_path", "path must be absolute and normalized");
  return path as string;
}
/** A destination that may not exist yet: its parent must be a real directory reached without symlinks. */
export function canonicalDestination(path: unknown): string {
  const target = canonicalDirectory(path);
  let parent: string;
  try { parent = realpathSync(dirname(target)); } catch (error) { throw new OperationsError("unsafe_path", "destination parent is unavailable", { cause: error }); }
  if (parent !== dirname(target) || !entry(parent)?.isDirectory()) fail("unsafe_path", "destination parent must be a real directory");
  return target;
}
const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
const ed25519 = (key: KeyObject): KeyObject => {
  if (!key || key.type !== "public" || key.asymmetricKeyType !== "ed25519") fail("invalid_input", "owner key must be an Ed25519 public key");
  return key;
};

export class AuthorityCoordinator {
  readonly directory: string;
  readonly coordinatorId: string;
  readonly ownerId: string;
  readonly #db: DatabaseSync;
  readonly #ownerKey: KeyObject;
  #closed = false;

  private constructor(directory: string, db: DatabaseSync, coordinatorId: string, ownerId: string, ownerKey: KeyObject) {
    this.directory = directory; this.#db = db; this.coordinatorId = coordinatorId; this.ownerId = ownerId; this.#ownerKey = ownerKey;
  }

  /**
   * Opens (or, with `init`, creates) the coordinator in an owner-private directory (0700, owned by this uid, no
   * symlink). An existing coordinator must pin exactly the given owner key when `init` is passed again.
   */
  static open(directory: string, init?: { ownerId: string; ownerPublicKey: KeyObject }): AuthorityCoordinator {
    const root = canonicalDirectory(directory);
    if (!entry(root)) { if (!init) fail("authority_unavailable", "coordinator does not exist"); mkdirSync(root, { mode: 0o700 }); }
    const stat = lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || realpathSync(root) !== root) {
      fail("unsafe_path", "coordinator directory must be private");
    }
    const path = join(root, COORDINATOR_FILE);
    const existed = entry(path) !== undefined;
    if (!existed && !init) fail("authority_unavailable", "coordinator does not exist");
    if (existed && (entry(path)!.isSymbolicLink() || !entry(path)!.isFile())) fail("unsafe_path", "coordinator file is not regular");
    const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5_000 });
    try {
      chmodSync(path, 0o600);
      db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!existed) {
          db.exec(SCHEMA);
          const put = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
          put.run("schema", String(COORDINATOR_SCHEMA)); put.run("coordinator_id", `coord_${randomBytes(16).toString("hex")}`);
          put.run("owner_id", init!.ownerId);
          put.run("owner_public_key", ed25519(init!.ownerPublicKey).export({ format: "der", type: "spki" }).toString("hex"));
        }
        const meta = new Map((db.prepare("SELECT key, value FROM meta").all() as Row[]).map((row) => [String(row.key), String(row.value)]));
        if ([...meta.keys()].sort().join(",") !== "coordinator_id,owner_id,owner_public_key,schema" || meta.get("schema") !== String(COORDINATOR_SCHEMA)) fail("unsupported_schema", "coordinator schema is unsupported");
        const key = createPublicKey({ key: Buffer.from(meta.get("owner_public_key")!, "hex"), format: "der", type: "spki" });
        if (init && (init.ownerId !== meta.get("owner_id") || !ed25519(init.ownerPublicKey).equals(key))) fail("identity_mismatch", "coordinator pins another owner");
        db.exec("COMMIT");
        return new AuthorityCoordinator(root, db, meta.get("coordinator_id")!, meta.get("owner_id")!, ed25519(key));
      } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    } catch (error) { db.close(); throw error; }
  }

  close(): void { if (!this.#closed) { this.#closed = true; this.#db.close(); } }

  #tx<T>(fn: () => T): T {
    if (this.#closed) fail("authority_unavailable", "coordinator is closed");
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.#db.exec("COMMIT"); return result; }
    catch (error) { if (this.#db.isTransaction) this.#db.exec("ROLLBACK"); throw error; }
  }
  #one(sql: string, ...args: Array<string | number | null>): Row | undefined { return this.#db.prepare(sql).get(...args) as Row | undefined; }
  #history(installation: string, checkpoint: string | null, event: string, epoch: number, at: number): void {
    this.#db.prepare("INSERT INTO history (installation_id, checkpoint_id, event, epoch, at) VALUES (?, ?, ?, ?, ?)").run(installation, checkpoint, event, epoch, at);
  }
  #checkpoint(checkpointId: string): Row {
    if (!CHECKPOINT_ID.test(checkpointId)) fail("invalid_input", "checkpoint id is not valid");
    const row = this.#one("SELECT * FROM checkpoints WHERE checkpoint_id = ?", checkpointId);
    if (!row) return fail("authority_unavailable", "checkpoint is unknown to the coordinator");
    return row;
  }
  /** The coordinator file must never live inside a data directory it governs (it would be snapshotted and copied). */
  assertOutside(directory: string): void {
    if (inside(this.directory, directory) || inside(directory, this.directory)) fail("unsafe_path", "coordinator and data directory overlap");
  }

  /** Owner-local enrollment of an installation at its current authority. Never lowers or forks a known epoch. */
  enroll(view: AuthorityView, now: number): void {
    this.assertOutside(view.directory);
    if (view.ownerId !== this.ownerId) fail("identity_mismatch", "installation belongs to another owner");
    this.#tx(() => {
      const row = this.#one("SELECT * FROM installations WHERE installation_id = ?", view.installationId);
      if (row) {
        if (Number(row.epoch) !== view.epoch || row.directory !== view.directory || row.state !== "active" || view.state !== "active") fail("authority_unavailable", "installation authority disagrees with the coordinator");
        return;
      }
      if (view.state !== "active") fail("authority_unavailable", "only an active authority can be enrolled");
      this.#db.prepare("INSERT INTO installations (installation_id, owner_id, epoch, state, directory, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
        .run(view.installationId, view.ownerId, view.epoch, view.directory, now);
      this.#history(view.installationId, null, "enrolled", view.epoch, now);
    });
  }

  /** CAS: the installation is active at exactly this epoch and directory; one open checkpoint per installation. */
  beginCheckpoint(view: AuthorityView, checkpointId: string, now: number): void {
    if (!CHECKPOINT_ID.test(checkpointId)) fail("invalid_input", "checkpoint id is not valid");
    this.#tx(() => {
      const row = this.#one("SELECT * FROM installations WHERE installation_id = ?", view.installationId);
      if (!row || row.owner_id !== view.ownerId || Number(row.epoch) !== view.epoch || row.directory !== view.directory || row.state !== "active" || view.state !== "active") {
        fail("authority_unavailable", "installation is not the active authority the coordinator knows");
      }
      this.#db.prepare("UPDATE installations SET state = 'transferring', updated_at = ? WHERE installation_id = ? AND state = 'active' AND epoch = ?").run(now, view.installationId, view.epoch);
      this.#db.prepare(`INSERT INTO checkpoints (checkpoint_id, installation_id, epoch, source_directory, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'prepared', ?, ?)`).run(checkpointId, view.installationId, view.epoch, view.directory, now, now);
      this.#history(view.installationId, checkpointId, "checkpoint_prepared", view.epoch, now);
    });
  }

  /** The store never entered the checkpoint (for example the drain was incomplete): back to active, same epoch. */
  cancelUnstarted(checkpointId: string, view: AuthorityView, now: number): void {
    this.#tx(() => {
      const row = this.#checkpoint(checkpointId);
      if (row.state !== "prepared" || view.state !== "active" || view.epoch !== Number(row.epoch) || view.installationId !== row.installation_id) {
        fail("authority_unavailable", "checkpoint already started; abort it explicitly");
      }
      this.#db.prepare("UPDATE checkpoints SET state = 'aborted', updated_at = ? WHERE checkpoint_id = ?").run(now, checkpointId);
      this.#db.prepare("UPDATE installations SET state = 'active', updated_at = ? WHERE installation_id = ? AND epoch = ?").run(now, view.installationId, view.epoch);
      this.#history(view.installationId, checkpointId, "checkpoint_cancelled", view.epoch, now);
    });
  }

  recordCaptured(checkpointId: string, artifactSha256: string, manifestSha256: string, now: number): void {
    if (!HEX64.test(artifactSha256) || !HEX64.test(manifestSha256)) fail("invalid_input", "digest is not valid");
    this.#tx(() => {
      const row = this.#checkpoint(checkpointId);
      if (row.state === "captured" && row.artifact_sha256 === artifactSha256 && row.manifest_sha256 === manifestSha256) return;
      if (row.state !== "prepared") fail("authority_unavailable", "checkpoint is not awaiting its artifact");
      this.#db.prepare("UPDATE checkpoints SET state = 'captured', artifact_sha256 = ?, manifest_sha256 = ?, updated_at = ? WHERE checkpoint_id = ? AND state = 'prepared'")
        .run(artifactSha256, manifestSha256, now, checkpointId);
      this.#history(String(row.installation_id), checkpointId, "checkpoint_captured", Number(row.epoch), now);
    });
  }

  /** Target binding for the source revocation and the receipt. The destination is fixed before revocation. */
  target(checkpointId: string, destination: string): string {
    const row = this.#checkpoint(checkpointId);
    const canonical = canonicalDestination(destination);
    this.assertOutside(canonical);
    if (canonical === row.source_directory || inside(canonical, String(row.source_directory)) || inside(String(row.source_directory), canonical)) {
      fail("unsafe_path", "destination overlaps the source directory");
    }
    return targetSha256(this.coordinatorId, canonical);
  }

  /**
   * Records the persisted source revocation, read back from the source database by the caller, only when it is
   * exactly this checkpoint, artifact and target. Idempotent.
   */
  recordRevoked(checkpointId: string, destination: string, source: { state: string; checkpointId: string | null; epoch: number; revokedArtifact: string | null; revokedTarget: string | null }, now: number): void {
    const target = this.target(checkpointId, destination);
    this.#tx(() => {
      const row = this.#checkpoint(checkpointId);
      if (source.state !== "revoked" || source.checkpointId !== checkpointId || source.epoch !== Number(row.epoch)
        || source.revokedArtifact !== row.artifact_sha256 || source.revokedTarget !== target) fail("authority_unavailable", "source revocation is not persisted for this checkpoint");
      if (row.state === "revoked" && row.target_sha256 === target) return;
      if (row.state !== "captured") fail("authority_unavailable", "checkpoint is not captured");
      this.#db.prepare("UPDATE checkpoints SET state = 'revoked', destination = ?, target_sha256 = ?, updated_at = ? WHERE checkpoint_id = ? AND state = 'captured'")
        .run(canonicalDestination(destination), target, now, checkpointId);
      this.#history(String(row.installation_id), checkpointId, "source_revoked", Number(row.epoch), now);
    });
  }

  /** Unsigned receipt body for the owner to sign. Only a revoked checkpoint can be receipted. */
  receiptBody(checkpointId: string, now: number, ttlMs: number): ActivationReceiptBody {
    const row = this.#checkpoint(checkpointId);
    if (row.state !== "revoked" || row.destination === null) fail("authority_unavailable", "source revocation is not recorded");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60_000) fail("invalid_input", "receipt lifetime is out of range");
    return {
      v: 1, purpose: RECEIPT_PURPOSE, coordinatorId: this.coordinatorId, installationId: String(row.installation_id), ownerId: this.ownerId,
      sourceEpoch: Number(row.epoch), checkpointId, sourceDirectory: String(row.source_directory), artifactSha256: String(row.artifact_sha256),
      manifestSha256: String(row.manifest_sha256), destination: String(row.destination), targetSha256: String(row.target_sha256),
      issuedAt: now, expiresAt: now + ttlMs, nonce: randomBytes(32).toString("hex"),
    };
  }

  /**
   * Verifies an activation receipt (pinned owner key, every binding, expiry) and consumes its nonce, moving the
   * checkpoint to `activating` under a fresh attempt token. A lost response is retried with the SAME receipt: the
   * nonce is already bound to it, and the attempt is taken over only when the previous attempt's process is gone.
   * Any other receipt for a checkpoint already activating or activated, a reused nonce, or a stale/aborted checkpoint
   * is refused.
   */
  /** Signature, shape and owner/coordinator of a receipt (no state read). */
  #authenticReceipt(receipt: ActivationReceipt): { body: ActivationReceiptBody; hash: string } {
    const body = receipt?.body;
    if (!body || typeof receipt.signature !== "string" || body.v !== 1 || body.purpose !== RECEIPT_PURPOSE || !NONCE.test(String(body.nonce))) fail("authentication_failed", "receipt is not valid");
    const keys = "artifactSha256,checkpointId,coordinatorId,destination,expiresAt,installationId,issuedAt,manifestSha256,nonce,ownerId,purpose,sourceDirectory,sourceEpoch,targetSha256,v";
    if (Object.keys(body).sort().join(",") !== keys) fail("authentication_failed", "receipt is not valid");
    let signature: Buffer;
    try { signature = Buffer.from(receipt.signature, "base64url"); } catch { return fail("authentication_failed", "receipt signature is not valid"); }
    if (signature.length !== 64 || !verify(null, receiptMessage(body), this.#ownerKey, signature)) fail("authentication_failed", "receipt is not signed by the owner");
    if (body.coordinatorId !== this.coordinatorId || body.ownerId !== this.ownerId) fail("authentication_failed", "receipt is for another coordinator or owner");
    return { body, hash: receiptSha256(receipt) };
  }
  /**
   * Every check of `consumeReceipt` against the recorded state, inside the caller's transaction. Returns whether the
   * receipt is the one already bound to an activating/activated checkpoint (a resume) or a fresh, unconsumed one.
   */
  #admitReceipt(body: ActivationReceiptBody, hash: string, now: number): { row: Row; resume: boolean } {
    const row = this.#checkpoint(String(body.checkpointId));
    const installation = this.#one("SELECT * FROM installations WHERE installation_id = ?", String(row.installation_id))!;
    if (body.installationId !== row.installation_id || body.sourceEpoch !== Number(row.epoch) || body.sourceDirectory !== row.source_directory
      || body.artifactSha256 !== row.artifact_sha256 || body.manifestSha256 !== row.manifest_sha256 || body.destination !== row.destination
      || body.targetSha256 !== row.target_sha256 || body.targetSha256 !== targetSha256(this.coordinatorId, body.destination)) {
      fail("authentication_failed", "receipt does not match the recorded checkpoint");
    }
    const used = this.#one("SELECT * FROM nonces WHERE nonce = ?", body.nonce);
    if (used && used.receipt_sha256 !== hash) fail("authentication_failed", "receipt nonce was already used");
    if (row.state === "activating" || row.state === "activated") {
      if (!used || row.receipt_sha256 !== hash) fail("authentication_failed", "checkpoint was already activated by another receipt");
      if (row.state === "activating" && row.attempt_pid !== null && Number(row.attempt_pid) !== process.pid && pidAlive(Number(row.attempt_pid))) {
        fail("destination_exists", "another activation attempt is still running");
      }
      return { row, resume: true };
    }
    if (row.state !== "revoked" || installation.state !== "transferring" || Number(installation.epoch) !== Number(row.epoch)) fail("authority_unavailable", "checkpoint cannot be activated");
    if (!(now >= body.issuedAt && now < body.expiresAt)) fail("authentication_failed", "receipt is expired or not yet valid");
    return { row, resume: false };
  }

  /**
   * Read-only admission of an activation receipt: exactly the checks `consumeReceipt` makes, without consuming the
   * nonce or touching any state, so an activation can stage and validate everything before the irreversible step.
   */
  verifyReceipt(receipt: ActivationReceipt, now: number): { checkpoint: CheckpointRecord; resume: boolean; receiptSha256: string } {
    const { body, hash } = this.#authenticReceipt(receipt);
    if (this.#closed) fail("authority_unavailable", "coordinator is closed");
    const { row, resume } = this.#admitReceipt(body, hash, now);
    return { checkpoint: record(row), resume, receiptSha256: hash };
  }

  /**
   * Verifies an activation receipt (pinned owner key, every binding, expiry) and consumes its nonce, moving the
   * checkpoint to `activating` under a fresh attempt token. A lost response is retried with the SAME receipt: the
   * nonce is already bound to it, and the attempt is taken over only when the previous attempt's process is gone.
   * Any other receipt for a checkpoint already activating or activated, a reused nonce, or a stale/aborted checkpoint
   * is refused.
   */
  consumeReceipt(receipt: ActivationReceipt, now: number): { checkpoint: CheckpointRecord; attemptToken: string; resumed: boolean } {
    const { body, hash } = this.#authenticReceipt(receipt);
    const token = randomBytes(24).toString("hex");
    return this.#tx(() => {
      const { row, resume } = this.#admitReceipt(body, hash, now);
      if (resume) {
        if (row.state === "activating") this.#db.prepare("UPDATE checkpoints SET attempt_token = ?, attempt_pid = ?, updated_at = ? WHERE checkpoint_id = ?").run(token, process.pid, now, body.checkpointId);
        return { checkpoint: record(this.#checkpoint(body.checkpointId)), attemptToken: token, resumed: true };
      }
      this.#db.prepare("INSERT INTO nonces (nonce, checkpoint_id, receipt_sha256, consumed_at) VALUES (?, ?, ?, ?)").run(body.nonce, body.checkpointId, hash, now);
      this.#db.prepare(`UPDATE checkpoints SET state = 'activating', receipt_sha256 = ?, activated_at = ?, attempt_token = ?, attempt_pid = ?, updated_at = ?
        WHERE checkpoint_id = ? AND state = 'revoked'`).run(hash, now, token, process.pid, now, body.checkpointId);
      this.#history(String(row.installation_id), body.checkpointId, "receipt_consumed", Number(row.epoch), now);
      return { checkpoint: record(this.#checkpoint(body.checkpointId)), attemptToken: token, resumed: false };
    });
  }

  // ---- staging ownership ----------------------------------------------------------------------------------------

  /**
   * Durably reserves a private staging directory name for this process BEFORE it is created or any plaintext is
   * written into it: capture staging only while the checkpoint is prepared, activation staging only for the exact
   * receipt admitted for the checkpoint. The name carries the random staging id, so it is never derived from (or
   * matched by) a pattern.
   */
  reserveStaging(checkpointId: string, purpose: "capture" | "activation", parent: string, label: string, receiptSha: string | null, now: number): StagingRecord {
    const root = canonicalDirectory(parent);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(label)) fail("unsafe_path", "staging label is not valid");
    if ((purpose === "activation") !== (receiptSha !== null) || (receiptSha !== null && !HEX64.test(receiptSha))) fail("invalid_input", "staging binding is not valid");
    if (inside(root, this.directory)) fail("unsafe_path", "staging must not live inside the coordinator directory");
    const stagingId = `stg_${randomBytes(18).toString("base64url")}`;
    const name = `.${label}.${purpose === "capture" ? "checkpoint" : "activation"}-${stagingId}`;
    return this.#tx(() => {
      const row = this.#checkpoint(checkpointId);
      const ok = purpose === "capture" ? row.state === "prepared"
        : (row.state === "revoked" || (row.state === "activating" && row.receipt_sha256 === receiptSha));
      if (!ok) fail("authority_unavailable", "checkpoint cannot stage now");
      this.#db.prepare(`INSERT INTO stagings (staging_id, checkpoint_id, purpose, parent, name, ino, pid, receipt_sha256, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'reserved', ?, ?)`).run(stagingId, checkpointId, purpose, root, name, process.pid, receiptSha, now, now);
      return stagingRecord(this.#one("SELECT * FROM stagings WHERE staging_id = ?", stagingId)!);
    });
  }
  /** Records the inode of the staging directory this process just created (create-only `mkdir`). */
  recordStagingCreated(stagingId: string, ino: string, now: number): void {
    if (!/^[0-9]{1,24}$/.test(ino)) fail("invalid_input", "inode is not valid");
    this.#tx(() => {
      const row = this.#staging(stagingId);
      if (row.state !== "reserved" || Number(row.pid) !== process.pid || (row.ino !== null && row.ino !== ino)) fail("authority_unavailable", "staging is not reserved by this process");
      this.#db.prepare("UPDATE stagings SET ino = ?, updated_at = ? WHERE staging_id = ?").run(ino, now, stagingId);
    });
  }
  /** Marks a staging removed; the caller has verified that its path no longer exists. Idempotent. */
  recordStagingRemoved(stagingId: string, now: number): void {
    this.#tx(() => {
      const row = this.#staging(stagingId);
      if (row.state === "removed") return;
      this.#db.prepare("UPDATE stagings SET state = 'removed', updated_at = ? WHERE staging_id = ?").run(now, stagingId);
    });
  }
  staging(stagingId: string): StagingRecord { return stagingRecord(this.#staging(stagingId)); }
  /** Stagings still reserved (created or not), with whether their recorded process is alive. */
  openStagings(): Array<StagingRecord & { processAlive: boolean }> {
    if (this.#closed) fail("authority_unavailable", "coordinator is closed");
    return (this.#db.prepare("SELECT * FROM stagings WHERE state = 'reserved' ORDER BY created_at, staging_id").all() as Row[])
      .map((row) => ({ ...stagingRecord(row), processAlive: Number(row.pid) !== process.pid && pidAlive(Number(row.pid)) }));
  }
  #staging(stagingId: string): Row {
    if (!STAGING_ID.test(String(stagingId))) fail("invalid_input", "staging id is not valid");
    const row = this.#one("SELECT * FROM stagings WHERE staging_id = ?", stagingId);
    if (!row) return fail("authority_unavailable", "staging is unknown to the coordinator");
    return row;
  }

  /** Fenced journal step: records the reserved destination inode for this attempt only. */
  recordDestination(checkpointId: string, attemptToken: string, destinationIno: string, now: number): void {
    this.#tx(() => {
      const row = this.#checkpoint(checkpointId);
      if (row.state !== "activating" || row.attempt_token !== attemptToken) fail("authority_unavailable", "activation attempt was superseded");
      if (row.destination_ino !== null && row.destination_ino !== destinationIno) fail("destination_exists", "destination was replaced since the reservation");
      this.#db.prepare("UPDATE checkpoints SET destination_ino = ?, updated_at = ? WHERE checkpoint_id = ?").run(destinationIno, now, checkpointId);
    });
  }

  /** Final CAS: the destination holds epoch + 1; the installation is active there and the source epoch is closed. */
  recordActivated(checkpointId: string, attemptToken: string | null, view: AuthorityView, now: number): void {
    this.#tx(() => {
      const row = this.#checkpoint(checkpointId);
      if (row.state === "activated") {
        if (view.epoch !== Number(row.epoch) + 1 || view.directory !== row.destination) fail("authority_unavailable", "activation record disagrees");
        return;
      }
      if (row.state !== "activating" || (attemptToken !== null && row.attempt_token !== attemptToken)) fail("authority_unavailable", "activation attempt was superseded");
      if (view.state !== "active" || view.epoch !== Number(row.epoch) + 1 || view.directory !== row.destination || view.installationId !== row.installation_id) {
        fail("authority_unavailable", "destination does not hold the activated authority");
      }
      this.#db.prepare("UPDATE checkpoints SET state = 'activated', attempt_token = NULL, attempt_pid = NULL, updated_at = ? WHERE checkpoint_id = ?").run(now, checkpointId);
      this.#db.prepare("UPDATE installations SET state = 'active', epoch = ?, directory = ?, updated_at = ? WHERE installation_id = ? AND state = 'transferring' AND epoch = ?")
        .run(view.epoch, view.directory, now, view.installationId, Number(row.epoch));
      this.#history(view.installationId, checkpointId, "activated", view.epoch, now);
    });
  }

  /** Owner abort before revocation: the store moved to epoch + 1 (active, same directory); the checkpoint is dead. */
  abort(checkpointId: string, view: AuthorityView, now: number): void {
    this.#tx(() => {
      const row = this.#checkpoint(checkpointId);
      if (row.state === "aborted") return;
      if (row.state !== "prepared" && row.state !== "captured") fail("authority_unavailable", "checkpoint can no longer be aborted");
      if (view.state !== "active" || view.epoch !== Number(row.epoch) + 1 || view.directory !== row.source_directory || view.installationId !== row.installation_id) {
        fail("authority_unavailable", "store was not aborted to the next epoch");
      }
      this.#db.prepare("UPDATE checkpoints SET state = 'aborted', updated_at = ? WHERE checkpoint_id = ?").run(now, checkpointId);
      this.#db.prepare("UPDATE installations SET state = 'active', epoch = ?, updated_at = ? WHERE installation_id = ? AND epoch = ?").run(view.epoch, now, view.installationId, Number(row.epoch));
      this.#history(view.installationId, checkpointId, "checkpoint_aborted", view.epoch, now);
    });
  }

  checkpoint(checkpointId: string): CheckpointRecord { return record(this.#checkpoint(checkpointId)); }
  /** Safe summary: ids, epochs, states and counts. No keys, receipts, signatures or paths. */
  /** Trusted local preflight: prove the opaque signer matches this coordinator before host admission closes. */
  assertOwnerSigner(owner: OwnerAuthority): void {
    if(this.#closed) fail("authority_unavailable","coordinator is closed");
    const challenge=Buffer.concat([Buffer.from("dexter.g8.owner-preflight\n"),randomBytes(32)]);
    try { if(!owner.publicKey.equals(this.#ownerKey) || !verify(null,challenge,this.#ownerKey,owner.sign(challenge))) throw new Error(); }
    catch { fail("authority_unavailable","owner signing custody is unavailable"); }
  }

  status(): {
    coordinatorId: string; installations: Array<{ installationId: string; epoch: number; state: string }>; checkpoints: Record<string, number>;
    openCheckpoints: Array<{ checkpointId: string; installationId: string; epoch: number; state: string }>; noncesConsumed: number;
    openStagings: Array<{ stagingId: string; checkpointId: string; purpose: string; created: boolean; processAlive: boolean }>;
  } {
    if (this.#closed) fail("authority_unavailable", "coordinator is closed");
    const checkpoints: Record<string, number> = {};
    for (const row of this.#db.prepare("SELECT state, COUNT(*) AS n FROM checkpoints GROUP BY state").all() as Row[]) checkpoints[String(row.state)] = Number(row.n);
    return {
      coordinatorId: this.coordinatorId,
      installations: (this.#db.prepare("SELECT installation_id, epoch, state FROM installations ORDER BY installation_id").all() as Row[])
        .map((row) => ({ installationId: String(row.installation_id), epoch: Number(row.epoch), state: String(row.state) })),
      checkpoints,
      openCheckpoints: (this.#db.prepare("SELECT checkpoint_id, installation_id, epoch, state FROM checkpoints WHERE state IN ('prepared', 'captured', 'revoked', 'activating') ORDER BY created_at").all() as Row[])
        .map((row) => ({ checkpointId: String(row.checkpoint_id), installationId: String(row.installation_id), epoch: Number(row.epoch), state: String(row.state) })),
      noncesConsumed: Number((this.#one("SELECT COUNT(*) AS n FROM nonces") ?? { n: 0 }).n),
      openStagings: this.openStagings().map((item) => ({ stagingId: item.stagingId, checkpointId: item.checkpointId, purpose: item.purpose, created: item.ino !== null, processAlive: item.processAlive })),
    };
  }
}

function record(row: Row): CheckpointRecord {
  const s = (key: string): string | null => (row[key] === null ? null : String(row[key]));
  return {
    checkpointId: String(row.checkpoint_id), installationId: String(row.installation_id), epoch: Number(row.epoch), sourceDirectory: String(row.source_directory),
    state: String(row.state), artifactSha256: s("artifact_sha256"), manifestSha256: s("manifest_sha256"), destination: s("destination"),
    targetSha256: s("target_sha256"), receiptSha256: s("receipt_sha256"), activatedAt: row.activated_at === null ? null : Number(row.activated_at),
    destinationIno: s("destination_ino"),
  };
}

function stagingRecord(row: Row): StagingRecord {
  return {
    stagingId: String(row.staging_id), checkpointId: String(row.checkpoint_id), purpose: row.purpose as StagingRecord["purpose"], parent: String(row.parent),
    name: String(row.name), ino: row.ino === null ? null : String(row.ino), pid: Number(row.pid), receiptSha256: row.receipt_sha256 === null ? null : String(row.receipt_sha256),
    state: row.state as StagingRecord["state"],
  };
}

/** The owner signs a receipt body inside the injected signer; the result carries no key material. */
export function signActivationReceipt(owner: OwnerAuthority, body: ActivationReceiptBody): ActivationReceipt {
  const signature = owner.sign(receiptMessage(body));
  if (!Buffer.isBuffer(signature) || signature.length !== 64) fail("authentication_failed", "owner signer returned an invalid signature");
  return { body: { ...body }, signature: signature.toString("base64url") };
}
