import { z } from "zod";

/** Only public operation data. Authority/provenance never comes from this body. */
export const McpRegistrationRequestSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  expectedInstancePin: z.null(),
  definition: z.unknown(),
}).strict();
export const McpRegistrationReceiptQuerySchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
}).strict();

/** Host-only argument. Root must derive it from owner routing or the persisted capability/action. */
export interface McpRegistrationAuthority {
  installationId: string;
  ownerId: string;
  origin: { kind: "owner_local" } | {
    kind: "harness_action";
    botId: string;
    threadId: string;
    turnId: string;
    actionId: string;
    callId: string;
  };
}

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const UUID = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
/** No endpoint, name, headers, secret slot, command, args, account subject or private payload. */
export const McpRegistrationReceiptSchema = z.object({
  version: z.literal(1),
  operation: z.literal("mcp.register"),
  receiptId: UUID,
  requestKeyHash: Hash,
  requestIdHash: Hash,
  requestHash: Hash,
  inputHash: Hash,
  originHash: Hash,
  instanceId: z.string().regex(/^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/),
  generation: UUID,
  definitionPin: Hash,
  instancePin: Hash,
  registeredAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
export type McpRegistrationReceipt = z.infer<typeof McpRegistrationReceiptSchema>;
/** Current association is separate from the immutable, original effect receipt. */
export interface McpRegistrationReceiptState {
  receipt: McpRegistrationReceipt;
  instanceState: "registered" | "removed" | "replaced";
}
/** Aggregate capacity only; does not enumerate another origin's receipts or imply inventory/auth readiness. */
export interface McpRegistrationJournalStatus {
  version: 1;
  used: number;
  limit: 4096;
  remaining: number;
  registrationCapacity: "available" | "full";
}
