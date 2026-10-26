import { createHash } from "node:crypto";
import { ConnectionWorkflowRequestSchema } from "@dexter/contracts";
import type { connectionWorkflows } from "./connection-workflows.js";
import type { McpResultArtifacts } from "@dexter/context";
import { AutomaticOwnDocumentInputSchema, readEngineCatalogDiagnostics, McpInstanceSelectionPlanSchema, McpAuthorizationHandoffInputSchema, McpAuthorizationHandoffSchema, MCP_AUTHORIZATION_HANDOFF_TTL_MS, AppendBotMemoryNoteSchema, MEMORY_NOTE_MAX_CHARACTERS, BOT_EXECUTION_ACCESS_REGISTRY, EngineSelectionSchema, PatchBotSchema, BotAvatarAppearanceSchema, MAX_BOT_AVATAR_APPEARANCE_JSON_BYTES, BotCommunicationPatchSchema, LIVE_VOICES, RegisterSkillSchema, mcpSetupDiagnostic, type McpSetupStage, type Action, type Bot, type EngineCatalogEntry, type JsonValue, type OwnerSkillScope, type SetSkillActivation } from "@dexter/contracts";
import { checkMcpDefinition, normalizeMcpHttpRegistration, looksSecret, mcpSetupCanonicalJSON, mcpSetupHash, McpConnectorError, type McpServerDefinition, type McpServerSummary, type McpToolSummary, type NativeMcpAdmin } from "@dexter/connectors";
import { APP_CONFIGURATION_GUIDE_PAGES, ContextError, HARNESS_GUIDE_TOPICS, readAppConfigurationGuidePage, readHarnessGuideTopic } from "@dexter/context";
import { GatewayError, MCP_AUTHORIZED_INVENTORY_LIMIT, type ArgumentSchema, type ScalarSchema, type CapabilityScope, type GatewayCallResult, type InputSchema, type ToolView, type TurnToolSurface } from "@dexter/gateway";
import { canonicalJson, dispatchAction, HostError, type TrustedApprovalEligibility, type ConversationRuntime, type HostStore } from "@dexter/hub";
import type { HostBotDocumentsPort, HostSkillsPort } from "@dexter/hub/http";
import { mcpRegistrationAction, validateMcpActionReceipt, recoverMcpRegistration } from "./mcp-registration-wiring.js";
import { isWellFormedText } from "./text-input.js";
import type { BotWorkspaceToolsPort, WorkspaceOwner } from "./bot-workspace-tools.js";
import { MAC_SETUP_CUA_OPERATIONS, MAC_SETUP_HANDOFF_TTL_MS, MacSetupHandoffInputSchema, MacSetupHandoffSchema,
  MacSetupStatusSchema, type DeviceConversationRoute, type MacSetupStatus } from "@dexter/contracts";

/** Reserved host-owned route. This is never an account, remote endpoint or an engine-selected router. */
export const HARNESS_OPERATION_DESTINATION = "dexter-harness-owner-proposals";
const PREFIX = "dexter.harness.";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
type Values = Record<string, JsonValue>;
type Proposal = { input: Values; pin: Values };
interface Capability { token: string; scope: Readonly<CapabilityScope>; controllers: Set<AbortController>; baseTargets: ReadonlySet<string>; ownerApproved?: boolean; ownerActionId?: string }
interface Definition { name: string; description: string; inputSchema: InputSchema; write: boolean; mcp?: boolean; documents?: boolean; workspace?: boolean }
// Classification comes only from this host-owned declaration, never a call field or a dexter.* prefix.
const approvalEligibility = (definition: Definition,input?:Values): TrustedApprovalEligibility | undefined =>
  definition.name==='memory.append' || definition.name==='documents.update' && input!==undefined && AutomaticOwnDocumentInputSchema.safeParse(input).success
    ? 'own_documents' : BOT_EXECUTION_ACCESS_REGISTRY.find(item=>item.destination===HARNESS_OPERATION_DESTINATION && item.tool===PREFIX+definition.name)?.operation as "terminal" | "cli" | "files_write" | undefined;
const string = (maxLength: number, pattern?: string): ScalarSchema => ({ type: "string", minLength: 1, maxLength, ...(pattern ? { pattern } : {}) });
const text = (maxLength: number): ScalarSchema => ({ type: "string", minLength: 0, maxLength });
const revision: ScalarSchema = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 };
const integer = (minimum: number, maximum: number): ScalarSchema => ({ type: "integer", minimum, maximum });
const path = string(1024);
const id = string(128, "^[A-Za-z0-9_-]+$");
const version = string(64, "^\\d+\\.\\d+\\.\\d+$");
const schema = (properties: Record<string, ArgumentSchema>, required: string[] = []): InputSchema => ({ type: "object", properties, required, additionalProperties: false });
const definitions: Definition[] = [
  {name:"results.artifact.read",write:false,description:"Read a bounded page of an already sanitized overflowing MCP receipt artifact from your own bot/conversation, with hash and original TTL. Does not fetch links or capture memory.",inputSchema:schema({artifact_id:id,offset:revision},["artifact_id"])},
  {name:"results.artifact.remove",write:true,description:"Ask the owner to remove an ephemeral MCP result artifact of your own bot/conversation. This grants no tool/account access and does not undo the upstream effect.",inputSchema:schema({artifact_id:id},["artifact_id"])},
  {name:"connections.catalog",write:false,description:"Read the managed app gallery for this host. This does not confirm account login or grant access.",inputSchema:schema({})},
  {name:"connections.request_status",write:false,description:"Read your own durable setup request in this conversation. Pending login/grants are distinct from turn admission. Never repost after uncertainty.",inputSchema:schema({request_id:id},["request_id"])},
  {name:"connections.request",write:true,description:"Ask the owner to connect a managed app for this original task. Supply request_json with clientRequestId UUID, expectedBotRevision, target {kind:managed,serviceId,catalogPin} from connections.catalog. Exact owner approval creates a bounded setup navigation receipt only. No OAuth, secrets or grants are performed; human selects exact accounts/tools and may continue this task once. Stop, expiry or drift refuses late continuation.",inputSchema:schema({request_json:string(2048)},["request_json"])},
  { name: "status", write: false, description: "Read your own bot, model selection, effective skill pins and selected MCP tools. No secrets, other bots or personal configuration are returned.", inputSchema: schema({}) },
  { name: "mac.setup.status", write: false, description: "Read passive own Mac route publication, frozen turn admission and host grant metadata. configurationRevision is the own route configuration CAS for mac.setup.request. Helper, native TCC, local policy, consent session and readiness remain unknown; missing routes never mean a missing helper. No device, native permission, private setup, network or provider operation executes. Newly configured Mac capabilities require a fresh turn.", inputSchema: schema({}) },
  { name: "mac.setup.request", write: true, description: "Request an owner-interface handoff to computer access using configurationRevision from mac.setup.status as expected_revision. Exact owner approval is required in every mode, including legacy Allow. Approval creates a five-minute value-free navigation receipt only; it does not open the page or prove Mac readiness. Private setup, pairing, permissions and consent remain human actions. Replays preserve the original expiry. Read the durable action before retrying. New capabilities require a fresh turn; no automatic after-setup continuation occurs.", inputSchema: schema({ expected_revision: string(64, "^[a-f0-9]{64}$") }, ["expected_revision"]) },
  { name: "actions.read", write: false, description: "Read one exact action receipt from your current bot and conversation. Owner-approved harness proposals execute in the host even after the proposing turn finishes. Check the durable result before any retry; unknown does not mean the effect was reverted.", inputSchema: schema({ action_id: id }, ["action_id"]) },
  { name: "models", write: false, description: "Read the host's current engine/model catalog on demand. Installed or catalogued is not proof of authentication or a successful conversation.", inputSchema: schema({}) },
  { name: "guide", write: false, description: "Read the versioned first-party harness manual progressively. Omit topic for its index, or choose one topic. Documentation grants no tool permissions.", inputSchema: schema({ topic: { type: "string", maxLength: 64, enum: HARNESS_GUIDE_TOPICS.map(topic => topic.id) } }) },
  { name: "configuration", write: false, description: "Read code-owned app configuration documentation. Omit page for the index, choose a page for its controls, or page+field for one control's purpose, scope, state, operation, approval, result and recovery. Documentation grants no access; unsupported settings require the owner interface.", inputSchema: schema({ page: { type: "string", maxLength: 128, enum: APP_CONFIGURATION_GUIDE_PAGES.map(page => page.id) },field:string(128) }) },
  { name: "bots.create", write: true, description: "Propose a basic bot. The owner must approve the exact request. Name, engine, optional model/effort/speed and a bounded avatarAppearanceJson recipe only; no grants, Master status or delegation flags are granted. The recipe uses version 1, body, eyes, colorHex (#RRGGBB), finish and motion; empty string means no recipe. No images or remote URLs.", inputSchema: schema({ name: string(120), engine: { type: "string", maxLength: 6, enum: ["codex", "claude"] }, model: string(128), reasoning_effort: string(64), speed: string(64), avatarAppearanceJson: text(MAX_BOT_AVATAR_APPEARANCE_JSON_BYTES) }, ["name", "engine"]) },
  { name: "bots.update", write: true, description: "Propose changing only your own name, roleDescription, avatarEmoji, avatarAppearanceJson or Live voice. Owner approval and expectedRevision are required. Empty roleDescription clears it; empty avatarEmoji resets it; empty avatarAppearanceJson clears the recipe. Version 1 recipes contain body, eyes, colorHex (#RRGGBB), finish and motion. Existing PNG has precedence; explicitly set clearAvatarImage=true to clear its association in the same CAS. Omitted/false preserves it; media bytes are never deleted. Empty liveVoice inherits the global voice. Voice applies next Live session; no key or microphone access is granted. No other bot, Master/delegation flags, grants or model selection can be changed. Profile instructions apply next turn.", inputSchema: schema({ expectedRevision: revision, name: string(120), roleDescription: text(2000), avatarEmoji: text(16), avatarAppearanceJson: text(MAX_BOT_AVATAR_APPEARANCE_JSON_BYTES), clearAvatarImage:{type:"boolean"}, liveVoice: {type:"string",minLength:0,maxLength:32,enum:["",...LIVE_VOICES]} }, ["expectedRevision"]) },
  { name: "bots.communication.update", write: true, description: "Propose changing your own canSeeBots, canSendActions or canReceiveOrders. At least one boolean and the current expectedRevision are required. This tool remains available when those flags are disabled. The exact owner approval is always required, by Permitir/Negar or one literal chat confirmation bound to the visible proposal. The host applies it atomically even after the proposing turn finishes; read the action receipt. Effective tools change next turn. No other bot, Master status, grants or peer permissions are changed.", inputSchema: schema({ expectedRevision: revision, canSeeBots: {type:"boolean"}, canSendActions: {type:"boolean"}, canReceiveOrders: {type:"boolean"} }, ["expectedRevision"]) },
  { name: "documents.read", write: false, documents: true, description: "Read only your own SOUL.md, USER.md and MEMORY.md with their shared revision. This returns the live stored documents; the running model context retains its already pinned snapshot until the next turn.", inputSchema: schema({}) },
  { name: "documents.update", write: true, documents: true, description: "Save one of your own SOUL, USER or MEMORY documents in this private conversation. Nonempty direct notes save automatically under the host's narrow own-document default; explicit ask/deny/expired permissions are preserved. expectedRevision and exact three-document pins are required; preserve unrelated text. Empty or whitespace markdown clears only that document and always needs exact owner approval. No secrets, other bot IDs or authority changes. Applies next turn; conflicts require a fresh read, never automatic retry.", inputSchema: schema({ expectedRevision: revision, document: { type: "string", maxLength: 6, enum: ["SOUL", "USER", "MEMORY"] }, markdown: text(8192), sourceReference:text(512) }, ["expectedRevision", "document", "markdown"]) },
  { name: "memory.history", write: false, documents: true, description: "Read canonical own MEMORY revisions with verified pins and host-derived provenance. Limit 1–50, default 20; before is a non-secret rN cursor. Git orphans are excluded. Declared source references are not proof of truth.", inputSchema: schema({limit:integer(1,50),before:string(17,"^r[1-9][0-9]{0,15}$")}) },
  { name: "memory.read_revision", write: false, documents: true, description: "Read one verified immutable own MEMORY revision. This does not replace the engine snapshot of an open turn.", inputSchema: schema({revision:integer(1,Number.MAX_SAFE_INTEGER-1)},["revision"]) },
  { name: "memory.receipt", write: false, documents: true, description: "Read the Context effect receipt of one exact own document action from this conversation, even when dispatcher outcome is unknown. Reading never repeats a mutation.", inputSchema: schema({action_id:id},["action_id"]) },
  { name: "memory.append", write: true, documents: true, description: "Append one direct literal note to your own MEMORY in this private conversation. Saves automatically under the host's bounded own-document default regardless of chat approval mode; explicit ask/deny/expired permissions are preserved. Strict expectedRevision and note (1–2048 UTF-16 characters). Host derives identity/provenance and pins the aggregate revision and three hashes. Preserves SOUL, USER and existing text. Exact duplicates create an already_present receipt, without semantic normalization. Applies next turn. After uncertainty read memory.receipt with the original action_id, never automatically retry. No background capture, dreaming, provider spending, permission change or other bot access.", inputSchema: schema({expectedRevision:revision,note:string(MEMORY_NOTE_MAX_CHARACTERS)},["expectedRevision","note"]) },
  { name: "memory.restore", write: true, documents: true, description: "Propose restoring one own MEMORY revision into a new aggregate revision with restoredFrom and a host-derived source. Exact owner approval always required, including Approve all. expectedRevision must match current head; SOUL/USER and all authority remain current. After ambiguity use memory.receipt with the original action ID, never propose an automatic retry.", inputSchema: schema({expectedRevision:revision,fromRevision:integer(1,Number.MAX_SAFE_INTEGER-1),sourceReference:text(512)},["expectedRevision","fromRevision"]) },
  { name: "terminal.status", write: false, workspace: true, description: "Read your own workspace and installed supported terminal runtimes and gh/python3 command tools without spawning a command. Metadata availability never proves login. Commands use the host user's operating-system permissions without automatic elevation; workspace cwd is not an OS sandbox. No account credentials or executable paths are returned.", inputSchema: schema({}) },
  { name: "terminal.run", write: true, workspace: true, description: "Propose one bash, zsh or sh shell command, or bun JavaScript evaluated by bun -e, with optional relative workspace cwd and a bounded timeout. Commands require exact owner approval in Ask, Accept edits and Approve all modes; the human-selected Full access policy may dispatch only commands eligible under an existing grant. Modes do not create access or bypass private gates. Commands have the host owner's OS permissions; cwd is not a sandbox. No secret values are accepted. Read the receipt before proposing any retry after an unknown or failed result.", inputSchema: schema({ runtime: { type: "string", maxLength: 4, enum: ["bash", "zsh", "sh", "bun"] }, command: string(8192), cwd: path, timeout_ms: integer(1,30000) }, ["runtime", "command"]) },
  { name: "cli.run", write: true, workspace: true, description: "Propose gh or python3 using literal argument strings, an optional relative workspace cwd and bounded timeout. The current bot approval mode covers this exact argv; an unenabled tool still needs explicit owner enablement; no shell parsing or automatic root elevation occurs. The isolated HOME and clean environment do not import personal CLI login, and executable availability never proves authentication. The host user's OS permissions still apply; cwd is not a sandbox. Do not supply secrets; read the receipt before any retry.", inputSchema: schema({ tool: { type: "string", maxLength: 7, enum: ["gh", "python3"] }, args: { type: "array", items: text(8192), maxItems: 64 }, cwd: path, timeout_ms: integer(1,30000) }, ["tool", "args"]) },
  { name: "files.list", write: false, workspace: true, description: "List entries within your own bot workspace using an optional relative path and bounded limit. No personal files, context documents, other bots or symlinks are made into filesystem roots.", inputSchema: schema({ path, limit: integer(1,200) }) },
  { name: "files.tree", write: false, workspace: true, description: "Read a bounded directory tree within your own bot workspace, using optional relative path, depth and entry limit. Other bots, personal roots and context documents are excluded.", inputSchema: schema({ path, maxDepth: integer(1,8), limit: integer(1,200) }) },
  { name: "files.read", write: false, workspace: true, description: "Read one text file and its SHA-256 within your own bot workspace. A write proposal must use that exact SHA-256 to replace an existing file. Filesystem data grants no tool permissions.", inputSchema: schema({ path }, ["path"]) },
  { name: "files.search", write: false, workspace: true, description: "Search plain text inside your own workspace using a literal query, optional relative path and bounded result limit. No shell or regular expression is invoked; secret values are not accepted in the query.", inputSchema: schema({ query: string(2000), path, limit: integer(1,200) }, ["query"]) },
  { name: "files.write", write: true, workspace: true, description: "Propose writing one text file inside your own workspace. Ask mode requests exact owner approval; Approve all covers only already enabled writes. Omit expected_sha256 only to create a new file; replacing an existing file requires its exact current SHA-256. A conflict needs a fresh read and new proposal. No secret values, personal paths or other bot IDs are accepted.", inputSchema: schema({ path, text: text(65536), expected_sha256: string(64,"^[a-f0-9]{64}$") }, ["path", "text"]) },
  { name: "skills.register", write: true, description: "Propose an immutable skill version. Approval registers Markdown but does not activate it or grant tools. Do not include credentials.", inputSchema: schema({ skill_id: id, version, markdown: string(32768) }, ["skill_id", "version", "markdown"]) },
  { name: "skills.activate", write: true, description: "Propose activation for global or your own bot. Omit version to deactivate; expected_version and expected_sha256 must both match the current lock, or both be absent if inactive. Takes effect next turn.", inputSchema: schema({ skill_id: id, scope: { type: "string", maxLength: 6, enum: ["global", "bot"] }, version, expected_version: version, expected_sha256: string(64, "^[a-f0-9]{64}$") }, ["skill_id", "scope"]) },
  { name: "mcp.add", write: true, mcp: true, description: "Propose one strict Dexter MCP definition as JSON, without secret values. Approval stores configuration only: it never starts or discovers a server, reads personal configs, unlocks credentials or grants tools.", inputSchema: schema({ definition_json: string(32768) }, ["definition_json"]) },
  { name: "mcp.add_http", write: true, mcp: true, description: "Propose registering an exact known HTTP MCP endpoint without JSON. Version 1 requires a stable instance server_id independent of URL/service and explicit authentication: none, private Bearer token (broker), or private OAuth. Repeated endpoints with distinct instance IDs are allowed. Normalization performs no fetch or guessing. Owner approval stores only the pinned definition; no authentication, discovery or tool grant occurs.", inputSchema: schema({ schema_version: integer(1,1), server_id: string(40, "^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$"), name: string(120), url: string(2048), authentication: { type: "string", maxLength: 6, enum: ["none", "broker", "oauth"] } }, ["schema_version", "server_id", "name", "url", "authentication"]) },
  { name: "mcp.registration_receipt", write: false, mcp: true, description: "Read the native effect receipt of one exactly approved own registration action from this conversation, including unknown dispatcher outcomes. The host derives the original turn/action/call identity. Query returns registered/removed/replaced history, never registers, authenticates, discovers or grants access. Unknown Hub state is preserved; never repost to recover.", inputSchema: schema({ action_id: id }, ["action_id"]) },
  { name: "mcp.registration_journal_status", write: false, mcp: true, description: "Read aggregate native registration journal capacity for this admitted installation: used/limit4096/remaining. Does not enumerate other origins, imply authentication or grant access. Full keeps prior receipts and refuses new registration; no purge or automatic retry exists.", inputSchema: schema({}) },
  { name: "mcp.inspect", write: false, mcp: true, description: "Read bounded setup metadata and tool catalog for a reachable selected own connection, or supply a succeeded own approved registration/discovery action_id from this thread. Receipt identity must match the current definition. No other bot, endpoint, custody or credential is returned; reading never connects, unlocks or discovers. Tool selection applies next turn.", inputSchema: schema({ server_id: string(40, "^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$"), action_id: string(128) }, ["server_id"]) },
  { name: "mcp.authorize", write: true, mcp: true, description: "Request an owner-only OAuth setup handoff for one reachable own HTTP OAuth instance. Read mcp.inspect for its current instance_pin and supply expected_instance_pin; an own succeeded registration/discovery action_id can establish reachability. Exact owner approval is always required, in every chat mode. Approval produces a five-minute value-free receipt for the active owner interface to open the connection page and begin its private login flow. This tool never starts OAuth, fetches metadata, reads credentials or authorizes/selects tools. Login and consent remain with the user in their browser. Replays retain the original receipt and expiry; historical receipts cannot open a new flow.", inputSchema: schema({ server_id: string(40, "^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$"), expected_instance_pin: string(64,"^[a-f0-9]{64}$"), action_id: id }, ["server_id","expected_instance_pin"]) },
  { name: "mcp.discover", write: true, mcp: true, description: "Propose discovery of an existing MCP server. Only after owner approval may the pinned endpoint/program be contacted or started. Authentication remains in owner settings; discovery grants no tools.", inputSchema: schema({ server_id: string(40, "^[a-z][a-z0-9-]*$") }, ["server_id"]) },
  { name: "mcp.instance_selection", write: false, mcp: true, description: "Read your own profile's connected native instances and current selection revision/pins. Instance IDs and generations identify configuration, not an authenticated external account. No endpoint, labels, tokens or implicit selection.", inputSchema: schema({}) },
  { name: "mcp.instance_selection_catalog", write: false, mcp: true, description: "Read exact publishable tool IDs of one connected native instance in your own profile, without discovery or authentication.", inputSchema: schema({server_id: string(40)}, ["server_id"]) },
  { name: "mcp.instance_selection_plan", write: false, mcp: true, description: "Materialize a reviewed explicit list of instances/tools using expected inventory/selection pins and revision. all_connected must explicitly list every connected eligible instance now; no wildcard or future inclusion. This read creates no grants.", inputSchema: schema({selection_json: string(32768)}, ["selection_json"]) },
  { name: "mcp.instance_selection_receipt", write: false, mcp: true, description: "Read the original own approved instance-selection receipt after partial failure, lost acknowledgement or restart. Never resumes grants or repeats selection. Historical phase and current association remain separate.", inputSchema: schema({action_id: id}, ["action_id"]) },
  { name: "mcp.select_instances", write: true, mcp: true, description: "Propose an exact materialized instance/tool selection plan from your own capability. Owner approval is mandatory; only ask for added tools, deny only removed destinations, no auth/discovery or future accounts. Partial operation must be read, never reposted to repair grants.", inputSchema: schema({plan_json: string(32768)}, ["plan_json"]) },
  { name: "mcp.select", write: true, mcp: true, description: "Propose replacing MCP tool selection for your own bot, using exact tool IDs from the current discovered catalog. Approval grants only ask, never allow. New tools are available next turn.", inputSchema: schema({ server_id: string(40, "^[a-z][a-z0-9-]*$"), tool_ids: { type: "array", items: string(128), maxItems: 256 } }, ["server_id", "tool_ids"]) },
];
function fail(code: "invalid_input" | "forbidden" | "conflict" | "unauthorized" | "unavailable"): never { throw new GatewayError(code, `Harness operation refused: ${code}.`); }
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
function avatarAppearanceInput(value:unknown):JsonValue {
  if(typeof value!=="string"||Buffer.byteLength(value,"utf8")>MAX_BOT_AVATAR_APPEARANCE_JSON_BYTES)fail("invalid_input");
  if(value==="")return null;
  let decoded:unknown;
  try{decoded=JSON.parse(value);}catch{fail("invalid_input");}
  const parsed=BotAvatarAppearanceSchema.safeParse(decoded);
  if(!parsed.success)fail("invalid_input");
  return json(parsed.data);
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail("invalid_input");
const rawTool = (value: unknown): string => value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string,unknown>).tool === "string"
  ? (value as {tool:string}).tool : "";
const same = (a: JsonValue, b: JsonValue): boolean => canonicalJson(a) === canonicalJson(b);
const project = (action: Action): GatewayCallResult => ({ actionId: action.id, status: action.state, requestHash: action.requestHash, reason: action.reason, result: action.result });
const botView = (bot: Bot): Values => ({ id: bot.id, name: bot.name, roleDescription: bot.roleDescription, avatarEmoji: bot.avatarEmoji, liveVoice: bot.liveVoice ?? null,
  avatarAppearance:json(bot.avatarAppearance??null),avatarImageId:bot.avatarImage?.id??null,
  activeAvatarKind:bot.avatarImage?"image":bot.avatarAppearance?"appearance":bot.avatarEmoji?"emoji":"default",
  defaultSelection: json(bot.defaultSelection ?? { engine: bot.engine, model: null, reasoningEffort: null, speed: null }), revision: bot.revision,
  canSeeBots: bot.canSeeBots, canReceiveOrders: bot.canReceiveOrders, canSendActions: bot.canSendActions, isMaster: bot.isMaster });
const serverView = (server: McpServerSummary): Values => ({ id: server.id, name: server.name, transport: server.transport, runsOn: server.runsOn, auth: server.auth, status: server.status,
  ...(server.diagnostic ? { diagnostic: json(server.diagnostic) } : {}) });
const toolView = (tool: McpToolSummary): Values => ({ id: tool.id, name: credentialText(tool.name) ? "[redacted]" : tool.name.slice(0,128), effect: tool.effect, state: tool.state });
const mcpStage = (tool: string): McpSetupStage => tool.endsWith("mcp.add") || tool.endsWith("mcp.add_http") || tool.endsWith("mcp.registration_receipt") || tool.endsWith("mcp.registration_journal_status") ? "registration"
  : tool.endsWith("mcp.authorize") ? "authentication" : tool.endsWith("mcp.select") ? "selection" : tool.endsWith("mcp.discover") ? "discovery" : "configuration";
function mcpRefusal(code: "invalid_input" | "conflict" | "unavailable", cause: string, stage: McpSetupStage): never {
  throw new GatewayError(code, `MCP setup refused: ${code}.`, mcpSetupDiagnostic(stage,cause));
}
const lockView = (lock: { id: string; version: string; sha256: string }): Values => ({ id: lock.id, version: lock.version, sha256: lock.sha256 });
// Refuse obvious credential material before it can be persisted in an action or skill. Hash pins are separate fields.
const credentialText = (text: string): boolean => /(?:\b(?:sk-|sk_live_|sk_test_|github_pat_|gh[pousr]_|xox[abprs]-|glpat-|AIza|AKIA|ASIA|ya29\.)[A-Za-z0-9_+=./-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|passphrase)\s*[:=]\s*["']?(?:Bearer\s+)?[A-Za-z0-9_+=./-]{12,})/i.test(text);

export interface HarnessOperationOptions {
  store: HostStore;
  base: TurnToolSurface;
  catalog(): Promise<EngineCatalogEntry[]>;
  runtime(): ConversationRuntime;
  skills(): Readonly<HostSkillsPort>;
  /** Borrowed trusted port, never returned or routed directly to a model; calls are restricted to its host-derived bot. */
  documents?: () => Readonly<HostBotDocumentsPort>;
  /** Host-derived audience; team turns cannot read or mutate private bot documents/history. */
  privateMemoryTurn?: (turnId: string) => boolean;
  /** Read-only first-party memory diagnostics. No configuration, provider call or credentials. */
  memoryServiceStatus?: () => JsonValue;
  /** Trusted own-workspace facade; the model never supplies a bot ID or receives this port directly. */
  workspace?: () => Readonly<BotWorkspaceToolsPort>;
  /** Host-derived: false when this turn has no output namespace (group audience); file/terminal tools are then hidden and refused. */
  workspaceTurn?: (turnId: string) => boolean;
  effectiveSkills(turnId: string): Array<{ id: string; version: string; sha256: string }>;
  /** Owner-only accessor; no credential methods are exposed by this surface. */
  mcp?: () => Readonly<NativeMcpAdmin>;
  connections?:()=>ReturnType<typeof connectionWorkflows>;
  connectionCatalog?:()=>Promise<unknown>;
  resultArtifacts?:()=>McpResultArtifacts;
  /** Passive owner-local publication metadata only; no helper, device execution or native-consent port. */
  macSetupRoutes?: (botId: string) => readonly DeviceConversationRoute[] | undefined;
}

/**
 * First-party proposal facade. Identity is host-derived and every mutation is a durable owner-approved action.
 * It does not weaken generic gateway manifest restrictions or expose owner HTTP/admin ports to a model.
 */
export class HarnessOperationSurface implements TurnToolSurface {
  readonly #options: HarnessOperationOptions;
  readonly #capabilities = new Map<string, Capability>();
  readonly #calls = new Set<Promise<GatewayCallResult>>();
  readonly #executions = new Map<string, Promise<GatewayCallResult>>();
  readonly #ownerControllers = new Set<AbortController>();
  readonly #admissions = new Map<string, Set<string>>();
  #stopped = false;
  #closing: Promise<void> | null = null;
  constructor(options: HarnessOperationOptions) { this.#options = options; }

  issueCapability(input: { turnId: string; ttlMs?: number }): { token: string; scope: CapabilityScope } {
    if (this.#stopped) fail("unavailable");
    for (const [key, cap] of this.#capabilities) {
      try { this.#validate(cap); } catch { this.#remove(key, cap); }
    }
    for (const turnId of this.#admissions.keys()) if (this.#options.store.getTurn(turnId).state !== "running") this.#admissions.delete(turnId);
    if (this.#capabilities.size >= 128) fail("unavailable");
    const issued = this.#options.base.issueCapability(input);
    const cap: Capability = { token: issued.token, scope: Object.freeze({ ...issued.scope }), controllers: new Set(), baseTargets: new Set() };
    try {
      if (!TOKEN.test(issued.token) || issued.scope.turnId !== input.turnId) fail("unauthorized");
      this.#validate(cap);
      const baseViews = this.#options.base.listTools(issued.token);
      if (baseViews.length > MCP_AUTHORIZED_INVENTORY_LIMIT) fail("unavailable");
      cap.baseTargets = new Set(baseViews.map(view => `${view.connectionId}\0${view.name}`));
      this.#capabilities.set(sha(issued.token), cap);
      this.listTools(issued.token);
      return { token: issued.token, scope: { ...cap.scope } };
    } catch (error) { this.#capabilities.delete(sha(issued.token)); this.#options.base.revokeCapability(issued.token); throw error; }
  }
  #validate(cap: Capability, signal?: AbortSignal): void {
    const store = this.#options.store, scope = cap.scope;
    if (this.#stopped || signal?.aborted || scope.expiresAt <= store.now()) fail("unauthorized");
    // prepareMcpTurn already holds a writer transaction during issuance/listing. This readonly check must not BEGIN
    // a nested transaction, and still refuses the same closed, stolen, checkpointed or stale-epoch handle.
    store.assertActiveWriter();
    store.assertTeamTurn(scope.turnId);
    const turn = store.getTurn(scope.turnId), thread = store.getThread(scope.threadId), bot = store.getBot(scope.botId);
    if (cap.ownerActionId && store.ownerToolScope(cap.ownerActionId).turnId !== scope.turnId) fail("forbidden");
    if ((!cap.ownerApproved && turn.state !== "running") || turn.botId !== bot.id || turn.threadId !== thread.id || thread.botId !== bot.id
      || scope.installationId !== store.hostId || scope.ownerId !== store.ownerId || bot.ownerId !== scope.ownerId || bot.profileId !== scope.profileId) fail("unauthorized");
  }
  #resolve(token: string, signal?: AbortSignal): Capability {
    if (typeof token !== "string" || !TOKEN.test(token)) fail("unauthorized");
    const cap = this.#capabilities.get(sha(token)); if (!cap) fail("unauthorized");
    this.#validate(cap, signal); return cap;
  }
  listTools(token: string): ToolView[] {
    const cap = this.#resolve(token);
    // Newly selected tools are admitted only by a subsequent turn. Existing targets still pass live base policy.
    const views = this.#options.base.listTools(token).filter(view => cap.baseTargets.has(`${view.connectionId}\0${view.name}`));
    for (const definition of definitions) {
      if (definition.mcp && !this.#options.mcp) continue;
      if(definition.name.startsWith("connections.")&&(!this.#options.connections||!this.#options.store.isOwnDocumentTurnPrivate(cap.scope.turnId)))continue;
      if(definition.name.startsWith("results.artifact.")&&!this.#options.resultArtifacts)continue;
      if (definition.documents && (!this.#options.documents || this.#options.privateMemoryTurn?.(cap.scope.turnId) === false
        || !this.#options.store.isOwnDocumentTurnPrivate(cap.scope.turnId))) continue;
      if (definition.workspace && (!this.#options.workspace || this.#options.workspaceTurn?.(cap.scope.turnId) === false)) continue;
      const name = PREFIX + definition.name;
      const grant = definition.write || definition.workspace ? this.#options.store.getGrant(cap.scope.botId, name, HARNESS_OPERATION_DESTINATION) : null;
      // A DENY/expired grant is preserved; protected host operations still refuse legacy ALLOW.
      const ownDocument=['documents.update','memory.append'].includes(definition.name),macHandoff=definition.name==='mac.setup.request';
      if (grant && ((definition.write ? grant.policy !== "ask" && !((ownDocument || macHandoff) && grant.policy==='allow') : grant.policy === "deny")
        || grant.expiresAt !== null && grant.expiresAt <= this.#options.store.now())) continue;
      views.push({ name, connectionId: HARNESS_OPERATION_DESTINATION, connectionLabel: "Dexter owner-approved setup", description: definition.description,
        effect: definition.write ? "write" : "read", requiresApproval: definition.write && !(definition.name==='memory.append' && this.#options.store.ownDocumentAutomationStatus(cap.scope.botId).append==='automatic') && this.#options.store.actionRequiresApproval(cap.scope.botId, name, HARNESS_OPERATION_DESTINATION, approvalEligibility(definition),cap.scope.threadId), inputSchema: structuredClone(definition.inputSchema) });
    }
    if (views.length > MCP_AUTHORIZED_INVENTORY_LIMIT) fail("unavailable");
    return views;
  }
  call(token: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<GatewayCallResult> {
    let cap: Capability;
    try { cap = this.#resolve(token, options.signal); } catch (error) { return Promise.reject(error); }
    const controller = new AbortController();
    const abort = (): void => controller.abort(); options.signal?.addEventListener("abort", abort, { once: true });
    cap.controllers.add(controller);
    const operation = this.#call(cap, input, controller.signal).catch(error => {
      if (error instanceof GatewayError || error instanceof HostError && error.code === "host_locked") throw error;
      if (error instanceof McpConnectorError) {
        const invalid = ["invalid_definition", "invalid_request", "secret_refused", "endpoint_invalid", "endpoint_secret_refused"].includes(error.code);
        const conflict = ["server_exists", "busy", "store_conflict", "catalog_unavailable", "tool_changed"].includes(error.code);
        const tool = rawTool(input);
        mcpRefusal(invalid ? "invalid_input" : conflict ? "conflict" : "unavailable", error.code, mcpStage(tool));
      }
      throw new GatewayError("unavailable", "Harness operation unavailable.");
    });
    this.#calls.add(operation);
    const release = (): void => { this.#calls.delete(operation); cap.controllers.delete(controller); options.signal?.removeEventListener("abort", abort); };
    void operation.then(release, release);
    return operation;
  }
  async #call(cap: Capability, raw: unknown, signal: AbortSignal): Promise<GatewayCallResult> {
    if (this.#calls.size >= 64) fail("unavailable");
    const call = object(raw);
    if (call.connectionId !== HARNESS_OPERATION_DESTINATION) {
      if (typeof call.connectionId !== "string" || typeof call.tool !== "string" || !cap.baseTargets.has(`${call.connectionId}\0${call.tool}`)) fail("forbidden");
      return this.#options.base.call(cap.token, raw, { signal });
    }
    if (Object.keys(call).sort().join(",") !== "arguments,callId,connectionId,tool" || typeof call.callId !== "string" || !CALL_ID.test(call.callId)
      || typeof call.tool !== "string") fail("invalid_input");
    const definition = definitions.find(item => PREFIX + item.name === call.tool);
    if (definition?.mcp && !this.#options.mcp) mcpRefusal("unavailable", "native_mcp_disabled", "host");
    if (!definition || !this.listTools(cap.token).some(view => view.name === call.tool && view.connectionId === HARNESS_OPERATION_DESTINATION)) fail("forbidden");
    const args = this.#arguments(definition, call.arguments);
    if (!definition.write) {
      const data = definition.name === "models" ? await this.#models() : definition.name === "guide"
        ? json(args.topic === undefined ? { topics: HARNESS_GUIDE_TOPICS } : readHarnessGuideTopic(args.topic as string))
        : definition.name === "configuration" ? this.#configurationGuide(args)
        : definition.name === "documents.read" ? { documents: json({...this.#options.documents!().read(cap.scope.botId),automation:this.#options.store.ownDocumentAutomationStatus(cap.scope.botId)}), appliesNextTurn: true }
        : definition.name === "memory.history" ? json(this.#options.documents!().history(cap.scope.botId,args))
        : definition.name === "memory.read_revision" ? json(this.#options.documents!().readRevision(cap.scope.botId,args.revision as number))
        : definition.name === "memory.receipt" ? this.#readMemoryReceipt(args.action_id as string,cap)
        : definition.name === "actions.read" ? json(this.#readAction(args.action_id as string, cap))
        : definition.name === "mcp.registration_receipt" ? this.#registrationReceipt(args,cap)
        : definition.name === "mcp.registration_journal_status" ? json(this.#options.mcp!().registrationJournalStatus({ installationId: cap.scope.installationId, ownerId: cap.scope.ownerId, origin: {kind:"owner_local"} }))
         : definition.name === "mcp.instance_selection" ? json(this.#options.mcp!().instanceSelectionReview(cap.scope.botId))
        : definition.name === "mcp.instance_selection_catalog" ? this.#instanceCatalog(args,cap)
        : definition.name === "mcp.instance_selection_plan" ? json(this.#options.mcp!().materializeInstanceSelection(cap.scope.botId,JSON.parse(args.selection_json as string)))
        : definition.name === "mcp.instance_selection_receipt" ? this.#instanceSelectionReceipt(args,cap)
        : definition.name === "mcp.inspect" ? this.#inspectMcp(args,cap)
        : definition.name === "connections.catalog" ? json(await this.#options.connectionCatalog!())
        : definition.name === "results.artifact.read" ? this.#options.resultArtifacts!().read(cap.scope.botId,cap.scope.threadId,args.artifact_id as string,args.offset as number??0)
        : definition.name === "connections.request_status" ? (()=>{const request=this.#options.store.connectionWorkflow(args.request_id as string);if(!request||request.botId!==cap.scope.botId||request.threadId!==cap.scope.threadId)fail("forbidden");return json(request);})()
        : definition.name === "mac.setup.status" ? this.#macSetupStatus(cap)
        : definition.workspace ? this.#readWorkspace(definition,args,cap) : this.#status(cap);
      this.#validate(cap, signal);
      const requestHash = sha(canonicalJson({ tool: call.tool, turnId: cap.scope.turnId, callId: call.callId, input: args }));
      return { actionId: `harness-read-${requestHash.slice(0,24)}`, status: "succeeded", requestHash, reason: null, result: data };
    }
    const store = this.#options.store, key = `harness_${sha(`${cap.scope.turnId}\0${call.callId}`).slice(0,48)}`;
    const continued=store.replayedContinuationAction(cap.scope.turnId,call.tool,HARNESS_OPERATION_DESTINATION,args);
    if(continued)return project(continued);
    let action = store.findAction(cap.scope.botId, key);
    if (action) {
      if (action.request.tool !== call.tool || action.request.threadId !== cap.scope.threadId || action.request.destination !== HARNESS_OPERATION_DESTINATION
        || !same(action.request.arguments.input ?? null, args)) fail("conflict");
    } else {
      this.#validate(cap, signal);
      const admitted = this.#admissions.get(cap.scope.turnId) ?? new Set<string>();
      if (admitted.size >= 32) fail("unavailable");
      const pin = this.#pin(definition, args, cap);
      const eligibility=approvalEligibility(definition,args),ownDocument=['documents.update','memory.append'].includes(definition.name),macHandoff=definition.name==='mac.setup.request';
      const grant = eligibility==='own_documents'?store.prepareOwnDocumentGrant(cap.scope.botId,call.tool):store.getGrant(cap.scope.botId, call.tool, HARNESS_OPERATION_DESTINATION);
      if (!grant) store.setProposalGrant({ botId: cap.scope.botId, tool: call.tool, destination: HARNESS_OPERATION_DESTINATION, policy: "ask" });
      else if (grant.policy !== "ask" && !((ownDocument || macHandoff) && grant.policy==='allow')) fail("forbidden");
      action = store.requestAction({ botId: cap.scope.botId, threadId: cap.scope.threadId, tool: call.tool, destination: HARNESS_OPERATION_DESTINATION,
        idempotencyKey: key, arguments: { input: args, pin, ...(definition.name === "bots.communication.update" ? {} : { origin: json(cap.scope) }) } }, eligibility);
      if (!["awaiting_approval", "ready"].includes(action.state)) fail("forbidden");
      admitted.add(action.id); this.#admissions.set(cap.scope.turnId, admitted);
    }
    store.bindToolAction(action.id,cap.scope.turnId,call.callId);
    return this.#settle(definition, action, cap, signal);
  }

  #readAction(id: string, cap: Capability): Action & {continuation:ReturnType<HostStore["toolActionProgress"]>} {
    const action = this.#options.store.getAction(id);
    if (action.request.botId !== cap.scope.botId || action.request.threadId !== cap.scope.threadId) fail("forbidden");
    if (this.#options.privateMemoryTurn?.(cap.scope.turnId) === false
      && (definitions.some(definition => definition.documents && PREFIX + definition.name === action.request.tool)
        || action.request.tool.startsWith("dexter.memory."))) fail("forbidden");
    return {...action,continuation:this.#options.store.toolActionProgress(id)};
  }

  #instanceCatalog(args: Values,cap: Capability): JsonValue {
    const mcp=this.#options.mcp!(),serverId=args.server_id as string;
    if(!mcp.instanceSelectionReview(cap.scope.botId).instances.some(t=>t.serverId===serverId))fail("forbidden");
    return {serverId,toolIds:mcp.tools(serverId).filter(t=>t.state==="publishable").map(t=>t.id),authenticatedSubject:"unverified"};
  }
  #instanceSelectionReceipt(args: Values,cap: Capability): JsonValue {
    const action=this.#options.store.getAction(args.action_id as string);
    if(action.request.botId!==cap.scope.botId||action.request.threadId!==cap.scope.threadId)fail("forbidden");
    return json({dispatcherState:action.state,selection:this.#options.mcp!().instanceSelectionReceipt(action.id)});
  }
  #registrationReceipt(input: Values, cap: Capability): JsonValue {
    const action = this.#readAction(input.action_id as string, cap);
    try { return json(recoverMcpRegistration(this.#options.store, this.#options.mcp!(), action.id)); }
    catch (error) { if (error instanceof HostError && error.code === "forbidden") fail("forbidden"); throw error; }
  }

  #readMemoryReceipt(id: string, cap: Capability): JsonValue {
    const action = this.#readAction(id,cap);
    if (action.request.destination !== HARNESS_OPERATION_DESTINATION
      || !["documents.update","memory.restore","memory.append"].some(name => action.request.tool === PREFIX + name)
      || !this.#options.store.toolActionOrigin(action.id)) fail("forbidden");
    // A null Context receipt remains unconfirmed; the dispatcher and its continuation remain literal.
    return { documents: json(this.#options.documents!().receipt(cap.scope.botId,`action:${action.id}`,cap.scope.threadId)), dispatcher: json(action) };
  }

  #mcpReadiness(server: McpServerSummary, tools: readonly McpToolSummary[], selected: readonly string[]): JsonValue {
    const stage = server.status === "needs_auth" ? "authentication" : server.status === "unavailable_here" ? "host"
      : server.status === "configured" ? "registration" : "discovery";
    const state = server.status === "needs_auth" ? "authentication_required" : server.status === "configured" ? "registered"
      : server.status === "unavailable_here" || server.status === "failed" ? "unavailable"
        : selected.length ? "selected_for_next_turn" : tools.some(tool=>tool.state === "publishable") ? "tools_available" : "no_publishable_tools";
    const nextStep = server.diagnostic?.recovery ?? (server.status === "configured" ? "owner_approve_discovery"
      : server.status === "ready" ? selected.length ? "invoke_exact_selected_connection_next_turn" : "owner_approve_own_bot_selection" : "read_receipt_before_retry");
    return { stage, state, nextStep, connectionReady: server.status === "ready", invocationReady: server.status === "ready" && selected.length > 0,
      invocationRequiresApproval: true, newToolsApplyNextTurn: true, automaticNextStep: false };
  }
  #reachableMcp(input: Values, cap: Capability) {
    const mcp = this.#options.mcp!(), serverId = input.serverId as string;
    const reachable = this.#options.base.listTools(cap.token).filter(view => cap.baseTargets.has(`${view.connectionId}\0${view.name}`)
      && view.name.startsWith(`mcp.${serverId}.`));
    const receipt = typeof input.actionId === "string" ? this.#approvedMcpReceipt(input.actionId,serverId,cap) : null;
    if (!reachable.length && !receipt) fail("forbidden");
    const own = mcp.botSelection(serverId,cap.scope.botId);
    if (reachable.length && !reachable.some(view=>own.toolIds.includes(view.name))) fail("forbidden");
    const server = mcp.listServers().find(item=>item.id === serverId);
    if (!server) mcpRefusal("unavailable", "server_unknown", "configuration");
    return { server, own, receipt, reachable };
  }
  #approvedMcpReceipt(actionId: string, serverId: string, cap: Capability): Action {
    const mcp=this.#options.mcp!(), receipt=this.#readAction(actionId,cap);
    if (receipt.state !== "succeeded" || receipt.decidedBy !== this.#options.store.ownerId || receipt.authorization?.source !== "exact_owner"
      || receipt.request.destination !== HARNESS_OPERATION_DESTINATION
      || !["mcp.add","mcp.add_http","mcp.discover"].some(name=>receipt.request.tool===PREFIX+name)) fail("forbidden");
    const result=object(receipt.result), server=object(result.server);
    if(server.id!==serverId || typeof result.instancePin!=="string" || !/^[a-f0-9]{64}$/.test(result.instancePin))fail("forbidden");
    if(mcp.instancePin(serverId)!==result.instancePin)mcpRefusal("conflict","configuration_changed","configuration");
    if(receipt.request.tool!==PREFIX+"mcp.discover"){
      const effect=recoverMcpRegistration(this.#options.store,mcp,receipt.id).registration;
      if(!effect || effect.instanceState!=="registered" || effect.receipt.instancePin!==result.instancePin)fail("forbidden");
    }
    return receipt;
  }
  #inspectMcp(input: Values, cap: Capability): JsonValue {
    const mcp = this.#options.mcp!(), serverId = input.serverId as string;
    const { server, own, receipt } = this.#reachableMcp(input,cap);
    const tools = mcp.tools(serverId);
    if (tools.length > 256 || own.toolIds.length > 256) mcpRefusal("unavailable", "server_limit", "configuration");
    return { server: serverView(server), configuration_pin: mcp.configurationPin(serverId), instance_pin: mcp.instancePin(serverId), tools: tools.map(toolView),
      selection: { botId: cap.scope.botId, toolIds: own.toolIds, policy: "ask" }, setup: this.#mcpReadiness(server,tools,own.toolIds),
      scopedBy: receipt ? "own_approved_receipt" : "reachable_own_selected_connection", automaticNextStep: false };
  }
  #authorizationInstance(input: Values): string {
    const mcp = this.#options.mcp!(), serverId = input.serverId as string;
    const instancePin = mcp.instancePin(serverId);
    if (instancePin !== input.expectedInstancePin) mcpRefusal("conflict","configuration_changed","authentication");
    const server = mcp.listServers().find(item=>item.id===serverId);
    if (!server || server.auth !== "oauth" || server.transport !== "streamable_http") fail("invalid_input");
    return instancePin;
  }
  #authorizationPin(input: Values, cap: Capability): Values {
    const instancePin = this.#authorizationInstance(input);
    const { receipt, reachable, own } = this.#reachableMcp(input,cap);
    return { instancePin, reachability: receipt ? "own_approved_receipt" : "reachable_own_selected_connection",
      receiptActionId: receipt?.id ?? null,
      selectedTools: receipt ? [] : reachable.filter(view=>own.toolIds.includes(view.name)).map(view=>view.name).sort(),
      selectionHash: receipt ? null : sha(canonicalJson(json(own.toolIds))) };
  }
  /** Owner continuation has no live engine token. Recheck the host-created admission proof, never relist a dead token. */
  #checkAuthorizationPin(proposal: Proposal, cap: Capability): void {
    const { input, pin } = proposal, mcp = this.#options.mcp!(), serverId = input.serverId as string;
    if (Object.keys(pin).sort().join(",") !== "instancePin,reachability,receiptActionId,selectedTools,selectionHash"
      || this.#authorizationInstance(input) !== pin.instancePin) fail("conflict");
    if (pin.reachability === "own_approved_receipt") {
      if (typeof pin.receiptActionId !== "string" || pin.receiptActionId !== input.actionId || pin.selectionHash !== null
        || !same(pin.selectedTools ?? null,[])) fail("forbidden");
      // Receipt scope is bound to this exact bot/thread and the current instance generation.
      const receipt=this.#approvedMcpReceipt(pin.receiptActionId,serverId,cap);
      if(object(receipt.result).instancePin!==pin.instancePin)fail("forbidden");
    } else if (pin.reachability === "reachable_own_selected_connection") {
      const selection = mcp.botSelection(serverId,cap.scope.botId), tools = pin.selectedTools;
      if (pin.receiptActionId !== null || !Array.isArray(tools) || !tools.length || tools.length > 256
        || tools.some(tool=>typeof tool!=="string" || !tool.startsWith(`mcp.${serverId}.`) || !selection.toolIds.includes(tool))
        || pin.selectionHash !== sha(canonicalJson(json(selection.toolIds)))) fail("forbidden");
      // Instance-selection review confirms the original bot/profile still owns a live native connection.
      const review = mcp.instanceSelectionReview(cap.scope.botId);
      const instance=review.instances.find(item=>item.serverId===serverId && item.instancePin===pin.instancePin);
      if (review.profileId !== cap.scope.profileId || !review.selected.some(item=>item.serverId===serverId
        && tools.some(tool=>item.toolIds.includes(tool as string)))
        || !instance || !tools.some(tool=>{
          const grant=this.#options.store.getGrant(cap.scope.botId,tool as string,instance.connectionId);
          return grant!==null && grant.policy!=="deny" && (grant.expiresAt===null || grant.expiresAt>this.#options.store.now());
        })) fail("forbidden");
    } else fail("forbidden");
  }

  /** Trusted owner decision continuation; no model-supplied capability or new tool call is needed. */
  async continueOwnerAction(action: Action): Promise<Action> {
    if (action.request.destination !== HARNESS_OPERATION_DESTINATION || action.request.tool === PREFIX + "bots.communication.update") return action;
    const definition = definitions.find(item => PREFIX + item.name === action.request.tool && item.write);
    if (!definition || !["ready", "denied"].includes(action.state)) return action;
    if (action.state === "denied") return action;
    const controller = new AbortController();
    this.#ownerControllers.add(controller);
    try {
      const origin = this.#options.store.ownerToolScope(action.id);
      const cap: Capability = { token: "", scope: origin,
        controllers: new Set(), baseTargets: new Set(), ownerApproved: true, ownerActionId: action.id };
      const settled = await this.#settle(definition, this.#options.store.getAction(action.id), cap, controller.signal);
      const receipt = this.#options.store.getAction(settled.actionId);
      this.#options.store.recordToolOutcome(receipt.id,settled.result);
      return receipt;
    } catch (error) {
      if (error instanceof HostError && error.code === "host_locked") throw error;
      const current = this.#options.store.getAction(action.id);
      const receipt = current.state === "ready" ? this.#options.store.blockAction(action.id) : current;
      return receipt;
    } finally { this.#ownerControllers.delete(controller); }
  }

  async #settle(definition: Definition, action: Action, cap: Capability, signal: AbortSignal): Promise<GatewayCallResult> {
    const store = this.#options.store;
    const running = this.#executions.get(action.id); if (running) return running;
    if (action.state !== "ready") return project(action);
    const proposal: Proposal = { input: object(action.request.arguments.input) as Values, pin: object(action.request.arguments.pin) as Values };
    try {
      if(["mcp.authorize","mac.setup.request","connections.request"].includes(definition.name) && (action.authorization?.source!=="exact_owner" || action.decidedBy!==store.ownerId))fail("forbidden");
      this.#validate(cap, signal); this.#checkPin(definition, proposal, cap);
    }
    catch (error) {
      if (error instanceof HostError && error.code === "host_locked") throw error;
      return project(store.blockAction(action.id));
    }
    const id = action.id;
    const executionCap:Capability={...cap,scope:store.ownerToolScope(id),ownerApproved:true,ownerActionId:id};
    const execution = dispatchAction(store, id, async (_request, executionContext) => {
      this.#validateRunning(executionCap, id, executionContext.signal);
      const result = await this.#execute(definition, proposal.input, executionCap, id, executionContext.signal);
      if(!["terminal.run","cli.run"].includes(definition.name))this.#validateRunning(executionCap, id, executionContext.signal);
      return result;
    }, signal).then(receipt=>{store.recordToolOutcome(id,receipt.result);return project(receipt);});
    this.#executions.set(id, execution);
    try { return await execution; } finally { this.#executions.delete(id); }
  }

  #arguments(definition: Definition, raw: unknown): Values {
    const args = object(raw), schema = definition.inputSchema;
    if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key)) || schema.required.some(key => !Object.hasOwn(args,key))) fail("invalid_input");
    for (const [key, value] of Object.entries(args)) {
      const property = schema.properties[key]!;
      if (property.type === "string") {
        if (typeof value !== "string" || value.length > property.maxLength || value.length < (property.minLength ?? 0)
          || property.enum && !property.enum.includes(value) || property.pattern && !new RegExp(property.pattern).test(value)) fail("invalid_input");
      } else if (property.type === "array") {
        if (!Array.isArray(value) || value.length > property.maxItems || value.some(item => typeof item !== "string" || property.items.type !== "string" || item.length < (property.items.minLength ?? 0) || item.length > property.items.maxLength)) fail("invalid_input");
      } else if (property.type === "integer") {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || property.minimum !== undefined && value < property.minimum
          || property.maximum !== undefined && value > property.maximum) fail("invalid_input");
      } else if (property.type === "boolean") {
        if (typeof value !== "boolean") fail("invalid_input");
      } else fail("invalid_input");
    }
    switch (definition.name) {
      case "results.artifact.read":case "results.artifact.remove":return json(args) as Values;
      case "connections.catalog":return {};
      case "connections.request_status":return {request_id:args.request_id as string};
      case "connections.request":{let decoded:unknown;try{decoded=JSON.parse(args.request_json as string);}catch{fail("invalid_input");}
        const parsed=ConnectionWorkflowRequestSchema.safeParse(decoded);if(!parsed.success||parsed.data.target.kind!=="managed")fail("invalid_input");return json(parsed.data) as Values;}
      case "status": case "models": case "mac.setup.status": return {};
      case "mac.setup.request": {
        const parsed=MacSetupHandoffInputSchema.safeParse(args);if(!parsed.success)fail("invalid_input");
        return {expected_revision:parsed.data.expected_revision};
      }
      case "actions.read": return { action_id: args.action_id as string };
      case "guide": return args.topic === undefined ? {} : { topic: args.topic as string };
      case "configuration": if(args.field!==undefined&&args.page===undefined)fail("invalid_input");return args.page === undefined ? {} : { page: args.page as string,...(args.field!==undefined?{field:args.field as string}:{}) };
      case "documents.read": return {};
      case "memory.history": case "memory.read_revision": case "memory.receipt": return json(args) as Values;
      case "memory.append": {
        const input = AppendBotMemoryNoteSchema.safeParse(args);
        if (!input.success || credentialText(input.data.note)) fail("invalid_input");
        return json(input.data) as Values;
      }
      case "memory.restore": {
        if(args.sourceReference!==undefined&&(!isWellFormedText(args.sourceReference as string)||credentialText(args.sourceReference as string)))fail("invalid_input");
        return json(args) as Values;
      }
      case "terminal.status": return {};
      case "cli.run": {
        const argv = args.args as string[];
        if (argv.some((arg,index)=>!isWellFormedText(arg) || arg.includes("\0") || credentialText(arg) || looksSecret(arg,argv[index-1]))
          || argv.reduce((length,arg)=>length+arg.length,0)>8192
          || typeof args.cwd === "string" && (!isWellFormedText(args.cwd) || credentialText(args.cwd))) fail("invalid_input");
        return json(args) as Values;
      }
      case "terminal.run": case "files.list": case "files.tree": case "files.read": case "files.search": case "files.write": {
        if (Object.entries(args).some(([key,value]) => key !== "expected_sha256" && typeof value === "string"
          && (!isWellFormedText(value) || credentialText(value)))
          || definition.name === "terminal.run" && !(args.command as string).trim()
          || definition.name === "files.write" && Buffer.byteLength(args.text as string,"utf8") > 65536) fail("invalid_input");
        return json(args) as Values;
      }
      case "bots.create": {
        if (!(args.name as string).trim() || credentialText(args.name as string) || [args.model,args.reasoning_effort,args.speed].some(value => typeof value === "string" && credentialText(value))) fail("invalid_input");
        const selection = EngineSelectionSchema.parse({ engine: args.engine, model: args.model ?? null, reasoningEffort: args.reasoning_effort ?? null, speed: args.speed ?? null });
        return { name: (args.name as string).trim(), selection: json(selection),
          ...(args.avatarAppearanceJson===undefined?{}:{avatarAppearance:avatarAppearanceInput(args.avatarAppearanceJson)}) };
      }
      case "bots.update": {
        if (Object.keys(args).length < 2 || [args.name, args.roleDescription, args.avatarEmoji].some(value => typeof value === "string" && (!isWellFormedText(value) || credentialText(value)))) fail("invalid_input");
        const {avatarAppearanceJson,clearAvatarImage,...fields}=args;
        const patch = PatchBotSchema.safeParse({ ...fields, ...(args.avatarEmoji === "" ? { avatarEmoji: null } : {}), ...(args.liveVoice === "" ? { liveVoice: null } : {}),
          ...(avatarAppearanceJson===undefined?{}:{avatarAppearance:avatarAppearanceInput(avatarAppearanceJson)}),
          ...(clearAvatarImage===true?{avatarImageId:null}:{}) });
        if (!patch.success||Object.keys(patch.data).length<2) fail("invalid_input");
        return json(patch.data) as Values;
      }
      case "bots.communication.update": {
        const patch = BotCommunicationPatchSchema.safeParse(args);
        if (!patch.success) fail("invalid_input");
        return json(patch.data) as Values;
      }
      case "documents.update": {
        if (!isWellFormedText(args.markdown as string) || credentialText(args.markdown as string) || args.sourceReference!==undefined&&(!isWellFormedText(args.sourceReference as string)||credentialText(args.sourceReference as string))) fail("invalid_input");
        return { expectedRevision: args.expectedRevision as number, document: args.document as string, markdown: args.markdown as string, ...(args.sourceReference===undefined?{}:{sourceReference:args.sourceReference as string}) };
      }
      case "skills.register": {
        if (credentialText(args.markdown as string)) fail("invalid_input");
        const value = RegisterSkillSchema.parse({ id: args.skill_id, version: args.version, markdown: args.markdown }); return json(value) as Values;
      }
      case "skills.activate": {
        if (Object.hasOwn(args,"expected_version") !== Object.hasOwn(args,"expected_sha256")) fail("invalid_input");
        return { skillId: args.skill_id as string, scope: args.scope as string, version: args.version as string ?? null,
          expected: args.expected_version === undefined ? null : { version: args.expected_version as string, sha256: args.expected_sha256 as string } };
      }
      case "mcp.add": {
        let value: unknown; try { value = JSON.parse(args.definition_json as string); } catch { return fail("invalid_input"); }
        if (Object.hasOwn(object(value), "source")) fail("invalid_input");
        const definition = checkMcpDefinition(value), t = definition.transport;
        if (Object.values(t.type === "stdio" ? t.env : t.headers).some(item => item.kind === "literal" || item.prefix !== undefined && credentialText(item.prefix))
          || t.type === "stdio" && t.args.some((arg,index) => looksSecret(arg,t.args[index-1]) || credentialText(arg))) fail("invalid_input");
        if (credentialText(definition.name) || credentialText(definition.source.name) || t.type === "streamable_http" && credentialText(t.url)) fail("invalid_input");
        // Header/env SLOT NAMES may be credential-shaped dictionary keys. Store only the already validated,
        // normalized definition string; no literal value can pass above and no secret-key object is admitted.
        return { definitionJson: canonicalJson(json(definition)), registrationDefinitionJson: mcpSetupCanonicalJSON(value), registrationInputJson: mcpSetupCanonicalJSON(value) };
      }
      case "mcp.add_http": {
        const candidate = normalizeMcpHttpRegistration(args);
        if (credentialText(candidate.name) || candidate.transport.type === "streamable_http" && credentialText(candidate.transport.url))
          mcpRefusal("invalid_input", "secret_refused", "registration");
        const original = { ...candidate, transport: { ...candidate.transport, url: args.url } } as Record<string, unknown>;
        delete original.source;
        return { definitionJson: canonicalJson(json(candidate)), registrationDefinitionJson: mcpSetupCanonicalJSON(original), registrationInputJson: mcpSetupCanonicalJSON(args) };
      }
      case "mcp.registration_receipt": return { action_id: args.action_id as string };
      case "mcp.registration_journal_status": return {};
      case "mcp.inspect": return { serverId: args.server_id as string, ...(args.action_id === undefined ? {} : { actionId: args.action_id as string }) };
      case "mcp.authorize": {
        const parsed=McpAuthorizationHandoffInputSchema.safeParse(args);if(!parsed.success)fail("invalid_input");
        return { serverId: parsed.data.server_id, expectedInstancePin: parsed.data.expected_instance_pin,
          ...(parsed.data.action_id===undefined?{}:{actionId:parsed.data.action_id}) };
      }
      case "mcp.discover": return { serverId: args.server_id as string };
      case "mcp.instance_selection": return {};
      case "mcp.instance_selection_receipt": return {action_id:args.action_id as string};
      case "mcp.instance_selection_catalog": return {server_id:args.server_id as string};
      case "mcp.instance_selection_plan": {
        try { JSON.parse(args.selection_json as string); } catch { fail("invalid_input"); }
        return {selection_json:args.selection_json as string};
      }
      case "mcp.select_instances": {
        let raw:unknown;try{raw=JSON.parse(args.plan_json as string);}catch{return fail("invalid_input");}
        const plan=McpInstanceSelectionPlanSchema.safeParse(raw);if(!plan.success)return fail("invalid_input");
        return {selectionPlan:json(plan.data)};
      }
      case "mcp.select": return { serverId: args.server_id as string, toolIds: [...new Set(args.tool_ids as string[])].sort() };
      default: return fail("invalid_input");
    }
  }
  #scope(input: Values, cap: Capability): OwnerSkillScope { return input.scope === "global" ? { kind: "global" } : { kind: "bot", botId: cap.scope.botId }; }
  #activation(input: Values, cap: Capability): SetSkillActivation {
    return { scope: this.#scope(input,cap), expected: input.expected as SetSkillActivation["expected"], version: input.version as string | null };
  }
  #skillAbsent(id: string, version: string): void {
    try { this.#options.skills().readSkill(id,version); }
    catch (error) { if (error instanceof ContextError && error.code === "not_found") return; throw error; }
    fail("conflict");
  }
  #currentActivation(input: Values, cap: Capability): JsonValue {
    const scope = this.#scope(input,cap), skills = this.#options.skills(), skillId = input.skillId as string;
    let after: string | undefined;
    for (let page = 0; page < 8; page++) {
      const result = skills.listSkillActivations({ scopeKind: scope.kind, ...(scope.kind === "bot" ? { botId: scope.botId } : {}), limit: 200,
        ...(after === undefined ? {} : { after }) });
      const found = result.items.find(item => item.skillId === skillId)?.lock;
      if (found) return { version: found.version, sha256: found.sha256 };
      if (!result.next || result.items.some(item => item.skillId > skillId)) return null;
      after = result.next;
    }
    return fail("unavailable");
  }
  #pin(definition: Definition, input: Values, cap: Capability): Values {
    switch (definition.name) {
      case "bots.create": return { kind: "basic_bot_no_permissions" };
      case "bots.update": {
        const bot = this.#options.store.getBot(cap.scope.botId);
        if (bot.revision !== input.expectedRevision) fail("conflict");
        return { revision: bot.revision };
      }
      case "bots.communication.update": {
        const bot = this.#options.store.getBot(cap.scope.botId);
        if (bot.revision !== input.expectedRevision) fail("conflict");
        if (bot.isMaster && input.canSeeBots === false) fail("invalid_input");
        return { revision: bot.revision, hostId: this.#options.store.hostId, turnId: cap.scope.turnId };
      }
      case "documents.update": case "memory.restore": case "memory.append": {
        const documents = this.#options.documents!().read(cap.scope.botId);
        if (documents.revision !== input.expectedRevision) fail("conflict");
        const from=definition.name==="memory.restore"?this.#options.documents!().readRevision(cap.scope.botId,input.fromRevision as number):null;
        return { revision: documents.revision, soulHash: sha(documents.soul), userHash: sha(documents.user), memoryHash: sha(documents.memory),
          ...(from?{sourcePin:json(from.pin)}:{}) };
      }
      case "terminal.run": case "cli.run": return { workspacePin: this.#options.workspace!().pin(this.#workspaceOwner(cap)) };
      case "files.write": {
        const workspace = this.#options.workspace!(), owner = this.#workspaceOwner(cap), filePin = workspace.filePin(owner,{path:input.path as string});
        const file = object(filePin);
        if (file.exists !== false && file.exists !== true || file.exists === true && (typeof file.sha256 !== "string" || file.sha256 !== input.expected_sha256)
          || file.exists === false && input.expected_sha256 !== undefined) fail("conflict");
        return { workspacePin: workspace.pin(owner), filePin };
      }
      case "skills.register": this.#skillAbsent(input.id as string,input.version as string); return { kind: "skill_version_absent" };
      case "skills.activate": {
        const current = this.#currentActivation(input,cap);
        if (!same(current,input.expected!)) fail("conflict");
        const lock = input.version === null ? null : this.#options.skills().readSkill(input.skillId as string,input.version as string).lock;
        return { current, lock: lock ? lockView(lock) : null };
      }
      case "mcp.add": case "mcp.add_http": {
        const candidate = this.#mcpDefinition(input);
        if (this.#options.mcp!().listServers().some(server => server.id === candidate.id)) mcpRefusal("conflict", "server_exists", "registration");
        return { kind: "server_absent", definitionHash: sha(input.definitionJson as string), inputHash: mcpSetupHash(JSON.parse(input.registrationDefinitionJson as string)), registrationInputHash: mcpSetupHash(JSON.parse(input.registrationInputJson as string)) };
      }
      case "mcp.select_instances": {
        const plan=McpInstanceSelectionPlanSchema.parse(input.selectionPlan),mcp=this.#options.mcp!();
        const current=mcp.materializeInstanceSelection(cap.scope.botId,{mode:plan.mode,expectedInventoryPin:plan.inventoryPin,expectedSelectionPin:plan.selectionPin,
          expectedRevision:plan.expectedRevision,instances:plan.targets.map(t=>({serverId:t.serverId,toolIds:t.toolIds}))});
        if(!same(json(current),json(plan)))fail("conflict");
        return {inventoryPin:plan.inventoryPin,selectionPin:plan.selectionPin,revision:plan.expectedRevision,planHash:sha(canonicalJson(json(plan)))};
      }
      case "connections.request":
        if(!this.#options.store.isOwnDocumentTurnPrivate(cap.scope.turnId))fail("forbidden");
        if(this.#options.store.getBot(cap.scope.botId).revision!==input.expectedBotRevision)fail("conflict");
        return {botRevision:input.expectedBotRevision!,target:input.target!};
      case "results.artifact.remove":{const snapshot=this.#options.resultArtifacts!().read(cap.scope.botId,cap.scope.threadId,input.artifact_id as string,0) as Values;return {artifactId:input.artifact_id!,sha256:snapshot.sha256!,expiresAt:snapshot.expiresAt!};}
      case "mcp.authorize": return this.#authorizationPin(input,cap);
      case "mac.setup.request": {
        const configurationRevision=this.#macSetupSnapshot(cap).configurationRevision;
        if(configurationRevision!==input.expected_revision)fail("conflict");
        return {configurationRevision};
      }
      case "mcp.discover": case "mcp.select": {
        const mcp = this.#options.mcp!(), serverId = input.serverId as string;
        const configurationPin = mcp.configurationPin(serverId);
        const tools = mcp.tools(serverId), selection = mcp.botSelection(serverId,cap.scope.botId);
        if (definition.name === "mcp.select" && (input.toolIds as string[]).some(id => !tools.some(tool => tool.id === id && tool.state === "publishable"))) mcpRefusal("invalid_input", "tool_not_allowed", "selection");
        return { configurationPin, previousSelection: json(selection.toolIds), toolsHash: sha(canonicalJson(json(tools))) };
      }
      default: return fail("invalid_input");
    }
  }
  #checkPin(definition: Definition, proposal: Proposal, cap: Capability): void {
    if (definition.name === "mcp.authorize") { this.#checkAuthorizationPin(proposal,cap); return; }
    const current = this.#pin(definition, proposal.input, cap);
    if (!same(current,proposal.pin)) fail("conflict");
  }
  #mcpDefinition(input: Values): McpServerDefinition { return checkMcpDefinition(JSON.parse(input.definitionJson as string)); }
  #validateRunning(cap: Capability, actionId: string, signal: AbortSignal): void {
    this.#validate(cap,signal);
    const store = this.#options.store, action = store.getAction(actionId), grant = store.getGrant(cap.scope.botId,action.request.tool,HARNESS_OPERATION_DESTINATION);
    if (action.state !== "running" || action.request.botId !== cap.scope.botId || action.request.threadId !== cap.scope.threadId || action.request.destination !== HARNESS_OPERATION_DESTINATION
      || [PREFIX+"mcp.authorize",PREFIX+"mac.setup.request",PREFIX+"connections.request"].includes(action.request.tool) && (action.authorization?.source!=="exact_owner" || action.decidedBy!==store.ownerId)
      || !grant || grant.policy !== "ask" && !(grant.policy==='allow' && (action.authorization?.source==='exact_owner'
        && ['documents.update','memory.append','mac.setup.request'].some(name=>action.request.tool===PREFIX+name) || store.ownDocumentAuthorizationValid(actionId)))
      || grant.revision !== action.grantRevision || grant.expiresAt !== null && grant.expiresAt <= store.now()) fail("forbidden");
  }
  async #execute(definition: Definition, input: Values, cap: Capability, actionId: string, signal: AbortSignal): Promise<JsonValue> {
    switch (definition.name) {
      case "mac.setup.request": {
        const store=this.#options.store,action=store.getAction(actionId);
        if(action.authorization?.source!=="exact_owner" || action.decidedBy!==store.ownerId)fail("forbidden");
        const configurationRevision=this.#macSetupSnapshot(cap).configurationRevision;
        if(configurationRevision!==input.expected_revision)fail("conflict");
        // Receipt only: the owner interface may navigate to its passive shell. No setup or consent executes here.
        return json(MacSetupHandoffSchema.parse({kind:"mac_setup_handoff",target:"computer_access",hostId:store.hostId,
          botId:cap.scope.botId,threadId:cap.scope.threadId,actionId,requestHash:action.requestHash,configurationRevision,
          expiresAt:store.now()+MAC_SETUP_HANDOFF_TTL_MS}));
      }
      case "bots.create": {
        const selection = EngineSelectionSchema.parse(input.selection);
        const bot = await this.#options.runtime().createBot({ name: input.name, profileId: cap.scope.profileId, engine: selection.engine, defaultSelection: selection,
          ...(input.avatarAppearance===undefined?{}:{avatarAppearance:input.avatarAppearance}) },
          () => this.#validateRunning(cap,actionId,signal));
        return { bot: botView(bot), grantedTools: [], delegationEnabled: false };
      }
      case "bots.update": {
        // Identity and authority flags are not arguments. The synchronous CAS has no native-session/model switch.
        this.#validateRunning(cap,actionId,signal);
        const bot = this.#options.store.patchBot(cap.scope.botId,PatchBotSchema.parse(input));
        return { bot: botView(bot), appliesNextTurn: true };
      }
      case "documents.update": case "memory.restore": case "memory.append": {
        this.#validateRunning(cap,actionId,signal);
        const updated=this.#options.documents!().executeAction(actionId);
        return {documents:json(updated),updatedDocument:definition.name==="documents.update"?input.document!:"MEMORY",appliesNextTurn:true};
      }
      case "files.write": {
        this.#validateRunning(cap,actionId,signal);
        return this.#options.workspace!().write(this.#workspaceOwner(cap),{ path: input.path as string, text: input.text as string,
          ...(input.expected_sha256 === undefined ? {} : { expected_sha256: input.expected_sha256 as string }) });
      }
      case "terminal.run": return this.#options.workspace!().run(this.#workspaceOwner(cap),{ runtime: input.runtime as "bash" | "zsh" | "sh" | "bun", command: input.command as string,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd as string }), ...(input.timeout_ms === undefined ? {} : { timeout_ms: input.timeout_ms as number }) },{signal});
      case "cli.run": return this.#options.workspace!().cli(this.#workspaceOwner(cap),{ tool: input.tool as "gh" | "python3", args: input.args as string[],
        ...(input.cwd === undefined ? {} : { cwd: input.cwd as string }), ...(input.timeout_ms === undefined ? {} : { timeout_ms: input.timeout_ms as number }) },{signal});
      case "skills.register": return { skill: lockView(this.#options.skills().registerSkill(input.id as string,input.version as string,input.markdown as string)), activated: false };
      case "skills.activate": {
        const result = this.#options.skills().setSkillActivation(input.skillId as string,this.#activation(input,cap));
        return { scope: json(result.scope), skillId: result.skillId, lock: result.lock ? lockView(result.lock) : null, appliesNextTurn: true };
      }
      case "mcp.add": case "mcp.add_http": {
        this.#validateRunning(cap, actionId, signal);
        const mcp = this.#options.mcp!(), { binding } = mcpRegistrationAction(this.#options.store, actionId);
        if (!binding) fail("conflict");
        const registrationReceipt = mcp.addServerWithReceipt(binding.request, binding.authority);
        validateMcpActionReceipt(registrationReceipt, binding);
        const server = mcp.listServers().find(item => item.id === registrationReceipt.instanceId);
        if (!server || mcp.instancePin(server.id) !== registrationReceipt.instancePin) fail("conflict");
        return { server: serverView(server), definitionHash: registrationReceipt.definitionPin, instancePin: registrationReceipt.instancePin,
          registrationReceipt: json(registrationReceipt), registrationInputHash: binding.registrationInputHash,
          hubActionId: actionId, nativeRequestHash: registrationReceipt.requestHash, discovered: false, grantedTools: [],
          setup: this.#mcpReadiness(server,[],[]) };
      }
      case "mcp.discover": {
        const result = await this.#options.mcp!().discover(input.serverId as string, { unlockCredentials: false });
        this.#validateRunning(cap,actionId,signal);
        if (result.tools.length > 256) fail("unavailable");
        return { server: serverView(result.server), definitionHash: this.#options.mcp!().definitionPin(input.serverId as string), instancePin: this.#options.mcp!().instancePin(input.serverId as string),
          tools: result.tools.map(toolView), grantedTools: [], authenticationInOwnerSettings: result.server.auth !== "none",
          queryCompleted: true, setup: this.#mcpReadiness(result.server,result.tools,[]) };
      }
      case "mcp.authorize": {
        const store=this.#options.store, action=store.getAction(actionId);
        if(action.authorization?.source!=="exact_owner" || action.decidedBy!==store.ownerId)fail("forbidden");
        const instancePin=this.#authorizationInstance(input);
        // Public handoff only. Network, browser, OAuth state/PKCE and custody are exclusively owner-interface work.
        const requestHash=sha(actionId),clientRequestId=`${requestHash.slice(0,8)}-${requestHash.slice(8,12)}-5${requestHash.slice(13,16)}-a${requestHash.slice(17,20)}-${requestHash.slice(20,32)}`;
        if(this.#options.connections && store.isOwnDocumentTurnPrivate(cap.scope.turnId))await this.#options.connections().request(actionId,{clientRequestId,expectedBotRevision:store.getBot(cap.scope.botId).revision,
          target:{kind:"native_mcp",serverId:input.serverId as string,instancePin}});
        return json(McpAuthorizationHandoffSchema.parse({kind:"mcp_authorization_handoff",serverId:input.serverId,instancePin,
          hostId:store.hostId,botId:cap.scope.botId,threadId:cap.scope.threadId,actionId,requestHash:action.requestHash,
          expiresAt:store.now()+MCP_AUTHORIZATION_HANDOFF_TTL_MS}));
      }
      case "connections.request":return json(await this.#options.connections!().request(actionId,ConnectionWorkflowRequestSchema.parse(input)));
      case "results.artifact.remove":return this.#options.resultArtifacts!().remove(cap.scope.botId,cap.scope.threadId,input.artifact_id as string);
      case "mcp.select_instances": return json(this.#options.mcp!().applyInstanceSelection(actionId));
      case "mcp.select": {
        const result = this.#options.mcp!().setBotSelection(input.serverId as string,cap.scope.botId,{ toolIds: input.toolIds, policy: "ask" });
        return { serverId: input.serverId!, toolIds: result.toolIds, policy: "ask", appliesNextTurn: true };
      }
      default: return fail("invalid_input");
    }
  }
  /** Bot + turn from the capability only; a turn without an output namespace (group audience) is refused. */
  #workspaceOwner(cap: Capability): WorkspaceOwner {
    if (this.#options.workspaceTurn?.(cap.scope.turnId) === false) fail("forbidden");
    return { botId: cap.scope.botId, turnId: cap.scope.turnId };
  }
  #readWorkspace(definition: Definition, input: Values, cap: Capability): JsonValue {
    const workspace = this.#options.workspace!(), botId = this.#workspaceOwner(cap);
    const location = input.path === undefined ? {} : {path:input.path as string};
    const limit = input.limit === undefined ? {} : {limit:input.limit as number};
    switch (definition.name) {
      case "terminal.status": return workspace.status(botId);
      case "files.list": return workspace.list(botId,{...location,...limit});
      case "files.tree": return workspace.tree(botId,{...location,...limit,...(input.maxDepth === undefined ? {} : {maxDepth:input.maxDepth as number})});
      case "files.read": return workspace.read(botId,{path:input.path as string});
      case "files.search": return workspace.search(botId,{query:input.query as string,...location,...limit});
      default: return fail("invalid_input");
    }
  }
  #macSetupSnapshot(cap: Capability): { routes: readonly DeviceConversationRoute[]; configurationRevision: string; known: boolean } {
    // The trusted callback receives only host-derived identity. Filter again before projection/hashing.
    const own=this.#options.macSetupRoutes?.(cap.scope.botId),known=own!==undefined;
    if(own && own.length>256)fail("unavailable");
    const routes=(own ?? []).filter(route=>route.botId===cap.scope.botId);
    const configuration=routes.map(route=>({id:route.id,deviceId:route.deviceId,tool:route.tool,status:route.status,
      revision:route.revision,fingerprint:route.fingerprint,generation:route.generation,pinRevision:route.pinRevision,
      schemaHash:route.schemaHash,operationVersion:route.operationVersion,minimumGrantRevision:route.minimumGrantRevision}))
      .sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    const configurationRevision=sha(canonicalJson(json({hostId:cap.scope.installationId,botId:cap.scope.botId,
      composition:known?"own_routes":"unavailable",configuration})));
    return {routes,configurationRevision,known};
  }
  #macSetupStatus(cap: Capability): JsonValue {
    const store=this.#options.store,{routes,configurationRevision,known}=this.#macSetupSnapshot(cap);
    const live=this.#options.base.listTools(cap.token).filter(view=>cap.baseTargets.has(`${view.connectionId}\0${view.name}`));
    const operations:MacSetupStatus["operations"]=MAC_SETUP_CUA_OPERATIONS.map(operation=>{
      const active=routes.filter(route=>route.tool===operation && route.status==="active");
      const states=active.map(route=>{
        const grant=store.getGrant(cap.scope.botId,operation,route.deviceId);
        return !grant?"missing":grant.policy==="deny"?"denied":grant.expiresAt!==null && grant.expiresAt<=store.now()?"expired"
          :grant.revision<route.minimumGrantRevision?"revision_required":"valid";
      });
      // At least one valid own route is enough for host grant metadata, never for native readiness.
      const grantValidity:MacSetupStatus["operations"][number]["grantValidity"]=!known?"unknown":!active.length?"not_published"
        :states.includes("valid")?"valid":states.includes("revision_required")?"revision_required":states.includes("expired")?"expired"
          :states.includes("denied")?"denied":"missing";
      return {operation,published:known && active.length>0,
        turnAdmitted:known && active.some(route=>live.some(view=>view.connectionId===route.id && view.name===operation)),grantValidity};
    });
    return json(MacSetupStatusSchema.parse({kind:"mac_setup_status",hostId:store.hostId,botId:cap.scope.botId,
      threadId:cap.scope.threadId,configurationRevision,routeConfiguration:known?"known":"unknown",operations,
      nativeTCC:"unknown",helper:"unknown",localPolicy:"unknown",session:"unknown",readiness:"unknown",newToolsApplyNextTurn:true}));
  }
  #configurationGuide(args:Values):JsonValue {
    if(args.page===undefined)return json({pages:APP_CONFIGURATION_GUIDE_PAGES});
    const page=readAppConfigurationGuidePage(args.page as string);
    if(args.field===undefined)return json(page);
    const field=page.fields.find(value=>value.id===args.field);if(!field)fail("invalid_input");
    return json({id:page.id,title:page.title,version:page.version,sha256:page.sha256,scope:page.scope,availability:page.availability,field});
  }
  async #models(): Promise<JsonValue> {
    const catalog = await this.#options.catalog();
    if (catalog.length > 32) fail("unavailable");
    // Explicit projection: executable paths, account/auth details and future provider additions never leak.
    return { items: catalog.map(entry => ({ id: entry.id, available: entry.available, installed: entry.installed ?? null, adapterSupported: entry.adapterSupported ?? null,
      defaultModel: entry.defaultModel, reasoningEfforts: entry.reasoningEfforts, speeds: entry.speeds,
      ...(readEngineCatalogDiagnostics(entry.diagnostics) ? { diagnostics: readEngineCatalogDiagnostics(entry.diagnostics)! } : {}),
      providerID: entry.providerID ?? null, providerLabel: entry.providerLabel ?? null,
      models: entry.models.slice(0,256).map(model => ({ id: model.id, label: model.label ?? model.id, reasoningEfforts: model.reasoningEfforts, speeds: model.speeds })) })) };
  }
  #status(cap: Capability): JsonValue {
    const store = this.#options.store, scope = cap.scope, selection = store.getThreadEngineSelection(scope.threadId);
    const mcp = this.#options.mcp?.();
    const selected = mcp ? mcp.listServers().slice(0,256).flatMap(server => {
      const own = mcp.botSelection(server.id,scope.botId); if (!own.toolIds.length) return [];
      return [{ server: serverView(server), toolIds: own.toolIds, selectionDoesNotGrantAccess: true }];
    }) : [];
    return { bot: botView(store.getBot(scope.botId)), thread: { id: scope.threadId, selection: json(selection.selection), override: json(selection.override), revision: selection.revision },
      skills: this.#options.effectiveSkills(scope.turnId).map(lockView), mcp: { configured: Boolean(mcp), selected },
      ...(this.#options.memoryServiceStatus ? { memoryService: this.#options.memoryServiceStatus() } : {}),
      approvalPolicy: json(store.getBotApprovalPolicy(scope.botId)), effectiveApprovalPolicy:json(store.getEffectiveApprovalPolicy(scope.threadId)),
      approvalTypes:json(store.listApprovalTypes(scope.botId)), approvalBoundary:"host_harness_only_native_provider_approval_unchanged", approvalPolicyChange: "human_only",
      executionAccess: json(store.getBotExecutionAccess(scope.botId)), executionAccessChange: "human_only",
      operations: this.listTools(cap.token).filter(view => view.connectionId === HARNESS_OPERATION_DESTINATION).map(view => view.name),
      changesApplyNextTurn: true, credentialsInOwnerSettings: true };
  }
  #remove(key: string, cap: Capability): void {
    this.#capabilities.delete(key); for (const controller of cap.controllers) controller.abort(); this.#options.base.revokeCapability(cap.token);
  }
  revokeCapability(token: string): void { if (typeof token !== "string") return; const key = sha(token), cap = this.#capabilities.get(key); if (cap) this.#remove(key,cap); }
  stopAdmission(): void { this.#options.store.stopApprovedExecutions(undefined,HARNESS_OPERATION_DESTINATION); this.#stopped = true; for (const [key,cap] of this.#capabilities) this.#remove(key,cap); for (const controller of this.#ownerControllers) controller.abort(); }
  close(): Promise<void> { this.stopAdmission(); return this.#closing ??= Promise.allSettled([...this.#calls, ...this.#executions.values()]).then(() => undefined); }
}
