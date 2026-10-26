import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const uuid = z.string().uuid();
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const text = z.string().min(1).max(8192).refine(v => !/[\u0000]/.test(v) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v));
export const NATIVE_VOICE_META_KEY = 'native_voice_journal_v1';
export const MAX_NATIVE_VOICE_JOURNAL_BYTES = 2 * 1024 * 1024;
export const NativeVoiceCodeSchema = z.enum(['native_voice_unsupported','auth_needed','model_unsupported','audio_client_missing','scope_changed','host_stopping','provider_failed','protocol_error','timeout','receipt_capacity','handoff_missing_transcript']);
export type NativeVoiceCode = z.infer<typeof NativeVoiceCodeSchema>;
export const NativeVoiceStateSchema = z.enum(['starting','active','stopping','closed','failed','unknown']);
export const NativeVoiceSelectionSchema = z.strictObject({engine:z.literal('codex'),model:z.string().max(128).nullable(),reasoningEffort:z.string().max(64).nullable(),speed:z.string().max(64).nullable()});
export const NativeVoiceSessionSchema = z.strictObject({id:uuid,hostId:id,botId:id,threadId:id,generation:uuid,
  cursor:revision,startedAt:revision.nullable(),endedAt:revision.nullable(),turnIds:z.array(id).max(64),
  botRevision:revision,selectionRevision:revision,selection:NativeVoiceSelectionSchema,voice:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).nullable(),
  state:NativeVoiceStateSchema,revision,code:NativeVoiceCodeSchema.nullable(),createdAt:revision,updatedAt:revision,expiresAt:revision});
export type NativeVoiceSession = z.infer<typeof NativeVoiceSessionSchema>;
export const NativeVoiceReceiptSchema = z.strictObject({id:uuid,operation:z.enum(['start','stop']),clientRequestId:id,threadId:id,
  sessionId:uuid,generation:uuid,hostId:id,requestHash:z.string().regex(/^[a-f0-9]{64}$/),createdAt:revision});
export type NativeVoiceReceipt = z.infer<typeof NativeVoiceReceiptSchema>;
export const NativeVoicePreferenceSchema=z.strictObject({hostId:id,botId:id,revision,voice:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).nullable(),updatedAt:revision});
export type NativeVoicePreference=z.infer<typeof NativeVoicePreferenceSchema>;
export const PatchNativeVoicePreferenceSchema=z.strictObject({expectedHostId:id,expectedBotId:id,expectedBotRevision:revision,expectedRevision:revision,clientRequestId:id,voice:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).nullable()});
export type PatchNativeVoicePreference=z.infer<typeof PatchNativeVoicePreferenceSchema>;
export const NativeVoicePreferenceReceiptSchema=z.strictObject({id:uuid,hostId:id,botId:id,clientRequestId:id,requestHash:z.string().regex(/^[a-f0-9]{64}$/),previousRevision:revision,preference:NativeVoicePreferenceSchema,createdAt:revision});
export type NativeVoicePreferenceReceipt=z.infer<typeof NativeVoicePreferenceReceiptSchema>;
export const NativeVoiceJournalSchema = z.strictObject({version:z.literal(1),sessions:z.array(NativeVoiceSessionSchema).max(256),receipts:z.array(NativeVoiceReceiptSchema).max(1024),preferences:z.array(NativeVoicePreferenceSchema).max(256),preferenceReceipts:z.array(NativeVoicePreferenceReceiptSchema).max(1024)});
export type NativeVoiceJournal = z.infer<typeof NativeVoiceJournalSchema>;
const pin = {expectedHostId:id,expectedBotId:id,generation:uuid,clientRequestId:id,expectedRevision:revision};
export const StartNativeVoiceSchema = z.strictObject({...pin,expectedRevision:z.literal(0),sessionId:uuid,
  expectedBotRevision:revision,expectedSelectionRevision:revision,
  sdpOffer:z.string().min(1).max(65536).optional(),voice:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional()});
export type StartNativeVoice = z.infer<typeof StartNativeVoiceSchema>;
export const StopNativeVoiceSchema = z.strictObject(pin);
export type StopNativeVoice = z.infer<typeof StopNativeVoiceSchema>;
export const NativeVoiceStatusSchema = z.strictObject({hostId:id,botId:id,threadId:id,botRevision:revision,selectionRevision:revision,
  supported:z.boolean(),code:NativeVoiceCodeSchema.nullable(),authentication:z.literal('unknown'),billing:z.literal('subscription_cli'),
  protocol:z.literal('v3'),transport:z.literal('webrtc'),voices:z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(64),
  cliVersion:z.string().max(64).nullable(),activeSessionId:uuid.nullable()});
export type NativeVoiceStatus = z.infer<typeof NativeVoiceStatusSchema>;
export const NativeVoiceEventSchema = z.strictObject({cursor:revision,sessionId:uuid,generation:uuid,
  kind:z.enum(['started','transcript','turn','closed','failed']),role:z.enum(['user','assistant']).optional(),
  text:text.optional(),turnId:id.optional(),state:z.string().max(64).optional(),code:NativeVoiceCodeSchema.optional()});
export type NativeVoiceEvent = z.infer<typeof NativeVoiceEventSchema>;
/** This owner exchange is memory-only and never a journal/event/backup value. */
export const NativeVoiceExchangeSchema = z.strictObject({sessionId:uuid,generation:uuid,sdpAnswer:z.string().min(1).max(65536),expiresAt:revision});
export type NativeVoiceExchange = z.infer<typeof NativeVoiceExchangeSchema>;
export interface NativeVoiceProviderEvent {
  kind:'sdp'|'started'|'transcript'|'handoff'|'closed'|'failed';
  sdp?:string;role?:'user'|'assistant';text?:string;handoffId?:string;code?:NativeVoiceCode;
}
export interface NativeVoiceConnection { speech(text:string):Promise<void>; text(text:string):Promise<void>; stop():Promise<void>; close():Promise<void> }
export interface NativeVoiceBackend {
  capabilities():Promise<{supported:boolean;voices:string[];cliVersion:string|null}>;
  start(input:{threadId:string;selection:NativeVoiceSession['selection'];sdpOffer:string;voice?:string;initialItems:{role:'user'|'assistant';text:string}[];assertCurrent?:()=>void},
    emit:(event:NativeVoiceProviderEvent)=>void):Promise<NativeVoiceConnection>;
}
