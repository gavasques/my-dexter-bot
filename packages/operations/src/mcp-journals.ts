import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { ConnectionWorkflowSchema, ConnectionWorkflowRequestSchema, GrantBatchReceiptSchema, McpAuthorizationHandoffInputSchema, McpPrivateInputSchema, McpPrivateInputJournalEnvelopeSchema, McpPrivateInputQuarantineSchema, mcpPrivateStringIsWellFormed, MCP_PRIVATE_INPUT_JOURNAL_LIMITS, type McpPrivateInputQuarantine, type ConnectionWorkflow, type McpPrivateInput, type GrantBatchReceipt } from "@dexter/contracts";
import { checkMcpDefinition, inspectMcpMetadata, MCP_METADATA_CATALOG_LIMITS, MCP_METADATA_DEFINITION_LIMITS, mcpLogicalHost, mcpSetupHash, mcpToolName, validateMcpPrivateInputRequests, type McpMetadataLimits, type McpServerDefinition } from "@dexter/connectors";
import { checkManifest } from "@dexter/gateway";
import { canonicalJson, type Json } from "./canonical.js";
import { all, one, type Identity } from "./schemas.js";
import { fail } from "./errors.js";

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SERVER = /^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
function bad(): never { return fail("reference_broken", "MCP journal metadata or its canonical host references are invalid"); }
const closed = (value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad();
  const result = value as Record<string, unknown>;
  if (keys.some(key => !Object.hasOwn(result, key)) || Object.keys(result).some(key => !keys.includes(key) && !optional.includes(key))) return bad();
  return result;
};
const id = (value: unknown): string => typeof value === "string" && ID.test(value) ? value : bad();
const hash = (value: unknown): string => typeof value === "string" && HASH.test(value) ? value : bad();
const natural = (value: unknown, minimum = 0): number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum ? value : bad();
const list = (value: unknown, maximum = 256): unknown[] => Array.isArray(value) && value.length <= maximum ? value : bad();
const json = (raw: unknown, maximum = MCP_METADATA_DEFINITION_LIMITS.maxBytes, canonical = true, limits:Readonly<McpMetadataLimits>=MCP_METADATA_DEFINITION_LIMITS): unknown => {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > maximum) return bad();
  let value: unknown; try { value = JSON.parse(raw); } catch { return bad(); }
  // Native3 historically writes the closed literal shapes with JSON.stringify. Accept that compact grammar
  // and the sorted canonical grammar, never whitespace, unknown keys or unreviewed metadata.
  if (canonicalJson(value as Json) !== raw && (canonical || JSON.stringify(value) !== raw) || !inspectMcpMetadata(value,[],limits).safe) return bad();
  return value;
};
const ownBot = (db: DatabaseSync, botId: string, ownerId: string): void => {
  if (!one(db, "SELECT id FROM bots WHERE id=? AND owner_id=?", botId, ownerId)) bad();
};

/** These receipts are audit/deduplication records; only Hub.grants remains grant authority. */
function grantReceipt(db: DatabaseSync, raw: unknown, operationId: string, identity: Identity): GrantBatchReceipt {
  const parsed = GrantBatchReceiptSchema.safeParse(json(raw)); if (!parsed.success) bad(); const value = parsed.data;
  if (value.version !== 1 || value.operationId !== operationId || value.hostId !== identity.installationId || value.ownerId !== identity.ownerId) bad();
  hash(value.requestHash); natural(value.createdAt);
  const targets = new Set<string>();
  for (const item of list(value.grants)) {
    const grant = closed(item, ["botId", "tool", "destination", "policy", "expiresAt", "revision"]);
    const botId = id(grant.botId), tool = id(grant.tool), destination = id(grant.destination), revision = natural(grant.revision, 1);
    if (!["allow", "ask", "deny"].includes(String(grant.policy)) || grant.expiresAt !== null && natural(grant.expiresAt) < 0) bad();
    ownBot(db, botId, identity.ownerId);
    const target = JSON.stringify([botId, tool, destination]); if (targets.has(target)) bad(); targets.add(target);
    const current = one(db, "SELECT * FROM grants WHERE bot_id=? AND tool=? AND destination=?", botId, tool, destination);
    if (!current || natural(current.revision, 1) < revision || current.revision === revision && (current.policy !== grant.policy || current.expires_at !== grant.expiresAt)) bad();
  }
  if (mcpSetupHash(value.request) !== value.requestHash) bad();
  return value;
}

function workflowOrigin(db: DatabaseSync, workflow: ConnectionWorkflow, identity: Identity): void {
  const action = one(db, "SELECT * FROM actions WHERE id=?", workflow.actionId);
  const origin = one(db, "SELECT * FROM tool_action_continuations WHERE action_id=?", workflow.actionId);
  const turn = one(db, "SELECT * FROM turns WHERE id=?", workflow.originTurnId);
  const authorization = one(db, "SELECT * FROM action_authorizations WHERE action_id=?", workflow.actionId);
  ownBot(db, workflow.botId, identity.ownerId);
  if (workflow.hostId !== identity.installationId || workflow.id !== `setup_${workflow.actionId}` || !action || !origin || !turn || !authorization
    || action.bot_id !== workflow.botId || action.thread_id !== workflow.threadId || action.decided_by !== identity.ownerId
    || action.destination!=="dexter-harness-owner-proposals"
    || !["dexter.harness.connections.request", "dexter.harness.mcp.authorize"].includes(String(action.tool))
    || authorization.source !== "exact_owner" || authorization.owner_id !== identity.ownerId
    || origin.origin_turn_id !== workflow.originTurnId || turn.bot_id !== workflow.botId || turn.thread_id !== workflow.threadId
    || !one(db, "SELECT id FROM threads WHERE id=? AND bot_id=?", workflow.threadId, workflow.botId)
    || workflow.createdAt > workflow.expiresAt || workflow.selections.some(s => new Set(s.tools.map(t => t.name)).size !== s.tools.length)
    || new Set(workflow.selections.map(s => s.connectionId)).size !== workflow.selections.length) bad();
  const actionRequest=JSON.parse(String(action.request)) as {arguments?:{input?:unknown}};
  if(action.tool==="dexter.harness.mcp.authorize"&&actionRequest.arguments?.input===undefined)bad();
  // First-party proposals retain the exact setup input in the action envelope. Older trusted host seams did
  // not: they remain bounded by the independent owner action/origin and terminal receipt references above.
  if(actionRequest.arguments?.input!==undefined){
    if(action.tool==="dexter.harness.mcp.authorize"){
      // The harness persists its normalized input, not ConnectionWorkflowRequest. Validate the
      // original public contract and derive the workflow identity from the canonical action id.
      const input=closed(actionRequest.arguments.input,["serverId","expectedInstancePin"],["actionId"]);
      const parsed=McpAuthorizationHandoffInputSchema.safeParse({server_id:input.serverId,expected_instance_pin:input.expectedInstancePin,
        ...(input.actionId===undefined?{}:{action_id:input.actionId})});
      if(!parsed.success)bad();
      if(parsed.data.action_id!==undefined){
        const prior=one(db,"SELECT * FROM actions WHERE id=?",parsed.data.action_id),authority=one(db,"SELECT * FROM action_authorizations WHERE action_id=?",parsed.data.action_id);
        if(!prior||!authority||prior.bot_id!==workflow.botId||prior.thread_id!==workflow.threadId||prior.state!=="succeeded"||prior.decided_by!==identity.ownerId
          ||prior.destination!=="dexter-harness-owner-proposals"||authority.source!=="exact_owner"||authority.owner_id!==identity.ownerId
          ||!["dexter.harness.mcp.add","dexter.harness.mcp.add_http","dexter.harness.mcp.discover"].includes(String(prior.tool)))bad();
        const result=JSON.parse(String(prior.result)) as {server?:{id?:unknown};instancePin?:unknown};
        if(result.server?.id!==parsed.data.server_id||result.instancePin!==parsed.data.expected_instance_pin)bad();
      }
      const digest=createHash("sha256").update(String(action.id)).digest("hex");
      const clientRequestId=`${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
      const target={kind:"native_mcp",serverId:parsed.data.server_id,instancePin:parsed.data.expected_instance_pin};
      if(workflow.clientRequestId!==clientRequestId||canonicalJson(target)!==canonicalJson(workflow.target as Json))bad();
    }else{
      const request=ConnectionWorkflowRequestSchema.safeParse(actionRequest.arguments.input);
      if(!request.success||mcpSetupHash(request.data)!==workflow.requestHash||request.data.clientRequestId!==workflow.clientRequestId
        ||canonicalJson(request.data.target as Json)!==canonicalJson(workflow.target as Json))bad();
    }
  }
  if (workflow.continuationTurnId === null) {
    if (workflow.state === "ready" || workflow.selections.length !== 0) bad();
  } else {
    const continuation = one(db, "SELECT * FROM turns WHERE id=?", workflow.continuationTurnId);
    if (!continuation || continuation.bot_id !== workflow.botId || continuation.thread_id !== workflow.threadId
      || continuation.client_request_id !== `connection-setup-${workflow.id}` || continuation.input_message_id !== turn.input_message_id
      || continuation.input_hash !== turn.input_hash || workflow.selections.length === 0 || !["ready", "stopped", "conflict"].includes(workflow.state)) bad();
  }
  if (workflow.state === "awaiting_user" && workflow.revision !== 1 || ["ready", "cancelled"].includes(workflow.state) && workflow.revision !== 2) bad();
}

// This is the only widened journal family. Workflow/grant/native metadata admission remains unchanged.
const privateInputJournalJson=(raw:unknown):unknown=>json(raw,MCP_PRIVATE_INPUT_JOURNAL_LIMITS.maxBytes,true,{
  maxBytes:MCP_PRIVATE_INPUT_JOURNAL_LIMITS.metadataBytes,maxNodes:MCP_PRIVATE_INPUT_JOURNAL_LIMITS.metadataNodes,maxDepth:MCP_PRIVATE_INPUT_JOURNAL_LIMITS.metadataDepth});
type PrivateEnvelope=Omit<McpPrivateInput,"requests">&{requests:unknown};
function privateInputOrigin(db:DatabaseSync,input:PrivateEnvelope,identity:Identity):void {
  const action=one(db,"SELECT * FROM actions WHERE id=?",input.actionId);ownBot(db,input.botId,identity.ownerId);
  if(!action||action.bot_id!==input.botId||action.thread_id!==input.threadId||action.destination!==input.connectionId
    ||action.request_hash!==input.requestHash||!one(db,"SELECT id FROM threads WHERE id=? AND bot_id=?",input.threadId,input.botId)
    ||input.createdAt>input.expiresAt||input.state==="pending"&&(input.revision!==1||input.responseHash!==null||input.clientRequestId!==null)
    ||input.state!=="pending"&&input.revision!==2||(input.responseHash===null)!==(input.clientRequestId===null)
    ||["answered","declined","cancelled"].includes(input.state)&&input.responseHash===null)bad();
}
function escapedEndAnchor(pattern:unknown):boolean {
  if(typeof pattern!=="string"||!pattern.startsWith("^")||!pattern.endsWith("$"))return false;
  let slashes=0;for(let i=pattern.length-2;i>=0&&pattern[i]==="\\";i--)slashes++;
  return slashes%2===1;
}
/** Only the four proven historical admission bugs can be quarantined. All other corruption still fails closed.
 * Repair below is an in-memory classification probe, never a stored or executable rewritten contract. */
function privateInputRow(db:DatabaseSync,raw:unknown,keyId:string,identity:Identity):{input:PrivateEnvelope;reason:McpPrivateInputQuarantine["reason"]|null}{
  const parsed=McpPrivateInputJournalEnvelopeSchema.safeParse(privateInputJournalJson(raw));
  if(!parsed.success||parsed.data.id!==keyId)bad();
  const input=parsed.data as PrivateEnvelope;privateInputOrigin(db,input,identity);
  if(!input.requests||typeof input.requests!=="object"||Array.isArray(input.requests))bad();
  const entries=Object.entries(input.requests);if(entries.length>8||entries.some(([key])=>!ID.test(key)))bad();
  // Opaque provider metadata and answers were never legitimate journal content, even for a historical bad form.
  for(const [,request]of entries){const value=closed(request,["method","params"]);closed(value.params,["message","requestedSchema"],["mode"]);}
  try{validateMcpPrivateInputRequests(input.requests);if(!McpPrivateInputSchema.safeParse(input).success)bad();return{input,reason:null};}catch{/* classify narrowly below */}
  if(!entries.length)return{input,reason:"lost_request_keys"};
  let reason:McpPrivateInputQuarantine["reason"]|null=null;
  const used=new Set<number>();
  const collect=(v:unknown):void=>{if(typeof v==="string")for(const char of v)used.add(char.codePointAt(0)!);else if(Array.isArray(v))v.forEach(collect);else if(v&&typeof v==="object")for(const[k,value]of Object.entries(v)){collect(k);collect(value);}};collect(input.requests);
  const replacements=new Map<number,string>();let candidate=0xe000;
  const repairString=(text:string):string=>{
    if(mcpPrivateStringIsWellFormed(text))return text;
    reason??="ill_formed_unicode";let out="";
    for(let i=0;i<text.length;i++){
      const unit=text.charCodeAt(i),next=text.charCodeAt(i+1);
      if(unit>=0xd800&&unit<=0xdbff&&next>=0xdc00&&next<=0xdfff){out+=text[i]!+text[++i]!;continue;}
      if(unit>=0xd800&&unit<=0xdfff){if(!replacements.has(unit)){while(used.has(candidate)&&candidate<=0xf8ff)candidate++;if(candidate>0xf8ff)bad();replacements.set(unit,String.fromCharCode(candidate));used.add(candidate++);}out+=replacements.get(unit)!;}
      else out+=text[i]!;
    }
    return out;
  };
  const repair=(v:unknown):unknown=>typeof v==="string"?repairString(v):Array.isArray(v)?v.map(repair):v&&typeof v==="object"?Object.fromEntries(Object.entries(v).map(([k,value])=>[repairString(k),repair(value)])):v;
  const occupied=new Set(entries.map(([key])=>key));
  const probe=Object.fromEntries(entries.map(([key,value],i)=>{
    if(["__proto__","prototype","constructor"].includes(key)){reason??="reserved_request_key";let temporary=`r6-historical-${i}`;while(occupied.has(temporary))temporary+="-";occupied.add(temporary);key=temporary;}
    return[key,repair(value)];
  }));
  for(const request of Object.values(probe)){
    const params=(request as {params:Record<string,unknown>}).params,schema=params.requestedSchema as {properties?:Record<string,Record<string,unknown>>};
    if(schema&&typeof schema==="object"&&schema.properties&&typeof schema.properties==="object")for(const field of Object.values(schema.properties)){
      if(field&&typeof field==="object"&&escapedEndAnchor(field.pattern)){reason??="escaped_end_anchor";field.pattern=String(field.pattern)+"$";}
    }
  }
  if(reason===null)bad();
  try{validateMcpPrivateInputRequests(probe);}catch{return bad();}
  return{input,reason};
}
function quarantinedInput(db:DatabaseSync,raw:unknown,keyId:string,identity:Identity):McpPrivateInputQuarantine{
  const parsed=McpPrivateInputQuarantineSchema.safeParse(json(raw,65_536));if(!parsed.success||parsed.data.id!==keyId)bad();
  const q=parsed.data;privateInputOrigin(db,{...q,state:q.previousState,revision:q.previousRevision,requests:{}},identity);return q;
}

/** Closed families in Hub16.meta. Unknown lookalikes never enter the admitted key list. Reads cause no writes. */
export function validateHubMcpJournals(db: DatabaseSync, identity: Identity): string[] {
  const admitted: string[] = [], workflows = new Map<string, ConnectionWorkflow>(), inputs = new Map<string, McpPrivateInput>(), workflowReceipts=new Set<string>();
  const rows = all(db, "SELECT key,value FROM meta");
  if (rows.length > 50_000) bad();
  for (const row of rows) {
    const key = String(row.key);
    let match = /^grant_batch_v1:([A-Za-z0-9_.:-]{1,128})$/.exec(key);
    if (match) { grantReceipt(db, row.value, match[1]!, identity); admitted.push(key); continue; }
    match = /^connection_setup_v1:([A-Za-z0-9_.:-]{1,128})$/.exec(key);
    if (match) {
      const parsed = ConnectionWorkflowSchema.safeParse(json(row.value, 65_536)); if (!parsed.success || parsed.data.id !== match[1]) bad();
      workflowOrigin(db, parsed.data, identity); workflows.set(parsed.data.id, parsed.data); admitted.push(key); continue;
    }
    match = /^mcp_private_input_v1:([A-Za-z0-9_.:-]{1,128})$/.exec(key);
    if(match){
      const {input}=privateInputRow(db,row.value,match[1]!,identity);if(inputs.has(input.id))bad();
      inputs.set(input.id,input as McpPrivateInput);admitted.push(key);continue;
    }
    match=/^mcp_private_quarantine_v1:([A-Za-z0-9_.:-]{1,128})$/.exec(key);
    if(match){
      const q=quarantinedInput(db,row.value,match[1]!,identity);if(inputs.has(q.id))bad();
      inputs.set(q.id,{...q,state:q.previousState,revision:q.previousRevision,requests:{}});admitted.push(key);
    }
  }
  for (const row of rows) {
    const key = String(row.key);
    let match = /^connection_setup_request_v1:([0-9a-f-]{36})$/.exec(key);
    if (match) {
      if (!UUID.test(match[1]!) || typeof row.value !== "string" || workflows.get(row.value)?.clientRequestId !== match[1]) bad();
      admitted.push(key); continue;
    }
    match = /^connection_setup_turn_v1:([A-Za-z0-9_.:-]{1,128})$/.exec(key);
    if (match) {
      if (typeof row.value !== "string" || workflows.get(row.value)?.continuationTurnId !== match[1]) bad(); admitted.push(key); continue;
    }
    match = /^connection_setup_receipt_v1:([0-9a-f-]{36})$/.exec(key);
    if (match) {
      if (!UUID.test(match[1]!)) bad(); const receipt = closed(json(row.value, 65_536), ["hash", "workflow"]); hash(receipt.hash);
      const parsed = ConnectionWorkflowSchema.safeParse(receipt.workflow); if (!parsed.success) bad(); const w = parsed.data, head = workflows.get(w.id);
      workflowOrigin(db, w, identity);
      if (!head || !["ready", "cancelled"].includes(w.state) || w.revision !== 2 || w.requestHash !== head.requestHash
        || w.actionId !== head.actionId || w.revision > head.revision || w.continuationTurnId !== head.continuationTurnId
        || canonicalJson(w.target as Json) !== canonicalJson(head.target as Json) || canonicalJson(w.selections as Json) !== canonicalJson(head.selections as Json)) bad();
      if(canonicalJson({...head,state:w.state,revision:w.revision} as Json)!==canonicalJson(w as Json)||workflowReceipts.has(w.id))bad();
      workflowReceipts.add(w.id);
      const input = { expectedHostID: identity.installationId, clientRequestId: match[1]!, expectedRevision: w.revision - 1,
        ...(w.state === "ready" ? { selections: w.selections } : {}) };
      if (mcpSetupHash({ kind: w.state === "ready" ? "complete" : "cancel", id: w.id, input }) !== receipt.hash) bad();
      admitted.push(key); continue;
    }
    match = /^mcp_private_response_v1:([0-9a-f-]{36})$/.exec(key);
    if (match) {
      if (!UUID.test(match[1]!) || typeof row.value !== "string" || inputs.get(row.value)?.clientRequestId !== match[1]) bad(); admitted.push(key);
    }
  }
  for (const w of workflows.values()) {
    if (one(db, "SELECT value FROM meta WHERE key=?", `connection_setup_request_v1:${w.clientRequestId}`)?.value !== w.id
      || w.continuationTurnId !== null && one(db, "SELECT value FROM meta WHERE key=?", `connection_setup_turn_v1:${w.continuationTurnId}`)?.value !== w.id
      || ["ready","cancelled"].includes(w.state)&&!workflowReceipts.has(w.id)) bad();
  }
  const responseIds = new Set<string>();
  for (const input of inputs.values()) if (input.clientRequestId !== null) {
    if (responseIds.has(input.clientRequestId) || one(db, "SELECT value FROM meta WHERE key=?", `mcp_private_response_v1:${input.clientRequestId}`)?.value !== input.id) bad(); responseIds.add(input.clientRequestId);
  }
  return admitted;
}

type NativeIntent = { version: 1; operationId: string; serverId: string; instancePin: string; state: "prepared" | "completed" | "interrupted";
  changes: {botId: string; toolIds: string[]}[]; catalog: unknown[] | null; grants: {botId: string; tool: string; destination: string; expectedRevision: number; policy: "ask" | "deny"; expiresAt: null}[] };

/** Catalog and intent aggregate scans share Native's 64 MiB bound; each stored definition keeps its 256 KiB bound.
 * Encoded JSON is also bounded, independently of metadata string/node accounting and the artifact's 128 MiB DB cap. */
export function validateNativeMcpCatalogMetadata(value:unknown):void {
  const definitions=list(value);
  if(Buffer.byteLength(canonicalJson(definitions as Json),"utf8")>MCP_METADATA_CATALOG_LIMITS.maxBytes
    ||!inspectMcpMetadata(definitions,[],MCP_METADATA_CATALOG_LIMITS).safe)bad();
  for(const definition of definitions)if(!inspectMcpMetadata(definition,[],MCP_METADATA_DEFINITION_LIMITS).safe)bad();
}

function tools(value: unknown, serverId: string): void {
  validateNativeMcpCatalogMetadata(value);
  const seen = new Set<string>();
  for (const item of list(value)) {
    const tool = closed(item, ["id", "mcpName", "description", "effect", "state", "manifest", "argumentNames"]);
    if (typeof tool.mcpName !== "string" || tool.id !== mcpToolName(serverId, tool.mcpName) || seen.has(String(tool.id))
      || typeof tool.description !== "string" || tool.description.length > 1024 || !["read", "write"].includes(String(tool.effect))
      || !["publishable", "refused_by_policy", "unsupported_schema"].includes(String(tool.state))) bad(); seen.add(String(tool.id));
    if (tool.state !== "publishable") { if (tool.manifest !== null || tool.argumentNames !== null) bad(); continue; }
    const manifest = checkManifest(tool.manifest);
    if(canonicalJson(manifest as unknown as Json)!==canonicalJson(tool.manifest as Json))bad();
    if (manifest.name !== tool.id || manifest.toolkit !== `mcp-${serverId}` || manifest.effect !== tool.effect || !/^[0-9a-f]{32}$/.test(manifest.version)
      || manifest.upstreamHost !== mcpLogicalHost(serverId) || manifest.destinationArgument !== null || manifest.destinationOrigins !== null) bad();
    const properties=manifest.nativeInputSchema?.properties ?? manifest.inputSchema.properties;
    const names = closed(tool.argumentNames, Object.keys(properties as Record<string,unknown>));
    if (Object.values(names).some(value => typeof value !== "string") || new Set(Object.values(names)).size !== Object.values(names).length) bad();
  }
}
function nativeIntent(raw: unknown, operationId: string): NativeIntent {
  const value = closed(json(raw, MCP_METADATA_CATALOG_LIMITS.maxBytes, false,MCP_METADATA_CATALOG_LIMITS), ["version", "operationId", "serverId", "instancePin", "state", "changes", "catalog", "grants"]);
  if (value.version !== 1 || value.operationId !== operationId || !UUID.test(operationId) || typeof value.serverId !== "string" || !SERVER.test(value.serverId)
    || !["prepared", "completed", "interrupted"].includes(String(value.state))) bad(); hash(value.instancePin);
  const botIds = new Set<string>();
  for (const item of list(value.changes)) {
    const change = closed(item, ["botId", "toolIds"]), botId = id(change.botId), names = list(change.toolIds).map(id);
    if (botIds.has(botId) || new Set(names).size !== names.length || names.some(name => !name.startsWith(`mcp.${value.serverId}.`))) bad(); botIds.add(botId);
  }
  const targets = new Set<string>();
  for (const item of list(value.grants)) {
    const grant = closed(item, ["botId", "tool", "destination", "expectedRevision", "policy", "expiresAt"]);
    const key = JSON.stringify([id(grant.botId), id(grant.tool), id(grant.destination)]); natural(grant.expectedRevision);
    if (targets.has(key) || !String(grant.tool).startsWith(`mcp.${value.serverId}.`) || !["ask", "deny"].includes(String(grant.policy)) || grant.expiresAt !== null) bad(); targets.add(key);
  }
  if (value.catalog !== null) tools(value.catalog, value.serverId);
  return value as unknown as NativeIntent;
}

/** Closed metadata under the unchanged Native3 SQL catalog. Circuit state is deliberately not portable. */
export function validateNativeMcpMetadata(db: DatabaseSync): string[] {
  const admitted: string[] = [], servers = new Map<string, McpServerDefinition>();
  for (const row of all(db, "SELECT * FROM servers")) {
    const definition=checkMcpDefinition(JSON.parse(String(row.definition)));
    if(!inspectMcpMetadata(definition).safe || definition.id!==row.id)bad(); servers.set(String(row.id),definition);
  }
  const rows = all(db, "SELECT key,value FROM meta"); if (rows.length > 3 + 256 * 5 + 512) bad();
  let intents = 0;
  for (const row of rows) {
    const key = String(row.key), match = /^(mcp-command|mcp-quarantine|mcp-changes):([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)$/.exec(key);
    if (match) {
      const serverId = match[2]!, definition = servers.get(serverId); if (!definition) bad();
      const value = json(row.value, 256 * 1024, false);
      if (match[1] === "mcp-command") {
        const pin = closed(value, ["realPath", "sha256", "invocationHash"], ["sizeBytes"]);
        if (definition.transport.type !== "stdio" || typeof pin.realPath !== "string" || !isAbsolute(pin.realPath) || pin.realPath.length > 4096 || normalize(pin.realPath) !== pin.realPath || /[\u0000-\u001f\u007f]/.test(pin.realPath)) bad();
        hash(pin.sha256); hash(pin.invocationHash); if (pin.sizeBytes !== undefined && natural(pin.sizeBytes) > 256 * 1024 * 1024) bad();
      } else if (match[1] === "mcp-quarantine") {
        const quarantine = closed(value, ["metadataHash", "observedAt"]); hash(quarantine.metadataHash); natural(quarantine.observedAt);
        if (one(db, "SELECT status FROM servers WHERE id=?", serverId)?.status !== "failed") bad();
      } else {
        const change = closed(value, ["revision", "added", "removed", "changed", "observedAt"]); hash(change.revision); natural(change.observedAt);
        const seen = new Set<string>();
        for (const family of ["added", "removed", "changed"]) for (const value of list(change[family])) {
          const name = id(value); if (!name.startsWith(`mcp.${serverId}.`) || seen.has(name)) bad(); seen.add(name);
        }
      }
      admitted.push(key); continue;
    }
    const intentKey = /^mcp-grants:([0-9a-f-]{36})$/.exec(key);
    if (intentKey) { nativeIntent(row.value, intentKey[1]!); if (++intents > 512) bad(); admitted.push(key); }
  }
  return admitted;
}

/** Validates the native recovery copy against immutable canonical Hub receipts, never grants from that copy. */
export function validateNativeMcpJournalReferences(native: DatabaseSync, hub: DatabaseSync): void {
  const identity = { installationId: String(one(hub, "SELECT value FROM meta WHERE key='host_id'")?.value), ownerId: String(one(hub, "SELECT value FROM meta WHERE key='owner_id'")?.value) };
  for (const row of all(native, "SELECT key,value FROM meta WHERE key GLOB 'mcp-grants:*'")) {
    const intent = nativeIntent(row.value, String(row.key).slice("mcp-grants:".length));
    for (const target of [...intent.changes, ...intent.grants]) ownBot(hub, target.botId, identity.ownerId);
    const receiptRow = one(hub, "SELECT value FROM meta WHERE key=?", `grant_batch_v1:${intent.operationId}`);
    if (!receiptRow) { if (intent.state === "completed" && intent.grants.length) bad(); continue; }
    const receipt = grantReceipt(hub, receiptRow.value, intent.operationId, identity);
    if (receipt.requestHash !== mcpSetupHash({ operationId: intent.operationId, grants: intent.grants }) || receipt.grants.length !== intent.grants.length) bad();
    for (const target of intent.grants) {
      const recorded = receipt.grants.find(g => g.botId === target.botId && g.tool === target.tool && g.destination === target.destination);
      if (!recorded || recorded.policy !== target.policy || recorded.expiresAt !== null || ![target.expectedRevision, target.expectedRevision + 1].includes(recorded.revision)) bad();
    }
  }
}

/** On copies only: pending RPCs and owner setup continuations cannot survive a process/authority transfer. */
export function sanitizeMcpHubJournals(path: string): void {
  const db = new DatabaseSync(path);
  try {
    const update = db.prepare("UPDATE meta SET value=? WHERE key=?");
    const identity={ownerId:String(one(db,"SELECT value FROM meta WHERE key='owner_id'")?.value),installationId:String(one(db,"SELECT value FROM meta WHERE key='host_id'")?.value)};
    db.exec("BEGIN IMMEDIATE");
    try{
      for(const row of all(db,"SELECT key,value FROM meta WHERE key GLOB 'mcp_private_input_v1:*'")){
        const key=String(row.key),id=key.slice("mcp_private_input_v1:".length),{input,reason}=privateInputRow(db,row.value,id,identity);
        if(reason!==null){
          const audit:McpPrivateInputQuarantine={version:1,id:input.id,actionId:input.actionId,requestHash:input.requestHash,connectionId:input.connectionId,botId:input.botId,threadId:input.threadId,
            state:"quarantined",previousState:input.state,previousRevision:input.revision,createdAt:input.createdAt,expiresAt:input.expiresAt,responseHash:input.responseHash,clientRequestId:input.clientRequestId,
            reason,rawHash:createHash("sha256").update(String(row.value)).digest("hex"),quarantinedAt:Date.now()};
          const auditKey=`mcp_private_quarantine_v1:${id}`;
          if(one(db,"SELECT key FROM meta WHERE key=?",auditKey))bad();
          db.prepare("INSERT INTO meta(key,value)VALUES(?,?)").run(auditKey,canonicalJson(audit as unknown as Json));
          db.prepare("DELETE FROM meta WHERE key=?").run(key);
          // Preserve the response index/UUID reservation: it now resolves to the inert audit record.
        }else if(input.state==="pending")update.run(canonicalJson({...input,state:"interrupted",revision:input.revision+1} as Json),key);
      }
      db.exec("COMMIT");
    }catch(error){db.exec("ROLLBACK");throw error;}
    for (const row of all(db, "SELECT key,value FROM meta WHERE key GLOB 'connection_setup_v1:*'")) {
      const workflow = ConnectionWorkflowSchema.parse(json(row.value));
      if (workflow.state === "awaiting_user") update.run(canonicalJson({ ...workflow, state: "stopped", revision: workflow.revision + 1 } as Json), String(row.key));
    }
    db.exec("PRAGMA secure_delete=ON; VACUUM;");
  } finally { db.close(); }
}

/** Prepared recovery copies become interrupted; a receipt GET after restore cannot finish the old selection. */
export function sanitizeNativeMcpMetadata(db: DatabaseSync): void {
  const update = db.prepare("UPDATE meta SET value=? WHERE key=?");
  for (const row of all(db, "SELECT key,value FROM meta WHERE key GLOB 'mcp-grants:*'")) {
    const intent = nativeIntent(row.value, String(row.key).slice("mcp-grants:".length));
    if (intent.state === "prepared") update.run(canonicalJson({ ...intent, state: "interrupted" } as Json), String(row.key));
  }
}

/** Artifact admission, also run before restore publication/nonce use: no process-local wait is portable. */
export function assertMcpCheckpointSafety(hub: DatabaseSync, native?: DatabaseSync): void {
  for(const row of all(hub,"SELECT key,value FROM meta WHERE key GLOB 'connection_setup_v1:*' OR key GLOB 'mcp_private_input_v1:*'")){
    const value=(String(row.key).startsWith("mcp_private_input_v1:")?privateInputJournalJson(row.value):json(row.value)) as {state?:unknown};
    if(value.state==="awaiting_user"||value.state==="pending")fail("corrupt","Checkpoint still carries a pending MCP workflow or private RPC wait");
  }
  const identity={ownerId:String(one(hub,"SELECT value FROM meta WHERE key='owner_id'")?.value),installationId:String(one(hub,"SELECT value FROM meta WHERE key='host_id'")?.value)};
  for(const row of all(hub,"SELECT key,value FROM meta WHERE key GLOB 'mcp_private_input_v1:*'")){
    if(privateInputRow(hub,row.value,String(row.key).slice("mcp_private_input_v1:".length),identity).reason!==null)
      fail("corrupt","Checkpoint still carries malformed private input instead of its inert quarantine audit");
  }
  if(native)for(const row of all(native,"SELECT key,value FROM meta WHERE key GLOB 'mcp-grants:*'")){
    if(nativeIntent(row.value,String(row.key).slice("mcp-grants:".length)).state==="prepared")fail("corrupt","Checkpoint still carries a prepared native MCP grant intent");
  }
}
