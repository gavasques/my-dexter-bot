import { types } from "node:util";
import { HostError, type HostStore } from "@dexter/hub";
import { type PendingClaim } from "@dexter/devices";
import { type DeviceAdmin } from "./device-services.js";
import { createLocalMacAgentSetupBundle, type LocalMacAgentSetupBundle } from "./local-device-bootstrap.js";

export interface LocalDeviceSetupPort {
  connection(): ReturnType<DeviceAdmin["connectionDescription"]>;
  offer(input: unknown): LocalMacAgentSetupBundle;
  claims(): { claims: PendingClaim[] };
  approve(claimId: string, input: unknown): { deviceId: string; fingerprint: string };
  reject(claimId: string, input: unknown): { rejected: true };
}
function empty(input: unknown): void {
  if (!input || typeof input !== "object" || types.isProxy(input) || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== 0)
    throw new HostError("invalid_input", "An empty setup request is required.");
}
function id(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value))
    throw new HostError("invalid_input", "A valid claim identifier is required.");
}
function guarded<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    throw new HostError(error instanceof HostError ? error.code : "conflict", "Local Mac setup operation could not be completed.");
  }
}
/**
 * Owner-loopback router ONLY, never paired-client API, engine or MCP tool. The root router must apply its
 * existing host/origin/peer checks. Each operation resolves current administration through HostServices
 * admission, so a retained port refuses after shutdown. No approval/grant is automatic. The setup response
 * carries a one-time pairing code and public certificate: do not log/persist it or include it in diagnostics.
 *
 * GET /v1/local-mac-agent/connection reads public trust only, without creating an offer or touching grants.
 * Enrollment routes: POST /v1/local-mac-agent/setup {}; GET /v1/local-mac-agent/claims;
 * POST /v1/local-mac-agent/claims/:id/approve|reject {}. The owner reviews the displayed client pin first.
 */
export function localDeviceSetupPort(store: HostStore, admin: () => Readonly<DeviceAdmin>): Readonly<LocalDeviceSetupPort> {
  return Object.freeze({
    connection: () => guarded(() => {
      store.summary();
      const value = admin().connectionDescription();
      if (value.installationId !== store.hostId) throw new HostError("conflict", "Local device belongs to another installation.");
      return { schema: value.schema, installationId: value.installationId, hostUrl: value.hostUrl,
        hostFingerprint: value.hostFingerprint, hostCertPem: value.hostCertPem };
    }),
    offer: (input: unknown) => guarded(() => { empty(input); return createLocalMacAgentSetupBundle(store, admin()); }),
    claims: () => guarded(() => ({ claims: admin().pendingClaims().map(claim => ({
      claimId: claim.claimId, kind: claim.kind, deviceId: claim.deviceId, clientFingerprint: claim.clientFingerprint,
      name: claim.name, capabilities: [...claim.capabilities], expiresAt: claim.expiresAt,
    })) })),
    approve: (claimId: string, input: unknown) => guarded(() => {
      empty(input); id(claimId);
      const approved = admin().approveClaim(claimId);
      return { deviceId: approved.deviceId, fingerprint: approved.fingerprint };
    }),
    reject: (claimId: string, input: unknown): { rejected: true } => guarded(() => {
      empty(input); id(claimId); admin().rejectClaim(claimId); return { rejected: true };
    }),
  });
}
