import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  checkRegistryProjection, checkSurfaceProjection, preservedDigest, projectRegistry, projectSurface, registryCounts, resolveCatalog, surfaceCounts,
  validateDevices, validateEnrollments, type DeviceReconciliation, type OperationPin, type RegistryProjection, type SurfaceProjection,
} from "./devices.js";
import { openEnvelope, type SnapshotKey } from "./envelope.js";
import { OperationsError, fail } from "./errors.js";
import { checkExactSchema, checkHubExact } from "./exact.js";
import {
  OwnedPaths, absentTarget, existingFile, noSidecars, publishTreeNoReplace, randomSuffix, readBounded, withOwnedCleanup,
} from "./files.js";
import { GIT_HEAD, GIT_PREFIX, GitSnapshot } from "./git.js";
import {
  COMPONENTS, DATABASE_MEMBERS, EXCLUDED_BY_FORMAT, SNAPSHOT_VERSION, V2_MEMBERS, agendaCounts, contextCounts, decodePayload, gitLimits, hubCounts,
  hubCountsV2, resolveLimits, sha256,
  type Completeness, type Coverage, type SnapshotCounts, type SnapshotCountsV2, type SnapshotLimits, type SnapshotManifest, type SnapshotVersion,
  type V2Kind,
} from "./manifest.js";
import { checkIntegrity, checkSchema, openReadOnly, sameIdentity, type Identity } from "./schemas.js";
import { checkHubSanitized, sameCounts, validateAgenda, validateContext } from "./validate.js";

/**
 * Restore layout. Deliberately not a Dexter dataDir: there is no `dexter.sqlite`, `context.sqlite`,
 * `context-revisions/`, `agenda.sqlite`, `devices.sqlite` or `device-tools.sqlite` at any level.
 * `QUARANTINE.json` documents intent only — HostStore, ContextHost, Agenda and the device stores do not read it, so
 * it is not an activation lock. Pointing a HostStore at this directory would create a fresh, empty installation
 * rather than resume the restored one.
 */
export const QUARANTINE_FILE = "QUARANTINE.json";
export const INSPECTION_DIR = "inspection";
export const INSPECTION_FILES: Readonly<Record<V2Kind, string>> = Object.freeze({
  hub: "hub.inspect.sqlite", context: "context.inspect.sqlite", agenda: "agenda.inspect.sqlite",
  deviceRegistry: "device-registry.inspect.sqlite", deviceSurface: "device-surface.inspect.sqlite",
});
export const INSPECTION_GIT_DIR = "context-git.inspect";
const GIT_CONFIG = "[core]\n\trepositoryformatversion = 0\n\tbare = true\n";

/** What a version 1 artifact never contained (it predates device coverage, so device state is simply not covered). */
export const EXCLUDED_FROM_SNAPSHOT = Object.freeze([
  "host_lease", "thread_sessions.native_cursor", "gateway.sqlite", "managed-apps.sqlite", "ai-memory-outbox.sqlite", "devices.sqlite",
  "device-tools.sqlite", "daemon journal.sqlite", "relay.sqlite", "engine/MCP workspaces and sessions", "private identity, keys, OAuth and CLI homes",
] as const);

export type RestoreStage = "authenticated" | "staged" | "validated" | "projected" | "reserved";

export interface RestoreOptions {
  /** Absolute, normalized path of an existing artifact file reached without symlinks. */
  artifact: string;
  key: SnapshotKey;
  /** Absolute, normalized path that must not exist; its parent must be reached without symlinks. */
  destination: string;
  /** When given, the authenticated manifest must name exactly this owner/installation. */
  expect?: { ownerId?: string; installationId?: string };
  /** Reviewed device operation pins; required when the artifact includes the device surface. */
  operationCatalog?: readonly OperationPin[];
  limits?: Partial<SnapshotLimits>;
  clock?: () => number;
  onStage?: (stage: RestoreStage) => void;
}

export interface InspectionProjection {
  /** Restored device files are inspection projections: authority neutralized, not valid runtime stores. */
  classification: "inspection_projection_not_runtime_valid";
  deviceRegistry: RegistryProjection | null;
  deviceSurface: SurfaceProjection | null;
}

export interface InspectionReceipt {
  destination: string;
  state: "quarantined_inspection";
  activatable: false;
  productBackup: false;
  version: SnapshotVersion;
  /** `legacy_v1_partial` for version 1; version 2 states its coverage explicitly. */
  completeness: Completeness;
  coverage: Coverage | null;
  artifactSha256: string;
  keyId: string;
  capturedAt: number;
  restoredAt: number;
  source: Identity;
  files: string[];
  counts: SnapshotCounts | SnapshotCountsV2;
  reconciliation: DeviceReconciliation | null;
  projection: InspectionProjection | null;
}

function stage(onStage: RestoreOptions["onStage"], name: RestoreStage): void {
  if (!onStage) return;
  const result: unknown = onStage(name);
  if (result !== undefined) fail("invalid_input", "restore observer must be synchronous and return nothing");
}

/**
 * Non-executing, quarantined inspection restore. Authenticates and decrypts before trusting any byte, stages into
 * a fresh 0700 sibling directory, validates hashes/schemas/integrity/identity/references on the staged copies,
 * projects the device stores into inert inspection copies, then publishes create-only (`publishTreeNoReplace`):
 * `mkdir` reservation, hard links of the validated inodes, directory syncs, `QUARANTINE.json` last. No rename ever
 * targets `destination`, so nothing that appears there — file, link or empty directory — is replaced. No
 * HostStore, device registry, device surface, runtime, engine, Agenda.tick, gateway or network is opened.
 */
export function restoreForInspection(options: RestoreOptions): InspectionReceipt {
  const limits = resolveLimits(options.limits);
  const clock = options.clock ?? Date.now;
  const artifact = existingFile(options.artifact);
  const { parent, name } = absentTarget(options.destination);
  const envelope = readBounded(artifact, limits.maxArtifactBytes);
  const plaintext = openEnvelope(envelope, options.key, limits.maxArtifactBytes);
  try {
    return restoreAuthenticated(options, limits, clock, plaintext, envelope, parent, name);
  } finally {
    plaintext.fill(0);
  }
}

function restoreAuthenticated(
  options: RestoreOptions, limits: SnapshotLimits, clock: () => number, plaintext: Buffer, envelope: Buffer, parent: string, name: string,
): InspectionReceipt {
  const { manifest, members } = decodePayload(plaintext, limits);
  if (options.expect?.ownerId !== undefined && options.expect.ownerId !== manifest.source.ownerId) fail("identity_mismatch", "snapshot belongs to another owner");
  if (options.expect?.installationId !== undefined && options.expect.installationId !== manifest.source.installationId) {
    fail("identity_mismatch", "snapshot belongs to another installation");
  }
  const current = manifest.version === SNAPSHOT_VERSION;
  const memberNames = current ? V2_MEMBERS : (DATABASE_MEMBERS as Readonly<Record<V2Kind, string>>);
  const kinds = (["hub", ...COMPONENTS] as V2Kind[]).filter((kind) => memberNames[kind] !== undefined && members.has(memberNames[kind]));
  const catalog = kinds.includes("deviceSurface") ? resolveCatalog(options.operationCatalog) : null;
  stage(options.onStage, "authenticated");
  const git = members.has(`${GIT_PREFIX}HEAD`) ? new GitSnapshot(members, gitLimits(limits)) : null;
  if (git && members.get(`${GIT_PREFIX}HEAD`)!.toString("latin1") !== GIT_HEAD) fail("corrupt", "context Git HEAD is invalid");

  const owned = new OwnedPaths();
  const staging = join(parent, `.${name}.restore-${randomSuffix()}`);
  const restoredAt = clock();
  return withOwnedCleanup(owned, () => {
    owned.mkdir(staging);
    const inspection = owned.mkdir(join(staging, INSPECTION_DIR));
    const path = (kind: V2Kind): string => join(inspection, INSPECTION_FILES[kind]);
    const files: string[] = [];
    for (const kind of kinds) {
      owned.write(path(kind), members.get(memberNames[kind])!);
      files.push(`${INSPECTION_DIR}/${INSPECTION_FILES[kind]}`);
    }
    if (git) {
      const root = owned.mkdir(join(inspection, INSPECTION_GIT_DIR));
      owned.write(join(root, "config"), Buffer.from(GIT_CONFIG));
      const directories = new Set<string>();
      for (const [member, bytes] of members) {
        if (!member.startsWith(GIT_PREFIX)) continue;
        const relative = member.slice(GIT_PREFIX.length);
        const parts = relative.split("/");
        for (let depth = 1; depth < parts.length; depth += 1) {
          const directory = parts.slice(0, depth).join("/");
          if (!directories.has(directory)) { owned.mkdir(join(root, directory)); directories.add(directory); }
        }
        owned.write(join(root, relative), bytes);
      }
      files.push(`${INSPECTION_DIR}/${INSPECTION_GIT_DIR}/`);
    }
    stage(options.onStage, "staged");

    const check = (kind: V2Kind, db: DatabaseSync): Identity => {
      if (kind === "hub" && current) return checkHubExact(db);
      if (kind === "deviceRegistry" || kind === "deviceSurface") return checkExactSchema(db, kind);
      return checkSchema(db, kind as "hub" | "context" | "agenda");
    };
    const opened: Partial<Record<V2Kind, DatabaseSync>> = {};
    let reconciliation: DeviceReconciliation | null = null;
    const originals: { deviceRegistry?: string; deviceSurface?: string } = {};
    try {
      for (const kind of kinds) {
        noSidecars(path(kind));
        const db = openReadOnly(path(kind));
        opened[kind] = db;
        if (!sameIdentity(check(kind, db), manifest.source)) fail("identity_mismatch", `${kind} copy belongs to another owner or installation`);
        checkIntegrity(db, kind);
      }
      const hub = opened.hub!;
      validateManifestState(manifest, opened, git);
      if (current) {
        if (opened.deviceRegistry) {
          reconciliation = validateDevices({
            hub, registry: opened.deviceRegistry, surface: opened.deviceSurface ?? null, identity: manifest.source, catalog,
            sanitizedDevices: new Set(manifest.sanitization.revokedDeviceIds),
          });
          originals.deviceRegistry = preservedDigest(opened.deviceRegistry, "deviceRegistry");
        }
        if (opened.deviceSurface) originals.deviceSurface = preservedDigest(opened.deviceSurface, "deviceSurface");
        sameCounts(reconciliation, manifest.reconciliation, "device reconciliation");
      }
    } catch (error) {
      if (error instanceof OperationsError) throw error;
      throw new OperationsError("corrupt", "inspection copy failed validation", { cause: error });
    } finally {
      for (const db of Object.values(opened)) db.close();
    }
    for (const kind of kinds) noSidecars(path(kind));
    stage(options.onStage, "validated");

    // Projection: only the staged device copies, only status columns, no counter or timestamp advanced.
    let projection: InspectionProjection | null = null;
    if (current) {
      projection = { classification: "inspection_projection_not_runtime_valid", deviceRegistry: null, deviceSurface: null };
      const counts = manifest.counts;
      if (kinds.includes("deviceRegistry")) {
        const report = projectRegistry(path("deviceRegistry"));
        reopen(path("deviceRegistry"), "deviceRegistry", manifest.source, (db) => checkRegistryProjection(db, { digest: originals.deviceRegistry!, counts: counts.deviceRegistry! }, report));
        projection.deviceRegistry = report;
      }
      if (kinds.includes("deviceSurface")) {
        const report = projectSurface(path("deviceSurface"));
        reopen(path("deviceSurface"), "deviceSurface", manifest.source, (db) => checkSurfaceProjection(db, { digest: originals.deviceSurface!, counts: counts.deviceSurface! }, report));
        projection.deviceSurface = report;
      }
      stage(options.onStage, "projected");
    }

    const artifactSha256 = sha256(envelope);
    const completeness: Completeness = current ? manifest.completeness : "legacy_v1_partial";
    const coverage = current ? manifest.coverage : null;
    const quarantine = {
      kind: "dexter.g8.quarantined-inspection", version: current ? 2 : 1, state: "quarantined_inspection", activatable: false, productBackup: false,
      notice: "Inspection copy only. Not a Dexter dataDir and not writer authority. Dexter components do not read this file; it is documentation, not a lock.",
      artifactVersion: manifest.version, completeness, coverage,
      source: manifest.source, capturedAt: manifest.capturedAt, restoredAt, artifactSha256, keyId: options.key.keyId,
      files, counts: manifest.counts, sanitization: manifest.sanitization, reconciliation, projection,
      excluded: current ? EXCLUDED_BY_FORMAT : EXCLUDED_FROM_SNAPSHOT,
      authority: { transfer: "unavailable", reason: "authority epoch, revocation and activation receipt are not implemented" },
    };
    owned.write(join(staging, QUARANTINE_FILE), Buffer.from(`${JSON.stringify(quarantine, null, 2)}\n`));

    publishTreeNoReplace(owned, staging, options.destination, QUARANTINE_FILE, () => stage(options.onStage, "reserved"));
    // Published: the destination holds its own links. Staging names are removed by inode; a foreign leftover there
    // is preserved and reported, while the complete, committed destination stays.
    if (!owned.cleanup()) throw new OperationsError("cleanup_incomplete", "inspection copy published but restore staging was not fully removed");
    return {
      destination: options.destination, state: "quarantined_inspection", activatable: false, productBackup: false, version: manifest.version,
      completeness, coverage, artifactSha256, keyId: options.key.keyId, capturedAt: manifest.capturedAt, restoredAt, source: manifest.source,
      files: [QUARANTINE_FILE, ...files], counts: manifest.counts, reconciliation, projection,
    };
  });
}

function reopen(path: string, kind: "deviceRegistry" | "deviceSurface", identity: Identity, verify: (db: DatabaseSync) => void): void {
  noSidecars(path);
  const db = openReadOnly(path);
  try {
    if (!sameIdentity(checkExactSchema(db, kind), identity)) fail("identity_mismatch", `${kind} projection identity changed`);
    checkIntegrity(db, kind);
    verify(db);
  } finally { db.close(); }
  noSidecars(path);
}

/** Sanitization, references and counts of every included database against the authenticated manifest. */
function validateManifestState(manifest: SnapshotManifest, opened: Partial<Record<V2Kind, DatabaseSync>>, git: GitSnapshot | null): void {
  const hub = opened.hub!;
  const gitObjects = manifest.members.filter((member) => member.name.startsWith(`${GIT_PREFIX}objects/`)).length;
  if (manifest.version === SNAPSHOT_VERSION) {
    checkHubSanitized(hub, manifest.capturedAt, manifest.sanitization.revokedDeviceIds);
    validateEnrollments(hub, manifest.source);
    sameCounts(hubCountsV2(hub), manifest.counts.hub, "hub");
    if (opened.deviceRegistry) sameCounts(registryCounts(opened.deviceRegistry), manifest.counts.deviceRegistry, "device registry");
    if (opened.deviceSurface) sameCounts(surfaceCounts(opened.deviceSurface), manifest.counts.deviceSurface, "device surface");
  } else {
    checkHubSanitized(hub, manifest.capturedAt, null);
    sameCounts(hubCounts(hub), manifest.counts.hub, "hub");
  }
  if (opened.context) {
    validateContext(opened.context, hub, git!);
    sameCounts(contextCounts(opened.context, gitObjects), manifest.counts.context, "context");
  }
  if (opened.agenda) {
    validateAgenda(opened.agenda, hub);
    sameCounts(agendaCounts(opened.agenda), manifest.counts.agenda, "agenda");
  }
}
