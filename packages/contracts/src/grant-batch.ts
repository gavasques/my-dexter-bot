import { z } from "zod";
/** Host-owned, cross-database journal receipt. No engine or external MCP supplies this plan. */
export const GrantBatchSchema = z.strictObject({
  operationId:z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  grants:z.array(z.strictObject({botId:z.string().min(1).max(128),tool:z.string().min(2).max(128),
    destination:z.string().min(1).max(128),expectedRevision:z.number().int().nonnegative(),
    policy:z.enum(["allow","ask","deny"]),expiresAt:z.number().int().nonnegative().nullable()})).max(256),
}).refine(v=>new Set(v.grants.map(g=>JSON.stringify([g.botId,g.tool,g.destination]))).size===v.grants.length,"Duplicate grant target");
export type GrantBatch = z.infer<typeof GrantBatchSchema>;
export const GrantBatchReceiptSchema=z.strictObject({version:z.literal(1),operationId:z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  requestHash:z.string().regex(/^[a-f0-9]{64}$/),hostId:z.string().min(1).max(128),ownerId:z.string().min(1).max(128),request:GrantBatchSchema,
  grants:z.array(z.strictObject({botId:z.string().min(1).max(128),tool:z.string().min(2).max(128),destination:z.string().min(1).max(128),
    policy:z.enum(["allow","ask","deny"]),expiresAt:z.number().int().nonnegative().nullable(),revision:z.number().int().positive()})).max(256),
  createdAt:z.number().int().nonnegative(),
}).superRefine((value,context)=>{
  if(value.operationId!==value.request.operationId||value.grants.length!==value.request.grants.length)
    context.addIssue({code:"custom",message:"Grant receipt request differs."});
  value.grants.forEach((grant,index)=>{const request=value.request.grants[index];
    if(!request||grant.botId!==request.botId||grant.tool!==request.tool||grant.destination!==request.destination||grant.policy!==request.policy||grant.expiresAt!==request.expiresAt
      ||![request.expectedRevision,request.expectedRevision+1].includes(grant.revision))context.addIssue({code:"custom",message:"Grant receipt outcome differs."});
  });
});
export type GrantBatchReceipt=z.infer<typeof GrantBatchReceiptSchema>;
