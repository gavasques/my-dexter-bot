import { CompleteConnectionWorkflowSchema, ToolExecutionFailure, type ConnectionWorkflowRequest } from "@dexter/contracts";
import type { CapabilityGateway } from "@dexter/gateway";
import { HostError, type HostStore, type ConversationRuntime } from "@dexter/hub";
import type { ConnectionsAdmin, NativeMcpAdmin } from "@dexter/connectors";

/** Host-owned setup coordinator. Auth and grants remain separate, explicitly consented operations. */
export function connectionWorkflows(store:HostStore,ports:{gateway:()=>CapabilityGateway;managed:()=>Readonly<ConnectionsAdmin>;
  native:()=>Readonly<NativeMcpAdmin>;runtime:()=>ConversationRuntime}) {
  const request=async(actionId:string,input:ConnectionWorkflowRequest)=>{
    try{
    const bot=store.getBot(store.getAction(actionId).request.botId);
    if(input.expectedBotRevision!==bot.revision)throw new HostError("conflict","Setup bot changed.");
    if(input.target.kind==="managed"){
      const target=input.target;
      let catalog:Awaited<ReturnType<ConnectionsAdmin["catalog"]>>;
      try{catalog=await ports.managed().catalog();}catch{throw new ToolExecutionFailure("transport_unavailable","before_dispatch");}
      if(catalog.pin!==target.catalogPin||!catalog.services.some(s=>s.serviceId===target.serviceId&&s.availability.state==="available"))
        throw new HostError("conflict","Setup catalog changed.");
    }else if(ports.native().instancePin(input.target.serverId)!==input.target.instancePin)
      throw new HostError("conflict","Setup instance changed.");
    return store.createConnectionWorkflow(actionId,input);
    }catch(error){
      // Catalog/pin/origin admission is read-only. No OAuth, grant or workflow was dispatched.
      if(error instanceof HostError&&["conflict","forbidden","not_found","unavailable","invalid_input"].includes(error.code))
        throw new ToolExecutionFailure("connection_changed","before_dispatch");
      throw error;
    }
  };
  const complete=(id:string,raw:unknown)=>{
    const input=CompleteConnectionWorkflowSchema.parse(raw),workflow=store.connectionWorkflow(id);
    if(!workflow)throw new HostError("not_found","Setup request not found.");
    // A terminal replay returns only the original persisted state; it never repeats authorization or grants.
    if(workflow.state!=="awaiting_user"){
      const receipt=store.completeConnectionWorkflow(id,input);
      if(workflow.state==="ready")ports.runtime().scheduleConnectionWorkflow(id);
      return receipt;
    }
    const bot=store.getBot(workflow.botId),gateway=ports.gateway();
    if(new Set(input.selections.map(s=>s.connectionId)).size!==input.selections.length)throw new HostError("invalid_input","Duplicate setup account.");
    for(const selection of input.selections){
      const connection=gateway.registry.getConnection(selection.connectionId);
      if(!connection||connection.status!=="active"||connection.revision!==selection.expectedRevision||connection.profileId!==bot.profileId||connection.ownerId!==store.ownerId)
        throw new HostError("conflict","Setup account changed.");
      if(workflow.target.kind==="native_mcp"){
        if(connection.toolkit!==`mcp-${workflow.target.serverId}`||ports.native().instancePin(workflow.target.serverId)!==workflow.target.instancePin)
          throw new HostError("conflict","Setup instance changed.");
      }else{
        const account=ports.managed().accounts().items.find(a=>a.gatewayConnectionIds.includes(connection.id));
        if(!account||account.status!=="connected"||account.serviceId!==workflow.target.serviceId||account.profileId!==bot.profileId)
          throw new HostError("conflict","Setup identity not confirmed.");
        if(selection.tools.some(tool=>!account.tools.some(t=>t.name===tool.name&&t.manifestHash===tool.manifestHash)))throw new HostError("conflict","Account tool definition changed.");
      }
      if(new Set(selection.tools.map(t=>t.name)).size!==selection.tools.length)throw new HostError("invalid_input","Duplicate setup tool.");
      for(const tool of selection.tools){const registered=gateway.registry.getTool(tool.name),grant=store.getGrant(bot.id,tool.name,connection.id);
        if(!registered||registered.status!=="active"||registered.manifestHash!==tool.manifestHash||registered.manifest.toolkit!==connection.toolkit
          ||!grant||grant.policy==="deny"||grant.expiresAt!==null&&grant.expiresAt<=store.now())throw new HostError("conflict","Setup access changed.");}
    }
    const result=store.completeConnectionWorkflow(id,input);ports.runtime().scheduleConnectionWorkflow(id);return result;
  };
  const choices=(id:string)=>{
    const workflow=store.connectionWorkflow(id);if(!workflow)throw new HostError("not_found","Setup request not found.");
    const bot=store.getBot(workflow.botId),gateway=ports.gateway(),target=workflow.target;
    const accounts=target.kind==="managed"?ports.managed().accounts().items.filter(a=>a.serviceId===target.serviceId&&a.status==="connected"&&a.profileId===bot.profileId):[];
    const eligible=new Set(accounts.flatMap(a=>a.gatewayConnectionIds));
    const choices=gateway.registry.listConnections(bot.profileId).filter(c=>c.status==="active"&&(target.kind==="native_mcp"?c.toolkit===`mcp-${target.serverId}`:eligible.has(c.id)))
      .map(connection=>({connectionId:connection.id,expectedRevision:connection.revision,label:connection.label,tools:gateway.registry.listTools().filter(t=>t.status==="active"&&t.manifest.toolkit===connection.toolkit
        &&(target.kind==="native_mcp"||accounts.some(a=>a.gatewayConnectionIds.includes(connection.id)&&a.tools.some(p=>p.name===t.manifest.name&&p.manifestHash===t.manifestHash)))).map(t=>{
          const grant=store.getGrant(bot.id,t.manifest.name,connection.id);return {name:t.manifest.name,manifestHash:t.manifestHash,effect:t.manifest.effect,enabled:grant!==null&&grant.policy!=="deny"&&(grant.expiresAt===null||grant.expiresAt>store.now())};})}));
    return {requestId:id,revision:workflow.revision,choices,authorizationRequestIds:target.kind==="managed"?ports.managed().setupAuthorizations?.(id)??[]:[]};
  };
  return Object.freeze({request,list:()=>({requests:store.connectionWorkflows()}),get:(id:string)=>store.connectionWorkflow(id),choices,complete,
    cancel:(id:string,input:unknown)=>store.cancelConnectionWorkflow(id,input)});
}
