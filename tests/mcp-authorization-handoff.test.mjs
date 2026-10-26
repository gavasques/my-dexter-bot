import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { HostServices } from '../packages/cli/dist/host-services.js';
import { HarnessOperationSurface, HARNESS_OPERATION_DESTINATION } from '../packages/cli/dist/harness-operation-surface.js';
import { createHostApp, createAuthorizedHostRouter } from '../packages/hub/dist/http.js';
import { APPROVAL_POLICY_SCOPE_VERSION, McpAuthorizationHandoffSchema, currentMcpAuthorizationHandoff, MCP_AUTHORIZATION_HANDOFF_TTL_MS } from '../packages/contracts/dist/index.js';
import { McpOAuthClient } from '../packages/connectors/dist/index.js';

// Synthetic stores/metadata/transports only. No real credentials, browser, provider, external network or engine inference.
const driver=id=>({id,capabilities:{resume:true,interrupt:true,fork:false,steer:false},status:async()=>({engine:id,installed:true}),
 open:async threadId=>({threadId,nativeCursor:'synthetic'}),async *turn(session,turnId){yield{type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},
 respondToTool:async()=>{},interrupt:async()=>{},close:async()=>{}});
const catalog=async()=>[{id:'codex',available:true,models:[{id:'synthetic',reasoningEfforts:[],speeds:[]}],defaultModel:'synthetic',reasoningEfforts:[],speeds:[]}];
const endpoint='https://resource.example/mcp';
const wire=(id,authentication='oauth')=>({schema_version:1,server_id:id,name:'Synthetic MCP',url:endpoint,authentication});
const definition=(id,url=endpoint)=>({id,name:'Synthetic OAuth',auth:'oauth',runsOn:'owner_mac',transport:{type:'streamable_http',url}});
const refused=e=>['forbidden','conflict','invalid_input','unavailable'].includes(e?.code);
const json=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
function fixture(t,{fetch,load}={}){
 const root=realpathSync(mkdtempSync('/private/tmp/dexter-mcp-authorization-handoff-')),surfaces=[],turns=[],counts={fetch:0,load:0,save:0,remove:0,custody:0};let sequence=0;
 const services=new HostServices({dataDir:join(root,'host'),enableEngines:true,enableMcp:true,engineCommands:{codex:'/usr/bin/false'},makeDriver:driver,engineCatalog:catalog,
  nativeMcp:{runsOn:'owner_mac',
   oauth:{fetch:async(...args)=>{counts.fetch++;if(fetch)return fetch(...args);throw Error('Synthetic unexpected OAuth/network');},store:{load:async(...args)=>{counts.load++;return load?load(...args):null;},save:async()=>{counts.save++;},remove:async()=>{counts.remove++;}}},
   credentials:{custody:{kind:'synthetic',read:async()=>{counts.custody++;throw Error('Unexpected synthetic custody');}}}}});
 const app=createHostApp(services.store,{runtime:services.runtime,mcp:services.nativeMcpHttp});
 const request=(method,path,body)=>app.request(`http://127.0.0.1${path}`,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const surface=()=>{const s=new HarnessOperationSurface({store:services.store,base:services.gateway,catalog:services.engineCatalog,runtime:()=>services.runtime,
  skills:()=>services.skillsHttp,effectiveSkills:()=>[],mcp:()=>services.nativeMcpAdmin});surfaces.push(s);return s;};
 const bot=()=>services.store.createBot({name:'Synthetic owner bot',profileId:'synthetic',engine:'codex'});
 const live=(actor,thread=services.store.createThread(actor.id))=>{const {turn}=services.store.createTurn(thread.id,{clientRequestId:`handoff-${++sequence}`,content:'Synthetic OAuth setup'});
  services.store.claimNextTurn(thread.id);turns.push(turn);const s=surface();return{bot:actor,thread,turn,surface:s,token:s.issueCapability({turnId:turn.id}).token};};
 const decide=async(p,decision='allow')=>{const r=await request('POST',`/v1/actions/${p.actionId}/decisions`,{decision,requestHash:p.requestHash});assert.equal(r.status,200);return r.json();};
 t.after(async()=>{for(const s of surfaces)await s.close();for(const turn of turns)if(services.store.getTurn(turn.id).state==='running')services.store.finishTurn(turn.id,'completed',null);
  await services.shutdown();rmSync(root,{recursive:true,force:true});});
 return{services,app,request,live,bot,decide,counts};
}
const call=(live,name,callId,args={})=>live.surface.call(live.token,{connectionId:HARNESS_OPERATION_DESTINATION,tool:`dexter.harness.${name}`,callId,arguments:args});
async function registration(f,live,id='oauth-instance',authentication='oauth',url=endpoint){
 const args={...wire(id,authentication),url},pending=await call(live,'mcp.add_http',`register-${id}`,args);assert.equal(pending.status,'awaiting_approval');await f.decide(pending);
 const result=await call(live,'mcp.add_http',`register-${id}`,args);assert.equal(result.status,'succeeded');return result;
}
const argumentsFor=r=>({server_id:r.result.server.id,expected_instance_pin:r.result.instancePin,action_id:r.actionId});
const quiet=f=>assert.deepEqual(f.counts,{fetch:0,load:0,save:0,remove:0,custody:0});

for(const mode of ['approve_all','full_access'])test(`OAuth handoff: ${mode} still requires exact approval; Deny and replay never start OAuth`,async t=>{
 const f=fixture(t),actor=f.bot(),live=f.live(actor);
 f.services.store.setBotApprovalPolicy(actor.id,{expectedHostId:f.services.store.hostId,expectedRevision:0,clientRequestId:`synthetic-${mode}`,mode,eligibleScopeVersion:APPROVAL_POLICY_SCOPE_VERSION});
 const registered=await registration(f,live),args=argumentsFor(registered);
 const inspected=await call(live,'mcp.inspect','inspect',{server_id:args.server_id,action_id:registered.actionId});
 assert.equal(inspected.result.instance_pin,args.expected_instance_pin);assert.equal(inspected.result.server.auth,'oauth');
 assert.equal(live.surface.listTools(live.token).find(v=>v.name==='dexter.harness.mcp.authorize').requiresApproval,true);
 const denied=await call(live,'mcp.authorize','denied',args);assert.equal(denied.status,'awaiting_approval');quiet(f);await f.decide(denied,'deny');
 assert.equal((await call(live,'mcp.authorize','denied',args)).status,'denied');quiet(f);
 const pending=await call(live,'mcp.authorize','allowed',args);assert.equal(pending.status,'awaiting_approval');quiet(f);await f.decide(pending);
 const approved=await call(live,'mcp.authorize','allowed',args);assert.equal(approved.status,'succeeded');quiet(f);
 const action=f.services.store.getAction(approved.actionId),receipt=McpAuthorizationHandoffSchema.parse(approved.result);
 assert.equal(action.authorization.source,'exact_owner');assert.equal(action.authorization.ownerId,f.services.store.ownerId);assert.equal(action.decidedBy,f.services.store.ownerId);
 assert.deepEqual(Object.keys(receipt).sort(),['actionId','botId','expiresAt','hostId','instancePin','kind','requestHash','serverId','threadId'].sort());
 assert.equal(receipt.actionId,approved.actionId);assert.equal(receipt.requestHash,approved.requestHash);assert.equal(receipt.hostId,f.services.store.hostId);
 assert.equal(receipt.botId,actor.id);assert.equal(receipt.threadId,live.thread.id);assert.equal(receipt.instancePin,args.expected_instance_pin);
 assert.ok(receipt.expiresAt>action.updatedAt && receipt.expiresAt<=action.updatedAt+MCP_AUTHORIZATION_HANDOFF_TTL_MS);
 assert.ok(currentMcpAuthorizationHandoff(receipt,action.updatedAt));assert.equal(currentMcpAuthorizationHandoff(receipt,receipt.expiresAt),null);
 assert.deepEqual((await call(live,'mcp.authorize','allowed',args)).result,receipt);assert.equal((await call(live,'mcp.authorize','allowed',args)).actionId,action.id);quiet(f);
 assert.deepEqual((await call(live,'actions.read','receipt',{action_id:action.id})).result.result,receipt);
 assert.equal(f.services.nativeMcpAdmin.credentialStatus(args.server_id).state,'unauthorized');assert.deepEqual(f.services.nativeMcpAdmin.botSelection(args.server_id,actor.id).toolIds,[]);
 for(const extra of [{botId:actor.id},{authorizationUrl:'https://issuer.example/authorize'},{state:'forged'},{origin:{ownerId:f.services.store.ownerId}}])
  await assert.rejects(call(live,'mcp.authorize',`forged-${Object.keys(extra)[0]}`,{...args,...extra}),e=>e.code==='invalid_input');
 await assert.rejects(call(live,'mcp.authorize','allowed',{...args,expected_instance_pin:'0'.repeat(64)}),e=>e.code==='conflict');quiet(f);
});

test('OAuth handoff: legacy Allow/Deny grants cannot bypass the exact owner boundary',async t=>{
 const f=fixture(t),actor=f.bot(),live=f.live(actor),registered=await registration(f,live),args=argumentsFor(registered);
 for(const policy of ['allow','deny','ask']){
  f.services.store.setGrant({botId:actor.id,tool:'dexter.harness.mcp.authorize',destination:HARNESS_OPERATION_DESTINATION,policy,...(policy==='ask'?{expiresAt:Date.now()-1}:{})});
  assert.ok(!live.surface.listTools(live.token).some(v=>v.name==='dexter.harness.mcp.authorize'));
  await assert.rejects(call(live,'mcp.authorize',policy,args),e=>e.code==='forbidden');quiet(f);
 }
});

test('OAuth handoff: own receipt, thread, authentication kind and current generation are checked before proposal and dispatch',async t=>{
 const f=fixture(t),actor=f.bot(),live=f.live(actor),registered=await registration(f,live),args=argumentsFor(registered);
 await assert.rejects(call(f.live(f.bot()),'mcp.authorize','foreign-bot',args),e=>e.code==='forbidden');
 await assert.rejects(call(f.live(actor),'mcp.authorize','foreign-thread',args),e=>e.code==='forbidden');
 await assert.rejects(call(live,'mcp.authorize','unreachable',{server_id:args.server_id,expected_instance_pin:args.expected_instance_pin}),e=>e.code==='forbidden');
 await assert.rejects(call(live,'mcp.authorize','stale-pin',{...args,expected_instance_pin:'0'.repeat(64)}),e=>e.code==='conflict');
 const noauth=await registration(f,live,'no-auth','none');await assert.rejects(call(live,'mcp.authorize','no-auth',argumentsFor(noauth)),e=>e.code==='invalid_input');quiet(f);
 const pending=await call(live,'mcp.authorize','pending-replacement',args);assert.equal(pending.status,'awaiting_approval');
 await f.services.nativeMcpAdmin.removeServer(args.server_id);f.services.nativeMcpAdmin.addServer({definition:definition(args.server_id)});
 assert.notEqual(f.services.nativeMcpAdmin.instancePin(args.server_id),args.expected_instance_pin);
 await f.decide(pending);assert.equal((await call(live,'mcp.authorize','pending-replacement',args)).status,'blocked');
 await assert.rejects(call(live,'mcp.inspect','old-inspect',{server_id:args.server_id,action_id:registered.actionId}),e=>e.code==='conflict');
 await assert.rejects(call(live,'mcp.authorize','old-receipt',{...args,expected_instance_pin:f.services.nativeMcpAdmin.instancePin(args.server_id)}),e=>e.code==='conflict');
 assert.deepEqual([f.counts.fetch,f.counts.load,f.counts.save,f.counts.custody],[0,0,0,0]);
});

test('OAuth handoff: approved own receipt dispatches after the proposing turn finishes without an engine capability',async t=>{
 const f=fixture(t),actor=f.bot(),live=f.live(actor),registered=await registration(f,live),pending=await call(live,'mcp.authorize','closed-turn',argumentsFor(registered));
 assert.equal(pending.status,'awaiting_approval');f.services.store.finishTurn(live.turn.id,'completed',null);await f.decide(pending);
 const action=f.services.store.getAction(pending.actionId);assert.equal(action.state,'succeeded');assert.equal(action.result.threadId,live.thread.id);quiet(f);
 const history=await f.request('GET',`/v1/actions/${action.id}`);assert.equal(history.status,200);assert.deepEqual((await history.json()).result,action.result);quiet(f);
});

function oauthMetadataFetch(resource=endpoint){return async input=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 if(url.pathname.startsWith('/.well-known/oauth-protected-resource'))return json({resource,authorization_servers:['https://issuer.example'],scopes_supported:['tools.read']});
 if(url.pathname.startsWith('/.well-known/oauth-authorization-server'))return json({issuer:'https://issuer.example',authorization_endpoint:'https://issuer.example/authorize',token_endpoint:'https://issuer.example/token',
  response_types_supported:['code'],grant_types_supported:['authorization_code'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256']});
 throw Error('Only synthetic OAuth metadata is accepted');
};}

test('Private OAuth start: incorrect instance CAS refuses before fetch/cancel, legacy start remains compatible and paired clients cannot start',async t=>{
 const f=fixture(t,{fetch:oauthMetadataFetch()}),id='private-oauth';f.services.nativeMcpAdmin.addServer({definition:definition(id)});
 const post=body=>f.request('POST',`/v1/mcp/servers/${id}/oauth/start`,body),pin=f.services.nativeMcpAdmin.instancePin(id);
 assert.equal((await post({clientId:'synthetic-client',expectedInstancePin:'0'.repeat(64)})).status,409);quiet(f);
 assert.equal((await post({clientId:'synthetic-client',expectedInstancePin:17})).status,400);quiet(f);
 assert.equal((await createAuthorizedHostRouter(f.services.store).request(`http://127.0.0.1/v1/mcp/servers/${id}/oauth/start`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
 const started=await post({clientId:'synthetic-client',expectedInstancePin:pin});assert.equal(started.status,200);assert.ok((await started.json()).authorization.authorizationUrl.includes('state='));
 const count=f.counts.fetch;assert.equal(f.services.nativeMcpAdmin.credentialStatus(id).state,'authorizing');
 assert.equal((await post({expectedInstancePin:'0'.repeat(64)})).status,409);assert.equal(f.counts.fetch,count);assert.equal(f.services.nativeMcpAdmin.credentialStatus(id).state,'authorizing');
 assert.equal((await post({clientId:'synthetic-client'})).status,200);assert.equal(f.services.nativeMcpAdmin.credentialStatus(id).state,'authorizing');
 assert.deepEqual([f.counts.load,f.counts.save,f.counts.custody],[0,0,0]);
});

test('Private OAuth start: remove/recreate while start returns cancels only the old flow, preserving replacement authorization',async t=>{
 const f=fixture(t,{fetch:oauthMetadataFetch()}),id='race-oauth';f.services.nativeMcpAdmin.addServer({definition:definition(id)});
 const oldPin=f.services.nativeMcpAdmin.instancePin(id),entered=Promise.withResolvers(),release=Promise.withResolvers(),original=McpOAuthClient.prototype.begin;let first=true;
 McpOAuthClient.prototype.begin=async function(...args){const value=await original.apply(this,args);if(first){first=false;entered.resolve();await release.promise;}return value;};
 t.after(()=>{release.resolve();McpOAuthClient.prototype.begin=original;});
 const old=f.services.nativeMcpAdmin.startOAuth(id,{clientId:'synthetic-old',expectedInstancePin:oldPin});const oldOutcome=old.then(()=>null,e=>e);
 await entered.promise;await f.services.nativeMcpAdmin.removeServer(id);f.services.nativeMcpAdmin.addServer({definition:definition(id)});
 const pin=f.services.nativeMcpAdmin.instancePin(id);assert.notEqual(pin,oldPin);
 await f.services.nativeMcpAdmin.startOAuth(id,{clientId:'synthetic-new',expectedInstancePin:pin});assert.equal(f.services.nativeMcpAdmin.credentialStatus(id).state,'authorizing');
 release.resolve();assert.equal((await oldOutcome).code,'store_conflict');assert.equal(f.services.nativeMcpAdmin.credentialStatus(id).state,'authorizing');assert.equal(f.services.nativeMcpAdmin.credentialStatus(id).lastError,null);
 assert.deepEqual([f.counts.load,f.counts.save,f.counts.custody],[0,0,0]);
});

test('OAuth client: stale metadata failure never contaminates the replacement flow status',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers(),base=oauthMetadataFetch();let first=true;
 const client=new McpOAuthClient({fetch:async(...args)=>{if(first){first=false;entered.resolve();await release.promise;throw Error('Synthetic old metadata failure');}return base(...args);}});
 t.after(()=>{release.resolve();return client.close();});
 const d=definition('metadata-race'),old=client.begin(d,{clientId:'synthetic-old'}).then(()=>null,e=>e);await entered.promise;
 const fresh=await client.begin(d,{clientId:'synthetic-new'});assert.equal(client.status(d).state,'authorizing');release.resolve();assert.equal((await old).code,'oauth_metadata_invalid');
 assert.equal(client.status(d).state,'authorizing');assert.equal(client.status(d).lastError,null);client.cancelStart(d.id,'https://issuer.example/authorize?state=wrong');
 assert.equal(client.status(d).state,'authorizing');client.cancelStart(d.id,fresh.authorizationUrl);assert.equal(client.pendingFlows,0);
});


test('OAuth handoff: effective own selection survives owner continuation without a live token; revoked selection cannot authorize',async t=>{
 let requests=0;const peer=createServer((req,res)=>{let body='';req.on('data',part=>body+=part.toString());req.on('end',()=>{requests++;
  if(req.method==='DELETE'){res.writeHead(202).end();return;}if(req.method!=='POST'){res.writeHead(405).end();return;}
  const message=JSON.parse(body);if(message.id===undefined){res.writeHead(202).end();return;}
  const send=value=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,...value}));
  if(message.method==='server/discover'){send({error:{code:-32601,message:'Synthetic legacy peer'}});return;}
  let result;if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-oauth-mcp',version:'1'}};
  else if(message.method==='tools/list')result={tools:[{name:'lookup',description:'Synthetic lookup',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{q:{type:'string',maxLength:50}},required:['q']}}]};
  else {assert.fail('Synthetic handoff must not invoke an app tool');}
  send({result});});});await new Promise(resolve=>peer.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{peer.closeAllConnections();peer.close(resolve);}));
 const resource=`http://127.0.0.1:${peer.address().port}/mcp`;
 const f=fixture(t,{load:async id=>({serverId:id,resource,resourceIndicator:resource,issuer:'https://issuer.example',tokenEndpoint:'https://issuer.example/token',
  clientId:'synthetic-client',clientSecret:null,accessToken:'synthetic-access-token',refreshToken:null,expiresAt:Date.now()+3600000,scope:'tools.read'})});
 const actor=f.bot(),initial=f.live(actor),registered=await registration(f,initial,'selected-oauth','oauth',resource);
 await f.services.nativeMcpAdmin.unlockCredentials('selected-oauth');const discovery=await f.services.nativeMcpAdmin.discover('selected-oauth',{unlockCredentials:false});
 assert.equal(discovery.server.status,'ready');assert.equal(discovery.tools.length,1);
 const tool=discovery.tools[0].id;f.services.nativeMcpAdmin.setBotSelection('selected-oauth',actor.id,{toolIds:[tool],policy:'ask'});
 const live=f.live(actor),inspect=await call(live,'mcp.inspect','own-selection-inspect',{server_id:'selected-oauth'});
 assert.equal(inspect.result.scopedBy,'reachable_own_selected_connection');
 const args={server_id:'selected-oauth',expected_instance_pin:registered.result.instancePin},pending=await call(live,'mcp.authorize','selected-handoff',args);
 const baseline={...f.counts},nativeRequests=requests;assert.equal(pending.status,'awaiting_approval');
 f.services.store.finishTurn(live.turn.id,'completed',null);await f.decide(pending);
 assert.equal(f.services.store.getAction(pending.actionId).state,'succeeded');assert.deepEqual(f.counts,baseline);assert.equal(requests,nativeRequests);
 const next=f.live(actor),revoked=await call(next,'mcp.authorize','revoked-selection',args);
 const connection=f.services.nativeMcpAdmin.instanceSelectionReview(actor.id).instances.find(v=>v.serverId==='selected-oauth');assert.ok(connection);
 f.services.store.setGrant({botId:actor.id,tool,destination:connection.connectionId,policy:'deny'});await f.decide(revoked);
 assert.equal((await call(next,'mcp.authorize','revoked-selection',args)).status,'blocked');assert.deepEqual(f.counts,baseline);assert.equal(requests,nativeRequests);
});


test('OAuth handoff: own succeeded discovery receipt establishes scope without authenticating or discovering again',async t=>{
 const f=fixture(t),actor=f.bot(),live=f.live(actor);f.services.nativeMcpAdmin.addServer({definition:definition('discover-oauth')});
 const pending=await call(live,'mcp.discover','discovery',{server_id:'discover-oauth'});assert.equal(pending.status,'awaiting_approval');await f.decide(pending);
 const discovered=await call(live,'mcp.discover','discovery',{server_id:'discover-oauth'});assert.equal(discovered.status,'succeeded');assert.equal(discovered.result.server.status,'needs_auth');quiet(f);
 const inspected=await call(live,'mcp.inspect','discover-inspect',{server_id:'discover-oauth',action_id:discovered.actionId});assert.equal(inspected.result.instance_pin,discovered.result.instancePin);
 const args=argumentsFor(discovered),handoff=await call(live,'mcp.authorize','discovery-handoff',args);await f.decide(handoff);
 assert.equal((await call(live,'mcp.authorize','discovery-handoff',args)).status,'succeeded');quiet(f);
});
