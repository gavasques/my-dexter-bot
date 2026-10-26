import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostError, HostStore } from "@dexter/hub";
import { type DeviceAdmin } from "../packages/cli/src/device-services.js";
import { localDeviceSetupPort } from "../packages/cli/src/local-device-setup-port.js";

test("owner setup port adapts public fields, validates closed bodies, resolves admission each operation", t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "dexter-local-device-port-"));
  const store = new HostStore({ dataDir: join(root, "host") });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  let calls = 0, approval = "", rejection = "", grants = 0, stopped = false;
  const claim = { claimId: "pcl_synthetic", kind: "pair" as const, deviceId: null,
    clientFingerprint: "f".repeat(64), name: "Synthetic Mac", capabilities: ["mac.browser.read"], expiresAt: Date.now() + 60000 };
  const offer = { hostUrl: "https://127.0.0.1:4318", hostFingerprint: "a".repeat(64),
    hostCertPem: "PUBLIC SYNTHETIC CERT", offerId: "offer", code: "b".repeat(43), expiresAt: Date.now() + 60000 };
  const admin: DeviceAdmin = {
    connectionDescription: () => ({ schema: "dexter.local-mac-agent-connection/1", installationId: store.hostId,
      hostUrl: offer.hostUrl, hostFingerprint: offer.hostFingerprint, hostCertPem: offer.hostCertPem }),
    pairingBundle: () => ({ ...offer }), pendingClaims: () => [claim],
    approveClaim: claimId => { approval = claimId; return { deviceId: "synthetic-device", fingerprint: claim.clientFingerprint }; },
    rejectClaim: claimId => { rejection = claimId; }, cancelOffer: () => {},
    grant: () => { grants++; throw new Error("must not grant"); },
  };
  const port = localDeviceSetupPort(store, () => { calls++; if (stopped) throw new HostError("conflict", "PRIVATE ERROR MATERIAL"); return admin; });
  assert.equal(calls, 0);
  const result = port.offer({});
  assert.equal(result.installationId, store.hostId);
  assert.deepEqual(result.offer, offer);
  assert.equal(approval, ""); assert.equal(grants, 0);
  const claims = port.claims();
  assert.deepEqual(claims, { claims: [claim] });
  claims.claims[0]!.capabilities.push("tampered");
  assert.deepEqual(claim.capabilities, ["mac.browser.read"]);
  assert.deepEqual(port.approve("pcl_synthetic", {}), { deviceId: "synthetic-device", fingerprint: claim.clientFingerprint });
  assert.deepEqual(port.reject("pcl_synthetic", {}), { rejected: true });
  assert.equal(approval, "pcl_synthetic"); assert.equal(rejection, "pcl_synthetic"); assert.equal(grants, 0);
  assert.equal(calls, 4);
  let hooks = 0;
  const bad = [null, [], { extra: true }, Object.create(null), { get extra() { hooks++; return true; } },
    new Proxy({}, { ownKeys() { hooks++; return []; } }), { [Symbol("hidden")]: true }];
  for (const input of bad) assert.throws(() => port.offer(input), (e: unknown) => e instanceof HostError && e.code === "invalid_input");
  for (const claimId of ["", "../private", "a".repeat(129), "line\nbreak"]) assert.throws(() => port.approve(claimId, {}));
  assert.equal(hooks, 0); assert.equal(calls, 4);
  stopped = true;
  for (const operation of [() => port.offer({}), () => port.claims(), () => port.approve("pcl_synthetic", {}), () => port.reject("pcl_synthetic", {})]) {
    assert.throws(operation, (e: unknown) => e instanceof HostError && e.code === "conflict" && !e.message.includes("PRIVATE ERROR MATERIAL"));
  }
  assert.equal(calls, 8); assert.equal(grants, 0);
});
