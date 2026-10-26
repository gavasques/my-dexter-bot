import { createHash } from "node:crypto";
import {
  DecideOwnerPairingClaimSchema, OwnerPairingClaimIdSchema, OwnerPairingDecisionReceiptSchema, OwnerPairingRequestIdSchema,
  OWNER_PAIRING_CLAIMS_CONTRACT_VERSION, OWNER_PAIRING_CLAIMS_LIMITS,
  type OwnerPairingClaim, type OwnerPairingClaimsList, type OwnerPairingDecisionReceipt, type OwnerPairingDecisionRecord,
} from "@dexter/contracts";
import { HostError } from "@dexter/hub";
import type { OwnerPairingJournal, OwnerPairingJournalRow } from "./owner-pairing-journal.js";

/**
 * Owner review of app-client claims (contracts/owner-pairing-claims.ts): list, inspect, approve or reject the claim another
 * device made with an invitation of THIS base, through the SAME app-client registry (`AppClientServices.admin`). Role and
 * scopes come from the offer and are never changed here; nothing creates grants, certificates, identities or rotations.
 *
 * A decision names the exact claim it was shown (claim pin + certificate pin) and the claims revision. It is reserved in the
 * dedicated owner pairing journal (with a provisional `unknown` receipt) BEFORE the registry effect; the final receipt is
 * derived from the registry's claim state re-read after the effect.
 */
type ClaimStatus = "pending" | "approving" | "approved" | "rejected" | "failed" | "expired";
/** Structurally the registry's `ClientClaimRecord`. */
export interface OwnerClaimRecordSource {
  claimId: string; offerId: string; kind: "pair" | "rotate"; role: "client-ios" | "client-mac"; scopes: readonly string[];
  targetDeviceId: string | null; approvedDeviceId: string | null; clientFingerprint: string; name: string; status: ClaimStatus;
  expiresAt: number; createdAt: number; decidedAt: number | null;
}
/** Structurally the public part of `ClientBinding`. */
export interface OwnerClaimBindingSource {
  deviceId: string; role: "client-ios" | "client-mac"; scopes: readonly string[]; fingerprint: string; generation: number; revision: number;
  status: "active" | "revoked";
}
/** Structurally the AppClientServices admin facade (claims part). */
export interface OwnerPairingClaimsAdminPort {
  pendingClaimRecords(limit?: number): OwnerClaimRecordSource[];
  claimRecord(claimId: string): OwnerClaimRecordSource | null;
  approveClaim(claimId: string): { deviceId: string; fingerprint: string };
  rejectClaim(claimId: string): void;
}
export interface OwnerPairingClaimsOptions {
  journal: OwnerPairingJournal;
  identity: () => { hostId: string; ownerId: string };
  /** Null: this host has no app-client channel. Throws once the host stopped admission. */
  admin: () => Readonly<OwnerPairingClaimsAdminPort> | null;
  binding: (deviceId: string) => OwnerClaimBindingSource | null;
  closing: () => boolean;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
/** Pin of the immutable facts the owner is shown (never the approved device, status or decision time). */
export function ownerClaimPin(record: OwnerClaimRecordSource): string {
  return sha256(canonical({ claimId: record.claimId, offerId: record.offerId, kind: record.kind, role: record.role, scopes: [...record.scopes],
    targetDeviceId: record.targetDeviceId, clientFingerprint: record.clientFingerprint, name: record.name, expiresAt: record.expiresAt }));
}
const sameScopes = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((scope, i) => scope === b[i]);
const unavailable = (): never => { throw new HostError("device_unavailable", "Pairing claims are unavailable on this host."); };

export class OwnerPairingClaims {
  readonly #options: OwnerPairingClaimsOptions;
  constructor(options: OwnerPairingClaimsOptions) { this.#options = options; }

  #admin(): { admin: Readonly<OwnerPairingClaimsAdminPort> | null; reason: "app_client_channel_unconfigured" | "host_closing" | null } {
    if (this.#options.closing() || this.#options.journal.closed) return { admin: null, reason: "host_closing" };
    let admin: Readonly<OwnerPairingClaimsAdminPort> | null;
    try { admin = this.#options.admin(); } catch { return { admin: null, reason: "host_closing" }; }
    return admin ? { admin, reason: null } : { admin: null, reason: "app_client_channel_unconfigured" };
  }
  #binding(deviceId: string | null): OwnerPairingClaim["binding"] {
    if (deviceId === null) return null;
    let b: OwnerClaimBindingSource | null;
    try { b = this.#options.binding(deviceId); } catch { return null; }
    return b ? { deviceId: b.deviceId, role: b.role, scopes: [...b.scopes] as OwnerPairingClaim["scopes"], fingerprint: b.fingerprint, generation: b.generation,
      revision: b.revision, status: b.status } : null;
  }
  #view(record: OwnerClaimRecordSource): OwnerPairingClaim {
    const offer = this.#options.journal.one("SELECT client_request_id FROM requests WHERE operation = 'create' AND state = 'done' AND offer_id = ?", record.offerId);
    return { claimId: record.claimId, offerId: record.offerId, kind: record.kind, role: record.role, scopes: [...record.scopes] as OwnerPairingClaim["scopes"],
      targetDeviceId: record.targetDeviceId, approvedDeviceId: record.approvedDeviceId, clientFingerprint: record.clientFingerprint, name: record.name,
      status: record.status, createdAt: record.createdAt, expiresAt: record.expiresAt, decidedAt: record.decidedAt, claimPin: ownerClaimPin(record),
      offerClientRequestId: offer ? String(offer.client_request_id) : null, binding: this.#binding(record.approvedDeviceId ?? record.targetDeviceId) };
  }

  /** Pending, unexpired claims of this base (bounded), with the claims revision every decision must name. */
  list(): OwnerPairingClaimsList {
    const { hostId } = this.#options.identity(), { admin, reason } = this.#admin();
    const revision = this.#options.journal.closed ? 1 : this.#options.journal.revision("claims");
    if (!admin) return { version: OWNER_PAIRING_CLAIMS_CONTRACT_VERSION, hostId, revision, journalPin: null, availability: "unavailable", reason, items: [], truncated: false };
    const journalPin = this.#options.journal.pin(), records = admin.pendingClaimRecords(OWNER_PAIRING_CLAIMS_LIMITS.listedClaims + 1);
    return { version: OWNER_PAIRING_CLAIMS_CONTRACT_VERSION, hostId, revision: this.#options.journal.revision("claims"), journalPin, availability: "available", reason: null,
      items: records.slice(0, OWNER_PAIRING_CLAIMS_LIMITS.listedClaims).map(record => this.#view(record)),
      truncated: records.length > OWNER_PAIRING_CLAIMS_LIMITS.listedClaims };
  }
  /** One claim in any state (inspection before and after a decision). */
  claim(claimIdRaw: string): OwnerPairingClaim {
    const claimId = OwnerPairingClaimIdSchema.parse(claimIdRaw), { admin } = this.#admin();
    if (!admin) return unavailable();
    const record = admin.claimRecord(claimId);
    if (!record) throw new HostError("not_found", "Pairing claim not found.");
    return this.#view(record);
  }
  /** Receipt (stored or provisional `unknown`) plus the live claim; null when this journal has no decision for the id. */
  decision(clientRequestIdRaw: string): OwnerPairingDecisionRecord | null {
    if (this.#options.journal.closed) unavailable();
    const row = this.#options.journal.row(OwnerPairingRequestIdSchema.parse(clientRequestIdRaw));
    if (!row || (row.operation !== "approve" && row.operation !== "reject")) return null;
    return this.#record(row);
  }
  #record(row: OwnerPairingJournalRow): OwnerPairingDecisionRecord {
    let parsed: unknown;
    try { parsed = JSON.parse(String(row.receipt)); } catch { throw new HostError("conflict", "Pairing offer journal is inconsistent."); }
    const result = OwnerPairingDecisionReceiptSchema.safeParse(parsed);
    if (!result.success || result.data.clientRequestId !== row.client_request_id || result.data.requestHash !== row.request_hash
      || result.data.operation !== row.operation || result.data.hostId !== this.#options.identity().hostId
      || (row.state === "reserved" && result.data.outcome !== "unknown")) throw new HostError("conflict", "Pairing offer journal is inconsistent.");
    const receipt = result.data, { admin } = this.#admin();
    let live: OwnerClaimRecordSource | null = null;
    if (admin) { try { live = admin.claimRecord(receipt.claim.claimId); } catch { live = null; } }
    return { receipt, claim: live ? this.#view(live) : null };
  }

  /** One owner decision on the exact claim shown. Exact replay returns the original receipt; anything else is refused first. */
  decide(claimIdRaw: string, raw: unknown): { created: boolean; result: OwnerPairingDecisionRecord } {
    if (this.#options.closing() || this.#options.journal.closed) unavailable();
    const claimId = OwnerPairingClaimIdSchema.parse(claimIdRaw), input = DecideOwnerPairingClaimSchema.parse(raw);
    const { hostId } = this.#options.identity();
    if (input.expectedHostId !== hostId) throw new HostError("conflict", "Host identity changed.");
    const requestHash = sha256(canonical({ claimId, clientRequestId: input.clientRequestId, decision: input.decision, expectedClaimPin: input.expectedClaimPin,
      expectedClientFingerprint: input.expectedClientFingerprint, expectedHostId: input.expectedHostId, expectedJournalPin: input.expectedJournalPin,
      expectedRevision: input.expectedRevision }));
    const prior = this.#options.journal.row(input.clientRequestId);
    if (prior) {
      if (prior.operation !== input.decision || prior.request_hash !== requestHash) throw new HostError("conflict", "Client request id was already used for another request.");
      return { created: false, result: this.#record(prior) };
    }
    const { admin } = this.#admin();
    if (!admin) return unavailable();
    // No receipt here: a decision formed under another journal continuity (restore, lost journal) is refused, never new.
    this.#options.journal.assertPin(input.expectedJournalPin);
    if (this.#options.journal.revision("claims") !== input.expectedRevision) throw new HostError("conflict", "Pairing claims revision changed.");
    const record = admin.claimRecord(claimId);
    if (!record) throw new HostError("not_found", "Pairing claim not found.");
    if (record.status !== "pending") throw new HostError("conflict", "Pairing claim is no longer pending.");
    const claimPin = ownerClaimPin(record);
    if (claimPin !== input.expectedClaimPin || record.clientFingerprint !== input.expectedClientFingerprint) throw new HostError("conflict", "Pairing claim changed.");
    if (input.decision === "approve" && record.kind === "rotate") {
      const target = this.#binding(record.targetDeviceId);
      if (!target || target.status !== "active" || target.role !== record.role || !sameScopes(target.scopes, record.scopes)) throw new HostError("conflict", "The rotated device is no longer active.");
    }
    const claim = { claimId, offerId: record.offerId, kind: record.kind, role: record.role, scopes: [...record.scopes] as OwnerPairingClaim["scopes"],
      targetDeviceId: record.targetDeviceId, clientFingerprint: record.clientFingerprint, name: record.name, claimPin };
    const base = (createdAt: number) => ({ version: OWNER_PAIRING_CLAIMS_CONTRACT_VERSION, hostId, clientRequestId: input.clientRequestId, requestHash,
      operation: input.decision, previousRevision: input.expectedRevision, revision: input.expectedRevision + 1, claim, grantsCreated: 0 as const, createdAt });
    const createdAt = this.#options.journal.reserve({ clientRequestId: input.clientRequestId, operation: input.decision, requestHash,
      expectedRevision: input.expectedRevision, offerId: record.offerId, claimId,
      provisional: at => JSON.stringify({ ...base(at), outcome: "unknown", binding: null } satisfies OwnerPairingDecisionReceipt) });
    try { if (input.decision === "approve") admin.approveClaim(claimId); else admin.rejectClaim(claimId); }
    catch { /* the registry state re-read below decides; nothing is retried */ }
    let after: OwnerClaimRecordSource | null;
    try { after = admin.claimRecord(claimId); } catch { after = null; }
    let outcome: OwnerPairingDecisionReceipt["outcome"] = "unknown", binding: OwnerPairingDecisionReceipt["binding"] = null;
    if (after && (after.status === "pending" || after.status === "expired")) outcome = "not_applied";
    else if (input.decision === "approve" && after?.status === "failed") outcome = "failed";
    else if (input.decision === "reject" && after?.status === "rejected") outcome = "rejected";
    else if (input.decision === "approve" && after?.status === "approved" && after.approvedDeviceId) {
      const b = this.#binding(after.approvedDeviceId);
      // Approved only with exactly the offer's role/scopes and the certificate the owner was shown.
      if (b && b.status === "active" && b.fingerprint === record.clientFingerprint && b.role === record.role && sameScopes(b.scopes, record.scopes)) {
        outcome = "approved";
        binding = { deviceId: b.deviceId, role: b.role, scopes: b.scopes, fingerprint: b.fingerprint, generation: b.generation, revision: b.revision };
      }
    }
    const receipt: OwnerPairingDecisionReceipt = { ...base(createdAt), outcome, binding };
    try { this.#options.journal.finalize(input.clientRequestId, JSON.stringify(receipt), null); }
    catch { throw new HostError("outcome_unknown", "Pairing claim decision is unconfirmed."); }
    return { created: true, result: { receipt, claim: after ? this.#view(after) : null } };
  }
}
