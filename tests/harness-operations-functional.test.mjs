import { mcpDirectoryClient } from './fixtures/mcp-directory-client.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {createConnection} from 'node:net';
import {tmpdir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Package smoke can run only `integrated composition` with every import resolved inside the new app resource.
const packageRoot=process.env.DEXTER_HARNESS_PACKAGE_ROOT;
if(packageRoot!==undefined&&!isAbsolute(packageRoot))throw new Error('DEXTER_HARNESS_PACKAGE_ROOT must be absolute.');
const moduleRoot=packageRoot??resolve('.');
const load=(relative)=>import(pathToFileURL(join(moduleRoot,packageRoot===undefined?relative:
 relative.replace(/^packages\/([^/]+)\//,'node_modules/@dexter/$1/'))).href);
const [{HostServices},{HarnessOperationSurface,HARNESS_OPERATION_DESTINATION},{createHostApp},guide,{gatewayReceiptEvidence}]=await Promise.all([
 load('packages/cli/dist/host-services.js'),load('packages/cli/dist/harness-operation-surface.js'),
 load('packages/hub/dist/http.js'),load('packages/context/dist/index.js'),load('packages/engines/dist/mcp-options.js'),
]);
const refused=error=>['invalid_input','forbidden','conflict','unauthorized','unavailable'].includes(error.code);
const catalog=()=>[{id:'codex',available:true,installed:true,adapterSupported:true,defaultModel:'synthetic-model',
 reasoningEfforts:['medium'],speeds:['fast'],models:[{id:'synthetic-model',label:'Synthetic',reasoningEfforts:['medium'],speeds:['fast']}]}];
const syntheticDriver=id=>({id,capabilities:{resume:true,interrupt:true,fork:false,steer:false},
 status:async()=>({engine:id,installed:true,authentication:'unverified',billing:'unknown'}),
 open:async threadId=>({threadId,nativeCursor:'synthetic-only'}),
 async *turn(session,turnId){yield{type:'text.delta',threadId:session.threadId,turnId,text:'Synthetic'};
  yield{type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},
 respondToTool:async()=>{},interrupt:async()=>{},close:async()=>{}});

function fixture(t,options={}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-harness-')));
 const services=new HostServices({dataDir:join(root,'host'),enableEngines:true,enableMcp:true,
  engineCommands:{codex:'/usr/bin/false'},makeDriver:syntheticDriver,engineCatalog:catalog,...options});
 const app=createHostApp(services.store,{runtime:services.runtime,skills:services.skillsHttp,
  ...(services.nativeMcpHttp?{mcp:services.nativeMcpHttp}:{})});
 const surfaces=[],turns=[];
 const surface=(overrides={})=>{
  const value=new HarnessOperationSurface({store:services.store,base:services.gateway,catalog:services.engineCatalog,
   runtime:()=>services.runtime,skills:()=>services.skillsHttp,
   effectiveSkills:turnId=>{const token=services.context.issue(turnId);try{return services.context.skills(token);}finally{services.context.revoke(token);}},
   ...(services.nativeMcpHttp?{mcp:()=>services.nativeMcpAdmin}:{}),...overrides});
  surfaces.push(value);return value;
 };
 const live=(bot,toolSurface=surface())=>{
  const thread=services.store.createThread(bot.id),{turn}=services.store.createTurn(thread.id,{clientRequestId:`manual-${turns.length}`,content:'Synthetic harness request'});
  assert.equal(services.store.claimNextTurn(thread.id).id,turn.id);turns.push(turn);
  return{thread,turn,surface:toolSurface,token:toolSurface.issueCapability({turnId:turn.id}).token};
 };
 const request=(method,path,body)=>app.request(`http://127.0.0.1${path}`,{method,headers:{'content-type':'application/json'},
  ...(body===undefined?{}:{body:JSON.stringify(body)})});
 const decide=async(receipt,decision='allow',requestHash=receipt.requestHash)=>{
  const response=await request('POST',`/v1/actions/${receipt.actionId}/decisions`,{decision,requestHash});
  return{status:response.status,body:await response.json()};
 };
 const bot=(name='Actor')=>services.store.createBot({name,profileId:'synthetic',engine:'codex'});
 t.after(async()=>{
  for(const value of surfaces)await value.close();
  for(const turn of turns)if(services.store.getTurn(turn.id).state==='running')services.store.finishTurn(turn.id,'completed',null);
  await services.shutdown();rmSync(root,{recursive:true,force:true});
 });
 return{root,services,app,bot,surface,live,request,decide};
}
const call=(live,name,callId,args={})=>live.surface.call(live.token,{connectionId:HARNESS_OPERATION_DESTINATION,
 tool:`dexter.harness.${name}`,callId,arguments:args});
async function approved(f,live,name,callId,args){
 const pending=await call(live,name,callId,args);assert.equal(pending.status,'awaiting_approval');
 assert.equal((await f.decide(pending)).status,200);return call(live,name,callId,args);
}

test('harness proposals: owner UI sees exact request; deny, hash, replay, scope and grant boundaries are durable',async t=>{
 const f=fixture(t),actor=f.bot(),other=f.bot('Other private bot'),live=f.live(actor);
 const before=f.services.store.listBots().length;
 assert.equal(f.services.store.summary().counts.grants,0,'listing/issuing grants nothing');
 assert.ok(live.surface.listTools(live.token).filter(view=>view.name.startsWith('dexter.harness.')).every(view=>view.effect==='read'||view.requiresApproval));
 const args={name:'New specialist',engine:'codex',model:'synthetic-model',reasoning_effort:'medium',speed:'fast'};
 const denied=await call(live,'bots.create','deny-bot',args);assert.equal(denied.status,'awaiting_approval');
 const visible=await(await f.request('GET',`/v1/actions/${denied.actionId}`)).json();
 assert.equal(visible.request.tool,'dexter.harness.bots.create');assert.equal(visible.request.destination,HARNESS_OPERATION_DESTINATION);
 assert.equal(visible.request.botId,actor.id);assert.equal(visible.request.threadId,live.thread.id);
 assert.equal(visible.request.arguments.input.name,args.name);assert.equal(f.services.store.listBots().length,before);
 assert.equal((await f.decide(denied,'allow','0'.repeat(64))).status,409);
 assert.equal((await f.decide(denied,'deny')).status,200);assert.equal((await call(live,'bots.create','deny-bot',args)).status,'denied');
 assert.equal(f.services.store.listBots().length,before);
 const made=await approved(f,live,'bots.create','make-bot',args);assert.equal(made.status,'succeeded');
 const created=f.services.store.getBot(made.result.bot.id);
 assert.equal(created.profileId,actor.profileId);assert.equal(created.ownerId,actor.ownerId);
 assert.equal(created.canSeeBots,false);assert.equal(created.canReceiveOrders,false);assert.equal(created.canSendActions,false);assert.equal(created.isMaster,false);
 assert.deepEqual(made.result.grantedTools,[]);assert.equal(f.services.store.listBots().length,before+1);
 assert.equal((await call(live,'bots.create','make-bot',args)).actionId,made.actionId);
 assert.equal(f.services.store.listBots().length,before+1,'same-call replay never creates a second bot');
 await assert.rejects(call(live,'bots.create','make-bot',{...args,name:'Changed'}),error=>error.code==='conflict');
 await assert.rejects(call(live,'bots.create','spoof',{...args,profileId:'foreign'}),refused);
 await assert.rejects(call(live,'bots.create','master',{...args,isMaster:true}),refused);
 await assert.rejects(call(live,'skills.activate','foreign',{skill_id:'shared',scope:'bot',botId:other.id}),refused);
 for(const policy of ['deny','allow']){
  f.services.store.setGrant({botId:actor.id,tool:'dexter.harness.bots.create',destination:HARNESS_OPERATION_DESTINATION,policy});
  assert.ok(!live.surface.listTools(live.token).some(view=>view.name==='dexter.harness.bots.create'));
  await assert.rejects(call(live,'bots.create',`grant-${policy}`,args),refused);
  assert.equal(f.services.store.getGrant(actor.id,'dexter.harness.bots.create',HARNESS_OPERATION_DESTINATION).policy,policy);
 }
 const status=await call(live,'status','own-status');assert.equal(status.result.bot.id,actor.id);
 assert.ok(!JSON.stringify(status.result).includes(other.id));assert.ok(!JSON.stringify(status.result).includes(f.root));
 const models=await call(live,'models','models');assert.equal(models.result.items[0].models[0].id,'synthetic-model');
 const index=await call(live,'guide','index');assert.deepEqual(index.result.topics.map(item=>item.id),guide.HARNESS_GUIDE_TOPICS.map(item=>item.id));
 const topic=await call(live,'guide','mcp-topic',{topic:'mcp'});assert.equal(createHash('sha256').update(topic.result.markdown).digest('hex'),topic.result.sha256);
 assert.equal(f.services.store.getGrant(other.id,'dexter.harness.bots.create',HARNESS_OPERATION_DESTINATION),null);
});

test('harness skills: immutable registration, own/global CAS and stale owner approval cannot overwrite a changed lock',async t=>{
 const f=fixture(t),actor=f.bot(),other=f.bot('Other'),live=f.live(actor);
 const registered=await approved(f,live,'skills.register','register',{skill_id:'reusable',version:'1.0.0',markdown:'SYNTHETIC_REUSABLE_INSTRUCTION'});
 assert.equal(registered.status,'succeeded');assert.equal(registered.result.activated,false);
 assert.equal(f.services.skillsHttp.listSkillActivations({scopeKind:'bot',botId:actor.id}).items.length,0);
 await assert.rejects(call(live,'skills.register','overwrite',{skill_id:'reusable',version:'1.0.0',markdown:'Overwrite'}),refused);
 const first=registered.result.skill;
 const activate=await approved(f,live,'skills.activate','activate',{skill_id:first.id,scope:'bot',version:first.version});
 assert.equal(activate.status,'succeeded');assert.equal(activate.result.appliesNextTurn,true);
 assert.equal(f.services.skillsHttp.listSkillActivations({scopeKind:'bot',botId:other.id}).items.length,0);
 const second=f.services.skillsHttp.registerSkill(first.id,'2.0.0','SYNTHETIC_SECOND');
 const third=f.services.skillsHttp.registerSkill(first.id,'3.0.0','SYNTHETIC_OWNER_CHANGE');
 const args={skill_id:first.id,scope:'bot',version:second.version,expected_version:first.version,expected_sha256:first.sha256};
 const pending=await call(live,'skills.activate','stale-cas',args);
 f.services.skillsHttp.setSkillActivation(first.id,{scope:{kind:'bot',botId:actor.id},expected:{version:first.version,sha256:first.sha256},version:third.version});
 assert.equal((await f.decide(pending)).status,200);const blocked=await call(live,'skills.activate','stale-cas',args);
 assert.equal(blocked.status,'blocked');assert.equal(blocked.reason,'permission_changed');
 assert.equal(f.services.skillsHttp.listSkillActivations({scopeKind:'bot',botId:actor.id}).items[0].lock.version,third.version);
 const global=await approved(f,live,'skills.activate','global',{skill_id:first.id,scope:'global',version:first.version});
 assert.equal(global.status,'succeeded');assert.deepEqual(global.result.scope,{kind:'global'});
 await assert.rejects(call(live,'skills.activate','missing-expect',{skill_id:first.id,scope:'bot',version:second.version,expected_version:third.version}),refused);
});

const fakeStdio=`import{appendFileSync,readFileSync}from'node:fs';import{createInterface}from'node:readline';
const[flag,log]=process.argv.slice(2);appendFileSync(log,JSON.stringify({started:true,inherited:process.env.DEXTER_TEST_PRIVATE_SENTINEL??null})+'\\n');
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
if(m.method==='server/discover')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}})+'\\n');
else if(m.method==='initialize')send(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'SyntheticHarness',version:'1'}});
else if(m.method==='tools/list'){const maximum=Number(readFileSync(flag,'utf8'));appendFileSync(log,JSON.stringify({list:true,maximum})+'\\n');send(m.id,{tools:[{name:'echo_text',description:'Synthetic echo',inputSchema:{type:'object',additionalProperties:false,required:['text'],properties:{text:{type:'string',maxLength:maximum}}}}]});}
else if(m.method==='tools/call'){appendFileSync(log,JSON.stringify({call:m.params.name})+'\\n');send(m.id,{content:[{type:'text',text:JSON.stringify({echo:m.params.arguments.text})}]});}
else send(m.id,{});});`;
function fakeDefinition(root,id='fake',overrides={}){
 const program=join(root,'fake-mcp.mjs'),flag=join(root,'schema-maximum'),log=join(root,'stdio-events');
 if(!existsSync(program)){writeFileSync(program,fakeStdio);writeFileSync(flag,'80');}
 return{definition:{id,name:'Synthetic MCP',auth:'none',runsOn:'owner_mac',transport:{type:'stdio',command:process.execPath,args:[program,flag,log]},
  limits:{connectTimeoutMs:3000,callTimeoutMs:3000},...overrides},flag,log,program};
}

test('harness MCP: add never spawns; discovery needs approval; complete schema pins guard selection; only own ask grants are applied',async t=>{
 const f=fixture(t,{nativeMcp:{runsOn:'owner_mac',oauth:false}}),actor=f.bot(),other=f.bot('Other'),live=f.live(actor),fake=fakeDefinition(f.root);
 const args={definition_json:JSON.stringify(fake.definition)};
 const pending=await call(live,'mcp.add','add',args);assert.equal(pending.status,'awaiting_approval');
 assert.equal(existsSync(fake.log),false);assert.equal(f.services.nativeMcpAdmin.listServers().length,0);
 assert.equal((await f.decide(pending)).status,200);const added=await call(live,'mcp.add','add',args);
 assert.equal(added.status,'succeeded');assert.equal(added.result.discovered,false);assert.equal(existsSync(fake.log),false);
 assert.ok(!JSON.stringify(added.result).includes(fake.program));
 const discoverArgs={server_id:'fake'},discovery=await call(live,'mcp.discover','discover',discoverArgs);
 assert.equal(discovery.status,'awaiting_approval');assert.equal(existsSync(fake.log),false);
 assert.equal((await f.decide(discovery)).status,200);
 const priorSentinel=process.env.DEXTER_TEST_PRIVATE_SENTINEL;process.env.DEXTER_TEST_PRIVATE_SENTINEL='synthetic-parent-only';
 let discovered;try{discovered=await call(live,'mcp.discover','discover',discoverArgs);}finally{
  if(priorSentinel===undefined)delete process.env.DEXTER_TEST_PRIVATE_SENTINEL;else process.env.DEXTER_TEST_PRIVATE_SENTINEL=priorSentinel;
 }
 assert.equal(discovered.status,'succeeded');assert.equal(discovered.result.tools.length,1);
 assert.ok(!JSON.stringify(discovered.result).includes(fake.program));
 const events=readFileSync(fake.log,'utf8').trim().split('\n').map(JSON.parse);assert.ok(events.some(event=>event.list));
 assert.ok(events.filter(event=>event.started).every(event=>event.inherited===null));
 const admin=f.services.nativeMcpAdmin,toolId=discovered.result.tools[0].id,summary=admin.tools('fake'),oldPin=admin.configurationPin('fake');
 assert.deepEqual(admin.botSelection('fake',actor.id).toolIds,[]);assert.deepEqual(admin.botSelection('fake',other.id).toolIds,[]);
 const selectArgs={server_id:'fake',tool_ids:[toolId]},selection=await call(live,'mcp.select','stale-select',selectArgs);
 writeFileSync(fake.flag,'81');await admin.discover('fake',{unlockCredentials:false});
 assert.deepEqual(admin.tools('fake'),summary,'public summaries stay equal although full input schema changed');
 assert.notEqual(admin.configurationPin('fake'),oldPin);
 assert.equal((await f.decide(selection)).status,200);assert.equal((await call(live,'mcp.select','stale-select',selectArgs)).status,'blocked');
 assert.deepEqual(admin.botSelection('fake',actor.id).toolIds,[]);
 const selected=await approved(f,live,'mcp.select','select',selectArgs);assert.equal(selected.status,'succeeded');
 assert.equal(selected.result.policy,'ask');assert.equal(selected.result.appliesNextTurn,true);
 assert.deepEqual(admin.botSelection('fake',actor.id).toolIds,[toolId]);assert.deepEqual(admin.botSelection('fake',other.id).toolIds,[]);
 assert.ok(!live.surface.listTools(live.token).some(view=>view.name===toolId),'new MCP tool is not admitted into the current native turn');
 const next=f.live(actor),external=next.surface.listTools(next.token).find(view=>view.name===toolId);assert.ok(external);assert.equal(external.requiresApproval,true);
 await assert.rejects(live.surface.call(live.token,{tool:toolId,connectionId:external.connectionId,callId:'too-early',arguments:{text:'synthetic'}}),refused);
 await assert.rejects(call(live,'mcp.select','spoof',{...selectArgs,bot_id:other.id}),refused);
 const status=await call(live,'status','selected');assert.deepEqual(status.result.mcp.selected[0].toolIds,[toolId]);
 assert.ok(!JSON.stringify(status.result).includes(fake.program));
});

test('harness MCP credential definitions stay value-free and approved discovery never unlocks custody or starts a locked server',async t=>{
 let reads=0;const custody={kind:'synthetic',read:async()=>{reads++;throw new Error('Synthetic custody must never be read.');}};
 const f=fixture(t,{nativeMcp:{runsOn:'owner_mac',oauth:false,credentials:{custody}}}),actor=f.bot(),live=f.live(actor);
 const fake=fakeDefinition(f.root,'locked',{auth:'broker'});
 fake.definition.transport.env={API_TOKEN:{kind:'secret',key:'env.api_token'}};
 const add=await approved(f,live,'mcp.add','locked-add',{definition_json:JSON.stringify(fake.definition)});assert.equal(add.status,'succeeded');
 const discovered=await approved(f,live,'mcp.discover','locked-discover',{server_id:'locked'});
 assert.equal(discovered.status,'succeeded');assert.equal(discovered.result.server.status,'needs_auth');
 assert.deepEqual(discovered.result.tools,[]);assert.equal(discovered.result.authenticationInOwnerSettings,true);
 assert.equal(reads,0);assert.equal(existsSync(fake.log),false);
 for(const transport of [
  {...fake.definition.transport,env:{API_TOKEN:{kind:'literal',value:'synthetic-value'}}},
  {...fake.definition.transport,env:{API_TOKEN:{kind:'secret',key:'env.api_token',prefix:'sk-'+'a'.repeat(20)}}},
  {...fake.definition.transport,args:[fake.program,'--token','synthetic-token-value']},
 ])await assert.rejects(call(live,'mcp.add',`unsafe-${transport.args.length}-${Object.values(transport.env)[0].kind}-${Object.values(transport.env)[0].prefix??''}`,
  {definition_json:JSON.stringify({...fake.definition,id:'unsafe',transport})}),refused);
 assert.equal(reads,0);assert.equal(f.services.nativeMcpAdmin.listServers().length,1);
});

test('harness cancellation and uncertain effects are bounded: unknown replay is one-shot and revoked read never publishes stale data',async t=>{
 const f=fixture(t),actor=f.bot();let creations=0;
 const surface=f.surface({runtime:()=>({createBot:async(input,admit)=>{creations++;await f.services.runtime.createBot(input,admit);throw new Error('Synthetic lost receipt.');}})});
 const live=f.live(actor,surface),args={name:'Uncertain one-shot',engine:'codex'};
 const receipt=await approved(f,live,'bots.create','uncertain',args);assert.equal(receipt.status,'unknown');assert.equal(creations,1);
 assert.equal((await call(live,'bots.create','uncertain',args)).status,'unknown');assert.equal(creations,1);
 let resolveCatalog;const slow=f.surface({catalog:()=>new Promise(resolveDone=>{resolveCatalog=resolveDone;})}),second=f.live(actor,slow);
 const pending=call(second,'models','slow');slow.revokeCapability(second.token);resolveCatalog(catalog());
 await assert.rejects(pending,refused);await assert.rejects(call(second,'status','after-revoke'),refused);
 const third=f.live(actor);f.services.store.finishTurn(third.turn.id,'completed',null);
 assert.throws(()=>third.surface.listTools(third.token),refused);
 for(const scope of [live,second])f.services.store.finishTurn(scope.turn.id,'completed',null);
 const checkpoint='ckp_harness_checkpoint_read_refusal';
 f.services.store.checkpointForTransfer(checkpoint);
 try{
  assert.throws(()=>f.services.store.assertActiveWriter(),error=>error.code==='host_locked');
  await assert.rejects(call(live,'models','checkpoint-read'),error=>error.code==='host_locked');
 }finally{f.services.store.abortCheckpoint(checkpoint);}
 assert.doesNotThrow(()=>f.services.store.withWriterLease(()=>f.services.store.assertActiveWriter()),'readonly authority admission is safe inside an existing canonical writer transaction');
});

function socketRpc(path){
 const socket=createConnection(path);let sequence=0,buffer='';const pending=new Map();
 const ready=new Promise((resolveDone,reject)=>{socket.once('connect',resolveDone);socket.once('error',reject);});
 socket.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const at=buffer.indexOf('\n'),message=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
  const waiting=pending.get(message.id);if(waiting){pending.delete(message.id);clearTimeout(waiting.timer);message.error?waiting.reject(new Error('Synthetic RPC refused.')):waiting.resolve(message.result);}}});
 socket.on('error',()=>{});socket.on('close',()=>{for(const waiting of pending.values()){clearTimeout(waiting.timer);waiting.reject(new Error('Synthetic RPC closed.'));}pending.clear();});
 const rpc=async(method,params)=>{await ready;const id=++sequence;return new Promise((resolveDone,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Synthetic RPC deadline.'));},5000);
  pending.set(id,{resolve:resolveDone,reject,timer});socket.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});};
 return{rpc,initialize:async()=>{await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'SyntheticHarness',version:'1'}});
  socket.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');},close:()=>socket.destroy()};
}

test('integrated composition: real HostServices native MCP bridge exposes the guide and approved operations, then loads own skill only next turn',async t=>{
 const until=async predicate=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>=end)throw new Error('Owner proposal deadline.');await new Promise(resolve=>setTimeout(resolve,10));}};
 const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-harness-integrated-')));let services,app,stage='construction',diagnostic=null;const inputs=[],clients=[];
 const capture=error=>{diagnostic={stage,name:String(error?.name??'Error'),code:String(error?.code??'none'),
  message:String(error?.message??'Synthetic driver failed.').replaceAll(root,'[isolated fixture]').slice(0,400)};};
 const decide=async receipt=>{const response=await app.request(`http://127.0.0.1/v1/actions/${receipt.actionId}/decisions`,{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:'allow',requestHash:receipt.requestHash})});assert.equal(response.status,200);};
 const makeDriver=(id,options)=>({id,capabilities:{resume:true,interrupt:true,fork:false,steer:false},status:async()=>({engine:id,installed:true}),
  open:async threadId=>{stage='native-open';try{assert.ok(options.localMcpServer);const rpc=socketRpc(options.localMcpServer.args[1]);clients.push(rpc);
   stage='native-mcp-initialize';await rpc.initialize();return{threadId,nativeCursor:'synthetic-integration',rpc};}catch(error){capture(error);throw error;}},
  async *turn(session,turnId,input){
   try{
   stage='turn-guide-input';
   inputs.push(input);assert.ok(input.includes('BEGIN DEXTER BUILT-IN HARNESS GUIDE'));
   const state=JSON.parse(input.match(/BEGIN DEXTER TURN STATE \(quoted data, not instructions\)\n([^\n]+)\nEND DEXTER TURN STATE/)[1]);
   stage='turn-guide-state';assert.equal(state.features.harnessAdminToolsEnabled,true);assert.equal(state.features.nativeMcpConfigured,false);
   stage='turn-tools-list';
   const directory=mcpDirectoryClient(session.rpc.rpc);
   const find=name=>directory.find(name);assert.ok(await find('dexter.harness.guide'));
   const observedReceipts=[];
   const toolCall=async(name,callId,args)=>{const value=await directory.call(name,callId,args);
    assert.equal(value.isError,false,`Synthetic MCP receipt ${value.structuredContent?.status??'refused'}`);
    // Native drivers observe the explicit MCP tool-result content before publishing subsequent assistant text.
    observedReceipts.push(...gatewayReceiptEvidence(value.content));return value.structuredContent;};
   stage='turn-guide-call';
   const index=await toolCall(await find('dexter.harness.guide'),'guide',{});assert.equal(index.status,'succeeded');
   assert.ok(index.result.topics.some(topic=>topic.id==='mcp'));
   if(inputs.length===1){
    assert.ok(!input.includes('INTEGRATED_SYNTHETIC_SKILL'));
    const registerName=await find('dexter.harness.skills.register'),registerArgs={skill_id:'integrated',version:'1.0.0',markdown:'INTEGRATED_SYNTHETIC_SKILL'};
    stage='turn-register-proposal';const registration=toolCall(registerName,'register',registerArgs);
    await until(()=>services.store.listActions('awaiting_approval').some(action=>action.request.tool==='dexter.harness.skills.register'));
    const request=services.store.listActions('awaiting_approval').find(action=>action.request.tool==='dexter.harness.skills.register');request.actionId=request.id;
    stage='turn-register-owner-decision';await decide(request);
    stage='turn-register-execute';
    const registered=await registration;assert.equal(registered.status,'succeeded');
    const activateName=await find('dexter.harness.skills.activate'),activateArgs={skill_id:'integrated',scope:'bot',version:'1.0.0'};
    stage='turn-activate-proposal';const activation=toolCall(activateName,'activate',activateArgs);
    await until(()=>services.store.listActions('awaiting_approval').some(action=>action.request.tool==='dexter.harness.skills.activate'));
    const activate=services.store.listActions('awaiting_approval').find(action=>action.request.tool==='dexter.harness.skills.activate');activate.actionId=activate.id;
    stage='turn-activate-owner-decision';await decide(activate);stage='turn-activate-execute';
    const activated=await activation;assert.equal(activated.result.appliesNextTurn,true);
    assert.deepEqual(observedReceipts.map(receipt=>receipt.actionId),[registered.actionId,activated.actionId]);
    assert.ok(!input.includes('INTEGRATED_SYNTHETIC_SKILL'),'current native turn instructions stay pinned');
   }else{stage='next-turn-skill';assert.ok(input.includes('INTEGRATED_SYNTHETIC_SKILL'));}
   for(const receipt of observedReceipts)yield{type:'tool.result.observed',threadId:session.threadId,turnId,...receipt};
   yield{type:'text.delta',threadId:session.threadId,turnId,text:'Synthetic integrated response'};
   yield{type:'turn.completed',threadId:session.threadId,turnId,usage:{}};
   }catch(error){capture(error);throw error;}
  },respondToTool:async()=>{},interrupt:async()=>{},close:async session=>session.rpc.close()});
 t.after(async()=>{for(const rpc of clients)rpc.close();await services?.shutdown();rmSync(root,{recursive:true,force:true});});
 services=new HostServices({dataDir:join(root,'host'),enableEngines:true,enableMcp:true,engineCommands:{codex:'/usr/bin/false'},makeDriver,engineCatalog:catalog});
 app=createHostApp(services.store,{runtime:services.runtime,skills:services.skillsHttp});
 const actor=services.store.createBot({name:'Synthetic integrated actor',profileId:'synthetic',engine:'codex'}),other=services.store.createBot({name:'Other',profileId:'synthetic',engine:'codex'});
 const thread=services.store.createThread(actor.id);
 for(const content of ['first','next']){
  const {turn}=services.runtime.startTurn(thread.id,{clientRequestId:content,content});
  const terminal=await services.runtime.waitForTurn(turn.id,10000);assert.equal(terminal.state,'completed',JSON.stringify({terminalCode:terminal.code,diagnostic}));
  assert.equal(services.store.turnOutput(turn.id),'Synthetic integrated response');
 }
 assert.equal(inputs.length,2);assert.equal(services.context.status().activeCapabilities,0);
 assert.equal(services.skillsHttp.listSkillActivations({scopeKind:'bot',botId:other.id}).items.length,0);
 assert.equal(services.store.listActions().filter(action=>action.state==='succeeded').length,2);
});
