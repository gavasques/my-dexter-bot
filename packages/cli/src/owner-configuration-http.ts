import { MemoryLearningCommandSchema, type MemoryLearningCommand } from '@dexter/contracts';
import { MemoryLearningStore, MEMORY_LEARNING_DESTINATION, memoryLearningTool } from '@dexter/context';
import { createHash, randomUUID } from "node:crypto";
import { IdSchema, McpInstanceSelectionInputSchema, McpInstanceSelectionPlanSchema, MemoryRoutinePolicyInputSchema,
  type Action, type JsonValue } from "@dexter/contracts";
import { canonicalJson, HostError, type HostStore } from "@dexter/hub";
import type { HostOwnerConfigurationPort } from "@dexter/hub/http";
import type { NativeMcpAdmin } from "@dexter/connectors";
import { MEMORY_ROUTINE_DESTINATION, MEMORY_ROUTINE_POLICY_TOOL, type MemoryRoutineStore } from "@dexter/context";

const HARNESS="dexter-harness-owner-proposals",SESSION_TTL=30*60_000,MAX_SESSIONS=64;
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
const json=(value:unknown):JsonValue=>JSON.parse(JSON.stringify(value)) as JsonValue;
const uuid=(value:unknown):value is string=>typeof value==="string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
const digest=(value:unknown):value is string=>typeof value==="string" && /^[0-9a-f]{64}$/.test(value);
function object(raw:unknown,fields:string[]):Record<string,unknown> {
  if(!raw || typeof raw!=="object" || Array.isArray(raw) || Object.keys(raw).sort().join(",")!==[...fields].sort().join(","))
    throw new HostError("invalid_input","Invalid owner configuration request.");
  return raw as Record<string,unknown>;
}
type Operation=`memory.learning.${MemoryLearningCommand["operation"]}`|"mcp.select_instances"|"memory.policy.update"|"memory.capture.propose"|"memory.maintenance.propose";
export interface OwnerConfigurationSession {
  sessionID:string;hostID:string;ownerID:string;botID:string;profileID:string;botRevision:number;windowID:string;expiresAt:number;
}
interface Options {
  store:HostStore;
  admitted():void;
  proposalsAvailable():boolean;
  mcp():Readonly<NativeMcpAdmin>;
  routines():MemoryRoutineStore;
  learning?():MemoryLearningStore;
  learningExtractorConfigured?(botId:string):boolean;
  learningBackendAvailable?(botId:string):boolean;
  extractorConfigured():boolean;
  extractorKind():"literal_excerpt"|"injected"|"unconfigured";
}

/** Borrowed owner HTTP facade. Sessions are finite host/window identities, never model capabilities or grants.
 * Proposals persist real human input + canonical action/tool lineage. No engine/provider/credential port is called. */
export class OwnerConfigurationHttp implements HostOwnerConfigurationPort {
  readonly #sessions=new Map<string,Readonly<OwnerConfigurationSession>>();
  constructor(readonly options:Options) {}
  stopAdmission():void { this.#sessions.clear(); }
  #own(sessionId:string,mutation=false):Readonly<OwnerConfigurationSession> {
    this.options.admitted();
    const store=this.options.store,current=this.#sessions.get(IdSchema.parse(sessionId));
    if(!current || current.expiresAt<=store.now() || current.hostID!==store.hostId || current.ownerID!==store.ownerId)
      throw new HostError("forbidden","Owner configuration session expired or changed.");
    const bot=store.getBot(current.botID);
    if(bot.ownerId!==current.ownerID || mutation && (bot.revision!==current.botRevision || bot.profileId!==current.profileID))
      throw new HostError("conflict","Owner configuration bot changed.");
    return current;
  }
  open(botId:string,raw:unknown):OwnerConfigurationSession {
    this.options.admitted();
    const input=object(raw,["expectedHostID","expectedOwnerID","expectedBotRevision","windowID"]),store=this.options.store,bot=store.getBot(botId);
    if(!uuid(input.windowID) || !Number.isSafeInteger(input.expectedBotRevision) || Number(input.expectedBotRevision)<0)
      throw new HostError("invalid_input","Invalid owner configuration window.");
    if(input.expectedHostID!==store.hostId || input.expectedOwnerID!==store.ownerId || bot.ownerId!==store.ownerId
      || input.expectedBotRevision!==bot.revision)throw new HostError("conflict","Owner configuration identity changed.");
    for(const [id,s] of this.#sessions)if(s.expiresAt<=store.now())this.#sessions.delete(id);
    // Retiring an older same-window session prevents stale callbacks from admitting a second intention.
    for(const [id,s] of this.#sessions)if(s.windowID===input.windowID)this.#sessions.delete(id);
    if(this.#sessions.size>=MAX_SESSIONS)throw new HostError("conflict","Owner configuration session limit reached.");
    const result:OwnerConfigurationSession={sessionID:randomUUID(),hostID:store.hostId,ownerID:store.ownerId,botID:bot.id,
      profileID:bot.profileId,botRevision:bot.revision,windowID:input.windowID,expiresAt:store.now()+SESSION_TTL};
    this.#sessions.set(result.sessionID,Object.freeze(result));return {...result};
  }

  #learning():MemoryLearningStore {if(!this.options.learning)throw new HostError('device_unavailable','Memory learning service unavailable.');return this.options.learning();}
  memoryLearningStatus(id:string):unknown {const s=this.#own(id);return this.#call(()=>this.#learning().status(s.botID,this.options.learningExtractorConfigured?.(s.botID)??false,this.options.learningBackendAvailable?.(s.botID)??false));}
  memoryLearningCandidates(id:string):unknown {const s=this.#own(id);return this.#call(()=>({items:this.#learning().candidates(s.botID)}));}
  memoryLearningRecords(id:string):unknown {const s=this.#own(id);return this.#call(()=>({items:this.#learning().records(s.botID)}));}
  memoryLearningJobs(id:string):unknown {const s=this.#own(id);return this.#call(()=>({items:this.#learning().jobs(s.botID)}));}
  memoryLearningPropose(id:string,raw:unknown):Action {
    const request=object(raw,['clientRequestId','command']),command=MemoryLearningCommandSchema.parse(request.command),operation=('memory.learning.'+command.operation) as Operation;
    return this.#propose(id,operation,request.clientRequestId,command,(s,turnId)=>this.#learning().propose(s.botID,turnId,String(request.clientRequestId),command),s=>this.#learning().validateCommand(s.botID,command));
  }
  memoryLearningReceipt(id:string,actionId:string):unknown {const s=this.#own(id),action=this.#scopedAction(s,actionId);if(action.request.destination!==MEMORY_LEARNING_DESTINATION)throw new HostError('forbidden','Memory learning action required.');return this.#call(()=>({action,receipt:this.#learning().receipt(s.botID,action.id)}));}
  memoryLearningRequest(id:string,clientRequestId:string):unknown {const s=this.#own(id),action=this.#find(s,IdSchema.parse(clientRequestId));if(!action)return {action:null,command:null,clientRequestId};const original=this.#scopedAction(s,action.id);if(original.request.destination!==MEMORY_LEARNING_DESTINATION)throw new HostError('forbidden','Memory learning request required.');return {action:original,command:MemoryLearningCommandSchema.parse(original.request.arguments.command),clientRequestId};}
  mcpSelection(id:string):unknown { const s=this.#own(id);return this.#call(()=>this.options.mcp().instanceSelectionReview(s.botID)); }
  mcpCatalog(id:string,serverId:string):unknown {
    const s=this.#own(id);return this.#call(()=>{
      const mcp=this.options.mcp(),review=mcp.instanceSelectionReview(s.botID),instance=review.instances.find(x=>x.serverId===serverId);
      if(!instance)throw new HostError("forbidden","MCP instance is not selectable in this owner session.");
      const tools=mcp.tools(serverId);if(tools.length>256)throw new HostError("conflict","MCP catalog exceeds selection bounds.");
      return {instance,tools,inventoryPin:review.inventoryPin,selectionPin:review.selectionPin,revision:review.revision};
    });
  }
  mcpPlan(id:string,raw:unknown):unknown {
    const s=this.#own(id);const input=McpInstanceSelectionInputSchema.parse(raw);
    return this.#call(()=>this.options.mcp().materializeInstanceSelection(s.botID,input));
  }
  mcpPropose(id:string,raw:unknown):Action {
    const request=object(raw,["clientRequestId","plan"]),plan=McpInstanceSelectionPlanSchema.parse(request.plan);
    return this.#propose(id,"mcp.select_instances",request.clientRequestId,request.plan,(s,turnId)=>{
      const mcp=this.options.mcp();
      const current=mcp.materializeInstanceSelection(s.botID,{mode:plan.mode,expectedInventoryPin:plan.inventoryPin,
        expectedSelectionPin:plan.selectionPin,expectedRevision:plan.expectedRevision,
        instances:plan.targets.map(t=>({serverId:t.serverId,toolIds:t.toolIds}))});
      if(canonicalJson(json(current))!==canonicalJson(json(plan)))throw new HostError("conflict","MCP selection plan changed.");
      return this.#action(s,turnId,"dexter.harness.mcp.select_instances",HARNESS,{selectionPlan:json(plan)},
        {inventoryPin:plan.inventoryPin,selectionPin:plan.selectionPin,revision:plan.expectedRevision,planHash:sha(canonicalJson(json(plan)))});
    },s=>{
      // Validate before creating any human turn/action/grant. A stale review produces no selection mutation.
      const current=this.options.mcp().materializeInstanceSelection(s.botID,{mode:plan.mode,expectedInventoryPin:plan.inventoryPin,
        expectedSelectionPin:plan.selectionPin,expectedRevision:plan.expectedRevision,instances:plan.targets.map(t=>({serverId:t.serverId,toolIds:t.toolIds}))});
      if(canonicalJson(json(current))!==canonicalJson(json(plan)))throw new HostError("conflict","MCP selection plan changed.");
    });
  }
  mcpReceipt(id:string,actionId:string):unknown {
    const s=this.#own(id),action=this.#scopedAction(s,actionId,"mcp.select_instances");
    const selection=["running","succeeded","unknown","blocked"].includes(action.state) && action.decidedBy===s.ownerID
      ? this.#call(()=>this.options.mcp().instanceSelectionReceipt(action.id)) : null;
    return {action,selection};
  }
  memoryPolicy(id:string):unknown { const s=this.#own(id);return this.#call(()=>this.options.routines().status(s.botID,this.options.extractorConfigured(),this.options.extractorKind())); }
  memoryPolicyPropose(id:string,raw:unknown):Action {
    const request=object(raw,["clientRequestId","input"]),input=MemoryRoutinePolicyInputSchema.parse(request.input);
    return this.#propose(id,"memory.policy.update",request.clientRequestId,request.input,(s,turnId)=>{
      const current=this.options.routines().policy(s.botID),bot=this.options.store.getBot(s.botID);
      if(current.revision!==input.expectedRevision)throw new HostError("conflict","Memory policy changed.");
      return this.#action(s,turnId,MEMORY_ROUTINE_POLICY_TOOL,MEMORY_ROUTINE_DESTINATION,json(input),
        {revision:current.revision,epoch:current.epoch,botRevision:bot.revision,profileId:bot.profileId});
    },s=>{if(this.options.routines().policy(s.botID).revision!==input.expectedRevision)throw new HostError("conflict","Memory policy changed.");});
  }
  memoryPolicyReceipt(id:string,actionId:string):unknown {
    const s=this.#own(id),action=this.#scopedAction(s,actionId,"memory.policy.update");
    return {action,policyReceipt:this.#call(()=>this.options.routines().policyReceipt(s.botID,action.id))};
  }
  memoryJobs(id:string,limit?:number):unknown { const s=this.#own(id);return this.#call(()=>({items:this.options.routines().jobs(s.botID,limit)})); }
  memoryJob(id:string,jobId:string):unknown {
    const s=this.#own(id);if(!digest(jobId))throw new HostError("invalid_input","Invalid memory candidate selector.");
    return this.#call(()=>{
      const routines=this.options.routines(),job=routines.job(s.botID,jobId),documents=job.actionId===null?null:routines.documents.receipt(s.botID,`action:${job.actionId}`);
      return {job:{...job,state:documents?"committed":job.state},documents};
    });
  }
  memoryCapturePropose(id:string,raw:unknown):Action {
    const request=object(raw,["clientRequestId","jobId"]);
    if(!digest(request.jobId))throw new HostError("invalid_input","Invalid memory candidate selector.");
    const jobId=request.jobId;
    return this.#propose(id,"memory.capture.propose",request.clientRequestId,{jobId},(s,turnId)=>
      this.options.routines().propose(s.botID,turnId,"owner-settings",{jobId}),s=>{
        const job=this.options.routines().job(s.botID,jobId);
        if(job.actionId!==null)throw new HostError("conflict","Memory candidate already has a proposal; read its receipt.");
        // The real routine proposal performs its epoch/head/grant checks before any document effect.
      });
  }
  memoryMaintenancePreview(id:string):unknown {
    const s=this.#own(id);return this.#call(()=>{const {after,...preview}=this.options.routines().maintenancePreview(s.botID);return preview;});
  }
  memoryMaintenancePropose(id:string,raw:unknown):Action {
    const request=object(raw,["clientRequestId","input"]),input=object(request.input,["expectedRevision","memoryHash","nextMemoryHash"]);
    if(!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision)<0 || Number(input.expectedRevision)>=Number.MAX_SAFE_INTEGER
      || !digest(input.memoryHash) || !digest(input.nextMemoryHash))throw new HostError("invalid_input","Invalid memory maintenance plan.");
    const plan={expectedRevision:Number(input.expectedRevision),memoryHash:input.memoryHash,nextMemoryHash:input.nextMemoryHash};
    return this.#propose(id,"memory.maintenance.propose",request.clientRequestId,plan,(s,turnId)=>
      this.options.routines().propose(s.botID,turnId,"owner-settings",plan),s=>{
        const preview=this.options.routines().maintenancePreview(s.botID);
        if(preview.expectedRevision!==plan.expectedRevision || preview.memoryHash!==plan.memoryHash || preview.nextMemoryHash!==plan.nextMemoryHash || !preview.removed.length)
          throw new HostError("conflict","Memory maintenance plan changed.");
      });
  }
  requestReceipt(id:string,clientRequestId:string):unknown {
    const s=this.#own(id),request=IdSchema.parse(clientRequestId);
    const action=this.#find(s,request);
    if(action)this.#scopedAction(s,action.id);
    const origin=action?this.options.store.toolActionOrigin(action.id):null;
    return {action,intent:origin?this.options.store.ownerSettingsIntent(origin.turnId):null};
  }
  #key(s:Readonly<OwnerConfigurationSession>,requestId:string):string {
    return "owner_settings_"+sha(canonicalJson({host:s.hostID,owner:s.ownerID,bot:s.botID,window:s.windowID,requestId})).slice(0,48);
  }
  #scopedAction(s:Readonly<OwnerConfigurationSession>,actionId:string,operation?:Operation):Action {
    const store=this.options.store,action=store.getAction(IdSchema.parse(actionId)),origin=store.toolActionOrigin(action.id);
    const marker=origin?store.ownerSettingsIntent(origin.turnId):null;
    if(action.request.botId!==s.botID || !marker || marker.ownerId!==s.ownerID || marker.windowId!==s.windowID
      || operation!==undefined && marker.operation!==operation
      || !origin || action.request.threadId!==store.getTurn(origin.turnId).threadId)
      throw new HostError("forbidden","Receipt belongs to another owner configuration window.");
    const expected=marker.operation.startsWith('memory.learning.')?[memoryLearningTool(MemoryLearningCommandSchema.parse(action.request.arguments.command).operation),MEMORY_LEARNING_DESTINATION]:marker.operation==="mcp.select_instances"?["dexter.harness.mcp.select_instances",HARNESS]
      :marker.operation==="memory.policy.update"?[MEMORY_ROUTINE_POLICY_TOOL,MEMORY_ROUTINE_DESTINATION]
      :marker.operation==="memory.capture.propose"?["dexter.harness.memory.append",HARNESS]
      :["dexter.harness.documents.update",HARNESS];
    if(marker.operation.startsWith('memory.learning.')&&marker.operation!=='memory.learning.'+MemoryLearningCommandSchema.parse(action.request.arguments.command).operation)throw new HostError('forbidden','Memory learning operation changed.');
    if(action.request.tool!==expected[0] || action.request.destination!==expected[1])
      throw new HostError("forbidden","Owner configuration action does not match its original intention.");
    return action;
  }
  #find(s:Readonly<OwnerConfigurationSession>,requestId:string):Action|null {
    const store=this.options.store;
    const threadId="thr_owner_settings_"+sha(canonicalJson({host:s.hostID,owner:s.ownerID,botId:s.botID,windowId:s.windowID}));
    let turn;
    try {turn=store.findTurn(threadId,requestId);}catch(error){if(error instanceof HostError && error.code==="not_found")return null;throw error;}
    if(!turn)return null;
    const marker=store.ownerSettingsIntent(turn.id);
    if(!marker || marker.windowId!==s.windowID || marker.clientRequestId!==requestId)throw new HostError("conflict","Owner configuration lineage changed.");
    const actions=store.toolActionsForOrigin(turn.id);
    if(actions.length>1)throw new HostError("conflict","Owner configuration action lineage is ambiguous.");
    return actions[0]??null;
  }
  #action(s:Readonly<OwnerConfigurationSession>,turnId:string,tool:string,destination:string,input:JsonValue,pin:JsonValue):Action {
    const store=this.options.store,turn=store.getTurn(turnId),marker=store.ownerSettingsIntent(turnId)!;
    const grant=store.getGrant(s.botID,tool,destination);
    if(!grant)store.setProposalGrant({botId:s.botID,tool,destination,policy:"ask"});
    else if(grant.policy!=="ask" || grant.expiresAt!==null && grant.expiresAt<=store.now())throw new HostError("forbidden","Exact owner proposal grant is unavailable.");
    const action=store.requestAction({botId:s.botID,threadId:turn.threadId,tool,destination,
      idempotencyKey:this.#key(s,marker.clientRequestId),arguments:{input,pin}});
    if(action.state!=="awaiting_approval")throw new HostError("forbidden","Owner configuration requires an exact human decision.");
    store.bindToolAction(action.id,turnId,"owner-settings");return action;
  }
  #propose(id:string,operation:Operation,rawRequestId:unknown,input:unknown,
    prepare:(s:Readonly<OwnerConfigurationSession>,turnId:string)=>Action,validate:(s:Readonly<OwnerConfigurationSession>)=>void):Action {
    const s=this.#own(id),requestId=IdSchema.parse(rawRequestId),store=this.options.store,bodyHash=sha(canonicalJson(json({operation,input})));
    return this.#call(()=>{
      // Idempotence is the original logical body/window/namespace, independent of transient session ID.
      const previous=this.#find(s,requestId);
      if(previous){const action=this.#scopedAction(s,previous.id,operation),origin=store.toolActionOrigin(action.id)!;
        if(store.ownerSettingsIntent(origin.turnId)!.bodyHash!==bodyHash)throw new HostError("conflict","Owner configuration request body changed.");return action;}
      this.#own(id,true);
      if(!this.options.proposalsAvailable())throw new HostError("device_unavailable","Owner proposal executor is not configured.");
      validate(s);
      const admission=store.createOwnerSettingsTurn(s.botID,{windowId:s.windowID,clientRequestId:requestId,operation,bodyHash});
      if(!admission.created)throw new HostError("conflict","Original owner admission is unresolved; read its action/receipt.");
      try {
        const action=prepare(s,admission.turn.id);
        // Preserve routine job idempotence: this window/request receipt is the real single tool binding,
        // never a rewritten action key or a second effect. An already-proposed job belongs to its old turn.
        const origin=store.toolActionOrigin(action.id);
        if(!origin || origin.turnId!==admission.turn.id)throw new HostError("conflict","Memory proposal already belongs to another intention.");
        return action;
      } finally {
        if(store.getTurn(admission.turn.id).state==="running")store.finishTurn(admission.turn.id,"completed",null);
      }
    });
  }
  #call<T>(fn:()=>T):T {
    try{return fn();}catch(error){
      if(error instanceof HostError || error instanceof Error && error.name==="ZodError")throw error;
      const code=(error as {code?:unknown})?.code;
      if(["invalid_input","invalid_request"].includes(String(code)))throw new HostError("invalid_input","Owner configuration request refused.");
      if(["forbidden","scope_mismatch","scope_changed"].includes(String(code)))throw new HostError("forbidden","Owner configuration scope refused.");
      if(code==="not_found")throw new HostError("not_found","Owner configuration item absent.");
      if(["unavailable","unavailable_here","catalog_unavailable"].includes(String(code)))throw new HostError("device_unavailable","Owner configuration is unavailable.");
      throw new HostError("conflict","Owner configuration state changed; read the original request and receipt.");
    }
  }
}
