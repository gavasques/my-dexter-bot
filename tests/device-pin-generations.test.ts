// Persistent pin bindings of the device registry (schema v2) and the fenced v1 -> v2 migration.
// Synthetic fixture pins (hex constants) only: they are NOT genuine paired identities and prove nothing
// about Keychain/Secure Enclave keys. No network, engine, account or user data.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { HostError, HostStore } from "@dexter/hub";
import { DeviceError, DevicePairingRegistry, FILE_APPEND } from "@dexter/devices";

const pin = (c: string): string => c.repeat(64);
const conflict = (e: unknown) => e instanceof DeviceError && e.code === "conflict";
const hostCode = (c: string) => (e: unknown) => e instanceof HostError && e.code === c;

function lab(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "dexter-pin-gen-"));
  chmodSync(root, 0o700);
  const dataDir = join(root, "host");
  let store = new HostStore({ dataDir });
  let registry = new DevicePairingRegistry(store);
  t.after(() => { try { registry.close(); } catch { /* closed */ } try { store.close(); } catch { /* closed */ } rmSync(root, { recursive: true, force: true }); });
  const db = (): DatabaseSync => new DatabaseSync(registry.databasePath);
  const raw = <T>(fn: (d: DatabaseSync) => T): T => { const d = db(); try { return fn(d); } finally { d.close(); } };
  function claim(kind: "pair" | "rotate", fp: string, deviceId?: string): string {
    const offer = kind === "pair" ? registry.createOffer({ kind }) : registry.createOffer({ kind, deviceId: deviceId! });
    return registry.claim({ offerId: offer.offerId, code: offer.code, clientFingerprint: fp, name: "Fixture Mac", capabilities: [FILE_APPEND] }).claimId;
  }
  return {
    root, dataDir, raw,
    get store() { return store; }, get registry() { return registry; },
    pair(fp: string): string { return registry.approveClaim(claim("pair", fp)).deviceId; },
    rotate(deviceId: string, fp: string): void { registry.approveClaim(claim("rotate", fp, deviceId)); },
    claim,
    restart(): void { registry.close(); store.close(); store = new HostStore({ dataDir }); registry = new DevicePairingRegistry(store); },
    closeAll(): void { registry.close(); store.close(); },
    reopen(): DevicePairingRegistry { store = new HostStore({ dataDir }); registry = new DevicePairingRegistry(store); return registry; },
    reopenStoreOnly(): HostStore { store = new HostStore({ dataDir }); return store; },
  };
}
const shape = (s: ReturnType<DevicePairingRegistry["pinBinding"]>) => s && { fp: s.fingerprint, generation: s.generation, revision: s.revision, status: s.status };

test("pairing starts at generation 1; rotation and the first revocation are counted once and persist across restart", (t) => {
  const l = lab(t);
  const id = l.pair(pin("a"));
  const first = l.registry.pinBinding(id)!;
  assert.deepEqual({ ...first }, { installationId: l.store.hostId, ownerId: l.store.ownerId, deviceId: id, fingerprint: pin("a"), generation: 1, revision: 1, status: "active" });
  assert.ok(Object.isFrozen(first));
  l.rotate(id, pin("b"));
  assert.deepEqual(shape(l.registry.pinBinding(id)), { fp: pin("b"), generation: 2, revision: 2, status: "active" });
  l.restart();
  assert.deepEqual(shape(l.registry.pinBinding(id)), { fp: pin("b"), generation: 2, revision: 2, status: "active" });
  l.registry.revokeDevice(id);
  assert.deepEqual(shape(l.registry.pinBinding(id)), { fp: pin("b"), generation: 2, revision: 3, status: "revoked" });
  l.registry.revokeDevice(id);
  l.restart();
  assert.deepEqual(shape(l.registry.pinBinding(id)), { fp: pin("b"), generation: 2, revision: 3, status: "revoked" }, "revocation is idempotent");
});

test("no binding for unapproved, rejected, failed-partial or foreign devices; reusing any bound pin is refused", (t) => {
  const l = lab(t);
  const pending = l.claim("pair", pin("c"));
  assert.equal(l.registry.listPendingClaims()[0]!.claimId, pending);
  assert.equal(l.raw((d) => d.prepare("SELECT COUNT(*) AS n FROM device_bindings").get() as { n: number }).n, 0);
  l.registry.rejectClaim(pending);
  // HostStore device registered directly (an approval interrupted before its pin bind): never a binding.
  const orphan = l.store.registerDevice({ name: "Orphan", platform: "macos", capabilities: [FILE_APPEND] });
  assert.equal(l.registry.pinBinding(orphan.id), null);
  assert.equal(l.registry.pinBinding("dev_missing"), null);
  assert.equal(l.registry.pinBinding(undefined as unknown as string), null);
  // Approval whose second fenced step fails: the HostStore device is revoked and has no binding.
  const failing = l.claim("pair", pin("d"));
  l.raw((d) => d.exec(`CREATE TRIGGER fail_bind BEFORE INSERT ON device_bindings BEGIN SELECT RAISE(ABORT, 'fixture'); END`));
  assert.throws(() => l.registry.approveClaim(failing));
  l.raw((d) => d.exec("DROP TRIGGER fail_bind"));
  const partial = l.store.listDevices().find((d) => d.name === "Fixture Mac")!;
  assert.notEqual(partial.revokedAt, null);
  assert.equal(l.registry.pinBinding(partial.id), null);
  assert.equal(l.raw((d) => d.prepare("SELECT COUNT(*) AS n FROM device_certs").get() as { n: number }).n, 0, "the failed bind left no pin");
  // A -> B -> A: a pin ever bound (even retired) can never be claimed again, by the same or another device.
  const id = l.pair(pin("a"));
  l.rotate(id, pin("b"));
  assert.throws(() => l.claim("rotate", pin("a"), id), (e: unknown) => e instanceof DeviceError && e.code === "forbidden");
  assert.throws(() => l.claim("pair", pin("a")), (e: unknown) => e instanceof DeviceError && e.code === "forbidden");
  assert.deepEqual(shape(l.registry.pinBinding(id)), { fp: pin("b"), generation: 2, revision: 2, status: "active" });
});

test("HostStore revocation overrides a stale active binding when the registry write was lost; the first registry revoke counts once", (t) => {
  const l = lab(t);
  const id = l.pair(pin("a"));
  l.store.revokeDevice(id); // writer loss between the canonical revoke and the registry transaction
  assert.deepEqual(shape(l.registry.pinBinding(id)), { fp: pin("a"), generation: 1, revision: 1, status: "revoked" });
  assert.equal(l.registry.authenticate(pin("a")), null);
  l.registry.revokeDevice(id);
  l.registry.revokeDevice(id);
  assert.deepEqual(shape(l.registry.pinBinding(id)), { fp: pin("a"), generation: 1, revision: 2, status: "revoked" });
});

test("counter overflow is a conflict with no effect on pins, claims or the binding", (t) => {
  const l = lab(t);
  const id = l.pair(pin("a"));
  const max = Number.MAX_SAFE_INTEGER;
  l.raw((d) => d.prepare("UPDATE device_bindings SET generation = ?, revision = ?").run(max, max));
  const claimId = l.claim("rotate", pin("b"), id);
  assert.throws(() => l.registry.approveClaim(claimId), conflict);
  assert.equal(l.registry.activeFingerprint(id), pin("a"));
  assert.equal(l.registry.listPendingClaims()[0]!.claimId, claimId, "claim still pending: the transaction rolled back");
  assert.deepEqual(shape(l.registry.pinBinding(id)), { fp: pin("a"), generation: max, revision: max, status: "active" });
  // Revoke: HostStore first (irreversible), then the registry transaction overflows and rolls back entirely.
  assert.throws(() => l.registry.revokeDevice(id), conflict);
  assert.equal(l.registry.listCertificates(id)[0]!.state, "active");
  assert.equal(l.registry.pinBinding(id)!.status, "revoked", "canonical revocation still wins");
  // Non-safe values stored by a foreign writer are refused on read and quarantine on open.
  l.raw((d) => d.prepare("UPDATE device_bindings SET revision = ?").run(2 ** 60));
  assert.throws(() => l.registry.pinBinding(id), conflict);
  l.closeAll();
  assert.throws(() => l.reopen(), conflict);
});

function downgradeToV1(l: ReturnType<typeof lab>): void {
  l.raw((d) => { d.exec("DROP TABLE device_bindings"); d.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'"); });
}
const version = (l: ReturnType<typeof lab>) => l.raw((d) => (d.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
const hasBindings = (l: ReturnType<typeof lab>) => !!l.raw((d) => d.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'device_bindings'").get());

test("v1 -> v2 migration reconciles pin history conservatively and survives restart", (t) => {
  const l = lab(t);
  const a = l.pair(pin("a"));
  l.rotate(a, pin("b"));
  l.rotate(a, pin("c"));
  const r = l.pair(pin("d"));
  l.rotate(r, pin("e"));
  l.registry.revokeDevice(r);
  const plain = l.pair(pin("f"));
  l.closeAll();
  downgradeToV1(l);
  l.reopen();
  assert.equal(version(l), "2");
  assert.deepEqual(shape(l.registry.pinBinding(a)), { fp: pin("c"), generation: 3, revision: 3, status: "active" });
  assert.deepEqual(shape(l.registry.pinBinding(r)), { fp: pin("e"), generation: 2, revision: 3, status: "revoked" });
  assert.deepEqual(shape(l.registry.pinBinding(plain)), { fp: pin("f"), generation: 1, revision: 1, status: "active" });
  // Migration never grants: no HostStore grant exists for any of these devices.
  assert.equal(l.store.getGrant("bot_none", FILE_APPEND, a), null);
  l.rotate(a, pin("7"));
  l.restart();
  assert.deepEqual(shape(l.registry.pinBinding(a)), { fp: pin("7"), generation: 4, revision: 4, status: "active" });
});

test("v1 revoked migration keeps the last inserted pin when timestamps tie or move backwards", (t) => {
  const l = lab(t);
  const tied = l.pair(pin("b"));
  l.rotate(tied, pin("1")); // Last pin sorts before the old one lexically.
  l.registry.revokeDevice(tied);
  const backwards = l.pair(pin("c"));
  l.rotate(backwards, pin("2"));
  l.registry.revokeDevice(backwards);
  l.raw((d) => {
    d.prepare("UPDATE device_certs SET created_at = 100 WHERE device_id = ?").run(tied);
    d.prepare("UPDATE device_certs SET created_at = 200 WHERE fp = ?").run(pin("c"));
    d.prepare("UPDATE device_certs SET created_at = 50 WHERE fp = ?").run(pin("2"));
  });
  l.closeAll();
  downgradeToV1(l);
  l.reopen();
  for (const [id, fp] of [[tied, pin("1")], [backwards, pin("2")]] as const) {
    assert.deepEqual(shape(l.registry.pinBinding(id)), { fp, generation: 2, revision: 3, status: "revoked" });
    assert.equal(l.registry.authenticate(fp), null);
    assert.equal(l.store.getGrant("bot_none", FILE_APPEND, id), null);
  }
  l.restart();
  assert.equal(l.registry.pinBinding(tied)!.fingerprint, pin("1"));
  assert.equal(l.registry.pinBinding(backwards)!.fingerprint, pin("2"));
});

test("migration is fenced and all-or-nothing: inconsistent history, foreign owner, unsupported or partial schema are quarantined untouched", (t) => {
  const l = lab(t);
  const a = l.pair(pin("a"));
  l.pair(pin("b"));
  l.closeAll();
  downgradeToV1(l);
  // Inconsistent v1 history (an active and a revoked pin on one device): nothing is migrated.
  l.raw((d) => d.prepare("INSERT INTO device_certs (fp, device_id, state, created_at, updated_at) VALUES (?, ?, 'revoked', 1, 1)").run(pin("9"), a));
  assert.throws(() => l.reopen(), conflict);
  l.store.close();
  assert.equal(version(l), "1");
  assert.equal(hasBindings(l), false, "the failed migration rolled back its DDL");
  l.raw((d) => d.prepare("DELETE FROM device_certs WHERE fp = ?").run(pin("9")));
  // Foreign installation: ownership is checked before any migration.
  const installation = l.raw((d) => (d.prepare("SELECT value FROM meta WHERE key = 'installation_id'").get() as { value: string }).value);
  l.raw((d) => d.prepare("UPDATE meta SET value = 'hst_foreign' WHERE key = 'installation_id'").run());
  assert.throws(() => l.reopen(), conflict);
  l.store.close();
  assert.equal(version(l), "1");
  assert.equal(hasBindings(l), false);
  l.raw((d) => d.prepare("UPDATE meta SET value = ? WHERE key = 'installation_id'").run(installation));
  // A second host cannot migrate while the writer is held.
  const holder = l.reopenStoreOnly();
  assert.throws(() => new DevicePairingRegistry(new HostStore({ dataDir: l.dataDir })), hostCode("host_locked"));
  assert.equal(version(l), "1");
  // A writer that lost its lease cannot migrate either.
  const leaseDb = new DatabaseSync(holder.databasePath);
  const token = (leaseDb.prepare("SELECT token FROM host_lease WHERE id = 1").get() as { token: string }).token;
  leaseDb.exec("UPDATE host_lease SET token = 'stolen-by-test'");
  assert.throws(() => new DevicePairingRegistry(holder), hostCode("host_locked"));
  leaseDb.prepare("UPDATE host_lease SET token = ? WHERE id = 1").run(token);
  leaseDb.close();
  assert.equal(version(l), "1");
  assert.equal(hasBindings(l), false);
  holder.close();
  // Unsupported versions and partial schemas.
  for (const [setup, label] of [
    [(d: DatabaseSync) => d.exec("UPDATE meta SET value = '3' WHERE key = 'schema_version'"), "future version"],
    [(d: DatabaseSync) => d.exec("CREATE TABLE device_bindings (device_id TEXT PRIMARY KEY) STRICT"), "v1 with a partial v2 table"],
    [(d: DatabaseSync) => d.exec("UPDATE meta SET value = '2' WHERE key = 'schema_version'"), "v2 missing bindings"],
    [(d: DatabaseSync) => d.exec("CREATE TABLE extra (x TEXT) STRICT"), "unknown table"],
    [(d: DatabaseSync) => d.exec("UPDATE meta SET value = '2' WHERE key = 'schema_version'; CREATE TABLE device_bindings (device_id TEXT PRIMARY KEY) STRICT"), "v2 with wrong binding columns"],
  ] as const) {
    l.raw(setup);
    const store = new HostStore({ dataDir: l.dataDir });
    try { assert.throws(() => new DevicePairingRegistry(store), conflict, label); } finally { store.close(); }
    l.raw((d) => {
      d.exec("DROP TABLE IF EXISTS extra; DROP TABLE IF EXISTS device_bindings;");
      d.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    });
  }
  l.reopen();
  assert.equal(version(l), "2");
  assert.deepEqual(shape(l.registry.pinBinding(a)), { fp: pin("a"), generation: 1, revision: 1, status: "active" });
});

test("v2 bindings that disagree with pin history are quarantined on open", (t) => {
  const l = lab(t);
  const a = l.pair(pin("a"));
  l.rotate(a, pin("b"));
  for (const tamper of [
    "UPDATE device_bindings SET generation = 1",
    "UPDATE device_bindings SET fp = '" + pin("a") + "'",
    "UPDATE device_bindings SET status = 'revoked', revision = 3",
    "DELETE FROM device_bindings",
  ]) {
    l.closeAll();
    const saved = l.raw((d) => d.prepare("SELECT * FROM device_bindings").all());
    l.raw((d) => { d.exec("PRAGMA foreign_keys = OFF"); d.exec(tamper); });
    assert.throws(() => l.reopen(), conflict, tamper);
    l.store.close();
    l.raw((d) => {
      d.exec("DELETE FROM device_bindings");
      for (const row of saved as Array<Record<string, string | number>>) {
        d.prepare("INSERT INTO device_bindings (device_id, fp, generation, revision, status) VALUES (?, ?, ?, ?, ?)")
          .run(row.device_id!, row.fp!, row.generation!, row.revision!, row.status!);
      }
    });
    l.reopen();
  }
  assert.deepEqual(shape(l.registry.pinBinding(a)), { fp: pin("b"), generation: 2, revision: 2, status: "active" });
});
