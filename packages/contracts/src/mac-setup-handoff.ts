import { z } from "zod";

export const MAC_SETUP_HANDOFF_TTL_MS = 5 * 60_000;
export const MAC_SETUP_CUA_OPERATIONS = ["mac.cua.status", "mac.cua.observe", "mac.cua.control"] as const;
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Model arguments contain only the passive own-configuration CAS. Identity comes from the capability. */
export const MacSetupHandoffInputSchema = z.strictObject({ expected_revision: digest });
export const MacSetupStatusInputSchema = z.strictObject({});
/** Closed passive projection; route publication and grants never prove a native helper or consent is ready. */
export const MacSetupStatusSchema = z.strictObject({
  kind: z.literal("mac_setup_status"), hostId: identity, botId: identity, threadId: identity,
  configurationRevision: digest, routeConfiguration: z.enum(["known", "unknown"]),
  operations: z.array(z.strictObject({
    operation: z.enum(MAC_SETUP_CUA_OPERATIONS), published: z.boolean(), turnAdmitted: z.boolean(),
    grantValidity: z.enum(["valid", "missing", "denied", "expired", "revision_required", "not_published", "unknown"]),
  })).length(MAC_SETUP_CUA_OPERATIONS.length).refine(operations=>new Set(operations.map(operation=>operation.operation)).size===MAC_SETUP_CUA_OPERATIONS.length,
    "Each CUA operation must occur exactly once."),
  nativeTCC: z.literal("unknown"), helper: z.literal("unknown"), localPolicy: z.literal("unknown"),
  session: z.literal("unknown"), readiness: z.literal("unknown"), newToolsApplyNextTurn: z.literal(true),
});
export type MacSetupStatus = z.infer<typeof MacSetupStatusSchema>;

/** Exact owner approval requests local interface navigation only. No private setup material is carried. */
export const MacSetupHandoffSchema = z.strictObject({
  kind: z.literal("mac_setup_handoff"), target: z.literal("computer_access"),
  hostId: identity, botId: identity, threadId: identity, actionId: identity, requestHash: digest,
  configurationRevision: digest, expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type MacSetupHandoff = z.infer<typeof MacSetupHandoffSchema>;

/** Old receipts remain readable history, but cannot authorize a new local interface navigation. */
export function currentMacSetupHandoff(value: unknown, now: number): MacSetupHandoff | null {
  const receipt = MacSetupHandoffSchema.safeParse(value);
  return receipt.success && Number.isSafeInteger(now) && now >= 0
    && receipt.data.expiresAt > now && receipt.data.expiresAt <= now + MAC_SETUP_HANDOFF_TTL_MS
    ? receipt.data : null;
}
