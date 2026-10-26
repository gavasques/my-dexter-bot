import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostStore } from "@dexter/hub";
import { pairDevice } from "@dexter/devices";
import { memoryTLS } from "./fixtures/relay-host-lab.js";
import { DeviceServices } from "../packages/cli/src/device-services.js";
import { openLocalDeviceCustody } from "../packages/cli/src/local-device-custody.js";
import { createLocalMacAgentSetupBundle } from "../packages/cli/src/local-device-bootstrap.js";
import { SealedCustodyError } from "../packages/cli/src/operator-sealed-custody.js";
const code = (value: string) => (e: unknown) => e instanceof SealedCustodyError && e.code === value;

test("explicit create stores only sealed custody; unlock preserves pin and refuses wrong password/foreign host", async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "dexter-local-custody-"));
  const store = new HostStore({ dataDir: join(root, "host") });
  const other = new HostStore({ dataDir: join(root, "other") });
  const file = join(root, "keys", "local.sealed");
  const password = () => Buffer.from("synthetic isolated operator password");
  const owned = password();
  const result = await openLocalDeviceCustody(store, file, "create", () => owned, 0);
  const tls = result.devices.identity, before = readFileSync(file);
  let services: DeviceServices | undefined;
  t.after(async () => { await services?.close(); await result.custody.close(); store.close(); other.close(); rmSync(root, { recursive: true, force: true }); });
  assert.ok(owned.every(byte => byte === 0));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, "keys")).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(join(root, "keys")), ["local.sealed"]);
  assert.equal(before.subarray(0, 8).toString(), "DXSEAL01");
  assert.equal(before.includes(Buffer.from("PRIVATE KEY")), false);
  const certificate = new X509Certificate(tls.certPem);
  assert.equal(certificate.ca, false);
  assert.equal(certificate.checkIP("127.0.0.1"), "127.0.0.1");
  assert.equal(certificate.checkHost("localhost"), "localhost");
  assert.ok(certificate.verify(certificate.publicKey));
  services = new DeviceServices(store, result.devices);
  await services.start();
  const offer = createLocalMacAgentSetupBundle(store, services.admin).offer;
  assert.equal(offer.hostFingerprint, tls.fingerprint);
  const pairing = pairDevice({ dataDir: join(root, "synthetic-agent"), identity: memoryTLS(), trust: offer,
    offerId: offer.offerId, code: offer.code, name: "Synthetic Mac", capabilities: ["mac.browser.read"], pollIntervalMs: 20 });
  const deadline = Date.now() + 5000;
  while (services.admin.pendingClaims().length === 0) {
    if (Date.now() >= deadline) throw new Error("synthetic TLS claim deadline");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(store.listDevices().length, 0);
  services.admin.approveClaim(services.admin.pendingClaims()[0]!.claimId);
  const paired = await pairing;
  const bot = store.createBot({ name: "Synthetic", profileId: "lab", engine: "claude" });
  assert.equal(store.getGrant(bot.id, "mac.browser.read", paired.deviceId), null);
  await services.close(); services = undefined;
  await result.custody.close();
  const duplicatePassword = password();
  await assert.rejects(openLocalDeviceCustody(store, file, "create", () => duplicatePassword, 0), code("conflict"));
  assert.ok(duplicatePassword.every(byte => byte === 0));
  assert.deepEqual(readFileSync(file), before);
  const wrong = Buffer.from("wrong isolated operator password");
  await assert.rejects(openLocalDeviceCustody(store, file, "unlock", () => wrong, 0), code("authentication_failed"));
  assert.ok(wrong.every(byte => byte === 0));
  await assert.rejects(openLocalDeviceCustody(other, file, "unlock", password, 0), code("authentication_failed"));
  const restarted = await openLocalDeviceCustody(store, file, "unlock", password, 0);
  try { assert.equal(restarted.devices.identity.fingerprint, tls.fingerprint); assert.deepEqual(readFileSync(file), before); }
  finally { await restarted.custody.close(); }
  assert.equal(store.listDevices().length, 1);
});

test("invalid input refuses before callback; missing unlock never creates or repairs custody", async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "dexter-local-custody-refuse-"));
  const store = new HostStore({ dataDir: join(root, "host") });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  let calls = 0;
  const callback = () => { calls++; return Buffer.from("synthetic isolated operator password"); };
  await assert.rejects(openLocalDeviceCustody(store, "relative", "create", callback), code("invalid_input"));
  await assert.rejects(openLocalDeviceCustody(store, join(root, "missing.sealed"), "create", callback, -1), code("invalid_input"));
  assert.equal(calls, 0);
  await assert.rejects(openLocalDeviceCustody(store, join(root, "missing.sealed"), "unlock", callback));
  assert.deepEqual(readdirSync(root), ["host"]);
});
