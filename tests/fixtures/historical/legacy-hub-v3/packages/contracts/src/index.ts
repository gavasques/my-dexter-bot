import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const IdSchema = z.string().min(1).max(128);
export const ToolNameSchema = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);
export const TimestampSchema = z.number().int().nonnegative();
export const JsonSchema = z.json();
export type JsonValue = z.infer<typeof JsonSchema>;
export const EngineIdSchema = z.enum(["claude", "codex"]);
export type EngineId = z.infer<typeof EngineIdSchema>;

export const CreateBotSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  profileId: IdSchema,
  engine: EngineIdSchema,
});
export const BotSchema = CreateBotSchema.extend({
  id: IdSchema, ownerId: IdSchema, createdAt: TimestampSchema,
});
export type Bot = z.infer<typeof BotSchema>;
export const ThreadSchema = z.strictObject({ id: IdSchema, botId: IdSchema, createdAt: TimestampSchema });
export type Thread = z.infer<typeof ThreadSchema>;
export const AppendMessageSchema = z.strictObject({
  clientMessageId: IdSchema,
  content: z.string().min(1).max(32_768),
});
export const MessageSchema = AppendMessageSchema.extend({
  id: IdSchema, threadId: IdSchema, role: z.enum(["user", "assistant"]), createdAt: TimestampSchema,
});
export const MessageRecordSchema = MessageSchema.extend({ cursor: z.number().int().positive() });
export type Message = z.infer<typeof MessageRecordSchema>;

export const GrantInputSchema = z.strictObject({
  botId: IdSchema, tool: ToolNameSchema, destination: IdSchema,
  policy: z.enum(["allow", "ask", "deny"]),
  expiresAt: TimestampSchema.nullable().default(null),
});
export const GrantSchema = GrantInputSchema.extend({ revision: z.number().int().positive() });
export type Grant = z.infer<typeof GrantSchema>;
export const ToolRequestSchema = z.strictObject({
  botId: IdSchema, threadId: IdSchema, tool: ToolNameSchema, destination: IdSchema,
  arguments: z.record(z.string(), JsonSchema), idempotencyKey: IdSchema,
});
export type ToolRequest = z.infer<typeof ToolRequestSchema>;
export const ActionStateSchema = z.enum([
  "awaiting_approval", "ready", "running", "succeeded", "denied", "blocked", "unknown",
]);
export const ActionSchema = z.strictObject({
  id: IdSchema, request: ToolRequestSchema, requestHash: z.string().length(64),
  grantRevision: z.number().int().positive(), state: ActionStateSchema,
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
  approvalExpiresAt: TimestampSchema.nullable(), decidedBy: IdSchema.nullable(),
  result: JsonSchema.nullable(),
  reason: z.enum(["user_denied", "approval_expired", "permission_changed", "host_interrupted", "executor_error"]).nullable(),
});
export type Action = z.infer<typeof ActionSchema>;
export const ApprovalDecisionSchema = z.strictObject({
  decision: z.enum(["allow", "deny"]), requestHash: z.string().length(64),
});

export const DeviceInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120), platform: z.enum(["macos", "ios"]),
  capabilities: z.array(ToolNameSchema).max(100),
});
export const DeviceSchema = DeviceInputSchema.extend({
  id: IdSchema, ownerId: IdSchema, lastSeenAt: TimestampSchema, revokedAt: TimestampSchema.nullable(),
});
export type Device = z.infer<typeof DeviceSchema>;
export const RenameDeviceSchema = z.strictObject({ name: DeviceInputSchema.shape.name });
export const DeviceViewSchema = DeviceSchema.extend({
  presence: z.enum(["online", "stale", "revoked"]), paired: z.boolean(),
});
export type DeviceView = z.infer<typeof DeviceViewSchema>;

export const EventSchema = z.strictObject({
  id: IdSchema, kind: z.enum([
    "bot.created", "thread.created", "message.appended", "grant.changed",
    "device.registered", "device.seen", "device.revoked", "device.renamed", "action.created", "action.decided",
    "action.started", "action.succeeded", "action.blocked", "action.unknown",
  ]),
  botId: IdSchema.nullable(), threadId: IdSchema.nullable(), entityId: IdSchema, createdAt: TimestampSchema,
});
export const EventRecordSchema = EventSchema.extend({ cursor: z.number().int().positive() });
export type HostEvent = z.infer<typeof EventRecordSchema>;

export const StartTurnSchema = z.strictObject({
  clientRequestId: IdSchema, content: AppendMessageSchema.shape.content,
});
export const TurnSchema = z.strictObject({
  cursor: z.number().int().positive(), id: IdSchema, threadId: IdSchema, botId: IdSchema,
  engine: EngineIdSchema, clientRequestId: IdSchema, inputMessageId: IdSchema,
  outputMessageId: IdSchema.nullable(),
  state: z.enum(["queued", "running", "completed", "interrupted", "failed", "unknown"]),
  code: z.string().regex(/^[a-z_]{1,64}$/).nullable(), outputChars: z.number().int().nonnegative(),
  outputTruncated: z.boolean(), createdAt: TimestampSchema, startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(), updatedAt: TimestampSchema,
});
export const TurnEventSchema = z.strictObject({
  cursor: z.number().int().positive(), turnId: IdSchema, threadId: IdSchema,
  kind: z.enum(["turn.queued", "turn.started", "text.delta", "tool.requested", "tool.resolved",
    "turn.completed", "turn.interrupted", "turn.failed", "turn.unknown"]),
  text: z.string().nullable(), data: JsonSchema.nullable(), createdAt: TimestampSchema,
});

export const ContractSchemas = {
  bot: BotSchema, thread: ThreadSchema, message: MessageRecordSchema, action: ActionSchema,
  grant: GrantSchema, device: DeviceSchema, deviceView: DeviceViewSchema, renameDevice: RenameDeviceSchema, event: EventRecordSchema,
  startTurn: StartTurnSchema, turn: TurnSchema, turnEvent: TurnEventSchema,
};
export function exportContracts(): Record<string, unknown> {
  return Object.fromEntries(Object.entries(ContractSchemas).map(([name, schema]) => [name, z.toJSONSchema(schema)]));
}
