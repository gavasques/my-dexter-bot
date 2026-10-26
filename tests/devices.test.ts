// Unit fixtures for @dexter/devices: no TLS server, no network. The real loopback channel is in
// devices-channel.test.ts.
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { inspect } from "node:util";
import { HostError, HostStore } from "@dexter/hub";
import {
  DEVICE_OPERATIONS, DaemonJournal, DeviceError, DevicePairingRegistry, FILE_APPEND, FILE_READ, HandlerRefusal, PROCESS_PROBE,
  UNSUPPORTED_DEVICE_CAPABILITIES, checkCapabilities, checkOperationArgs, createFixtureHandlers, generateSyntheticIdentity, loadIdentity, readBinding,
} from "@dexter/devices";

import { memoryCustody, replaceMemoryKey } from "./fixtures/device-memory-custody.js";

const code = (c: string) => (e: unknown) => e instanceof DeviceError && e.code === c;
function temp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "dexter-devices-unit-"));
  chmodSync(dir, 0o700);
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
const signal = new AbortController().signal;

test("operations are finite, strictly shaped and unsupported capabilities are explicit", () => {
  // Browser/CUA operations are declared since the G4 local capabilities; their shapes are covered in device-local-capabilities.test.ts.
  assert.deepEqual([...DEVICE_OPERATIONS.keys()].filter((tool) => !tool.startsWith("mac.browser.") && !tool.startsWith("mac.cua.")).sort(), [FILE_APPEND, FILE_READ, PROCESS_PROBE].sort());
  assert.deepEqual(checkOperationArgs(FILE_READ, { name: "a.txt" }), { name: "a.txt" });
  for (const bad of [{ name: "../a" }, { name: "a/b" }, { name: ".hidden" }, { name: "a.txt", deviceId: "dev_x" }, {}, { name: 1 }]) {
    assert.throws(() => checkOperationArgs(FILE_READ, bad as never), code("invalid_input"));
  }
  assert.throws(() => checkOperationArgs(FILE_APPEND, { name: "a", line: "x\ny" }), code("invalid_input"));
  assert.throws(() => checkOperationArgs(PROCESS_PROBE, { command: "rm" }), code("invalid_input"));
  for (const tool of UNSUPPORTED_DEVICE_CAPABILITIES) assert.throws(() => checkCapabilities([tool]), code("unsupported"));
  assert.throws(() => checkCapabilities([FILE_READ, FILE_READ]), code("invalid_input"));
  assert.throws(() => checkCapabilities([]), code("invalid_input"));
  assert.deepEqual(checkCapabilities([PROCESS_PROBE, FILE_READ]), [FILE_READ, PROCESS_PROBE].sort());
});

test("identity keeps the private key out of JSON and inspection and requires private files", (t) => {
  const dir = temp(t);
  const id = generateSyntheticIdentity(join(dir, "id"), "unit");
  assert.match(id.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(id).includes("PRIVATE"), false);
  assert.equal(inspect(id, { showHidden: true }).includes("PRIVATE"), false);
  assert.ok(id.keyPem.includes("PRIVATE KEY"));
  assert.throws(() => loadIdentity(join(dir, "id")), code("forbidden"));
  memoryCustody(join(dir, "id"), id, t);
  assert.equal(loadIdentity(join(dir, "id")).fingerprint, id.fingerprint);
  chmodSync(join(dir, "id", "cert.pem"), 0o644);
  assert.throws(() => loadIdentity(join(dir, "id")), code("forbidden"));
  chmodSync(join(dir, "id", "cert.pem"), 0o600);
  const other = generateSyntheticIdentity(join(dir, "other"), "other");
  replaceMemoryKey(join(dir, "id"), other);
  assert.throws(() => loadIdentity(join(dir, "id")), code("invalid_input"));
  assert.notEqual(other.fingerprint, id.fingerprint);
});

test("registry: one-time offers expire, codes are hashed and bound to installation/owner", (t) => {
  const dir = temp(t);
  let now = 1_000_000;
  const store = new HostStore({ dataDir: join(dir, "host"), clock: () => now });
  const registry = new DevicePairingRegistry(store, { offerTtlMs: 60_000 });
  t.after(() => { registry.close(); store.close(); });
  const offer = registry.createOffer({ kind: "pair" });
  assert.equal(readFileSync(registry.databasePath).includes(Buffer.from(offer.code)), false);
  const fp = "a".repeat(64);
  now += 60_000;
  assert.throws(() => registry.claim({ offerId: offer.offerId, code: offer.code, clientFingerprint: fp, name: "Mac", capabilities: [FILE_READ] }), code("forbidden"));
  const fresh = registry.createOffer({ kind: "pair" });
  const { claimId } = registry.claim({ offerId: fresh.offerId, code: fresh.code, clientFingerprint: fp, name: "Mac", capabilities: [FILE_READ] });
  assert.throws(() => registry.claim({ offerId: fresh.offerId, code: fresh.code, clientFingerprint: "b".repeat(64), name: "Mac", capabilities: [FILE_READ] }), code("forbidden"));
  assert.throws(() => registry.claimStatus(claimId, "b".repeat(64)), code("not_found"));
  assert.equal(registry.claimStatus(claimId, fp).status, "pending");
  now += 60_000;
  assert.equal(registry.claimStatus(claimId, fp).status, "expired");
  assert.throws(() => registry.approveClaim(claimId), code("conflict"));
  assert.equal(store.listDevices().length, 0);
  assert.equal(registry.authenticate(fp), null);
});

test("registry approval creates a grantless HostStore device bound to the claimed pin", (t) => {
  const dir = temp(t);
  const store = new HostStore({ dataDir: join(dir, "host") });
  const registry = new DevicePairingRegistry(store);
  t.after(() => { registry.close(); store.close(); });
  const offer = registry.createOffer({ kind: "pair" });
  const fp = "c".repeat(64);
  const { claimId } = registry.claim({ offerId: offer.offerId, code: offer.code, clientFingerprint: fp, name: "  Mac  ", capabilities: [FILE_READ] });
  const { deviceId } = registry.approveClaim(claimId);
  assert.equal(registry.authenticate(fp)?.id, deviceId);
  assert.equal(store.getDevice(deviceId).name, "Mac");
  assert.equal(store.getGrant("any", FILE_READ, deviceId), null);
  assert.throws(() => registry.approveClaim(claimId), code("conflict"));
  registry.revokeDevice(deviceId);
  assert.equal(registry.authenticate(fp), null);
  assert.notEqual(store.getDevice(deviceId).revokedAt, null);
});

test("auxiliary databases refuse symlinks, including dangling ones, and foreign installations", (t) => {
  const dir = temp(t);
  const hostDir = join(dir, "host");
  const first = new HostStore({ dataDir: hostDir });
  const registry = new DevicePairingRegistry(first);
  registry.close();
  first.close();
  const otherDir = join(dir, "other");
  const other = new HostStore({ dataDir: otherDir });
  t.after(() => { other.close(); });
  copyFileSync(join(hostDir, "devices.sqlite"), join(otherDir, "devices.sqlite"));
  assert.throws(() => new DevicePairingRegistry(other), code("conflict"));
  rmSync(join(otherDir, "devices.sqlite"));
  symlinkSync(join(dir, "nowhere.sqlite"), join(otherDir, "devices.sqlite"));
  assert.throws(() => new DevicePairingRegistry(other), code("forbidden"));
  const daemonDir = join(dir, "daemon");
  mkdirSync(daemonDir, { mode: 0o700 });
  symlinkSync(join(dir, "missing"), join(daemonDir, "journal.sqlite"));
  assert.throws(() => new DaemonJournal(daemonDir, { installationId: "host_a", ownerId: "own_a", deviceId: "dev_a" }), code("forbidden"));
  symlinkSync(join(dir, "missing-binding"), join(daemonDir, "binding.json"));
  assert.throws(() => readBinding(daemonDir), code("forbidden"));
});

test("journal: start before effect, crash becomes unknown, binding and single-process lease", (t) => {
  const dir = temp(t);
  const binding = { installationId: "host_a", ownerId: "own_a", deviceId: "dev_a" };
  const begin = { hostId: "host_a", actionId: "act_1", requestHash: "1".repeat(64), nonce: "2".repeat(32), tool: FILE_APPEND };
  const journal = new DaemonJournal(dir, binding);
  assert.equal(journal.begin(begin).kind, "new");
  assert.throws(() => new DaemonJournal(dir, binding), code("conflict"));
  journal.close();
  assert.throws(() => new DaemonJournal(dir, { ...binding, deviceId: "dev_b" }), code("conflict"));
  const reopened = new DaemonJournal(dir, binding);
  t.after(() => { reopened.close(); });
  assert.deepEqual(reopened.entry("act_1"), { status: "unknown", acked: false, code: "daemon_interrupted" });
  const again = reopened.begin(begin);
  assert.equal(again.kind, "existing");
  assert.equal(reopened.begin({ ...begin, requestHash: "3".repeat(64) }).kind, "conflict");
  assert.equal(reopened.begin({ ...begin, actionId: "act_2" }).kind, "new");
  const receipt = reopened.finish("host_a", "act_2", { status: "completed", result: { text: "user data" } });
  assert.deepEqual(receipt.result, { text: "user data" });
  reopened.ack(["act_2"]);
  const replay = reopened.begin({ ...begin, actionId: "act_2" });
  assert.ok(replay.kind === "existing" && (replay.receipt.result as { replayed: boolean }).replayed);
  assert.equal(readFileSync(reopened.databasePath).includes(Buffer.from("user data")), false);
});

test("fixture handlers: selected root only, no symlink follow, constant bounded probe", async (t) => {
  const dir = temp(t);
  const root = join(dir, "root");
  mkdirSync(root, { mode: 0o700 });
  assert.throws(() => createFixtureHandlers({ root, enable: ["mac.cua.control"] }), (e: unknown) => e instanceof HandlerRefusal);
  const handlers = createFixtureHandlers({ root, enable: [FILE_READ, FILE_APPEND, PROCESS_PROBE] });
  writeFileSync(join(dir, "outside.txt"), "secret-outside");
  symlinkSync(join(dir, "outside.txt"), join(root, "link.txt"));
  await assert.rejects(handlers.get(FILE_READ)!({ name: "link.txt" }, { signal }), (e: unknown) => e instanceof HandlerRefusal && e.code === "symlink_refused");
  await assert.rejects(handlers.get(FILE_APPEND)!({ name: "link.txt", line: "x" }, { signal }), (e: unknown) => e instanceof HandlerRefusal);
  assert.equal(readFileSync(join(dir, "outside.txt"), "utf8"), "secret-outside");
  const probe = await handlers.get(PROCESS_PROBE)!({}, { signal }) as Record<string, string>;
  assert.equal(probe.probe, "dexter-synthetic");
  const onlyRead = createFixtureHandlers({ root, enable: [FILE_READ] });
  assert.equal(onlyRead.has(FILE_APPEND), false);
  chmodSync(root, 0o755);
  assert.throws(() => createFixtureHandlers({ root, enable: [FILE_READ] }), code("forbidden"));
});

test("host errors stay HostError for the hub", () => {
  assert.ok(new HostError("forbidden", "x") instanceof Error);
});
