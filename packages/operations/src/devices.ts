import { DatabaseSync } from "node:sqlite";
import { DeviceRoutePatchSchema, type DeviceRouteReceipt } from "@dexter/contracts";
import { canonicalJson, parseJson, sha256Text, type Json } from "./canonical.js";
import { OperationsError, fail } from "./errors.js";
import { noSidecars } from "./files.js";
import { all, count, one, type Identity } from "./schemas.js";

/**
 * Read-only cross-database validation of the G4 device state against the canonical Hub copy, plus the
 * inspection-only projection that neutralizes copied authority. Nothing here constructs `HostStore`,
 * `DevicePairingRegistry` or `DeviceTurnSurface`, runs their migrations or "repairs" an interrupted step:
 * crash windows between the two SQLite files are classified and reported, never completed or executed.
 */

type Row = Record<string, unknown>;
const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const TOOL = /^mac\.[a-z][a-z0-9_.]{1,100}$/;
const VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const broken = (message: string): never => fail("reference_broken", message);
const str = (value: unknown): value is string => typeof value === "string";
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/** Read-only query that turns node:sqlite range errors (counters beyond 2^53) into a typed failure. */
function rows(db: DatabaseSync, sql: string, ...args: Array<string | number | null>): Row[] {
  try { return all(db, sql, ...args); }
  catch (error) { throw new OperationsError("corrupt", "device state could not be read", { cause: error }); }
}

// ---- trusted operation catalog --------------------------------------------------------------------

/** One reviewed device operation pin, as published by `@dexter/devices` (`DEVICE_OPERATIONS`) or a frozen older release. */
export interface OperationPin { readonly tool: string; readonly version: string; readonly schemaHash: string }
export type OperationCatalog = ReadonlyMap<string, string>;
const pinKey = (tool: string, version: string): string => `${tool}\u0000${version}`;

/**
 * Closed, explicit catalog. Routes and calls are accepted only when their exact (tool, operation version,
 * schema hash) appears here; an older release (for example the eight 1.0.0 operations next to the nine 1.1.0
 * ones) must be listed explicitly — nothing is inferred from a tool name or the current release.
 */
export function resolveCatalog(input: unknown): OperationCatalog {
  if (!Array.isArray(input) || input.length === 0 || input.length > 1024) fail("invalid_input", "operation catalog is required");
  const catalog = new Map<string, string>();
  for (const raw of input as unknown[]) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join(",") !== "schemaHash,tool,version") {
      fail("invalid_input", "operation catalog entry is not valid");
    }
    const { tool, version, schemaHash } = raw as Record<string, unknown>;
    if (!str(tool) || !TOOL.test(tool) || !str(version) || !VERSION.test(version) || !str(schemaHash) || !HEX64.test(schemaHash)) {
      fail("invalid_input", "operation catalog entry is not valid");
    }
    const key = pinKey(tool as string, version as string);
    if (catalog.has(key)) fail("invalid_input", "operation catalog entry is duplicated");
    catalog.set(key, schemaHash as string);
  }
  return catalog;
}

// ---- counts ---------------------------------------------------------------------------------------

export const OFFER_STATES = ["open", "claimed", "cancelled", "exhausted"] as const;
export const CLAIM_STATES = ["pending", "approving", "approved", "rejected", "failed"] as const;
export const CERT_STATES = ["active", "retired", "revoked"] as const;
export const BINDING_STATES = ["active", "revoked"] as const;
export const RECEIPT_STATES = ["completed", "failed", "unknown"] as const;
export const ROUTE_STATES = ["active", "suspended", "revoked"] as const;
export const COMPOSITE_SURFACES = ["gateway", "device"] as const;

function grouped(db: DatabaseSync, table: string, column: string, states: readonly string[]): Record<string, number> {
  const result = Object.fromEntries(states.map((state) => [state, 0]));
  for (const row of rows(db, `SELECT ${column} AS state, COUNT(*) AS n FROM ${table} GROUP BY ${column}`)) {
    if (!states.includes(String(row.state))) fail("corrupt", `${table} has an unknown state`);
    result[String(row.state)] = Number(row.n);
  }
  return result;
}

export interface RegistryCounts {
  offers: Record<string, number>; claims: Record<string, number>; certificates: Record<string, number>;
  bindings: Record<string, number>; lateReceipts: Record<string, number>;
}
export function registryCounts(db: DatabaseSync): RegistryCounts {
  return {
    offers: grouped(db, "offers", "status", OFFER_STATES), claims: grouped(db, "claims", "status", CLAIM_STATES),
    certificates: grouped(db, "device_certs", "state", CERT_STATES), bindings: grouped(db, "device_bindings", "status", BINDING_STATES),
    lateReceipts: grouped(db, "late_receipts", "status", RECEIPT_STATES),
  };
}
export interface SurfaceCounts { routes: Record<string, number>; calls: number; attachedCalls: number; compositeBindings: Record<string, number> }
export function surfaceCounts(db: DatabaseSync): SurfaceCounts {
  return {
    routes: grouped(db, "device_routes", "status", ROUTE_STATES),
    calls: count(db, "SELECT COUNT(*) AS n FROM device_calls"),
    attachedCalls: count(db, "SELECT COUNT(*) AS n FROM device_calls WHERE action_id IS NOT NULL"),
    compositeBindings: grouped(db, "composite_call_bindings", "surface", COMPOSITE_SURFACES),
  };
}

/**
 * Crash windows and uncertain outcomes found across files. Reported (and pinned in the manifest), never repaired:
 * an inspector shows them; it does not finish a pairing, attach an action, retry a call or claim a result.
 */
export interface DeviceReconciliation {
  /** Pin binding still active while the canonical Hub device was revoked at the source (revocation interrupted). */
  interruptedRevocations: number;
  /** Claims left `approving` (an approval interrupted between its fenced steps; the registry would fail it on open). */
  interruptedApprovals: number;
  /** Source-active Hub macOS devices without a registry pin binding (for example an interrupted approval). */
  hubMacDevicesWithoutPin: number;
  /** Durable call intents whose Hub action exists under the exact idempotency key but was never attached. */
  recoverableAttachments: number;
  /** Durable call intents with no Hub action: intent only, nothing was requested. */
  intentOnlyCalls: number;
  /** Attached device actions whose canonical outcome is `unknown` (never retryable). */
  unknownDeviceActions: number;
  /** Hub actions in the reserved `dvt_` key namespace with no Surface call row. */
  unboundDeviceActions: number;
}
export const RECONCILIATION_KEYS = [
  "interruptedRevocations", "interruptedApprovals", "hubMacDevicesWithoutPin", "recoverableAttachments", "intentOnlyCalls",
  "unknownDeviceActions", "unboundDeviceActions",
] as const;

// ---- Hub v3 client enrollments --------------------------------------------------------------------

/** Mirrors `@dexter/hub` CLIENT_DEVICE_SCOPES (pinned by the tests). */
export const CLIENT_DEVICE_SCOPES = Object.freeze([
  "chat.read", "chat.write", "approvals.read", "approvals.decide", "devices.read", "devices.manage", "grants.read", "grants.manage",
  "outputs.read", "outputs.manage", "connections.read", "connections.manage", "mcp.read", "mcp.manage",
] as const);

/**
 * Immutable client enrollments stay valid on the sanitized copy: digest recomputed exactly as HostStore computes it
 * (`sha256(canonicalJson({namespace, claimId, name, fingerprint, role, scopes, hostId, ownerId}))`), host/owner
 * bound to meta, device row owned with the role's platform, no capabilities and the same creation time. A revoked
 * device (the sanitized state) is valid, as it is for HostStore.
 */
export function validateEnrollments(hub: DatabaseSync, identity: Identity): number {
  const enrollments = rows(hub, "SELECT * FROM client_device_enrollments ORDER BY namespace, claim_id");
  for (const row of enrollments) {
    if (row.namespace !== "app-client-v1" || !str(row.claim_id) || !ID.test(row.claim_id) || row.host_key !== "host_id" || row.owner_key !== "owner_id"
      || row.host_id !== identity.installationId || row.owner_id !== identity.ownerId) broken("client enrollment authority is inconsistent");
    if ((row.role !== "client-ios" && row.role !== "client-mac") || !str(row.fingerprint) || !HEX64.test(row.fingerprint) || !str(row.original_name)) {
      broken("client enrollment metadata is inconsistent");
    }
    const scopes = parseJson(row.scopes);
    if (!Array.isArray(scopes) || scopes.some((scope) => !str(scope) || !(CLIENT_DEVICE_SCOPES as readonly string[]).includes(scope))
      || new Set(scopes).size !== scopes.length || JSON.stringify([...(scopes as string[])].sort()) !== row.scopes) broken("client enrollment scopes are inconsistent");
    const digest = sha256Text(canonicalJson({
      namespace: "app-client-v1", claimId: row.claim_id as string, name: row.original_name as string, fingerprint: row.fingerprint as string,
      role: row.role as string, scopes: scopes as Json[], hostId: identity.installationId, ownerId: identity.ownerId,
    }));
    if (row.digest !== digest) broken("client enrollment digest does not match");
    const device = one(hub, "SELECT * FROM devices WHERE id = ? AND owner_id = ?", String(row.device_id), identity.ownerId);
    if (!device || device.platform !== (row.role === "client-ios" ? "ios" : "macos") || device.capabilities !== "[]" || device.created_at !== row.created_at) {
      broken("client enrollment device is inconsistent");
    }
  }
  return enrollments.length;
}

// ---- registry + surface against the Hub -----------------------------------------------------------

export interface DeviceValidationInput {
  hub: DatabaseSync;
  registry: DatabaseSync | null;
  surface: DatabaseSync | null;
  identity: Identity;
  catalog: OperationCatalog | null;
  /** Hub devices whose `revoked_at` was set by capture sanitization (so revocation at the source is distinguishable). */
  sanitizedDevices: ReadonlySet<string>;
}

/** Every reference is checked on the original (pre-projection) copies; anything inconsistent fails closed. */
export function validateDevices(input: DeviceValidationInput): DeviceReconciliation {
  const { hub, registry, surface, identity } = input;
  const result: DeviceReconciliation = {
    interruptedRevocations: 0, interruptedApprovals: 0, hubMacDevicesWithoutPin: 0, recoverableAttachments: 0, intentOnlyCalls: 0,
    unknownDeviceActions: 0, unboundDeviceActions: 0,
  };
  if (surface && !registry) fail("invalid_input", "device surface requires the device registry");
  const hubDevices = new Map(rows(hub, "SELECT * FROM devices").map((row) => [String(row.id), row]));
  for (const id of input.sanitizedDevices) {
    if (!hubDevices.has(id)) broken("sanitized device is missing from the hub");
  }
  const sourceRevoked = (device: Row): boolean => device.revoked_at !== null && !input.sanitizedDevices.has(String(device.id));
  const enrolledDevices = new Set(rows(hub, "SELECT device_id FROM client_device_enrollments").map((row) => String(row.device_id)));
  const enrolledFingerprints = new Set(rows(hub, "SELECT fingerprint FROM client_device_enrollments").map((row) => String(row.fingerprint)));
  const macDevice = (id: unknown): Row => {
    const device = hubDevices.get(String(id));
    if (!device || device.owner_id !== identity.ownerId || device.platform !== "macos") broken("paired device is missing from the hub or not owned");
    if (enrolledDevices.has(String(id))) broken("paired device is also an app-client enrollment");
    return device!;
  };

  const bindings = new Map<string, Row>();
  const certsByDevice = new Map<string, Row[]>();
  if (registry) {
    for (const cert of rows(registry, "SELECT * FROM device_certs ORDER BY rowid")) {
      if (!str(cert.fp) || !HEX64.test(cert.fp) || !str(cert.device_id)) broken("device certificate is not valid");
      if (enrolledFingerprints.has(cert.fp as string)) broken("device certificate is also an app-client fingerprint");
      certsByDevice.set(cert.device_id as string, [...(certsByDevice.get(cert.device_id as string) ?? []), cert]);
    }
    for (const binding of rows(registry, "SELECT * FROM device_bindings")) bindings.set(String(binding.device_id), binding);
    for (const deviceId of certsByDevice.keys()) if (!bindings.has(deviceId)) broken("device certificates have no binding");
    for (const [deviceId, binding] of bindings) {
      const certs = certsByDevice.get(deviceId) ?? [];
      if (!positive(binding.generation) || !positive(binding.revision) || binding.revision < binding.generation || binding.generation !== certs.length) {
        broken("device binding counters disagree with its pin history");
      }
      const pinned = certs.find((cert) => cert.fp === binding.fp);
      if (!pinned) broken("device binding pin is not in its history");
      const active = certs.filter((cert) => cert.state === "active");
      if (binding.status === "active" ? (active.length !== 1 || pinned!.state !== "active") : certs.some((cert) => cert.state !== "revoked")) {
        broken("device binding status disagrees with its pin history");
      }
      const device = macDevice(deviceId);
      if (binding.status === "revoked" && !sourceRevoked(device)) broken("device pins are revoked while the hub device is not");
      if (binding.status === "active" && sourceRevoked(device)) result.interruptedRevocations += 1;
    }
    for (const device of hubDevices.values()) {
      if (device.platform === "macos" && !sourceRevoked(device) && !bindings.has(String(device.id)) && !enrolledDevices.has(String(device.id))) {
        result.hubMacDevicesWithoutPin += 1;
      }
    }

    const offers = new Map(rows(registry, "SELECT * FROM offers").map((row) => [String(row.id), row]));
    const claimed = new Set<string>();
    for (const offer of offers.values()) {
      if (!str(offer.code_hash) || !HEX64.test(offer.code_hash)) broken("pairing offer verifier is not valid");
      if (offer.kind === "pair" ? offer.device_id !== null : !bindings.has(String(offer.device_id))) broken("pairing offer device is not valid");
    }
    for (const claim of rows(registry, "SELECT * FROM claims")) {
      const offer = offers.get(String(claim.offer_id));
      if (!offer || offer.status !== "claimed" || offer.kind !== claim.kind) broken("pairing claim offer is not valid");
      claimed.add(String(claim.offer_id));
      if (!str(claim.client_fp) || !HEX64.test(claim.client_fp)) broken("pairing claim fingerprint is not valid");
      const capabilities = parseJson(claim.capabilities);
      if (!Array.isArray(capabilities) || capabilities.some((item) => !str(item))) broken("pairing claim capabilities are not valid");
      if (claim.kind === "rotate" && claim.device_id !== offer!.device_id) broken("rotation claim device is not valid");
      if (claim.kind === "pair" && claim.status !== "approved" && claim.device_id !== null) broken("pairing claim device is not valid");
      if (claim.status === "approved") {
        const certs = certsByDevice.get(String(claim.device_id)) ?? [];
        if (!certs.some((cert) => cert.fp === claim.client_fp)) broken("approved claim has no bound certificate");
      }
      if (claim.status === "approving") result.interruptedApprovals += 1;
    }
    for (const offer of offers.values()) if (offer.status === "claimed" && !claimed.has(String(offer.id))) broken("claimed offer has no claim");
    for (const receipt of rows(registry, "SELECT * FROM late_receipts")) {
      const action = one(hub, "SELECT destination, request_hash FROM actions WHERE id = ?", String(receipt.action_id));
      if (!action || action.destination !== receipt.device_id || action.request_hash !== receipt.request_hash) broken("late receipt does not match a hub action");
      macDevice(receipt.device_id);
    }
  }

  if (surface) {
    if (!input.catalog) fail("invalid_input", "an operation catalog is required to validate device routes and calls");
    const catalog = input.catalog!;
    const pin = (row: Row): void => {
      const device = macDevice(row.device_id);
      const binding = bindings.get(String(row.device_id));
      if (!binding) broken("device route has no registry binding");
      if (!(certsByDevice.get(String(row.device_id)) ?? []).some((cert) => cert.fp === row.fingerprint)) broken("device route pin is not in its history");
      if (!positive(row.generation) || !positive(row.pin_revision) || row.pin_revision < row.generation
        || row.generation > Number(binding!.generation) || row.pin_revision > Number(binding!.revision)) broken("device route pin counters are not valid");
      if (!str(row.tool) || catalog.get(pinKey(row.tool, String(row.operation_version))) !== row.schema_hash) broken("device operation pin is not in the catalog");
      const capabilities = parseJson(device.capabilities);
      if (!Array.isArray(capabilities) || !capabilities.includes(row.tool as string)) broken("device route tool is not a device capability");
      if (!one(hub, "SELECT 1 AS x FROM bots WHERE id = ? AND owner_id = ?", String(row.bot_id), identity.ownerId)) broken("device route bot is missing from the hub");
    };
    const routes = new Map<string, Row>();
    for (const route of rows(surface, "SELECT * FROM device_routes")) {
      if (!str(route.id) || !route.id.startsWith("dvr_") || !positive(route.revision) || !positive(route.minimum_grant_revision)) broken("device route is not valid");
      pin(route);
      routes.set(route.id as string, route);
    }
    if (one(surface,"SELECT value FROM meta WHERE key='schema'")?.value === "3") {
      const receipts = rows(surface,"SELECT * FROM device_route_receipts");
      if (receipts.length > 10_000) broken("device route receipt quota exceeded");
      for (const row of receipts) {
        const input = DeviceRoutePatchSchema.safeParse(parseJson(row.request_json));
        const raw = parseJson(row.receipt_json);
        if (!input.success || canonicalJson(input.data as unknown as Json) !== row.request_json
          || sha256Text(String(row.request_json)) !== row.request_hash || input.data.clientRequestId !== row.client_request_id
          || input.data.expectedHostId !== identity.installationId || !raw || typeof raw !== "object" || Array.isArray(raw)
          || Object.keys(raw).sort().join(",") !== "clientRequestId,committedAt,hostId,ownerId,request,requestHash,route,schema"
          || canonicalJson(raw) !== row.receipt_json) broken("device route receipt is not canonical");
        const receipt = raw as unknown as DeviceRouteReceipt;
        if (receipt.schema !== "dexter.device-route-receipt/1" || receipt.hostId !== identity.installationId
          || receipt.ownerId !== identity.ownerId || receipt.clientRequestId !== row.client_request_id
          || receipt.requestHash !== row.request_hash || canonicalJson(receipt.request as unknown as Json) !== row.request_json
          || !Number.isSafeInteger(receipt.committedAt) || receipt.committedAt < 0 || receipt.committedAt !== row.committed_at)
          broken("device route receipt identity is invalid");
        const r = receipt.route, request = input.data!;
        if (!r || typeof r !== "object" || Array.isArray(r)
          || Object.keys(r).sort().join(",") !== "botId,deviceId,fingerprint,generation,id,minimumGrantRevision,needsFreshGrant,operationVersion,pinRevision,revision,schemaHash,status,tool"
          || r.botId !== request.botId || r.deviceId !== request.deviceId || r.tool !== request.tool || r.status !== request.status
          || typeof r.needsFreshGrant !== "boolean" || !positive(r.minimumGrantRevision)
          || r.revision !== (request.expectedRevision ?? 0)+1 || !positive(r.revision)) broken("device route receipt result is invalid");
        const head = routes.get(r.id);
        if (!head || head.bot_id !== r.botId || head.device_id !== r.deviceId || head.tool !== r.tool
          || Number(head.revision) < r.revision) broken("device route receipt has no route head");
        pin({bot_id:r.botId,device_id:r.deviceId,tool:r.tool,fingerprint:r.fingerprint,generation:r.generation,
          pin_revision:r.pinRevision,schema_hash:r.schemaHash,operation_version:r.operationVersion});
      }
    }
    const keys = new Set<string>();
    for (const call of rows(surface, "SELECT * FROM device_calls")) {
      const route = routes.get(String(call.route_id));
      if (!route || route.bot_id !== call.bot_id || route.device_id !== call.device_id || route.tool !== call.tool
        || !positive(call.route_revision) || call.route_revision > Number(route.revision)) broken("device call route is not valid");
      pin(call);
      const turn = one(hub, "SELECT thread_id, bot_id FROM turns WHERE id = ?", String(call.turn_id));
      if (!turn || turn.thread_id !== call.thread_id || turn.bot_id !== call.bot_id) broken("device call turn is missing from the hub");
      const args = parseJson(call.arguments);
      if (args === null || typeof args !== "object" || Array.isArray(args) || canonicalJson(args) !== call.arguments
        || sha256Text(call.arguments as string) !== call.args_hash) broken("device call arguments are not canonical");
      if (!positive(call.grant_revision)) broken("device call grant revision is not valid");
      const grant = one(hub, "SELECT revision FROM grants WHERE bot_id = ? AND tool = ? AND destination = ?", String(call.bot_id), String(call.tool), String(call.device_id));
      if (!grant || Number(grant.revision) < Number(call.grant_revision)) broken("device call grant revision is not in the hub");
      const base: Json = {
        turnId: call.turn_id as string, callId: call.call_id as string, routeId: call.route_id as string, routeRevision: call.route_revision as number,
        botId: call.bot_id as string, threadId: call.thread_id as string, deviceId: call.device_id as string, tool: call.tool as string,
        fingerprint: call.fingerprint as string, generation: call.generation as number, pinRevision: call.pin_revision as number,
        schemaHash: call.schema_hash as string, operationVersion: call.operation_version as string, argsHash: call.args_hash as string,
        arguments: args as Json, grantRevision: call.grant_revision as number,
      };
      if (call.idempotency_key !== `dvt_${sha256Text(canonicalJson(base)).slice(0, 48)}`) broken("device call idempotency key does not match its intent");
      keys.add(`${String(call.bot_id)}\u0000${String(call.idempotency_key)}`);
      const request: Json = {
        botId: call.bot_id as string, threadId: call.thread_id as string, tool: call.tool as string, destination: call.device_id as string,
        arguments: args as Json, idempotencyKey: call.idempotency_key as string,
      };
      const action = call.action_id === null
        ? one(hub, "SELECT * FROM actions WHERE bot_id = ? AND idempotency_key = ?", String(call.bot_id), String(call.idempotency_key))
        : one(hub, "SELECT * FROM actions WHERE id = ?", String(call.action_id));
      if (action) {
        const stored = parseJson(action.request);
        if (action.bot_id !== call.bot_id || action.idempotency_key !== call.idempotency_key || action.thread_id !== call.thread_id
          || action.tool !== call.tool || action.destination !== call.device_id || stored === undefined
          || canonicalJson(stored) !== canonicalJson(request) || action.request_hash !== sha256Text(canonicalJson(request))) {
          broken("device call does not match its hub action");
        }
        if (call.action_id === null) result.recoverableAttachments += 1;
        else if (action.state === "unknown") result.unknownDeviceActions += 1;
      } else if (call.action_id !== null) broken("device call action is missing from the hub");
      else result.intentOnlyCalls += 1;
    }
    for (const binding of rows(surface, "SELECT * FROM composite_call_bindings")) {
      const turn = one(hub, "SELECT thread_id, bot_id FROM turns WHERE id = ?", String(binding.turn_id));
      if (!turn || turn.thread_id !== binding.thread_id || turn.bot_id !== binding.bot_id || !str(binding.args_hash) || !HEX64.test(binding.args_hash)) {
        broken("composite call binding turn is not valid");
      }
      const device = binding.surface === "device";
      if (device !== String(binding.connection_id).startsWith("dvr_")) broken("composite call binding surface is not valid");
      if (device) {
        const route = routes.get(String(binding.connection_id));
        if (!route || route.bot_id !== binding.bot_id || route.tool !== binding.tool) broken("composite call binding route is not valid");
      }
      const call = one(surface, "SELECT * FROM device_calls WHERE turn_id = ? AND call_id = ?", String(binding.turn_id), String(binding.call_id));
      // With a child call the binding must name the same content (`args_hash`); an intent-only binding has nothing to join.
      if (call && (!device || call.route_id !== binding.connection_id || call.tool !== binding.tool || call.bot_id !== binding.bot_id
        || call.thread_id !== binding.thread_id || call.args_hash !== binding.args_hash)) broken("composite call binding disagrees with its device call");
    }
    for (const action of rows(hub, "SELECT bot_id, idempotency_key FROM actions WHERE substr(idempotency_key, 1, 4) = 'dvt_'")) {
      if (!keys.has(`${String(action.bot_id)}\u0000${String(action.idempotency_key)}`)) result.unboundDeviceActions += 1;
    }
  }
  return result;
}

// ---- inspection projection ------------------------------------------------------------------------

/**
 * Columns whose content the projection must leave byte-identical. The projection changes only the listed status
 * columns; ids, verifiers, public pins, generations, revisions, receipts, arguments, idempotency keys, action ids
 * and composite bindings stay exactly as captured.
 */
const PRESERVED: Readonly<Record<"deviceRegistry" | "deviceSurface", Readonly<Record<string, string>>>> = Object.freeze({
  deviceRegistry: {
    meta: "key,value",
    offers: "id,code_hash,kind,device_id,attempts,expires_at,created_at,updated_at",
    claims: "id,offer_id,kind,client_fp,name,capabilities,device_id,expires_at,created_at,decided_at",
    device_certs: "fp,device_id,created_at,updated_at",
    device_bindings: "device_id,fp,generation,revision",
    late_receipts: "action_id,device_id,request_hash,status,code,received_at",
  },
  deviceSurface: {
    meta: "key,value",
    device_routes: "id,bot_id,device_id,tool,fingerprint,generation,pin_revision,schema_hash,operation_version,revision,minimum_grant_revision",
    device_calls: "turn_id,call_id,route_id,route_revision,bot_id,thread_id,device_id,tool,fingerprint,generation,pin_revision,schema_hash,operation_version,args_hash,arguments,grant_revision,idempotency_key,action_id",
    composite_call_bindings: "turn_id,call_id,bot_id,thread_id,surface,connection_id,tool,args_hash",
  },
});

export function preservedDigest(db: DatabaseSync, kind: "deviceRegistry" | "deviceSurface"): string {
  const parts: string[] = [];
  const preserved = {...PRESERVED[kind]};
  if (kind === "deviceSurface" && one(db,"SELECT value FROM meta WHERE key='schema'")?.value === "3")
    preserved.device_route_receipts = "client_request_id,request_hash,request_json,receipt_json,committed_at";
  for (const [table, columns] of Object.entries(preserved)) {
    parts.push(table, ...rows(db, `SELECT ${columns} FROM ${table} ORDER BY ${columns}`).map((row) => JSON.stringify(Object.values(row))));
  }
  return sha256Text(parts.join("\n"));
}

export interface RegistryProjection { offersCancelled: number; claimsFailed: number; bindingsRevoked: number; certificatesRevoked: number }
export interface SurfaceProjection { routesSuspended: number }

/**
 * Applies the inspection projection to a staged copy (never a source, never through a store constructor). Open
 * offers become `cancelled`, `pending`/`approving` claims `failed`, active pins and bindings `revoked`, active routes
 * `suspended` — WITHOUT advancing any generation, revision or timestamp and without rebinding or consenting. The
 * result is deliberately not a valid runtime registry/surface (a runtime revocation or suspension advances the
 * revision, and a runtime-revoked binding has no retired pins): it is classified `inspection_projection` and
 * validated here, never opened by Dexter components.
 */
function project<T>(path: string, apply: (changes: (sql: string) => number) => T): T {
  noSidecars(path);
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec("BEGIN IMMEDIATE");
    let report: T;
    try {
      report = apply((sql) => Number(db.prepare(sql).run().changes));
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
    return report;
  } catch (error) {
    if (error instanceof OperationsError) throw error;
    throw new OperationsError("corrupt", "inspection projection could not be applied", { cause: error });
  } finally {
    db.close();
  }
}
export function projectRegistry(path: string): RegistryProjection {
  return project(path, (changes) => ({
    offersCancelled: changes("UPDATE offers SET status = 'cancelled' WHERE status = 'open'"),
    claimsFailed: changes("UPDATE claims SET status = 'failed' WHERE status IN ('pending', 'approving')"),
    bindingsRevoked: changes("UPDATE device_bindings SET status = 'revoked' WHERE status = 'active'"),
    certificatesRevoked: changes("UPDATE device_certs SET state = 'revoked' WHERE state = 'active'"),
  }));
}
export function projectSurface(path: string): SurfaceProjection {
  return project(path, (changes) => ({ routesSuspended: changes("UPDATE device_routes SET status = 'suspended' WHERE status = 'active'") }));
}

/** The projection carries no usable authority and changed nothing it must preserve. */
export function checkRegistryProjection(db: DatabaseSync, original: { digest: string; counts: RegistryCounts }, report: RegistryProjection): void {
  const now = registryCounts(db);
  const before = original.counts;
  if (now.offers.open !== 0 || now.claims.pending !== 0 || now.claims.approving !== 0 || now.certificates.active !== 0 || now.bindings.active !== 0) {
    fail("corrupt", "device registry projection still carries usable authority");
  }
  if (now.certificates.retired !== before.certificates.retired || report.offersCancelled !== before.offers.open
    || report.claimsFailed !== (before.claims.pending ?? 0) + (before.claims.approving ?? 0) || report.bindingsRevoked !== before.bindings.active
    || report.certificatesRevoked !== before.certificates.active) fail("corrupt", "device registry projection changed more than authority");
  if (preservedDigest(db, "deviceRegistry") !== original.digest) fail("corrupt", "device registry projection changed preserved history");
}
export function checkSurfaceProjection(db: DatabaseSync, original: { digest: string; counts: SurfaceCounts }, report: SurfaceProjection): void {
  const now = surfaceCounts(db);
  if (now.routes.active !== 0 || report.routesSuspended !== original.counts.routes.active) fail("corrupt", "device surface projection still carries active routes");
  if (preservedDigest(db, "deviceSurface") !== original.digest) fail("corrupt", "device surface projection changed preserved history");
}
