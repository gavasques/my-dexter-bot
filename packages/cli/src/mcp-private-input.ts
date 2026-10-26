import { randomUUID, createHash } from "node:crypto";
import { RespondMcpPrivateInputSchema, ToolExecutionFailure, mcpPrivateInputJournalRequests, type McpPrivateInputPageQuery, type McpPrivateInput, type JsonValue } from "@dexter/contracts";
import { validateMcpPrivateInputRequests, validateMcpPrivateInputResponses } from "@dexter/connectors";
import type { AdapterCall, CapabilityGateway } from "@dexter/gateway";
import { HostError, canonicalJson, type HostStore } from "@dexter/hub";

/** One process-local wait within the original running action; restart never replays a remote write. */
export class McpPrivateInputCoordinator {
  readonly #pending=new Map<string,{call:AdapterCall;resolve:(value:Record<string,unknown>)=>void;reject:(error:unknown)=>void;cleanup:()=>void;validateResponse?:((responses:Record<string,unknown>)=>void)|undefined}>();
  constructor(readonly store:HostStore,readonly gateway:()=>CapabilityGateway){}
  authorized(call:AdapterCall):boolean {
    try{const store=this.store,gateway=this.gateway();store.assertActiveWriter();
      if(!call.actionId||!call.requestHash)return false;
      const action=store.getAction(call.actionId),connection=gateway.registry.getConnection(call.connectionId),registered=gateway.registry.getTool(action.request.tool),grant=store.getGrant(action.request.botId,action.request.tool,action.request.destination);
      store.assertTeamTurn(call.scope.turnId);
      return action.state==="running"&&action.requestHash===call.requestHash&&action.request.destination===call.connectionId&&action.request.botId===call.scope.botId&&action.request.threadId===call.scope.threadId
        &&!store.toolOriginStopped(call.scope.turnId)&&connection?.status==="active"&&connection.revision===call.connectionRevision
        &&registered?.status==="active"&&registered.manifestHash===call.manifestHash&&registered.revision===call.toolRevision
        &&grant!==null&&grant.policy!=="deny"&&grant.revision===action.grantRevision&&(grant.expiresAt===null||grant.expiresAt>store.now());
    }catch{return false;}
  }
  request(call:AdapterCall,raw:Record<string,unknown>,signal:AbortSignal,validateResponse?:(responses:Record<string,unknown>)=>void):Promise<Record<string,unknown>> {
    if(!this.authorized(call)||signal.aborted)return Promise.reject(new ToolExecutionFailure("input_required","after_dispatch"));
    const requests=validateMcpPrivateInputRequests(raw),now=this.store.now(),id=`mcpform_${randomUUID()}`;
    // Persist only the safe form definition. Provider metadata and opaque continuation state stay on the live transport.
    const journalRequests=mcpPrivateInputJournalRequests(requests);
    const entry:McpPrivateInput={version:1,id,actionId:call.actionId!,requestHash:call.requestHash!,connectionId:call.connectionId,botId:call.scope.botId,threadId:call.scope.threadId,
      revision:1,state:"pending",requests:journalRequests as Record<string,JsonValue>,createdAt:now,expiresAt:now+300_000,responseHash:null,clientRequestId:null};
    const recorded=this.store.recordMcpPrivateInput(entry);
    if(Object.keys(recorded.requests).sort().join("\0")!==Object.keys(requests).sort().join("\0")
      ||canonicalJson(recorded.requests)!==canonicalJson(journalRequests as Record<string,JsonValue>))
      throw new HostError("conflict","MCP input record differs from the validated requests.");
    return new Promise((resolve,reject)=>{
      const abort=()=>{this.#finish(id,"interrupted");};
      const timer=setTimeout(()=>{this.#finish(id,"expired");},300_000);timer.unref();
      let cleaned=false;
      const cleanup=()=>{if(cleaned)return;cleaned=true;clearTimeout(timer);signal.removeEventListener("abort",abort);this.#pending.delete(id);};
      this.#pending.set(id,{call,resolve,reject,cleanup,validateResponse});signal.addEventListener("abort",abort,{once:true});
      if(signal.aborted)abort();
    });
  }
  list(){
    const snapshot=this.store.mcpPrivateInputList(),requests:McpPrivateInput[]=[];
    let invalidRequestCount=snapshot.invalidRequestCount;
    for(const input of snapshot.requests){try{validateMcpPrivateInputRequests(input.requests);requests.push(input);}catch{invalidRequestCount++;}}
    return{...snapshot,requests,invalidRequestCount,incomplete:snapshot.incomplete||invalidRequestCount>0};
  }
  page(query:McpPrivateInputPageQuery={}){return this.store.mcpPrivateInputPage(query,[...this.#pending.keys()]);}
  get(id:string){
    const input=this.store.mcpPrivateInput(id);
    if(input)try{validateMcpPrivateInputRequests(input.requests);}catch{throw new HostError("conflict","MCP form is unavailable; its body could not be validated.");}
    return input;
  }
  #finish(id:string,state:McpPrivateInput["state"]){
    const pending=this.#pending.get(id);if(!pending)return null;
    // Release process-local custody exactly once BEFORE touching a writer that may already be fenced/closed.
    pending.cleanup();
    try{const old=this.store.mcpPrivateInput(id);return old?this.store.recordMcpPrivateInput({...old,state,revision:old.revision+1}):null;}
    catch{return null;} // A lost writer cannot finish the journal, authorize an effect, or escape a timer/listener.
    finally{pending.reject(new ToolExecutionFailure("input_required","after_dispatch"));}
  }
  respond(id:string,raw:unknown):McpPrivateInput {
    const input=RespondMcpPrivateInputSchema.parse(raw),entry=this.get(id),pending=this.#pending.get(id);
    if(!entry)throw new HostError("not_found","MCP input not found.");
    if(input.expectedHostID!==this.store.hostId||input.actionId!==entry.actionId||input.requestHash!==entry.requestHash)throw new HostError("forbidden","MCP input origin differs.");
    const responses=validateMcpPrivateInputResponses(entry.requests,input.responses),responseHash=createHash("sha256").update(canonicalJson({id,input} as unknown as JsonValue)).digest("hex");
    const responseOwner=this.store.mcpPrivateInputResponseOwner(input.clientRequestId);
    if(responseOwner!==null&&responseOwner!==id)throw new HostError("conflict","MCP response belongs to another input.");
    if(entry.clientRequestId===input.clientRequestId){if(entry.responseHash!==responseHash)throw new HostError("conflict","MCP response differs.");return entry;}
    if(entry.state!=="pending"||entry.revision!==input.expectedRevision||!pending||!this.authorized(pending.call))throw new HostError("conflict","MCP input is stale or stopped.");
    // The originating session checks its live credential custody before consuming this private answer.
    // Only the callback lives in the wait; neither credential values nor this validator are journaled.
    pending.validateResponse?.(responses);
    const actions=Object.values(responses).map(v=>(v as {action:string}).action),state=actions.some(a=>a==="cancel")?"cancelled":actions.some(a=>a==="decline")?"declined":"answered";
    const result=this.store.recordMcpPrivateInput({...entry,state,revision:entry.revision+1,responseHash,clientRequestId:input.clientRequestId});
    pending.cleanup();
    pending.resolve(responses);return result;
  }
  close(){for(const id of this.#pending.keys())this.#finish(id,"interrupted");}
}
