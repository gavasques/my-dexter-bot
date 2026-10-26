import { GroupContractSchemas } from './groups.js';
import { z } from "zod";
import { BotAvatarAppearanceSchema } from "./avatar-appearance.js";
export * from "./avatar-appearance.js";
export * from "./tool-execution-failure.js";
export * from "./grant-batch.js";
export * from "./connection-workflows.js";
export * from "./mcp-private-input.js";
export { DeviceRoutePatchSchema, type DeviceRoutePatch, type DeviceConversationRoute, type DeviceRouteReceipt } from "./device-routes.js";
export { mcpSetupDiagnostic, readMcpSetupDiagnostic, type McpSetupDiagnostic, type McpSetupCause, type McpSetupStage } from "./mcp-setup.js";
export { DiscoverMcpServerSchema,type DiscoverMcpServer } from './mcp-discovery.js';
export { McpAuthorizationHandoffInputSchema, McpAuthorizationHandoffSchema, currentMcpAuthorizationHandoff,
  MCP_AUTHORIZATION_HANDOFF_TTL_MS, type McpAuthorizationHandoff } from "./mcp-authorization-handoff.js";
export { MacSetupHandoffInputSchema, MacSetupStatusInputSchema, MacSetupStatusSchema, MacSetupHandoffSchema,
  currentMacSetupHandoff, MAC_SETUP_HANDOFF_TTL_MS, MAC_SETUP_CUA_OPERATIONS,
  type MacSetupHandoff, type MacSetupStatus } from "./mac-setup-handoff.js";

export { EngineCatalogDiagnosticsSchema, EngineMcpAttachmentSchema, readEngineCatalogDiagnostics, type EngineCatalogDiagnostics, type EngineMcpAttachment } from './engine-diagnostics.js';
import type { EngineCatalogDiagnostics } from './engine-diagnostics.js';

export const PROTOCOL_VERSION = 1;
export const IdSchema = z.string().min(1).max(128);
export const ToolNameSchema = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);
export const TimestampSchema = z.number().int().nonnegative();
export const JsonSchema = z.json();
export type JsonValue = z.infer<typeof JsonSchema>;
export const EngineIdSchema = z.enum(["claude", "codex", "grok", "muse", "antigravity"]);
export type EngineId = z.infer<typeof EngineIdSchema>;

export const EngineSelectionSchema = z.strictObject({
  engine: EngineIdSchema, model: z.string().min(1).max(128).nullable(),
  reasoningEffort: z.string().min(1).max(64).nullable(), speed: z.string().min(1).max(64).nullable(),
});
export type EngineSelection = z.infer<typeof EngineSelectionSchema>;
export interface EngineCatalogModel { id: string; label?: string; reasoningEfforts: string[]; speeds: string[]; source?: string; minCliVersion?: string }
export interface EngineCatalogEntry {
  id: string; available: boolean; models: EngineCatalogModel[]; defaultModel: string | null;
  reasoningEfforts: string[]; speeds: string[]; installed?: boolean; version?: string;
  adapterSupported?: boolean; unavailableReason?: string;
  providerID?:string; providerLabel?:string; catalogSource?:string;
  diagnostics?: EngineCatalogDiagnostics;
}
export const PatchThreadEngineSelectionSchema = z.strictObject({
  expectedRevision:z.number().int().nonnegative(), selection:EngineSelectionSchema.nullable(),
  scope:z.enum(["thread","thread_and_bot"]).default("thread"), expectedBotRevision:z.number().int().nonnegative().optional(),
}).superRefine((value,context)=>{
  if(value.scope==="thread_and_bot"){
    if(value.expectedBotRevision===undefined)context.addIssue({code:"custom",path:["expectedBotRevision"],message:"Combined scope requires the bot revision."});
    if(value.selection===null)context.addIssue({code:"custom",path:["selection"],message:"Combined scope requires a selected engine configuration."});
  }
});
export function defaultEngineSelection(engine:EngineId):EngineSelection { return {engine,model:null,reasoningEffort:null,speed:null}; }

export const BROWSER_USE_META_KEY = "browser_use_config_v1";
export const MAX_BROWSER_USE_METADATA_BYTES = 262_144;
const BrowserUseRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Exact public DNS names only: no URL, wildcard, port, IP or implicit local-network access. */
export const BrowserUseDomainSchema = z.string().min(3).max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
  .refine(value => !/(?:^|\.)(?:localhost|local|lan|internal|intranet|invalid|test|onion|home|arpa)$/.test(value), "Use an exact public DNS hostname.");
export const BrowserUseBotPolicySchema = z.strictObject({
  enabled:z.boolean(),allowedDomains:z.array(BrowserUseDomainSchema).max(32)
    .refine(value=>new Set(value).size===value.length,"Domain names must be unique."),
  maxSteps:z.number().int().min(1).max(100),timeoutSeconds:z.number().int().min(30).max(240),
  profileId:z.string().uuid().regex(/^[0-9a-f-]+$/).nullable(),
}).superRefine((value,context)=>{
  if(value.enabled&&!value.allowedDomains.length)context.addIssue({code:"custom",path:["allowedDomains"],message:"Enabled browser access needs an explicit domain list."});
});
export type BrowserUseBotPolicy = z.infer<typeof BrowserUseBotPolicySchema>;
export function defaultBrowserUseBotPolicy():BrowserUseBotPolicy {return {enabled:false,allowedDomains:[],maxSteps:20,timeoutSeconds:120,profileId:null};}
const BrowserUseBotsSchema=z.record(z.string().regex(/^bot_[A-Za-z0-9_-]{1,124}$/),BrowserUseBotPolicySchema)
  .refine(value=>Object.keys(value).length<=500,"Too many browser policies.")
  .superRefine((value,context)=>{
    const profiles=new Set<string>();
    for(const [botId,policy] of Object.entries(value))if(policy.enabled&&policy.profileId!==null){
      if(profiles.has(policy.profileId))context.addIssue({code:"custom",path:[botId,"profileId"],message:"A browser profile cannot be shared by enabled bots."});
      profiles.add(policy.profileId);
    }
  });
export const BrowserUseConfigurationSchema=z.strictObject({version:z.literal(1),revision:BrowserUseRevisionSchema,
  enabled:z.boolean(),bots:BrowserUseBotsSchema})
  .refine(value=>JSON.stringify(value).length<=MAX_BROWSER_USE_METADATA_BYTES,"Browser configuration is too large.");
export type BrowserUseConfiguration=z.infer<typeof BrowserUseConfigurationSchema>;
export const BrowserUseSettingsSchema=BrowserUseConfigurationSchema.safeExtend({hostID:IdSchema});
export type BrowserUseSettings=z.infer<typeof BrowserUseSettingsSchema>;
export function defaultBrowserUseConfiguration():BrowserUseConfiguration {return {version:1,revision:0,enabled:false,bots:{}};}
/** Stable, closed metadata contains policy only, never credentials, remote tasks, browser handles or URLs. */
export function browserUseConfigurationJSON(config:BrowserUseConfiguration):string {
  return JSON.stringify({version:config.version,revision:config.revision,enabled:config.enabled,
    bots:Object.fromEntries(Object.entries(config.bots).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([id,policy])=>[id,
      {enabled:policy.enabled,allowedDomains:[...policy.allowedDomains].sort(),maxSteps:policy.maxSteps,timeoutSeconds:policy.timeoutSeconds,profileId:policy.profileId}]))});
}
export const PatchBrowserUseSettingsSchema=z.strictObject({expectedHostID:IdSchema,
  expectedRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),enabled:z.boolean(),bots:BrowserUseBotsSchema});
export const PatchBrowserUseBotPolicySchema=z.strictObject({expectedHostID:IdSchema,
  expectedRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),policy:BrowserUseBotPolicySchema});

export const LIVE_VOICE_META_KEY = "voice_config_v1";
export const LIVE_VOICES = ["alloy","ash","ballad","beacon","bossa","brise","cedar","cinder","coral","delta","echo","flitz","gleam","harema","juni","marin","meridian","nira","noeul","nuri","quartz","ripple","sage","shida","shimmer","sillage","stone","tempo","verse","vesper","willow"] as const;
export const LiveVoiceSchema = z.enum(LIVE_VOICES);
export type LiveVoice = z.infer<typeof LiveVoiceSchema>;
export const LiveVoiceSettingsSchema = z.strictObject({hostID:IdSchema,enabled:z.boolean(),defaultVoice:LiveVoiceSchema,
  revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)});
export type LiveVoiceSettings = z.infer<typeof LiveVoiceSettingsSchema>;
export const LiveVoiceConfigurationSchema = z.strictObject({version:z.literal(1),
  revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),enabled:z.boolean(),defaultVoice:LiveVoiceSchema,
  botVoices:z.record(z.string().regex(/^bot_[A-Za-z0-9_-]{1,124}$/),LiveVoiceSchema).refine(value=>Object.keys(value).length<=500,"Too many bot voice overrides.")});
export type LiveVoiceConfiguration = z.infer<typeof LiveVoiceConfigurationSchema>;
export function defaultLiveVoiceConfiguration():LiveVoiceConfiguration {return {version:1,revision:0,enabled:false,defaultVoice:"bossa",botVoices:{}};}
/** Closed deterministic metadata serialization; this document contains no credentials or audio. */
export function liveVoiceConfigurationJSON(config:LiveVoiceConfiguration):string {
  return JSON.stringify({version:config.version,revision:config.revision,enabled:config.enabled,defaultVoice:config.defaultVoice,
    botVoices:Object.fromEntries(Object.entries(config.botVoices).sort(([a],[b])=>a<b?-1:a>b?1:0))});
}
export const PatchLiveVoiceSettingsSchema=z.strictObject({expectedHostID:IdSchema,enabled:z.boolean(),defaultVoice:LiveVoiceSchema,
  expectedRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1)});
const VoiceUUIDSchema=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const LiveVoiceTranscriptSegmentSchema=z.strictObject({id:VoiceUUIDSchema,role:z.enum(["user","assistant"]),
  text:z.string().min(1).max(8192).refine(value=>{
    for(let index=0;index<value.length;index++){
      const unit=value.charCodeAt(index);
      if(unit>=0xd800&&unit<=0xdbff){const next=value.charCodeAt(++index);if(!(next>=0xdc00&&next<=0xdfff))return false;}
      else if(unit>=0xdc00&&unit<=0xdfff)return false;
    }
    return true;
  },"Transcript text must be well formed."),startMS:z.number().int().nonnegative().max(86_400_000).optional(),
  endMS:z.number().int().nonnegative().max(86_400_000).optional()}).superRefine((value,context)=>{
    if(value.startMS!==undefined&&value.endMS!==undefined&&value.endMS<value.startMS)
      context.addIssue({code:"custom",path:["endMS"],message:"Segment end precedes its start."});
  });
export type LiveVoiceTranscriptSegment=z.infer<typeof LiveVoiceTranscriptSegmentSchema>;
export const LiveVoiceTranscriptSchema=z.strictObject({hostID:IdSchema,sessionID:VoiceUUIDSchema,segments:z.array(LiveVoiceTranscriptSegmentSchema).max(128)})
  .superRefine((value,context)=>{
    if(new Set(value.segments.map(segment=>segment.id)).size!==value.segments.length)
      context.addIssue({code:"custom",path:["segments"],message:"Segment IDs must be unique."});
    if(value.segments.reduce((total,segment)=>total+segment.text.length,0)>32768)
      context.addIssue({code:"custom",path:["segments"],message:"Transcript exceeds its text budget."});
  });

/** Avatar bytes are canonical host media, never inline bot/team metadata or model context. */
export const MAX_AVATAR_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_AVATAR_STORAGE_BYTES = 100 * 1024 * 1024;
export const MAX_AVATAR_IMAGES = 2048;
export const MAX_AVATAR_UPLOAD_RECEIPTS = 8192;
export const AvatarImageIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const AvatarImageSchema = z.strictObject({id:AvatarImageIdSchema,mediaType:z.literal("image/png"),
  sha256:z.string().regex(/^[0-9a-f]{64}$/),bytes:z.number().int().min(1).max(MAX_AVATAR_IMAGE_BYTES),
  width:z.number().int().min(1).max(1024),height:z.number().int().min(1).max(1024),createdAt:TimestampSchema});
export type AvatarImage = z.infer<typeof AvatarImageSchema>;
export const UploadAvatarImageSchema = z.strictObject({expectedHostID:IdSchema,clientRequestId:AvatarImageIdSchema,
  mediaType:z.literal("image/png"),dataBase64:z.string().min(1).max(4*Math.ceil(MAX_AVATAR_IMAGE_BYTES/3))});
/** Human-owned execution policy. Grants and private consent remain separate authorities. */
export const APPROVAL_POLICY_SCOPE_VERSION = "d03.execution.v1" as const;
export const ApprovalPolicyModeSchema = z.enum(["ask", "accept_edits", "approve_all", "full_access"]);
export const BotApprovalPolicySchema = z.strictObject({
  hostId:IdSchema, botId:IdSchema, ownerId:IdSchema, mode:ApprovalPolicyModeSchema,
  revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  eligibleScopeVersion:z.literal(APPROVAL_POLICY_SCOPE_VERSION), updatedAt:TimestampSchema, receiptId:IdSchema.nullable(),
});
export type BotApprovalPolicy = z.infer<typeof BotApprovalPolicySchema>;
export const SetBotApprovalPolicySchema = z.strictObject({
  expectedHostId:IdSchema,clientRequestId:IdSchema,
  expectedRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),
  mode:ApprovalPolicyModeSchema,eligibleScopeVersion:z.literal(APPROVAL_POLICY_SCOPE_VERSION),
});
export const BotApprovalPolicyReceiptSchema = z.strictObject({
  id:IdSchema,clientRequestId:IdSchema,inputHash:z.string().regex(/^[0-9a-f]{64}$/),
  hostId:IdSchema,botId:IdSchema,ownerId:IdSchema,previous:BotApprovalPolicySchema,policy:BotApprovalPolicySchema,
  revocationEffects:z.strictObject({blockedActionIds:z.array(IdSchema),abortedActionIds:z.array(IdSchema)}),createdAt:TimestampSchema,
});
export type BotApprovalPolicyReceipt = z.infer<typeof BotApprovalPolicyReceiptSchema>;
export const ActionAuthorizationSchema = z.strictObject({
  source:z.enum(["exact_owner","owner_policy","bounded_grant","thread_policy","owner_type"]),ownerId:IdSchema,
  policyRevision:z.number().int().nonnegative().nullable(),policyReceiptId:IdSchema.nullable(),
  eligibleScopeVersion:z.literal(APPROVAL_POLICY_SCOPE_VERSION).nullable(),
});
export type ActionAuthorization = z.infer<typeof ActionAuthorizationSchema>;
/** Four host modes. This table describes automatic approval only; no row creates access. */
export const APPROVAL_MODE_EFFECTS = Object.freeze({
  ask: { edits:false, commands:false, routine:false },
  accept_edits: { edits:true, commands:false, routine:false },
  approve_all: { edits:true, commands:false, routine:true },
  full_access: { edits:true, commands:true, routine:true },
} as const);
export const ThreadApprovalPolicySchema=z.strictObject({hostId:IdSchema,ownerId:IdSchema,botId:IdSchema,threadId:IdSchema,
  overrideMode:ApprovalPolicyModeSchema.nullable(),revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),receiptId:IdSchema.nullable(),updatedAt:TimestampSchema});
export type ThreadApprovalPolicy=z.infer<typeof ThreadApprovalPolicySchema>;
export const EffectiveApprovalPolicySchema=z.strictObject({thread:ThreadApprovalPolicySchema,bot:BotApprovalPolicySchema,
  mode:ApprovalPolicyModeSchema,source:z.enum(["bot_default","chat_override"]),effects:z.strictObject({edits:z.boolean(),commands:z.boolean(),routine:z.boolean()})});
export const SetThreadApprovalPolicySchema=z.strictObject({expectedHostId:IdSchema,clientRequestId:IdSchema,
  expectedRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),overrideMode:ApprovalPolicyModeSchema.nullable()});
export const ApprovalTypeSchema=z.strictObject({key:z.string().regex(/^[a-f0-9]{64}$/).nullable(),eligible:z.boolean(),
  reason:z.enum(["eligible","private_flow","access_not_enabled","unsupported","pins_unavailable","authority_changed"]),
  category:z.enum(["edits","commands","routine","other"]),revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),enabled:z.boolean()});
export type ApprovalType=z.infer<typeof ApprovalTypeSchema>;
export const ApprovalContextSchema=z.strictObject({version:z.literal("approval.preferences.v1"),
 eligibility:z.enum(["terminal","cli","files_write","native_mcp","native_mcp_read","device","browser_use","automation","own_documents"]).nullable(),
 category:z.enum(["edits","commands","routine","other"]),eligible:z.boolean(),reason:ApprovalTypeSchema.shape.reason,
 typeKey:z.string().regex(/^[a-f0-9]{64}$/).nullable(),pinsHash:z.string().regex(/^[a-f0-9]{64}$/),
 botRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),authorityEpoch:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),grantRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1)});
export type ApprovalContext=z.infer<typeof ApprovalContextSchema>;
export const ApprovalTypePreferenceSchema=z.strictObject({key:z.string().regex(/^[a-f0-9]{64}$/),hostId:IdSchema,ownerId:IdSchema,botId:IdSchema,
  tool:ToolNameSchema,destination:IdSchema,grantRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1),authorityEpoch:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),
  pinsHash:z.string().regex(/^[a-f0-9]{64}$/),revision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1),enabled:z.boolean(),receiptId:IdSchema,updatedAt:TimestampSchema});
export const DecideApprovalPreferenceSchema=z.strictObject({expectedHostId:IdSchema,clientRequestId:IdSchema,
  requestHash:z.string().regex(/^[a-f0-9]{64}$/),decision:z.enum(["allow","deny"]),alwaysAccept:z.boolean(),
  expectedTypeKey:z.string().regex(/^[a-f0-9]{64}$/).nullable(),expectedPreferenceRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1)});
export const RevokeApprovalTypeSchema=z.strictObject({expectedHostId:IdSchema,clientRequestId:IdSchema,expectedRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1)});
export const ApprovalPreferenceReceiptSchema=z.strictObject({id:IdSchema,clientRequestId:IdSchema,inputHash:z.string().regex(/^[a-f0-9]{64}$/),
  hostId:IdSchema,ownerId:IdSchema,botId:IdSchema,kind:z.enum(["chat_mode","decision","type_revoke"]),targetId:IdSchema,
  input:JsonSchema,previous:JsonSchema,state:JsonSchema,createdAt:TimestampSchema,
  revocationEffects:z.strictObject({blockedActionIds:z.array(IdSchema),abortedActionIds:z.array(IdSchema)})});
export type ApprovalPreferenceReceipt=z.infer<typeof ApprovalPreferenceReceiptSchema>;
export const CreateBotSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  profileId: IdSchema,
  engine: EngineIdSchema, defaultSelection: EngineSelectionSchema.optional(),avatarImageId:AvatarImageIdSchema.nullable().optional(),
  avatarAppearance:BotAvatarAppearanceSchema.nullable().optional(),
});
const AvatarEmojiSchema = z.string().max(16).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value.replace(/\u200d/g, "")), "Avatar contains control characters").nullable();
export const PatchBotSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  defaultSelection: EngineSelectionSchema.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  roleDescription: z.string().max(2000).optional(),
  avatarEmoji: AvatarEmojiSchema.optional(),
  avatarImageId:AvatarImageIdSchema.nullable().optional(),
  avatarAppearance:BotAvatarAppearanceSchema.nullable().optional(),
  canSeeBots: z.boolean().optional(), canReceiveOrders: z.boolean().optional(),
  canSendActions: z.boolean().optional(), isMaster: z.boolean().optional(),
  liveVoice:LiveVoiceSchema.nullable().optional(),
});
/** A bot may propose only its own three communication preferences, never Master status or tool grants. */
export const BotCommunicationPatchSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  canSeeBots: z.boolean().optional(), canSendActions: z.boolean().optional(), canReceiveOrders: z.boolean().optional(),
}).refine(value => value.canSeeBots !== undefined || value.canSendActions !== undefined || value.canReceiveOrders !== undefined,
  "At least one communication flag is required.");
export type BotCommunicationPatch = z.infer<typeof BotCommunicationPatchSchema>;
export const BOT_COMMUNICATION_TOOL = "dexter.harness.bots.communication.update";
export const BOT_COMMUNICATION_DESTINATION = "dexter-harness-owner-proposals";
/** Whole, literal phrases only. This parser does not interpret model text, attachments or compound instructions. */
export function parseBotCommunicationConfirmation(text: string): "allow" | "deny" | null {
  const phrase = text.trim().toLocaleLowerCase("en-US").replace(/[.!]+$/u, "").trim();
  if (["sim", "yes", "pode fazer", "pode aplicar", "autorizo"].includes(phrase)) return "allow";
  if (["não", "nao", "no", "não pode", "nao pode"].includes(phrase)) return "deny";
  return null;
}
export const BotSchema = CreateBotSchema.omit({avatarImageId:true}).extend({
  id: IdSchema, ownerId: IdSchema, createdAt: TimestampSchema,
  roleDescription: z.string().max(2000).default(""), avatarEmoji: AvatarEmojiSchema.default(null),
  avatarImage:AvatarImageSchema.nullable().optional(),
  canSeeBots: z.boolean().default(false), canReceiveOrders: z.boolean().default(false),
  canSendActions: z.boolean().default(false), isMaster: z.boolean().default(false),
  revision: z.number().int().nonnegative().default(0),
  liveVoice:LiveVoiceSchema.nullable().optional(),
});
export type Bot = z.infer<typeof BotSchema>;
export const LiveVoiceContextSchema=z.strictObject({hostID:IdSchema,bot:BotSchema,threadID:IdSchema,
  settings:LiveVoiceSettingsSchema,voice:LiveVoiceSchema,instructions:z.string().max(1200),
  documents:z.strictObject({botId:IdSchema,revision:z.number().int().nonnegative(),soul:z.string().max(6000),
    user:z.string().max(6000),memory:z.string().max(6000),updatedAt:TimestampSchema.nullable()}).optional(),
  history:z.array(z.strictObject({role:z.enum(["user","assistant"]),text:z.string().max(1800)})).max(12)});
export type LiveVoiceContext=z.infer<typeof LiveVoiceContextSchema>;
export const ThreadEngineSelectionSchema = z.strictObject({selection:EngineSelectionSchema,override:EngineSelectionSchema.nullable(),
  revision:z.number().int().nonnegative(),handoffStatus:z.enum(["none","ready"]),updatedBot:BotSchema.optional()});
export type ThreadEngineSelection = z.infer<typeof ThreadEngineSelectionSchema>;
export const DelegateBotInputSchema = z.strictObject({
  targetBotId: IdSchema, task: z.string().min(1).max(8192),
});
export const BotDelegationSchema = z.strictObject({
  id: IdSchema, sourceBotId: IdSchema, targetBotId: IdSchema,
  sourceThreadId: IdSchema, targetThreadId: IdSchema, sourceTurnId: IdSchema, targetTurnId: IdSchema,
  parentId: IdSchema.nullable(), rootId: IdSchema, depth: z.number().int().min(1).max(3),
  deadlineAt: TimestampSchema, state: z.enum(["pending", "running", "completed", "cancelled", "failed", "unknown"]),
  createdAt: TimestampSchema, updatedAt: TimestampSchema, result: z.string().max(32768).nullable(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/), callId: IdSchema,
});
export type BotDelegation = z.infer<typeof BotDelegationSchema>;
export const SkillIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const SkillVersionSchema = z.string().max(64).regex(/^\d+\.\d+\.\d+$/);
export const SkillLockSchema = z.strictObject({ id: SkillIdSchema, version: SkillVersionSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/), commit: z.string().regex(/^[a-f0-9]{40,64}$/), path: z.string().min(1).max(512) });
export type SkillLockDto = z.infer<typeof SkillLockSchema>;
export const OwnerSkillScopeSchema = z.discriminatedUnion("kind", [z.strictObject({kind:z.literal("global")}),
  z.strictObject({kind:z.literal("bot"),botId:SkillIdSchema})]);
export type OwnerSkillScope = z.infer<typeof OwnerSkillScopeSchema>;
/** Validate UTF-16 without requiring the newer String.isWellFormed library declaration. */
function wellFormedSkillMarkdown(value:string):boolean {
  for(let index=0;index<value.length;index++){
    const unit=value.charCodeAt(index);
    if(unit>=0xd800 && unit<=0xdbff){
      const next=value.charCodeAt(++index);
      if(!(next>=0xdc00 && next<=0xdfff))return false;
    }else if(unit>=0xdc00 && unit<=0xdfff)return false;
  }
  return true;
}
export const TEAM_WORKSPACES_META_KEY = "team_workspaces_v1";
export const MAX_TEAMS = 100;
export const MAX_TEAM_BOTS = 32;
export const MAX_TEAM_BINDINGS = 4096;
export const MAX_TEAM_METADATA_BYTES = 8 * 1024 * 1024;
const TeamIdentitySchema = IdSchema.regex(/^[A-Za-z0-9_-]{1,128}$/);
export const TeamRequestIDSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const TeamRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const TeamTimeSchema = TimestampSchema.max(Number.MAX_SAFE_INTEGER);
const TeamNameSchema = z.string().trim().min(1).max(120).refine(wellFormedSkillMarkdown);
const TeamRoleSchema = z.string().max(2000).refine(wellFormedSkillMarkdown);
const TeamTextSchema = z.string().max(8192).refine(wellFormedSkillMarkdown);
const TeamEmojiSchema = AvatarEmojiSchema.refine(value => value === null || wellFormedSkillMarkdown(value));
const TeamBotIDsSchema = z.array(TeamIdentitySchema).max(MAX_TEAM_BOTS)
  .refine(value => new Set(value).size === value.length, "Team bot ids must be unique.");
export const TeamSchema = z.strictObject({id:TeamIdentitySchema,ownerId:TeamIdentitySchema,name:TeamNameSchema,
  avatarEmoji:TeamEmojiSchema,roleDescription:TeamRoleSchema,coordinatorBotId:TeamIdentitySchema.nullable(),
  avatarImage:AvatarImageSchema.nullable().optional(),
  botIds:TeamBotIDsSchema,rules:TeamTextSchema,memory:TeamTextSchema,revision:TeamRevisionSchema,
  createdAt:TeamTimeSchema,updatedAt:TeamTimeSchema});
export type Team = z.infer<typeof TeamSchema>;
export const CreateTeamSchema = z.strictObject({expectedHostID:IdSchema,clientRequestId:TeamRequestIDSchema,name:TeamNameSchema,
  avatarEmoji:TeamEmojiSchema.optional(),roleDescription:TeamRoleSchema.optional(),coordinatorBotId:TeamIdentitySchema,
  avatarImageId:AvatarImageIdSchema.nullable().optional(),
  botIds:TeamBotIDsSchema,rules:TeamTextSchema.optional(),memory:TeamTextSchema.optional()})
  .refine(value => value.botIds.includes(value.coordinatorBotId), "The coordinator must belong to the team.");
export type CreateTeam = z.infer<typeof CreateTeamSchema>;
export const PatchTeamSchema = z.strictObject({expectedHostID:IdSchema,expectedRevision:TeamRevisionSchema,
  name:TeamNameSchema.optional(),avatarEmoji:TeamEmojiSchema.optional(),roleDescription:TeamRoleSchema.optional(),
  avatarImageId:AvatarImageIdSchema.nullable().optional(),
  coordinatorBotId:TeamIdentitySchema.optional(),botIds:TeamBotIDsSchema.optional(),rules:TeamTextSchema.optional(),memory:TeamTextSchema.optional()});
export type PatchTeam = z.infer<typeof PatchTeamSchema>;
const TeamWorkspaceProfileSchema = z.strictObject({avatarEmoji:TeamEmojiSchema,roleDescription:TeamRoleSchema,
  avatarImageId:AvatarImageIdSchema.nullable().optional(),
  coordinatorBotId:TeamIdentitySchema,rules:TeamTextSchema,memory:TeamTextSchema,
  revision:TeamRevisionSchema.refine(value=>value>=1),createdAt:TeamTimeSchema,updatedAt:TeamTimeSchema});
const TeamWorkspaceBindingSchema = z.strictObject({teamId:TeamIdentitySchema,coordinatorBotId:TeamIdentitySchema,
  teamRevision:TeamRevisionSchema.refine(value=>value>=1),createdAt:TeamTimeSchema,delegationId:TeamIdentitySchema.nullable()});
const TeamCreateReceiptSchema = z.strictObject({requestHash:z.string().regex(/^[0-9a-f]{64}$/),team:TeamSchema});
const TeamThreadReceiptSchema = z.strictObject({teamId:TeamIdentitySchema,expectedRevision:TeamRevisionSchema,
  requestHash:z.string().regex(/^[0-9a-f]{64}$/),threadId:TeamIdentitySchema,teamRevision:TeamRevisionSchema,
  coordinatorBotId:TeamIdentitySchema,createdAt:TeamTimeSchema});
/** The canonical Context document extends the existing registry; it never owns a second team or membership list. */
export const TeamWorkspacesMetadataSchema = z.strictObject({version:z.literal(1),
  profiles:z.record(TeamIdentitySchema,TeamWorkspaceProfileSchema).refine(value=>Object.keys(value).length<=MAX_TEAMS),
  bindings:z.record(TeamIdentitySchema,TeamWorkspaceBindingSchema).refine(value=>Object.keys(value).length<=MAX_TEAM_BINDINGS),
  createReceipts:z.record(TeamRequestIDSchema,TeamCreateReceiptSchema).refine(value=>Object.keys(value).length<=MAX_TEAMS),
  threadReceipts:z.record(TeamRequestIDSchema,TeamThreadReceiptSchema).refine(value=>Object.keys(value).length<=MAX_TEAM_BINDINGS)});
export type TeamWorkspacesMetadata = z.infer<typeof TeamWorkspacesMetadataSchema>;
export function defaultTeamWorkspacesMetadata():TeamWorkspacesMetadata {
  return {version:1,profiles:{},bindings:{},createReceipts:{},threadReceipts:{}};
}
/** Stable recursive key order permits closed metadata and exact replay checks in both host and backup gates. */
export function teamWorkspacesCanonicalJSON(value:unknown):string {
  const sort = (entry:unknown):unknown => {
    if(Array.isArray(entry))return entry.map(sort);
    if(entry!==null&&typeof entry==="object")return Object.fromEntries(Object.entries(entry)
      .filter(([,item])=>item!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,sort(item)]));
    return entry;
  };
  return JSON.stringify(sort(value));
}
export const RegisterSkillSchema = z.strictObject({id:SkillIdSchema,version:SkillVersionSchema,
  markdown:z.string().min(1).max(32768).refine(wellFormedSkillMarkdown)});
export const SetSkillActivationSchema = z.strictObject({scope:OwnerSkillScopeSchema,
  expected:z.strictObject({version:SkillVersionSchema,sha256:z.string().regex(/^[a-f0-9]{64}$/)}).nullable(),
  version:SkillVersionSchema.nullable()});
export type SetSkillActivation = z.infer<typeof SetSkillActivationSchema>;
export const SkillActivationSchema = z.strictObject({scope:OwnerSkillScopeSchema,skillId:SkillIdSchema,lock:SkillLockSchema.nullable()});
export type SkillActivationDto = z.infer<typeof SkillActivationSchema>;
export const ThreadSchema = z.strictObject({ id: IdSchema, botId: IdSchema, createdAt: TimestampSchema, teamId: IdSchema.nullable().optional(), audience:z.enum(["private","group"]).optional(), groupId:IdSchema.nullable().optional(), groupConversationId:IdSchema.nullable().optional() });
export type Thread = z.infer<typeof ThreadSchema>;
export const TeamThreadSchema = z.strictObject({teamId:TeamIdentitySchema,teamRevision:TeamRevisionSchema,thread:ThreadSchema});
export type TeamThread = z.infer<typeof TeamThreadSchema>;
/** Display-only history metadata derived from persisted messages. Additive sibling of list `items`; never part of Thread or receipts. */
export const THREAD_SUMMARY_TITLE_MAX = 80, THREAD_SUMMARY_PREVIEW_MAX = 160, THREAD_LIST_MAX = 500;
export const ThreadSummarySchema = z.strictObject({
  threadId: IdSchema, title: z.string().min(1).max(THREAD_SUMMARY_TITLE_MAX).nullable(),
  preview: z.string().min(1).max(THREAD_SUMMARY_PREVIEW_MAX).nullable(), previewRole: z.enum(["user", "assistant"]).nullable(),
  lastMessageHasImage: z.boolean(), messageCount: z.number().int().nonnegative(),
  lastMessageAt: TimestampSchema.nullable(), updatedAt: TimestampSchema,
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;
export const ThreadListResponseSchema = z.strictObject({
  items: z.array(ThreadSchema), summaries: z.array(ThreadSummarySchema).max(THREAD_LIST_MAX).optional(),
});
export const MAX_IMAGE_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENTS = 4;
export const ImageAttachmentIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const ImageAttachmentSchema = z.strictObject({
  id: ImageAttachmentIdSchema, threadId: IdSchema, mediaType: z.literal("image/png"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().positive().max(MAX_IMAGE_ATTACHMENT_BYTES),
  width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096), createdAt: TimestampSchema,
});
export type ImageAttachment = z.infer<typeof ImageAttachmentSchema>;
export const UploadImageAttachmentSchema = z.strictObject({
  clientAttachmentId: ImageAttachmentIdSchema, mediaType: z.literal("image/png"),
  dataBase64: z.string().min(4).max(4 * Math.ceil(MAX_IMAGE_ATTACHMENT_BYTES / 3)),
});
const AttachmentIdsSchema = z.array(ImageAttachmentIdSchema).max(MAX_MESSAGE_ATTACHMENTS)
  .refine(ids => new Set(ids).size === ids.length, "Duplicate attachment ids");
export const AppendMessageSchema = z.strictObject({
  clientMessageId: IdSchema,
  content: z.string().max(32_768), attachmentIds: AttachmentIdsSchema.optional(),
});
export const MessageSchema = z.strictObject({
  clientMessageId: IdSchema, content: z.string().max(32_768), attachments: z.array(ImageAttachmentSchema).max(MAX_MESSAGE_ATTACHMENTS).default([]),
  id: IdSchema, threadId: IdSchema, role: z.enum(["user", "assistant"]), createdAt: TimestampSchema,
});
export const MessageRecordSchema = MessageSchema.extend({ cursor: z.number().int().positive() });
export type Message = z.infer<typeof MessageRecordSchema>;
export const LiveVoiceTranscriptReceiptSchema=z.strictObject({hostID:IdSchema,sessionID:VoiceUUIDSchema,threadID:IdSchema,
  messages:z.array(MessageRecordSchema).max(128)});
export type LiveVoiceTranscriptReceipt=z.infer<typeof LiveVoiceTranscriptReceiptSchema>;

export const GrantInputSchema = z.strictObject({
  botId: IdSchema, tool: ToolNameSchema, destination: IdSchema,
  policy: z.enum(["allow", "ask", "deny"]),
  expiresAt: TimestampSchema.nullable().default(null),
});
export const GrantSchema = GrantInputSchema.extend({ revision: z.number().int().positive() });
export type Grant = z.infer<typeof GrantSchema>;

/** Closed first-party execution registry. These IDs select operations, never caller-supplied targets. */
export const BOT_EXECUTION_ACCESS_SCOPE_VERSION = "d03.access.v1" as const;
export const BOT_EXECUTION_ACCESS_REGISTRY = Object.freeze([
  Object.freeze({operation:"terminal",tool:"dexter.harness.terminal.run",destination:"dexter-harness-owner-proposals"}),
  Object.freeze({operation:"cli",tool:"dexter.harness.cli.run",destination:"dexter-harness-owner-proposals"}),
  Object.freeze({operation:"files_write",tool:"dexter.harness.files.write",destination:"dexter-harness-owner-proposals"}),
  Object.freeze({operation:"automation",tool:"dexter.automations.run",destination:"dexter-automations"}),
] as const);
export const BotExecutionOperationSchema=z.enum(["terminal","cli","files_write","automation"]);
export type BotExecutionOperation=z.infer<typeof BotExecutionOperationSchema>;
export const BotExecutionAccessEntrySchema=z.strictObject({operation:BotExecutionOperationSchema,
  grant:GrantSchema.nullable(),provisional:z.boolean(),enabled:z.boolean()});
export const BotExecutionAccessSchema=z.strictObject({hostId:IdSchema,botId:IdSchema,ownerId:IdSchema,
  botRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),scopeVersion:z.literal(BOT_EXECUTION_ACCESS_SCOPE_VERSION),
  inventoryHash:z.string().regex(/^[0-9a-f]{64}$/),entries:z.array(BotExecutionAccessEntrySchema).length(4)});
export type BotExecutionAccess=z.infer<typeof BotExecutionAccessSchema>;
export const SetBotExecutionAccessSchema=z.strictObject({expectedHostId:IdSchema,clientRequestId:IdSchema,
  expectedBotRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),expectedInventoryHash:z.string().regex(/^[0-9a-f]{64}$/),
  scopeVersion:z.literal(BOT_EXECUTION_ACCESS_SCOPE_VERSION),operation:BotExecutionOperationSchema,enabled:z.boolean()});
export const BotExecutionAccessReceiptSchema=z.strictObject({id:IdSchema,clientRequestId:IdSchema,
  inputHash:z.string().regex(/^[0-9a-f]{64}$/),hostId:IdSchema,botId:IdSchema,ownerId:IdSchema,
  input:SetBotExecutionAccessSchema,previous:BotExecutionAccessSchema,access:BotExecutionAccessSchema,
  revocationEffects:z.strictObject({blockedActionIds:z.array(IdSchema),abortedActionIds:z.array(IdSchema)}),createdAt:TimestampSchema});
export type BotExecutionAccessReceipt=z.infer<typeof BotExecutionAccessReceiptSchema>;
export const ActionApprovalRequirementSchema=z.strictObject({reason:z.literal("access_not_enabled"),
  policyRevision:z.number().int().nonnegative()});

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
  result: JsonSchema.nullable(), authorization:ActionAuthorizationSchema.optional(), approvalRequirement:ActionApprovalRequirementSchema.optional(), approvalType:ApprovalTypeSchema.optional(),
  reason: z.enum(["user_denied", "approval_expired", "permission_changed", "host_interrupted", "executor_error"]).nullable(),
});
export type Action = z.infer<typeof ActionSchema>;
export const ApprovalDecisionSchema = z.strictObject({
  decision: z.enum(["allow", "deny"]), requestHash: z.string().length(64),
});
/** Human owner-local acknowledgement only; never an executable bot proposal or a claim of success. */
export const ReconcileUncertaintySchema=z.strictObject({hostId:IdSchema,clientRequestId:IdSchema,
  expectedRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  decision:z.literal("release_hold"),acknowledgement:z.literal("effect_may_have_occurred"),
  requestHash:z.string().regex(/^[a-f0-9]{64}$/).optional()});
export const BotCommunicationConfirmationSchema = z.strictObject({
  actionId: IdSchema, requestHash: z.string().regex(/^[a-f0-9]{64}$/), clientRequestId: IdSchema,
  text: z.string().min(1).max(80),
});
export const BotCommunicationReceiptSchema = z.strictObject({
  actionId: IdSchema, requestHash: z.string().regex(/^[a-f0-9]{64}$/), clientRequestId: IdSchema.nullable(),
  decision: z.enum(["allow", "deny"]), applied: z.boolean(),
  previousRevision: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
  changes: z.strictObject({canSeeBots:z.boolean().optional(),canSendActions:z.boolean().optional(),canReceiveOrders:z.boolean().optional()}),
  appliesNextTurn: z.literal(true),
});
export type BotCommunicationReceipt = z.infer<typeof BotCommunicationReceiptSchema>;
export const BotCommunicationConfirmationResultSchema = z.strictObject({
  action: ActionSchema, bot: BotSchema, messages: z.array(MessageRecordSchema).length(2), receipt: BotCommunicationReceiptSchema,
});
export type BotCommunicationConfirmationResult = z.infer<typeof BotCommunicationConfirmationResultSchema>;

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
    "bot.created", "bot.updated", "thread.created", "message.appended", "grant.changed",
    "device.registered", "device.seen", "device.revoked", "device.renamed", "action.created", "action.decided",
    "action.started", "action.succeeded", "action.blocked", "action.unknown",
  ]),
  botId: IdSchema.nullable(), threadId: IdSchema.nullable(), entityId: IdSchema, createdAt: TimestampSchema, audience:z.enum(["private","group"]).optional(),groupId:IdSchema.nullable().optional(),groupConversationId:IdSchema.nullable().optional(),
});
export const EventRecordSchema = EventSchema.extend({ cursor: z.number().int().positive() });
export type HostEvent = z.infer<typeof EventRecordSchema>;

export const StartTurnSchema = z.strictObject({
  clientRequestId: IdSchema, content: AppendMessageSchema.shape.content, attachmentIds: AttachmentIdsSchema.optional(),
});
export const TurnSchema = z.strictObject({
  cursor: z.number().int().positive(), id: IdSchema, threadId: IdSchema, botId: IdSchema,
  selection: EngineSelectionSchema.optional(),
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

/** Owner-local durable automations; timestamps are epoch milliseconds, never an engine clock. */
const AutomationEpochSchema=z.number().int().min(0).max(8_640_000_000_000_000);
export const AutomationWhenSchema=z.discriminatedUnion("kind",[
  z.strictObject({kind:z.literal("once"),at:AutomationEpochSchema}),
  z.strictObject({kind:z.literal("interval"),everyMs:z.number().int().min(60_000).max(2_592_000_000),firstAt:AutomationEpochSchema}),
  z.strictObject({kind:z.literal("cron"),expression:z.string().min(9).max(128),timeZone:z.string().min(1).max(100)}),
]);
export type AutomationWhen=z.infer<typeof AutomationWhenSchema>;
const AutomationHost={hostId:IdSchema};
const AutomationMutation={...AutomationHost,clientRequestId:IdSchema,expectedRevision:z.number().int().positive()};
const AutomationDefinition={title:z.string().trim().min(1).max(160),content:AppendMessageSchema.shape.content.min(1).max(32_768).refine(v=>v.trim().length>0,"Automation instructions are required."),when:AutomationWhenSchema};
const AutomationScheduleCursorSchema=z.strictObject({createdAt:AutomationEpochSchema,id:IdSchema});
const AutomationOccurrenceCursorSchema=z.strictObject({scheduleId:IdSchema,scheduledAt:AutomationEpochSchema});
export const AutomationCreateSchema=z.strictObject({...AutomationMutation,expectedRevision:z.literal(0),botId:IdSchema,threadId:IdSchema,...AutomationDefinition});
export const AutomationUpdateSchema=z.strictObject({...AutomationMutation,...AutomationDefinition});
export const AutomationStateSchema=z.strictObject({...AutomationMutation,state:z.enum(["active","disabled"])});
export const AutomationRunSchema=z.strictObject(AutomationMutation);
export const AutomationListSchema=z.strictObject({...AutomationHost,botId:IdSchema.optional(),limit:z.number().int().min(1).max(500).optional(),after:AutomationScheduleCursorSchema.optional()});
export const AutomationHistorySchema=z.strictObject({...AutomationHost,botId:IdSchema.optional(),scheduleId:IdSchema.optional(),limit:z.number().int().min(1).max(500).optional(),after:AutomationOccurrenceCursorSchema.optional()});
export const AutomationCalendarSchema=z.strictObject({...AutomationHost,botId:IdSchema.optional(),from:AutomationEpochSchema,to:AutomationEpochSchema,limit:z.number().int().min(1).max(1000).optional()}).refine(v=>v.to>v.from&&v.to-v.from<=42*86_400_000,"Calendar window must be at most 42 days.");
export const AutomationPreviewSchema=z.strictObject({...AutomationHost,when:AutomationWhenSchema,after:AutomationEpochSchema.optional(),count:z.number().int().min(1).max(8).optional()});

export const ContractSchemas = {
  ...GroupContractSchemas,
  botCommunicationPatch:BotCommunicationPatchSchema,botCommunicationConfirmation:BotCommunicationConfirmationSchema,
  botCommunicationReceipt:BotCommunicationReceiptSchema,botCommunicationConfirmationResult:BotCommunicationConfirmationResultSchema,
  automationCreate:AutomationCreateSchema,automationUpdate:AutomationUpdateSchema,automationState:AutomationStateSchema,automationRun:AutomationRunSchema,automationList:AutomationListSchema,automationHistory:AutomationHistorySchema,automationCalendar:AutomationCalendarSchema,automationPreview:AutomationPreviewSchema,
  botExecutionAccess:BotExecutionAccessSchema,setBotExecutionAccess:SetBotExecutionAccessSchema,botExecutionAccessReceipt:BotExecutionAccessReceiptSchema,
  botApprovalPolicy:BotApprovalPolicySchema,setBotApprovalPolicy:SetBotApprovalPolicySchema,botApprovalPolicyReceipt:BotApprovalPolicyReceiptSchema,
  bot: BotSchema, patchBot: PatchBotSchema, botDelegation: BotDelegationSchema,avatarImage:AvatarImageSchema,uploadAvatarImage:UploadAvatarImageSchema,
  team:TeamSchema,createTeam:CreateTeamSchema,patchTeam:PatchTeamSchema,teamThread:TeamThreadSchema,
  liveVoiceSettings:LiveVoiceSettingsSchema,patchLiveVoiceSettings:PatchLiveVoiceSettingsSchema,
  browserUseSettings:BrowserUseSettingsSchema,patchBrowserUseSettings:PatchBrowserUseSettingsSchema,browserUseBotPolicy:BrowserUseBotPolicySchema,
  liveVoiceContext:LiveVoiceContextSchema,liveVoiceTranscript:LiveVoiceTranscriptSchema,liveVoiceTranscriptReceipt:LiveVoiceTranscriptReceiptSchema,
  skillLock:SkillLockSchema,registerSkill:RegisterSkillSchema,setSkillActivation:SetSkillActivationSchema,skillActivation:SkillActivationSchema,
  engineSelection: EngineSelectionSchema, threadEngineSelection: ThreadEngineSelectionSchema,
  thread: ThreadSchema, message: MessageRecordSchema, imageAttachment:ImageAttachmentSchema, uploadImageAttachment:UploadImageAttachmentSchema, action: ActionSchema,
  grant: GrantSchema, device: DeviceSchema, deviceView: DeviceViewSchema, renameDevice: RenameDeviceSchema, event: EventRecordSchema,
  startTurn: StartTurnSchema, turn: TurnSchema, turnEvent: TurnEventSchema, reconcileUncertainty: ReconcileUncertaintySchema,
};
export function exportContracts(): Record<string, unknown> {
  return Object.fromEntries(Object.entries(ContractSchemas).map(([name, schema]) => [name, z.toJSONSchema(schema)]));
}

export * from './bot-memory.js';

export { McpRegistrationRequestSchema, McpRegistrationReceiptQuerySchema, McpRegistrationReceiptSchema,
  type McpRegistrationAuthority, type McpRegistrationReceipt, type McpRegistrationReceiptState, type McpRegistrationJournalStatus } from "./mcp-receipts.js";

// Root-owned MCP instance selection contract overlay.
export { McpInstanceSelectionInputSchema, McpInstanceSelectionTargetSchema, McpInstanceSelectionPlanSchema, McpInstanceSelectionStepSchema, McpInstanceSelectionJournalSchema, type McpInstanceSelectionPlan, type McpInstanceSelectionTarget, type McpInstanceSelectionStep, type McpInstanceSelectionJournal } from "./mcp-instance-selection.js";

export * from './groups.js';

export * from './memory-learning.js';
export * from './native-voice.js';
// UX-P1-09 app connections (owner-loopback contract + trusted service contract).
export * from "./connections.js";
export * from "./connections-platform.js";
// Owner-private configuration of the connections service (metadata only; the capability never crosses this contract).
export * from "./connections-configuration.js";
// Output folders of a base: general / Bots/<id> / Times/<id> (owner-loopback contract).
export * from "./output-files.js";
// Owner pairing offer: owner-loopback private contract (deliberately not part of exportContracts()).
export * from "./owner-pairing-offer.js";
// Owner review of app-client claims: owner-loopback private contract (deliberately not part of exportContracts()).
export * from "./owner-pairing-claims.js";
export * from './own-document-automation.js';
