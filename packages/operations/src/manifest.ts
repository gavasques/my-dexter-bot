import { BACKEND_COUNT_TABLES } from './memory-backend-schema.js';
import { LEARNING_COUNT_TABLES } from './memory-learning-schema.js';
import { GROUP_COUNT_TABLES, APPROVAL_COUNT_TABLES } from "./groups.js";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { OperationsError, fail } from "./errors.js";
import { sealedLength, type EnvelopePurpose } from "./envelope.js";
import { GIT_MEMBER, GIT_PREFIX, type GitLimits } from "./git.js";
import {
  BINDING_STATES, CERT_STATES, CLAIM_STATES, COMPOSITE_SURFACES, OFFER_STATES, RECEIPT_STATES, RECONCILIATION_KEYS, ROUTE_STATES,
  type DeviceReconciliation, type RegistryCounts, type SurfaceCounts,
} from "./devices.js";
import { LEDGER_COUNT_TABLES } from './memory-ledger.js';
import { all, one, count, type DatabaseKind } from "./schemas.js";
import { readMemoryRoutineMetadata } from './memory-routines.js';

export const SNAPSHOT_FORMAT = "dexter-g8-inspection-snapshot";
/** Current artifact version. Version 1 (R2: Hub v2, Context, Agenda) is still decoded, as legacy partial inspection only. */
export const SNAPSHOT_VERSION = 2;
export const LEGACY_SNAPSHOT_VERSION = 1;
export type SnapshotVersion = typeof LEGACY_SNAPSHOT_VERSION | typeof SNAPSHOT_VERSION;
export const DATABASE_MEMBERS: Record<DatabaseKind, string> = { hub: "hub.sqlite", context: "context.sqlite", agenda: "agenda.sqlite" };

/** Optional components of a version 2 artifact. Each one is declared, never inferred from a missing member. */
export const COMPONENTS = ["context", "agenda", "deviceRegistry", "deviceSurface"] as const;
export type Component = typeof COMPONENTS[number];
export type V2Kind = "hub" | Component;
export const V2_MEMBERS: Readonly<Record<V2Kind, string>> = Object.freeze({
  hub: "hub.sqlite", context: "context.sqlite", agenda: "agenda.sqlite",
  deviceRegistry: "device-registry.sqlite", deviceSurface: "device-surface.sqlite",
});
/** Source file of each component next to `dexter.sqlite`. */
export const SOURCE_FILES: Readonly<Record<V2Kind, string>> = Object.freeze({
  hub: "dexter.sqlite", context: "context.sqlite", agenda: "agenda.sqlite",
  deviceRegistry: "devices.sqlite", deviceSurface: "device-tools.sqlite",
});
/**
 * `included`: captured as a member. `absent`: the caller declared it not included and the source file was verified
 * absent inside the fence. `excluded_by_caller`: the caller declared it not included while the source file exists,
 * so the artifact is knowingly partial.
 */
export type CoverageState = "included" | "absent" | "excluded_by_caller";
export const COVERAGE_STATES: readonly CoverageState[] = ["included", "absent", "excluded_by_caller"];
/**
 * Never part of this format, whatever the caller asks: their state is credentials/references, remote-effect
 * outboxes, another writer's lease or engine sessions, and must be re-established, not copied.
 */
export const EXCLUDED_BY_FORMAT = Object.freeze([
  "gateway.sqlite", "managed-apps.sqlite", "ai-memory-outbox.sqlite", "daemon journal.sqlite", "relay.sqlite", "relay-writer.sqlite",
  "engine/MCP workspaces and sessions", "private identity, keys, Keychain, OAuth, APNs, broker values and CLI homes",
] as const);
/**
 * Auxiliary stores next to `dexter.sqlite` whose schema this format has not adopted after review: the app-client
 * pairing registry and the relay consumer journal. Capture refuses an installation that has one
 * (`unsupported_component`) instead of silently excluding client authority or relay idempotency state; until an
 * exact coverage version adopts them, the only coverage a version 2 artifact can record for each is `absent`.
 */
export const APP_CLIENTS_FILE = "app-clients.sqlite";
export const RELAY_CONSUMER_FILE = "relay-consumer.sqlite";
export const UNADOPTED_COMPONENTS = Object.freeze({ appClients: APP_CLIENTS_FILE, relayConsumer: RELAY_CONSUMER_FILE } as const);
export interface Coverage {
  hub: "included";
  context: CoverageState; agenda: CoverageState; deviceRegistry: CoverageState; deviceSurface: CoverageState;
  appClients: "absent";
  relayConsumer: "absent";
  excludedByFormat: readonly string[];
}
/**
 * `known_components_covered`: every component this format knows is included or verified absent. It is still an
 * inspection artifact of the components above — never a complete product backup (see EXCLUDED_BY_FORMAT).
 * `partial`: at least one existing component was excluded by the caller. Version 1 artifacts are `legacy_v1_partial`.
 */
export type Completeness = "known_components_covered" | "partial" | "legacy_v1_partial";
export function completenessOf(coverage: Pick<Coverage, Component>): Completeness {
  return COMPONENTS.every((component) => coverage[component] !== "excluded_by_caller") ? "known_components_covered" : "partial";
}

/** Upper bounds. Callers may lower them; values above the defaults are refused. */
export interface SnapshotLimits {
  maxArtifactBytes: number;
  maxManifestBytes: number;
  maxMembers: number;
  maxDatabaseBytes: number;
  maxGitObjectBytes: number;
  maxGitInflatedObjectBytes: number;
  /** Aggregate inflated bytes over every Context Git object of one capture or restore. */
  maxGitInflatedBytes: number;
  /** Aggregate commit/tree bytes scanned while resolving history and Context pins. */
  maxGitTraversalBytes: number;
}
export const DEFAULT_LIMITS: Readonly<SnapshotLimits> = Object.freeze({
  maxArtifactBytes: 256 * 1024 * 1024,
  maxManifestBytes: 4 * 1024 * 1024,
  maxMembers: 50_000,
  maxDatabaseBytes: 128 * 1024 * 1024,
  maxGitObjectBytes: 8 * 1024 * 1024,
  maxGitInflatedObjectBytes: 16 * 1024 * 1024,
  maxGitInflatedBytes: 128 * 1024 * 1024,
  maxGitTraversalBytes: 1024 * 1024 * 1024,
});

/**
 * Inflated Git bytes admitted per artifact byte. The aggregate inflation budget is the smaller of
 * `maxGitInflatedBytes` and this multiple of `maxArtifactBytes`, so a caller that lowers the artifact quota also
 * lowers how much decompression an authenticated artifact (or a copied source repository) can demand.
 */
export const GIT_INFLATION_RATIO = 16;

export function gitLimits(limits: SnapshotLimits): GitLimits {
  return {
    maxObjects: limits.maxMembers, maxObjectBytes: limits.maxGitObjectBytes, maxInflatedObjectBytes: limits.maxGitInflatedObjectBytes,
    maxInflatedBytes: Math.min(limits.maxGitInflatedBytes, GIT_INFLATION_RATIO * limits.maxArtifactBytes),
    maxTraversalBytes: limits.maxGitTraversalBytes,
  };
}

export function resolveLimits(input: Partial<SnapshotLimits> | undefined): SnapshotLimits {
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!(key in DEFAULT_LIMITS)) fail("invalid_input", "unknown snapshot limit");
    const max = DEFAULT_LIMITS[key as keyof SnapshotLimits];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) fail("invalid_input", "snapshot limit is out of range");
    limits[key as keyof SnapshotLimits] = value as number;
  }
  return limits;
}

export interface HubCounts {
  bots: number; threads: number; messages: number; events: number; grants: number; devices: number; threadSessions: number;
  actions: Record<string, number>; turns: Record<string, number>;
}
export interface ContextCounts { artifacts: number; revisions: number; skills: number; activations: number; memories: number; gitObjects: number; botDocuments?: number; documentRevisions?: number; documentReceipts?: number; routinePolicies?: number; routinePolicyReceipts?: number; routineJobs?: number; memorySubjects?: number; memoryScopes?: number; memoryRecords?: number; memoryRevisions?: number; memoryCandidates?: number; memoryJobs?: number; memoryOperations?: number; memoryProjectionOutbox?: number; memoryProjectionReceipts?: number; memoryTombstones?: number; backendSettings?:number; backendSettingReceipts?:number; backendProvisioning?:number }
export interface AgendaCounts { schedules: number; occurrences: Record<string, number> }
export interface SnapshotCounts { hub: HubCounts; context: ContextCounts | null; agenda: AgendaCounts | null }
export interface SnapshotCountsV2 {
  hub: HubCounts & { clientEnrollments: number };
  context: ContextCounts | null; agenda: AgendaCounts | null;
  deviceRegistry: RegistryCounts | null; deviceSurface: SurfaceCounts | null;
}
export interface SanitizationReport {
  leaseRowsRemoved: number;
  nativeCursorsCleared: number;
  actionsMarkedUnknown: number;
  turnsMarkedUnknown: number;
  devicesRevoked: number;
  grantsExpired: number;
}
/** Version 2 also names the Hub devices it revoked, so revocation at the source stays distinguishable. */
export interface SanitizationReportV2 extends SanitizationReport { revokedDeviceIds: string[] }
export interface ManifestMember { name: string; bytes: number; sha256: string }
export interface SnapshotManifestV1 {
  format: typeof SNAPSHOT_FORMAT;
  version: typeof LEGACY_SNAPSHOT_VERSION;
  capturedAt: number;
  nodeVersion: string;
  source: { ownerId: string; installationId: string };
  capture: { fence: "host_writer_lease"; method: "vacuum_into"; drain: "caller_responsibility_not_verified" };
  quarantine: true;
  authority: "not_transferred";
  members: ManifestMember[];
  counts: SnapshotCounts;
  sanitization: SanitizationReport;
}
export interface SnapshotManifestV2 {
  format: typeof SNAPSHOT_FORMAT;
  version: typeof SNAPSHOT_VERSION;
  capturedAt: number;
  nodeVersion: string;
  source: { ownerId: string; installationId: string };
  capture: {
    fence: "host_writer_lease"; method: "vacuum_into"; drain: "caller_responsibility_not_verified";
    atomicity: "single_writer_fence_not_distributed_transaction";
  };
  quarantine: true;
  authority: "not_transferred";
  coverage: Coverage;
  completeness: Exclude<Completeness, "legacy_v1_partial">;
  members: ManifestMember[];
  counts: SnapshotCountsV2;
  sanitization: SanitizationReportV2;
  /** Cross-file crash windows and uncertain outcomes; present exactly when the device registry is included. */
  reconciliation: DeviceReconciliation | null;
}
export type SnapshotManifest = SnapshotManifestV1 | SnapshotManifestV2;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ACTION_STATES = ["awaiting_approval", "ready", "running", "succeeded", "denied", "blocked", "unknown"];
const TURN_STATES = ["queued", "running", "completed", "interrupted", "failed", "unknown"];
const OCCURRENCE_STATES = ["prepared", "accepted", "withdrawn", "blocked"];

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function byState(db: DatabaseSync, table: string, states: readonly string[]): Record<string, number> {
  const result = Object.fromEntries(states.map((state) => [state, 0]));
  for (const row of all(db, `SELECT state, COUNT(*) AS n FROM ${table} GROUP BY state`)) {
    if (!states.includes(String(row.state))) fail("corrupt", `${table} has an unknown state`);
    result[String(row.state)] = Number(row.n);
  }
  return result;
}
export function hubCounts(db: DatabaseSync): HubCounts {
  const n = (table: string): number => count(db, `SELECT COUNT(*) AS n FROM ${table}`);
  return {
    bots: n("bots"), threads: n("threads"), messages: n("messages"), events: n("events"), grants: n("grants"), devices: n("devices"),
    threadSessions: n("thread_sessions"), actions: byState(db, "actions", ACTION_STATES), turns: byState(db, "turns", TURN_STATES),
  };
}
export function contextCounts(db: DatabaseSync, gitObjects: number): ContextCounts {
  const n = (table: string): number => count(db, `SELECT COUNT(*) AS n FROM ${table}`);
  const routines=readMemoryRoutineMetadata(db);
  const marker=one(db,"SELECT value FROM meta WHERE key='schema'")?.value;const backend=marker==='5';const learning=marker==='4'||backend;const ledger=marker==='3'||learning;
  return { artifacts: n("artifacts"), revisions: n("revisions"), skills: n("skills"), activations: n("activations"), memories: n("memories"), gitObjects,
    ...(one(db,"SELECT value FROM meta WHERE key='schema'")?.value!=="1"?{botDocuments:n("bot_documents"),documentRevisions:n("bot_document_revisions"),documentReceipts:n("bot_document_receipts")}:{ }),
    ...(backend?Object.fromEntries(Object.entries(BACKEND_COUNT_TABLES).map(([key,table])=>[key,n(table)])):{ }),
    ...(learning?Object.fromEntries(Object.entries(LEARNING_COUNT_TABLES).map(([key,table])=>[key,n(table)])):{ }),
    ...(ledger?Object.fromEntries(Object.entries(LEDGER_COUNT_TABLES).map(([key,table])=>[key,n(table)])):{ }),
    ...(routines?{routinePolicies:Object.keys(routines.policies).length,routinePolicyReceipts:Object.keys(routines.receipts).length,routineJobs:Object.keys(routines.jobs).length}:{}) };
}
export function hubCountsV2(db: DatabaseSync): SnapshotCountsV2["hub"] {
  return { ...hubCounts(db), clientEnrollments: count(db, "SELECT COUNT(*) AS n FROM client_device_enrollments"),
    ...(Number(one(db,"PRAGMA user_version")?.user_version)>=16?{memoryCaptureIntents:count(db,"SELECT COUNT(*) n FROM memory_capture_intents")}:{ }),
    ...(Number(one(db,"PRAGMA user_version")?.user_version)>=15?Object.fromEntries(Object.entries({...GROUP_COUNT_TABLES,...APPROVAL_COUNT_TABLES}).map(([key,table])=>[key,count(db,`SELECT COUNT(*) n FROM ${table}`)])):{}) };
}
export function agendaCounts(db: DatabaseSync): AgendaCounts {
  return { schedules: count(db, "SELECT COUNT(*) AS n FROM schedules"), occurrences: byState(db, "occurrences", OCCURRENCE_STATES) };
}

// ---- strict decoding ------------------------------------------------------------------------------

type Record_ = Record<string, unknown>;
function closed(value: unknown, keys: readonly string[]): Record_ {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("corrupt", "snapshot manifest is not valid");
  const record = value as Record_;
  if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) fail("corrupt", "snapshot manifest is not valid");
  return record;
}
function natural(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("corrupt", "snapshot manifest is not valid");
  return value as number;
}
function literal<T>(value: unknown, expected: T): T {
  if (value !== expected) fail("unsupported_schema", "snapshot manifest format is unsupported");
  return expected;
}
function stateCounts(value: unknown, states: readonly string[]): Record<string, number> {
  const record = closed(value, states);
  return Object.fromEntries(states.map((state) => [state, natural(record[state])]));
}
const HUB_COUNT_KEYS = ["bots", "threads", "messages", "events", "grants", "devices", "threadSessions", "actions", "turns"];

function decodeHubCounts(value: unknown, extra: readonly string[]): Record_ {
  const groups=value!==null&&typeof value==="object"&&Object.hasOwn(value,"groups") ? Object.keys({...GROUP_COUNT_TABLES,...APPROVAL_COUNT_TABLES}):[];
  const captures=value!==null&&typeof value==="object"&&Object.hasOwn(value,"memoryCaptureIntents")?["memoryCaptureIntents"]:[];
  extra=[...extra,...captures,...groups];
  const hub = closed(value, [...HUB_COUNT_KEYS, ...extra]);
  return {
    bots: natural(hub.bots), threads: natural(hub.threads), messages: natural(hub.messages), events: natural(hub.events),
    grants: natural(hub.grants), devices: natural(hub.devices), threadSessions: natural(hub.threadSessions),
    actions: stateCounts(hub.actions, ACTION_STATES), turns: stateCounts(hub.turns, TURN_STATES),
    ...Object.fromEntries(extra.map((key) => [key, natural(hub[key])])),
  };
}
function decodeContextCounts(value: unknown): ContextCounts | null {
  if (value === null) return null;
  const current=value!==null&&typeof value==="object"&&Object.hasOwn(value,"documentRevisions");
  const routines=typeof value==="object"&&value!==null&&Object.hasOwn(value,"routineJobs");
  const ledger=typeof value==="object"&&value!==null&&Object.hasOwn(value,"memoryRecords");
  const learning=typeof value==="object"&&value!==null&&Object.hasOwn(value,"learningJobs");
  const backend=typeof value==="object"&&value!==null&&Object.hasOwn(value,"backendSettings");
  const extras=[...(backend?Object.keys(BACKEND_COUNT_TABLES):[]),...(learning?Object.keys(LEARNING_COUNT_TABLES):[]),...(ledger?Object.keys(LEDGER_COUNT_TABLES):[]),...(routines?["routinePolicies","routinePolicyReceipts","routineJobs"]:[])];
  const context = closed(value, ["artifacts", "revisions", "skills", "activations", "memories", "gitObjects",...(current?["botDocuments","documentRevisions","documentReceipts"]:[]),...extras]);
  return {
    artifacts: natural(context.artifacts), revisions: natural(context.revisions), skills: natural(context.skills),
    activations: natural(context.activations), memories: natural(context.memories), gitObjects: natural(context.gitObjects),
    ...(current?{botDocuments:natural(context.botDocuments),documentRevisions:natural(context.documentRevisions),documentReceipts:natural(context.documentReceipts)}:{}),
    ...Object.fromEntries(extras.map(key=>[key,natural(context[key])])),
  };
}
function decodeAgendaCounts(value: unknown): AgendaCounts | null {
  if (value === null) return null;
  const agenda = closed(value, ["schedules", "occurrences"]);
  return { schedules: natural(agenda.schedules), occurrences: stateCounts(agenda.occurrences, OCCURRENCE_STATES) };
}
function decodeRegistryCounts(value: unknown): RegistryCounts | null {
  if (value === null) return null;
  const record = closed(value, ["offers", "claims", "certificates", "bindings", "lateReceipts"]);
  return {
    offers: stateCounts(record.offers, OFFER_STATES), claims: stateCounts(record.claims, CLAIM_STATES),
    certificates: stateCounts(record.certificates, CERT_STATES), bindings: stateCounts(record.bindings, BINDING_STATES),
    lateReceipts: stateCounts(record.lateReceipts, RECEIPT_STATES),
  };
}
function decodeSurfaceCounts(value: unknown): SurfaceCounts | null {
  if (value === null) return null;
  const record = closed(value, ["routes", "calls", "attachedCalls", "compositeBindings"]);
  const surface = {
    routes: stateCounts(record.routes, ROUTE_STATES), calls: natural(record.calls), attachedCalls: natural(record.attachedCalls),
    compositeBindings: stateCounts(record.compositeBindings, COMPOSITE_SURFACES),
  };
  if (surface.attachedCalls > surface.calls) fail("corrupt", "snapshot manifest is not valid");
  return surface;
}

function decodeSanitization(value: unknown, version: SnapshotVersion): SanitizationReportV2 | SanitizationReport {
  const keys = ["leaseRowsRemoved", "nativeCursorsCleared", "actionsMarkedUnknown", "turnsMarkedUnknown", "devicesRevoked", "grantsExpired"];
  const record = closed(value, version === SNAPSHOT_VERSION ? [...keys, "revokedDeviceIds"] : keys);
  const report: SanitizationReport = {
    leaseRowsRemoved: natural(record.leaseRowsRemoved), nativeCursorsCleared: natural(record.nativeCursorsCleared),
    actionsMarkedUnknown: natural(record.actionsMarkedUnknown), turnsMarkedUnknown: natural(record.turnsMarkedUnknown),
    devicesRevoked: natural(record.devicesRevoked), grantsExpired: natural(record.grantsExpired),
  };
  if (version !== SNAPSHOT_VERSION) return report;
  const ids = record.revokedDeviceIds;
  if (!Array.isArray(ids) || ids.length !== report.devicesRevoked || ids.some((id) => typeof id !== "string" || !ID.test(id))
    || ids.some((id, index) => index > 0 && !(String(ids[index - 1]) < String(id)))) fail("corrupt", "snapshot sanitization report is not valid");
  return { ...report, revokedDeviceIds: [...(ids as string[])] };
}

function decodeMembers(value: unknown, limits: SnapshotLimits, databases: readonly string[]): ManifestMember[] {
  if (!Array.isArray(value) || value.length === 0) fail("corrupt", "snapshot manifest has no members");
  const rawMembers = value as unknown[];
  if (rawMembers.length > limits.maxMembers) fail("quota_exceeded", "snapshot has too many members");
  const seen = new Set<string>();
  return rawMembers.map((raw) => {
    const member = closed(raw, ["name", "bytes", "sha256"]);
    const name = member.name;
    if (typeof name !== "string" || !(databases.includes(name) || GIT_MEMBER.test(name))) fail("unsafe_path", "snapshot member is not allowlisted");
    if (seen.has(name as string)) fail("unsafe_path", "snapshot member is duplicated");
    seen.add(name as string);
    const bytes = natural(member.bytes);
    if (bytes > (databases.includes(name as string) ? limits.maxDatabaseBytes : limits.maxGitObjectBytes)) fail("quota_exceeded", "snapshot member exceeds the size limit");
    if (typeof member.sha256 !== "string" || !SHA256.test(member.sha256)) fail("corrupt", "snapshot member digest is not valid");
    return { name: name as string, bytes, sha256: member.sha256 as string };
  });
}

/** Context SQLite and its Git always travel together, and agree with the declared Git object count. */
function checkContextMembers(members: readonly ManifestMember[], hasContext: boolean, counts: ContextCounts | null): void {
  const has = (name: string): boolean => members.some((member) => member.name === name);
  if (hasContext !== has(`${GIT_PREFIX}HEAD`) || hasContext !== (counts !== null)) fail("corrupt", "context database and Git must travel together");
  if (!hasContext && members.some((member) => member.name.startsWith(GIT_PREFIX))) fail("corrupt", "context Git without context database");
  const gitObjects = members.filter((member) => member.name.startsWith(`${GIT_PREFIX}objects/`)).length;
  if (counts && counts.gitObjects !== gitObjects) fail("corrupt", "context Git object count disagrees");
}

function decodeCommon(record: Record_): { capturedAt: number; nodeVersion: string; source: { ownerId: string; installationId: string } } {
  const source = closed(record.source, ["ownerId", "installationId"]);
  if (typeof source.ownerId !== "string" || !ID.test(source.ownerId) || typeof source.installationId !== "string" || !ID.test(source.installationId)) {
    fail("corrupt", "snapshot manifest identity is not valid");
  }
  literal(record.quarantine, true);
  literal(record.authority, "not_transferred");
  if (typeof record.nodeVersion !== "string" || !/^v\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(record.nodeVersion)) fail("corrupt", "snapshot manifest is not valid");
  return {
    capturedAt: natural(record.capturedAt), nodeVersion: record.nodeVersion as string,
    source: { ownerId: source.ownerId as string, installationId: source.installationId as string },
  };
}

function decodeV1(record: Record_, limits: SnapshotLimits): SnapshotManifestV1 {
  closed(record, ["format", "version", "capturedAt", "nodeVersion", "source", "capture", "quarantine", "authority", "members", "counts", "sanitization"]);
  const common = decodeCommon(record);
  const capture = closed(record.capture, ["fence", "method", "drain"]);
  literal(capture.fence, "host_writer_lease"); literal(capture.method, "vacuum_into"); literal(capture.drain, "caller_responsibility_not_verified");
  const members = decodeMembers(record.members, limits, Object.values(DATABASE_MEMBERS));
  const rawCounts = closed(record.counts, ["hub", "context", "agenda"]);
  const counts: SnapshotCounts = {
    hub: decodeHubCounts(rawCounts.hub, []) as unknown as HubCounts,
    context: decodeContextCounts(rawCounts.context), agenda: decodeAgendaCounts(rawCounts.agenda),
  };
  const manifest: SnapshotManifestV1 = {
    format: SNAPSHOT_FORMAT, version: LEGACY_SNAPSHOT_VERSION, ...common,
    capture: { fence: "host_writer_lease", method: "vacuum_into", drain: "caller_responsibility_not_verified" },
    quarantine: true, authority: "not_transferred", members, counts,
    sanitization: decodeSanitization(record.sanitization, LEGACY_SNAPSHOT_VERSION),
  };
  // Member set must agree with the declared optional components.
  const has = (name: string): boolean => members.some((member) => member.name === name);
  if (!has(DATABASE_MEMBERS.hub)) fail("corrupt", "snapshot has no hub database");
  checkContextMembers(members, has(DATABASE_MEMBERS.context), counts.context);
  if (has(DATABASE_MEMBERS.agenda) !== (counts.agenda !== null)) fail("corrupt", "agenda member and counts disagree");
  return manifest;
}

function decodeV2(record: Record_, limits: SnapshotLimits): SnapshotManifestV2 {
  closed(record, [
    "format", "version", "capturedAt", "nodeVersion", "source", "capture", "quarantine", "authority", "coverage", "completeness",
    "members", "counts", "sanitization", "reconciliation",
  ]);
  const common = decodeCommon(record);
  const capture = closed(record.capture, ["fence", "method", "drain", "atomicity"]);
  literal(capture.fence, "host_writer_lease"); literal(capture.method, "vacuum_into"); literal(capture.drain, "caller_responsibility_not_verified");
  literal(capture.atomicity, "single_writer_fence_not_distributed_transaction");
  const rawCoverage = closed(record.coverage, ["hub", ...COMPONENTS, "appClients", "relayConsumer", "excludedByFormat"]);
  literal(rawCoverage.hub, "included");
  literal(rawCoverage.appClients, "absent");
  literal(rawCoverage.relayConsumer, "absent");
  if (!Array.isArray(rawCoverage.excludedByFormat) || JSON.stringify(rawCoverage.excludedByFormat) !== JSON.stringify(EXCLUDED_BY_FORMAT)) {
    fail("unsupported_schema", "snapshot manifest format is unsupported");
  }
  const states = {} as Record<Component, CoverageState>;
  for (const component of COMPONENTS) {
    const state = rawCoverage[component];
    if (!COVERAGE_STATES.includes(state as CoverageState)) fail("corrupt", "snapshot coverage is not valid");
    states[component] = state as CoverageState;
  }
  if (states.deviceSurface === "included" && states.deviceRegistry !== "included") fail("corrupt", "device surface coverage requires the device registry");
  const coverage: Coverage = { hub: "included", ...states, appClients: "absent", relayConsumer: "absent", excludedByFormat: [...EXCLUDED_BY_FORMAT] };
  const completeness = completenessOf(coverage);
  if (record.completeness !== completeness) fail("corrupt", "snapshot completeness disagrees with its coverage");

  const members = decodeMembers(record.members, limits, Object.values(V2_MEMBERS));
  const rawCounts = closed(record.counts, ["hub", ...COMPONENTS]);
  const counts: SnapshotCountsV2 = {
    hub: decodeHubCounts(rawCounts.hub, ["clientEnrollments"]) as unknown as SnapshotCountsV2["hub"],
    context: decodeContextCounts(rawCounts.context), agenda: decodeAgendaCounts(rawCounts.agenda),
    deviceRegistry: decodeRegistryCounts(rawCounts.deviceRegistry), deviceSurface: decodeSurfaceCounts(rawCounts.deviceSurface),
  };
  const has = (name: string): boolean => members.some((member) => member.name === name);
  if (!has(V2_MEMBERS.hub)) fail("corrupt", "snapshot has no hub database");
  for (const component of COMPONENTS) {
    const included = states[component] === "included";
    if (has(V2_MEMBERS[component]) !== included || (counts[component] !== null) !== included) fail("corrupt", `${component} coverage, member and counts disagree`);
  }
  checkContextMembers(members, states.context === "included", counts.context);

  let reconciliation: DeviceReconciliation | null = null;
  if (record.reconciliation !== null) {
    const raw = closed(record.reconciliation, RECONCILIATION_KEYS);
    reconciliation = Object.fromEntries(RECONCILIATION_KEYS.map((key) => [key, natural(raw[key])])) as unknown as DeviceReconciliation;
  }
  if ((reconciliation !== null) !== (states.deviceRegistry === "included")) fail("corrupt", "device reconciliation disagrees with coverage");
  return {
    format: SNAPSHOT_FORMAT, version: SNAPSHOT_VERSION, ...common,
    capture: { fence: "host_writer_lease", method: "vacuum_into", drain: "caller_responsibility_not_verified", atomicity: "single_writer_fence_not_distributed_transaction" },
    quarantine: true, authority: "not_transferred", coverage, completeness: completeness as SnapshotManifestV2["completeness"], members, counts,
    sanitization: decodeSanitization(record.sanitization, SNAPSHOT_VERSION) as SanitizationReportV2, reconciliation,
  };
}

/** Closed decode of an authenticated manifest. Unknown formats and versions fail closed. */
export function decodeManifest(value: unknown, limits: SnapshotLimits): SnapshotManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("corrupt", "snapshot manifest is not valid");
  const record = value as Record_;
  literal(record.format, SNAPSHOT_FORMAT);
  if (record.version === LEGACY_SNAPSHOT_VERSION) return decodeV1(record, limits);
  literal(record.version, SNAPSHOT_VERSION);
  return decodeV2(record, limits);
}

// ---- payload ---------------------------------------------------------------------------------------

const PAYLOAD_LENGTH_BYTES = 4;
const DIGEST_PLACEHOLDER = "0".repeat(64);
/** Exact bytes one member adds to the manifest JSON (its entry plus the separating comma). */
export function memberFramingBytes(name: string, bytes: number): number {
  return Buffer.byteLength(JSON.stringify({ name, bytes, sha256: DIGEST_PLACEHOLDER }), "utf8") + 1;
}

/**
 * Admission accounting for one artifact. Every member is charged, with its manifest framing, before its bytes are
 * read or allocated; the envelope overhead is reserved up front at its exact size for the largest admissible
 * ciphertext. `exact` re-checks the assembled sizes before the payload buffer exists.
 */
export class PayloadBudget {
  readonly #limits: SnapshotLimits;
  readonly #keyId: string;
  readonly #purpose: EnvelopePurpose | undefined;
  #remaining: number;
  constructor(limits: SnapshotLimits, keyId: string, purpose?: EnvelopePurpose) {
    this.#limits = limits; this.#keyId = keyId; this.#purpose = purpose;
    this.#remaining = limits.maxArtifactBytes - (sealedLength(limits.maxArtifactBytes, keyId, purpose) - limits.maxArtifactBytes) - PAYLOAD_LENGTH_BYTES;
    if (this.#remaining < 0) fail("quota_exceeded", "snapshot artifact exceeds the size limit");
  }
  /** Charges one member of `bytes`; throws before the caller allocates anything for it. */
  admit(name: string, bytes: number): void {
    const cost = bytes + memberFramingBytes(name, bytes);
    if (cost > this.#remaining) fail("quota_exceeded", "snapshot artifact exceeds the size limit");
    this.#remaining -= cost;
  }
  /** Exact final check on the assembled manifest and member sizes, before the payload is concatenated. */
  exact(manifestJsonBytes: number, memberBytes: number): void {
    if (manifestJsonBytes > this.#limits.maxManifestBytes) fail("quota_exceeded", "snapshot manifest exceeds the size limit");
    if (sealedLength(PAYLOAD_LENGTH_BYTES + manifestJsonBytes + memberBytes, this.#keyId, this.#purpose) > this.#limits.maxArtifactBytes) {
      fail("quota_exceeded", "snapshot artifact exceeds the size limit");
    }
  }
}

/** Plaintext payload: u32 manifest length | manifest JSON | member bytes in manifest order. */
export function encodePayload(manifest: SnapshotManifest, members: ReadonlyMap<string, Buffer>, budget?: PayloadBudget): Buffer {
  const json = Buffer.from(JSON.stringify(manifest), "utf8");
  budget?.exact(json.length, manifest.members.reduce((total, member) => total + member.bytes, 0));
  const length = Buffer.alloc(PAYLOAD_LENGTH_BYTES); length.writeUInt32BE(json.length);
  return Buffer.concat([length, json, ...manifest.members.map((member) => members.get(member.name)!)]);
}

/** Called only on authenticated plaintext. Lengths and digests must account for every byte exactly. */
export function decodePayload(payload: Buffer, limits: SnapshotLimits): { manifest: SnapshotManifest; members: Map<string, Buffer> } {
  if (payload.length < 4) fail("corrupt", "snapshot payload is truncated");
  const length = payload.readUInt32BE(0);
  if (length > limits.maxManifestBytes || 4 + length > payload.length) fail("corrupt", "snapshot manifest length is invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(payload.subarray(4, 4 + length).toString("utf8")); }
  catch (error) { throw new OperationsError("corrupt", "snapshot manifest is not valid JSON", { cause: error }); }
  const manifest = decodeManifest(parsed, limits);
  const members = new Map<string, Buffer>();
  let offset = 4 + length;
  for (const member of manifest.members) {
    if (offset + member.bytes > payload.length) fail("corrupt", "snapshot payload is truncated");
    const bytes = payload.subarray(offset, offset + member.bytes);
    if (sha256(bytes) !== member.sha256) fail("corrupt", "snapshot member digest does not match");
    members.set(member.name, bytes);
    offset += member.bytes;
  }
  if (offset !== payload.length) fail("corrupt", "snapshot payload has trailing bytes");
  return { manifest, members };
}
