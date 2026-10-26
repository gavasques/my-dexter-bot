import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HostServices } from '../packages/cli/dist/host-services.js';
import { HarnessOperationSurface, HARNESS_OPERATION_DESTINATION } from '../packages/cli/dist/harness-operation-surface.js';
import { normalizeMcpHttpRegistration } from '../packages/connectors/dist/index.js';
import { APPROVAL_POLICY_SCOPE_VERSION, readMcpSetupDiagnostic } from '../packages/contracts/dist/index.js';
import { createHostApp } from '../packages/hub/dist/http.js';
import { gatewayReceiptEvidence } from '../packages/engines/dist/mcp-options.js';
import { DatabaseSync } from 'node:sqlite';
import { checkFullSchema } from '../packages/operations/dist/full-schemas.js';

const catalog=()=>[{id:'codex',available:true,models:[{id:'synthetic',reasoningEfforts:['medium'],speeds:[]}],defaultModel:'synthetic',reasoningEfforts:['medium'],speeds:[]}];
const driver=id=>({id,capabilities:{resume:true,interrupt:true,fork:false,steer:false},status:async()=>({engine:id,installed:true}),
 open:async threadId=>({threadId,nativeCursor:'synthetic'}),async *turn(session,turnId){yield{type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},
 respondToTool:async()=>{},interrupt:async()=>{},close:async()=>{}});
const registration=(server_id,url='http://127.0.0.1:9/known-endpoint',authentication='none')=>({schema_version:1,server_id,name:'Synthetic connection',url,authentication});
function fixture(t,options={}){
 const root=realpathSync(mkdtempSync('/private/tmp/d04-http-')), surfaces=[],turns=[];
 let services,app,sequence=0;
 const open=()=>{services=new HostServices({dataDir:join(root,'host'),enableEngines:true,enableMcp:true,engineCommands:{codex:'/usr/bin/false'},makeDriver:driver,engineCatalog:catalog,...options});
  app=createHostApp(services.store,{runtime:services.runtime,skills:services.skillsHttp,...(services.nativeMcpHttp?{mcp:services.nativeMcpHttp}:{})});};
 open();
 const surface=(over={})=>{const value=new HarnessOperationSurface({store:services.store,base:services.gateway,catalog:services.engineCatalog,
  runtime:()=>services.runtime,skills:()=>services.skillsHttp,effectiveSkills:()=>[],...(services.nativeMcpHttp?{mcp:()=>services.nativeMcpAdmin}:{}),...over});surfaces.push(value);return value;};
 const live=(bot,thread=services.store.createThread(bot.id),s=surface())=>{const{turn}=services.store.createTurn(thread.id,{clientRequestId:`manual-${++sequence}`,content:'Synthetic MCP setup'});
  services.store.claimNextTurn(thread.id);turns.push(turn);return{thread,turn,surface:s,token:s.issueCapability({turnId:turn.id}).token};};
 const decide=async receipt=>{const response=await app.request(`http://127.0.0.1/v1/actions/${receipt.actionId}/decisions`,{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({decision:'allow',requestHash:receipt.requestHash})});assert.equal(response.status,200);};
 const stop=async()=>{for(const s of surfaces.splice(0))await s.close();for(const turn of turns.splice(0))if(services.store.getTurn(turn.id).state==='running')services.store.finishTurn(turn.id,'completed',null);await services.shutdown();};
 t.after(async()=>{await stop();rmSync(root,{recursive:true,force:true});});
 return{root,get services(){return services;},get app(){return app;},surface,live,decide,stop,open,bot:()=>services.store.createBot({name:'Synthetic',profileId:'synthetic',engine:'codex'})};
}
const call=(live,name,callId,args={})=>live.surface.call(live.token,{connectionId:HARNESS_OPERATION_DESTINATION,tool:`dexter.harness.${name}`,callId,arguments:args});
async function approved(f,live,name,id,args){const proposal=await call(live,name,id,args);assert.equal(proposal.status,'awaiting_approval');await f.decide(proposal);return call(live,name,id,args);}
async function httpFixture(t){
 const seen=[], mode={schema:50,invalid:false};
 const server=createServer((req,res)=>{let body='';req.on('data',chunk=>{body+=chunk;if(body.length>32768)req.destroy();});req.on('end',()=>{
  if(req.method!=='POST'){res.writeHead(405).end();return;}
  const msg=JSON.parse(body);seen.push({method:msg.method,tool:msg.params?.name});
  if(msg.id===undefined){res.writeHead(202).end();return;}
  const reply=result=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:msg.id,result}));
  if(mode.invalid){res.writeHead(200,{'content-type':'application/json'}).end('not MCP');return;}
  if(msg.method==='initialize')reply({protocolVersion:msg.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'d04-synthetic',version:'1'}});
  else if(msg.method==='tools/list')reply({tools:[{name:'lookup',description:'Synthetic lookup',inputSchema:{type:'object',properties:{q:{type:'string',maxLength:mode.schema}},required:['q'],additionalProperties:false}}]});
  else if(msg.method==='tools/call')reply({content:[{type:'text',text:`synthetic:${msg.params.arguments.q}`}]});
  else res.writeHead(400).end();
 });});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 return{url:`http://127.0.0.1:${server.address().port}/exact-fixture-endpoint`,seen,mode};
}

test('D04 pure versioned URL normalization never fetches or guesses; secret URLs refuse without bytes; repeated endpoint has independent IDs',()=>{
 const saved=globalThis.fetch;globalThis.fetch=()=>{throw new Error('Normalizer must not fetch');};
 try{
  const input=registration('account-one',' HTTPS://EXAMPLE.test:443/docs '),one=normalizeMcpHttpRegistration(input);
  assert.equal(one.transport.url,'https://example.test/docs');assert.equal(one.id,'account-one');assert.equal(one.auth,'none');
  assert.deepEqual(normalizeMcpHttpRegistration(input),one);
  const two=normalizeMcpHttpRegistration({...input,server_id:'account-two'});assert.equal(two.transport.url,one.transport.url);assert.notEqual(two.id,one.id);
  assert.equal(normalizeMcpHttpRegistration(registration('private',input.url,'broker')).transport.headers.authorization.key,'token');
  for(const url of ['https://secret:synthetic@fixture.test/mcp','https://fixture.test/mcp?secret=synthetic','https://fixture.test/mcp#synthetic','https://fixture.test/mcp?','https://fixture.test/mcp#']){
   assert.throws(()=>normalizeMcpHttpRegistration(registration('reject',url)),e=>e.code==='endpoint_secret_refused'&&!e.message.includes(url)&&!e.message.includes('synthetic'));
  }
  for(const input of [registration('bad','http://192.168.1.1/mcp'),registration('bad','https://host.test/\npath'),{...registration('bad'),schema_version:2},{...registration('bad'),authentication:undefined},{...registration('bad'),server_id:undefined}])assert.throws(()=>normalizeMcpHttpRegistration(input));
  assert.equal(readMcpSetupDiagnostic({stage:'discovery',code:'response_invalid',recovery:'arbitrary-secret'}),null);
 }finally{globalThis.fetch=saved;}
});

test('D04 composition disabled has typed preadmission cause; enabled HTTP registration is mandatory human, zero effect, exact replay/restart and receipt scope',async t=>{
 const off=fixture(t),disabled=off.live(off.bot());assert.ok(!disabled.surface.listTools(disabled.token).some(x=>x.name.endsWith('mcp.add_http')));
 await assert.rejects(call(disabled,'mcp.add_http','off',registration('off')),e=>e.code==='unavailable'&&e.diagnostic.code==='native_mcp_disabled');
 const f=fixture(t,{nativeMcp:{runsOn:'owner_mac',oauth:false}}),bot=f.bot(),other=f.bot(),live=f.live(bot),args=registration('instance-one');
 f.services.store.setBotApprovalPolicy(bot.id,{expectedHostId:f.services.store.hostId,expectedRevision:0,clientRequestId:'human-mode',mode:'approve_all',eligibleScopeVersion:APPROVAL_POLICY_SCOPE_VERSION});
 f.services.store.setProposalGrant({botId:bot.id,tool:'dexter.harness.mcp.add_http',destination:HARNESS_OPERATION_DESTINATION,policy:'ask'});
 assert.equal(live.surface.listTools(live.token).find(x=>x.name.endsWith('mcp.add_http')).inputSchema.properties.schema_version.maximum,1);
 const pending=await call(live,'mcp.add_http','one',args);assert.equal(pending.status,'awaiting_approval');assert.equal(f.services.nativeMcpAdmin.listServers().length,0);
 await f.decide(pending);const receipt=await call(live,'mcp.add_http','one',args);assert.equal(receipt.status,'succeeded');assert.equal(receipt.result.discovered,false);
 assert.equal((await call(live,'mcp.add_http','one',args)).actionId,receipt.actionId);assert.equal(f.services.nativeMcpAdmin.listServers().length,1);
 await assert.rejects(call(live,'mcp.add_http','one',{...args,name:'changed'}),e=>e.code==='conflict');
 await assert.rejects(call(live,'mcp.add_http','duplicate',args),e=>e.code==='conflict'&&e.diagnostic.code==='server_exists');
 const inspect=await call(live,'mcp.inspect','inspect',{server_id:'instance-one',action_id:receipt.actionId});assert.equal(inspect.result.setup.state,'registered');
 assert.ok(!JSON.stringify(inspect.result).includes(args.url));
 const otherLive=f.live(other);await assert.rejects(call(otherLive,'mcp.inspect','foreign',{server_id:'instance-one',action_id:receipt.actionId}),e=>e.code==='forbidden');
 const thread=live.thread;await f.stop();f.open();const resumed=f.live(f.services.store.getBot(bot.id),thread);
 assert.equal((await call(resumed,'actions.read','receipt',{action_id:receipt.actionId})).result.id,receipt.actionId);
 assert.equal((await call(resumed,'mcp.inspect','resume',{server_id:'instance-one',action_id:receipt.actionId})).result.server.id,'instance-one');
 assert.equal(f.services.nativeMcpAdmin.listServers().length,1);assert.equal(f.services.store.listActions().filter(a=>a.request.tool.endsWith('mcp.add_http')).length,1);
});

test('D04 needs_auth is completed query, never connected or custody unlock; diagnostics persist and old instance receipt/pin refuses recreation',async t=>{
 let reads=0;const http=await httpFixture(t),f=fixture(t,{nativeMcp:{runsOn:'owner_mac',oauth:false,credentials:{custody:{kind:'synthetic',read:async()=>{reads++;return'synthetic';}}}}});
 const live=f.live(f.bot()),args=registration('locked',http.url,'broker'),added=await approved(f,live,'mcp.add_http','register',args);
 assert.equal(reads,0);assert.equal(http.seen.length,0);
 const auth=await approved(f,live,'mcp.discover','discover',{server_id:'locked'});assert.equal(auth.status,'succeeded');assert.equal(auth.result.queryCompleted,true);
 assert.equal(auth.result.server.status,'needs_auth');assert.equal(auth.result.setup.connectionReady,false);assert.equal(auth.result.setup.automaticNextStep,false);
 assert.deepEqual(auth.result.tools,[]);assert.equal(reads,0);assert.equal(http.seen.length,0);assert.equal(auth.result.server.diagnostic.code,'credential_locked');
 const plain=registration('plain',http.url),plainReceipt=await approved(f,live,'mcp.add_http','plain-add',plain);
 http.mode.invalid=true;const failed=await approved(f,live,'mcp.discover','plain-fail',{server_id:'plain'});
 assert.equal(failed.result.server.status,'failed');assert.equal(failed.result.server.diagnostic.stage,'discovery');assert.equal(failed.result.server.diagnostic.code,'protocol_unsupported');
 const stableDiagnostic=failed.result.server.diagnostic,thread=live.thread,botId=live.turn.botId;await f.stop();f.open();const resumed=f.live(f.services.store.getBot(botId),thread);
 const nativePath=join(f.root,'host','native-mcp.sqlite'),snapshotPath=join(f.root,'native-mcp-snapshot.sqlite');
 const db=new DatabaseSync(nativePath,{readOnly:true});try{
  assert.deepEqual(checkFullSchema(db,'nativeMcp'),{ownerId:f.services.store.ownerId,installationId:f.services.store.hostId});
  db.prepare('VACUUM INTO ?').run(snapshotPath);
 }finally{db.close();}
 const snapshot=new DatabaseSync(snapshotPath);try{
  assert.deepEqual(checkFullSchema(snapshot,'nativeMcp'),{ownerId:f.services.store.ownerId,installationId:f.services.store.hostId});
  assert.deepEqual(JSON.parse(snapshot.prepare('SELECT value FROM meta WHERE key=?').get('mcp-diagnostic:plain').value),stableDiagnostic);
  snapshot.prepare('INSERT INTO meta VALUES (?,?)').run('unexpected','synthetic');assert.throws(()=>checkFullSchema(snapshot,'nativeMcp'),e=>e.code==='unsupported_schema');
  snapshot.prepare('DELETE FROM meta WHERE key=?').run('unexpected');snapshot.prepare('UPDATE meta SET value=? WHERE key=?').run('not-a-generation','mcp-instance:plain');
  assert.throws(()=>checkFullSchema(snapshot,'nativeMcp'),e=>e.code==='corrupt');
 }finally{snapshot.close();}
 assert.deepEqual((await call(resumed,'mcp.inspect','failed-resume',{server_id:'plain',action_id:plainReceipt.actionId})).result.server.diagnostic,stableDiagnostic);
 const pending=await call(resumed,'mcp.discover','stale-generation',{server_id:'locked'}),oldPin=f.services.nativeMcpAdmin.configurationPin('locked');
 await f.services.nativeMcpAdmin.removeServer('locked');f.services.nativeMcpAdmin.addServer({definition:normalizeMcpHttpRegistration(args)});
 assert.notEqual(f.services.nativeMcpAdmin.configurationPin('locked'),oldPin);await f.decide(pending);assert.equal((await call(resumed,'mcp.discover','stale-generation',{server_id:'locked'})).status,'blocked');
 await assert.rejects(call(resumed,'mcp.inspect','old-receipt',{server_id:'locked',action_id:added.actionId}),e=>e.code==='conflict'&&e.diagnostic.code==='configuration_changed');
 assert.equal(reads,0);
});

test('D04 catalog schema and selection pin changes refuse before grant; postclaim partial registration stays unknown and exact replay never repeats',async t=>{
 const http=await httpFixture(t),f=fixture(t,{nativeMcp:{runsOn:'owner_mac',oauth:false}}),bot=f.bot(),live=f.live(bot);
 await approved(f,live,'mcp.add_http','register',registration('catalog',http.url));await approved(f,live,'mcp.discover','discover',{server_id:'catalog'});
 const tool='mcp.catalog.lookup',args={server_id:'catalog',tool_ids:[tool]},pending=await call(live,'mcp.select','stale',args),before=f.services.nativeMcpAdmin.tools('catalog');
 http.mode.schema=51;await f.services.nativeMcpAdmin.discover('catalog',{unlockCredentials:false});assert.deepEqual(f.services.nativeMcpAdmin.tools('catalog'),before);
 await f.decide(pending);assert.equal((await call(live,'mcp.select','stale',args)).status,'blocked');assert.deepEqual(f.services.nativeMcpAdmin.botSelection('catalog',bot.id).toolIds,[]);
 const selectionPending=await call(live,'mcp.select','selection-changed',args);f.services.nativeMcpAdmin.setBotSelection('catalog',bot.id,{toolIds:[tool],policy:'ask'});
 await f.decide(selectionPending);assert.equal((await call(live,'mcp.select','selection-changed',args)).status,'blocked');
 let effects=0;const admin=f.services.nativeMcpAdmin,s=f.surface({mcp:()=>({...admin,addServerWithReceipt:(input,authority)=>{effects++;admin.addServerWithReceipt(input,authority);throw new Error('synthetic partial with secret bytes discarded');}})}),uncertain=f.live(bot,undefined,s),uncertainArgs=registration('uncertain',http.url);
 const unknown=await approved(f,uncertain,'mcp.add_http','one-shot',uncertainArgs);assert.equal(unknown.status,'unknown');assert.equal(unknown.reason,'executor_error');assert.equal(effects,1);
 assert.equal((await call(uncertain,'mcp.add_http','one-shot',uncertainArgs)).status,'unknown');assert.equal(effects,1);
});

test('D04 identical endpoint registrations keep five independent instances/selections; future instance and revocation never broaden or retarget another bot',async t=>{
 const http=await httpFixture(t),f=fixture(t,{nativeMcp:{runsOn:'owner_mac',oauth:false}}),a=f.bot(),b=f.bot(),c=f.bot(),lives=[f.live(a),f.live(b),f.live(c)];
 for(let i=1;i<=5;i++){const id=`account-${i}`;await approved(f,lives[0],'mcp.add_http',`add-${i}`,registration(id,http.url));await approved(f,lives[0],'mcp.discover',`discover-${i}`,{server_id:id});}
 for(const [live,ids] of [[lives[0],[1]],[lives[1],[2,3]],[lives[2],[1,2,3,4,5]]])for(const i of ids)await approved(f,live,'mcp.select',`select-${i}`,{server_id:`account-${i}`,tool_ids:[`mcp.account-${i}.lookup`]});
 const connections=f.services.gateway.registry.listConnections('synthetic');assert.equal(new Set(connections.map(x=>x.id)).size,5);
 assert.deepEqual(f.services.nativeMcpAdmin.botSelection('account-2',a.id).toolIds,[]);assert.deepEqual(f.services.nativeMcpAdmin.botSelection('account-3',b.id).toolIds,['mcp.account-3.lookup']);
 await approved(f,lives[0],'mcp.add_http','add-6',registration('account-6',http.url));assert.deepEqual(f.services.nativeMcpAdmin.botSelection('account-6',c.id).toolIds,[]);
 await f.services.nativeMcpAdmin.removeServer('account-2');assert.deepEqual(f.services.nativeMcpAdmin.botSelection('account-1',a.id).toolIds,['mcp.account-1.lookup']);assert.deepEqual(f.services.nativeMcpAdmin.botSelection('account-3',b.id).toolIds,['mcp.account-3.lookup']);
 assert.equal(http.seen.filter(x=>x.method==='tools/call').length,0);
});

function socketRpc(path){
 const socket=createConnection(path),pending=new Map();let sequence=0,buffer='';
 const ready=new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});socket.on('error',()=>{});
 socket.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const i=buffer.indexOf('\n'),msg=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);const p=pending.get(msg.id);if(p){pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(new Error('Synthetic RPC refusal')):p.resolve(msg.result);}}});
 socket.on('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Synthetic RPC closed'));}pending.clear();});
 const rpc=async(method,params)=>{await ready;const id=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Synthetic RPC deadline'));},8000);pending.set(id,{resolve,reject,timer});socket.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});};
 return{rpc,initialize:async()=>{await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'D04-synthetic',version:'1'}});socket.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');},close:()=>socket.destroy()};
}

test('D04 actual native MCP bridge/controller/scripted engine: HTTP registration → owner discovery → own selection → next-turn invocation → consumed receipt and response', {timeout:30000},async t=>{
 const http=await httpFixture(t),root=realpathSync(mkdtempSync('/private/tmp/d04-engine-')),clients=[];let services,app,round=0,driverFailure=null;
 const until=async predicate=>{const end=Date.now()+8000;while(!predicate()){if(Date.now()>end)throw new Error('Synthetic owner decision deadline');await new Promise(resolve=>setTimeout(resolve,10));}};
 const makeDriver=(id,options)=>({id,capabilities:{resume:true,interrupt:true,fork:false,steer:false},status:async()=>({engine:id,installed:true}),open:async threadId=>{
  const rpc=socketRpc(options.localMcpServer.args[1]);clients.push(rpc);await rpc.initialize();return{threadId,nativeCursor:'synthetic',rpc};},
 async *turn(session,turnId){
  try {
  round++;const tools=(await session.rpc.rpc('tools/list',{})).tools;
  const invoke=async(name,callId,input)=>{const direct=tools.find(t=>t.title.startsWith(name+' '));if(direct)return session.rpc.rpc('tools/call',{name:direct.name,arguments:{callId,input}});
   const found=await session.rpc.rpc('tools/call',{name:'dx_catalog_search',arguments:{query:name,limit:20}}),entry=found.structuredContent.tools.find(t=>t.title===name);assert.ok(entry,name);
   const described=await session.rpc.rpc('tools/call',{name:'dx_catalog_describe',arguments:{alias:entry.alias}});assert.equal(described.isError,false);
   return session.rpc.rpc('tools/call',{name:'dx_catalog_call',arguments:{alias:entry.alias,callId,input}});};
  const decideCall=async(name,callId,input)=>{const operation=invoke(name,callId,input);
   await until(()=>services.store.listActions('awaiting_approval').some(a=>a.request.tool===name));const action=services.store.listActions('awaiting_approval').find(a=>a.request.tool===name);
   const decision=await app.request(`http://127.0.0.1/v1/actions/${action.id}/decisions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:'allow',requestHash:action.requestHash})});assert.equal(decision.status,200);
   const result=await operation;assert.equal(result.isError,false);assert.equal(result.structuredContent.status,'succeeded');return result.structuredContent;};
  if(round===1){
   const invalid=await invoke('dexter.harness.mcp.add_http','invalid-endpoint',registration('invalid',http.url+'?synthetic-secret=must-not-return'));
   assert.equal(invalid.isError,true);assert.equal(invalid.structuredContent.outcome,'refused_before_admission');assert.equal(invalid.structuredContent.diagnostic.code,'endpoint_secret_refused');
   assert.ok(!JSON.stringify(invalid).includes('must-not-return'));assert.equal(services.store.listActions().length,0);assert.equal(http.seen.length,0);
   const added=await decideCall('dexter.harness.mcp.add_http','register',registration('journey',http.url));assert.equal(http.seen.length,0);assert.equal(added.result.discovered,false);
   for(const receipt of gatewayReceiptEvidence(added))yield{type:'tool.result.observed',threadId:session.threadId,turnId,...receipt};
   const found=await decideCall('dexter.harness.mcp.discover','discover',{server_id:'journey'});assert.equal(found.result.setup.state,'tools_available');assert.equal(http.seen.filter(x=>x.method==='tools/call').length,0);
   for(const receipt of gatewayReceiptEvidence(found))yield{type:'tool.result.observed',threadId:session.threadId,turnId,...receipt};
   const selected=await decideCall('dexter.harness.mcp.select','select',{server_id:'journey',tool_ids:['mcp.journey.lookup']});assert.equal(selected.result.appliesNextTurn,true);
   for(const receipt of gatewayReceiptEvidence(selected))yield{type:'tool.result.observed',threadId:session.threadId,turnId,...receipt};
   assert.ok(!(await session.rpc.rpc('tools/list',{})).tools.some(t=>t.title.startsWith('mcp.journey.lookup ')));
   yield{type:'text.delta',threadId:session.threadId,turnId,text:'Registered, discovered and selected for next turn.'};
  }else{
   const invoked=await decideCall('mcp.journey.lookup','invoke',{q:'owned-fixture'});assert.equal(invoked.result.content[0].text,'synthetic:owned-fixture');
   for(const receipt of gatewayReceiptEvidence(invoked))yield{type:'tool.result.observed',threadId:session.threadId,turnId,...receipt};
   yield{type:'text.delta',threadId:session.threadId,turnId,text:JSON.stringify({answer:'Synthetic MCP result received.',receipt:invoked})};
  }
  yield{type:'turn.completed',threadId:session.threadId,turnId,usage:{}};
  } catch(error) {driverFailure={code:error?.code??null,name:error?.name??null,message:String(error?.message??'').split('\n')[0].slice(0,120).replaceAll('must-not-return','[synthetic redacted]')};throw error;}
 },respondToTool:async()=>{},interrupt:async()=>{},close:async session=>session.rpc.close()});
 t.after(async()=>{for(const c of clients)c.close();await services?.shutdown();rmSync(root,{recursive:true,force:true});});
 services=new HostServices({dataDir:join(root,'host'),enableEngines:true,enableMcp:true,nativeMcp:{runsOn:'owner_mac',oauth:false},engineCommands:{codex:'/usr/bin/false'},makeDriver,engineCatalog:catalog});
 app=createHostApp(services.store,{runtime:services.runtime,skills:services.skillsHttp,mcp:services.nativeMcpHttp});
 const bot=services.store.createBot({name:'Synthetic engine',profileId:'synthetic',engine:'codex'}),thread=services.store.createThread(bot.id);
 for(const content of ['setup','invoke']){const{turn}=services.runtime.startTurn(thread.id,{clientRequestId:content,content});const finished=await services.runtime.waitForTurn(turn.id,12000);assert.equal(finished.state,'completed',JSON.stringify({code:finished.code,driverFailure}));}
 const actions=services.store.listActions();assert.equal(actions.length,4,JSON.stringify(actions.map(a=>({tool:a.request.tool,state:a.state,progress:services.store.toolActionProgress(a.id)}))));assert.ok(actions.every(a=>a.state==='succeeded'&&services.store.toolActionProgress(a.id).consumedByEngine));
 assert.equal(http.seen.filter(x=>x.method==='tools/call').length,1);assert.equal(services.store.listActions('awaiting_approval').length,0);
 const last=services.store.listTurns(thread.id).find(t=>services.store.turnOutput(t.id).includes('Synthetic MCP result received.'));assert.ok(last);
 assert.equal(JSON.parse(services.store.turnOutput(last.id)).receipt.result.content[0].text,'synthetic:owned-fixture');
});
