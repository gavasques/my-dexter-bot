// ClientPairingRegistry over a real HostStore: typed offers, single-use claims, canonical enrollment journal,
// crash recovery between the two databases, rotation and canonical-first revocation. Synthetic data only.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { HostError, HostStore } from "@dexter/hub";
// The package index export of ClientPairingRegistry is staged with its owner; import the module directly.
import { DevicePairingRegistry } from "@dexter/devices";
import { ClientPairingRegistry } from "../packages/devices/src/client-registry.js";
import { DeviceError } from "../packages/devices/src/errors.js";

const deviceCode = (c: string) => (e: unknown) => e instanceof DeviceError && e.code === c;
const fp = (ch: string) => ch.repeat(64);
interface Lab { dir: string; store: HostStore; registry: ClientPairingRegistry; reopen(): ClientPairingRegistry }
function lab(t: TestContext, offset = { ms: 0 }): Lab {
  const root = mkdtempSync(join(tmpdir(), "dexter-client-registry-")); chmodSync(root, 0o700);
  const dir = join(root, "host");
  const store = new HostStore({ dataDir: dir, clock: () => Date.now() + offset.ms });
  const l: Lab = { dir, store, registry: new ClientPairingRegistry(store),
    reopen() { l.registry.close(); l.registry = new ClientPairingRegistry(store); return l.registry; } };
  t.after(() => { l.registry.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return l;
}
function claim(l: Lab, fingerprint: string, scopes: ("chat.read" | "chat.write" | "devices.read")[] = ["chat.write", "chat.read"], role: "client-ios" | "client-mac" = "client-ios") {
  const offer = l.registry.createOffer({ kind: "pair", role, scopes });
  return { offer, ...l.registry.claim({ offerId: offer.offerId, code: offer.code, name: " Lab Phone ", clientFingerprint: fingerprint }) };
}
const counts = (l: Lab) => ({ devices: l.store.listDevices().length, bots: l.store.listBots().length, actions: l.store.listActions().length });

test("owner offer fixes role/scopes; approval enrolls one canonical client device with no capabilities or grants", (t) => {
  const l = lab(t);
  const { offer, claimId } = claim(l, fp("a"));
  assert.deepEqual(offer.scopes, ["chat.read", "chat.write"]);
  assert.equal(l.registry.authenticate(fp("a")), null, "a claim alone never authenticates");
  assert.equal(l.registry.claimStatus(claimId, fp("a")).status, "pending");
  assert.throws(() => l.registry.claimStatus(claimId, fp("b")), deviceCode("not_found"));
  const [pending] = l.registry.listPendingClaims();
  assert.equal(pending!.role, "client-ios"); assert.equal(pending!.name, "Lab Phone");
  const { deviceId } = l.registry.approveClaim(claimId);
  const device = l.store.getDevice(deviceId);
  assert.equal(device.platform, "ios"); assert.deepEqual(device.capabilities, []);
  assert.deepEqual(counts(l), { devices: 1, bots: 0, actions: 0 });
  const binding = l.registry.authenticate(fp("a"))!;
  assert.deepEqual({ ...binding, scopes: [...binding.scopes] }, { installationId: l.store.hostId, ownerId: l.store.ownerId, deviceId, role: "client-ios",
    scopes: ["chat.read", "chat.write"], fingerprint: fp("a"), generation: 1, revision: 1, status: "active" });
  const status = l.registry.claimStatus(claimId, fp("a"));
  assert.deepEqual([status.status, status.deviceId, status.pinGeneration, status.bindingRevision], ["approved", deviceId, 1, 1]);
  const enrollment = l.store.findClientDeviceEnrollment({ namespace: "app-client-v1", claimId })!;
  assert.equal(enrollment.deviceId, deviceId); assert.equal(enrollment.fingerprint, fp("a"));
  // A client-mac binding is macos but still capability-free and absent from the Mac agent registry.
  const mac = claim(l, fp("c"), ["chat.read"], "client-mac");
  const macId = l.registry.approveClaim(mac.claimId).deviceId;
  assert.equal(l.store.getDevice(macId).platform, "macos");
  const agents = new DevicePairingRegistry(l.store);
  try {
    assert.equal(agents.authenticate(fp("c")), null);
    assert.equal(agents.pinBinding(macId), null);
  } finally { agents.close(); }
  assert.throws(() => l.registry.createOffer({ kind: "pair", role: "agent-mac" as never, scopes: [] }), deviceCode("invalid_input"));
  assert.throws(() => l.registry.createOffer({ kind: "pair", role: "client-ios", scopes: ["chat.read", "chat.read"] }), deviceCode("invalid_input"));
  assert.throws(() => l.registry.createOffer({ kind: "pair", role: "client-ios", scopes: ["tools.run" as never] }), deviceCode("invalid_input"));
});

test("codes are hashed, bounded, single-use and expire; refusals are uniform", (t) => {
  const offset = { ms: 0 };
  const l = lab(t, offset);
  const offer = l.registry.createOffer({ kind: "pair", role: "client-ios", scopes: [] });
  const bad = "x".repeat(43);
  for (let i = 0; i < 5; i++) assert.throws(() => l.registry.claim({ offerId: offer.offerId, code: bad, name: "P", clientFingerprint: fp("a") }), deviceCode("forbidden"));
  assert.throws(() => l.registry.claim({ offerId: offer.offerId, code: offer.code, name: "P", clientFingerprint: fp("a") }), deviceCode("forbidden"), "exhausted");
  const once = l.registry.createOffer({ kind: "pair", role: "client-ios", scopes: [] });
  l.registry.claim({ offerId: once.offerId, code: once.code, name: "P", clientFingerprint: fp("b") });
  assert.throws(() => l.registry.claim({ offerId: once.offerId, code: once.code, name: "P", clientFingerprint: fp("c") }), deviceCode("forbidden"), "replay");
  const again = l.registry.createOffer({ kind: "pair", role: "client-ios", scopes: [] });
  assert.throws(() => l.registry.claim({ offerId: again.offerId, code: again.code, name: "P", clientFingerprint: fp("b") }), deviceCode("forbidden"), "one claim per certificate");
  assert.throws(() => l.registry.claim({ offerId: again.offerId, code: again.code, name: "bad\u0007", clientFingerprint: fp("d") }), deviceCode("invalid_input"));
  offset.ms = 11 * 60_000;
  assert.throws(() => l.registry.claim({ offerId: again.offerId, code: again.code, name: "P", clientFingerprint: fp("d") }), deviceCode("forbidden"), "expired");
  const db = new DatabaseSync(l.registry.databasePath, { readOnly: true });
  try {
    const text = JSON.stringify(db.prepare("SELECT * FROM offers").all());
    for (const secret of [offer.code, once.code, again.code]) assert.equal(text.includes(secret), false, "only code hashes are stored");
  } finally { db.close(); }
  const reserved = new ClientPairingRegistry(l.store, { reservedFingerprints: [fp("e")] });
  try {
    const o = reserved.createOffer({ kind: "pair", role: "client-ios", scopes: [] });
    assert.throws(() => reserved.claim({ offerId: o.offerId, code: o.code, name: "P", clientFingerprint: fp("e") }), deviceCode("forbidden"));
  } finally { reserved.close(); }
});

test("crash after the Hub enrollment commit resumes with the same device id; retry never creates a second device", (t) => {
  const l = lab(t);
  const { claimId } = claim(l, fp("a"));
  const original = l.store.registerClientDeviceForClaim.bind(l.store);
  let committed = "";
  l.store.registerClientDeviceForClaim = (input) => { committed = original(input).deviceId; throw new Error("crash after commit"); };
  assert.throws(() => l.registry.approveClaim(claimId), deviceCode("unavailable"));
  delete (l.store as { registerClientDeviceForClaim?: unknown }).registerClientDeviceForClaim;
  assert.equal(l.registry.authenticate(fp("a")), null, "approving never authenticates");
  assert.equal(l.registry.claimStatus(claimId, fp("a")).status, "pending");
  const reopened = l.reopen();
  assert.equal(reopened.authenticate(fp("a"))!.deviceId, committed);
  assert.equal(l.store.listDevices().length, 1);
  // A crash before any Hub commit fails the claim at the next open: no device exists for it.
  const second = claim(l, fp("b"));
  l.store.registerClientDeviceForClaim = () => { throw new HostError("host_locked", "fenced"); };
  assert.throws(() => l.registry.approveClaim(second.claimId), (e: unknown) => e instanceof HostError && e.code === "host_locked");
  delete (l.store as { registerClientDeviceForClaim?: unknown }).registerClientDeviceForClaim;
  // An explicit retry of the interrupted approval resumes it (idempotent canonical key).
  const retried = l.registry.approveClaim(second.claimId);
  assert.equal(l.store.listDevices().length, 2);
  assert.throws(() => l.registry.approveClaim(second.claimId), deviceCode("conflict"));
  assert.equal(l.registry.authenticate(fp("b"))!.deviceId, retried.deviceId);
  const third = claim(l, fp("c"));
  l.store.registerClientDeviceForClaim = () => { throw new HostError("host_locked", "fenced"); };
  assert.throws(() => l.registry.approveClaim(third.claimId));
  delete (l.store as { registerClientDeviceForClaim?: unknown }).registerClientDeviceForClaim;
  l.reopen();
  assert.equal(l.registry.claimStatus(third.claimId, fp("c")).status, "failed");
  assert.equal(l.store.listDevices().length, 2);
});

test("canonical metadata that diverges from an approving claim is revoked and never bound", (t) => {
  const l = lab(t);
  const { offer, claimId } = claim(l, fp("a"), ["chat.read"]);
  // The Hub journal records the claim with different scopes than this registry later holds.
  l.store.registerClientDeviceForClaim({ namespace: "app-client-v1", claimId, name: "Lab Phone", fingerprint: fp("a"), role: "client-ios", scopes: ["chat.read", "chat.write"] });
  const db = new DatabaseSync(l.registry.databasePath);
  db.prepare("UPDATE claims SET status = 'approving' WHERE id = ?").run(claimId);
  db.close();
  assert.doesNotThrow(() => l.reopen(), "recovery resolves the divergence instead of binding it");
  assert.equal(l.registry.authenticate(fp("a")), null);
  assert.equal(l.registry.claimStatus(claimId, fp("a")).status, "failed");
  const [device] = l.store.listDevices();
  assert.notEqual(device!.revokedAt, null, "the divergent canonical device is revoked");
  assert.equal(l.store.listDevices().length, 1);
  void offer;
});

test("rotation keeps id/role/scopes, bumps counters and retires the old pin; revocation is canonical first", (t) => {
  const l = lab(t);
  const { claimId } = claim(l, fp("a"));
  const { deviceId } = l.registry.approveClaim(claimId);
  const rotate = l.registry.createOffer({ kind: "rotate", deviceId });
  assert.equal(rotate.role, "client-ios"); assert.deepEqual(rotate.scopes, ["chat.read", "chat.write"]);
  const rotated = l.registry.claim({ offerId: rotate.offerId, code: rotate.code, name: "New", clientFingerprint: fp("b") });
  assert.equal(l.registry.approveClaim(rotated.claimId).deviceId, deviceId);
  assert.equal(l.registry.authenticate(fp("a")), null);
  const binding = l.registry.authenticate(fp("b"))!;
  assert.deepEqual([binding.deviceId, binding.generation, binding.revision, binding.role], [deviceId, 2, 2, "client-ios"]);
  assert.equal(l.store.getDevice(deviceId).name, "Lab Phone", "a rotation name is not applied");
  l.store.renameDevice(deviceId, { name: "Renamed" });
  assert.equal(l.registry.authenticate(fp("b"))!.revision, 2, "rename never changes the binding");
  l.reopen();
  assert.equal(l.registry.authenticate(fp("b"))!.generation, 2);
  // Canonical revocation alone already denies, even before the auxiliary registry learns about it.
  l.store.revokeDevice(deviceId);
  assert.equal(l.registry.authenticate(fp("b")), null);
  assert.equal(l.registry.binding(deviceId)!.status, "revoked");
  const revoked = l.registry.revokeDevice(deviceId);
  assert.deepEqual(revoked.fingerprints.sort(), [fp("a"), fp("b")]);
  assert.equal(l.registry.binding(deviceId)!.revision, 3);
  assert.throws(() => l.registry.createOffer({ kind: "rotate", deviceId }), deviceCode("conflict"));
  assert.throws(() => l.registry.revokeDevice(l.store.registerDevice({ name: "Legacy", platform: "macos", capabilities: [] }).id), deviceCode("not_found"));
  // Re-pairing after revocation is a new id without grants; the old pins stay unusable.
  const again = claim(l, fp("c"));
  assert.notEqual(l.registry.approveClaim(again.claimId).deviceId, deviceId);
  assert.equal(l.store.listActions().length, 0);
});

test("foreign, tampered or unknown registry files are quarantined without being rewritten", (t) => {
  const l = lab(t);
  claim(l, fp("a"));
  const path = l.registry.databasePath;
  l.registry.close();
  const tamper = (sql: string, restore: string): void => {
    const db = new DatabaseSync(path); db.exec(sql); db.close();
    assert.throws(() => new ClientPairingRegistry(l.store), deviceCode("conflict"));
    const fix = new DatabaseSync(path); fix.exec(restore); fix.close();
  };
  tamper("UPDATE meta SET value = 'own_other' WHERE key = 'owner_id'", `UPDATE meta SET value = '${l.store.ownerId}' WHERE key = 'owner_id'`);
  tamper("CREATE TABLE extra (x INTEGER)", "DROP TABLE extra");
  // An imported trigger could undo a revocation or a binding change: any object outside the exact schema is refused.
  tamper("CREATE TRIGGER undo_revoke AFTER UPDATE ON client_bindings BEGIN UPDATE client_bindings SET status = 'active'; END", "DROP TRIGGER undo_revoke");
  tamper("CREATE TRIGGER Undo AFTER UPDATE ON CLIENT_CERTS BEGIN SELECT 1; END", "DROP TRIGGER Undo");
  tamper("CREATE INDEX extra_idx ON claims (name)", "DROP INDEX extra_idx");
  tamper("UPDATE claims SET role = 'client-mac'", "UPDATE claims SET role = 'client-ios'");
  tamper("UPDATE offers SET scopes = '[\"chat.write\",\"chat.read\"]'; UPDATE claims SET scopes = '[\"chat.write\",\"chat.read\"]'",
    "UPDATE offers SET scopes = '[\"chat.read\",\"chat.write\"]'; UPDATE claims SET scopes = '[\"chat.read\",\"chat.write\"]'");
  l.registry = new ClientPairingRegistry(l.store);
  assert.equal(l.registry.listPendingClaims().length, 1);
});
