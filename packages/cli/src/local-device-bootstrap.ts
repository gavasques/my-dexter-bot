import { HostError, type ExistingHostIdentity, type HostStore } from "@dexter/hub";
import { type PairingBundle } from "@dexter/devices";
import { type DeviceAdmin, type DeviceServicesOptions, validateDeviceServicesOptions } from "./device-services.js";
import { OperatorSealedCustody } from "./operator-sealed-custody.js";

/**
 * Explicit owner-local channel bootstrap from the EXISTING encrypted operator custody. No key is
 * generated/exported, no private material is written and an unavailable/locked/mismatched custody refuses.
 * Invoke before opening HostServices, using its captured canonical installation identity. The caller
 * retains custody ownership until successful host startup and must drain the host before locking it.
 * Agent Keychain identity, claim approval and bot grants remain separate explicit actions.
 */
export function prepareLocalDeviceChannel(custody: OperatorSealedCustody, expected: ExistingHostIdentity,
  port = 4318): Readonly<DeviceServicesOptions> {
  try {
    const description = custody.toJSON();
    if (!description.unlocked || !description.identity || description.binding.installationId !== expected.installationId
      || description.binding.ownerId !== expected.ownerId) throw new Error();
    return validateDeviceServicesOptions({ identity: custody.tlsIdentity(), listenHost: "127.0.0.1", port });
  } catch { throw new HostError("conflict", "Unlock the matching encrypted host custody before preparing the local device channel."); }
}

/** Sensitive, memory-only response of a trusted local owner action, never a tool result or diagnostic. */
export interface LocalMacAgentSetupBundle {
  schema: "dexter.local-mac-agent-setup/1";
  installationId: string;
  offer: PairingBundle;
}
/** Call after startDevices; the existing host remains the sole source of identity and pairing claims. */
export function createLocalMacAgentSetupBundle(store: HostStore, admin: Readonly<DeviceAdmin>): LocalMacAgentSetupBundle {
  // The registry owns its writer-fenced transaction; do not nest another SQLite transaction around it.
  store.summary();
  return { schema: "dexter.local-mac-agent-setup/1", installationId: store.hostId,
    offer: admin.pairingBundle({ kind: "pair" }) };
}
