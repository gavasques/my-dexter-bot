import { z } from "zod";
import { OwnerPairingOfferIdSchema, OwnerPairingRequestIdSchema, OwnerPairingRoleSchema, OwnerPairingScopesSchema } from "./owner-pairing-offer.js";

/**
 * Owner review of app-client pairing claims (private owner-loopback contract, version 1): after another iPhone/Mac used an
 * invitation, the human owner of THIS base lists, inspects, approves or rejects its claim from the app (no CLI).
 *
 * - Human owner loopback only (`createHostApp`); refused (403) on the paired-client router before any work; never an
 *   engine/harness tool, MCP or `exportContracts()`.
 * - A decision names the base, the claims revision and journal pin it saw, one client request UUID, and the EXACT claim it was shown: the
 *   claim pin (offer, kind, role, scopes, target device, certificate pin, name, expiry) and the client certificate pin.
 *   Role and scopes always come from the owner's offer; approval never adds a scope (outputs.* included) and creates no
 *   grant for any bot. The body never carries owner, grant, capability or authority fields.
 * - The journal reserves the revision and the request BEFORE the registry effect; the receipt is derived from the registry's
 *   claim state re-read after the effect. Exact replay returns the original receipt; the same id with another body
 *   conflicts; a lost ACK is read back with GET (never re-posted automatically). Nothing re-issues certificates, creates
 *   identities or rotates keys on recovery.
 */
export const OWNER_PAIRING_CLAIMS_CONTRACT_VERSION = 1 as const;
export const OWNER_PAIRING_CLAIMS_LIMITS = Object.freeze({ listedClaims: 50 });
const HostId = z.string().min(1).max(128);
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const DeviceId = z.string().min(1).max(128);
export const OwnerPairingClaimIdSchema = z.string().regex(/^ccl_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const OwnerPairingClaimStatusSchema = z.enum(["pending", "approving", "approved", "rejected", "failed", "expired"]);
/** Live binding of the approved device (or of a rotation target): public pins and counters only. */
export const OwnerPairingClaimBindingSchema = z.strictObject({
  deviceId: DeviceId, role: OwnerPairingRoleSchema, scopes: OwnerPairingScopesSchema, fingerprint: Hash,
  generation: z.number().int().min(1), revision: z.number().int().min(1), status: z.enum(["active", "revoked"]),
});
export const OwnerPairingClaimSchema = z.strictObject({
  claimId: OwnerPairingClaimIdSchema,
  offerId: OwnerPairingOfferIdSchema,
  kind: z.enum(["pair", "rotate"]),
  role: OwnerPairingRoleSchema,
  scopes: OwnerPairingScopesSchema,
  /** Device a `rotate` claim re-keys; null for `pair`. */
  targetDeviceId: DeviceId.nullable(),
  /** Set once approved. */
  approvedDeviceId: DeviceId.nullable(),
  /** SHA-256 pin of the certificate the other device proved over mutual TLS; compare it with the device before approving. */
  clientFingerprint: Hash,
  /** Untrusted label typed on the other device. */
  name: z.string().min(1).max(120),
  status: OwnerPairingClaimStatusSchema,
  createdAt: Timestamp, expiresAt: Timestamp, decidedAt: Timestamp.nullable(),
  /** SHA-256 of the immutable claim facts shown to the owner; a decision must name it. */
  claimPin: Hash,
  /** The owner-flow invitation this claim consumed (null when the offer came from the CLI). */
  offerClientRequestId: OwnerPairingRequestIdSchema.nullable(),
  binding: OwnerPairingClaimBindingSchema.nullable(),
});
export type OwnerPairingClaim = z.infer<typeof OwnerPairingClaimSchema>;
export const OwnerPairingClaimsListSchema = z.strictObject({
  version: z.literal(OWNER_PAIRING_CLAIMS_CONTRACT_VERSION),
  hostId: HostId,
  /** Claims journal revision every decision must name (1 before the first decision). */
  revision: Revision,
  /** Journal continuity pin (authority epoch + journal instance) every decision must name; null while unavailable. */
  journalPin: Hash.nullable(),
  availability: z.enum(["available", "unavailable"]),
  reason: z.enum(["app_client_channel_unconfigured", "host_closing"]).nullable(),
  /** Pending, unexpired claims, oldest first. */
  items: z.array(OwnerPairingClaimSchema).max(OWNER_PAIRING_CLAIMS_LIMITS.listedClaims),
  truncated: z.boolean(),
});
export type OwnerPairingClaimsList = z.infer<typeof OwnerPairingClaimsListSchema>;

/** POST /v1/owner/app-client-pairing/claims/:claimId/decision. Exactly these keys. */
export const DecideOwnerPairingClaimSchema = z.strictObject({
  expectedHostId: HostId,
  expectedRevision: Revision,
  expectedJournalPin: Hash,
  clientRequestId: OwnerPairingRequestIdSchema,
  decision: z.enum(["approve", "reject"]),
  expectedClaimPin: Hash,
  expectedClientFingerprint: Hash,
});
export type DecideOwnerPairingClaim = z.infer<typeof DecideOwnerPairingClaimSchema>;

/**
 * Durable decision receipt. `not_applied`: the registry still shows the claim pending/expired after the attempt (nothing
 * changed); `unknown`: reserved but not confirmed (read the live claim). `binding` only for `approved`.
 */
export const OwnerPairingDecisionReceiptSchema = z.strictObject({
  version: z.literal(OWNER_PAIRING_CLAIMS_CONTRACT_VERSION),
  hostId: HostId,
  clientRequestId: OwnerPairingRequestIdSchema,
  requestHash: Hash,
  operation: z.enum(["approve", "reject"]),
  previousRevision: Revision,
  revision: Revision,
  outcome: z.enum(["approved", "rejected", "not_applied", "failed", "unknown"]),
  claim: z.strictObject({ claimId: OwnerPairingClaimIdSchema, offerId: OwnerPairingOfferIdSchema, kind: z.enum(["pair", "rotate"]),
    role: OwnerPairingRoleSchema, scopes: OwnerPairingScopesSchema, targetDeviceId: DeviceId.nullable(), clientFingerprint: Hash,
    name: z.string().min(1).max(120), claimPin: Hash }),
  binding: z.strictObject({ deviceId: DeviceId, role: OwnerPairingRoleSchema, scopes: OwnerPairingScopesSchema, fingerprint: Hash,
    generation: z.number().int().min(1), revision: z.number().int().min(1) }).nullable(),
  grantsCreated: z.literal(0),
  createdAt: Timestamp,
});
export type OwnerPairingDecisionReceipt = z.infer<typeof OwnerPairingDecisionReceiptSchema>;
/** Receipt plus the live claim (null if the registry no longer knows it). */
export const OwnerPairingDecisionRecordSchema = z.strictObject({ receipt: OwnerPairingDecisionReceiptSchema, claim: OwnerPairingClaimSchema.nullable() });
export type OwnerPairingDecisionRecord = z.infer<typeof OwnerPairingDecisionRecordSchema>;
