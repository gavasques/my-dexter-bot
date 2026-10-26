import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DeviceHostServer, DevicePairingRegistry, generateSyntheticIdentity } from "@dexter/devices";
import { HostError, HostStore } from "@dexter/hub";
import { createAuthorizedHostRouter, createHostApp, type HostRequestAuthority } from "@dexter/hub/http";
import { DeviceServices, type DeviceAdmin } from "../packages/cli/src/device-services.js";
import { HostServices } from "../packages/cli/src/host-services.js";
import { localDeviceSetupPort } from "../packages/cli/src/local-device-setup-port.js";

// Owned synthetic directories, public lab certificates and ephemeral loopback listeners only.
// No real host, Keychain, native helper, account, grant or pairing request is used.
function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), "dx-mac-connection-")));
  return value;
}
function counts(path: string): Record<string, number> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(["offers", "claims", "device_certs", "device_bindings", "late_receipts"].map(name =>
      [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n)]));
  } finally { db.close(); }
}
const connectionPath = "/v1/local-mac-agent/connection";

test("listener public description is refused before start/after admission stop; reading creates no enrollment", async t => {
  const path = root(), store = new HostStore({ dataDir: join(path, "host") });
  const registry = new DevicePairingRegistry(store), identity = generateSyntheticIdentity(join(path, "identity"), "host");
  const server = new DeviceHostServer({ store, registry, identity, port: 0, pollWaitMs: 50 });
  t.after(async () => { await server.close(); registry.close(); store.close(); rmSync(path, { recursive: true, force: true }); });
  const before = counts(registry.databasePath);
  assert.throws(() => server.connectionDescription());
  const url = await server.start();
  for (let i = 0; i < 3; i++) assert.deepEqual(server.connectionDescription(), {
    schema: "dexter.local-mac-agent-connection/1", installationId: store.hostId,
    hostUrl: url, hostFingerprint: identity.fingerprint, hostCertPem: identity.certPem,
  });
  assert.deepEqual(counts(registry.databasePath), before);
  server.stopAdmission();
  assert.throws(() => server.connectionDescription());
  await server.close();
  assert.throws(() => server.connectionDescription());
  assert.deepEqual(counts(registry.databasePath), before);
});

test("actual HostServices owner GET publishes only current public trust with no offers/claims/devices/grants", async t => {
  const path = root(), identity = generateSyntheticIdentity(join(path, "identity"), "host");
  const services = new HostServices({ dataDir: join(path, "host"), devices: { identity, port: 0, pollWaitMs: 50 } });
  t.after(async () => { await services.shutdown(); rmSync(path, { recursive: true, force: true }); });
  const url = await services.startDevices(), setup = services.localDeviceSetupHttp!;
  const app = createHostApp(services.store, { localDeviceSetup: setup });
  const before = counts(join(path, "host", "devices.sqlite")), canonical = services.store.summary().counts;
  for (let i = 0; i < 3; i++) {
    const response = await app.request("http://127.0.0.1" + connectionPath);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text(), object = JSON.parse(text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(object).sort(), ["schema", "installationId", "hostUrl", "hostFingerprint", "hostCertPem"].sort());
    assert.equal(object.installationId, services.store.hostId); assert.equal(object.hostUrl, url);
    assert.equal(object.hostFingerprint, identity.fingerprint); assert.equal(object.hostCertPem, identity.certPem);
    for (const forbidden of ["PRIVATE KEY", "offerId", '"code"', "claimId", "capabilities", "grants", "ownerId"])
      assert.equal(text.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(counts(join(path, "host", "devices.sqlite")), before);
  assert.deepEqual(services.store.summary().counts, canonical);
  assert.equal((await app.request("http://127.0.0.1" + connectionPath + "?offer=true")).status, 400);
  assert.deepEqual(counts(join(path, "host", "devices.sqlite")), before);
});

test("owner loopback/origin and paired authority gates refuse before resolving connection metadata", async t => {
  const path = root(), store = new HostStore({ dataDir: join(path, "host") });
  t.after(() => { store.close(); rmSync(path, { recursive: true, force: true }); });
  let reads = 0;
  const app = createHostApp(store, { localDeviceSetup: {
    connection() { reads++; throw new Error("not reached"); },
    offer() { throw new Error("not reached"); }, claims() { throw new Error("not reached"); },
    approve() { throw new Error("not reached"); }, reject() { throw new Error("not reached"); },
  } });
  for (const headers of [{ host: "remote.example" }, { origin: "http://remote.example" }])
    assert.equal((await app.request("http://127.0.0.1" + connectionPath, { headers })).status, 403);
  assert.equal((await app.request("http://remote.example" + connectionPath)).status, 403);
  const authority: HostRequestAuthority = { principal: "paired-client", installationId: store.hostId,
    ownerId: store.ownerId, deviceId: "dev_synthetic", role: "client-mac",
    scopes: ["chat.read", "chat.write", "devices.read", "devices.manage", "grants.read", "grants.manage", "approvals.read", "approvals.decide"],
    pinGeneration: 1, bindingRevision: 1, assertCurrent() {}, noteSelfRevoke() {} };
  assert.equal((await app.request("http://127.0.0.1" + connectionPath, {}, { authority })).status, 403);
  const paired = createAuthorizedHostRouter(store);
  const response = await paired.request("https://synthetic.example" + connectionPath, {}, { authority });
  assert.equal(response.status, 403); assert.equal((await response.json() as { error: string }).error, "forbidden");
  assert.equal(reads, 0);
});

test("unconfigured/non-listening channels refuse; retained port cannot read after host shutdown", async t => {
  const path = root(), store = new HostStore({ dataDir: join(path, "unconfigured") });
  const app = createHostApp(store);
  assert.equal((await app.request("http://127.0.0.1" + connectionPath)).status, 503);
  const identity = generateSyntheticIdentity(join(path, "identity"), "host");
  const services = new HostServices({ dataDir: join(path, "host"), devices: { identity, port: 0, pollWaitMs: 50 } });
  t.after(async () => { await services.shutdown(); store.close(); rmSync(path, { recursive: true, force: true }); });
  const retained = services.localDeviceSetupHttp!, owner = createHostApp(services.store, { localDeviceSetup: retained });
  const before = counts(join(path, "host", "devices.sqlite"));
  assert.equal((await owner.request("http://127.0.0.1" + connectionPath)).status, 503);
  await services.startDevices(); assert.equal((await owner.request("http://127.0.0.1" + connectionPath)).status, 200);
  await services.shutdown();
  assert.throws(() => retained.connection(), HostError);
  const response = await owner.request("http://127.0.0.1" + connectionPath);
  assert.equal(response.status, 409);
  assert.deepEqual(counts(join(path, "host", "devices.sqlite")), before);
});

test("retained setup resolves live administration, refuses another installation and redacts private failures", t => {
  const path = root(), store = new HostStore({ dataDir: join(path, "host") });
  t.after(() => { store.close(); rmSync(path, { recursive: true, force: true }); });
  let calls = 0, foreign = false, stopped = false;
  const admin: DeviceAdmin = {
    connectionDescription: () => ({ schema: "dexter.local-mac-agent-connection/1", installationId: foreign ? "host_foreign" : store.hostId,
      hostUrl: "https://127.0.0.1:4999", hostFingerprint: "a".repeat(64), hostCertPem: "PUBLIC LAB CERT" }),
    pairingBundle() { throw new Error("no offer allowed"); }, pendingClaims() { throw new Error("no claim allowed"); },
    approveClaim() { throw new Error("no approve allowed"); }, rejectClaim() { throw new Error("no reject allowed"); },
    cancelOffer() { throw new Error("no cancellation allowed"); }, grant() { throw new Error("no grant allowed"); },
  };
  const port = localDeviceSetupPort(store, () => { calls++; if (stopped) throw new Error("PRIVATE UPSTREAM ERROR"); return admin; });
  assert.equal(calls, 0); assert.equal(port.connection().installationId, store.hostId); assert.equal(calls, 1);
  foreign = true;
  assert.throws(() => port.connection(), (error: unknown) => error instanceof HostError && error.code === "conflict");
  stopped = true;
  assert.throws(() => port.connection(), (error: unknown) => error instanceof HostError && error.code === "conflict"
    && !error.message.includes("PRIVATE UPSTREAM ERROR"));
  assert.equal(calls, 3);
});

test("lost canonical writer refuses listener and borrowed admin metadata with no enrollment effects", async t => {
  const path = root(), store = new HostStore({ dataDir: join(path, "host") });
  const identity = generateSyntheticIdentity(join(path, "identity"), "host"), services = new DeviceServices(store, { identity, port: 0, pollWaitMs: 50 });
  t.after(async () => { await services.close(); store.close(); rmSync(path, { recursive: true, force: true }); });
  await services.start(); const admin = services.admin;
  const registry = new DatabaseSync(join(path, "host", "devices.sqlite"), { readOnly: true });
  const before = Number((registry.prepare("SELECT COUNT(*) AS n FROM offers").get() as { n: number }).n);
  const db = new DatabaseSync(store.databasePath);
  const token = (db.prepare("SELECT token FROM host_lease WHERE id = 1").get() as { token: string }).token;
  try {
    db.exec("UPDATE host_lease SET token = 'synthetic-fenced' WHERE id = 1");
    assert.throws(() => admin.connectionDescription(), (error: unknown) => error instanceof HostError && error.code === "host_locked");
    assert.equal(Number((registry.prepare("SELECT COUNT(*) AS n FROM offers").get() as { n: number }).n), before);
  } finally { db.prepare("UPDATE host_lease SET token = ? WHERE id = 1").run(token); db.close(); registry.close(); }
});
