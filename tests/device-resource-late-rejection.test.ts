import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DaemonJournal, DeviceError, MacDeviceDaemon, generateSyntheticIdentity } from "@dexter/devices";

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const codeIs = (code: string) => (error: unknown): boolean => error instanceof DeviceError && error.code === code;

test("late resource rejection stays quarantined after a stop deadline and the remaining cleanup", async t => {
  const lab = mkdtempSync(join(tmpdir(), "dexter-late-resource-")); chmodSync(lab, 0o700);
  const host = generateSyntheticIdentity(join(lab, "host"), "fixture-host");
  const peer = generateSyntheticIdentity(join(lab, "peer"), "fixture-peer");
  const dataDir = join(lab, "daemon"); mkdirSync(dataDir, { mode: 0o700 });
  writeFileSync(join(dataDir, "binding.json"), JSON.stringify({
    installationId: "host_fixture", ownerId: "owner_fixture", deviceId: "dev_fixture", hostFingerprint: host.fingerprint,
  }), { mode: 0o600 });
  const failed = deferred(), remaining = deferred(); let failedCalls = 0, remainingCalls = 0;
  const daemon = new MacDeviceDaemon({ dataDir, identity: peer,
    trust: { hostUrl: "https://127.0.0.1:1", hostCertPem: host.certPem, hostFingerprint: host.fingerprint },
    handlers: new Map(), stopTimeoutMs: 20, resources: [
      { close: () => { failedCalls++; return failed.promise; } },
      { close: () => { remainingCalls++; return remaining.promise; } },
    ] });
  // The journal is inert and belongs only to this test; no polling or network was started.
  t.after(() => { remaining.resolve(); daemon.journal.close(); rmSync(lab, { recursive: true, force: true }); });
  const leaseHeld = (): void => assert.throws(() => {
    const unexpected = new DaemonJournal(dataDir, daemon.binding); unexpected.close();
  }, codeIs("conflict"));

  await assert.rejects(daemon.stop(), codeIs("timeout"));
  leaseHeld();
  failed.reject(Error("fixture late cleanup rejection"));
  // The other cleanup is still pending; a retry joins it and cannot release the journal.
  await assert.rejects(daemon.stop(), codeIs("timeout"));
  leaseHeld();
  remaining.resolve();
  await assert.rejects(daemon.stop(), codeIs("unavailable"));
  leaseHeld();
  await assert.rejects(daemon.runOnce(), codeIs("unavailable"));
  await assert.rejects(daemon.stop(), codeIs("unavailable"));
  leaseHeld();
  assert.equal(failedCalls, 1); assert.equal(remainingCalls, 1);
});
