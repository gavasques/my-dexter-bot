import { memoryBackendMetadataSummary, type MemoryBackendMetadataSummary } from './memory-backend.js';
import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ACTIVATION_MARKER_FILE, activationReservationPath } from "@dexter/hub";
import { openImmutable } from "./capture.js";
import { CHECKPOINT_EXCLUDED, CHECKPOINT_SOURCE_FILES, CONTEXT_REPOSITORY, RELAY_HOST_DIRECTORY } from "./checkpoint.js";
import { OperationsError } from "./errors.js";
import { SQLITE_SIDECARS, entry } from "./files.js";
import { checkFullSchema, contextSchemaLabel, deviceSurfaceSchemaLabel, FULL_SCHEMAS, type FullKind } from "./full-schemas.js";
import { all, count, one, openReadOnly } from "./schemas.js";

/**
 * Read-only diagnosis of a data directory. Every database is opened read-only — `immutable` when it is closed, so
 * no `-wal`/`-shm` is ever created next to it — and a lone sidecar or hot journal is reported without opening
 * anything. The report holds only states, versions, booleans and counts: no content, path, id, token, cursor,
 * key or raw error text.
 */
export interface SourceAuthority {
  schemaVersion: number;
  state: "active" | "checkpointed" | "revoked"; epoch: number; provenance: string; checkpointId: string | null;
  installationId: string; ownerId: string; directory: string; directoryIno: string;
  revokedArtifact: string | null; revokedTarget: string | null; activationReceipt: string | null;
}

type Sidecars = "none" | "pair" | "incomplete" | "hot_journal";
function sidecars(path: string): Sidecars {
  const present = SQLITE_SIDECARS.filter((suffix) => entry(`${path}${suffix}`) !== undefined);
  if (present.includes("-journal")) return "hot_journal";
  if (present.length === 0) return "none";
  return present.join(",") === "-wal,-shm" ? "pair" : "incomplete";
}
/** SQLite pages are powers of two of at least 512 bytes, so a database file holds a whole number of 512-byte units. */
const PAGE_UNIT = 512;
/**
 * Opens without creating anything next to the file, or returns the reason it cannot. A main file known to be empty
 * or truncated is refused before any SQLite read: the first read of a zero-page main deletes a `-wal` beside it, even
 * read-only. `lstat` only — closing a probe descriptor would drop this process's POSIX locks on a live database. A
 * practical refusal, not admission and not a guarantee against uncoordinated truncation after the check.
 */
function openSafely(path: string): DatabaseSync | Sidecars | "truncated" {
  const main = entry(path);
  if (!main || main.isSymbolicLink() || !main.isFile()) return "incomplete";
  if (main.size < PAGE_UNIT || main.size % PAGE_UNIT !== 0) return "truncated";
  const state = sidecars(path);
  if (state === "none") return openImmutable(path);
  if (state === "pair") return openReadOnly(path);
  return state;
}

/** Authority row of `<dataDir>/dexter.sqlite`, read independently of any store handle (executed evidence). */
export function readSourceAuthority(dataDir: string): SourceAuthority {
  const db = openSafely(join(dataDir, "dexter.sqlite"));
  if (typeof db === "string") throw new OperationsError("corrupt", "source database cannot be read safely");
  try {
    const schemaVersion = Number(one(db, "PRAGMA user_version")?.user_version);
    if (![4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].includes(schemaVersion)) throw new OperationsError("unsupported_schema", "source database has no authority schema");
    checkFullSchema(db, "hub");
    const rows = all(db, "SELECT * FROM host_authority");
    if (rows.length !== 1) throw new OperationsError("corrupt", "source authority is not unique");
    const row = rows[0]!;
    const s = (key: string): string | null => (row[key] === null ? null : String(row[key]));
    return {
      schemaVersion, state: row.state as SourceAuthority["state"], epoch: Number(row.epoch), provenance: String(row.provenance), checkpointId: s("checkpoint_id"),
      installationId: String(row.installation_id), ownerId: String(row.owner_id), directory: String(row.directory), directoryIno: String(row.directory_ino),
      revokedArtifact: s("revoked_artifact"), revokedTarget: s("revoked_target"), activationReceipt: s("activation_receipt"),
    };
  } finally { db.close(); }
}

/** Schema version and recorded identity of `<dataDir>/dexter.sqlite`, read without creating anything next to it. */
export function readHubIdentity(dataDir: string): { schemaVersion: number; installationId: string; ownerId: string } {
  const db = openSafely(join(dataDir, "dexter.sqlite"));
  if (typeof db === "string") throw new OperationsError("corrupt", "source database cannot be read safely");
  try {
    const schemaVersion = Number(one(db, "PRAGMA user_version")?.user_version);
    let installationId: unknown; let ownerId: unknown;
    try {
      installationId = one(db, "SELECT value FROM meta WHERE key = 'host_id'")?.value;
      ownerId = one(db, "SELECT value FROM meta WHERE key = 'owner_id'")?.value;
    } catch (error) { throw new OperationsError("unsupported_schema", "source database has no Hub identity", { cause: error }); }
    if (!Number.isSafeInteger(schemaVersion) || typeof installationId !== "string" || !installationId || typeof ownerId !== "string" || !ownerId) {
      throw new OperationsError("unsupported_schema", "source database has no Hub identity");
    }
    return { schemaVersion, installationId, ownerId };
  } finally { db.close(); }
}

export interface DoctorReport {
  ok: boolean;
  dataDirectory: "present" | "missing";
  hub: {
    file: "present" | "missing"; sidecars: Sidecars | null; schemaVersion: number | null; supported: boolean;
    authority: { state: string; epoch: number; provenance: string; boundHere: boolean } | "legacy_without_authority" | null;
    leaseRow: boolean | null;
    counts: { bots: number; threads: number; messages: number; turns: Record<string, number>; actions: Record<string, number>; devices: { active: number; revoked: number }; grants: number } | null;
  };
  components: Partial<Record<Exclude<FullKind, "hub">, { sidecars: Sidecars; schema: string }>>;
  memoryBackend?: MemoryBackendMetadataSummary;
  contextRepository: boolean;
  activationPending: boolean;
  /** A destination reservation (in the parent) names this directory: an activation is in progress or crashed. */
  activationReserved: boolean;
  excludedPresent: string[];
  unknownEntries: number;
  issues: string[];
}

const grouped = (db: DatabaseSync, table: string): Record<string, number> =>
  Object.fromEntries(all(db, `SELECT state, COUNT(*) AS n FROM ${table} GROUP BY state ORDER BY state`).map((row) => [String(row.state), Number(row.n)]));

export function doctor(dataDir: string): DoctorReport {
  const report: DoctorReport = {
    ok: false, dataDirectory: "missing", hub: { file: "missing", sidecars: null, schemaVersion: null, supported: false, authority: null, leaseRow: null, counts: null },
    components: {}, contextRepository: false, activationPending: false, activationReserved: false, excludedPresent: [], unknownEntries: 0, issues: [],
  };
  let parent: string | null = null;
  try { parent = realpathSync(dirname(dataDir)); } catch { parent = null; }
  if (parent !== null && entry(activationReservationPath(join(parent, basename(dataDir))))) { report.activationReserved = true; report.issues.push("activation_reserved"); }
  const root = entry(dataDir);
  if (!root || root.isSymbolicLink() || !root.isDirectory()) { report.issues.push("data_directory_missing"); return report; }
  report.dataDirectory = "present";
  const files = new Map(Object.entries(CHECKPOINT_SOURCE_FILES).map(([kind, file]) => [file, kind as FullKind]));
  const baseOf = (name: string): string => { const suffix = SQLITE_SIDECARS.find((item) => name.endsWith(item)); return suffix ? name.slice(0, -suffix.length) : name; };
  for (const name of readdirSync(dataDir)) {
    const base = baseOf(name);
    if (files.has(base)) continue;
    if (name === RELAY_HOST_DIRECTORY && entry(join(dataDir, name))?.isDirectory() && !entry(join(dataDir, name))?.isSymbolicLink()) {
      for (const inner of readdirSync(join(dataDir, name))) if (!files.has(`${RELAY_HOST_DIRECTORY}/${baseOf(inner)}`)) report.unknownEntries += 1;
      continue;
    }
    if (name === CONTEXT_REPOSITORY) { report.contextRepository = true; continue; }
    if (name === ACTIVATION_MARKER_FILE) { report.activationPending = true; report.issues.push("activation_pending"); continue; }
    if (Object.hasOwn(CHECKPOINT_EXCLUDED, base)) { if (!report.excludedPresent.includes(base)) report.excludedPresent.push(base); continue; }
    report.unknownEntries += 1;
  }
  report.excludedPresent.sort();
  if (report.unknownEntries) report.issues.push("unknown_entries");

  const hubPath = join(dataDir, "dexter.sqlite");
  if (entry(hubPath)) {
    report.hub.file = "present";
    report.hub.sidecars = sidecars(hubPath);
    const db = openSafely(hubPath);
    if (typeof db === "string") report.issues.push(`hub_${db}`);
    else {
      try {
        const version = Number(one(db, "PRAGMA user_version")?.user_version);
        report.hub.schemaVersion = version;
        report.hub.supported = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].includes(version);
        if (report.hub.supported) {
          try { checkFullSchema(db, "hub"); } catch { report.hub.supported = false; report.issues.push("hub_schema_not_canonical"); }
          const row = one(db, "SELECT * FROM host_authority WHERE id = 1");
          if (row) {
            let boundHere = false;
            try { const real = realpathSync(dataDir); boundHere = row.directory === real && row.directory_ino === statSync(real, { bigint: true }).ino.toString(); } catch { boundHere = false; }
            report.hub.authority = { state: String(row.state), epoch: Number(row.epoch), provenance: String(row.provenance), boundHere };
            if (row.state !== "active") report.issues.push(`authority_${String(row.state)}`);
            if (!boundHere) report.issues.push("authority_bound_elsewhere");
          } else report.issues.push("authority_missing");
        } else if (version >= 1 && version <= 3) {
          report.hub.authority = "legacy_without_authority";
          report.issues.push("legacy_upgrade_required");
        } else report.issues.push("hub_schema_unsupported");
        if (version >= 1) {
          report.hub.leaseRow = count(db, "SELECT COUNT(*) AS n FROM host_lease") > 0;
          report.hub.counts = {
            bots: count(db, "SELECT COUNT(*) AS n FROM bots"), threads: count(db, "SELECT COUNT(*) AS n FROM threads"),
            messages: count(db, "SELECT COUNT(*) AS n FROM messages"), turns: version >= 2 ? grouped(db, "turns") : {}, actions: grouped(db, "actions"),
            devices: { active: count(db, "SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL"), revoked: count(db, "SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NOT NULL") },
            grants: count(db, "SELECT COUNT(*) AS n FROM grants"),
          };
        }
      } catch { report.issues.push("hub_unreadable"); } finally { db.close(); }
    }
  } else report.issues.push("hub_missing");

  for (const [file, kind] of files) {
    if (kind === "hub" || !entry(join(dataDir, file))) continue;
    const path = join(dataDir, file);
    const state = sidecars(path);
    const db = openSafely(path);
    if (typeof db === "string") { report.components[kind] = { sidecars: state, schema: "not_opened" }; report.issues.push(`${kind}_${db}`); continue; }
    try {
      checkFullSchema(db, kind);
      if(kind==="context"&&contextSchemaLabel(db).startsWith("context-v5-")){const hub=openSafely(hubPath);if(typeof hub==='string')report.issues.push('memory_backend_metadata_invalid');else try{report.memoryBackend=memoryBackendMetadataSummary(db,hub);}catch{report.issues.push('memory_backend_metadata_invalid');}finally{hub.close();}}
      report.components[kind] = { sidecars: state, schema: kind==="context" ? contextSchemaLabel(db) : kind==="deviceSurface"?deviceSurfaceSchemaLabel(db):FULL_SCHEMAS[kind].label };
    } catch { report.components[kind] = { sidecars: state, schema: "unsupported" }; report.issues.push(`${kind}_schema_unsupported`); }
    finally { db.close(); }
  }
  report.ok = report.issues.length === 0;
  return report;
}
