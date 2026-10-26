import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostError, HostStore, canonicalJson, type ClientDeviceScope } from '@dexter/hub';
import { createHostApp, type HostMcpPort } from '@dexter/hub/http';
import { CapabilityGateway, type AdapterCall } from '@dexter/gateway';
import { McpConnectorError, validateMcpPrivateInputResponses } from '@dexter/connectors';
import type { JsonValue, McpPrivateInput } from '@dexter/contracts';
import { AppClientServices } from '../packages/cli/src/app-client-services.js';
import { McpPrivateInputCoordinator } from '../packages/cli/src/mcp-private-input.js';
import { call, clientIdentity, hostIdentity, type Trust } from './app-client-lab.js';
import type { TlsIdentity } from '@dexter/devices';
export const ordinary={r1:{method:'elicitation/create',params:{message:'Confirm an ordinary synthetic preference. '+'Choose a synthetic preference before continuing. '.repeat(3),requestedSchema:{type:'object',properties:{value:{type:'string',pattern:'^good$'},confirm:{type:'boolean'},note:{type:'string'}},additionalProperties:false}}}};
export async function privateInputRemoteLab(){
  const root=mkdtempSync(join(tmpdir(),'dx-r8-private-')),store=new HostStore({dataDir:join(root,'host')});
  const fixture=JSON.parse(readFileSync(resolve('apps/apple/Tests/DexterHostClientTests/Fixtures/mcp-private-form-r3.json'),'utf8')) as {positive:{name:string;requestJSON:string}[]};
  const maximum=JSON.parse(fixture.positive.find(p=>p.name==='r7-max-8x64KiB-schema-2048-message-128-id')!.requestJSON) as Record<string,unknown>;
  let coordinator!:McpPrivateInputCoordinator,originalCall!:AdapterCall,effects=0,ready!:()=>void;
  const entered=new Promise<void>(resolve=>{ready=resolve;});
  const gateway=new CapabilityGateway({store,broker:{acquire:()=>({headers:{}}),secretValues:()=>[]},adapter:{execute:async(current,_auth,context)=>{
    originalCall=current; const answer=coordinator.request(current,maximum,context.signal,responses=>{validateMcpPrivateInputResponses(maximum,responses,['SYNTHETIC_PRIVATE_SECRET']);});ready();
    await answer;effects++;return{isError:false,structuredContent:{confirmed:true}};
  }}});
  coordinator=new McpPrivateInputCoordinator(store,()=>gateway);
  const bot=store.createBot({name:'R8 synthetic',profileId:'default',engine:'claude'}),thread=store.createThread(bot.id);
  const turn=store.createTurn(thread.id,{clientRequestId:randomUUID(),content:'Synthetic original operation'}).turn;store.claimNextTurn(thread.id);
  gateway.registerTool({name:'fixture.write',toolkit:'fixture',version:'1.0.0',upstreamSlug:'WRITE',upstreamHost:'fixture.example.test',description:'Synthetic',effect:'write',destinationArgument:null,destinationOrigins:null,inputSchema:{type:'object',properties:{},required:[],additionalProperties:false}});
  const connection=gateway.connectAccount({profileId:'default',toolkit:'fixture',label:'Synthetic',upstreamAccountRef:'synthetic',credentialRef:'synthetic',allowedHosts:['fixture.example.test']});
  store.setGrant({botId:bot.id,tool:'fixture.write',destination:connection.id,policy:'allow'});
  const abort=new AbortController(),operation=gateway.call(gateway.issueCapability({turnId:turn.id}).token,{callId:'original',tool:'fixture.write',connectionId:connection.id,arguments:{}},{signal:abort.signal});void operation.catch(()=>{});await entered;
  const input=coordinator.page().summaries[0]!;
  const canonical=coordinator.get(input.id)!;
  for(let n=0;n<300;n++){
    const row:McpPrivateInput={...canonical,id:`mcpform_history_${String(n).padStart(4,'0')}`,requests:ordinary as unknown as Record<string,JsonValue>};
    store.recordMcpPrivateInput(row);store.recordMcpPrivateInput({...row,state:n%2?'declined':'expired',revision:2});
  }
  const smallWait=coordinator.request(originalCall,ordinary,abort.signal);void smallWait.catch(()=>{});
  const port={inputRequests:{list:()=>coordinator.list(),page:(query)=>coordinator.page(query),get:(id:string)=>coordinator.get(id),respond:(id:string,body:unknown)=>{
    try{return coordinator.respond(id,body);}catch(e){if(e instanceof McpConnectorError&&e.effect==='none')throw new HostError('invalid_input','MCP response contract differs.');throw e;}
  }}} as HostMcpPort;
  const host=hostIdentity(join(root,'host-id')),services=new AppClientServices(store,{identity:host,requestTimeoutMs:15_000},{mcp:port}),url=await services.start();
  const trust:Trust={url,certPem:host.certPem,fingerprint:host.fingerprint},owner=createHostApp(store,{mcp:port});
  return{root,store,coordinator,gateway,maximum,input:canonical,operation,abort,services,trust,host,owner,effects:()=>effects,
    identity:(name:string)=>clientIdentity(join(root,'client-'+name)),
    pair:async(identity:TlsIdentity,scopes:ClientDeviceScope[])=>{
      const bundle=services.admin.pairingBundle({kind:'pair',role:'client-mac',scopes});
      const claim=await call(trust,identity,'POST','/app-client/v1/pair/claim',{offerId:bundle.offerId,code:bundle.code,name:'Synthetic R8 client'});
      services.admin.approveClaim(claim.json.claimId as string);
      return (await call(trust,identity,'POST','/app-client/v1/pair/status',{claimId:claim.json.claimId})).json;
    },
    canonicalRows:()=>canonicalJson(coordinator.store.mcpPrivateInputs() as unknown as JsonValue),
    close:async()=>{await services.close();coordinator.close();abort.abort();await operation.catch(()=>{});gateway.close();store.close();rmSync(root,{recursive:true,force:true});}
  };
}
