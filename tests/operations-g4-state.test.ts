import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, createSecretKey, randomBytes, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import type { Action } from "@dexter/contracts";
import { DEVICE_OPERATIONS, DevicePairingRegistry, deviceOperationSchemaHash, operationFor } from "@dexter/devices";
import { CLIENT_DEVICE_SCOPES as HUB_SCOPES, canonicalJson as hubCanonicalJson, HostStore } from "@dexter/hub";
import {
  CLIENT_DEVICE_SCOPES, EXCLUDED_BY_FORMAT, INSPECTION_DIR, INSPECTION_FILES, OperationsError, QUARANTINE_FILE, canonicalJson,
  captureInspectionSnapshot, restoreForInspection, type CaptureOptions, type CaptureReceipt, type OperationPin, type OperationsErrorCode,
  type SnapshotKey,
} from "@dexter/operations";
import { DeviceTurnSurface, type DevicePinSnapshot, type DeviceToolsPort } from "../packages/cli/src/device-turn-surface.js";

// ---- synthetic fixtures: temp dirs, synthetic keys, fingerprints and phrases only ---------------------

const KEY_ID = "fixture-key-g4";
function fixtureKey(seed = 9): SnapshotKey {
  const key = createSecretKey(Buffer.alloc(32, seed));
  return { keyId: KEY_ID, use<T>(operation: (lent: KeyObject) => T): T { return operation(key); } };
}
const code = (expected: OperationsErrorCode) => (error: unknown) => {
  assert.ok(error instanceof OperationsError, `expected OperationsError(${expected}), got ${String(error)}`);
  assert.equal(error.code, expected, error.message);
  return true;
};
const fp = (label: string): string => createHash("sha256").update(`synthetic-cert-${label}`).digest("hex");
const TOOL = "mac.file.append";
const ARGS = { name: "fixture.txt", line: "synthetic line" };
const CURRENT_CATALOG: OperationPin[] = [...DEVICE_OPERATIONS.values()].map((op) => ({ tool: op.tool, version: op.version, schemaHash: op.schemaHash }));
/** The frozen 1.0.0 release: the eight operations before `mac.cua.status`, pinned explicitly. */
const OLD_CATALOG: OperationPin[] = [...DEVICE_OPERATIONS.values()].filter((op) => op.tool !== "mac.cua.status").map((op) => ({
  tool: op.tool, version: "1.0.0",
  schemaHash: deviceOperationSchemaHash({ version: "1.0.0", tool: op.tool, effect: op.effect, description: op.description, inputSchema: op.inputSchema }),
}));

function workspace(t: TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dexter-ops-g4-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

interface G4 {
  root: string; dataDir: string; out: string; store: HostStore; registry: DevicePairingRegistry; surface: DeviceTurnSurface;
  botId: string; threadId: string; turnId: string; deviceId: string; revokedDeviceId: string; routeId: string;
  okAction: Action; unknownAction: Action; token: string;
}

/** Real HostStore v3 + DevicePairingRegistry v2 + DeviceTurnSurface v2 with every state the inventory names. */
async function g4(t: TestContext): Promise<G4> {
  const root = workspace(t);
  const dataDir = join(root, "data"); const out = join(root, "out");
  mkdirSync(out, { mode: 0o700 });
  const store = new HostStore({ dataDir });
  const registry = new DevicePairingRegistry(store);
  const pair = (label: string): string => {
    const offer = registry.createOffer({ kind: "pair" });
    const { claimId } = registry.claim({ offerId: offer.offerId, code: offer.code, clientFingerprint: fp(label), name: `Synthetic Mac ${label}`, capabilities: [TOOL] });
    return registry.approveClaim(claimId).deviceId;
  };
  const deviceId = pair("A");
  // Rotation: generation 2, revision 2, the first pin retired.
  const rotate = registry.createOffer({ kind: "rotate", deviceId });
  registry.approveClaim(registry.claim({ offerId: rotate.offerId, code: rotate.code, clientFingerprint: fp("B"), name: "x", capabilities: [TOOL] }).claimId);
  // A second device paired then revoked through the registry (Hub first, then pins).
  const revokedDeviceId = pair("C");
  registry.revokeDevice(revokedDeviceId);
  // Open offer and a pending claim: copied one-time authority that must never stay usable.
  registry.createOffer({ kind: "pair" });
  const pendingOffer = registry.createOffer({ kind: "pair" });
  registry.claim({ offerId: pendingOffer.offerId, code: pendingOffer.code, clientFingerprint: fp("D"), name: "Pending Mac", capabilities: [TOOL] });
  // Immutable Hub v3 app-client enrollment.
  store.registerClientDeviceForClaim({ namespace: "app-client-v1", claimId: "claim-fixture-1", name: "Synthetic iPhone", fingerprint: fp("E"), role: "client-ios", scopes: ["chat.read", "approvals.read"] });

  const bot = store.createBot({ name: "Synthetic", profileId: "personal", engine: "claude" });
  const thread = store.createThread(bot.id);
  const turn = store.createTurn(thread.id, { clientRequestId: "turn-g4", content: "synthetic turn" }).turn;
  store.claimNextTurn(thread.id);
  let outcome: "complete" | "unknown" = "complete";
  const port: DeviceToolsPort = {
    installationId: store.hostId, ownerId: store.ownerId,
    snapshot: (id) => registry.pinBinding(id) as DevicePinSnapshot | null,
    authenticatedPresence: () => "online",
    operation: (tool) => operationFor(tool),
    async dispatchBound(id, context) {
      const action = store.claimAction(id);
      const peer = registry.pinBinding(action.request.destination)!;
      if (!context.guard(action, peer)) return store.markUnknown(id, "executor_error");
      return outcome === "complete" ? store.completeAction(id, { ok: true }) : store.markUnknown(id, "executor_error");
    },
  };
  const surface = new DeviceTurnSurface(store, port);
  t.after(async () => { try { await surface.close(); } catch { /* quarantined fixtures */ } registry.close(); store.close(); });
  const route = surface.admin.bindRoute({ botId: bot.id, deviceId, tool: TOOL });
  store.setGrant({ botId: bot.id, tool: TOOL, destination: deviceId, policy: "allow" });
  const { token } = surface.issueCapability({ turnId: turn.id });
  const call = (callId: string) => surface.call(token, { tool: TOOL, connectionId: route.id, callId, arguments: ARGS });
  const ok = await call("call-ok");
  assert.equal(ok.status, "succeeded");
  outcome = "unknown";
  const unknown = await call("call-unknown");
  assert.equal(unknown.status, "unknown");
  // Crash after the Hub action committed but before the Surface attached it: recoverable by the exact key only.
  const request = store.requestAction.bind(store);
  store.requestAction = (input: unknown) => { request(input); throw new Error("synthetic crash after hub commit"); };
  await assert.rejects(call("call-orphan"));
  // Crash before the Hub action: durable intent only.
  store.requestAction = () => { throw new Error("synthetic crash before hub commit"); };
  await assert.rejects(call("call-intent"));
  delete (store as { requestAction?: unknown }).requestAction;
  surface.reserveCompositeCall(token, { tool: TOOL, connectionId: route.id, callId: "call-composite", arguments: ARGS }, { surface: "device", listed: true });
  const okAction = store.getAction(ok.actionId);
  registry.recordLateReceipt({ actionId: okAction.id, deviceId, requestHash: okAction.requestHash, status: "completed", code: null });
  return {
    root, dataDir, out, store, registry, surface, botId: bot.id, threadId: thread.id, turnId: turn.id, deviceId, revokedDeviceId, routeId: route.id,
    okAction, unknownAction: store.getAction(unknown.actionId), token,
  };
}

const ALL = { context: false, agenda: false, deviceRegistry: true, deviceSurface: true };
function capture(f: G4, overrides: Partial<CaptureOptions> = {}): CaptureReceipt {
  return captureInspectionSnapshot({
    source: f.store, include: ALL, operationCatalog: CURRENT_CATALOG, key: fixtureKey(), output: join(f.out, "g4.dxg8"), ...overrides,
  });
}
const rows = (path: string, sql: string): Array<Record<string, unknown>> => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return (db.prepare(sql).all() as Array<Record<string, unknown>>).map((row) => ({ ...row })); } finally { db.close(); }
};
/** Logical content of every table, for proving a source was not changed. */
function dump(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    return JSON.stringify([db.prepare("PRAGMA user_version").get(), ...tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]),
      db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all()]);
  } finally { db.close(); }
}

// ---- envelope forging (independent reimplementation of the documented format) -------------------------

function unseal(envelope: Buffer): Buffer {
  const headerLength = envelope.readUInt16BE(8);
  const aadLength = 10 + headerLength + 12;
  const decipher = createDecipheriv("aes-256-gcm", createSecretKey(Buffer.alloc(32, 9)), envelope.subarray(10 + headerLength, aadLength), { authTagLength: 16 });
  decipher.setAAD(envelope.subarray(0, aadLength));
  decipher.setAuthTag(envelope.subarray(envelope.length - 16));
  return Buffer.concat([decipher.update(envelope.subarray(aadLength, envelope.length - 16)), decipher.final()]);
}
function reseal(payload: Buffer): Buffer {
  const header = Buffer.from(JSON.stringify({ v: 1, alg: "AES-256-GCM", purpose: "dexter.g8.inspection-snapshot", keyId: KEY_ID, ciphertextBytes: payload.length }));
  const length = Buffer.alloc(2); length.writeUInt16BE(header.length);
  const nonce = randomBytes(12);
  const aad = Buffer.concat([Buffer.from([0x44, 0x58, 0x47, 0x38, 0x53, 0x4e, 0x50, 0x01]), length, header, nonce]);
  const cipher = createCipheriv("aes-256-gcm", createSecretKey(Buffer.alloc(32, 9)), nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  return Buffer.concat([aad, cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
}
interface Decoded { manifest: Record<string, any>; members: Map<string, Buffer> }
function decode(payload: Buffer): Decoded {
  const length = payload.readUInt32BE(0);
  const manifest = JSON.parse(payload.subarray(4, 4 + length).toString("utf8"));
  const members = new Map<string, Buffer>();
  let offset = 4 + length;
  for (const member of manifest.members) { members.set(member.name, payload.subarray(offset, offset + member.bytes)); offset += member.bytes; }
  return { manifest, members };
}
function encode(d: Decoded, order: string[] = d.manifest.members.map((m: { name: string }) => m.name)): Buffer {
  const manifest = { ...d.manifest, members: order.map((name) => {
    const bytes = d.members.get(name)!;
    return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }) };
  const json = Buffer.from(JSON.stringify(manifest));
  const length = Buffer.alloc(4); length.writeUInt32BE(json.length);
  return Buffer.concat([length, json, ...order.map((name) => d.members.get(name)!)]);
}
function mutateDatabase(bytes: Buffer, dir: string, sql: string): Buffer {
  const path = join(dir, `mutate-${randomBytes(4).toString("hex")}.sqlite`);
  writeFileSync(path, bytes);
  const db = new DatabaseSync(path);
  db.exec(sql); db.close();
  const changed = readFileSync(path); unlinkSync(path);
  return changed;
}

// ---- tests ---------------------------------------------------------------------------------------

test("operations copies of canonical JSON and client scopes are the Hub's", () => {
  assert.deepEqual([...CLIENT_DEVICE_SCOPES], [...HUB_SCOPES]);
  const value = { b: [1, { d: null, c: "x" }], a: true, "ü": 1.5 };
  assert.equal(canonicalJson(value), hubCanonicalJson(value));
  assert.equal(OLD_CATALOG.length, 8);
  assert.equal(CURRENT_CATALOG.length, 9);
});

test("Hub v3, registry v2 and surface v2 round-trip into an inert, explicitly covered inspection copy", async (t) => {
  const f = await g4(t);
  const sources = ["dexter.sqlite", "devices.sqlite", "device-tools.sqlite"].map((name) => join(f.dataDir, name));
  const before = sources.map(dump);
  const dirBefore = readdirSync(f.dataDir).sort();
  const probes: string[] = [];
  const receipt = capture(f, {
    onStage: (stage) => {
      if (stage !== "device_registry_copied" && stage !== "device_surface_copied") return;
      // Cooperative device writers need the same fence and cannot commit inside it.
      assert.throws(() => f.registry.createOffer({ kind: "pair" }));
      assert.throws(() => f.surface.admin.suspendRoute(f.routeId));
      probes.push(stage);
    },
  });
  assert.deepEqual(probes, ["device_registry_copied", "device_surface_copied"]);
  assert.deepEqual(sources.map(dump), before, "sources are byte-for-byte unchanged in content, schema and version");
  assert.deepEqual(readdirSync(f.dataDir).sort(), dirBefore, "no sidecar or file appears next to the sources");
  assert.equal(receipt.version, 2);
  assert.deepEqual(receipt.coverage, {
    hub: "included", context: "absent", agenda: "absent", deviceRegistry: "included", deviceSurface: "included", appClients: "absent", relayConsumer: "absent",
    excludedByFormat: [...EXCLUDED_BY_FORMAT],
  });
  assert.equal(receipt.completeness, "known_components_covered");
  assert.equal(receipt.productBackup, false);
  assert.equal(receipt.drain, "caller_responsibility_not_verified");
  assert.deepEqual(receipt.reconciliation, {
    interruptedRevocations: 0, interruptedApprovals: 0, hubMacDevicesWithoutPin: 0, recoverableAttachments: 1, intentOnlyCalls: 1,
    unknownDeviceActions: 1, unboundDeviceActions: 0,
  });
  const counts = receipt.counts as Extract<CaptureReceipt["counts"], { deviceRegistry: unknown }>;
  assert.equal(counts.hub.clientEnrollments, 1);
  assert.deepEqual(counts.deviceRegistry, {
    offers: { open: 1, claimed: 4, cancelled: 0, exhausted: 0 }, claims: { pending: 1, approving: 0, approved: 3, rejected: 0, failed: 0 },
    certificates: { active: 1, retired: 1, revoked: 1 }, bindings: { active: 1, revoked: 1 }, lateReceipts: { completed: 1, failed: 0, unknown: 0 },
  });
  assert.deepEqual(counts.deviceSurface, { routes: { active: 1, suspended: 0, revoked: 0 }, calls: 4, attachedCalls: 2, compositeBindings: { gateway: 0, device: 1 } });

  const destination = join(f.root, "inspect");
  const restored = restoreForInspection({ artifact: receipt.path, key: fixtureKey(), destination, operationCatalog: CURRENT_CATALOG });
  assert.equal(restored.activatable, false);
  assert.equal(restored.completeness, "known_components_covered");
  assert.deepEqual(restored.reconciliation, receipt.reconciliation);
  assert.deepEqual(restored.projection, {
    classification: "inspection_projection_not_runtime_valid",
    deviceRegistry: { offersCancelled: 1, claimsFailed: 1, bindingsRevoked: 1, certificatesRevoked: 1 }, deviceSurface: { routesSuspended: 1 },
  });
  assert.deepEqual(restored.files, [QUARANTINE_FILE, ...["hub", "deviceRegistry", "deviceSurface"].map((kind) => `${INSPECTION_DIR}/${INSPECTION_FILES[kind as "hub"]}`)]);
  assert.deepEqual(readdirSync(join(destination, INSPECTION_DIR)).sort(), ["device-registry.inspect.sqlite", "device-surface.inspect.sqlite", "hub.inspect.sqlite"]);
  const quarantine = JSON.parse(readFileSync(join(destination, QUARANTINE_FILE), "utf8"));
  assert.equal(quarantine.productBackup, false);
  assert.equal(quarantine.authority.transfer, "unavailable");

  const hub = join(destination, INSPECTION_DIR, INSPECTION_FILES.hub);
  const reg = join(destination, INSPECTION_DIR, INSPECTION_FILES.deviceRegistry);
  const srf = join(destination, INSPECTION_DIR, INSPECTION_FILES.deviceSurface);
  // Hub: every device revoked, enrollment kept immutable and valid, no lease.
  assert.deepEqual(rows(hub, "SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL"), [{ n: 0 }]);
  assert.deepEqual(rows(hub, "SELECT claim_id, digest FROM client_device_enrollments"), rows(sources[0]!, "SELECT claim_id, digest FROM client_device_enrollments"));
  assert.deepEqual(rows(hub, "SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name"), ["client_enrollment_no_delete", "client_enrollment_no_update", "host_authority_forward", "host_authority_no_delete", "host_authority_revoked_final"].map((name) => ({ name })));
  // Schema 4: the inspection copy carries a revoked (final) authority; the source authority stays active.
  assert.deepEqual(rows(hub, "SELECT state FROM host_authority"), [{ state: "revoked" }]);
  assert.deepEqual(rows(sources[0]!, "SELECT state FROM host_authority"), [{ state: "active" }]);
  // Registry projection: no usable pin, offer or claim; history (ids, pins, generations, revisions, retired pin) unchanged.
  assert.deepEqual(rows(reg, "SELECT status, COUNT(*) AS n FROM offers WHERE status = 'open' GROUP BY status"), []);
  assert.deepEqual(rows(reg, "SELECT COUNT(*) AS n FROM claims WHERE status IN ('pending', 'approving')"), [{ n: 0 }]);
  assert.deepEqual(rows(reg, "SELECT COUNT(*) AS n FROM device_certs WHERE state = 'active'"), [{ n: 0 }]);
  assert.deepEqual(rows(reg, "SELECT device_id, fp, generation, revision FROM device_bindings ORDER BY device_id"),
    rows(sources[1]!, "SELECT device_id, fp, generation, revision FROM device_bindings ORDER BY device_id"));
  assert.deepEqual(rows(reg, "SELECT fp FROM device_certs WHERE state = 'retired'"), [{ fp: fp("A") }]);
  assert.deepEqual(rows(reg, "SELECT generation, revision FROM device_bindings WHERE device_id = '" + f.deviceId + "'"), [{ generation: 2, revision: 2 }]);
  // Surface projection: route inactive with the same revision; calls, idempotency keys, action ids and bindings exact.
  assert.deepEqual(rows(srf, "SELECT status, revision FROM device_routes"), [{ status: "suspended", revision: rows(sources[2]!, "SELECT revision FROM device_routes")[0]!.revision }]);
  assert.deepEqual(rows(srf, "SELECT * FROM device_calls ORDER BY call_id"), rows(sources[2]!, "SELECT * FROM device_calls ORDER BY call_id"));
  assert.deepEqual(rows(srf, "SELECT * FROM composite_call_bindings"), rows(sources[2]!, "SELECT * FROM composite_call_bindings"));
  // Uncertain outcomes stay uncertain; nothing was executed, attached or retried.
  assert.deepEqual(rows(hub, `SELECT state FROM actions WHERE id = '${f.unknownAction.id}'`), [{ state: "unknown" }]);
  assert.deepEqual(rows(srf, "SELECT call_id FROM device_calls WHERE action_id IS NULL ORDER BY call_id"), [{ call_id: "call-intent" }, { call_id: "call-orphan" }]);

  // Capturing again after the device stores closed (WAL checkpointed) neither fails nor leaves files behind.
  await f.surface.close(); f.registry.close();
  const closedDir = readdirSync(f.dataDir).sort();
  const again = capture(f, { output: join(f.out, "closed.dxg8") });
  assert.deepEqual(again.reconciliation, receipt.reconciliation);
  assert.deepEqual(readdirSync(f.dataDir).sort(), closedDir);
});

test("coverage is declared, never inferred: absence, caller exclusion, surface-without-registry and app clients", async (t) => {
  const f = await g4(t);
  assert.throws(() => captureInspectionSnapshot({ source: f.store, include: { context: false, agenda: false }, key: fixtureKey(), output: join(f.out, "a.dxg8") }), code("invalid_input"));
  assert.throws(() => capture(f, { include: { ...ALL, extra: true } as never, output: join(f.out, "b.dxg8") }), code("invalid_input"));
  assert.throws(() => capture(f, { include: { ...ALL, deviceRegistry: false }, output: join(f.out, "c.dxg8") }), code("invalid_input"));
  assert.throws(() => capture(f, { operationCatalog: undefined as never, output: join(f.out, "d.dxg8") }), code("invalid_input"));
  const partial = capture(f, { include: { ...ALL, deviceRegistry: false, deviceSurface: false }, output: join(f.out, "partial.dxg8") });
  assert.equal(partial.coverage?.deviceRegistry, "excluded_by_caller");
  assert.equal(partial.coverage?.deviceSurface, "excluded_by_caller");
  assert.equal(partial.completeness, "partial");
  assert.equal(partial.reconciliation, null);
  const restored = restoreForInspection({ artifact: partial.path, key: fixtureKey(), destination: join(f.root, "partial") });
  assert.equal(restored.completeness, "partial");
  // An app-client registry has no reviewed schema yet: refused, never silently excluded.
  writeFileSync(join(f.dataDir, "app-clients.sqlite"), "", { mode: 0o600 });
  assert.throws(() => capture(f, { output: join(f.out, "e.dxg8") }), code("unsupported_component"));
  assert.throws(() => capture(f, { include: { context: false, agenda: false, deviceRegistry: false, deviceSurface: false }, output: join(f.out, "f.dxg8") }), code("unsupported_component"));
  unlinkSync(join(f.dataDir, "app-clients.sqlite"));
  // The relay consumer journal is likewise refused, sidecar alone included, until a reviewed schema is adopted.
  writeFileSync(join(f.dataDir, "relay-consumer.sqlite-wal"), "", { mode: 0o600 });
  assert.throws(() => capture(f, { output: join(f.out, "g.dxg8") }), code("unsupported_component"));
  unlinkSync(join(f.dataDir, "relay-consumer.sqlite-wal"));
  assert.ok(capture(f, { output: join(f.out, "h.dxg8") }));
  assert.deepEqual(readdirSync(f.out).sort(), ["h.dxg8", "partial.dxg8"]);
});

test("capture refuses device stores outside the exact reviewed schema or another owner", async (t) => {
  const f = await g4(t);
  const raw = new DatabaseSync(join(f.dataDir, "devices.sqlite"));
  t.after(() => raw.close());
  raw.exec("CREATE TRIGGER fixture_extra AFTER UPDATE ON offers BEGIN SELECT 1; END");
  assert.throws(() => capture(f, { output: join(f.out, "a.dxg8") }), code("unsupported_schema"));
  raw.exec("DROP TRIGGER fixture_extra");
  raw.exec("UPDATE meta SET value = 'own_foreign' WHERE key = 'owner_id'");
  assert.throws(() => capture(f, { output: join(f.out, "b.dxg8") }), code("identity_mismatch"));
  raw.exec(`UPDATE meta SET value = '${f.store.ownerId}' WHERE key = 'owner_id'`);
  assert.ok(capture(f, { output: join(f.out, "c.dxg8") }));
  // Version 1 is legacy Hub v2 only; the current Hub v3 cannot be written into it.
  assert.throws(() => capture(f, { version: 1, include: { context: false, agenda: false }, output: join(f.out, "d.dxg8") }), code("unsupported_schema"));
});

test("authenticated tampering of G4 state, coverage or reconciliation fails closed with nothing left behind", async (t) => {
  const f = await g4(t);
  const receipt = capture(f);
  const scratch = join(f.root, "scratch"); mkdirSync(scratch);
  let n = 0;
  const reject = (expected: OperationsErrorCode, mutate: (d: Decoded) => Buffer | void, catalog: OperationPin[] | null = CURRENT_CATALOG): void => {
    const path = join(f.out, `forged-${n += 1}.dxg8`);
    const d = decode(unseal(readFileSync(receipt.path)));
    writeFileSync(path, reseal(mutate(d) ?? encode(d)), { flag: "wx" });
    const before = readdirSync(f.root).sort();
    assert.throws(() => restoreForInspection({ artifact: path, key: fixtureKey(), destination: join(f.root, "never"), ...(catalog ? { operationCatalog: catalog } : {}) }), code(expected), `case ${n}`);
    assert.deepEqual(readdirSync(f.root).sort(), before, `case ${n} leaves nothing behind`);
  };
  const db = (name: string, sql: string) => (d: Decoded): void => { d.members.set(name, mutateDatabase(d.members.get(name)!, scratch, sql)); };
  const H = "hub.sqlite", R = "device-registry.sqlite", S = "device-surface.sqlite";
  // Sanity: identity forge restores; both catalogs listed explicitly are accepted.
  {
    const path = join(f.out, "identity.dxg8");
    writeFileSync(path, reseal(encode(decode(unseal(readFileSync(receipt.path))))), { flag: "wx" });
    assert.ok(restoreForInspection({ artifact: path, key: fixtureKey(), destination: join(f.root, "ok"), operationCatalog: [...OLD_CATALOG, ...CURRENT_CATALOG] }));
  }
  // Imported triggers or schema drift: exact catalog, any case, any table.
  reject("unsupported_schema", db(H, "CREATE TRIGGER undo AFTER UPDATE ON devices BEGIN UPDATE devices SET revoked_at = NULL WHERE id = NEW.id; END"));
  reject("unsupported_schema", db(H, "CREATE TRIGGER undo AFTER UPDATE ON DEVICES BEGIN SELECT 1; END"));
  reject("unsupported_schema", db(H, "CREATE TRIGGER lease AFTER DELETE ON host_lease BEGIN SELECT 1; END"));
  reject("unsupported_schema", db(H, "DROP TRIGGER client_enrollment_no_update"));
  reject("unsupported_schema", db(H, "CREATE VIEW peek AS SELECT * FROM devices"));
  reject("unsupported_schema", db(H, "CREATE INDEX extra_idx ON devices (name)"));
  reject("unsupported_schema", db(H, "INSERT INTO meta (key, value) VALUES ('authority_epoch', '7')"));
  reject("unsupported_schema", db(R, "CREATE TRIGGER t AFTER INSERT ON claims BEGIN SELECT 1; END"));
  reject("unsupported_schema", db(S, "PRAGMA user_version = 1"));
  reject("unsupported_schema", db(S, "UPDATE meta SET value = '1' WHERE key = 'schema'"));
  // Authority / sanitization.
  reject("corrupt", db(H, `UPDATE devices SET revoked_at = NULL WHERE id = '${f.deviceId}'`));
  reject("corrupt", (d) => { const ids = d.manifest.sanitization.revokedDeviceIds as string[]; ids.splice(ids.indexOf(f.deviceId), 1); d.manifest.sanitization.devicesRevoked -= 1; });
  reject("reference_broken", db(H, "DROP TRIGGER client_enrollment_no_update; UPDATE client_device_enrollments SET scopes = '[\"chat.read\",\"grants.manage\"]'; "
    + "CREATE TRIGGER client_enrollment_no_update BEFORE UPDATE ON client_device_enrollments\nBEGIN SELECT RAISE(ABORT, 'client enrollment is immutable'); END"));
  // Cross-owner and pin history.
  reject("reference_broken", db(H, `UPDATE devices SET owner_id = 'own_foreign' WHERE id = '${f.deviceId}'`));
  reject("reference_broken", db(R, `UPDATE device_bindings SET generation = 3, revision = 3 WHERE device_id = '${f.deviceId}'`));
  // Pins revoked (internally consistent, counts re-pinned) while the Hub device was active at the source: never a valid crash state.
  reject("reference_broken", (d) => {
    db(R, `UPDATE device_certs SET state = 'revoked' WHERE device_id = '${f.deviceId}'; UPDATE device_bindings SET status = 'revoked' WHERE device_id = '${f.deviceId}'`)(d);
    d.manifest.counts.deviceRegistry.certificates = { active: 0, retired: 0, revoked: 3 };
    d.manifest.counts.deviceRegistry.bindings = { active: 0, revoked: 2 };
  });
  reject("reference_broken", db(R, `UPDATE late_receipts SET request_hash = '${"0".repeat(64)}'`));
  // Surface hashes, idempotency, action joins, operation catalog.
  reject("reference_broken", db(S, `UPDATE device_calls SET args_hash = '${"1".repeat(64)}' WHERE call_id = 'call-ok'`));
  reject("reference_broken", db(S, `UPDATE device_calls SET idempotency_key = 'dvt_${"2".repeat(48)}' WHERE call_id = 'call-ok'`));
  // Intent-only call: no Hub action joins it, so only the recomputed key can expose a forged idempotency key.
  reject("reference_broken", db(S, `UPDATE device_calls SET idempotency_key = 'dvt_${"4".repeat(48)}' WHERE call_id = 'call-intent'`));
  reject("reference_broken", db(S, `UPDATE device_calls SET generation = 3 WHERE call_id = 'call-ok'`));
  reject("reference_broken", db(H, `UPDATE actions SET request_hash = '${"3".repeat(64)}' WHERE id = '${f.okAction.id}'`));
  // Isolated from late receipts: the unknown action's hash, and the request body of the never-attached action.
  reject("reference_broken", db(H, `UPDATE actions SET request_hash = '${"5".repeat(64)}' WHERE id = '${f.unknownAction.id}'`));
  reject("reference_broken", db(H, `UPDATE actions SET request = replace(request, 'synthetic line', 'forged line') WHERE id NOT IN ('${f.okAction.id}', '${f.unknownAction.id}') AND substr(idempotency_key, 1, 4) = 'dvt_'`));
  reject("reference_broken", (d) => { db(S, `UPDATE device_calls SET action_id = 'act_missing' WHERE call_id = 'call-intent'`)(d); d.manifest.counts.deviceSurface.attachedCalls += 1; });
  reject("reference_broken", db(S, `UPDATE composite_call_bindings SET connection_id = 'dvr_missing'`));
  reject("reference_broken", () => {}, OLD_CATALOG);
  reject("invalid_input", () => {}, null);
  // Coverage, members and reconciliation must agree with each other.
  reject("corrupt", (d) => { d.manifest.coverage.deviceSurface = "absent"; });
  reject("corrupt", (d) => { d.manifest.completeness = "partial"; });
  reject("corrupt", (d) => encode(d, d.manifest.members.map((m: { name: string }) => m.name).filter((name: string) => name !== S)));
  reject("corrupt", (d) => { d.manifest.reconciliation.intentOnlyCalls = 0; });
  reject("corrupt", (d) => { d.manifest.reconciliation = null; });
  reject("corrupt", (d) => { d.manifest.counts.deviceRegistry.offers.open = 0; });
  reject("unsupported_schema", (d) => { d.manifest.coverage.excludedByFormat = []; });
  reject("unsupported_schema", (d) => { d.manifest.coverage.appClients = "included"; });
  reject("unsupported_schema", (d) => { d.manifest.coverage.relayConsumer = "excluded_by_caller"; });
  reject("corrupt", (d) => { delete d.manifest.coverage.relayConsumer; });
  reject("unsupported_schema", (d) => { d.manifest.capture.atomicity = "distributed_transaction"; });
});

test("interrupted cross-file steps are classified and reported, never completed", async (t) => {
  const f = await g4(t);
  // Interrupted revocation: Hub revoked, registry write lost. Interrupted approval: claim left approving, Hub device unbound.
  const raw = new DatabaseSync(join(f.dataDir, "devices.sqlite"));
  t.after(() => raw.close());
  f.store.revokeDevice(f.deviceId);
  const offer = f.registry.createOffer({ kind: "pair" });
  const { claimId } = f.registry.claim({ offerId: offer.offerId, code: offer.code, clientFingerprint: fp("F"), name: "Interrupted", capabilities: [TOOL] });
  f.store.withWriterLease(() => { raw.prepare("UPDATE claims SET status = 'approving' WHERE id = ?").run(claimId); });
  f.store.registerDevice({ name: "Unbound Mac", platform: "macos", capabilities: [TOOL] });
  const before = dump(join(f.dataDir, "devices.sqlite"));
  const receipt = capture(f);
  assert.equal(dump(join(f.dataDir, "devices.sqlite")), before, "capture does not fail or resume the approving claim at the source");
  assert.equal(receipt.reconciliation?.interruptedRevocations, 1);
  assert.equal(receipt.reconciliation?.interruptedApprovals, 1);
  assert.equal(receipt.reconciliation?.hubMacDevicesWithoutPin, 1);
  const restored = restoreForInspection({ artifact: receipt.path, key: fixtureKey(), destination: join(f.root, "inspect"), operationCatalog: CURRENT_CATALOG });
  assert.deepEqual(restored.reconciliation, receipt.reconciliation);
  assert.equal(restored.projection?.deviceRegistry?.claimsFailed, 2, "pending and approving claims are neutralized in the projection only");
});

test("legacy version 1 artifacts stay explicit, partial and inspection-only", (t) => {
  const root = workspace(t);
  const dataDir = join(root, "data"); const out = join(root, "out"); mkdirSync(out, { mode: 0o700 });
  const store = new HostStore({ dataDir });
  t.after(() => store.close());
  const bot = store.createBot({ name: "Legacy", profileId: "personal", engine: "claude" });
  store.appendMessage(store.createThread(bot.id).id, { clientMessageId: "m1", content: "synthetic legacy" });
  // Historical fixture: the same file at Hub schema 2 (v3 enrollment table and triggers removed).
  const raw = new DatabaseSync(join(dataDir, "dexter.sqlite"));
  raw.exec("BEGIN IMMEDIATE; DROP TRIGGER host_authority_no_delete; DROP TRIGGER host_authority_revoked_final; DROP TRIGGER host_authority_forward; DROP TABLE host_authority; DROP TRIGGER client_enrollment_no_update; DROP TRIGGER client_enrollment_no_delete; DROP TABLE client_device_enrollments; PRAGMA user_version = 2; COMMIT;");
  raw.close();
  const include = { context: false, agenda: false };
  // Schema 4: a live store whose authority vanished under it (here: the downgrade) no longer lends its writer fence,
  // for either format; nothing is captured.
  assert.throws(() => captureInspectionSnapshot({ source: store, include: { ...include, deviceRegistry: false, deviceSurface: false }, key: fixtureKey(), output: join(out, "v2.dxg8") }), code("fence_unavailable"));
  assert.throws(() => captureInspectionSnapshot({ source: store, version: 1, include, key: fixtureKey(), output: join(out, "v1-live.dxg8") }), code("fence_unavailable"));
  assert.deepEqual(readdirSync(out), []);
  // Historical artifact production only (the restore side is under test): an explicit fixture fence over the closed
  // schema-2 file, which current code can no longer open as a writer.
  const historical = { databasePath: store.databasePath, ownerId: store.ownerId, hostId: store.hostId, withWriterLease: <T>(operation: () => T): T => operation() };
  assert.throws(() => captureInspectionSnapshot({ source: historical, include: { ...include, deviceRegistry: false, deviceSurface: false }, key: fixtureKey(), output: join(out, "v2.dxg8") }), code("unsupported_schema"));
  const receipt = captureInspectionSnapshot({ source: historical, version: 1, include, key: fixtureKey(), output: join(out, "v1.dxg8") });
  assert.equal(receipt.version, 1);
  assert.equal(receipt.completeness, "legacy_v1_partial");
  assert.equal(receipt.coverage, null);
  const restored = restoreForInspection({ artifact: receipt.path, key: fixtureKey(), destination: join(root, "inspect") });
  assert.equal(restored.version, 1);
  assert.equal(restored.completeness, "legacy_v1_partial");
  assert.equal(restored.projection, null);
  const quarantine = JSON.parse(readFileSync(join(root, "inspect", QUARANTINE_FILE), "utf8"));
  assert.ok(quarantine.excluded.includes("devices.sqlite") && quarantine.excluded.includes("device-tools.sqlite"));
  // A v1 manifest can never carry device members or claim coverage.
  const d = decode(unseal(readFileSync(receipt.path)));
  d.members.set("device-registry.sqlite", Buffer.from("x"));
  writeFileSync(join(out, "f1.dxg8"), reseal(encode(d, [...d.manifest.members.map((m: { name: string }) => m.name), "device-registry.sqlite"])));
  assert.throws(() => restoreForInspection({ artifact: join(out, "f1.dxg8"), key: fixtureKey(), destination: join(root, "x") }), code("unsafe_path"));
  const e = decode(unseal(readFileSync(receipt.path)));
  e.manifest.coverage = { hub: "included" };
  writeFileSync(join(out, "f2.dxg8"), reseal(encode(e)));
  assert.throws(() => restoreForInspection({ artifact: join(out, "f2.dxg8"), key: fixtureKey(), destination: join(root, "y") }), code("corrupt"));
});

test("composite bindings must carry their device call's args_hash, at capture and at authenticated restore", async (t) => {
  const f = await g4(t);
  const receipt = capture(f);
  const scratch = join(f.root, "scratch"); mkdirSync(scratch);
  const OTHER = "b".repeat(64);
  const bind = (callId: string, hash: string): string => `INSERT INTO composite_call_bindings SELECT turn_id, call_id, bot_id, thread_id, 'device', route_id, tool, `
    + (hash === "same" ? "args_hash" : `'${hash}'`) + ` FROM device_calls WHERE call_id = '${callId}'`;
  const forge = (name: string, sql: string): string => {
    const d = decode(unseal(readFileSync(receipt.path)));
    d.members.set("device-surface.sqlite", mutateDatabase(d.members.get("device-surface.sqlite")!, scratch, sql));
    d.manifest.counts.deviceSurface.compositeBindings.device += sql.startsWith("INSERT") ? 1 : 0;
    const path = join(f.out, name);
    writeFileSync(path, reseal(encode(d)), { flag: "wx" });
    return path;
  };
  const restore = (artifact: string, destination: string) => restoreForInspection({ artifact, key: fixtureKey(), destination, operationCatalog: CURRENT_CATALOG });
  // Controls: the same binding with the child's own hash, and a different hash on the intent-only binding (no child call), both restore.
  assert.ok(restore(forge("same-ok.dxg8", bind("call-ok", "same")), join(f.root, "same-ok")));
  assert.ok(restore(forge("intent-only.dxg8", `UPDATE composite_call_bindings SET args_hash = '${OTHER}' WHERE call_id = 'call-composite'`), join(f.root, "intent-only")));
  // Isolated: identity, surface, route, tool, bot, thread and turn all agree; only the content hash differs from the child call.
  for (const callId of ["call-ok", "call-unknown"]) {
    const destination = join(f.root, `never-${callId}`);
    const before = readdirSync(f.root).sort();
    assert.throws(() => restore(forge(`${callId}.dxg8`, bind(callId, OTHER)), destination), code("reference_broken"), callId);
    assert.equal(existsSync(destination), false, "no projected output");
    assert.deepEqual(readdirSync(f.root).sort(), before);
  }
  // The shared validator refuses the same conflict in the source at capture, before anything is sealed or left staged.
  const raw = new DatabaseSync(join(f.dataDir, "device-tools.sqlite"));
  t.after(() => raw.close());
  f.store.withWriterLease(() => { raw.exec(bind("call-ok", OTHER)); });
  const source = dump(join(f.dataDir, "device-tools.sqlite"));
  const outBefore = readdirSync(f.out).sort();
  assert.throws(() => capture(f, { output: join(f.out, "conflict.dxg8") }), code("reference_broken"));
  assert.deepEqual(readdirSync(f.out).sort(), outBefore, "no artifact and no staging left");
  assert.equal(dump(join(f.dataDir, "device-tools.sqlite")), source);
});

test("a lone WAL or SHM sidecar or a rollback journal is refused before SQLite opens the source", async (t) => {
  const f = await g4(t);
  await f.surface.close(); f.registry.close();
  const closed = readdirSync(f.dataDir).sort();
  assert.ok(!closed.some((name) => name.startsWith("devices.sqlite-") || name.startsWith("device-tools.sqlite-")), "device stores are closed, no sidecars");
  // Raw bytes only: even a read-only SQLite handle (such as `dump`) on a closed WAL store creates sidecars.
  const sources = ["devices.sqlite", "device-tools.sqlite"].map((name) => join(f.dataDir, name));
  const raw = sources.map((path) => readFileSync(path));
  let n = 0;
  for (const file of ["devices.sqlite", "device-tools.sqlite"]) {
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = join(f.dataDir, `${file}${suffix}`);
      const bytes = n % 2 === 0 ? Buffer.alloc(0) : randomBytes(64);
      writeFileSync(sidecar, bytes, { flag: "wx", mode: 0o600 });
      const listed = readdirSync(f.dataDir).sort();
      assert.throws(() => capture(f, { output: join(f.out, `lone-${n += 1}.dxg8`) }), code("corrupt"), `${file}${suffix}`);
      assert.deepEqual(readdirSync(f.dataDir).sort(), listed, `${file}${suffix}: no partner sidecar created at the source`);
      assert.deepEqual(readFileSync(sidecar), bytes, `${file}${suffix}: sidecar bytes preserved`);
      assert.deepEqual(readdirSync(f.out), [], `${file}${suffix}: no artifact and no plaintext staging left`);
      unlinkSync(sidecar);
    }
  }
  assert.deepEqual(sources.map((path) => readFileSync(path)), raw, "main files byte-identical");
  // The closed store (no sidecars) and, below, the open store (complete pair) still capture.
  assert.ok(capture(f, { output: join(f.out, "closed.dxg8") }));
  assert.deepEqual(readdirSync(f.dataDir).sort(), closed);
});

test("a staged copy is owned the moment it exists: a post-copy sidecar failure leaves no plaintext behind", async (t) => {
  const f = await g4(t);
  // Fault injection only: right after the real VACUUM INTO of the registry, a foreign sidecar appears at the source.
  const foreign = join(f.dataDir, "devices.sqlite-journal");
  const prepare = DatabaseSync.prototype.prepare;
  t.after(() => { DatabaseSync.prototype.prepare = prepare; });
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (sql !== "VACUUM INTO ?") return statement;
    const run = statement.run.bind(statement);
    return Object.assign(Object.create(statement), {
      run: (target: string) => {
        const result = run(target);
        if (target.endsWith("device-registry.sqlite")) writeFileSync(foreign, "foreign", { flag: "wx", mode: 0o600 });
        return result;
      },
    });
  } as typeof prepare;
  assert.throws(() => capture(f), code("unsafe_path"));
  DatabaseSync.prototype.prepare = prepare;
  assert.deepEqual(readdirSync(f.out), [], "the adopted staged copies and staging directory are removed");
  assert.equal(readFileSync(foreign, "utf8"), "foreign", "the foreign source sidecar is preserved");
  unlinkSync(foreign);
  assert.ok(capture(f, { output: join(f.out, "after.dxg8") }));
});
