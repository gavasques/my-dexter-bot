import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { sanitizeMemoryLedger } from './memory-ledger.js';
import { validateDevices, validateEnrollments, registryCounts, resolveCatalog, surfaceCounts, type DeviceReconciliation, type OperationPin } from "./devices.js";
import { sealEnvelope, type SnapshotKey } from "./envelope.js";
import { OperationsError, fail } from "./errors.js";
import { checkExactSchema, checkHubExact, hubSchemaVersion } from "./exact.js";
import { OwnedPaths, SQLITE_SIDECARS, absentTarget, entry, noSidecars, publishNoReplace, randomSuffix, readBounded, withOwnedCleanup } from "./files.js";
import { GitSnapshot, readContextGit } from "./git.js";
import {
  COMPONENTS, UNADOPTED_COMPONENTS, DATABASE_MEMBERS, EXCLUDED_BY_FORMAT, LEGACY_SNAPSHOT_VERSION, PayloadBudget, SNAPSHOT_FORMAT, SNAPSHOT_VERSION,
  SOURCE_FILES, V2_MEMBERS, agendaCounts, completenessOf, contextCounts, encodePayload, gitLimits, hubCounts, hubCountsV2, resolveLimits, sha256,
  type Completeness, type Component, type Coverage, type CoverageState, type SanitizationReport, type SanitizationReportV2, type SnapshotCounts,
  type SnapshotCountsV2, type SnapshotLimits, type SnapshotManifest, type SnapshotVersion, type V2Kind,
} from "./manifest.js";
import { checkIntegrity, checkSchema, count, one, openReadOnly, sameIdentity, type Identity } from "./schemas.js";
import { checkHubSanitized, validateAgenda, validateContext } from "./validate.js";

/**
 * The canonical writer fence, passed explicitly. `HostStore` satisfies this shape.
 *
 * Contract for the caller (not verified here): the store is open and its lease is retained for the whole call;
 * if the host had runtime, MCP, gateway, device or remote-flush work, admission was closed and that work drained
 * *before* calling, *without* closing the store. Shutdown followed by a file copy is not a substitute: shutdown
 * releases the lease. This helper only proves what the fence proves — no cooperative Hub, Context, Agenda, device
 * registry or device surface write commits while it copies (they all write inside `withWriterLease`) — and records
 * drain as `caller_responsibility_not_verified`. It is one fence over several SQLite files, not a distributed
 * transaction: intermediate states a crash left between two files are captured as they are and reported.
 */
export interface SnapshotSourceFence {
  readonly databasePath: string;
  readonly ownerId: string;
  readonly hostId: string;
  withWriterLease<T>(operation: () => T): T;
}

export type CaptureStage =
  | "fenced" | "hub_copied" | "context_copied" | "agenda_copied" | "device_registry_copied" | "device_surface_copied"
  | "released" | "sanitized" | "sealed";

/** Version 1 flags (legacy, Hub schema 2 only). */
export interface IncludeV1 { context: boolean; agenda: boolean }
/** Version 2 flags: closed, every component declared. */
export interface IncludeV2 { context: boolean; agenda: boolean; deviceRegistry: boolean; deviceSurface: boolean }

export interface CaptureOptions {
  source: SnapshotSourceFence;
  /**
   * Artifact version. Defaults to 2. Version 1 is the historical R2 format (Hub schema 2, Context, Agenda) and is
   * produced only when asked for explicitly; it is always legacy partial inspection.
   */
  version?: SnapshotVersion;
  /**
   * Version 2 requires all four flags. A version 1 shaped `{ context, agenda }` without an explicit `version: 1` is
   * refused rather than read as "device state absent": absence or exclusion must be declared, never implied.
   */
  include: IncludeV1 | IncludeV2;
  /** Reviewed device operation pins; required when `deviceSurface` is included. */
  operationCatalog?: readonly OperationPin[];
  key: SnapshotKey;
  /** Absolute, normalized path of a new artifact file; its parent must be reached without symlinks. */
  output: string;
  limits?: Partial<SnapshotLimits>;
  clock?: () => number;
  /** Synchronous observation/fault-injection seam for fixtures. Throwing aborts the capture. */
  onStage?: (stage: CaptureStage) => void;
}

export interface CaptureReceipt {
  path: string;
  bytes: number;
  sha256: string;
  keyId: string;
  version: SnapshotVersion;
  capturedAt: number;
  source: Identity;
  fence: "host_writer_lease";
  drain: "caller_responsibility_not_verified";
  members: number;
  /** `null` for version 1, which did not record coverage. */
  coverage: Coverage | null;
  completeness: Completeness;
  /** Always false: even full known-component coverage is an inspection artifact, not a product backup. */
  productBackup: false;
  counts: SnapshotCounts | SnapshotCountsV2;
  sanitization: SanitizationReport | SanitizationReportV2;
  reconciliation: DeviceReconciliation | null;
}

function trustedSourceFiles(path: string, required: boolean): void {
  const main = entry(path);
  if (!main) { if (required) fail("invalid_input", "included database does not exist"); return; }
  if (main.isSymbolicLink() || !main.isFile()) fail("unsafe_path", "source database is not a regular file");
  for (const suffix of SQLITE_SIDECARS) {
    const side = entry(`${path}${suffix}`);
    if (side && (side.isSymbolicLink() || !side.isFile())) fail("unsafe_path", "source database sidecar is not a regular file");
  }
}
/** Something exists for this component at the source (main file, any sidecar, or the Context Git directory). */
function sourcePresent(dataDir: string, component: Component): boolean {
  const path = join(dataDir, SOURCE_FILES[component]);
  if ([path, ...SQLITE_SIDECARS.map((suffix) => `${path}${suffix}`)].some((item) => entry(item) !== undefined)) return true;
  return component === "context" && entry(join(dataDir, "context-revisions")) !== undefined;
}

function stage(onStage: CaptureOptions["onStage"], name: CaptureStage): void {
  if (!onStage) return;
  const result: unknown = onStage(name);
  if (result !== undefined) fail("invalid_input", "capture observer must be synchronous and return nothing");
}

export type Checker = (db: DatabaseSync) => Identity;
/** Schema and identity check of each kind for each version. Version 2 uses the exact catalog where it exists. */
function checker(version: SnapshotVersion, kind: V2Kind): Checker {
  if (kind === "hub") return version === SNAPSHOT_VERSION ? (db) => checkHubExact(db) : (db) => checkSchema(db, "hub");
  if (kind === "deviceRegistry" || kind === "deviceSurface") return (db) => checkExactSchema(db, kind);
  return (db) => checkSchema(db, kind);
}

/**
 * Snapshot of one database through an independent read-only handle while the caller's lease is held.
 * `VACUUM INTO` reads one consistent snapshot (WAL included) and writes a brand-new file; WAL/SHM are never copied.
 * The source is never opened writable and no store constructor or migration runs on it.
 */
export function vacuumInto(
  kind: string, check: Checker, source: string, target: string, identity: Identity, limits: SnapshotLimits, owned: OwnedPaths,
): void {
  trustedSourceFiles(source, true);
  const sidecars = (): string => SQLITE_SIDECARS.filter((suffix) => entry(`${source}${suffix}`) !== undefined).join(",");
  const present = sidecars();
  if (present.includes("-journal")) fail("corrupt", `${kind} source has a hot rollback journal`);
  // Refused before any open: a read-only handle next to a lone -wal or -shm would create the missing partner at the source.
  if (present !== "" && present !== "-wal,-shm") fail("corrupt", `${kind} source has an incomplete WAL/SHM sidecar pair`);
  // A store that is closed (checkpointed, no -wal/-shm) is read `immutable`: a plain read-only handle on a WAL file
  // would create -wal/-shm next to the source. With the store open, its -wal/-shm already exist and are read as is.
  const db = present === "" ? openImmutable(source) : openReadOnly(source);
  try {
    if (!sameIdentity(check(db), identity)) fail("identity_mismatch", `${kind} database belongs to another owner or installation`);
    const pages = Number(one(db, "PRAGMA page_count")?.page_count) * Number(one(db, "PRAGMA page_size")?.page_size);
    if (!Number.isSafeInteger(pages) || pages > limits.maxDatabaseBytes) fail("quota_exceeded", `${kind} database exceeds the size limit`);
    if (entry(target) !== undefined) fail("destination_exists", "staged copy already exists");
    noSidecars(target);
    // The copy is owned as soon as it exists (target was absent just above, inside the 0700 staging), so any later
    // failure, including a partial VACUUM INTO, removes it instead of leaving unadopted plaintext behind.
    try { db.prepare("VACUUM INTO ?").run(target); }
    catch (error) {
      if (entry(target) !== undefined) { try { owned.adopt(target); } catch { /* not a regular file: cleanup reports incomplete */ } }
      throw error;
    }
    owned.adopt(target);
    db.close();
    if (sidecars() !== present) fail("unsafe_path", `${kind} source sidecars changed during the copy`);
  } catch (error) {
    if (error instanceof OperationsError) throw error;
    throw new OperationsError("corrupt", `${kind} database could not be snapshotted`, { cause: error });
  } finally {
    if (db.isOpen) db.close();
  }
}

export function openImmutable(path: string): DatabaseSync {
  const url = pathToFileURL(path); url.search = "immutable=1";
  try { return new DatabaseSync(url, { readOnly: true, enableForeignKeyConstraints: false, timeout: 0 }); }
  catch (error) { throw new OperationsError("corrupt", "database could not be opened read-only", { cause: error }); }
}

/** Mutates only the staged copy: transient lease, native cursors, in-flight states and remote reach. */
function sanitizeHub(path: string, capturedAt: number, check: Checker): SanitizationReportV2 {
  noSidecars(path);
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 0 });
  try {
    db.exec("PRAGMA journal_mode = DELETE; PRAGMA secure_delete = ON;");
    check(db);
    const changes = (sql: string, ...args: number[]): number => Number(db.prepare(sql).run(...args).changes);
    db.exec("BEGIN IMMEDIATE");
    let report: SanitizationReportV2;
    try {
      if (hubSchemaVersion(db) >= 6) changes("UPDATE bot_delegations SET state='unknown',result=NULL,updated_at=? WHERE state IN ('pending','running')", capturedAt);
      const revokedDeviceIds = (db.prepare("SELECT id FROM devices WHERE revoked_at IS NULL").all() as Array<{ id: string }>).map((row) => String(row.id)).sort();
      report = {
        leaseRowsRemoved: changes("DELETE FROM host_lease"),
        nativeCursorsCleared: changes("UPDATE thread_sessions SET native_cursor = NULL WHERE native_cursor IS NOT NULL"),
        actionsMarkedUnknown: changes("UPDATE actions SET state = 'unknown', reason = 'host_interrupted' WHERE state = 'running'"),
        turnsMarkedUnknown: changes(`UPDATE turns SET state = 'unknown', code = 'host_interrupted',
          finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE state = 'running'`, capturedAt, capturedAt),
        devicesRevoked: changes("UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL", capturedAt),
        grantsExpired: changes("UPDATE grants SET expires_at = ? WHERE expires_at IS NULL OR expires_at > ?", capturedAt, capturedAt),
        revokedDeviceIds,
      };
      if (report.devicesRevoked !== revokedDeviceIds.length) fail("corrupt", "device revocation report disagrees");
      // Schema 4: an inspection copy never carries authority. Its authority row is revoked (final by trigger), so even
      // a copy renamed to dexter.sqlite cannot open; it is also bound to the source directory, never to this one.
      if (hubSchemaVersion(db) >= 4 && changes(`UPDATE host_authority SET state = 'revoked', checkpoint_id = COALESCE(checkpoint_id, 'inspection'),
          revoked_artifact = 'inspection_copy', revoked_target = 'inspection_copy', updated_at = ? WHERE state != 'revoked'`, capturedAt) > 1) {
        fail("corrupt", "authority row is not unique");
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
    // secure_delete zeroed freed cells; VACUUM rebuilds so no lease token or cursor bytes survive in free pages.
    db.exec("VACUUM");
    return report;
  } finally {
    db.close();
  }
}

export function finalizeCopy(path: string): void {
  noSidecars(path);
  const db = new DatabaseSync(path, { timeout: 0 });
  try { db.exec("PRAGMA journal_mode = DELETE; VACUUM;"); } finally { db.close(); }
}

function closedFlags(value: unknown, keys: readonly string[]): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",")
    && keys.every((key) => typeof (value as Record<string, unknown>)[key] === "boolean");
}

/**
 * Captures canonical Hub plus the declared optional components into one encrypted, authenticated inspection
 * artifact. Fully synchronous: every source read happens inside one `withWriterLease` callback.
 */
export function captureInspectionSnapshot(options: CaptureOptions): CaptureReceipt {
  const { source, key } = options;
  if (!source || typeof source.withWriterLease !== "function" || typeof source.databasePath !== "string") fail("fence_unavailable", "an explicit writer fence is required");
  if (basename(source.databasePath) !== "dexter.sqlite") fail("invalid_input", "source is not a canonical Hub database");
  const version: SnapshotVersion = options.version ?? SNAPSHOT_VERSION;
  if (version !== SNAPSHOT_VERSION && version !== LEGACY_SNAPSHOT_VERSION) fail("invalid_input", "snapshot version is unsupported");
  const legacy = version === LEGACY_SNAPSHOT_VERSION;
  if (!closedFlags(options.include, legacy ? ["context", "agenda"] : COMPONENTS)) {
    fail("invalid_input", legacy ? "include flags are required" : "version 2 requires include flags for context, agenda, deviceRegistry and deviceSurface");
  }
  const flags = options.include as Partial<IncludeV2>;
  const include: IncludeV2 = { context: !!flags.context, agenda: !!flags.agenda, deviceRegistry: !!flags.deviceRegistry, deviceSurface: !!flags.deviceSurface };
  if (include.deviceSurface && !include.deviceRegistry) fail("invalid_input", "the device surface requires the device registry");
  const catalog = include.deviceSurface ? resolveCatalog(options.operationCatalog) : null;
  const limits = resolveLimits(options.limits);
  const clock = options.clock ?? Date.now;
  const { parent, name } = absentTarget(options.output);
  const dataDir = dirname(source.databasePath);
  const identity: Identity = { ownerId: source.ownerId, installationId: source.hostId };
  const owned = new OwnedPaths();
  const staging = join(parent, `.${name}.capture-${randomSuffix()}`);
  const budget = new PayloadBudget(limits, typeof key?.keyId === "string" ? key.keyId : "");
  const members = legacy ? (DATABASE_MEMBERS as Readonly<Record<V2Kind, string>>) : V2_MEMBERS;
  const kinds = (["hub", ...COMPONENTS] as V2Kind[]).filter((kind) => kind === "hub" || include[kind as Component]);

  return withOwnedCleanup(owned, () => {
    owned.mkdir(staging);
    const staged = (kind: V2Kind): string => join(staging, members[kind]);
    let git = new Map<string, Buffer>();
    let capturedAt = 0;
    const coverage = { context: "absent", agenda: "absent", deviceRegistry: "absent", deviceSurface: "absent" } as Record<Component, CoverageState>;
    const copiedStage: Record<V2Kind, CaptureStage> = {
      hub: "hub_copied", context: "context_copied", agenda: "agenda_copied", deviceRegistry: "device_registry_copied", deviceSurface: "device_surface_copied",
    };

    let fenced: unknown;
    let entered = false;
    try {
      fenced = source.withWriterLease(() => {
        entered = true;
        capturedAt = clock();
        stage(options.onStage, "fenced");
        if (!legacy) {
          // Frozen relay-host layout (`relay-host/relay-associations.sqlite`, `relay-host/relay-consumer.sqlite`): the
          // inspection format never adopted it, so its presence is refused rather than silently omitted.
          if (entry(join(dataDir, "relay-host")) !== undefined) fail("unsupported_component", "relay-host stores have no adopted schema in the inspection format");
          for (const file of Object.values(UNADOPTED_COMPONENTS)) {
            const path = join(dataDir, file);
            if ([path, ...SQLITE_SIDECARS.map((suffix) => `${path}${suffix}`)].some((item) => entry(item) !== undefined)) {
              fail("unsupported_component", `${file} has no adopted reviewed schema; capture refuses rather than exclude its authority or idempotency state`);
            }
          }
        }
        for (const kind of ["hub", ...COMPONENTS] as V2Kind[]) {
          if (kind !== "hub" && !include[kind as Component]) {
            if (!legacy) coverage[kind as Component] = sourcePresent(dataDir, kind as Component) ? "excluded_by_caller" : "absent";
            continue;
          }
          vacuumInto(kind, checker(version, kind), join(dataDir, SOURCE_FILES[kind]), staged(kind), identity, limits, owned);
          if (kind !== "hub") coverage[kind as Component] = "included";
          if (kind === "context") git = readContextGit(join(dataDir, "context-revisions"), gitLimits(limits), (member, bytes) => budget.admit(member, bytes));
          stage(options.onStage, copiedStage[kind]);
        }
        return undefined;
      });
    } catch (error) {
      // Failures inside the fenced copy keep their own identity; only a fence that could not be entered is reported as such.
      if (entered || error instanceof OperationsError) throw error;
      throw new OperationsError("fence_unavailable", "the canonical writer fence could not be held", { cause: error });
    }
    if (fenced !== undefined) fail("fence_unavailable", "writer fence returned unexpectedly");
    stage(options.onStage, "released");
    if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) fail("invalid_input", "clock must return epoch milliseconds");

    // Below this line only staged copies are touched.
    const fullSanitization = sanitizeHub(staged("hub"), capturedAt, checker(version, "hub"));
    if(kinds.includes('context'))sanitizeMemoryLedger(staged('context'),staged('hub'));
    for (const kind of kinds) if (kind !== "hub") finalizeCopy(staged(kind));
    const opened: Partial<Record<V2Kind, DatabaseSync>> = {};
    let counts: SnapshotCounts | SnapshotCountsV2;
    let reconciliation: DeviceReconciliation | null = null;
    try {
      for (const kind of kinds) {
        noSidecars(staged(kind));
        const db = openReadOnly(staged(kind));
        opened[kind] = db;
        if (!sameIdentity(checker(version, kind)(db), identity)) fail("identity_mismatch", `${kind} copy identity changed`);
        checkIntegrity(db, kind);
      }
      const hub = opened.hub!;
      if (count(hub, "SELECT COUNT(*) AS n FROM host_lease") !== 0) fail("corrupt", "sanitized copy still has a lease");
      const gitObjects = [...git.keys()].filter((member) => member.includes("/objects/")).length;
      if (legacy) {
        counts = {
          hub: hubCounts(hub), context: opened.context ? contextCounts(opened.context, gitObjects) : null,
          agenda: opened.agenda ? agendaCounts(opened.agenda) : null,
        };
      } else {
        // Version 2 validates every reference before sealing, so a broken source never publishes an artifact.
        checkHubSanitized(hub, capturedAt, fullSanitization.revokedDeviceIds);
        validateEnrollments(hub, identity);
        if (opened.context) validateContext(opened.context, hub, new GitSnapshot(git, gitLimits(limits)));
        if (opened.agenda) validateAgenda(opened.agenda, hub);
        if (opened.deviceRegistry) {
          reconciliation = validateDevices({
            hub, registry: opened.deviceRegistry, surface: opened.deviceSurface ?? null, identity, catalog,
            sanitizedDevices: new Set(fullSanitization.revokedDeviceIds),
          });
        }
        counts = {
          hub: hubCountsV2(hub), context: opened.context ? contextCounts(opened.context, gitObjects) : null,
          agenda: opened.agenda ? agendaCounts(opened.agenda) : null,
          deviceRegistry: opened.deviceRegistry ? registryCounts(opened.deviceRegistry) : null,
          deviceSurface: opened.deviceSurface ? surfaceCounts(opened.deviceSurface) : null,
        };
      }
    } finally {
      for (const db of Object.values(opened)) db.close();
    }

    const payloadMembers = new Map<string, Buffer>();
    for (const kind of kinds) {
      noSidecars(staged(kind));
      payloadMembers.set(members[kind], readBounded(staged(kind), limits.maxDatabaseBytes, (bytes) => budget.admit(members[kind], bytes)));
    }
    for (const [member, bytes] of git) payloadMembers.set(member, bytes);
    if (payloadMembers.size > limits.maxMembers) fail("quota_exceeded", "snapshot has too many members");
    stage(options.onStage, "sanitized");

    const memberList = [...payloadMembers].map(([member, bytes]) => ({ name: member, bytes: bytes.length, sha256: sha256(bytes) }));
    const { revokedDeviceIds, ...sanitizationV1 } = fullSanitization;
    let manifest: SnapshotManifest;
    let coverageRecord: Coverage | null = null;
    let completeness: Completeness = "legacy_v1_partial";
    if (legacy) {
      manifest = {
        format: SNAPSHOT_FORMAT, version: LEGACY_SNAPSHOT_VERSION, capturedAt, nodeVersion: process.version, source: identity,
        capture: { fence: "host_writer_lease", method: "vacuum_into", drain: "caller_responsibility_not_verified" },
        quarantine: true, authority: "not_transferred", members: memberList, counts: counts as SnapshotCounts, sanitization: sanitizationV1,
      };
    } else {
      coverageRecord = { hub: "included", ...coverage, appClients: "absent", relayConsumer: "absent", excludedByFormat: [...EXCLUDED_BY_FORMAT] };
      const v2Completeness = completenessOf(coverageRecord) as Exclude<Completeness, "legacy_v1_partial">;
      completeness = v2Completeness;
      manifest = {
        format: SNAPSHOT_FORMAT, version: SNAPSHOT_VERSION, capturedAt, nodeVersion: process.version, source: identity,
        capture: { fence: "host_writer_lease", method: "vacuum_into", drain: "caller_responsibility_not_verified", atomicity: "single_writer_fence_not_distributed_transaction" },
        quarantine: true, authority: "not_transferred", coverage: coverageRecord, completeness: v2Completeness, members: memberList,
        counts: counts as SnapshotCountsV2, sanitization: { ...sanitizationV1, revokedDeviceIds }, reconciliation,
      };
    }
    const payload = encodePayload(manifest, payloadMembers, budget);
    const envelope = sealEnvelope(payload, key);
    payload.fill(0);
    if (envelope.length > limits.maxArtifactBytes) fail("corrupt", "sealed artifact size disagrees with its admission");
    stage(options.onStage, "sealed");

    const temporary = join(staging, "artifact.partial");
    owned.write(temporary, envelope);
    publishNoReplace(owned, temporary, options.output);
    // Success: staged copies are removed exactly; nothing else in the parent is touched.
    if (!owned.cleanup()) throw new OperationsError("cleanup_incomplete", "artifact published but capture staging was not fully removed");
    return {
      path: options.output, bytes: envelope.length, sha256: sha256(envelope), keyId: key.keyId, version, capturedAt, source: identity,
      fence: "host_writer_lease", drain: "caller_responsibility_not_verified", members: manifest.members.length,
      coverage: coverageRecord, completeness, productBackup: false, counts, sanitization: manifest.sanitization, reconciliation,
    };
  });
}

