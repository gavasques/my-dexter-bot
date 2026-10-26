import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostStore } from "@dexter/hub";
import { pairDevice } from "@dexter/devices";
import { prepareLocalDeviceChannel, createLocalMacAgentSetupBundle } from "../packages/cli/src/local-device-bootstrap.js";
import { DeviceServices } from "../packages/cli/src/device-services.js";
import { OperatorSealedCustody } from "../packages/cli/src/operator-sealed-custody.js";
import { memoryTLS } from "./fixtures/relay-host-lab.js";

test("sealed channel bootstrap refuses locked/foreign custody; setup uses canonical identity and grants stay denied", async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "dexter-local-device-bootstrap-"));
  const store = new HostStore({ dataDir: join(root, "host") });
  const expected = { installationId: store.hostId, ownerId: store.ownerId };
  const password = randomBytes(32), tls = memoryTLS(), path = join(root, "keys", "host.sealed");
  const custody = OperatorSealedCustody.create(path, { ...expected, deviceId: "host", generation: 1, keyId: "key" }, password, tls);
  let services: DeviceServices | undefined;
  t.after(async () => { await services?.close(); store.close(); await custody.close(); password.fill(0); rmSync(root, { recursive: true, force: true }); });
  const sealedBefore = readFileSync(path);
  assert.throws(() => prepareLocalDeviceChannel(custody, expected, 0));
  custody.unlock(password);
  assert.throws(() => prepareLocalDeviceChannel(custody, { ...expected, installationId: "foreign" }, 0));
  assert.throws(() => prepareLocalDeviceChannel(custody, expected, -1));
  const options = prepareLocalDeviceChannel(custody, expected, 0);
  assert.equal(options.identity.fingerprint, tls.fingerprint);
  assert.equal(options.listenHost, "127.0.0.1");
  services = new DeviceServices(store, options);
  assert.throws(() => createLocalMacAgentSetupBundle(store, services!.admin));
  await services.start();
  const bundle = createLocalMacAgentSetupBundle(store, services.admin);
  assert.equal(bundle.schema, "dexter.local-mac-agent-setup/1");
  assert.equal(bundle.installationId, store.hostId);
  assert.equal(bundle.offer.hostFingerprint, tls.fingerprint);
  assert.match(bundle.offer.hostUrl, /^https:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(store.listDevices().length, 0);
  assert.equal(services.admin.pendingClaims().length, 0);
  const agentIdentity = memoryTLS();
  const pairing = pairDevice({ dataDir: join(root, "synthetic-agent"), identity: agentIdentity,
    trust: bundle.offer, offerId: bundle.offer.offerId, code: bundle.offer.code,
    name: "Synthetic Mac", capabilities: ["mac.browser.read"], pollIntervalMs: 20 });
  // Claim is only pending; possession of the offer does not authorize this agent automatically.
  const deadline = Date.now() + 5000;
  while (services.admin.pendingClaims().length === 0) {
    if (Date.now() >= deadline) throw new Error("synthetic claim deadline");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(store.listDevices().length, 0);
  const claim = services.admin.pendingClaims()[0]!;
  assert.equal(claim.clientFingerprint, agentIdentity.fingerprint);
  services.admin.approveClaim(claim.claimId);
  const binding = await pairing;
  const bot = store.createBot({ name: "Synthetic", profileId: "lab", engine: "claude" });
  assert.equal(store.getGrant(bot.id, "mac.browser.read", binding.deviceId), null);
  assert.equal(services.http.get(binding.deviceId).presence, "stale");
  assert.deepEqual(readFileSync(path), sealedBefore);
  await services.close(); services = undefined;
  await custody.lock();
  assert.throws(() => prepareLocalDeviceChannel(custody, expected, 0));
});
