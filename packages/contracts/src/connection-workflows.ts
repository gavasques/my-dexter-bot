import { z } from "zod";
const id=z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const ConnectionWorkflowTargetSchema=z.discriminatedUnion("kind",[
  z.strictObject({kind:z.literal("managed"),serviceId:id,catalogPin:hash}),
  z.strictObject({kind:z.literal("native_mcp"),serverId:id,instancePin:hash}),
]);
export const ConnectionWorkflowRequestSchema=z.strictObject({clientRequestId:z.string().uuid(),expectedBotRevision:z.number().int().nonnegative(),target:ConnectionWorkflowTargetSchema});
export const ConnectionWorkflowSelectionSchema=z.strictObject({connectionId:id,expectedRevision:z.number().int().positive(),tools:z.array(z.strictObject({name:id,manifestHash:hash})).min(1).max(256)});
export const CompleteConnectionWorkflowSchema=z.strictObject({expectedHostID:id,clientRequestId:z.string().uuid(),expectedRevision:z.number().int().positive(),selections:z.array(ConnectionWorkflowSelectionSchema).min(1).max(5)})
  .refine(value=>JSON.stringify(value).length<=65_536,"Connection setup request exceeds 64 KiB.");
export const CancelConnectionWorkflowSchema=z.strictObject({expectedHostID:id,clientRequestId:z.string().uuid(),expectedRevision:z.number().int().positive()});
export const ConnectionWorkflowSchema=z.strictObject({version:z.literal(1),id,hostId:id,botId:id,threadId:id,originTurnId:id,actionId:id,clientRequestId:z.string().uuid(),requestHash:hash,
  target:ConnectionWorkflowTargetSchema,revision:z.number().int().positive(),state:z.enum(["awaiting_user","ready","cancelled","expired","stopped","conflict"]),
  expiresAt:z.number().int().nonnegative(),createdAt:z.number().int().nonnegative(),selections:z.array(ConnectionWorkflowSelectionSchema).max(5),continuationTurnId:id.nullable()});
export type ConnectionWorkflow=z.infer<typeof ConnectionWorkflowSchema>;
export type ConnectionWorkflowRequest=z.infer<typeof ConnectionWorkflowRequestSchema>;
export type CompleteConnectionWorkflow=z.infer<typeof CompleteConnectionWorkflowSchema>;
export type ConnectionWorkflowSelection=z.infer<typeof ConnectionWorkflowSelectionSchema>;
