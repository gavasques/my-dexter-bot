import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Device } from "@dexter/contracts";
import { HostError, type HostStore } from "@dexter/hub";
import { DeviceError } from "./errors.js";
import { privateDatabasePath, privateDirectory, sealDatabase } from "./files.js";
import { checkCapabilities } from "./operations.js";
import { FINGERPRINT, wireId } from "./wire.js";

export const DEVICES_DATABASE_FILE = "devices.sqlite";
const SCHEMA_VERSION = 2;
const DEFAULT_OFFER_TTL_MS = 10 * 60_000;
const MAX_OFFER_TTL_MS = 60 * 60_000;
const MAX_CODE_ATTEMPTS = 5;
const PAIRING_CODE = /^[A-Za-z0-9_-]{43}$/;

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE offers (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('pair', 'rotate')), device_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'cancelled', 'exhausted')), attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE claims (
  id TEXT PRIMARY KEY, offer_id TEXT NOT NULL UNIQUE REFERENCES offers(id), kind TEXT NOT NULL CHECK (kind IN ('pair', 'rotate')),
  client_fp TEXT NOT NULL, name TEXT NOT NULL, capabilities TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approving', 'approved', 'rejected', 'failed')),
  device_id TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER
) STRICT;
CREATE TABLE device_certs (
  fp TEXT PRIMARY KEY, device_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active', 'retired', 'revoked')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX device_certs_active ON device_certs (device_id) WHERE state = 'active';
CREATE TABLE late_receipts (
  action_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'unknown')), code TEXT, received_at INTEGER NOT NULL
) STRICT;
`;
/**
 * Schema v2: one persistent pin binding per paired device id. `generation` counts the pins ever bound to the
 * device (1 at pairing, +1 per approved rotation); `revision` counts binding changes (pairing, each rotation,
 * the first revocation). Both change only in the same transaction as the certificate they describe, never
 * from a clock or caller input. `fp` is the active pin, or the last bound pin once revoked.
 */
const BINDINGS = `
CREATE TABLE device_bindings (
  device_id TEXT PRIMARY KEY, fp TEXT NOT NULL UNIQUE REFERENCES device_certs(fp),
  generation INTEGER NOT NULL CHECK (generation >= 1), revision INTEGER NOT NULL CHECK (revision >= generation),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked'))
) STRICT;
`;
const V1_TABLES = ["claims", "device_certs", "late_receipts", "meta", "offers"];
const V2_TABLES = [...V1_TABLES, "device_bindings"].sort();
const BINDING_COLUMNS = "device_id,fp,generation,revision,status";

type Row = Record<string, unknown>;
/** Returned from a transaction to commit (attempt counters, expiry) and then raise the refusal. */
class Refusal { constructor(readonly error: DeviceError) {} }
const refused = (): DeviceError => new DeviceError("forbidden", "pairing refused");
const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();
const counter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
/** Next binding counter; overflow is a conflict raised inside the transaction, so nothing commits. */
const next = (value: number): number => {
  if (!Number.isSafeInteger(value + 1)) throw new DeviceError("conflict", "device binding counter exhausted");
  return value + 1;
};

export interface PairingOffer {
  offerId: string;
  /** One-time secret shown once to the owner for out-of-band transfer. Only its hash is stored. */
  code: string;
  kind: "pair" | "rotate";
  deviceId: string | null;
  expiresAt: number;
}
export interface PendingClaim {
  claimId: string;
  kind: "pair" | "rotate";
  deviceId: string | null;
  /** Public SHA-256 pin of the certificate that proved possession during the claim. */
  clientFingerprint: string;
  name: string;
  capabilities: string[];
  expiresAt: number;
}
export type ClaimStatus = "pending" | "approved" | "rejected" | "expired" | "failed";
export interface DeviceCertificate { fingerprint: string; deviceId: string; state: "active" | "retired" | "revoked" }
export interface LateReceipt { actionId: string; deviceId: string; requestHash: string; status: "completed" | "failed" | "unknown"; code: string | null; receivedAt: number }
export interface DeviceRegistryOptions { clock?: () => number; offerTtlMs?: number }
/**
 * Owner-bound pin binding of one paired device, read from this registry and the canonical HostStore device.
 * `status` is `revoked` whenever the HostStore device is revoked, even if the auxiliary revocation of the
 * pins was lost (fenced host between the two writes). Contains a public pin only, no key or pairing material.
 */
export interface DevicePinBinding {
  readonly installationId: string; readonly ownerId: string; readonly deviceId: string;
  readonly fingerprint: string; readonly generation: number; readonly revision: number;
  readonly status: "active" | "revoked";
}

/**
 * Pairing metadata of paired devices for one installation/owner: one-time offers (hash only), claims bound
 * to the certificate presented over mutual TLS, and the active certificate pin of each device. Devices,
 * grants, approvals and actions stay in the hub's HostStore; this file never decides an action outcome.
 *
 * Every mutation (and opening the file) commits inside `HostStore.withWriterLease`, so a fenced or closed
 * host cannot pair, approve, rotate or revoke. Mutations never run network I/O or other HostStore writes
 * inside the fence; approval registers the HostStore device between two fenced steps.
 */
export class DevicePairingRegistry {
  readonly databasePath: string;
  readonly offerTtlMs: number;
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  private closed = false;

  constructor(private readonly store: HostStore, options: DeviceRegistryOptions = {}) {
    this.clock = options.clock ?? (() => store.now());
    this.offerTtlMs = options.offerTtlMs ?? DEFAULT_OFFER_TTL_MS;
    if (!Number.isSafeInteger(this.offerTtlMs) || this.offerTtlMs < 1_000 || this.offerTtlMs > MAX_OFFER_TTL_MS) {
      throw new DeviceError("invalid_input", "invalid offer ttl");
    }
    const dataDir = dirname(store.databasePath);
    this.databasePath = join(dataDir, DEVICES_DATABASE_FILE);
    this.db = store.withWriterLease(() => {
      privateDirectory(dataDir, false);
      privateDatabasePath(this.databasePath);
      const db = new DatabaseSync(this.databasePath, { timeout: 5_000 });
      try {
        sealDatabase(this.databasePath);
        db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
      } catch (error) { db.close(); throw error; }
      return db;
    });
    try {
      this.tx(() => {
        const hasMeta = this.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
        if (!hasMeta) {
          if (this.tables().length !== 0) throw new DeviceError("conflict", "unsupported device schema");
          this.db.exec(SCHEMA);
          this.db.exec(BINDINGS);
          const insert = this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
          insert.run("schema_version", String(SCHEMA_VERSION));
          insert.run("installation_id", store.hostId);
          insert.run("owner_id", store.ownerId);
          return;
        }
        const meta = (key: string): unknown => (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined)?.value;
        // Ownership is verified before any migration: a foreign file is never rewritten.
        if (meta("installation_id") !== store.hostId || meta("owner_id") !== store.ownerId) {
          throw new DeviceError("conflict", "device registry belongs to another installation or owner");
        }
        const version = meta("schema_version");
        if (version === "1") {
          this.expectTables(V1_TABLES);
          this.migrateV1();
        } else if (version !== String(SCHEMA_VERSION)) {
          throw new DeviceError("conflict", "unsupported device schema");
        }
        this.expectTables(V2_TABLES);
        this.verifyBindings();
        // An approval interrupted between its fenced steps has no certificate binding; it never resumes.
        this.db.prepare("UPDATE claims SET status = 'failed', decided_at = ? WHERE status = 'approving'").run(this.clock());
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  get installationId(): string { return this.store.hostId; }
  get ownerId(): string { return this.store.ownerId; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ---- owner/admin operations (trusted, in-process; never exposed to a device) -----------------

  /** A one-time pairing offer. `rotate` replaces the certificate of an existing, non-revoked device. */
  createOffer(input: { kind: "pair" } | { kind: "rotate"; deviceId: string }): PairingOffer {
    const kind = input.kind;
    if (kind !== "pair" && kind !== "rotate") throw new DeviceError("invalid_input", "invalid offer kind");
    const deviceId = kind === "rotate" ? wireId((input as { deviceId: unknown }).deviceId) : null;
    const code = randomBytes(32).toString("base64url");
    return this.tx(() => {
      if (deviceId !== null) {
        const device = this.hostDevice(deviceId);
        if (!device || device.revokedAt !== null || !this.activeCert(deviceId)) throw new DeviceError("conflict", "device cannot rotate");
      }
      const now = this.clock();
      const offerId = `pof_${randomUUID()}`;
      const expiresAt = now + this.offerTtlMs;
      this.db.prepare(`INSERT INTO offers (id, code_hash, kind, device_id, status, attempts, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'open', 0, ?, ?, ?)`).run(offerId, sha256(code).toString("hex"), kind, deviceId, expiresAt, now, now);
      return { offerId, code, kind, deviceId, expiresAt };
    });
  }
  cancelOffer(offerId: string): void {
    this.tx(() => { this.db.prepare("UPDATE offers SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'open'").run(this.clock(), offerId); });
  }
  listPendingClaims(): PendingClaim[] {
    const now = this.clock();
    return this.all("SELECT * FROM claims WHERE status = 'pending' AND expires_at > ? ORDER BY created_at, id", now).map((row) => ({
      claimId: row.id as string, kind: row.kind as PendingClaim["kind"], deviceId: (row.device_id as string | null) ?? null,
      clientFingerprint: row.client_fp as string, name: row.name as string,
      capabilities: JSON.parse(row.capabilities as string) as string[], expiresAt: Number(row.expires_at),
    }));
  }

  /**
   * Owner approval. `pair` registers a new HostStore device (no grants) and binds the claimed certificate;
   * `rotate` swaps the active certificate of the same device id, so grants and history stay attached.
   */
  approveClaim(claimId: string): { deviceId: string; fingerprint: string } {
    const claim = this.tx(() => {
      const row = this.one("SELECT * FROM claims WHERE id = ?", claimId);
      if (!row || row.status !== "pending") throw new DeviceError("conflict", "claim is not pending");
      if (Number(row.expires_at) <= this.clock()) throw new DeviceError("conflict", "claim expired");
      const fp = row.client_fp as string;
      if (this.one("SELECT 1 AS x FROM device_certs WHERE fp = ?", fp)) throw new DeviceError("conflict", "certificate already used");
      if (row.kind === "rotate") {
        const deviceId = row.device_id as string;
        const device = this.hostDevice(deviceId);
        if (!device || device.revokedAt !== null || !this.activeCert(deviceId)) throw new DeviceError("conflict", "device cannot rotate");
        const binding = this.bindingRow(deviceId);
        if (!binding || binding.status !== "active" || binding.fp !== this.activeCert(deviceId)) throw new DeviceError("conflict", "device cannot rotate");
        const generation = next(binding.generation), revision = next(binding.revision);
        const now = this.clock();
        this.db.prepare("UPDATE device_certs SET state = 'retired', updated_at = ? WHERE device_id = ? AND state = 'active'").run(now, deviceId);
        this.db.prepare("INSERT INTO device_certs (fp, device_id, state, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)").run(fp, deviceId, now, now);
        this.db.prepare("UPDATE device_bindings SET fp = ?, generation = ?, revision = ? WHERE device_id = ? AND status = 'active'")
          .run(fp, generation, revision, deviceId);
        this.db.prepare("UPDATE claims SET status = 'approved', decided_at = ? WHERE id = ?").run(now, claimId);
        return { kind: "rotate" as const, deviceId, fp, name: "", capabilities: [] as string[] };
      }
      this.db.prepare("UPDATE claims SET status = 'approving' WHERE id = ?").run(claimId);
      return { kind: "pair" as const, deviceId: "", fp, name: row.name as string, capabilities: JSON.parse(row.capabilities as string) as string[] };
    });
    if (claim.kind === "rotate") return { deviceId: claim.deviceId, fingerprint: claim.fp };
    let device: Device;
    try {
      device = this.store.registerDevice({ name: claim.name, platform: "macos", capabilities: claim.capabilities });
    } catch (error) {
      this.tx(() => { this.db.prepare("UPDATE claims SET status = 'failed', decided_at = ? WHERE id = ?").run(this.clock(), claimId); });
      throw error instanceof HostError ? error : new DeviceError("unavailable", "device registration failed");
    }
    try {
      this.tx(() => {
        const now = this.clock();
        this.db.prepare("INSERT INTO device_certs (fp, device_id, state, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)").run(claim.fp, device.id, now, now);
        this.db.prepare("INSERT INTO device_bindings (device_id, fp, generation, revision, status) VALUES (?, ?, 1, 1, 'active')").run(device.id, claim.fp);
        const changed = this.db.prepare("UPDATE claims SET status = 'approved', device_id = ?, decided_at = ? WHERE id = ? AND status = 'approving'").run(device.id, now, claimId);
        if (Number(changed.changes) !== 1) throw new DeviceError("conflict", "claim is not approving");
      });
    } catch (error) {
      // The new HostStore device has no certificate binding; revoke it so it can never be used.
      try { this.store.revokeDevice(device.id); } catch { /* fenced host: the device has no pin and never authenticates */ }
      throw error;
    }
    return { deviceId: device.id, fingerprint: claim.fp };
  }
  rejectClaim(claimId: string): void {
    this.tx(() => {
      const changed = this.db.prepare("UPDATE claims SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'").run(this.clock(), claimId);
      if (Number(changed.changes) !== 1) throw new DeviceError("conflict", "claim is not pending");
    });
  }

  /**
   * Revokes in the canonical HostStore first (irreversible; blocks pending actions in the same hub
   * transaction), then retires every pin of the device. Re-pairing creates a new device id without grants.
   */
  revokeDevice(deviceId: string): Device {
    const device = this.store.revokeDevice(deviceId);
    this.tx(() => {
      const now = this.clock();
      // Idempotent: only the first revocation of an active binding bumps its revision.
      const binding = this.bindingRow(deviceId);
      if (binding && binding.status === "active") {
        this.db.prepare("UPDATE device_bindings SET status = 'revoked', revision = ? WHERE device_id = ? AND status = 'active'").run(next(binding.revision), deviceId);
      }
      this.db.prepare("UPDATE device_certs SET state = 'revoked', updated_at = ? WHERE device_id = ? AND state != 'revoked'").run(now, deviceId);
      this.db.prepare("UPDATE offers SET status = 'cancelled', updated_at = ? WHERE device_id = ? AND status = 'open'").run(now, deviceId);
      this.db.prepare("UPDATE claims SET status = 'rejected', decided_at = ? WHERE device_id = ? AND status = 'pending'").run(now, deviceId);
    });
    return device;
  }
  listCertificates(deviceId?: string): DeviceCertificate[] {
    const rows = deviceId === undefined
      ? this.all("SELECT * FROM device_certs ORDER BY created_at, fp")
      : this.all("SELECT * FROM device_certs WHERE device_id = ? ORDER BY created_at, fp", deviceId);
    return rows.map((row) => ({ fingerprint: row.fp as string, deviceId: row.device_id as string, state: row.state as DeviceCertificate["state"] }));
  }
  /** HostStore macOS devices that are not revoked and have no active pin (e.g. an interrupted approval). */
  orphanDevices(): Device[] {
    return this.store.listDevices().filter((d) => d.platform === "macos" && d.revokedAt === null && !this.activeCert(d.id));
  }
  lateReceipt(actionId: string): LateReceipt | null {
    const row = this.one("SELECT * FROM late_receipts WHERE action_id = ?", actionId);
    return row ? {
      actionId: row.action_id as string, deviceId: row.device_id as string, requestHash: row.request_hash as string,
      status: row.status as LateReceipt["status"], code: (row.code as string | null) ?? null, receivedAt: Number(row.received_at),
    } : null;
  }

  // ---- device-facing operations (called by the TLS server with the verified peer pin) ----------

  /** Pairing claim over mutual TLS. Every refusal has the same code and message (no oracle). */
  claim(input: { offerId: unknown; code: unknown; clientFingerprint: string; name: unknown; capabilities: unknown }): { claimId: string } {
    if (!FINGERPRINT.test(input.clientFingerprint)) throw refused();
    if (typeof input.offerId !== "string" || typeof input.code !== "string" || !PAIRING_CODE.test(input.code)) throw refused();
    const name = typeof input.name === "string" ? input.name.trim() : "";
    // eslint-disable-next-line no-control-regex
    if (name.length < 1 || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw new DeviceError("invalid_input", "invalid name");
    const capabilities = checkCapabilities(input.capabilities);
    const offerId = input.offerId;
    const presented = sha256(input.code);
    return this.tx(() => {
      const offer = this.one("SELECT * FROM offers WHERE id = ?", offerId);
      const now = this.clock();
      if (!offer || offer.status !== "open" || Number(offer.expires_at) <= now) return new Refusal(refused());
      const stored = Buffer.from(offer.code_hash as string, "hex");
      if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) {
        const attempts = Number(offer.attempts) + 1;
        this.db.prepare("UPDATE offers SET attempts = ?, status = ?, updated_at = ? WHERE id = ?")
          .run(attempts, attempts >= MAX_CODE_ATTEMPTS ? "exhausted" : "open", now, offerId);
        return new Refusal(refused());
      }
      if (this.one("SELECT 1 AS x FROM device_certs WHERE fp = ?", input.clientFingerprint)
        || this.one("SELECT 1 AS x FROM claims WHERE client_fp = ? AND status IN ('pending', 'approving')", input.clientFingerprint)) {
        return new Refusal(refused());
      }
      const claimId = `pcl_${randomUUID()}`;
      this.db.prepare("UPDATE offers SET status = 'claimed', updated_at = ? WHERE id = ?").run(now, offerId);
      this.db.prepare(`INSERT INTO claims (id, offer_id, kind, client_fp, name, capabilities, status, device_id, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .run(claimId, offerId, offer.kind as string, input.clientFingerprint, name, JSON.stringify(capabilities),
          (offer.device_id as string | null) ?? null, now + this.offerTtlMs, now);
      return { claimId };
    });
  }
  /** Only the certificate that made the claim can read its status. */
  claimStatus(claimId: unknown, clientFingerprint: string): { status: ClaimStatus; deviceId: string | null } {
    if (typeof claimId !== "string") throw new DeviceError("not_found", "claim not found");
    const row = this.one("SELECT * FROM claims WHERE id = ? AND client_fp = ?", claimId, clientFingerprint);
    if (!row) throw new DeviceError("not_found", "claim not found");
    const status = row.status as string;
    if (status === "approved") return { status: "approved", deviceId: row.device_id as string };
    if (status === "pending" || status === "approving") {
      return { status: Number(row.expires_at) <= this.clock() && status === "pending" ? "expired" : "pending", deviceId: null };
    }
    return { status: status as ClaimStatus, deviceId: null };
  }
  /**
   * Possession, not a claimed id: the device is the one whose active pin equals the TLS peer certificate,
   * and only while the canonical HostStore device exists, belongs to this owner and is not revoked.
   */
  authenticate(clientFingerprint: string): Device | null {
    if (!FINGERPRINT.test(clientFingerprint)) return null;
    const row = this.one("SELECT device_id FROM device_certs WHERE fp = ? AND state = 'active'", clientFingerprint);
    if (!row) return null;
    const device = this.hostDevice(row.device_id as string);
    if (!device || device.revokedAt !== null || device.platform !== "macos" || device.ownerId !== this.store.ownerId) return null;
    return device;
  }
  activeFingerprint(deviceId: string): string | null {
    return this.activeCert(deviceId);
  }
  /**
   * Read-only pin binding for trusted host composition (no engine, HTTP or device path). `null` for an
   * unknown, foreign or non-macOS device and for a HostStore device whose approval never bound a pin.
   * Safe inside an outer `withWriterLease`: it only reads.
   */
  pinBinding(deviceId: string): DevicePinBinding | null {
    if (typeof deviceId !== "string") return null;
    const device = this.hostDevice(deviceId);
    if (!device || device.ownerId !== this.store.ownerId || device.platform !== "macos") return null;
    const binding = this.bindingRow(deviceId);
    if (!binding) return null;
    const revoked = device.revokedAt !== null || binding.status === "revoked";
    if (!revoked && binding.fp !== this.activeCert(deviceId)) throw new DeviceError("conflict", "device binding is inconsistent");
    return Object.freeze({
      installationId: this.store.hostId, ownerId: this.store.ownerId, deviceId, fingerprint: binding.fp,
      generation: binding.generation, revision: binding.revision, status: revoked ? "revoked" as const : "active" as const,
    });
  }
  /** Auxiliary record of a receipt that arrived after the host stopped waiting. Never changes the action. */
  recordLateReceipt(receipt: Omit<LateReceipt, "receivedAt">): void {
    this.tx(() => {
      this.db.prepare(`INSERT INTO late_receipts (action_id, device_id, request_hash, status, code, received_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (action_id) DO NOTHING`).run(receipt.actionId, receipt.deviceId, receipt.requestHash, receipt.status, receipt.code, this.clock());
    });
  }

  // ---- internals -----------------------------------------------------------------------------

  private hostDevice(id: string): Device | null {
    try { return this.store.getDevice(id); } catch (error) {
      if (error instanceof HostError && error.code === "not_found") return null;
      throw error;
    }
  }
  private bindingRow(deviceId: string): { fp: string; generation: number; revision: number; status: "active" | "revoked" } | null {
    let row: Row | undefined;
    try { row = this.one("SELECT * FROM device_bindings WHERE device_id = ?", deviceId); } catch (error) {
      // node:sqlite refuses integers beyond Number.MAX_SAFE_INTEGER; such a counter is never valid.
      if (error instanceof RangeError) throw new DeviceError("conflict", "device binding is invalid");
      throw error;
    }
    if (!row) return null;
    const generation = row.generation, revision = row.revision;
    if (typeof row.fp !== "string" || !FINGERPRINT.test(row.fp) || !counter(generation) || !counter(revision) || revision < generation
      || (row.status !== "active" && row.status !== "revoked")) {
      throw new DeviceError("conflict", "device binding is invalid");
    }
    return { fp: row.fp, generation, revision, status: row.status };
  }
  private tables(): string[] {
    return this.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => row.name as string);
  }
  /** Partial or foreign schema is quarantined: the file stays untouched and the registry refuses to open. */
  private expectTables(expected: readonly string[]): void {
    if (this.tables().join(",") !== [...expected].sort().join(",")) throw new DeviceError("conflict", "unsupported device schema");
  }
  /**
   * v1 -> v2, inside the opening fenced transaction (all or nothing). Only pin history already in this file is
   * reconciled: generation = pins ever bound to the device; revision = generation, +1 if its pins are revoked.
   * Grants, devices and actions in the HostStore are never read for authority or rewritten here.
   */
  private migrateV1(): void {
    this.db.exec(BINDINGS);
    const insert = this.db.prepare("INSERT INTO device_bindings (device_id, fp, generation, revision, status) VALUES (?, ?, ?, ?, ?)");
    for (const { device_id: deviceId } of this.all("SELECT DISTINCT device_id FROM device_certs ORDER BY device_id")) {
      // v1 has no binding counter. Its insertion order records rotations even when wall-clock
      // timestamps tie or move backwards; fingerprint ordering cannot identify the last bound pin.
      const certs = this.all("SELECT fp, state FROM device_certs WHERE device_id = ? ORDER BY rowid DESC", deviceId as string);
      const active = certs.filter((c) => c.state === "active"), revoked = certs.filter((c) => c.state === "revoked");
      // Revocation marks every pin revoked and rotation always leaves exactly one active pin.
      if (revoked.length > 0 ? revoked.length !== certs.length : active.length !== 1) throw new DeviceError("conflict", "device pin history is inconsistent");
      const generation = certs.length;
      const status = revoked.length > 0 ? "revoked" : "active";
      const fp = (status === "active" ? active[0]! : certs[0]!).fp as string;
      insert.run(deviceId as string, fp, generation, generation + (status === "revoked" ? 1 : 0), status);
    }
    this.db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
  }
  /** Every pinned device has exactly one consistent binding; anything else is quarantined (fail closed). */
  private verifyBindings(): void {
    const columns = this.all("PRAGMA table_info(device_bindings)").map((row) => row.name as string).join(",");
    if (columns !== BINDING_COLUMNS) throw new DeviceError("conflict", "unsupported device schema");
    const orphan = this.one(`SELECT 1 AS x FROM device_certs c LEFT JOIN device_bindings b ON b.device_id = c.device_id WHERE b.device_id IS NULL
      UNION ALL SELECT 1 FROM device_bindings b LEFT JOIN device_certs c ON c.fp = b.fp AND c.device_id = b.device_id WHERE c.fp IS NULL
      UNION ALL SELECT 1 FROM device_bindings b JOIN device_certs c ON c.fp = b.fp
        WHERE (b.status = 'active' AND c.state != 'active') OR (b.status = 'revoked' AND c.state != 'revoked')
      UNION ALL SELECT 1 FROM device_bindings b JOIN device_certs c ON c.device_id = b.device_id
        WHERE b.status = 'revoked' AND c.state != 'revoked'
      UNION ALL SELECT 1 FROM device_bindings b WHERE b.generation != (SELECT COUNT(*) FROM device_certs c WHERE c.device_id = b.device_id)
      LIMIT 1`);
    if (orphan) throw new DeviceError("conflict", "device pin history is inconsistent");
    for (const { device_id: deviceId } of this.all("SELECT device_id FROM device_bindings")) this.bindingRow(deviceId as string);
  }
  private activeCert(deviceId: string): string | null {
    const row = this.one("SELECT fp FROM device_certs WHERE device_id = ? AND state = 'active'", deviceId);
    return row ? (row.fp as string) : null;
  }
  private tx<T>(fn: () => T | Refusal): T {
    if (this.closed) throw new DeviceError("unavailable", "device registry closed");
    const result = this.store.withWriterLease(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const value = fn();
        this.db.exec("COMMIT");
        return value;
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        throw error;
      }
    });
    if (result instanceof Refusal) throw result.error;
    return result;
  }
  private one(sql: string, ...params: SQLInputValue[]): Row | undefined {
    if (this.closed) throw new DeviceError("unavailable", "device registry closed");
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    if (this.closed) throw new DeviceError("unavailable", "device registry closed");
    return this.db.prepare(sql).all(...params) as Row[];
  }
}
