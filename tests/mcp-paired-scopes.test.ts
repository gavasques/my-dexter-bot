import {serve} from '@hono/node-server';
import assert from'node:assert/strict';import{test}from'node:test';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{randomUUID}from'node:crypto';
import{HostStore,HostError,type ClientDeviceScope}from'@dexter/hub';import{createAuthorizedHostRouter,createHostApp,type HostRequestAuthority,type HostConnectionsPort,type HostMcpPort,type HostConnectionWorkflowsPort}from'@dexter/hub/http';
function f(t:{after(fn:()=>void):void}){const dir=mkdtempSync(join(tmpdir(),'dx-mcp-paired-')),store=new HostStore({dataDir:dir});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const authority=(scopes:ClientDeviceScope[],check=()=>{})=>({principal:'paired-client',installationId:store.hostId,ownerId:store.ownerId,deviceId:'dev_synthetic',role:'client-ios',scopes,pinGeneration:1,bindingRevision:1,assertCurrent:check,noteSelfRevoke(){}} as HostRequestAuthority);
  return {store,authority};}
test('new scopes are opt-in and independent; native/private project custody remains executor-only',async t=>{
  const {store,authority}=f(t);let reads=0,writes=0;
  const port={status:()=>{reads++;return{hostId:store.hostId};},startAuthorization:async()=>{writes++;return{created:true,authorization:{authorizationURL:'https://connect.example.test/opaque'}};}}as unknown as HostConnectionsPort;
  const router=createAuthorizedHostRouter(store,{connections:port});
  const fetch=(path:string,method:string,scopes:ClientDeviceScope[],body?:unknown)=>router.fetch(new Request('https://paired.example.test'+path,{method,...(body&&method!=='GET'?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})}),{authority:authority(scopes)});
  assert.equal((await fetch('/v1/connections/status','GET',['chat.read'])).status,403);
  assert.equal((await fetch('/v1/connections/status','GET',['connections.manage'])).status,403);
  assert.equal((await fetch('/v1/connections/status','GET',['connections.read'])).status,200);assert.equal(reads,1);
  const body={expectedHostID:store.hostId,clientRequestId:randomUUID(),serviceId:'gmail',catalogPin:'a'.repeat(64),profileId:null,label:null,replacesAccountId:null};
  assert.equal((await fetch('/v1/connections/authorizations','POST',['connections.read'],body)).status,403);assert.equal(writes,0);
  assert.equal((await fetch('/v1/connections/authorizations','POST',['connections.manage'],body)).status,201);assert.equal(writes,1);
  for(const path of ['/v1/connections/platform-configuration','/v1/mcp/servers/synthetic/oauth/start','/v1/mcp/servers/synthetic/credentials/unlock'])assert.equal((await fetch(path,path.includes('configuration')?'GET':'POST',['connections.manage','mcp.manage'],{})).status,403);
});
test('private MRTR response rechecks the TLS authority after body parsing, before admitting any response',async t=>{
  const{store,authority}=f(t);let effects=0,checks=0,active=true;
  const mcp={inputRequests:{respond:()=>{effects++;return{};}}}as unknown as HostMcpPort,router=createAuthorizedHostRouter(store,{mcp});
  const a=authority(['mcp.manage'],()=>{if(!active)throw new HostError('forbidden','revoked');if(++checks===2)queueMicrotask(()=>{active=false;});});
  const response=await router.fetch(new Request('https://paired.example.test/v1/mcp/input-requests/mcpform_synthetic/respond',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedHostID:store.hostId,clientRequestId:randomUUID(),expectedRevision:1,actionId:'act_synthetic',requestHash:'a'.repeat(64),approval:'approve_exact_input',responses:{r1:{action:'accept',content:{confirm:true}}}})}),{authority:a});
  assert.equal(response.status,403);assert.equal(effects,0);
});

// R3-11: exercise the actual HTTP routers, with synthetic ports that commit a receipt then lose the answer.
// The same recovery id is read; neither a 503 nor a legacy error code grants authority to retry a write.
test('connection outcome_unknown is HTTP 503 on owner and paired writes; GET recovers the same receipt', async t => {
  const {store,authority}=f(t),accountId='acct_00000000-0000-4000-8000-000000000001';
  let effects=0,conflict=false;const receipts=new Map<string,unknown>();
  const uncertain=(input:{clientRequestId?:string})=>{effects++;if(conflict)throw new HostError('conflict','synthetic CAS');
    if(input.clientRequestId)receipts.set(input.clientRequestId,{clientRequestId:input.clientRequestId,recovered:true});
    throw new HostError('outcome_unknown','synthetic lost ACK');};
  const connections={
    setAccess:(_id:string,input:{clientRequestId:string})=>uncertain(input),
    setLabel:(_id:string,input:{clientRequestId:string})=>uncertain(input),
    disconnect:async(_id:string,input:{clientRequestId:string})=>uncertain(input),
    startAuthorization:async(input:{clientRequestId:string})=>uncertain(input),
    callback:async(id:string)=>uncertain({clientRequestId:id}),
    receipt:(id:string)=>receipts.get(id)??null,
  }as unknown as HostConnectionsPort;
  const workflows={complete:(_id:string,input:{clientRequestId:string})=>uncertain(input),cancel:(_id:string,input:{clientRequestId:string})=>uncertain(input)}as unknown as HostConnectionWorkflowsPort;
  const owner=createHostApp(store,{connections,connectionWorkflows:workflows}),paired=createAuthorizedHostRouter(store,{connections,connectionWorkflows:workflows});
  async function listener(fetch:(request:Request)=>Response|Promise<Response>){
    const server=await new Promise<ReturnType<typeof serve>>(resolve=>{const instance=serve({hostname:'127.0.0.1',port:0,fetch},()=>resolve(instance));});
    t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
    const address=server.address();assert.ok(address&&typeof address==='object');return `http://127.0.0.1:${address.port}`;
  }
  const ownerURL=await listener(request=>owner.fetch(request));
  const pairedURL=await listener(request=>paired.fetch(request,{authority:authority(['connections.read','connections.manage'])}));
  const requestId=randomUUID(),access={expectedHostID:store.hostId,clientRequestId:requestId,expectedRevision:1,botId:'bot_synthetic',enabled:true,toolNames:['gmail.read']};
  for(const base of [ownerURL,pairedURL]){
    const reply=await fetch(base+`/v1/connections/accounts/${accountId}/access`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(access)});
    assert.equal(reply.status,503);assert.equal((await reply.json()).error,'outcome_unknown');assert.equal(reply.headers.get('cache-control'),'no-store');
    const before=effects,recovery=await fetch(base+'/v1/connections/receipts/'+requestId);assert.equal(recovery.status,200);
    assert.deepEqual(await recovery.json(),{clientRequestId:requestId,recovered:true});assert.equal(effects,before,'GET never reapplies the access');
  }
  const cases:[string,string,unknown][]=[
    ['POST','/v1/connections/authorizations',{expectedHostID:store.hostId,clientRequestId:randomUUID(),serviceId:'gmail',catalogPin:'a'.repeat(64),profileId:null,label:null,replacesAccountId:null}],
    ['POST','/v1/connections/authorizations/'+requestId+'/callback',{expectedHostID:store.hostId,outcome:'returned',providerAccountRef:null}],
    ['PATCH',`/v1/connections/accounts/${accountId}/label`,{expectedHostID:store.hostId,clientRequestId:randomUUID(),expectedRevision:1,label:'Synthetic'}],
    ['POST',`/v1/connections/accounts/${accountId}/disconnect`,{expectedHostID:store.hostId,clientRequestId:randomUUID(),expectedRevision:1}],
    ['POST','/v1/connections/setup-requests/setup_synthetic/complete',{expectedHostID:store.hostId,clientRequestId:randomUUID(),expectedRevision:1,selections:[{connectionId:'conn_synthetic',expectedRevision:1,tools:[{name:'gmail.read',manifestHash:'a'.repeat(64)}]}]}],
    ['POST','/v1/connections/setup-requests/setup_synthetic/cancel',{expectedHostID:store.hostId,clientRequestId:randomUUID(),expectedRevision:1}],
  ];
  for(const base of [ownerURL,pairedURL])for(const[method,path,body]of cases){const result=await fetch(base+path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(result.status,503,path);assert.equal((await result.json()).error,'outcome_unknown');}
  conflict=true;
  for(const base of [ownerURL,pairedURL]){const result=await fetch(base+`/v1/connections/accounts/${accountId}/access`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(access)});assert.equal(result.status,409);assert.equal((await result.json()).error,'conflict');}
  const denied=await paired.fetch(new Request('https://paired.example.test'+`/v1/connections/accounts/${accountId}/access`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(access)}),{authority:authority(['connections.read'])});assert.equal(denied.status,403);
});
