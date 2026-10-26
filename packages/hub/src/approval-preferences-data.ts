import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import { automaticOwnDocumentArguments, ApprovalPreferenceReceiptSchema, ThreadApprovalPolicySchema, ApprovalTypePreferenceSchema,
  ApprovalContextSchema, SetThreadApprovalPolicySchema, DecideApprovalPreferenceSchema, RevokeApprovalTypeSchema,
  type JsonValue } from "@dexter/contracts";
import { HostError } from "./errors.js";

function canonical(value:unknown):string {
  if(value===null || typeof value!=="object")return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
/** Shared by live open and exact Operations import. New authority must retain its receipt chain. */
export function assertApprovalPreferencesData(db:DatabaseSync,hostId:string,ownerId:string):void {
  if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='approval_preference_receipts'").get())return;
  const one=(sql:string,...args:SQLInputValue[])=>db.prepare(sql).get(...args);
  const rows=(sql:string)=>db.prepare(sql).all();
  const fail=():never=>{throw new HostError("conflict","Approval preference authority or receipt is invalid.");};
  const receipts=new Map<string,ReturnType<typeof ApprovalPreferenceReceiptSchema.parse>>();
  const contexts=new Map<string,ReturnType<typeof ApprovalContextSchema.parse>>();
  for(const row of rows("SELECT * FROM approval_preference_receipts")){
    const receipt=ApprovalPreferenceReceiptSchema.parse(JSON.parse(String(row.receipt)));
    const input=receipt.kind==="chat_mode" ? SetThreadApprovalPolicySchema.parse(receipt.input)
      : receipt.kind==="decision" ? DecideApprovalPreferenceSchema.parse(receipt.input) : RevokeApprovalTypeSchema.parse(receipt.input);
    const digest=createHash("sha256").update(canonical({hostId,ownerId,botId:receipt.botId,kind:receipt.kind,targetId:receipt.targetId,input})).digest("hex");
    if(receipt.hostId!==hostId || receipt.ownerId!==ownerId || input.expectedHostId!==hostId || receipt.id!==row.id
      || receipt.botId!==row.bot_id || receipt.clientRequestId!==row.client_request_id || input.clientRequestId!==receipt.clientRequestId
      || digest!==receipt.inputHash || digest!==row.input_hash || receipt.createdAt!==row.created_at
      || !one("SELECT 1 FROM bots WHERE id=? AND owner_id=?",receipt.botId,ownerId))fail();
    if(receipt.kind==="chat_mode"){
      const before=ThreadApprovalPolicySchema.parse(receipt.previous),after=ThreadApprovalPolicySchema.parse(receipt.state);
      const change=SetThreadApprovalPolicySchema.parse(input);
      if(before.revision!==change.expectedRevision || after.revision!==before.revision+1 || after.overrideMode!==change.overrideMode
        || before.threadId!==receipt.targetId || after.threadId!==receipt.targetId || after.receiptId!==receipt.id || after.updatedAt!==receipt.createdAt
        || [before,after].some(p=>p.hostId!==hostId || p.ownerId!==ownerId || p.botId!==receipt.botId)
        || !one("SELECT 1 FROM threads WHERE id=? AND bot_id=?",receipt.targetId,receipt.botId))fail();
    }else if(receipt.kind==="decision"){
      const change=DecideApprovalPreferenceSchema.parse(input),action=one("SELECT * FROM actions WHERE id=? AND bot_id=?",receipt.targetId,receipt.botId);
      const state=receipt.state as {actionId?:JsonValue;requestHash?:JsonValue;decision?:JsonValue;preference?:JsonValue};
      if(!action || action.request_hash!==change.requestHash || state.actionId!==receipt.targetId || state.requestHash!==change.requestHash
        || state.decision!==change.decision || action.decided_by!==ownerId)fail();
      if(change.alwaysAccept){
        const after=ApprovalTypePreferenceSchema.parse(state.preference),before=receipt.previous===null?null:ApprovalTypePreferenceSchema.parse(receipt.previous);
        if(change.decision!=="allow" || after.key!==change.expectedTypeKey || after.revision!==change.expectedPreferenceRevision+1
          || (before?.revision??0)!==change.expectedPreferenceRevision || !after.enabled || after.receiptId!==receipt.id
          || after.botId!==receipt.botId || after.hostId!==hostId || after.ownerId!==ownerId
          || after.tool!==action!.tool || after.destination!==action!.destination || after.grantRevision!==action!.grant_revision)fail();
      }else if(state.preference!==null)fail();
    }else {
      const change=RevokeApprovalTypeSchema.parse(input),before=ApprovalTypePreferenceSchema.parse(receipt.previous),after=ApprovalTypePreferenceSchema.parse(receipt.state);
      if(before.revision!==change.expectedRevision || before.key!==receipt.targetId || after.key!==receipt.targetId || after.enabled
        || after.revision!==before.revision+1 || after.receiptId!==receipt.id || after.updatedAt!==receipt.createdAt
        || canonical({...before,revision:after.revision,enabled:false,receiptId:after.receiptId,updatedAt:after.updatedAt})!==canonical(after))fail();
    }
    for(const id of [...receipt.revocationEffects.blockedActionIds,...receipt.revocationEffects.abortedActionIds])
      if(!one("SELECT 1 FROM actions WHERE id=? AND bot_id=?",id,receipt.botId))fail();
    receipts.set(receipt.id,receipt);
  }
  for(const receipt of receipts.values()){
    if(receipt.previous===null)continue;
    const before=receipt.previous as {revision?:JsonValue;receiptId?:JsonValue;overrideMode?:JsonValue;updatedAt?:JsonValue};
    if(receipt.kind==="chat_mode" && before.revision===0){
      if(before.receiptId!==null || before.overrideMode!==null || before.updatedAt!==0)fail();continue;
    }
    if(receipt.kind==="decision" && !DecideApprovalPreferenceSchema.parse(receipt.input).alwaysAccept)continue;
    const previous=typeof before.receiptId==="string" ? receipts.get(before.receiptId) : null;
    const state=previous?.kind==="decision" ? (previous.state as {preference:JsonValue}).preference : previous?.state;
    if(!previous || canonical(state)!==canonical(receipt.previous))fail();
  }
  for(const row of rows("SELECT * FROM thread_approval_policies")){
    const policy=ThreadApprovalPolicySchema.parse(JSON.parse(String(row.policy))),receipt=policy.receiptId?receipts.get(policy.receiptId):null;
    if(policy.threadId!==row.thread_id || receipt?.kind!=="chat_mode" || canonical(receipt.state)!==canonical(policy))fail();
  }
  for(const row of rows("SELECT * FROM approval_type_preferences")){
    const preference=ApprovalTypePreferenceSchema.parse(JSON.parse(String(row.preference))),receipt=receipts.get(preference.receiptId);
    const state=receipt?.kind==="decision" ? (receipt.state as {preference:JsonValue}).preference : receipt?.state;
    if(preference.key!==row.type_key || preference.botId!==row.bot_id || !receipt || canonical(state)!==canonical(preference))fail();
  }
  for(const row of rows("SELECT * FROM action_approval_contexts")){
    const context=ApprovalContextSchema.parse(JSON.parse(String(row.context))),action=one("SELECT * FROM actions WHERE id=?",String(row.action_id));
    if(!action || context.grantRevision!==action.grant_revision || context.eligible!==(context.reason==="eligible") || context.eligible!==(context.typeKey!==null))fail();
    const tool=String(action!.tool),destination=String(action!.destination),kind=context.eligibility;
    const expected=kind==="files_write" || kind==="device" && tool==="mac.file.append" ? "edits"
      : kind==="terminal" || kind==="cli" ? "commands"
      : kind==="native_mcp_read" || kind==="automation" || kind==="browser_use"
        || kind==="device" && ["mac.file.read","mac.process.probe","mac.browser.read","mac.browser.navigate","mac.browser.close"].includes(tool) ? "routine" : "other";
    if(context.category!==expected)fail();
    if(context.eligible){
      const trusted=kind==="terminal" ? tool==="dexter.harness.terminal.run" && destination==="dexter-harness-owner-proposals"
        : kind==="cli" ? tool==="dexter.harness.cli.run" && destination==="dexter-harness-owner-proposals"
        : kind==="files_write" ? tool==="dexter.harness.files.write" && destination==="dexter-harness-owner-proposals"
        : kind==='own_documents' ? destination==='dexter-harness-owner-proposals' && automaticOwnDocumentArguments(tool,JSON.parse(String(action!.request)).arguments)!==null
        : kind==="automation" ? tool==="dexter.automations.run" && destination==="dexter-automations"
        : kind==="browser_use" ? tool==="dexter.browseruse.run" && destination==="browser-use-cloud"
        : kind==="native_mcp" || kind==="native_mcp_read" ? /^mcp\.[a-z0-9_.-]+$/.test(tool) && !destination.startsWith("dev_")
        : kind==="device" ? destination.startsWith("dev_") && ["mac.file.read","mac.file.append","mac.process.probe","mac.browser.navigate","mac.browser.read","mac.browser.close"].includes(tool) : false;
      const request=JSON.parse(String(action!.request)),pin=request.arguments.pin;
      if(!trusted || !pin || typeof pin!=="object" || Array.isArray(pin))fail();
      const stablePin=Object.fromEntries(Object.entries(pin).filter(([key])=>key!=="turnId")),pinsHash=createHash("sha256").update(canonical(stablePin)).digest("hex");
      const input=request.arguments.input && typeof request.arguments.input==="object" && !Array.isArray(request.arguments.input) ? request.arguments.input : {};
      const boundary=kind==="native_mcp" || kind==="native_mcp_read" ? input : Object.fromEntries(["runtime","cwd","path","tool","scheduleId"].map(key=>[key,input[key]??null]));
      const typeKey=createHash("sha256").update(canonical({hostId,ownerId,botId:request.botId,botRevision:context.botRevision,authorityEpoch:context.authorityEpoch,
        tool,destination,grantRevision:context.grantRevision,pinsHash,boundary,scopeVersion:"d03.execution.v1",eligibility:kind})).digest("hex");
      if(context.pinsHash!==pinsHash || context.typeKey!==typeKey)fail();
      if(kind==='own_documents'){
        const args=automaticOwnDocumentArguments(tool,request.arguments)!,origin=args.origin;
        if(origin.installationId!==hostId || origin.ownerId!==ownerId || origin.botId!==action!.bot_id || origin.threadId!==action!.thread_id
          || !one('SELECT 1 FROM turns WHERE id=? AND bot_id=? AND thread_id=?',origin.turnId,origin.botId,origin.threadId)
          || !one('SELECT 1 FROM bots WHERE id=? AND owner_id=? AND profile_id=?',origin.botId,ownerId,origin.profileId)
          || /^thr_(?:team|group)_/.test(origin.threadId) || one('SELECT 1 FROM group_thread_audiences WHERE thread_id=?',origin.threadId))fail();
      }
    }
    contexts.set(String(row.action_id),context);
  }
  for(const row of rows("SELECT * FROM action_authorizations WHERE source IN ('thread_policy','owner_type')")){
    const action=one("SELECT * FROM actions WHERE id=?",String(row.action_id)),context=contexts.get(String(row.action_id)),receipt=receipts.get(String(row.policy_receipt_id));
    if(!action || !context || !receipt || row.owner_id!==ownerId || action.decided_by!==ownerId || receipt.botId!==action.bot_id
      || row.eligible_scope_version!=="d03.execution.v1")fail();
    if(row.source==="thread_policy"){
      const policy=ThreadApprovalPolicySchema.parse(receipt!.state);
      if(receipt!.kind!=="chat_mode" || policy.threadId!==action!.thread_id || policy.revision!==row.policy_revision || policy.overrideMode===null)fail();
    }else {
      const state=receipt!.kind==="decision" ? (receipt!.state as {preference:JsonValue}).preference : null;
      const preference=ApprovalTypePreferenceSchema.parse(state);
      if(!context!.eligible || preference.key!==context!.typeKey || preference.revision!==row.policy_revision || !preference.enabled)fail();
    }
  }
}
