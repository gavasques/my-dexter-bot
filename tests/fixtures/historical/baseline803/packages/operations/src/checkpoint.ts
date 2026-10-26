import { createHash, createPublicKey } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { vacuumInto, finalizeCopy } from "./capture.js";
import { sha256Text } from "./canonical.js";
import {
  registryCounts, resolveCatalog, surfaceCounts, validateDevices, validateEnrollments,
  type DeviceReconciliation, type OperationPin, type RegistryCounts, type SurfaceCounts,
} from "./devices.js";
import { AUTHORITY_ENVELOPE_PURPOSE, openEnvelope, sealEnvelope, type SnapshotKey } from "./envelope.js";
import { OperationsError, fail } from "./errors.js";
import { OwnedPaths, SQLITE_SIDECARS, absentTarget, existingFile, noSidecars, publishNoReplace, randomSuffix, readBounded, withOwnedCleanup } from "./files.js";
import { checkFullSchema, contextSchemaLabel, agendaSchemaLabel, nativeMcpSchemaLabel, FULL_SCHEMAS, type FullKind } from "./full-schemas.js";
import { GIT_PREFIX, GitSnapshot, inflateObject, readContextGit } from "./git.js";
import {
  PayloadBudget, agendaCounts, contextCounts, gitLimits, hubCountsV2, resolveLimits, sha256,
  type AgendaCounts, type ContextCounts, type ManifestMember, type SnapshotCountsV2, type SnapshotLimits,
} from "./manifest.js";
import { all, checkIntegrity, count, one, openReadOnly, sameIdentity, type Identity } from "./schemas.js";
import { sanitizeNativeMcp, validateNativeMcp, type NativeMcpCounts } from "./native-mcp.js";
import { validateAgenda, validateContext } from "./validate.js";
import { LEDGER_COUNT_TABLES, sanitizeMemoryLedger } from './memory-ledger.js';
import { sanitizeMemoryRoutines, readMemoryRoutineMetadata } from './memory-routines.js';

/**
 * Authority checkpoint artifact (writes version 2, reads versions 1 and 2): the complete, encrypted and authenticated local state of one
 * installation, captured while its authority is held in a transfer checkpoint. Unlike the inspection snapshot it
 * keeps the original data needed to run again (grants, approvals, journals, idempotency keys, enrollments), and it
 * is only ever activated under a separate owner receipt bound to its hash and checkpoint. It is sealed with its own
 * envelope purpose, so neither format can be opened as the other.
 */
export const CHECKPOINT_FORMAT = "dexter-g8-authority-checkpoint";
export const CHECKPOINT_FORMAT_VERSION = 2;
export const CHECKPOINT_COMPONENTS = ["context", "agenda", "deviceRegistry", "deviceSurface", "appClients", "relayConsumer", "relayAssociations", "nativeMcp"] as const;
export type CheckpointComponent = typeof CHECKPOINT_COMPONENTS[number];
export const CHECKPOINT_SOURCE_FILES: Readonly<Record<FullKind, string>> = Object.freeze({
  nativeMcp: "native-mcp.sqlite", hub: "dexter.sqlite", context: "context.sqlite", agenda: "agenda.sqlite", deviceRegistry: "devices.sqlite",
  deviceSurface: "device-tools.sqlite", appClients: "app-clients.sqlite",
  // Frozen relay-host composition (Sol R1): both relay stores live in `<dataDir>/relay-host/`.
  relayConsumer: "relay-host/relay-consumer.sqlite", relayAssociations: "relay-host/relay-associations.sqlite",
});
export const RELAY_HOST_DIRECTORY = "relay-host";
export const CHECKPOINT_MEMBERS: Readonly<Record<FullKind, string>> = Object.freeze({
  nativeMcp: "native-mcp.sqlite", hub: "hub.sqlite", context: "context.sqlite", agenda: "agenda.sqlite", deviceRegistry: "device-registry.sqlite",
  deviceSurface: "device-surface.sqlite", appClients: "app-clients.sqlite", relayConsumer: "relay-consumer.sqlite",
  relayAssociations: "relay-associations.sqlite",
});
export const CONTEXT_REPOSITORY = "context-revisions";
/**
 * Known data-directory entries this format deliberately does not carry. Their presence is recorded in the manifest
 * (never their content) and the destination starts without them: each one must be re-established by its own owner
 * flow, never copied. Any other entry in the data directory fails the capture with `unsupported_component`.
 */
export const CHECKPOINT_EXCLUDED: Readonly<Record<string, string>> = Object.freeze({
  "gateway.sqlite": "app_connections_must_be_reauthorized",
  "managed-apps.sqlite": "provisioning_state_reconnected_upstream",
  "ai-memory-outbox.sqlite": "remote_effect_outbox_never_replayed",
  "mcp-stdio": "temporary_mcp_child_homes_and_cache_recreated",
  "workspaces": "engine_sessions_recreated",
});
/** Never part of the artifact, whatever is present: secrets, other writers and non-exportable material. */
export const CHECKPOINT_EXCLUDED_BY_FORMAT = Object.freeze([
  "host lease token and pid", "engine native cursors", "private keys and certificates (identity directory)", "Keychain, 1Password, OAuth and API tokens",
  "APNs keys", "HealthKit data", "daemon journal", "relay service store", "engine/MCP sockets and CLI homes",
] as const);
/**
 * Relay private custody (signing/decryption keys of the recipient) is never part of the artifact. The public
 * recipient label in `relay-associations.sqlite` cannot recreate it: a destination needs a matching custody provider
 * and explicit owner reapproval before relay runs again.
 */
export const RELAY_CUSTODY = "not_exported_reapproval_required";

export type CheckpointCoverage = { hub: "included" } & Record<CheckpointComponent, "included" | "absent"> & { relayCustody: typeof RELAY_CUSTODY };
export interface AppClientCounts { offers: Record<string, number>; claims: Record<string, number>; certificates: Record<string, number>; bindings: Record<string, number> }
export interface RelayConsumerCounts { operations: Record<string, number>; issuers: number; acknowledgements: Record<string, number>; retainedAckRequests: number }
export interface RelayAssociationCounts { associations: Record<string, number>; history: number; pins: number; hostRevision: number }
export interface CheckpointCounts {
  hub: SnapshotCountsV2["hub"]; context: ContextCounts | null; agenda: AgendaCounts | null; deviceRegistry: RegistryCounts | null;
  deviceSurface: SurfaceCounts | null; appClients: AppClientCounts | null; relayConsumer: RelayConsumerCounts | null;
  relayAssociations: RelayAssociationCounts | null; nativeMcp: NativeMcpCounts | null;
}
export interface CheckpointSourceRecord { ownerId: string; installationId: string; epoch: number; checkpointId: string; directory: string }
export interface CheckpointManifest {
  format: typeof CHECKPOINT_FORMAT; version: 1 | typeof CHECKPOINT_FORMAT_VERSION; capturedAt: number; nodeVersion: string;
  source: CheckpointSourceRecord;
  capture: { fence: "authority_checkpoint"; method: "vacuum_into"; drain: "quiesced_then_store_verified_no_running_work"; atomicity: "single_writer_fence_not_distributed_transaction" };
  coverage: CheckpointCoverage;
  excluded: { present: string[]; byFormat: string[] };
  schemas: Partial<Record<FullKind, string>>;
  members: ManifestMember[];
  counts: CheckpointCounts;
  reconciliation: DeviceReconciliation | null;
  sanitization: { leaseRowsRemoved: number; nativeCursorsCleared: number };
}

const APP_OFFER_STATES = ["open", "claimed", "cancelled", "exhausted"];
const APP_CLAIM_STATES = ["pending", "approving", "approved", "rejected", "failed"];
const APP_CERT_STATES = ["active", "retired", "revoked"];
const APP_BINDING_STATES = ["active", "revoked"];
const RELAY_STATES = ["prepared", "committed", "acked", "blocked", "unknown"];
const RELAY_ACK_STATES = ["pending", "acked"];
const CHECKPOINT_ID = /^ckp_[A-Za-z0-9_-]{16,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const CONTEXT_PATH = /^(skills|artifacts|memory)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.md$/;

function grouped(db: DatabaseSync, table: string, column: string, states: readonly string[]): Record<string, number> {
  const result = Object.fromEntries(states.map((state) => [state, 0])) as Record<string, number>;
  for (const row of all(db, `SELECT ${column} AS s, COUNT(*) AS n FROM ${table} GROUP BY ${column}`)) {
    if (!states.includes(String(row.s))) fail("corrupt", `${table} has an unknown state`);
    result[String(row.s)] = Number(row.n);
  }
  return result;
}
export function appClientCounts(db: DatabaseSync): AppClientCounts {
  return {
    offers: grouped(db, "offers", "status", APP_OFFER_STATES), claims: grouped(db, "claims", "status", APP_CLAIM_STATES),
    certificates: grouped(db, "client_certs", "state", APP_CERT_STATES), bindings: grouped(db, "client_bindings", "status", APP_BINDING_STATES),
  };
}
export function relayConsumerCounts(db: DatabaseSync): RelayConsumerCounts {
  return {
    operations: grouped(db, "operations", "state", RELAY_STATES), issuers: count(db, "SELECT COUNT(*) AS n FROM issuers"),
    acknowledgements: grouped(db, "acknowledgements", "state", RELAY_ACK_STATES),
    retainedAckRequests: count(db, "SELECT COUNT(*) AS n FROM acknowledgements WHERE request_json IS NOT NULL"),
  };
}

export function relayAssociationCounts(db: DatabaseSync): RelayAssociationCounts {
  return {
    associations: grouped(db, "associations", "status", ["active", "revoked"]), history: count(db, "SELECT COUNT(*) AS n FROM history"),
    pins: count(db, "SELECT COUNT(*) AS n FROM pins"), hostRevision: relayRevision(one(db, "SELECT host_revision FROM metadata")?.host_revision),
  };
}

const broken = (message: string): never => fail("reference_broken", message);
// Relay tables are not STRICT. SQLite affinity does not prove a stored counter's type or range.
const relayRevision = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1
  ? value : broken("relay persisted revision is not valid");
const json = (text: unknown): unknown => { try { return JSON.parse(String(text)); } catch { return broken("stored JSON is not valid"); } };

/**
 * App-client registry against the Hub: every binding is an owner app-client enrollment of the Hub with the same
 * role and digest, its pin history is coherent (exactly one active pin while active, only revoked pins once revoked,
 * generation = pins bound), and no client pin is reused. A Hub-revoked device with an active binding is the
 * interrupted-revocation crash window (the registry authenticates it as revoked); it is counted, not repaired.
 */
export function validateAppClients(db: DatabaseSync, hub: DatabaseSync, identity: Identity): { interruptedRevocations: number } {
  const enrollments = new Map(all(hub, "SELECT * FROM client_device_enrollments").map((row) => [String(row.device_id), row]));
  const devices = new Map(all(hub, "SELECT * FROM devices").map((row) => [String(row.id), row]));
  let interruptedRevocations = 0;
  const certs = all(db, "SELECT * FROM client_certs ORDER BY rowid");
  for (const cert of certs) if (!HEX64.test(String(cert.fp))) broken("client certificate is not valid");
  for (const binding of all(db, "SELECT * FROM client_bindings")) {
    const deviceId = String(binding.device_id);
    const enrollment = enrollments.get(deviceId); const device = devices.get(deviceId);
    if (!enrollment || !device || device.owner_id !== identity.ownerId) broken("client binding has no Hub enrollment");
    if (enrollment!.role !== binding.role || enrollment!.digest !== binding.enrollment_digest || binding.scopes !== enrollment!.scopes
      || enrollment!.claim_id !== binding.claim_id) broken("client binding disagrees with its enrollment");
    const claim = one(db, "SELECT * FROM claims WHERE id = ?", String(binding.claim_id));
    if (!claim || claim.status !== "approved" || claim.device_id !== deviceId || claim.role !== binding.role) broken("client binding claim is not approved");
    const history = certs.filter((cert) => cert.device_id === deviceId);
    const active = history.filter((cert) => cert.state === "active"); const revoked = history.filter((cert) => cert.state === "revoked");
    if (history.length !== Number(binding.generation) || Number(binding.revision) < Number(binding.generation)) broken("client pin history disagrees with its binding");
    if (binding.status === "active") {
      if (active.length !== 1 || active[0]!.fp !== binding.fp) broken("active client binding does not hold its pin");
      if (device!.revoked_at !== null) interruptedRevocations += 1;
    } else if (revoked.length !== history.length || !history.some((cert) => cert.fp === binding.fp)) broken("revoked client binding keeps usable pins");
  }
  for (const cert of certs) if (!one(db, "SELECT 1 AS x FROM client_bindings WHERE device_id = ?", String(cert.device_id))) broken("client certificate has no binding");
  for (const claim of all(db, "SELECT * FROM claims")) {
    const offer = one(db, "SELECT * FROM offers WHERE id = ?", String(claim.offer_id));
    if (!offer || offer.kind !== claim.kind || offer.role !== claim.role || offer.scopes !== claim.scopes || offer.status !== "claimed") broken("client claim disagrees with its offer");
  }
  return { interruptedRevocations };
}

/**
 * Relay consumer journal against the Hub: every issuer hash is the digest of its stored provenance, every journal
 * entry references a known issuer, every accepted turn exists in the Hub under the same thread and request id and
 * carries the exact `relay-consumer-v1` source-hash receipt, and retained ACK requests are JSON objects. Entries in
 * `prepared`, `blocked` or `unknown` stay as they are: nothing is redelivered or resumed.
 */
export function validateRelayConsumer(db: DatabaseSync, hub: DatabaseSync): void {
  const issuers = new Set<string>();
  for (const row of all(db, "SELECT * FROM issuers")) {
    if (createHash("sha256").update(String(row.provenance_json)).digest("hex") !== row.hash) broken("relay issuer hash does not match its provenance");
    if (!Array.isArray(json(row.provenance_json))) broken("relay issuer provenance is not valid");
    issuers.add(String(row.hash));
  }
  for (const op of all(db, "SELECT * FROM operations")) {
    if (!issuers.has(String(op.issuer_hash))) broken("relay operation has no issuer");
    if (op.turn_id === null) {
      if (op.thread_id !== null && (op.state === "committed" || op.state === "acked")) broken("committed relay turn has no Hub turn");
      continue;
    }
    if (op.thread_id === null) broken("relay notice carries a turn");
    const turn = one(hub, "SELECT * FROM turns WHERE id = ?", String(op.turn_id));
    if (!turn || turn.thread_id !== op.thread_id || turn.client_request_id !== op.request_id) broken("relay operation turn is missing from the Hub");
    const queued = all(hub, "SELECT data FROM turn_events WHERE turn_id = ? AND kind = 'turn.queued'", String(op.turn_id));
    const receipt = queued.length === 1 ? json(queued[0]!.data) as Record<string, unknown> | null : null;
    if (!receipt || typeof receipt !== "object" || Object.keys(receipt).length !== 2 || receipt.source !== "relay-consumer-v1" || receipt.hash !== op.logical_hash) {
      broken("relay operation source receipt does not match the Hub");
    }
  }
  for (const ack of all(db, "SELECT * FROM acknowledgements")) {
    if (!issuers.has(String(ack.issuer_hash))) broken("relay acknowledgement has no issuer");
    if (ack.request_json !== null) {
      const value = json(ack.request_json);
      if (value === null || typeof value !== "object" || Array.isArray(value)) broken("retained relay ACK request is not valid");
    }
  }
}

// Persisted JSON is already a plain JSON value, so no live-object/proxy snapshot or custody dependency is needed.
// Keep this version-1 closed grammar aligned with relay-host binding() and relay/protocol pin().
const relayObject = (text: unknown, keys: readonly string[]): Record<string, unknown> => {
  const value = json(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    return broken("relay association JSON grammar is not valid");
  }
  return value as Record<string, unknown>;
};
const relayId = (value: unknown): void => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) broken("relay association identity is not valid");
};
const relayPin = (text: unknown): Record<string, unknown> => {
  const pin = relayObject(text, ["installationId", "ownerId", "deviceId", "generation", "keyId", "signingPublicKey", "encryptionPublicKey"]);
  for (const key of ["installationId", "ownerId", "deviceId", "keyId"]) relayId(pin[key]);
  relayRevision(pin.generation);
  for (const [field, algorithm] of [["signingPublicKey", "ed25519"], ["encryptionPublicKey", "x25519"]] as const) {
    const value = pin[field];
    if (typeof value !== "string" || value.length > 172 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) broken("relay public key is not valid");
    try {
      const bytes = Buffer.from(value as string, "base64");
      if (bytes.length > 128 || bytes.toString("base64") !== value) return broken("relay public key is not canonical");
      const key = createPublicKey({ key: bytes, type: "spki", format: "der" });
      if (key.asymmetricKeyType !== algorithm || !key.export({ type: "spki", format: "der" }).equals(bytes)) broken("relay public key is not canonical");
    } catch { broken("relay public key is not valid"); }
  }
  return pin;
};
const relayBinding = (text: unknown): Record<string, unknown> => {
  const binding = relayObject(text, ["installationId", "ownerId", "deviceId", "role", "scopes", "fingerprint", "generation", "revision", "status"]);
  for (const key of ["installationId", "ownerId", "deviceId"]) relayId(binding[key]);
  relayRevision(binding.generation); relayRevision(binding.revision);
  if (!["client-ios", "client-mac"].includes(binding.role as string) || !["active", "revoked"].includes(binding.status as string)
    || typeof binding.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(binding.fingerprint)) broken("relay binding is not valid");
  const scopes = binding.scopes;
  const allowed = ["approvals.decide", "approvals.read", "chat.read", "chat.write", "devices.manage", "devices.read", "grants.manage", "grants.read"];
  if (!Array.isArray(scopes) || scopes.length > 8 || scopes.some(scope => typeof scope !== "string" || !allowed.includes(scope))
    || new Set(scopes).size !== scopes.length) broken("relay binding scopes are not valid");
  return binding;
};

/** Validate relay's persisted version-1 grammar and references before capture or destination authority publication.
 * Revoked associations may retain older host revisions; sender generations are independent of host generation.
 * Tombstones, history and public pins are retained exactly; validation never reactivates or normalizes stored rows.
 */
export function validateRelayAssociations(db: DatabaseSync): void {
  const meta = one(db, "SELECT * FROM metadata")!;
  const hostRevision = relayRevision(meta.host_revision);
  relayId(meta.host_id); relayId(meta.owner_id);
  const recipient = relayPin(meta.recipient_json);
  const recipientDevice = recipient.deviceId as string;
  if (recipient.installationId !== meta.host_id || recipient.ownerId !== meta.owner_id) broken("relay recipient identity disagrees with its host");
  if (relayRevision(recipient.generation) !== hostRevision) broken("relay recipient generation disagrees with its host");
  // The columns are not STRICT: an INTEGER column can keep TEXT/REAL, and Number('invalid') is NaN, which makes every
  // ordering comparison false. A revision must be a stored positive safe integer before it is ordered.
  const revision = relayRevision;
  for (const row of all(db, "SELECT * FROM associations")) {
    const rowHostRevision = revision(row.host_revision), rowRevision = revision(row.revision);
    relayBinding(row.binding_json); relayPin(row.sender_json);
    const history = all(db, "SELECT * FROM history WHERE device_id = ? ORDER BY revision", String(row.device_id));
    if (history.length === 0 || history.some((entry, index) => revision(entry.revision) !== index + 1) || revision(history.at(-1)!.revision) !== rowRevision) {
      broken("relay association history is not contiguous");
    }
    const last = history.at(-1)!;
    if ((last.action === "enroll") !== (row.status === "active") || !["enroll", "revoke", "recipient"].includes(String(last.action))) broken("relay association status disagrees with its history");
    if (row.binding_json !== last.binding_json || row.sender_json !== last.sender_json) broken("relay association disagrees with its history");
    // A recipient rotation only tombstones an enrolled association: same binding and sender, the rotated host revision
    // (which equals the new recipient pin generation, archived in `pins`), never newer than the host.
    history.forEach((entry, index) => {
      if (entry.action !== "recipient") return;
      const prior = index > 0 ? history[index - 1]! : null;
      if (!prior || prior.action !== "enroll" || entry.binding_json !== prior.binding_json || entry.sender_json !== prior.sender_json) {
        return broken("relay association recipient rotation is not valid");
      }
      const enrolled = revision(prior.host_revision), rotated = revision(entry.host_revision);
      if (rotated <= enrolled || rotated > hostRevision
        || !one(db, "SELECT 1 AS x FROM pins WHERE device_id = ? AND generation = ?", recipientDevice, rotated)) {
        broken("relay association recipient rotation is not valid");
      }
    });
    if (rowHostRevision > hostRevision || (row.status === "active" && rowHostRevision !== hostRevision)) broken("relay association host revision disagrees with its host");
    if (history[0]!.action !== "enroll") broken("relay history must begin with enrollment");
  }
  for (const entry of all(db, "SELECT * FROM history")) {
    const binding = relayBinding(entry.binding_json), sender = relayPin(entry.sender_json);
    if (entry.device_id !== binding.deviceId || binding.installationId !== meta.host_id || binding.ownerId !== meta.owner_id
      || sender.deviceId !== binding.deviceId || sender.installationId !== binding.installationId || sender.ownerId !== binding.ownerId) {
      broken("relay history identity disagrees with its host");
    }
    if (!one(db, "SELECT 1 AS x FROM pins WHERE device_id = ? AND generation = ? AND pin_json = ?",
      sender.deviceId as string, sender.generation as number, JSON.stringify(sender))) broken("relay history sender has no archived pin");
    revision(entry.revision);
    if (revision(entry.host_revision) > hostRevision) broken("relay history is newer than its host");
    if (!one(db, "SELECT 1 AS x FROM associations WHERE device_id = ?", String(entry.device_id))) broken("relay history has no association");
  }
  const generations = new Map<string, number>();
  let recipientGeneration = 0;
  for (const pin of all(db, "SELECT * FROM pins ORDER BY device_id, generation")) {
    const parsed = relayPin(pin.pin_json);
    const generation = revision(pin.generation), device = String(pin.device_id);
    if (parsed.generation !== generation || parsed.deviceId !== pin.device_id || parsed.keyId !== pin.key_id
      || parsed.signingPublicKey !== pin.signing_key || parsed.encryptionPublicKey !== pin.encryption_key
      || parsed.installationId !== meta.host_id || parsed.ownerId !== meta.owner_id) broken("relay pin disagrees with its row or host");
    if (generation !== (generations.get(device) ?? 0) + 1) broken("relay pin generations are not contiguous");
    generations.set(device, generation);
    if (device === recipientDevice) recipientGeneration = generation;
  }
  if (recipientGeneration !== hostRevision) broken("relay recipient pins disagree with its host");
  const current = one(db, "SELECT pin_json FROM pins WHERE device_id = ? AND generation = ?", recipientDevice, hostRevision);
  if (!current || JSON.stringify(relayPin(current.pin_json)) !== JSON.stringify(recipient)) broken("relay recipient has no matching archived pin");
}

// ---- capture -------------------------------------------------------------------------------------

/** The held checkpoint of a `HostStore` (structural, so this package never opens the source itself). */
export interface CheckpointSource {
  readonly databasePath: string;
  readonly hostId: string;
  readonly ownerId: string;
  withCheckpointFence<T>(checkpointId: string, operation: () => T): T;
}
export interface CheckpointCaptureOptions {
  source: CheckpointSource;
  checkpoint: { checkpointId: string; epoch: number; directory: string };
  key: SnapshotKey;
  output: string;
  /** Reviewed device operation pins; required when the device surface exists. */
  operationCatalog?: readonly OperationPin[];
  limits?: Partial<SnapshotLimits>;
  clock?: () => number;
  /**
   * Staging owned through the coordinator: the name reserved there before creation, and a callback that records the
   * created directory's inode before any plaintext is written into it. Without it a random private name is used.
   */
  staging?: { name: string; created(ino: string): void };
}
export interface CheckpointCaptureReceipt {
  path: string; bytes: number; artifactSha256: string; manifestSha256: string; keyId: string; capturedAt: number;
  source: CheckpointSourceRecord; coverage: CheckpointCoverage; excludedPresent: string[]; counts: CheckpointCounts;
  reconciliation: DeviceReconciliation | null; members: number;
}

const sidecarOf = (name: string): string | null => {
  for (const suffix of SQLITE_SIDECARS) if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  return null;
};
/**
 * Closed scan of the data directory: known components, the Context repository, the frozen `relay-host/` directory
 * (exactly its two stores and their WAL sidecars) and the declared exclusions only. Anything else, including a relay
 * store outside `relay-host/`, fails with `unsupported_component` instead of being dropped.
 */
function scanDataDirectory(dataDir: string): { present: Set<FullKind>; contextGit: boolean; excludedPresent: string[] } {
  const files = new Map(Object.entries(CHECKPOINT_SOURCE_FILES).map(([kind, file]) => [file, kind as FullKind]));
  const present = new Set<FullKind>(); const excluded = new Set<string>(); let contextGit = false;
  const known = (relative: string): boolean => {
    const base = sidecarOf(relative) ?? relative;
    if (!files.has(base)) return false;
    if (base === relative) present.add(files.get(base)!);
    return true;
  };
  for (const name of readdirSync(dataDir).sort()) {
    if (name === RELAY_HOST_DIRECTORY) {
      const stat = lstatSync(join(dataDir, name));
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail("unsafe_path", "relay-host is not a private directory");
      for (const inner of readdirSync(join(dataDir, name)).sort()) {
        if (!known(`${RELAY_HOST_DIRECTORY}/${inner}`)) fail("unsupported_component", "relay-host holds a store this format has not adopted");
      }
      continue;
    }
    if (known(name)) continue;
    const base = sidecarOf(name) ?? name;
    if (name === CONTEXT_REPOSITORY) { contextGit = true; continue; }
    if (Object.hasOwn(CHECKPOINT_EXCLUDED, base) && (base === name || base.endsWith(".sqlite"))) { excluded.add(base); continue; }
    fail("unsupported_component", "the data directory holds a store this format has not adopted");
  }
  if (contextGit !== present.has("context")) fail("unsupported_component", "Context index and repository must be present together");
  if (present.has("deviceSurface") && !present.has("deviceRegistry")) fail("reference_broken", "device surface requires the device registry");
  return { present, contextGit, excludedPresent: [...excluded].sort() };
}

function closedHubCopy(path: string): { leaseRowsRemoved: number; nativeCursorsCleared: number } {
  noSidecars(path);
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 0 });
  try {
    db.exec("PRAGMA journal_mode = DELETE; PRAGMA secure_delete = ON;");
    checkFullSchema(db, "hub");
    db.exec("BEGIN IMMEDIATE");
    let report: { leaseRowsRemoved: number; nativeCursorsCleared: number };
    try {
      report = {
        leaseRowsRemoved: Number(db.prepare("DELETE FROM host_lease").run().changes),
        nativeCursorsCleared: Number(db.prepare("UPDATE thread_sessions SET native_cursor = NULL WHERE native_cursor IS NOT NULL").run().changes),
      };
      db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    db.exec("VACUUM");
    return report;
  } finally { db.close(); }
}

/** The authority row of a Hub copy must be exactly the receipted checkpoint, with nothing running. */
export function checkCheckpointAuthority(hub: DatabaseSync, source: CheckpointSourceRecord): void {
  const rows = all(hub, "SELECT * FROM host_authority");
  const row = rows[0];
  if (rows.length !== 1 || !row || row.installation_id !== source.installationId || row.owner_id !== source.ownerId) fail("identity_mismatch", "hub authority belongs to another installation");
  if (row.state !== "checkpointed" || row.checkpoint_id !== source.checkpointId || Number(row.epoch) !== source.epoch || row.directory !== source.directory) {
    fail("authority_unavailable", "hub copy is not the checkpointed authority");
  }
  if (count(hub, "SELECT (SELECT COUNT(*) FROM actions WHERE state = 'running') + (SELECT COUNT(*) FROM turns WHERE state = 'running') AS n") !== 0) {
    fail("corrupt", "checkpoint copy carries running work");
  }
}

/** Every reference across the stores, on read-only copies. Returns device reconciliation and the counts. */
export function validateCheckpointStores(
  opened: Partial<Record<FullKind, DatabaseSync>>, git: { snapshot: GitSnapshot; objects: number } | null, identity: Identity,
  catalog: ReturnType<typeof resolveCatalog> | null,
): { counts: CheckpointCounts; reconciliation: DeviceReconciliation | null; appClientInterrupted: number } {
  const hub = opened.hub!;
  validateEnrollments(hub, identity);
  if (opened.context) { if (!git) fail("corrupt", "Context has no repository"); validateContext(opened.context, hub, git!.snapshot); }
  if (opened.context && readMemoryRoutineMetadata(opened.context) && count(hub,"SELECT COUNT(*) AS n FROM grants WHERE tool='dexter.memory.policy.update' AND destination='dexter-memory-routines' AND policy<>'deny'") !== 0) fail('corrupt', 'Checkpoint carries effective memory capture authority.');
  if (opened.agenda) validateAgenda(opened.agenda, hub);
  let reconciliation: DeviceReconciliation | null = null;
  if (opened.deviceRegistry) {
    reconciliation = validateDevices({ hub, registry: opened.deviceRegistry, surface: opened.deviceSurface ?? null, identity, catalog, sanitizedDevices: new Set() });
  }
  const appClientInterrupted = opened.appClients ? validateAppClients(opened.appClients, hub, identity).interruptedRevocations : 0;
  if (opened.relayConsumer) validateRelayConsumer(opened.relayConsumer, hub);
  if (opened.relayAssociations) validateRelayAssociations(opened.relayAssociations);
  const nativeMcp = opened.nativeMcp ? validateNativeMcp(opened.nativeMcp, hub) : null;
  const gitObjects = git ? git.objects : 0;
  return {
    counts: {
      hub: hubCountsV2(hub), context: opened.context ? contextCounts(opened.context, gitObjects) : null, agenda: opened.agenda ? agendaCounts(opened.agenda) : null,
      deviceRegistry: opened.deviceRegistry ? registryCounts(opened.deviceRegistry) : null,
      deviceSurface: opened.deviceSurface ? surfaceCounts(opened.deviceSurface) : null,
      appClients: opened.appClients ? appClientCounts(opened.appClients) : null,
      relayConsumer: opened.relayConsumer ? relayConsumerCounts(opened.relayConsumer) : null,
      relayAssociations: opened.relayAssociations ? relayAssociationCounts(opened.relayAssociations) : null, nativeMcp,
    },
    reconciliation, appClientInterrupted,
  };
}
export function gitSnapshotOf(members: ReadonlyMap<string, Buffer>, limits: SnapshotLimits): { snapshot: GitSnapshot; objects: number } {
  return { snapshot: new GitSnapshot(members, gitLimits(limits)), objects: [...members.keys()].filter((name) => name.startsWith(`${GIT_PREFIX}objects/`)).length };
}

/**
 * Captures the complete checkpoint artifact. The whole source read is one synchronous callback inside the held
 * checkpoint fence (lease and exact checkpoint, every writer refused); afterwards only staged copies are touched.
 */
export function captureCheckpointArtifact(options: CheckpointCaptureOptions): CheckpointCaptureReceipt {
  const { source, key, checkpoint } = options;
  if (!source || typeof source.withCheckpointFence !== "function" || basename(String(source.databasePath)) !== "dexter.sqlite") fail("fence_unavailable", "an explicit checkpoint fence is required");
  if (!checkpoint || !CHECKPOINT_ID.test(String(checkpoint.checkpointId)) || !Number.isSafeInteger(checkpoint.epoch) || checkpoint.epoch < 1) fail("invalid_input", "checkpoint is not valid");
  const limits = resolveLimits(options.limits);
  const clock = options.clock ?? Date.now;
  const dataDir = dirname(source.databasePath);
  if (checkpoint.directory !== dataDir) fail("identity_mismatch", "checkpoint directory is not the source directory");
  const identity: Identity = { ownerId: source.ownerId, installationId: source.hostId };
  const { parent, name } = absentTarget(options.output);
  const owned = new OwnedPaths();
  const staging = join(parent, options.staging ? options.staging.name : `.${name}.checkpoint-${randomSuffix()}`);
  if (options.staging && (dirname(staging) !== parent || !/^\.[A-Za-z0-9._-]+$/.test(options.staging.name))) fail("unsafe_path", "staging name is not valid");
  const budget = new PayloadBudget(limits, typeof key?.keyId === "string" ? key.keyId : "", AUTHORITY_ENVELOPE_PURPOSE);
  const record: CheckpointSourceRecord = { ownerId: identity.ownerId, installationId: identity.installationId, epoch: checkpoint.epoch, checkpointId: checkpoint.checkpointId, directory: dataDir };

  return withOwnedCleanup(owned, () => {
    owned.mkdir(staging);
    options.staging?.created(lstatSync(staging, { bigint: true }).ino.toString());
    const staged = (kind: FullKind): string => join(staging, CHECKPOINT_MEMBERS[kind]);
    let scan: ReturnType<typeof scanDataDirectory> | undefined;
    let git = new Map<string, Buffer>();
    let capturedAt = 0;
    const fenced: unknown = source.withCheckpointFence(checkpoint.checkpointId, () => {
      capturedAt = clock();
      scan = scanDataDirectory(dataDir);
      for (const kind of ["hub", ...CHECKPOINT_COMPONENTS] as FullKind[]) {
        if (kind !== "hub" && !scan.present.has(kind)) continue;
        vacuumInto(kind, (db) => checkFullSchema(db, kind), join(dataDir, CHECKPOINT_SOURCE_FILES[kind]), staged(kind), identity, limits, owned);
        if (kind === "context") git = readContextGit(join(dataDir, CONTEXT_REPOSITORY), gitLimits(limits), (member, bytes) => budget.admit(member, bytes));
      }
      return undefined;
    });
    if (fenced !== undefined || !scan) fail("fence_unavailable", "checkpoint fence returned unexpectedly");
    if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) fail("invalid_input", "clock must return epoch milliseconds");
    const kinds = (["hub", ...CHECKPOINT_COMPONENTS] as FullKind[]).filter((kind) => kind === "hub" || scan!.present.has(kind));
    const catalog = scan.present.has("deviceSurface") ? resolveCatalog(options.operationCatalog) : null;

    const sanitization = closedHubCopy(staged("hub"));
    if (scan.present.has('context')) sanitizeMemoryRoutines(staged('context'), staged('hub'), capturedAt);
    if (scan.present.has('context')) sanitizeMemoryLedger(staged('context'),staged('hub'));
    if (scan.present.has("nativeMcp")) sanitizeNativeMcp(staged("nativeMcp"), staged("hub"));
    for (const kind of kinds) if (kind !== "hub") finalizeCopy(staged(kind));
    const opened: Partial<Record<FullKind, DatabaseSync>> = {};
    let validated: ReturnType<typeof validateCheckpointStores>;
    let hubSchemaLabel="";
    let agendaLabel="agenda-v3";
    let contextLabel="";
    let nativeMcpLabel="";
    try {
      for (const kind of kinds) {
        noSidecars(staged(kind));
        const db = openReadOnly(staged(kind)); opened[kind] = db;
        if (!sameIdentity(checkFullSchema(db, kind), identity)) fail("identity_mismatch", `${kind} copy belongs to another installation`);
        if(kind==="hub")hubSchemaLabel=`hub-v${Number(one(db,"PRAGMA user_version")?.user_version)}`;
        if(kind==="context")contextLabel=contextSchemaLabel(db);
        if(kind==="agenda")agendaLabel=agendaSchemaLabel(db);
        if(kind==="nativeMcp")nativeMcpLabel=nativeMcpSchemaLabel(db);
        checkIntegrity(db, kind);
      }
      checkCheckpointAuthority(opened.hub!, record);
      if (count(opened.hub!, "SELECT COUNT(*) AS n FROM host_lease") !== 0) fail("corrupt", "checkpoint copy still carries a lease");
      validated = validateCheckpointStores(opened, opened.context ? gitSnapshotOf(git, limits) : null, identity, catalog);
    } finally {
      for (const db of Object.values(opened)) db.close();
    }

    const payloadMembers = new Map<string, Buffer>();
    for (const kind of kinds) {
      noSidecars(staged(kind));
      payloadMembers.set(CHECKPOINT_MEMBERS[kind], readBounded(staged(kind), limits.maxDatabaseBytes, (bytes) => budget.admit(CHECKPOINT_MEMBERS[kind], bytes)));
    }
    for (const [member, bytes] of git) payloadMembers.set(member, bytes);
    if (payloadMembers.size > limits.maxMembers) fail("quota_exceeded", "artifact has too many members");
    const coverage = { hub: "included", relayCustody: RELAY_CUSTODY } as CheckpointCoverage;
    for (const component of CHECKPOINT_COMPONENTS) coverage[component] = scan.present.has(component) ? "included" : "absent";
    const manifest: CheckpointManifest = {
      format: CHECKPOINT_FORMAT, version: CHECKPOINT_FORMAT_VERSION, capturedAt, nodeVersion: process.version, source: record,
      capture: { fence: "authority_checkpoint", method: "vacuum_into", drain: "quiesced_then_store_verified_no_running_work", atomicity: "single_writer_fence_not_distributed_transaction" },
      coverage, excluded: { present: scan.excludedPresent, byFormat: [...CHECKPOINT_EXCLUDED_BY_FORMAT] },
      schemas: Object.fromEntries(kinds.map((kind) => [kind, kind==="hub" ? hubSchemaLabel : kind==="context" ? contextLabel : kind==="agenda"?agendaLabel:kind==="nativeMcp"?nativeMcpLabel:FULL_SCHEMAS[kind].label])),
      members: [...payloadMembers].map(([member, bytes]) => ({ name: member, bytes: bytes.length, sha256: sha256(bytes) })),
      counts: validated.counts, reconciliation: validated.reconciliation, sanitization,
    };
    const { payload, manifestSha256 } = encodeCheckpointPayload(manifest, payloadMembers, budget);
    const envelope = sealEnvelope(payload, key, AUTHORITY_ENVELOPE_PURPOSE);
    payload.fill(0);
    if (envelope.length > limits.maxArtifactBytes) fail("corrupt", "sealed artifact size disagrees with its admission");
    const temporary = join(staging, "artifact.partial");
    owned.write(temporary, envelope);
    publishNoReplace(owned, temporary, options.output);
    if (!owned.cleanup()) throw new OperationsError("cleanup_incomplete", "artifact published but checkpoint staging was not fully removed");
    return {
      path: options.output, bytes: envelope.length, artifactSha256: sha256(envelope), manifestSha256, keyId: key.keyId, capturedAt, source: record,
      coverage, excludedPresent: scan.excludedPresent, counts: validated.counts, reconciliation: validated.reconciliation, members: manifest.members.length,
    };
  });
}

// ---- payload ---------------------------------------------------------------------------------------

function encodeCheckpointPayload(manifest: CheckpointManifest, members: ReadonlyMap<string, Buffer>, budget: PayloadBudget): { payload: Buffer; manifestSha256: string } {
  const text = Buffer.from(JSON.stringify(manifest), "utf8");
  budget.exact(text.length, manifest.members.reduce((total, member) => total + member.bytes, 0));
  const length = Buffer.alloc(4); length.writeUInt32BE(text.length);
  return { payload: Buffer.concat([length, text, ...manifest.members.map((member) => members.get(member.name)!)]), manifestSha256: sha256(text) };
}

type Record_ = Record<string, unknown>;
function closed(value: unknown, keys: readonly string[]): Record_ {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    fail("corrupt", "checkpoint manifest is not valid");
  }
  return value as Record_;
}
const natural = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("corrupt", "checkpoint manifest number is not valid");
  return value as number;
};
const text = (value: unknown, max = 1024): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail("corrupt", "checkpoint manifest text is not valid");
  return value as string;
};
function stateCounts(value: unknown, states: readonly string[]): Record<string, number> {
  const record = closed(value, states);
  return Object.fromEntries(states.map((state) => [state, natural(record[state])]));
}

/**
 * Closed decode. Member names are the fixed component members plus allowlisted Context Git members; counts must be
 * present exactly for the included components. Values are re-derived from the staged copies and compared again.
 */
export function decodeCheckpointManifest(value: unknown, limits: SnapshotLimits): CheckpointManifest {
  const record = closed(value, ["format", "version", "capturedAt", "nodeVersion", "source", "capture", "coverage", "excluded", "schemas", "members", "counts", "reconciliation", "sanitization"]);
  if (record.format !== CHECKPOINT_FORMAT || (record.version !== 1 && record.version !== CHECKPOINT_FORMAT_VERSION)) fail("unsupported_schema", "checkpoint format is unsupported");
  const source = closed(record.source, ["ownerId", "installationId", "epoch", "checkpointId", "directory"]);
  if (!CHECKPOINT_ID.test(text(source.checkpointId)) || natural(source.epoch) < 1) fail("corrupt", "checkpoint source is not valid");
  const capture = closed(record.capture, ["fence", "method", "drain", "atomicity"]);
  if (capture.fence !== "authority_checkpoint" || capture.method !== "vacuum_into" || capture.drain !== "quiesced_then_store_verified_no_running_work"
    || capture.atomicity !== "single_writer_fence_not_distributed_transaction") fail("unsupported_schema", "checkpoint capture method is unsupported");
  const legacy = record.version === 1;
  const components = legacy ? CHECKPOINT_COMPONENTS.filter(kind => kind !== "nativeMcp") : CHECKPOINT_COMPONENTS;
  const coverageRecord = closed(record.coverage, ["hub", ...components, "relayCustody"]);
  if (legacy) coverageRecord.nativeMcp = "absent";
  if (coverageRecord.hub !== "included" || coverageRecord.relayCustody !== RELAY_CUSTODY) fail("unsupported_schema", "checkpoint coverage is unsupported");
  const coverage = { hub: "included", relayCustody: RELAY_CUSTODY } as CheckpointCoverage;
  for (const component of CHECKPOINT_COMPONENTS) {
    if (coverageRecord[component] !== "included" && coverageRecord[component] !== "absent") fail("corrupt", "checkpoint coverage is not valid");
    coverage[component] = coverageRecord[component] as "included" | "absent";
  }
  const excluded = closed(record.excluded, ["present", "byFormat"]);
  if (!Array.isArray(excluded.present) || excluded.present.some((name) => typeof name !== "string" || !Object.hasOwn(CHECKPOINT_EXCLUDED, name))
    || new Set(excluded.present).size !== excluded.present.length || JSON.stringify(excluded.byFormat) !== JSON.stringify(CHECKPOINT_EXCLUDED_BY_FORMAT)) {
    fail("unsupported_schema", "checkpoint exclusions are unsupported");
  }
  const kinds = (["hub", ...CHECKPOINT_COMPONENTS] as FullKind[]).filter((kind) => kind === "hub" || coverage[kind as CheckpointComponent] === "included");
  const schemas = closed(record.schemas, kinds);
  for (const kind of kinds) {
    // Historical authority artifacts retain their original Hub label; staged database bytes are still
    // checked against the corresponding exact schema before activation. Context also preserves its exact
    // pre-document catalog alongside the known additive document catalog. Other stores remain pinned.
    const supported = kind === "hub" ? ["hub-v4", "hub-v5", "hub-v6", "hub-v7", "hub-v8", "hub-v9", "hub-v10", "hub-v11", "hub-v12", "hub-v13", "hub-v14"].includes(schemas[kind] as string)
      : kind === "context" ? ["context-v1", "context-v1-bot-documents", "context-v2-document-history", "context-v2-document-history-memory-routines-v1", "context-v3-memory-ledger", "context-v3-memory-ledger-memory-routines-v1"].includes(schemas[kind] as string)
      : kind==="agenda" ? ["agenda-v2","agenda-v3"].includes(String(schemas[kind]))
      : kind==="nativeMcp" ? ["native-mcp-v1","native-mcp-v2","native-mcp-v3"].includes(String(schemas[kind])) : schemas[kind] === FULL_SCHEMAS[kind].label;
    if (!supported) fail("unsupported_schema", `${kind} schema of the checkpoint is unsupported`);
  }
  if (!Array.isArray(record.members) || record.members.length === 0) fail("corrupt", "checkpoint members are not valid");
  if ((record.members as unknown[]).length > limits.maxMembers) fail("quota_exceeded", "checkpoint has too many members");
  const names = new Set<string>();
  let total = 0;
  const members = (record.members as unknown[]).map((raw) => {
    const member = closed(raw, ["name", "bytes", "sha256"]);
    const name = text(member.name, 200);
    const database = kinds.some((kind) => CHECKPOINT_MEMBERS[kind] === name);
    if ((!database && !/^context-git\/(?:HEAD|refs\/heads\/master|objects\/[0-9a-f]{2}\/[0-9a-f]{38})$/.test(name)) || names.has(name)) fail("corrupt", "checkpoint member is not allowed");
    if (!database && coverage.context !== "included") fail("corrupt", "Git member without Context");
    names.add(name);
    if (!HEX64.test(String(member.sha256))) fail("corrupt", "checkpoint member digest is not valid");
    // Per-member quota of the caller (a database or one Git file), admitted before any member is sliced or staged.
    const bytes = natural(member.bytes);
    if (bytes > (database ? limits.maxDatabaseBytes : limits.maxGitObjectBytes)) fail("quota_exceeded", "checkpoint member exceeds the size limit");
    total += bytes;
    if (total > limits.maxArtifactBytes) fail("quota_exceeded", "checkpoint members exceed the artifact limit");
    return { name, bytes, sha256: String(member.sha256) };
  });
  for (const kind of kinds) if (!names.has(CHECKPOINT_MEMBERS[kind])) fail("corrupt", `${kind} member is missing`);
  if (coverage.context === "included" && !names.has(`${GIT_PREFIX}HEAD`)) fail("corrupt", "Context Git HEAD is missing");
  const counts = record.counts as CheckpointCounts;
  closed(counts, ["hub", ...components]);
  if (legacy) counts.nativeMcp = null;
  if (counts.nativeMcp) {
    const v3 = schemas.nativeMcp === "native-mcp-v3";
    const v2 = schemas.nativeMcp === "native-mcp-v2" || v3;
    const mcp = closed(counts.nativeMcp, ["servers", "catalogs", "selections", "connections", ...(v2 ? ["setupReceipts"] : []), ...(v3 ? ["instanceSelectionHeads","instanceSelectionReceipts"] : [])]);
    for (const value of Object.values(mcp)) natural(value);
    if(v3&&(Number(mcp.instanceSelectionHeads)>256||Number(mcp.instanceSelectionReceipts)>256))fail("corrupt","native MCP instance selection journal exceeds its bound");
    if (v2 && Number(mcp.setupReceipts) > 4096) fail("corrupt", "native MCP receipt count exceeds its journal bound");
  }
  for (const component of CHECKPOINT_COMPONENTS) if ((counts[component] !== null) !== (coverage[component] === "included")) fail("corrupt", `${component} counts disagree with coverage`);
  if(counts.context){
    const routines=String(schemas.context).endsWith("-memory-routines-v1");
    const ledger=String(schemas.context).startsWith("context-v3-memory-ledger");
    const fields=["artifacts","revisions","skills","activations","memories","gitObjects",...(["context-v2-document-history","context-v2-document-history-memory-routines-v1","context-v3-memory-ledger","context-v3-memory-ledger-memory-routines-v1"].includes(String(schemas.context))?["botDocuments","documentRevisions","documentReceipts"]:[]),...(routines?["routinePolicies","routinePolicyReceipts","routineJobs"]:[]),...(ledger?Object.keys(LEDGER_COUNT_TABLES):[])];
    const context=closed(counts.context,fields);for(const value of Object.values(context))natural(value);
    if(routines&&(Number(context.routinePolicies)>32||Number(context.routinePolicyReceipts)>160||Number(context.routineJobs)>128))fail('corrupt','Memory routine counts exceed bounded registry.');
  }
  if (counts.appClients) {
    const app = closed(counts.appClients, ["offers", "claims", "certificates", "bindings"]);
    stateCounts(app.offers, APP_OFFER_STATES); stateCounts(app.claims, APP_CLAIM_STATES); stateCounts(app.certificates, APP_CERT_STATES); stateCounts(app.bindings, APP_BINDING_STATES);
  }
  if (counts.relayAssociations) {
    const relay = closed(counts.relayAssociations, ["associations", "history", "pins", "hostRevision"]);
    stateCounts(relay.associations, ["active", "revoked"]); natural(relay.history); natural(relay.pins); natural(relay.hostRevision);
  }
  if (counts.relayConsumer) {
    const relay = closed(counts.relayConsumer, ["operations", "issuers", "acknowledgements", "retainedAckRequests"]);
    stateCounts(relay.operations, RELAY_STATES); natural(relay.issuers); stateCounts(relay.acknowledgements, RELAY_ACK_STATES); natural(relay.retainedAckRequests);
  }
  const sanitization = closed(record.sanitization, ["leaseRowsRemoved", "nativeCursorsCleared"]);
  if ((record.reconciliation !== null) !== (coverage.deviceRegistry === "included")) fail("corrupt", "device reconciliation disagrees with coverage");
  return {
    format: CHECKPOINT_FORMAT, version: record.version as 1 | 2, capturedAt: natural(record.capturedAt), nodeVersion: text(record.nodeVersion, 64),
    source: { ownerId: text(source.ownerId), installationId: text(source.installationId), epoch: natural(source.epoch), checkpointId: String(source.checkpointId), directory: text(source.directory) },
    capture: capture as CheckpointManifest["capture"], coverage, excluded: { present: [...excluded.present as string[]], byFormat: [...CHECKPOINT_EXCLUDED_BY_FORMAT] },
    schemas: schemas as CheckpointManifest["schemas"], members, counts, reconciliation: record.reconciliation as DeviceReconciliation | null,
    sanitization: { leaseRowsRemoved: natural(sanitization.leaseRowsRemoved), nativeCursorsCleared: natural(sanitization.nativeCursorsCleared) },
  };
}

export interface OpenedCheckpoint { manifest: CheckpointManifest; members: Map<string, Buffer>; artifactSha256: string; manifestSha256: string }
/** Bounded read of the artifact file, authenticated decryption under the checkpoint purpose and strict decode. */
export function openCheckpointArtifact(path: string, key: SnapshotKey, limitsInput?: Partial<SnapshotLimits>): OpenedCheckpoint {
  const limits = resolveLimits(limitsInput);
  const bytes = readBounded(existingFile(path), limits.maxArtifactBytes);
  const artifactSha256 = sha256(bytes);
  const payload = openEnvelope(bytes, key, limits.maxArtifactBytes, AUTHORITY_ENVELOPE_PURPOSE);
  if (payload.length < 4) fail("corrupt", "checkpoint payload is truncated");
  const length = payload.readUInt32BE(0);
  if (length > limits.maxManifestBytes || 4 + length > payload.length) fail("corrupt", "checkpoint manifest length is invalid");
  const manifestBytes = payload.subarray(4, 4 + length);
  let parsed: unknown;
  try { parsed = JSON.parse(manifestBytes.toString("utf8")); } catch (error) { throw new OperationsError("corrupt", "checkpoint manifest is not valid JSON", { cause: error }); }
  const manifest = decodeCheckpointManifest(parsed, limits);
  const members = new Map<string, Buffer>();
  let offset = 4 + length;
  for (const member of manifest.members) {
    if (offset + member.bytes > payload.length) fail("corrupt", "checkpoint payload is truncated");
    const body = payload.subarray(offset, offset + member.bytes);
    if (sha256(body) !== member.sha256) fail("corrupt", "checkpoint member digest does not match");
    members.set(member.name, body); offset += member.bytes;
  }
  if (offset !== payload.length) fail("corrupt", "checkpoint payload has trailing bytes");
  return { manifest, members, artifactSha256, manifestSha256: sha256(manifestBytes) };
}

/**
 * Working tree of master's HEAD commit, as `ContextRepository.read` expects it next to `.git`: every entry must be a
 * plain file (mode 100644) or directory on an allowlisted Context path. Blob bodies are inflated under the per-object
 * and aggregate bounds and verified against their names.
 */
export function contextWorkingTree(members: ReadonlyMap<string, Buffer>, limits: SnapshotLimits): Map<string, Buffer> {
  const bounds = gitLimits(limits);
  const master = members.get(`${GIT_PREFIX}refs/heads/master`);
  const files = new Map<string, Buffer>();
  if (master === undefined) return files;
  let remaining = bounds.maxInflatedBytes;
  const object = (id: string): { type: string; body: Buffer } => {
    const compressed = members.get(`${GIT_PREFIX}objects/${id.slice(0, 2)}/${id.slice(2)}`);
    if (!compressed) return broken("context Git object is missing");
    const inflated = inflateObject(id, compressed, Math.min(bounds.maxInflatedObjectBytes, remaining), true);
    remaining -= inflated.inflated;
    return inflated;
  };
  const commit = object(master.toString("latin1").trim());
  const tree = commit.type === "commit" ? /^tree ([0-9a-f]{40})\n/.exec(commit.body.toString("latin1")) : null;
  if (!tree) return broken("context Git master is not a commit");
  const walk = (treeId: string, prefix: string, depth: number): void => {
    if (depth > 4) broken("context Git tree is too deep");
    const node = object(treeId);
    if (node.type !== "tree") broken("context Git tree is not a tree");
    let offset = 0;
    while (offset < node.body.length) {
      const space = node.body.indexOf(0x20, offset); const nul = node.body.indexOf(0, space + 1);
      if (space < 0 || nul < 0 || nul + 21 > node.body.length) fail("corrupt", "context Git tree is not valid");
      const mode = node.body.subarray(offset, space).toString("latin1"); const name = node.body.subarray(space + 1, nul).toString("utf8");
      const id = node.body.subarray(nul + 1, nul + 21).toString("hex"); offset = nul + 21;
      const path = prefix ? `${prefix}/${name}` : name;
      if (mode === "40000") walk(id, path, depth + 1);
      else if (mode === "100644" && CONTEXT_PATH.test(path)) {
        const blob = object(id);
        if (blob.type !== "blob") broken("context Git file is not a blob");
        files.set(path, Buffer.from(blob.body));
      } else fail("unsupported_schema", "context Git tree entry is not an allowlisted file");
    }
  };
  walk(tree[1]!, "", 0);
  return files;
}

/** Digest helper exported for receipts and tests. */
export const digestOf = (value: unknown): string => sha256Text(JSON.stringify(value));
