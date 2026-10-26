import { z } from 'zod';
const wellFormed = (value: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const key = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const requestID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const markdown = z.string().max(8192).refine(value => wellFormed(value));
/** Literal note only. The host derives identity/provenance and preserves the existing head. */
export const MEMORY_NOTE_MAX_CHARACTERS = 2048;
export const BOT_MEMORY_MAX_CHARACTERS = 8192;
export const AppendBotMemoryNoteSchema = z.object({ expectedRevision: revision,
  note: z.string().min(1).max(MEMORY_NOTE_MAX_CHARACTERS).refine(value => wellFormed(value) && value.trim().length > 0),
}).strict();
export type AppendBotMemoryNote = z.infer<typeof AppendBotMemoryNoteSchema>;
// A textual citation is declared data, never evidence that the cited source is true.
export const MemoryReferenceSchema = z.string().max(512).refine(value => wellFormed(value));
/** Host-stamped append effect marker. It is never an engine-supplied source or permission. */
export const MemoryNoteEffectSchema = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/),
  outcome: z.enum(['appended','already_present']), baseRevision: revision,
  baseMemoryHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export const MemorySourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('legacy_unknown'), reference: z.null() }).strict(),
  z.object({ kind: z.literal('owner_ui'), ownerId: key, clientRequestId: requestID, reference: MemoryReferenceSchema.nullable() }).strict(),
  z.object({ kind: z.literal('harness_action'), ownerId: key, actionId: key, threadId: key, turnId: key, callId: requestID, reference: MemoryReferenceSchema.nullable(), memoryNote: MemoryNoteEffectSchema.optional() }).strict(),
]);
export type MemorySource = z.infer<typeof MemorySourceSchema>;
export const SetBotDocumentsSchema = z.object({ expectedRevision: revision, soul: markdown, user: markdown, memory: markdown,
  clientRequestId: requestID.optional(), sourceReference: MemoryReferenceSchema.optional() }).strict();
export const RestoreBotMemorySchema = z.object({ expectedRevision: revision, fromRevision: revision.refine(value => value > 0),
  clientRequestId: requestID, sourceReference: MemoryReferenceSchema.optional() }).strict();
export type RestoreBotMemory = z.infer<typeof RestoreBotMemorySchema>;
export interface BotMemoryRevision {
  botId: string; revision: number; pin: {path: string; sha256: string; commit: string};
  source: MemorySource; restoredFrom: number | null; updatedAt: number;
}
export interface BotMemoryHistory { items: BotMemoryRevision[]; nextCursor: string | null }
export interface BotMemoryVersion extends BotMemoryRevision { markdown: string }
export interface DocumentMutationReceipt {
  botId: string; operationKey: string; requestHash: string; operation: 'update' | 'restore' | 'append';
  revision: number; source: MemorySource; committedAt: number;
  /** Derived from the exact stored append input/revision; absent from pre-existing receipts. */
  note?: { sha256: string; outcome: 'appended' | 'already_present' };
}

/** Opt-in review pipeline. Policy never authorizes tools, self-modification or automatic MEMORY writes. */
export const MEMORY_ROUTINE_META_KEY = 'bot-memory-routines.v1';
export const MEMORY_ROUTINE_METADATA_BYTES = 262144;
export const MemoryRoutinePolicyInputSchema = z.object({ expectedRevision: revision, enabled: z.boolean(), maintenanceEnabled:z.boolean(),
  minIntervalMs:z.number().int().min(60000).max(86400000).default(60000),maxNotesPerDay:z.number().int().min(1).max(16).default(4),
  maxNoteCharacters:z.number().int().min(1).max(512).default(512),
}).strict().refine(value=>value.enabled || !value.maintenanceEnabled);
export type MemoryRoutinePolicyInput = z.infer<typeof MemoryRoutinePolicyInputSchema>;
export const MemoryRoutinePolicySchema = z.object({revision,epoch:revision,enabled:z.boolean(),maintenanceEnabled:z.boolean(),
 minIntervalMs:z.number().int().min(60000).max(86400000),maxNotesPerDay:z.number().int().min(1).max(16),maxNoteCharacters:z.number().int().min(1).max(512),
 actionId:key.nullable(),botRevision:revision,profileId:key,grantRevision:revision,updatedAt:revision,
}).strict();
export type MemoryRoutinePolicy = z.infer<typeof MemoryRoutinePolicySchema>;
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const MemoryRoutineSourceSchema = z.object({turnId:key,threadId:key,inputMessageId:key,outputMessageId:key,
 finishedAt:revision,outputHash:digest,outputCharacters:z.number().int().min(1).max(32768),role:z.literal('assistant'),
}).strict();
export const MemoryRoutineJobSchema = z.object({id:digest,botId:key,profileId:key,botRevision:revision,epoch:revision,policyRevision:revision,
 kind:z.enum(['capture','maintenance']),state:z.enum(['extracting','candidate','empty','invalid','withdrawn','unknown','proposed','committed','conflict']),
 source:MemoryRoutineSourceSchema.nullable(),note:z.string().max(512).refine(wellFormed).nullable(),baseRevision:revision,
 soulHash:digest,userHash:digest,memoryHash:digest,nextMemoryHash:digest.nullable(),actionId:key.nullable(),proposalTurnId:key.nullable(),
 createdAt:revision,updatedAt:revision,
}).strict();
export type MemoryRoutineJob = z.infer<typeof MemoryRoutineJobSchema>;
export const MemoryRoutinePolicyReceiptSchema = z.object({actionId:key,botId:key,ownerId:key,actionRequestHash:digest,inputHash:digest,
 previousRevision:revision,policy:MemoryRoutinePolicySchema,withdrawnJobIds:z.array(digest).max(128),committedAt:revision,
}).strict();
export type MemoryRoutinePolicyReceipt = z.infer<typeof MemoryRoutinePolicyReceiptSchema>;
export const MemoryRoutineMetadataSchema=z.object({version:z.literal(1),policies:z.record(key,MemoryRoutinePolicySchema),
 receipts:z.record(key,MemoryRoutinePolicyReceiptSchema),jobs:z.record(digest,MemoryRoutineJobSchema),
}).strict().refine(value=>Object.keys(value.policies).length<=32&&Object.keys(value.receipts).length<=160&&Object.keys(value.jobs).length<=128);
export type MemoryRoutineMetadata=z.infer<typeof MemoryRoutineMetadataSchema>;
export const MemoryRoutineExtractorResultSchema=z.object({note:z.string().min(1).max(512).refine(value=>wellFormed(value)&&value.trim().length>0),
 classification:z.literal('context'),
}).strict().nullable();
