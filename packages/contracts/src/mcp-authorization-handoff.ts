import { z } from "zod";

export const MCP_AUTHORIZATION_HANDOFF_TTL_MS = 5 * 60_000;
const serverId = z.string().regex(/^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/);
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Public first-party tool arguments. Identity and OAuth material cannot be supplied by the model. */
export const McpAuthorizationHandoffInputSchema = z.strictObject({
  server_id: serverId, expected_instance_pin: digest, action_id: identity.optional(),
});
/** Public durable receipt: only an exact owner decision can produce this UI handoff. No URL, state or credentials. */
export const McpAuthorizationHandoffSchema = z.strictObject({
  kind: z.literal("mcp_authorization_handoff"), serverId, instancePin: digest,
  hostId: identity, botId: identity, threadId: identity, actionId: identity,
  requestHash: digest, expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type McpAuthorizationHandoff = z.infer<typeof McpAuthorizationHandoffSchema>;

/** Expired receipts remain readable history; this helper checks only eligibility for a new local UI handoff. */
export function currentMcpAuthorizationHandoff(value: unknown, now: number): McpAuthorizationHandoff | null {
  const receipt = McpAuthorizationHandoffSchema.safeParse(value);
  return receipt.success && Number.isSafeInteger(now) && now >= 0
    && receipt.data.expiresAt > now && receipt.data.expiresAt <= now + MCP_AUTHORIZATION_HANDOFF_TTL_MS
    ? receipt.data : null;
}
