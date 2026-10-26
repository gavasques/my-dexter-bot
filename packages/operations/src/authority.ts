import type { InspectionReceipt } from "./restore.js";

/**
 * An inspection copy is never transferable. Local authority transfer exists only through a transfer checkpoint
 * (`LocalAuthorityController`: Hub schema 4 epoch, persisted source revocation enforced by HostStore, owner-signed
 * single-use activation receipt bound to the checkpoint artifact, checkpoint and destination). None of that can be
 * synthesized from an inspection receipt, a copied lease row, a matching hostId or hostname, or possession of the
 * snapshot key, so this API always answers `unavailable` and has no side effects: it neither activates the
 * inspection copy nor revokes or deletes anything at the source.
 */
export interface AuthorityTransferUnavailable {
  readonly status: "unavailable";
  readonly reason: "authority_transfer_not_implemented";
  readonly missing: readonly ["authority_epoch_checkpoint", "persisted_source_revocation", "owner_activation_receipt"];
  readonly inspection: { readonly destination: string; readonly state: "quarantined_inspection" };
}

export function requestAuthorityTransfer(receipt: Pick<InspectionReceipt, "destination">): AuthorityTransferUnavailable {
  return Object.freeze({
    status: "unavailable",
    reason: "authority_transfer_not_implemented",
    missing: ["authority_epoch_checkpoint", "persisted_source_revocation", "owner_activation_receipt"] as const,
    inspection: Object.freeze({ destination: receipt.destination, state: "quarantined_inspection" as const }),
  });
}
