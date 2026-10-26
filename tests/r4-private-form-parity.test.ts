import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { HostError, canonicalJson, type ClientDeviceScope } from '@dexter/hub';
import { createHostApp, createAuthorizedHostRouter, type HostRequestAuthority } from '@dexter/hub/http';
import { McpUpstreamSession, checkMcpDefinition, McpConnectorError, type McpRuntimeHost } from '@dexter/connectors';
import { McpMrtrVault, type AdapterCall } from '@dexter/gateway';
import { HostServices } from '../packages/cli/src/host-services.js';

const schema = { type: 'object', properties: { email: { type: 'string', format: 'email' },
  alias: { type: 'string', pattern: '^[a-z]+$' }, count: { type: 'integer', minimum: 1, maximum: 3 } },
  required: ['email', 'alias', 'count'], additionalProperties: true };
const FORM = { r1: { method: 'elicitation/create', params: { message: 'Review a synthetic preference.', requestedSchema: schema,
  _meta: { provider: 'synthetic-only' } } } };
const VALUES = { email: 'reader@example.test', alias: 'alpha', count: 2 };
const OPAQUE = 'opaque-state-r4-private-never-persisted';
const CANARY = 'sk-TESTONLYDexterFixture00000000000';

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'dx-r4-mrtr-'));
  let services!: HostServices, session!: McpUpstreamSession, signal!: AbortSignal;
  const calls: Array<{ id: unknown; method: string; params: Record<string, unknown> }> = [];
  let effects = 0, promptCount = 0, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(init?.body as string) as {id: unknown; method: string; params?: Record<string, unknown>};
    calls.push({id: request.id, method: request.method, params: request.params ?? {}});
    let result: Record<string, unknown>;
    if(request.method === 'server/discover') result = {resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{tools:{}},ttlMs:0,cacheScope:'private'};
    else if(request.method === 'tools/list') result = {resultType:'complete',tools:[{name:'write',inputSchema:{type:'object',properties:{},additionalProperties:false}}],ttlMs:0,cacheScope:'private'};
    else if(request.method === 'tools/call') {
      if(!request.params?.inputResponses) result = {resultType:'input_required',requestState:OPAQUE,inputRequests:FORM};
      else {
        assert.equal(request.params.requestState, OPAQUE, 'opaque state remains exact after rejected local answers');
        const responses = request.params.inputResponses as {r1:{action:string}};
        if(responses.r1.action === 'accept') effects++;
        result = {resultType:'complete',content:[],structuredContent:{confirmed:responses.r1.action === 'accept'}};
      }
    } else throw new Error('unexpected synthetic protocol method');
    result._meta = {'io.modelcontextprotocol/serverInfo':{name:'synthetic',version:'1'}};
    return Response.json({jsonrpc:'2.0',id:request.id,result});
  }) as typeof globalThis.fetch;
  t.after(async()=>{await session?.close();await services?.shutdown();rmSync(dir,{recursive:true,force:true});});
  services = new HostServices({dataDir:join(dir,'host'),enableMcp:true,enableEngines:true,enableGroups:false,enableWorkspaceTools:false,makeDriver:()=>{throw new Error('No synthetic engine may open.');},nativeMcp:{runsOn:'owner_mac'},
    upstream:{broker:{acquire:()=>({headers:{}}),secretValues:()=>[]},adapter:{execute:async(call:AdapterCall,_auth,context)=>{
      signal = context.signal; return session.callTool('write',{},context.signal,call);
    }}}});
  const host: McpRuntimeHost = {runsOn:'owner_mac',stdioRoot:join(dir,'unused'),protocolMode:'modern',fetch,secretValues:()=>[CANARY],inputRequired:{
    authorized:call=>services.mcpPrivateInputs.authorized(call),
    request:(call,requests,abort)=>{promptCount++;const pending=services.mcpPrivateInputs.request(call,requests,abort);entered();return pending;},
  }};
  session = await McpUpstreamSession.open(checkMcpDefinition({id:'synthetic',name:'Synthetic',runsOn:'owner_mac',auth:'none',transport:{type:'streamable_http',url:'https://mcp.example.test/mcp'}}),{},host);
  await session.listTools();
  const store = services.store, gateway = services.gateway!;
  const bot = store.createBot({name:'Synthetic MRTR',profileId:'default',engine:'claude'}), thread = store.createThread(bot.id);
  const turn = store.createTurn(thread.id,{clientRequestId:randomUUID(),content:'Review a synthetic preference.'}).turn;
  store.claimNextTurn(thread.id);
  gateway.registerTool({name:'fixture.write',toolkit:'fixture',version:'1.0.0',upstreamSlug:'write',upstreamHost:'fixture.example.test',description:'Synthetic',effect:'write',destinationArgument:null,destinationOrigins:null,inputSchema:{type:'object',properties:{},required:[],additionalProperties:false}});
  const connection = gateway.connectAccount({profileId:'default',toolkit:'fixture',label:'Synthetic',upstreamAccountRef:'synthetic',credentialRef:'fixture',allowedHosts:['fixture.example.test']});
  store.setGrant({botId:bot.id,tool:'fixture.write',destination:connection.id,policy:'allow'});
  const controller = new AbortController();
  const operation = gateway.call(gateway.issueCapability({turnId:turn.id}).token,{callId:'original',tool:'fixture.write',connectionId:connection.id,arguments:{}},{signal:controller.signal});
  void operation.catch(()=>{});await ready;
  const input = services.mcpPrivateInputs.list().requests[0]!;assert.ok(input);
  const body = (content:Record<string,unknown>,id=randomUUID())=>({expectedHostID:store.hostId,clientRequestId:id,expectedRevision:1,actionId:input.actionId,requestHash:input.requestHash,approval:'approve_exact_input',responses:{r1:{action:'accept',content}}});
  const authority = (scopes:ClientDeviceScope[]=['mcp.read','mcp.manage']):HostRequestAuthority=>({principal:'paired-client',installationId:store.hostId,ownerId:store.ownerId,deviceId:'dev_synthetic',role:'client-ios',scopes,pinGeneration:1,bindingRevision:1,assertCurrent(){},noteSelfRevoke(){}});
  const owner = createHostApp(store,{mcp:services.nativeMcpHttp!}),paired = createAuthorizedHostRouter(store,{mcp:services.nativeMcpHttp!});
  const http = (kind:'owner'|'paired',method:string,path:string,payload?:unknown,scopes?:ClientDeviceScope[])=>{
    const request=new Request((kind==='owner'?'http://127.0.0.1':'https://paired.example.test')+path,{method,headers:{'content-type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
    return kind==='owner'?owner.fetch(request):paired.fetch(request,{authority:authority(scopes)});
  };
  return {services,store,gateway,input,turn,operation,body,http,controller,signal:()=>signal,
    legs:()=>calls.filter(c=>c.method==='tools/call'),effects:()=>effects,prompts:()=>promptCount,dir};
}

for(const kind of ['owner','paired'] as const)test(`R4 real HostServices ${kind} HTTP invalid answers preserve private state; explicit correction uses new SDK leg`,{timeout:30_000},async t=>{
  const f=await fixture(t),path=`/v1/mcp/input-requests/${f.input.id}`,invalidID=randomUUID();
  for(const content of [{...VALUES,email:'bad'},{...VALUES,alias:'ALPHA'},{...VALUES,count:99},{...VALUES,pwd:'ordinary'},{...VALUES,email:CANARY},{}]) {
    const response=await f.http(kind,'POST',path+'/respond',f.body(content,invalidID));
    assert.equal(response.status,400);assert.equal(response.headers.get('cache-control'),'no-store');
    const error=await response.json() as {error:string;message:string};assert.equal(error.error,'invalid_input');assert.ok(!JSON.stringify(error).includes(CANARY));
    const current=f.services.mcpPrivateInputs.get(f.input.id)!;assert.deepEqual(current,f.input);
    assert.equal(current.state,'pending');assert.equal(current.revision,1);assert.equal(current.clientRequestId,null);
    assert.equal(f.legs().length,1);assert.equal(f.effects(),0);assert.equal(f.prompts(),1);assert.equal(f.signal().aborted,false);
    const read=await f.http(kind,'GET',path);assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'no-store');assert.deepEqual(await read.json(),f.input);
  }
  const validID=randomUUID(),answer=f.body(VALUES,validID),accepted=await f.http(kind,'POST',path+'/respond',answer);
  assert.equal(accepted.status,200);assert.equal(accepted.headers.get('cache-control'),'no-store');
  const receipt=await accepted.json() as {clientRequestId:string;state:string};assert.equal(receipt.state,'answered');assert.equal(receipt.clientRequestId,validID);
  const done=await f.operation;assert.equal(done.status,'succeeded');assert.equal(done.actionId,f.input.actionId);assert.equal(done.requestHash,f.input.requestHash);
  assert.equal(f.store.listActions().length,1);assert.equal(f.legs().length,2);assert.notEqual(f.legs()[0]!.id,f.legs()[1]!.id);assert.equal(f.effects(),1);
  const replay=await f.http(kind,'POST',path+'/respond',answer);assert.equal(replay.status,200);assert.equal(f.legs().length,2);assert.equal(f.effects(),1);
  const conflict=await f.http(kind,'POST',path+'/respond',f.body(VALUES));assert.equal(conflict.status,409);assert.equal((await conflict.json() as {error:string}).error,'conflict');assert.equal(conflict.headers.get('cache-control'),'no-store');
  const publicState=JSON.stringify([f.services.mcpPrivateInputs.list(),f.store.getAction(done.actionId!)]);
  for(const value of [OPAQUE,VALUES.email,CANARY])assert.ok(!publicState.includes(value));
  const visit=(dir:string):void=>{for(const name of readdirSync(dir)){const p=join(dir,name);if(statSync(p).isDirectory())visit(p);else {const bytes=readFileSync(p);for(const value of [OPAQUE,VALUES.email,CANARY])assert.ok(!bytes.includes(Buffer.from(value)),'private values/state never written to owned host storage');}}};visit(join(f.dir,'host'));
});

test('R4 input HTTP no-store applies to malformed, revoked and missing paths before response admission',{timeout:30_000},async t=>{
  const f=await fixture(t),path=`/v1/mcp/input-requests/${f.input.id}`;
  for(const kind of ['owner','paired'] as const) {
    const invalid=await f.http(kind,'POST',path+'/respond',{});assert.equal(invalid.status,400);assert.equal(invalid.headers.get('cache-control'),'no-store');
    const missing=await f.http(kind,'GET','/v1/mcp/input-requests/missing');assert.equal(missing.status,404);assert.equal(missing.headers.get('cache-control'),'no-store');
  }
  const denied=await f.http('paired','POST',path+'/respond',f.body(VALUES),['mcp.read']);assert.equal(denied.status,403);assert.equal(denied.headers.get('cache-control'),'no-store');
  const original=f.services.mcpPrivateInputs.respond.bind(f.services.mcpPrivateInputs);
  f.services.mcpPrivateInputs.respond=()=>{throw new HostError('outcome_unknown','Synthetic uncertainty.');};
  for(const kind of ['owner','paired'] as const) {
    const response=await f.http(kind,'POST',path+'/respond',f.body(VALUES));assert.ok([409,503].includes(response.status));assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json() as {error:string}).error,'outcome_unknown');
  }
  f.services.mcpPrivateInputs.respond=original;
  f.controller.abort();const done=await f.operation;assert.equal(done.status,'unknown');assert.equal(f.legs().length,1);assert.equal(f.effects(),0);
});

test('R4 Stop after rejected form answer blocks correction and never starts another RPC',{timeout:30_000},async t=>{
  const f=await fixture(t);
  assert.throws(()=>f.services.mcpPrivateInputs.respond(f.input.id,f.body({...VALUES,alias:'ALPHA'})),(error:unknown)=>error instanceof McpConnectorError&&error.code==='input_schema_invalid'&&error.effect==='none');
  f.store.withdrawTurnToolActions(f.turn.id);f.controller.abort();
  assert.throws(()=>f.services.mcpPrivateInputs.respond(f.input.id,f.body(VALUES)));
  const done=await f.operation;assert.equal(done.actionId,f.input.actionId);assert.equal(done.status,'unknown');assert.equal(f.legs().length,1);assert.equal(f.effects(),0);
});

test('R4 declined private form sends no content and consumes only the original protocol continuation',{timeout:30_000},async t=>{
  const f=await fixture(t),body={...f.body(VALUES),approval:undefined,responses:{r1:{action:'decline'}}};
  const answer=f.services.mcpPrivateInputs.respond(f.input.id,body);assert.equal(answer.state,'declined');await f.operation;
  assert.equal(f.effects(),0);assert.equal(f.legs().length,2);assert.equal(f.legs()[1]!.params.requestState,OPAQUE);
  assert.deepEqual(f.legs()[1]!.params.inputResponses,{r1:{action:'decline'}});
});

test('R4 private continuation TTL and one-use binding remain fixed across local response validation',()=>{
  let now=1000;const vault=new McpMrtrVault(()=>now,1000),binding={principal:'p',connectionId:'c',logicalCallId:'a',method:'tools/call' as const,requestHash:'a'.repeat(64),pin:'pin'};
  const issued=vault.issue(binding,'opaque-private','first',0);now=2001;
  assert.throws(()=>vault.consume(issued,binding,'second',()=>true));
  const current=vault.issue(binding,'opaque-private','first',0);
  assert.equal(vault.consume(current,binding,'second',()=>true).requestState,'opaque-private');
  assert.throws(()=>vault.consume(current,binding,'third',()=>true));
});

// This route uses HostServices' actual NativeMcpRuntime, synthetic in-memory custody, its real session handler,
// and the owner/paired HTTP ports. No validator callback is supplied or substituted by this test.
for(const kind of ['owner','paired'] as const)test(`R4 actual native HostServices ${kind} known plaintext secret is refused before receipt/private-state consumption`,{timeout:30_000},async t=>{
  const plaintext='privateplaintextcustodyvalue';
  const dir=mkdtempSync(join(tmpdir(),'dx-r4-known-custody-'));
  const legs:Array<{id:unknown;params:Record<string,unknown>}>=[];
  let effects=0;
  const form={r1:{method:'elicitation/create',params:{message:'A synthetic nonsecret note',requestedSchema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}}}};
  const server=createServer((request,response)=>{
    let body='';request.setEncoding('utf8');request.on('data',chunk=>{body+=chunk;});request.on('end',()=>{
      if(request.method!=='POST'){response.writeHead(405).end();return;}
      const rpc=JSON.parse(body)as {id:unknown;method:string;params?:Record<string,unknown>};
      let result:Record<string,unknown>;
      if(rpc.method==='server/discover')result={resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{tools:{}},ttlMs:0,cacheScope:'private'};
      else if(rpc.method==='tools/list')result={resultType:'complete',tools:[{name:'read',inputSchema:{type:'object',properties:{},additionalProperties:false}}],ttlMs:0,cacheScope:'private'};
      else if(rpc.method==='tools/call') {
        legs.push({id:rpc.id,params:rpc.params??{}});
        if(!rpc.params?.inputResponses)result={resultType:'input_required',requestState:OPAQUE,inputRequests:form};
        else {effects++;result={resultType:'complete',content:[],structuredContent:{ok:true}};}
      }else {response.writeHead(400).end();return;}
      result._meta={'io.modelcontextprotocol/serverInfo':{name:'synthetic',version:'1'}};
      response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address()as AddressInfo).port}`;
  let services:HostServices|undefined;
  t.after(async()=>{await services?.shutdown();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));rmSync(dir,{recursive:true,force:true});});
  services=new HostServices({dataDir:join(dir,'host'),enableMcp:true,enableEngines:true,enableGroups:false,enableWorkspaceTools:false,
    makeDriver:()=>{throw new Error('No synthetic engine may open.');},nativeMcp:{runsOn:'owner_mac',privateOrigins:[origin],oauth:false,
      credentials:{custody:{kind:'synthetic',read:async()=>plaintext}}}});
  const store=services.store,gateway=services.gateway!,admin=services.nativeMcpAdmin;
  const bot=store.createBot({name:'Synthetic native custody',profileId:'default',engine:'claude'}),thread=store.createThread(bot.id);
  const turn=store.createTurn(thread.id,{clientRequestId:randomUUID(),content:'Synthetic private response.'}).turn;store.claimNextTurn(thread.id);
  admin.addServer({definition:{id:'known',name:'Synthetic',auth:'broker',runsOn:'owner_mac',transport:{type:'streamable_http',url:origin+'/mcp',headers:{'X-Synthetic-Key':{kind:'secret',key:'header.synthetic'}}},readOnlyTools:['read']}});
  const discovered=await admin.discover('known');assert.equal(discovered.server.status,'ready');
  admin.setBotSelection('known',bot.id,{toolIds:['mcp.known.read'],policy:'ask'});
  const connection=gateway.registry.listConnections('default').find(c=>c.toolkit==='mcp-known')!;assert.ok(connection);
  store.setGrant({botId:bot.id,tool:'mcp.known.read',destination:connection.id,policy:'allow'});
  const operation=gateway.call(gateway.issueCapability({turnId:turn.id}).token,{callId:'known-private',tool:'mcp.known.read',connectionId:connection.id,arguments:{}});
  void operation.catch(()=>{});
  for(let n=0;n<300&&!services.mcpPrivateInputs.list().requests.length;n++)await new Promise(resolve=>setTimeout(resolve,10));
  const input=services.mcpPrivateInputs.list().requests[0]!;assert.ok(input,'real native session emitted private form');
  const owner=createHostApp(store,{mcp:services.nativeMcpHttp!}),paired=createAuthorizedHostRouter(store,{mcp:services.nativeMcpHttp!});
  const authority:HostRequestAuthority={principal:'paired-client',installationId:store.hostId,ownerId:store.ownerId,deviceId:'dev_synthetic',role:'client-ios',scopes:['mcp.read','mcp.manage'],pinGeneration:1,bindingRevision:1,assertCurrent(){},noteSelfRevoke(){}};
  const path=`/v1/mcp/input-requests/${input.id}/respond`;
  const http=(value:string)=>{
    const request=new Request((kind==='owner'?'http://127.0.0.1':'https://paired.example.test')+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedHostID:store.hostId,clientRequestId:randomUUID(),expectedRevision:1,actionId:input.actionId,requestHash:input.requestHash,approval:'approve_exact_input',responses:{r1:{action:'accept',content:{value}}}})});
    return kind==='owner'?owner.fetch(request):paired.fetch(request,{authority});
  };
  const rejected=await http(plaintext);assert.equal(rejected.status,400);assert.equal(rejected.headers.get('cache-control'),'no-store');assert.equal((await rejected.json()as {error:string}).error,'invalid_input');
  assert.deepEqual(services.mcpPrivateInputs.get(input.id),input,'no receipt/UUID/revision consumed by custody rejection');
  assert.equal(legs.length,1);assert.equal(effects,0);
  const accepted=await http('ordinary');assert.equal(accepted.status,200);
  const done=await operation;assert.equal(done.status,'succeeded');assert.equal(done.actionId,input.actionId);assert.equal(done.requestHash,input.requestHash);
  assert.equal(legs.length,2);assert.notEqual(legs[0]!.id,legs[1]!.id);assert.equal(legs[1]!.params.requestState,OPAQUE);assert.equal(effects,1);
  const visit=(at:string):void=>{for(const name of readdirSync(at)){const p=join(at,name);if(statSync(p).isDirectory())visit(p);else {const data=readFileSync(p);for(const value of [plaintext,OPAQUE])assert.ok(!data.includes(Buffer.from(value)),'no private state/custody values in host storage');}}};visit(join(dir,'host'));
});


for(const kind of ['owner','paired'] as const)test(`R8 real HostServices ${kind} metadata pages leave historical bodies unverified; exact GET isolates poison/no-store and the original form stays actionable`,{timeout:30_000},async t=>{
  const f=await fixture(t),db=new DatabaseSync(f.store.databasePath);t.after(()=>db.close());
  const source=f.input.requests.r1 as {method:string;params:{message:string;requestedSchema:Record<string,unknown>}};
  const poison=[{}, {r1:{...source,params:{...source.params,message:'Synthetic \ud800'}}},
    {r1:{...source,params:{...source.params,requestedSchema:{type:'object',properties:{value:{type:'string',pattern:'^a\\$'}}}}}}];
  const raw=poison.map((requests,i)=>{const id=`mcpform_bad_${i}`,value=canonicalJson({...f.input,id,requests} as never);db.prepare('INSERT INTO meta(key,value)VALUES(?,?)').run(`mcp_private_input_v1:${id}`,value);return value;});
  const response=await f.http(kind,'GET','/v1/mcp/input-requests');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const result=await response.json() as {version:number;summaries:Array<{id:string;detailState:string}>;invalidRequestCount:number;invalidCountScope:string;quarantinedRequestCount:number;omittedRequestCount:number;unverifiedRequestCount:number;incomplete:boolean};
  assert.equal(result.version,2);assert.deepEqual(result.summaries.map(v=>v.id),[f.input.id]);assert.equal(result.summaries[0]!.detailState,'not_loaded');
  assert.equal(result.invalidRequestCount,0);assert.equal(result.invalidCountScope,'page_envelopes');assert.equal(result.quarantinedRequestCount,0);assert.equal(result.omittedRequestCount,3);assert.equal(result.unverifiedRequestCount,1);assert.equal(result.incomplete,false);
  const history=await f.http(kind,'GET','/v1/mcp/input-requests?view=history');assert.equal(history.status,200);
  const retained=await history.json() as {summaries:unknown[];unverifiedRequestCount:number;invalidRequestCount:number};
  assert.equal(retained.summaries.length,4);assert.equal(retained.unverifiedRequestCount,4);assert.equal(retained.invalidRequestCount,0,'valid envelopes never claim their unhydrated bodies are valid');
  for(let i=0;i<raw.length;i++){
    const detail=await f.http(kind,'GET',`/v1/mcp/input-requests/mcpform_bad_${i}`);assert.equal(detail.status,409);assert.equal(detail.headers.get('cache-control'),'no-store');
  }
  for(let i=0;i<raw.length;i++)assert.equal(db.prepare('SELECT value FROM meta WHERE key=?').get(`mcp_private_input_v1:mcpform_bad_${i}`)!.value,raw[i],'GET never repairs or deletes live historical bytes');
  assert.equal(f.legs().length,1);assert.equal(f.effects(),0);
  const accepted=await f.http(kind,'POST',`/v1/mcp/input-requests/${f.input.id}/respond`,f.body(VALUES));assert.equal(accepted.status,200);await f.operation;assert.equal(f.effects(),1);assert.equal(f.legs().length,2);
});
