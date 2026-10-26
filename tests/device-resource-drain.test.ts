import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DaemonJournal, DeviceError, MacDeviceDaemon, generateSyntheticIdentity } from "@dexter/devices";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const codeIs = (code: string) => (error: unknown): boolean => error instanceof DeviceError && error.code === code;

function fixture(t: TestContext, resources: ReadonlyArray<{ close(): Promise<void> }>, stopTimeoutMs = 1000): MacDeviceDaemon {
  const lab = mkdtempSync(join(tmpdir(), "dexter-resource-drain-")); chmodSync(lab, 0o700);
  const host = generateSyntheticIdentity(join(lab, "host"), "fixture-host");
  const peer = generateSyntheticIdentity(join(lab, "peer"), "fixture-peer");
  const dataDir = join(lab, "daemon"); mkdirSync(dataDir, { mode: 0o700 });
  writeFileSync(join(dataDir, "binding.json"), JSON.stringify({
    installationId: "host_fixture", ownerId: "owner_fixture", deviceId: "dev_fixture", hostFingerprint: host.fingerprint,
  }), { mode: 0o600 });
  const daemon = new MacDeviceDaemon({ dataDir, identity: peer,
    trust: { hostUrl: "https://127.0.0.1:1", hostCertPem: host.certPem, hostFingerprint: host.fingerprint },
    handlers: new Map(), resources, stopTimeoutMs });
  // Only this fixture owns the inert journal; no polling or external effects have started.
  t.after(() => { daemon.journal.close(); rmSync(lab, { recursive: true, force: true }); });
  return daemon;
}
function assertLeaseHeld(daemon: MacDeviceDaemon): void {
  const dir = join(daemon.journal.databasePath, "..");
  assert.throws(() => {
    const unexpected = new DaemonJournal(dir, daemon.binding); unexpected.close();
  }, codeIs("conflict"));
}
function assertLeaseReleased(daemon: MacDeviceDaemon): void {
  const journal = new DaemonJournal(join(daemon.journal.databasePath, ".."), daemon.binding); journal.close();
}

test("daemon concurrent stops share resource closure and keep the journal lease until it settles", async t => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const daemon = fixture(t, [{ close: async () => { calls++; entered.resolve(); await release.promise; } }]);
  const first = daemon.stop(), second = daemon.stop();
  await entered.promise;
  assertLeaseHeld(daemon);
  await assert.rejects(daemon.runOnce(), codeIs("unavailable"));
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assertLeaseReleased(daemon);
});

test("daemon stop deadline retains the journal and retry joins the same pending resource closure", async t => {
  const release = deferred(); let calls = 0;
  const daemon = fixture(t, [{ close: async () => { calls++; await release.promise; } }], 20);
  await assert.rejects(daemon.stop(), codeIs("timeout"));
  assertLeaseHeld(daemon);
  release.resolve();
  await daemon.stop();
  assert.equal(calls, 1);
  assertLeaseReleased(daemon);
});

test("rejected resource cleanup stays quarantined, tries every resource once and never releases the journal", async t => {
  let failedCalls = 0, otherCalls = 0;
  const daemon = fixture(t, [
    { close: () => { failedCalls++; throw Error("fixture cleanup unconfirmed"); } },
    { close: async () => { otherCalls++; } },
  ]);
  await assert.rejects(daemon.stop(), codeIs("unavailable"));
  assertLeaseHeld(daemon);
  await assert.rejects(daemon.runOnce(), codeIs("unavailable"));
  await assert.rejects(daemon.stop(), codeIs("unavailable"));
  assertLeaseHeld(daemon);
  assert.equal(failedCalls, 1); assert.equal(otherCalls, 1);
});

