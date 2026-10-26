import { z } from "zod";
const ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const ServerID = z.string().regex(/^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/);
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const UUID = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const ToolIDs = z.array(z.string().min(1).max(128)).max(256).refine(v => new Set(v).size === v.length && [...v].sort().join("\0") === v.join("\0"));
export const McpInstanceSelectionInputSchema = z.object({
  mode: z.enum(["explicit", "all_connected"]), expectedInventoryPin: Hash, expectedSelectionPin: Hash,
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  instances: z.array(z.object({ serverId: ServerID, toolIds: ToolIDs }).strict()).max(32),
}).strict();
export const McpInstanceSelectionTargetSchema = z.object({
  serverId: ServerID, generation: UUID, instancePin: Hash, configurationPin: Hash,
  connectionId: ID, connectionRevision: Revision, toolIds: ToolIDs,
}).strict();
export const McpInstanceSelectionPlanSchema = z.object({
  version: z.literal(1), mode: z.enum(["explicit", "all_connected"]),
  inventoryPin: Hash, selectionPin: Hash, expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  targets: z.array(McpInstanceSelectionTargetSchema).max(32),
}).strict().refine(p => new Set(p.targets.map(t => t.serverId)).size === p.targets.length
  && p.targets.reduce((n,t) => n+t.toolIds.length,0) <= 256);
export type McpInstanceSelectionPlan = z.infer<typeof McpInstanceSelectionPlanSchema>;
export type McpInstanceSelectionTarget = z.infer<typeof McpInstanceSelectionTargetSchema>;
const Grant = z.object({ revision: Revision, policy: z.enum(["ask", "allow", "deny"]), expiresAt: z.number().int().min(0).nullable() }).strict();
export const McpInstanceSelectionStepSchema = z.object({
  serverId: ServerID, toolId: z.string().min(1).max(128), connectionId: ID,
  policy: z.enum(["ask", "deny"]), before: Grant.nullable(),
}).strict();
export const McpInstanceSelectionJournalSchema = z.object({
  version: z.literal(1), operation: z.literal("mcp.select_instances"), receiptId: UUID,
  actionId: ID, hubRequestHash: Hash, originHash: Hash, requestHash: Hash, botId: ID, profileId: ID,
  revision: Revision, plan: McpInstanceSelectionPlanSchema,
  steps: z.array(McpInstanceSelectionStepSchema).max(512),
  retainedGrants: z.array(z.object({toolId:z.string().min(1).max(128),connectionId:ID,grant:Grant}).strict()).max(256),
  phase: z.enum(["pending", "completed", "partial"]), code: z.enum(["interrupted", "scope_changed", "grant_conflict"]).nullable(),
  createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict().refine(j => j.revision === j.plan.expectedRevision+1 && (j.phase === "completed" ? j.code === null : j.phase === "partial" ? j.code !== null : j.code === null));
export type McpInstanceSelectionJournal = z.infer<typeof McpInstanceSelectionJournalSchema>;
export type McpInstanceSelectionStep = z.infer<typeof McpInstanceSelectionStepSchema>;
