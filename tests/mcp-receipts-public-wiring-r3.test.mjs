import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, after } from 'node:test';
const originalFetch=globalThis.fetch;let fetchCalls=0;
globalThis.fetch=async()=>{fetchCalls++;throw Error('unexpected network blocked in synthetic MCP fixture');};
after(()=>{globalThis.fetch=originalFetch;});
import { HostServices } from '../packages/cli/dist/host-services.js';
import { HarnessOperationSurface, HARNESS_OPERATION_DESTINATION } from '../packages/cli/dist/harness-operation-surface.js';
import { createHostApp } from '../packages/hub/dist/http.js';
import { APPROVAL_POLICY_SCOPE_VERSION } from '../packages/contracts/dist/index.js';
import { mcpSetupHash } from '../packages/connectors/dist/index.js';
const driver = id => ({id,capabilities:{resume:true,interrupt:true,fork:false,steer:false},status:async()=>({engine:id,installed:true}),
 open:async threadId=>({threadId,nativeCursor:'synthetic'}),async *turn(session,turnId){yield{type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},respondToTool:async()=>{},interrupt:async()=>{},close:async()=>{}});
const catalog = async()=>[{id:'codex',available:true,models:[{id:'synthetic',reasoningEfforts:[],speeds:[]}],defaultModel:'synthetic',reasoningEfforts:[],speeds:[]}];
const httpArgs = (id, url=' HTTPS://EXAMPLE.test:443/mcp ')=>( {schema_version:1,server_id:id,name:'Synthetic connection',url,authentication:'none'} );
const definition = id=>({id,name:'Synthetic',auth:'none',runsOn:'any',transport:{type:'streamable_http',url:'https://example.test/mcp'}});
const readRows = (dir,table='setup_receipts')=>{const db=new DatabaseSync(join(dir,'native-mcp.sqlite'),{readOnly:true});try{return db.prepare(`SELECT * FROM ${table}`).all();}finally{db.close();}};
function fixture(t, oauth=true){
 const root=realpathSync(mkdtempSync('/private/tmp/dexter-mcp-public-r3-synthetic-')),surfaces=[],turns=[],counts={fetch:0,custody:0,load:0,save:0,remove:0,registrations:0};let services,app,sequence=0,lose=false;
 const open=()=>{
  services=new HostServices({dataDir:join(root,'host'),enableEngines:true,enableMcp:true,engineCommands:{codex:'/usr/bin/false'},makeDriver:driver,engineCatalog:catalog,
   nativeMcp:{runsOn:'owner_mac',oauth:oauth?{store:{load:async()=>{counts.load++;throw Error('unexpected synthetic token load');},save:async()=>{counts.save++;throw Error('unexpected synthetic token save');},remove:async()=>{counts.remove++;throw Error('unexpected synthetic token remove');}}}:false,
    credentials:{custody:{kind:'synthetic',read:async()=>{counts.custody++;throw Error('unexpected synthetic custody');}}}}});
  const native=services.nativeMcpAdmin;
  const proxy=Object.freeze({...native,addServerWithReceipt:(input,authority)=>{const value=native.addServerWithReceipt(input,authority);counts.registrations++;if(lose){lose=false;throw Error('synthetic postcommit response lost');}return value;}});
  Object.defineProperty(services,'nativeMcpAdmin',{get:()=>proxy});
  app=createHostApp(services.store,{runtime:services.runtime,mcp:services.nativeMcpHttp});
 };
 const surface=()=>{const s=new HarnessOperationSurface({store:services.store,base:services.gateway,catalog:services.engineCatalog,runtime:()=>services.runtime,skills:()=>services.skillsHttp,effectiveSkills:()=>[],mcp:()=>services.nativeMcpAdmin});surfaces.push(s);return s;};
 const live=(bot,thread=services.store.createThread(bot.id))=>{const {turn}=services.store.createTurn(thread.id,{clientRequestId:`manual-${++sequence}`,content:'Synthetic MCP registration'});services.store.claimNextTurn(thread.id);turns.push(turn);const s=surface();return{bot,thread,turn,surface:s,token:s.issueCapability({turnId:turn.id}).token};};
 const decide=async(p,decision)=>{const r=await app.request(`http://127.0.0.1/v1/actions/${p.actionId}/decisions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision,requestHash:p.requestHash})});assert.equal(r.status,200);return r.json();};
 const stop=async()=>{for(const s of surfaces.splice(0))await s.close();for(const turn of turns.splice(0)){const value=services.store.getTurn(turn.id);if(value.state==='running')services.store.finishTurn(turn.id,'completed',null);}await services.shutdown();};
 open();t.after(async()=>{await stop();rmSync(root,{recursive:true,force:true});});
 return{root,counts,get services(){return services;},get app(){return app;},live,decide,stop,open,lose:()=>{lose=true;},bot:()=>services.store.createBot({name:'Synthetic',engine:'codex',profileId:'synthetic'})};
}
const call=(live,name,id,args={})=>live.surface.call(live.token,{connectionId:HARNESS_OPERATION_DESTINATION,tool:`dexter.harness.${name}`,callId:id,arguments:args});
const quiet=f=>{assert.equal(fetchCalls,0);assert.deepEqual([f.counts.fetch,f.counts.custody,f.counts.load,f.counts.save,f.counts.remove],[0,0,0,0,0]);};

// Real HostServices decision continuation, canonical writer and HTTP app, with synthetic driver only. No socket/OAuth/account.
test('MCP R3: add_http and add require exact Allow, Deny has zero effects, immutable original input and forged provenance refuse',async t=>{
 for(const tool of ['mcp.add_http','mcp.add']){
  const f=fixture(t),bot=f.bot(),live=f.live(bot);
  f.services.store.setBotApprovalPolicy(bot.id,{expectedHostId:f.services.store.hostId,expectedRevision:0,clientRequestId:'synthetic-approve-all',mode:'approve_all',eligibleScopeVersion:APPROVAL_POLICY_SCOPE_VERSION});
  const args=id=>tool==='mcp.add_http'?httpArgs(id):{definition_json:JSON.stringify(definition(id))};
  const denied=await call(live,tool,'denied',args('denied-instance'));assert.equal(denied.status,'awaiting_approval');await f.decide(denied,'deny');
  assert.equal(f.counts.registrations,0);assert.equal(f.services.nativeMcpAdmin.listServers().length,0);
  await assert.rejects(call(live,'mcp.registration_receipt','denied-read',{action_id:denied.actionId}),e=>e.code==='forbidden');
  const input=args('one-instance'),pending=await call(live,tool,'allowed',input);assert.equal(pending.status,'awaiting_approval');assert.equal(f.counts.registrations,0);
  await f.decide(pending,'allow');const result=await call(live,tool,'allowed',input);assert.equal(result.status,'succeeded');assert.equal(f.counts.registrations,1);
  const action=f.services.store.getAction(result.actionId),receipt=action.result.registrationReceipt;
  assert.equal(action.authorization.source,'exact_owner');assert.equal(receipt.requestIdHash,mcpSetupHash({requestId:`action:${action.id}`}));
  assert.equal(receipt.inputHash,mcpSetupHash(JSON.parse(action.request.arguments.input.registrationDefinitionJson)));
  assert.notEqual(receipt.requestHash,action.requestHash);assert.equal(action.result.nativeRequestHash,receipt.requestHash);
  const read=await call(live,'mcp.registration_receipt','read',{action_id:action.id});assert.equal(read.result.registration.instanceState,'registered');assert.deepEqual(read.result.registration.receipt,receipt);
  const capacity=await call(live,'mcp.registration_journal_status','capacity');assert.deepEqual(capacity.result,{version:1,used:1,limit:4096,remaining:4095,registrationCapacity:'available'});
  const changed=tool==='mcp.add_http'?{...input,url:'https://example.test/mcp'}:{definition_json:JSON.stringify({...definition('one-instance'),readOnlyTools:[]})};
  await assert.rejects(call(live,tool,'allowed',changed),e=>e.code==='conflict','Changed raw input refuses even when normalization is identical');
  await assert.rejects(call(live,tool,'forged',{...args('forged-instance'),origin:{kind:'owner_local'},botId:bot.id}),e=>e.code==='invalid_input');
  if(tool==='mcp.add')await assert.rejects(call(live,tool,'source',{definition_json:JSON.stringify({...definition('forged-source'),source:{format:'manual',name:'fake'}})}),e=>e.code==='invalid_input');
  const other=f.live(f.bot());await assert.rejects(call(other,'mcp.registration_receipt','other',{action_id:action.id}),e=>e.code==='forbidden');
  const otherThread=f.live(bot);await assert.rejects(call(otherThread,'mcp.registration_receipt','thread',{action_id:action.id}),e=>e.code==='forbidden');
  const db=new DatabaseSync(f.services.store.databasePath,{readOnly:true});try{assert.equal(db.prepare("SELECT count(*) AS n FROM grants WHERE tool GLOB 'mcp.*'").get().n,0);}finally{db.close();}
  assert.equal(readRows(join(f.root,'host')).length,1);assert.equal((await call(live,tool,'allowed',input)).actionId,action.id);assert.equal(f.counts.registrations,1);quiet(f);
 }
});

test('MCP R3: postcommit failure recovers by original action on owner/bot reads and reopen without repost or promoting unknown',async t=>{
 const f=fixture(t),bot=f.bot(),live=f.live(bot),input=httpArgs('lost-instance');
 const pending=await call(live,'mcp.add_http','lost',input);f.lose();await f.decide(pending,'allow');
 const dispatched=await call(live,'mcp.add_http','lost',input);assert.equal(dispatched.status,'unknown');
 assert.equal(f.services.store.getAction(pending.actionId).state,'unknown');assert.equal(f.counts.registrations,1);
 const stored=JSON.parse(readRows(join(f.root,'host'))[0].receipt);
 const read=await call(live,'mcp.registration_receipt','query',{action_id:pending.actionId});assert.equal(read.result.dispatcherState,'unknown');assert.deepEqual(read.result.registration,{receipt:stored,instanceState:'registered'});
 const response=await f.app.request(`http://127.0.0.1/v1/mcp/actions/${pending.actionId}/registration-receipt`);assert.equal(response.status,200);assert.deepEqual((await response.json()).registration.receipt,stored);
 assert.equal((await call(live,'mcp.add_http','lost',input)).status,'unknown');assert.equal(f.counts.registrations,1);
 const thread=live.thread;await f.stop();f.open();const current=f.live(f.services.store.getBot(bot.id),thread);
 const recovered=await call(current,'mcp.registration_receipt','after-reopen',{action_id:pending.actionId});assert.equal(recovered.result.dispatcherState,'unknown');assert.deepEqual(recovered.result.registration.receipt,stored);
 assert.equal(readRows(join(f.root,'host')).length,1);assert.equal(f.counts.registrations,1);assert.equal(f.services.nativeMcpAdmin.listServers().length,1);
 await assert.rejects(call(current,'mcp.add_http','different-call',input),e=>e.code==='conflict');quiet(f);
});

test('MCP R3: owner exact request routes recover committed 503, deduplicate and reject changed or forged origin bodies',async t=>{
 const f=fixture(t),input={requestId:'owner-exact',expectedInstancePin:null,definition:definition('owner-instance')};f.lose();
 const post=body=>f.app.request('http://127.0.0.1/v1/mcp/registrations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const lost=await post(input);assert.equal(lost.status,503);assert.equal((await lost.json()).error,'outcome_unknown');assert.equal(f.counts.registrations,1);
 const read=await f.app.request('http://127.0.0.1/v1/mcp/registrations/owner-exact');assert.equal(read.status,200);const receipt=(await read.json()).registration.receipt;
 assert.equal(f.counts.registrations,1);const replay=await post(input);assert.equal(replay.status,201);assert.deepEqual((await replay.json()).receipt,receipt);
 assert.equal(readRows(join(f.root,'host')).length,1);assert.equal(f.services.nativeMcpAdmin.listServers().length,1);
 assert.equal((await post({...input,definition:{...input.definition,readOnlyTools:[]}})).status,400);
 assert.equal((await post({...input,origin:{kind:'owner_local'},installationId:f.services.store.hostId})).status,400);
 assert.equal((await post({...input,definition:{...input.definition,source:{format:'manual',name:'fake'}}})).status,400);
 assert.equal((await f.app.request('http://127.0.0.1/v1/mcp/registrations/owner-exact?origin=forged')).status,400);
 const status=await f.app.request('http://127.0.0.1/v1/mcp/registration-journal');assert.equal((await status.json()).used,1);
 const before=f.counts.registrations;await f.stop();f.open();const after=await f.app.request('http://127.0.0.1/v1/mcp/registrations/owner-exact');assert.deepEqual((await after.json()).registration.receipt,receipt);assert.equal(f.counts.registrations,before);quiet(f);
});

test('MCP R3: removed/replaced old receipts remain history and cannot unlock current inspect or grants',async t=>{
 const f=fixture(t,false),bot=f.bot(),live=f.live(bot),input=httpArgs('old-instance');const pending=await call(live,'mcp.add_http','old',input);await f.decide(pending,'allow');const original=await call(live,'mcp.add_http','old',input);
 await f.services.nativeMcpAdmin.removeServer('old-instance');
 const removed=await call(live,'mcp.registration_receipt','removed',{action_id:original.actionId});assert.equal(removed.result.registration.instanceState,'removed');
 const owner={requestId:'replacement',expectedInstancePin:null,definition:definition('old-instance')};
 const replacement=await f.app.request('http://127.0.0.1/v1/mcp/registrations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(owner)});assert.equal(replacement.status,201);
 const replaced=await call(live,'mcp.registration_receipt','replaced',{action_id:original.actionId});assert.equal(replaced.result.registration.instanceState,'replaced');assert.notEqual(f.services.nativeMcpAdmin.instancePin('old-instance'),original.result.instancePin);
 await assert.rejects(call(live,'mcp.inspect','inspect',{server_id:'old-instance',action_id:original.actionId}),e=>e.code==='conflict');
 assert.equal(f.services.nativeMcpAdmin.botSelection('old-instance',bot.id).toolIds.length,0);assert.equal(f.services.gateway.registry.listConnections().length,0);quiet(f);
});
