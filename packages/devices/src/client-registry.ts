import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Device } from "@dexter/contracts";
import {
  CLIENT_DEVICE_SCOPES, HostError, type ClientDeviceEnrollment, type ClientDeviceRole, type ClientDeviceScope, type HostStore,
} from "@dexter/hub";
import { DeviceError } from "./errors.js";
import { privateDatabasePath, privateDirectory, sealDatabase } from "./files.js";
import { FINGERPRINT, wireId } from "./wire.js";

export const APP_CLIENTS_DATABASE_FILE = "app-clients.sqlite";
export const APP_CLIENT_NAMESPACE = "app-client-v1";
export const APP_CLIENT_ROLES: readonly ClientDeviceRole[] = Object.freeze(["client-ios", "client-mac"]);
const SCHEMA_VERSION = "1";
const DEFAULT_OFFER_TTL_MS = 10 * 60_000;
const MAX_OFFER_TTL_MS = 60 * 60_000;
const MAX_CODE_ATTEMPTS = 5;
const PAIRING_CODE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Closed schema. Role, platform and scopes are fixed by the owner's offer and copied unchanged into the claim
 * and the binding; nothing in a client request can choose them. `generation` counts pins ever bound to the
 * device (1 at pairing, +1 per approved rotation), `revision` counts binding changes (pair, rotate, revoke).
 */
const TABLES: ReadonlyArray<readonly [string, string]> = [
  ["meta", "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT"],
  ["offers", `CREATE TABLE offers (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('pair', 'rotate')),
  role TEXT NOT NULL CHECK (role IN ('client-ios', 'client-mac')), scopes TEXT NOT NULL, device_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'cancelled', 'exhausted')), attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT`],
  ["claims", `CREATE TABLE claims (
  id TEXT PRIMARY KEY, offer_id TEXT NOT NULL UNIQUE REFERENCES offers(id), kind TEXT NOT NULL CHECK (kind IN ('pair', 'rotate')),
  role TEXT NOT NULL CHECK (role IN ('client-ios', 'client-mac')), scopes TEXT NOT NULL, client_fp TEXT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approving', 'approved', 'rejected', 'failed')),
  device_id TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER
) STRICT`],
  ["client_certs", `CREATE TABLE client_certs (
  fp TEXT PRIMARY KEY, device_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active', 'retired', 'revoked')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT`],
  ["client_certs_active", "CREATE UNIQUE INDEX client_certs_active ON client_certs (device_id) WHERE state = 'active'"],
  ["client_bindings", `CREATE TABLE client_bindings (
  device_id TEXT PRIMARY KEY, claim_id TEXT NOT NULL UNIQUE REFERENCES claims(id),
  role TEXT NOT NULL CHECK (role IN ('client-ios', 'client-mac')), scopes TEXT NOT NULL, enrollment_digest TEXT NOT NULL,
  fp TEXT NOT NULL UNIQUE REFERENCES client_certs(fp),
  generation INTEGER NOT NULL CHECK (generation >= 1), revision INTEGER NOT NULL CHECK (revision >= generation),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked'))
) STRICT`],
];
const normalize = (sql: string): string => sql.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();

type Row = Record<string, unknown>;
class Refusal { constructor(readonly error: DeviceError) {} }
const refused = (): DeviceError => new DeviceError("forbidden", "pairing refused");
const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();
const counter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const next = (value: number): number => {
  if (!Number.isSafeInteger(value + 1)) throw new DeviceError("conflict", "client binding counter exhausted");
  return value + 1;
};
const platformOf = (role: ClientDeviceRole): Device["platform"] => role === "client-ios" ? "ios" : "macos";

/** Unique, closed, sorted scope list (0–8). An empty list allows only health/contracts. */
export function clientScopes(value: unknown): ClientDeviceScope[] {
  if (!Array.isArray(value) || value.length > CLIENT_DEVICE_SCOPES.length) throw new DeviceError("invalid_input", "invalid scopes");
  const scopes: ClientDeviceScope[] = [];
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    if (typeof item !== "string" || !(CLIENT_DEVICE_SCOPES as readonly string[]).includes(item) || scopes.includes(item as ClientDeviceScope)) {
      throw new DeviceError("invalid_input", "invalid scopes");
    }
    scopes.push(item as ClientDeviceScope);
  }
  return scopes.sort();
}
function clientRole(value: unknown): ClientDeviceRole {
  if (value !== "client-ios" && value !== "client-mac") throw new DeviceError("invalid_input", "invalid role");
  return value;
}
function storedScopes(value: unknown): ClientDeviceScope[] {
  if (typeof value !== "string") throw new DeviceError("conflict", "client registry is inconsistent");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new DeviceError("conflict", "client registry is inconsistent"); }
  const scopes = clientScopes(parsed);
  if (JSON.stringify(scopes) !== value) throw new DeviceError("conflict", "client registry is inconsistent");
  return scopes;
}

export type ClientOfferInput =
  | { kind: "pair"; role: ClientDeviceRole; scopes: readonly ClientDeviceScope[] }
  | { kind: "rotate"; deviceId: string };
export interface ClientPairingOffer {
  offerId: string;
  /** One-time secret for the owner's private transfer (QR/file). Only its hash is stored; never log it. */
  code: string;
  kind: "pair" | "rotate";
  role: ClientDeviceRole;
  scopes: readonly ClientDeviceScope[];
  deviceId: string | null;
  expiresAt: number;
}
export interface ClientPendingClaim {
  claimId: string;
  kind: "pair" | "rotate";
  role: ClientDeviceRole;
  scopes: readonly ClientDeviceScope[];
  deviceId: string | null;
  /** Public SHA-256 pin of the certificate that proved possession over mutual TLS. */
  clientFingerprint: string;
  /** Untrusted label. */
  name: string;
  expiresAt: number;
}
export type ClientClaimState = "pending" | "approved" | "rejected" | "expired" | "failed";
/**
 * Owner review of one claim (trusted, in-process): the offer it consumed and the exact role/scopes/pin it carries.
 * `targetDeviceId` is the device a `rotate` claim re-keys (null for `pair`); `approvedDeviceId` is set once approved.
 */
export interface ClientClaimRecord {
  claimId: string;
  offerId: string;
  kind: "pair" | "rotate";
  role: ClientDeviceRole;
  scopes: readonly ClientDeviceScope[];
  targetDeviceId: string | null;
  approvedDeviceId: string | null;
  /** Public SHA-256 pin of the certificate that proved possession over mutual TLS. */
  clientFingerprint: string;
  /** Untrusted label. */
  name: string;
  status: "pending" | "approving" | "approved" | "rejected" | "failed" | "expired";
  expiresAt: number;
  createdAt: number;
  decidedAt: number | null;
}
export interface ClientClaimStatus {
  status: ClientClaimState;
  deviceId: string | null;
  role: ClientDeviceRole;
  scopes: readonly ClientDeviceScope[];
  pinGeneration: number | null;
  bindingRevision: number | null;
}
/**
 * Owner-bound binding of one paired app client, read from this registry and the canonical HostStore device.
 * `status` is `revoked` whenever the HostStore device is revoked, even if the auxiliary revocation was lost.
 */
export interface ClientBinding {
  readonly installationId: string;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly role: ClientDeviceRole;
  readonly scopes: readonly ClientDeviceScope[];
  readonly fingerprint: string;
  readonly generation: number;
  readonly revision: number;
  readonly status: "active" | "revoked";
}
export interface ClientRegistryOptions {
  clock?: () => number;
  offerTtlMs?: number;
  /** Public pins that can never be claimed as a client certificate (e.g. the host's own TLS identity). */
  reservedFingerprints?: readonly string[];
}

/**
 * Pairing metadata of paired Apple app clients (`client-ios`, `client-mac`) for one installation/owner, in its
 * own private database and key namespace, separate from the Mac agent registry. The canonical device and its
 * immutable enrollment journal live in the HostStore (`registerClientDeviceForClaim`), written in the same Hub
 * transaction; this file only binds the approved certificate pin to that device. Client devices publish no
 * capabilities and no grant is ever created here.
 *
 * Every mutation commits inside `HostStore.withWriterLease` and never calls another HostStore write inside
 * the fence. Approval is `pending -> approving` (fenced), canonical enrollment (Hub transaction), then
 * `approving -> approved` with the pin (fenced). A crash between them is recovered from the canonical
 * enrollment for the same claim id: the same device is bound, or it is revoked when metadata diverges.
 */
export class ClientPairingRegistry {
  readonly databasePath: string;
  readonly offerTtlMs: number;
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  private readonly reserved: ReadonlySet<string>;
  private closed = false;

  constructor(private readonly store: HostStore, options: ClientRegistryOptions = {}) {
    this.clock = options.clock ?? (() => store.now());
    this.offerTtlMs = options.offerTtlMs ?? DEFAULT_OFFER_TTL_MS;
    if (!Number.isSafeInteger(this.offerTtlMs) || this.offerTtlMs < 1_000 || this.offerTtlMs > MAX_OFFER_TTL_MS) {
      throw new DeviceError("invalid_input", "invalid offer ttl");
    }
    const reserved = options.reservedFingerprints ?? [];
    if (!Array.isArray(reserved) || reserved.some((fp) => typeof fp !== "string" || !FINGERPRINT.test(fp))) {
      throw new DeviceError("invalid_input", "invalid reserved fingerprints");
    }
    this.reserved = new Set(reserved);
    const dataDir = dirname(store.databasePath);
    this.databasePath = join(dataDir, APP_CLIENTS_DATABASE_FILE);
    this.db = store.withWriterLease(() => {
      privateDirectory(dataDir, false);
      privateDatabasePath(this.databasePath);
      const db = new DatabaseSync(this.databasePath, { timeout: 5_000, enableForeignKeyConstraints: true });
      try {
        sealDatabase(this.databasePath);
        db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
      } catch (error) { db.close(); throw error; }
      return db;
    });
    try {
      this.tx(() => {
        if (this.schemaObjects().length === 0) {
          for (const [, sql] of TABLES) this.db.exec(sql);
          const insert = this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
          insert.run("schema_version", SCHEMA_VERSION);
          insert.run("namespace", APP_CLIENT_NAMESPACE);
          insert.run("installation_id", store.hostId);
          insert.run("owner_id", store.ownerId);
          return;
        }
        this.verifySchema();
        const meta = Object.fromEntries(this.all("SELECT key, value FROM meta").map((row) => [row.key as string, row.value]));
        // Ownership is verified before anything else: a foreign file is never rewritten.
        if (Object.keys(meta).sort().join(",") !== "installation_id,namespace,owner_id,schema_version"
          || meta.installation_id !== store.hostId || meta.owner_id !== store.ownerId) {
          throw new DeviceError("conflict", "client registry belongs to another installation or owner");
        }
        if (meta.schema_version !== SCHEMA_VERSION || meta.namespace !== APP_CLIENT_NAMESPACE) throw new DeviceError("conflict", "unsupported client schema");
        this.verifyRows();
      });
      this.recover();
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

  // ---- owner/admin operations (trusted, in-process; never exposed to a client) -----------------

  /**
   * One-time offer. Role and scopes are fixed here; `rotate` keeps the role/scopes of the existing binding. `ttlMs` may
   * only shorten the configured offer lifetime (owner choice), never extend it.
   */
  createOffer(input: ClientOfferInput, ttlMs?: number): ClientPairingOffer {
    if (input === null || typeof input !== "object") throw new DeviceError("invalid_input", "invalid offer");
    if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > this.offerTtlMs)) throw new DeviceError("invalid_input", "invalid offer ttl");
    const kind = input.kind;
    if (kind !== "pair" && kind !== "rotate") throw new DeviceError("invalid_input", "invalid offer kind");
    const pairRole = kind === "pair" ? clientRole((input as { role: unknown }).role) : null;
    const pairScopes = kind === "pair" ? clientScopes((input as { scopes: unknown }).scopes) : null;
    const deviceId = kind === "rotate" ? wireId((input as { deviceId: unknown }).deviceId) : null;
    const code = randomBytes(32).toString("base64url");
    return this.tx(() => {
      let role = pairRole, scopes = pairScopes;
      if (deviceId !== null) {
        const binding = this.bindingRow(deviceId);
        const device = this.hostDevice(deviceId);
        if (!binding || binding.status !== "active" || !device || device.revokedAt !== null) throw new DeviceError("conflict", "device cannot rotate");
        role = binding.role; scopes = binding.scopes;
      }
      const now = this.clock();
      const offerId = `cof_${randomUUID()}`;
      const expiresAt = now + (ttlMs ?? this.offerTtlMs);
      this.db.prepare(`INSERT INTO offers (id, code_hash, kind, role, scopes, device_id, status, attempts, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?, ?, ?)`).run(offerId, sha256(code).toString("hex"), kind, role!, JSON.stringify(scopes),
        deviceId, expiresAt, now, now);
      return { offerId, code, kind, role: role!, scopes: Object.freeze([...scopes!]), deviceId, expiresAt };
    });
  }
  cancelOffer(offerId: string): void {
    this.tx(() => { this.db.prepare("UPDATE offers SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'open'").run(this.clock(), offerId); });
  }
  /** Read-only state of one offer (`open` past its expiry reads `expired`); null when this registry never issued it. */
  offerState(offerId: string): { status: "open" | "claimed" | "cancelled" | "exhausted" | "expired"; expiresAt: number } | null {
    if (typeof offerId !== "string") return null;
    const row = this.one("SELECT status, expires_at FROM offers WHERE id = ?", offerId);
    if (!row) return null;
    const expiresAt = Number(row.expires_at), status = row.status as "open" | "claimed" | "cancelled" | "exhausted";
    return { status: status === "open" && expiresAt <= this.clock() ? "expired" : status, expiresAt };
  }
  listPendingClaims(): ClientPendingClaim[] {
    const now = this.clock();
    return this.all("SELECT * FROM claims WHERE status = 'pending' AND expires_at > ? ORDER BY created_at, id", now).map((row) => ({
      claimId: row.id as string, kind: row.kind as "pair" | "rotate", role: clientRole(row.role), scopes: Object.freeze(storedScopes(row.scopes)),
      deviceId: (row.device_id as string | null) ?? null, clientFingerprint: row.client_fp as string, name: row.name as string,
      expiresAt: Number(row.expires_at),
    }));
  }

  /** Owner review of one claim in any state; null when this registry never recorded it. */
  claimRecord(claimId: string): ClientClaimRecord | null {
    if (typeof claimId !== "string") return null;
    const row = this.one("SELECT * FROM claims WHERE id = ?", claimId);
    return row ? this.claimView(row) : null;
  }
  /** Pending, unexpired claims for owner review, oldest first (bounded). */
  pendingClaimRecords(limit = 50): ClientClaimRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new DeviceError("invalid_input", "invalid limit");
    return this.all("SELECT * FROM claims WHERE status = 'pending' AND expires_at > ? ORDER BY created_at, id LIMIT ?", this.clock(), limit).map(row => this.claimView(row));
  }

  /**
   * Owner approval. `pair` enrolls one canonical device through the HostStore claim journal and binds the
   * claimed pin to it; a retry of an interrupted approval resumes with the same device id. `rotate` swaps the
   * active pin of the same device, keeping its role and scopes. No grant is created either way.
   */
  approveClaim(claimId: string): { deviceId: string; fingerprint: string } {
    if (typeof claimId !== "string") throw new DeviceError("not_found", "claim not found");
    const claim = this.tx(() => {
      const row = this.one("SELECT * FROM claims WHERE id = ?", claimId);
      if (!row || (row.status !== "pending" && row.status !== "approving")) throw new DeviceError("conflict", "claim is not pending");
      const fp = row.client_fp as string;
      if (row.status === "pending") {
        if (Number(row.expires_at) <= this.clock()) throw new DeviceError("conflict", "claim expired");
        if (this.one("SELECT 1 AS x FROM client_certs WHERE fp = ?", fp)) throw new DeviceError("conflict", "certificate already used");
      }
      if (row.kind === "rotate") {
        const deviceId = row.device_id as string;
        const device = this.hostDevice(deviceId);
        const binding = this.bindingRow(deviceId);
        if (!device || device.revokedAt !== null || !binding || binding.status !== "active" || binding.fp !== this.activeCert(deviceId)) {
          throw new DeviceError("conflict", "device cannot rotate");
        }
        if (binding.role !== row.role || JSON.stringify(binding.scopes) !== row.scopes) throw new DeviceError("conflict", "device cannot rotate");
        const now = this.clock();
        this.db.prepare("UPDATE client_certs SET state = 'retired', updated_at = ? WHERE device_id = ? AND state = 'active'").run(now, deviceId);
        this.db.prepare("INSERT INTO client_certs (fp, device_id, state, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)").run(fp, deviceId, now, now);
        this.db.prepare("UPDATE client_bindings SET fp = ?, generation = ?, revision = ? WHERE device_id = ? AND status = 'active'")
          .run(fp, next(binding.generation), next(binding.revision), deviceId);
        this.db.prepare("UPDATE claims SET status = 'approved', decided_at = ? WHERE id = ?").run(now, claimId);
        return { kind: "rotate" as const, deviceId, fp, role: binding.role, scopes: binding.scopes, name: "" };
      }
      this.db.prepare("UPDATE claims SET status = 'approving' WHERE id = ?").run(claimId);
      return { kind: "pair" as const, deviceId: "", fp, role: clientRole(row.role), scopes: storedScopes(row.scopes), name: row.name as string };
    });
    if (claim.kind === "rotate") return { deviceId: claim.deviceId, fingerprint: claim.fp };
    let enrollment: ClientDeviceEnrollment;
    try {
      enrollment = this.store.registerClientDeviceForClaim({ namespace: APP_CLIENT_NAMESPACE, claimId, name: claim.name,
        fingerprint: claim.fp, role: claim.role, scopes: claim.scopes });
    } catch (error) {
      // Divergent or invalid canonical metadata is definitive; anything else (a fenced host) stays `approving`
      // and is completed by a retry or at the next open from the canonical journal, never by a second device.
      if (error instanceof HostError && (error.code === "conflict" || error.code === "invalid_input")) this.fail(claimId, null);
      throw error instanceof HostError ? error : new DeviceError("unavailable", "client enrollment failed");
    }
    return this.activate(claimId, enrollment);
  }
  rejectClaim(claimId: string): void {
    this.tx(() => {
      const changed = this.db.prepare("UPDATE claims SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'").run(this.clock(), claimId);
      if (Number(changed.changes) !== 1) throw new DeviceError("conflict", "claim is not pending");
    });
  }

  /**
   * Revokes in the canonical HostStore first (irreversible; blocks pending actions targeting it), then retires
   * every pin of the client. Refuses devices that are not app clients of this registry. Re-pairing is a new id.
   */
  revokeDevice(deviceId: string): { device: Device; fingerprints: string[] } {
    if (!this.isClientDevice(deviceId)) throw new DeviceError("not_found", "client device not found");
    const fingerprints = this.listCertificates(deviceId).map((cert) => cert.fingerprint);
    const device = this.store.revokeDevice(deviceId);
    this.tx(() => {
      const now = this.clock();
      const binding = this.bindingRow(deviceId);
      if (binding && binding.status === "active") {
        this.db.prepare("UPDATE client_bindings SET status = 'revoked', revision = ? WHERE device_id = ? AND status = 'active'").run(next(binding.revision), deviceId);
      }
      this.db.prepare("UPDATE client_certs SET state = 'revoked', updated_at = ? WHERE device_id = ? AND state != 'revoked'").run(now, deviceId);
      this.db.prepare("UPDATE offers SET status = 'cancelled', updated_at = ? WHERE device_id = ? AND status = 'open'").run(now, deviceId);
      this.db.prepare("UPDATE claims SET status = 'rejected', decided_at = ? WHERE device_id = ? AND status = 'pending'").run(now, deviceId);
    });
    return { device, fingerprints };
  }
  listCertificates(deviceId: string): { fingerprint: string; state: "active" | "retired" | "revoked" }[] {
    return this.all("SELECT fp, state FROM client_certs WHERE device_id = ? ORDER BY created_at, fp", deviceId)
      .map((row) => ({ fingerprint: row.fp as string, state: row.state as "active" | "retired" | "revoked" }));
  }
  /** Whether the canonical device id was bound (now or before) by this registry. */
  isClientDevice(deviceId: string): boolean {
    if (typeof deviceId !== "string") return false;
    return this.one("SELECT 1 AS x FROM client_bindings WHERE device_id = ?", deviceId) !== undefined;
  }

  // ---- client-facing operations (called by the TLS listener with the verified peer pin) ----------

  /** Claim over mutual TLS. Role, platform and scopes come from the offer. Every refusal is identical. */
  claim(input: { offerId: unknown; code: unknown; name: unknown; clientFingerprint: string }): { claimId: string } {
    if (typeof input.clientFingerprint !== "string" || !FINGERPRINT.test(input.clientFingerprint) || this.reserved.has(input.clientFingerprint)) throw refused();
    if (typeof input.offerId !== "string" || typeof input.code !== "string" || !PAIRING_CODE.test(input.code)) throw refused();
    const name = typeof input.name === "string" ? input.name.trim() : "";
    // eslint-disable-next-line no-control-regex
    if (name.length < 1 || name.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new DeviceError("invalid_input", "invalid name");
    const offerId = input.offerId;
    const presented = sha256(input.code);
    const fp = input.clientFingerprint;
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
      if (this.one("SELECT 1 AS x FROM client_certs WHERE fp = ?", fp)
        || this.one("SELECT 1 AS x FROM claims WHERE client_fp = ? AND status IN ('pending', 'approving', 'approved')", fp)) {
        return new Refusal(refused());
      }
      const claimId = `ccl_${randomUUID()}`;
      this.db.prepare("UPDATE offers SET status = 'claimed', updated_at = ? WHERE id = ?").run(now, offerId);
      this.db.prepare(`INSERT INTO claims (id, offer_id, kind, role, scopes, client_fp, name, status, device_id, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .run(claimId, offerId, offer.kind as string, offer.role as string, offer.scopes as string, fp, name,
          (offer.device_id as string | null) ?? null, now + this.offerTtlMs, now);
      return { claimId };
    });
  }
  /** Only the certificate that made the claim can read it. Approved status carries the binding counters. */
  claimStatus(claimId: unknown, clientFingerprint: string): ClientClaimStatus {
    if (typeof claimId !== "string") throw new DeviceError("not_found", "claim not found");
    const row = this.one("SELECT * FROM claims WHERE id = ? AND client_fp = ?", claimId, clientFingerprint);
    if (!row) throw new DeviceError("not_found", "claim not found");
    const base = { role: clientRole(row.role), scopes: Object.freeze(storedScopes(row.scopes)) };
    const status = row.status as string;
    if (status === "approved") {
      const deviceId = row.device_id as string;
      const binding = this.binding(deviceId);
      // An approved pin is reported only while it is still the active binding of a current device.
      if (!binding || binding.status !== "active" || binding.fingerprint !== clientFingerprint) {
        return { ...base, status: "rejected", deviceId: null, pinGeneration: null, bindingRevision: null };
      }
      return { ...base, status: "approved", deviceId, pinGeneration: binding.generation, bindingRevision: binding.revision };
    }
    if (status === "pending" || status === "approving") {
      const expired = status === "pending" && Number(row.expires_at) <= this.clock();
      return { ...base, status: expired ? "expired" : "pending", deviceId: null, pinGeneration: null, bindingRevision: null };
    }
    return { ...base, status: status as ClientClaimState, deviceId: null, pinGeneration: null, bindingRevision: null };
  }
  /**
   * Possession, not a claimed id: the binding whose active pin equals the TLS peer certificate, only while the
   * canonical HostStore device exists for this owner, is not revoked, has the role's platform and no capabilities.
   */
  authenticate(clientFingerprint: string): ClientBinding | null {
    if (typeof clientFingerprint !== "string" || !FINGERPRINT.test(clientFingerprint)) return null;
    const row = this.one("SELECT device_id FROM client_certs WHERE fp = ? AND state = 'active'", clientFingerprint);
    if (!row) return null;
    const binding = this.binding(row.device_id as string);
    return binding && binding.status === "active" && binding.fingerprint === clientFingerprint ? binding : null;
  }
  /** Read-only snapshot for trusted composition (projection, listener). `null` if not an app client here. */
  binding(deviceId: string): ClientBinding | null {
    if (typeof deviceId !== "string") return null;
    const binding = this.bindingRow(deviceId);
    if (!binding) return null;
    const device = this.hostDevice(deviceId);
    if (!device || device.ownerId !== this.store.ownerId) return null;
    if (device.platform !== platformOf(binding.role) || device.capabilities.length !== 0) throw new DeviceError("conflict", "client binding is inconsistent");
    const revoked = device.revokedAt !== null || binding.status === "revoked";
    if (!revoked && binding.fp !== this.activeCert(deviceId)) throw new DeviceError("conflict", "client binding is inconsistent");
    return Object.freeze({
      installationId: this.store.hostId, ownerId: this.store.ownerId, deviceId, role: binding.role,
      scopes: Object.freeze([...binding.scopes]), fingerprint: binding.fp, generation: binding.generation, revision: binding.revision,
      status: revoked ? "revoked" as const : "active" as const,
    });
  }

  // ---- internals -----------------------------------------------------------------------------

  private claimView(row: Row): ClientClaimRecord {
    const kind = row.kind === "rotate" ? "rotate" as const : "pair" as const, stored = row.status as string, expiresAt = Number(row.expires_at);
    const deviceId = (row.device_id as string | null) ?? null;
    const status = stored === "pending" && expiresAt <= this.clock() ? "expired" as const : stored as ClientClaimRecord["status"];
    return { claimId: row.id as string, offerId: row.offer_id as string, kind, role: clientRole(row.role), scopes: Object.freeze(storedScopes(row.scopes)),
      targetDeviceId: kind === "rotate" ? deviceId : null, approvedDeviceId: status === "approved" ? deviceId : null,
      clientFingerprint: row.client_fp as string, name: row.name as string, status, expiresAt, createdAt: Number(row.created_at),
      decidedAt: row.decided_at === null || row.decided_at === undefined ? null : Number(row.decided_at) };
  }

  /** Second fenced step of a pair approval: bind the pin only if the canonical enrollment matches the claim. */
  private activate(claimId: string, enrollment: ClientDeviceEnrollment): { deviceId: string; fingerprint: string } {
    let diverged = false;
    try {
      return this.tx(() => {
        const row = this.one("SELECT * FROM claims WHERE id = ?", claimId);
        if (!row || row.status !== "approving") throw new DeviceError("conflict", "claim is not approving");
        if (enrollment.namespace !== APP_CLIENT_NAMESPACE || enrollment.claimId !== claimId || enrollment.hostId !== this.store.hostId
          || enrollment.ownerId !== this.store.ownerId || enrollment.fingerprint !== row.client_fp || enrollment.role !== row.role
          || JSON.stringify([...enrollment.scopes]) !== row.scopes || enrollment.deviceId !== enrollment.device.id
          || enrollment.device.platform !== platformOf(enrollment.role) || enrollment.device.capabilities.length !== 0) {
          diverged = true;
          throw new DeviceError("conflict", "client enrollment diverged");
        }
        if (enrollment.device.revokedAt !== null) { diverged = true; throw new DeviceError("conflict", "client device was revoked"); }
        if (this.one("SELECT 1 AS x FROM client_certs WHERE fp = ?", enrollment.fingerprint)
          || this.one("SELECT 1 AS x FROM client_bindings WHERE device_id = ?", enrollment.deviceId)) {
          diverged = true;
          throw new DeviceError("conflict", "client binding already exists");
        }
        const now = this.clock();
        this.db.prepare("INSERT INTO client_certs (fp, device_id, state, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)")
          .run(enrollment.fingerprint, enrollment.deviceId, now, now);
        this.db.prepare(`INSERT INTO client_bindings (device_id, claim_id, role, scopes, enrollment_digest, fp, generation, revision, status)
          VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'active')`).run(enrollment.deviceId, claimId, enrollment.role, row.scopes as string,
          enrollment.digest, enrollment.fingerprint);
        this.db.prepare("UPDATE claims SET status = 'approved', device_id = ?, decided_at = ? WHERE id = ?").run(enrollment.deviceId, now, claimId);
        return { deviceId: enrollment.deviceId, fingerprint: enrollment.fingerprint };
      });
    } catch (error) {
      // A canonical device that can never be bound to this claim is revoked so it cannot authenticate anywhere.
      if (diverged) this.fail(claimId, enrollment.deviceId);
      throw error;
    }
  }
  /** Terminal failure of an approval; revokes its canonical device (if any) first. Never creates a second one. */
  private fail(claimId: string, deviceId: string | null): void {
    if (deviceId !== null) {
      try { this.store.revokeDevice(deviceId); } catch { /* fenced host: the device has no binding and never authenticates */ }
    }
    try {
      this.tx(() => { this.db.prepare("UPDATE claims SET status = 'failed', decided_at = ? WHERE id = ? AND status IN ('pending', 'approving')").run(this.clock(), claimId); });
    } catch { /* stays approving: completed or failed again at the next open */ }
  }
  /**
   * Opening recovery. Every `approving` claim is resolved from the canonical journal (same claim id): missing
   * means no device was committed (failed); a matching current enrollment is bound; divergence is revoked.
   * Every existing binding must match its canonical enrollment, otherwise the registry refuses to open.
   */
  private recover(): void {
    for (const row of this.all("SELECT id FROM claims WHERE status = 'approving' ORDER BY created_at, id")) {
      const claimId = row.id as string;
      const enrollment = this.store.findClientDeviceEnrollment({ namespace: APP_CLIENT_NAMESPACE, claimId });
      if (enrollment === null) { this.fail(claimId, null); continue; }
      try { this.activate(claimId, enrollment); } catch (error) {
        if (!(error instanceof DeviceError && error.code === "conflict")) throw error;
      }
    }
    for (const row of this.all("SELECT * FROM client_bindings ORDER BY device_id")) {
      const enrollment = this.store.findClientDeviceEnrollment({ namespace: APP_CLIENT_NAMESPACE, claimId: row.claim_id as string });
      const claim = this.one("SELECT * FROM claims WHERE id = ?", row.claim_id as string);
      if (!enrollment || !claim || claim.status !== "approved" || claim.device_id !== row.device_id || claim.kind !== "pair"
        || enrollment.deviceId !== row.device_id || enrollment.role !== row.role || JSON.stringify([...enrollment.scopes]) !== row.scopes
        || enrollment.digest !== row.enrollment_digest || enrollment.fingerprint !== claim.client_fp) {
        throw new DeviceError("conflict", "client binding does not match its canonical enrollment");
      }
      this.binding(row.device_id as string);
    }
  }
  private hostDevice(id: string): Device | null {
    try { return this.store.getDevice(id); } catch (error) {
      if (error instanceof HostError && error.code === "not_found") return null;
      throw error;
    }
  }
  private bindingRow(deviceId: string): { fp: string; role: ClientDeviceRole; scopes: ClientDeviceScope[]; generation: number; revision: number; status: "active" | "revoked" } | null {
    let row: Row | undefined;
    try { row = this.one("SELECT * FROM client_bindings WHERE device_id = ?", deviceId); } catch (error) {
      if (error instanceof RangeError) throw new DeviceError("conflict", "client binding is invalid");
      throw error;
    }
    if (!row) return null;
    const generation = row.generation, revision = row.revision;
    if (typeof row.fp !== "string" || !FINGERPRINT.test(row.fp) || !counter(generation) || !counter(revision) || revision < generation
      || (row.status !== "active" && row.status !== "revoked") || (row.role !== "client-ios" && row.role !== "client-mac")) {
      throw new DeviceError("conflict", "client binding is invalid");
    }
    return { fp: row.fp, role: row.role, scopes: storedScopes(row.scopes), generation, revision, status: row.status };
  }
  private schemaObjects(): Row[] {
    return this.all("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name");
  }
  /** Closed schema: exactly the expected objects with their exact SQL. Anything else is quarantined. */
  private verifySchema(): void {
    const objects = this.schemaObjects();
    const expected = [...TABLES].sort((a, b) => a[0].localeCompare(b[0]));
    if (objects.length !== expected.length) throw new DeviceError("conflict", "unsupported client schema");
    for (const [i, [name, sql]] of expected.entries()) {
      const actual = objects[i]!;
      if (actual.name !== name || typeof actual.sql !== "string" || normalize(actual.sql) !== normalize(sql)) {
        throw new DeviceError("conflict", "unsupported client schema");
      }
    }
  }
  /** Every pin history is consistent with exactly one binding per bound device. */
  private verifyRows(): void {
    const bad = this.one(`SELECT 1 AS x FROM client_certs c LEFT JOIN client_bindings b ON b.device_id = c.device_id WHERE b.device_id IS NULL
      UNION ALL SELECT 1 FROM client_bindings b LEFT JOIN client_certs c ON c.fp = b.fp AND c.device_id = b.device_id WHERE c.fp IS NULL
      UNION ALL SELECT 1 FROM client_bindings b JOIN client_certs c ON c.fp = b.fp
        WHERE (b.status = 'active' AND c.state != 'active') OR (b.status = 'revoked' AND c.state != 'revoked')
      UNION ALL SELECT 1 FROM client_bindings b JOIN client_certs c ON c.device_id = b.device_id WHERE b.status = 'revoked' AND c.state != 'revoked'
      UNION ALL SELECT 1 FROM client_bindings b WHERE b.generation != (SELECT COUNT(*) FROM client_certs c WHERE c.device_id = b.device_id)
      UNION ALL SELECT 1 FROM offers o WHERE o.kind = 'pair' AND o.device_id IS NOT NULL
      UNION ALL SELECT 1 FROM claims c JOIN offers o ON o.id = c.offer_id WHERE c.role != o.role OR c.scopes != o.scopes OR c.kind != o.kind
      LIMIT 1`);
    if (bad) throw new DeviceError("conflict", "client pin history is inconsistent");
    for (const row of this.all("SELECT scopes, role FROM offers")) { storedScopes(row.scopes); clientRole(row.role); }
    for (const row of this.all("SELECT device_id FROM client_bindings")) this.bindingRow(row.device_id as string);
  }
  private activeCert(deviceId: string): string | null {
    const row = this.one("SELECT fp FROM client_certs WHERE device_id = ? AND state = 'active'", deviceId);
    return row ? (row.fp as string) : null;
  }
  private tx<T>(fn: () => T | Refusal): T {
    if (this.closed) throw new DeviceError("unavailable", "client registry closed");
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
    if (this.closed) throw new DeviceError("unavailable", "client registry closed");
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    if (this.closed) throw new DeviceError("unavailable", "client registry closed");
    return this.db.prepare(sql).all(...params) as Row[];
  }
}
