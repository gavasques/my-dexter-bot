import { mcpDirectoryClient } from './fixtures/mcp-directory-client.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID, createSecretKey } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { HostServices } from '../packages/cli/dist/host-services.js';
import { HarnessOperationSurface, HARNESS_OPERATION_DESTINATION } from '../packages/cli/dist/harness-operation-surface.js';
import { BrowserUseTurnSurface, BROWSER_USE_DESTINATION } from '../packages/cli/dist/browser-use-surface.js';
import { AutomationTurnSurface, AUTOMATION_DESTINATION } from '../packages/cli/dist/automation-surface.js';
import { createHostApp } from '../packages/hub/dist/http.js';
import { SyntheticCredentialBroker } from '../packages/gateway/dist/index.js';
import { HostStore, ConversationRuntime, SCHEMA_VERSION } from '../packages/hub/dist/index.js';
import { doctor, readSourceAuthority, captureInspectionSnapshot, restoreForInspection } from '../packages/operations/dist/index.js';
import { DatabaseSync } from 'node:sqlite';
import { checkHubExact } from '../packages/operations/dist/exact.js';

// No inference, provider account, authfile, personal files or paid API. This executable speaks the
// Claude protocol; production ClaudeCliDriver + WorkspaceDriver + MCP wrapper + shell are used unchanged.
const nativeFixture = String.raw`
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const args=process.argv.slice(2), flag=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
if(args.includes('--version')){console.log('synthetic 1.2.3');process.exit(0);}
if(args.includes('auth')){send({loggedIn:true,authMethod:'claude.ai'});process.exit(0);}
let source='';for await(const line of createInterface({input:process.stdin}))source+=line;
const input=JSON.parse(source).message.content;
const server=JSON.parse(flag('--mcp-config')).mcpServers.dexter_gateway;
const child=spawn(server.command,server.args,{env:{PATH:'/usr/bin:/bin'},stdio:['pipe','pipe','ignore']});
let sequence=0,buffer='';const pending=new Map();
child.stdout.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const n=buffer.indexOf('\n'),row=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);pending.get(row.id)?.(row);pending.delete(row.id);}});
const rpc=(method,params)=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'P0-local-synthetic',version:'1'}});
child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
send({type:'system',subtype:'init',session_id:flag('--session-id')??flag('--resume'),mcp_servers:[{name:'dexter_gateway',status:'connected'}]});
const directory=(MCP_DIRECTORY_CLIENT_FACTORY)(rpc);
let answer;
if(input.includes('Host tool continuation.')){
 const receipt=JSON.parse(input.split('Tool receipt: ').at(-1));
 answer={kind:'receipt-continuation',receipt,originalTaskPresent:input.includes('ORIGINAL_CONTINUATION'),model:flag('--model'),effort:flag('--effort')};
 if(receipt.tool==='dexter.harness.files.write' && receipt.state==='succeeded'){
  const tool=await directory.find('dexter.harness.files.write');
  const replay=await directory.call(tool,'new-engine-id-same-effect',{path:'receipt.txt',text:'durable result'});
  answer.replayActionId=replay.result.structuredContent.actionId;
 }
 if(receipt.receipts){
  const tool=await directory.find('dexter.harness.files.write');
  answer.replayActionIds=[];
  for(const [i,old] of receipt.receipts.entries()){
   const replay=await directory.call(tool,'multi-replay-'+i,{path:'multi-'+i+'.txt',text:'multi-'+i});
   answer.replayActionIds.push(replay.result.structuredContent.actionId);
  }
 }
}else if(input.includes('P0_NO_TOOLS')){answer={kind:'unrelated'};}else{
 const catalog=(await rpc('tools/list',{})).result.tools;
 const tool=await directory.find('dexter.harness.terminal.run');
 const denied=input.includes('P0_DENY');
 const operation=directory.call(tool,'p0-shell-once',{runtime:'sh',command:input.includes('P0_ENGINE_DIES')?"sleep 0.5; printf 'late effect' >> proof.txt":"printf 'effect\\n' >> proof.txt; printf 'P0_LOCAL_RESULT'"});
 if(input.includes('P0_ENGINE_DIES')){await new Promise(resolve=>setTimeout(resolve,250));process.exit(0);}
 const call=await operation;
 send({type:'user',session_id:flag('--session-id')??flag('--resume'),message:{role:'user',content:[{type:'tool_result',tool_use_id:'fixture-use',content:call.result.content}]}});
 answer={kind:'same-call',receipt:call.result.structuredContent,expectedDenial:denied,model:flag('--model')};
}
child.stdin.end();await new Promise(resolve=>child.once('close',resolve));
send({type:'result',subtype:'success',result:JSON.stringify(answer),usage:{}});
`;

async function until(predicate, timeout=7000) {
  const end=Date.now()+timeout;
  for(;;){const value=predicate();if(value)return value;if(Date.now()>=end)throw new Error('P0 bounded condition failed.');await new Promise(resolve=>setTimeout(resolve,10));}
}
const catalog=()=>[{id:'claude',available:true,models:[{id:'fixture-opus',reasoningEfforts:['high'],speeds:[]}],defaultModel:'fixture-opus',reasoningEfforts:['high'],speeds:[]}];
async function fixture(t, agenda=false, extra={}) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-p0-local-'))), executable=join(root,'synthetic-claude.mjs');
  writeFileSync(executable,`#!${process.execPath}\n${nativeFixture.replace('MCP_DIRECTORY_CLIENT_FACTORY',mcpDirectoryClient.toString())}`,{mode:0o700});
  const options={dataDir:join(root,'host'),enableMcp:true,enableEngines:true,enableAgenda:agenda,engineCommands:{claude:executable},engineCatalog:catalog,...extra};
  let services=new HostServices(options), server;
  const bot=services.store.createBot({name:'P0 synthetic',profileId:'synthetic-only',engine:'claude',defaultSelection:{engine:'claude',model:'fixture-opus',reasoningEffort:'high',speed:null}});
  const thread=services.store.createThread(bot.id), surfaces=[];
  const harness=()=>{const surface=new HarnessOperationSurface({store:services.store,base:services.gateway,catalog:services.engineCatalog,runtime:()=>services.runtime,
    skills:()=>services.skillsHttp,effectiveSkills:()=>[],workspace:()=>services.botWorkspaceTools});surfaces.push(surface);return surface;};
  const live=(surface=harness())=>{const {turn}=services.store.createTurn(thread.id,{clientRequestId:`manual-${services.store.listTurns(thread.id).length}`,content:'ORIGINAL_CONTINUATION'});
    services.store.claimNextTurn(thread.id);return {turn,surface,token:surface.issueCapability({turnId:turn.id}).token};};
  const call=(live,tool,callId,input,destination=HARNESS_OPERATION_DESTINATION)=>live.surface.call(live.token,{connectionId:destination,tool,callId,arguments:input});
  const decision=async(action,decision='allow')=>{
    if(!server){const app=createHostApp(services.store,{runtime:services.runtime});server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});await until(()=>server.listening);}
    const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/actions/${action.id??action.actionId}/decisions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision,requestHash:action.requestHash})});
    assert.equal(response.status,200);return response.json();
  };
  const resumed=async(actionId)=>{const id=await until(()=>services.store.toolActionOrigin(actionId)?.continuationTurnId);
    const turn=await services.runtime.waitForTurn(id,7000);assert.equal(turn.state,'completed',turn.code??'');return JSON.parse(services.store.turnOutput(id));};
  t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));for(const surface of surfaces)await surface.close();await services.shutdown();rmSync(root,{recursive:true,force:true});});
  return {root,options,bot,thread,live,call,decision,resumed,harness,get services(){return services;},async restart(){
    if(server){await new Promise(resolve=>server.close(resolve));server=null;}
    for(const surface of surfaces)await surface.close();await services.shutdown();services=new HostServices(options);
  }};
}

test('P0 native process: one MCP RPC waits for owner allow/deny, executes a real shell once and produces automatic engine output', {timeout:20000}, async t=>{
  const f=await fixture(t), path=join(f.options.dataDir,'bot-files',f.bot.id,'proof.txt');
  for(const [content,decision] of [['P0_ALLOW','allow'],['P0_DENY','deny']]){
    const {turn}=f.services.runtime.startTurn(f.thread.id,{clientRequestId:content,content});
    const action=await until(()=>{const state=f.services.store.getTurn(turn.id);if(['failed','unknown'].includes(state.state))throw new Error(JSON.stringify({state:state.state,code:state.code,events:f.services.store.listTurnEvents({turnId:turn.id})}));return f.services.store.listActions('awaiting_approval')[0];});
    assert.equal(f.services.store.getTurn(turn.id).state,'running');
    const before=existsSync(path)?readFileSync(path,'utf8'):'';
    await new Promise(resolve=>setTimeout(resolve,120));
    assert.equal(f.services.store.listActions('awaiting_approval').length,1);
    assert.equal(existsSync(path)?readFileSync(path,'utf8'):'',before);
    await f.decision(action,decision);
    assert.equal((await f.services.runtime.waitForTurn(turn.id,7000)).state,'completed');
    const answer=JSON.parse(f.services.store.turnOutput(turn.id));
    assert.equal(answer.kind,'same-call');assert.equal(answer.model,'fixture-opus');
    assert.equal(answer.receipt.actionId,action.id);assert.equal(answer.receipt.status,decision==='allow'?'succeeded':'denied');
    if(decision==='allow')assert.equal(answer.receipt.result.stdout,'P0_LOCAL_RESULT');
    assert.equal(f.services.store.toolActionOrigin(action.id).delivered,true);
    assert.equal(f.services.store.toolActionOrigin(action.id).continuationTurnId,null);
    await f.decision(action,decision);
  }
  assert.equal(readFileSync(path,'utf8'),'effect\n');
  assert.equal(f.services.store.listTurns(f.thread.id).length,2);
});

test('P0 terminated/restarted proposal: durable approval executes once and the original model receives the exact receipt without another user message', {timeout:20000}, async t=>{
  const f=await fixture(t), live=f.live();
  const pending=await f.call(live,'dexter.harness.files.write','persisted',{path:'receipt.txt',text:'durable result'});
  f.services.store.finishTurn(live.turn.id,'completed',null);
  live.surface.revokeCapability(live.token);
  await f.restart();
  await f.decision(pending);
  const answer=await f.resumed(pending.actionId);
  assert.equal(answer.kind,'receipt-continuation');assert.equal(answer.originalTaskPresent,true);
  assert.equal(answer.model,'fixture-opus');assert.equal(answer.effort,'high');
  assert.equal(answer.receipt.state,'succeeded');assert.equal(answer.receipt.actionId,pending.actionId);
  assert.equal(answer.replayActionId,pending.actionId,'a new model call id returns the old receipt without a second proposal/effect');
  const path=join(f.options.dataDir,'bot-files',f.bot.id,'receipt.txt');assert.equal(readFileSync(path,'utf8'),'durable result');
  const id=f.services.store.toolActionOrigin(pending.actionId).continuationTurnId;
  assert.equal(f.services.store.listMessages(f.thread.id).filter(message=>message.role==='user').length,1,'host continuation never fabricates another user message');
  assert.equal(f.services.store.getTurn(id).inputMessageId,live.turn.inputMessageId);
  await f.decision(pending);assert.equal(f.services.store.toolActionOrigin(pending.actionId).continuationTurnId,id);
  await f.restart();await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(f.services.store.listTurns(f.thread.id).length,2);assert.equal(readFileSync(path,'utf8'),'durable result');
});

test('P0 gateway recovery executes the original pinned local adapter once, delivers its result and refuses a stale grant', {timeout:20000}, async t=>{
  const broker=new SyntheticCredentialBroker();broker.put('local-fixture',{headers:{},allowedHosts:['fixture.example.test']});
  let effects=0, effectFile;
  const f=await fixture(t,false,{upstream:{broker,adapter:{async execute(call){effects++;writeFileSync(effectFile,call.arguments.text);return {localResult:'gateway-result'};}}}});
  effectFile=join(f.root,'gateway-effect.txt');
  const tool={name:'fixture.record',toolkit:'fixture',upstreamSlug:'RECORD_LOCAL',version:'v1',description:'Synthetic local file adapter',upstreamHost:'fixture.example.test',effect:'write',inputSchema:{type:'object',additionalProperties:false,required:['text'],properties:{text:{type:'string',maxLength:100}}}};
  f.services.gateway.registerTool(tool);
  const connection=f.services.gateway.connectAccount({profileId:f.bot.profileId,toolkit:'fixture',label:'Synthetic local',upstreamAccountRef:'fixture-only',credentialRef:'local-fixture',allowedHosts:['fixture.example.test']});
  f.services.store.setGrant({botId:f.bot.id,tool:tool.name,destination:connection.id,policy:'ask'});
  const live=f.live(f.services.gateway), pending=await f.call(live,tool.name,'gateway-once',{text:'one local effect'},connection.id);
  f.services.store.finishTurn(live.turn.id,'completed',null);f.services.gateway.revokeCapability(live.token);
  await f.decision(pending);
  assert.equal((await f.resumed(pending.actionId)).receipt.result.localResult,'gateway-result');assert.equal(effects,1);assert.equal(readFileSync(effectFile,'utf8'),'one local effect');
  await f.decision(pending);assert.equal(effects,1);
  const stale=f.live(f.services.gateway), old=await f.call(stale,tool.name,'stale',{text:'must not replace'},connection.id);
  f.services.store.finishTurn(stale.turn.id,'completed',null);
  // Exact decision is durable, but an ABA grant change still blocks before dispatch.
  f.services.store.decideAction(old.actionId,{decision:'allow',requestHash:old.requestHash});
  f.services.store.setGrant({botId:f.bot.id,tool:tool.name,destination:connection.id,policy:'deny'});
  await f.services.runtime.recoverOwnerActions();
  assert.equal((await f.resumed(old.actionId)).receipt.state,'blocked');assert.equal(effects,1);
});

test('P0 terminated denial and unknown effect deliver receipts to the engine; unknown is never redispatched', {timeout:20000}, async t=>{
  const f=await fixture(t), denied=f.live();
  const proposal=await f.call(denied,'dexter.harness.files.write','deny-late',{path:'denied.txt',text:'must not exist'});
  f.services.store.finishTurn(denied.turn.id,'completed',null);await f.decision(proposal,'deny');
  assert.equal((await f.resumed(proposal.actionId)).receipt.state,'denied');
  assert.equal(existsSync(join(f.options.dataDir,'bot-files',f.bot.id,'denied.txt')),false);
  const uncertain=f.live(), effect=await f.call(uncertain,'dexter.harness.terminal.run','uncertain',{runtime:'sh',command:"printf 'unknown effect' > unknown.txt"});
  f.services.store.decideAction(effect.actionId,{requestHash:effect.requestHash,decision:'allow'});
  // Real shell effect, followed by deliberate loss of its durable execution receipt.
  f.services.store.claimAction(effect.actionId);
  await f.services.botWorkspaceTools.run(f.bot.id,{runtime:'sh',command:"printf 'unknown effect' > unknown.txt"},{signal:new AbortController().signal});
  f.services.store.markUnknown(effect.actionId,'executor_error');
  f.services.store.finishTurn(uncertain.turn.id,'unknown','host_interrupted');
  await f.restart();
  assert.equal((await f.resumed(effect.actionId)).receipt.state,'unknown');
  assert.equal(f.services.store.getAction(effect.actionId).state,'unknown');
  assert.equal(f.services.store.listActions().length,2);
});

test('P0 common recovery preserves Browser Use configuration and automation receipt/CAS after their proposing turn ends', {timeout:20000}, async t=>{
  const f=await fixture(t,true);
  const browser=new BrowserUseTurnSurface({store:f.services.store,base:f.services.gateway,vault:f.services.browserUseKeyVault});
  const browserLive=f.live(browser), pending=await f.call(browserLive,'dexter.browseruse.configure','browser-config',{
    expectedRevision:0,enabled:true,allowed_domains:['example.com'],max_steps:7,timeout_seconds:30,profile_id:''},BROWSER_USE_DESTINATION);
  f.services.store.finishTurn(browserLive.turn.id,'completed',null);await browser.close();await f.decision(pending);
  assert.equal((await f.resumed(pending.actionId)).receipt.state,'succeeded');
  assert.equal(f.services.store.getBrowserUseConfiguration().bots[f.bot.id].enabled,true);
  const automation=new AutomationTurnSurface({store:f.services.store,base:f.services.gateway,port:()=>f.services.automationsHttp});
  const automationLive=f.live(automation), proposed=await f.call(automationLive,'dexter.automations.create','automation-create',{
    title:'Synthetic P0',content:'No external effects',kind:'interval',every_ms:60000,first_at:f.services.store.now()+3600000},AUTOMATION_DESTINATION);
  f.services.store.finishTurn(automationLive.turn.id,'completed',null);await automation.close();await f.decision(proposed);
  const receipt=(await f.resumed(proposed.actionId)).receipt;
  assert.equal(receipt.state,'succeeded');assert.equal(receipt.result.schedule.botId,f.bot.id);
  assert.equal(f.services.automationsHttp.list({hostId:f.services.store.hostId}).items.length,1);
});

test('P0 v10 -> v11 migration preserves host identity and existing messages without inferring legacy tool authority', async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-p0-migrate-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=new HostStore({dataDir:root}),identity={hostId:store.hostId,ownerId:store.ownerId},path=store.databasePath;
  const bot=store.createBot({name:'Migration only',profileId:'synthetic-only',engine:'claude'}),thread=store.createThread(bot.id);
  store.appendMessage(thread.id,{clientMessageId:'existing',content:'synthetic preserved message'});store.close();
  const legacy=new DatabaseSync(path);legacy.exec('DROP TABLE tool_action_continuations; PRAGMA user_version=10;');legacy.close();
  const reopened=new HostStore({dataDir:root});
  try {
    assert.equal(reopened.hostId,identity.hostId);assert.equal(reopened.ownerId,identity.ownerId);
    assert.equal(reopened.summary().schemaVersion,SCHEMA_VERSION);assert.equal(SCHEMA_VERSION,11);
    assert.equal(reopened.listMessages(thread.id)[0].content,'synthetic preserved message');assert.deepEqual(reopened.toolActionsForRecovery(),[]);
  } finally {reopened.close();}
});

test('R3 approved shell survives ordinary engine exit and delivers one successful host continuation', {timeout:15000}, async t=>{
  const f=await fixture(t),{turn}=f.services.runtime.startTurn(f.thread.id,{clientRequestId:'late-receipt',content:'P0_ENGINE_DIES ORIGINAL_CONTINUATION'});
  const action=await until(()=>f.services.store.listActions('awaiting_approval')[0]);
  await f.decision(action);
  assert.equal((await f.services.runtime.waitForTurn(turn.id,7000)).state,'failed');
  const answer=await f.resumed(action.id);
  assert.equal(answer.receipt.state,'succeeded');
  const path=join(f.options.dataDir,'bot-files',f.bot.id,'proof.txt');
  assert.equal(readFileSync(path,'utf8'),'late effect');
  assert.equal(f.services.store.listTurns(f.thread.id).length,2);
  assert.doesNotThrow(()=>f.services.store.assertEngineSelectionIdle(f.thread.id));
});

test('R2 host shutdown aborts the gateway owner execution and preserves its partial effect as unknown', {timeout:10000}, async t=>{
  const broker=new SyntheticCredentialBroker();broker.put('stop-fixture',{headers:{},allowedHosts:['fixture.example.test']});
  let effects=0,aborted=false,effectFile;
  const f=await fixture(t,false,{upstream:{broker,adapter:{async execute(_call,_auth,{signal}){
    effects++;writeFileSync(effectFile,'partial');
    await new Promise((_resolve,reject)=>{const abort=()=>{aborted=true;reject(new Error('Synthetic aborted effect.'));};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
  }}}});
  effectFile=join(f.root,'shutdown-partial.txt');
  const tool={name:'fixture.stop',toolkit:'fixture',upstreamSlug:'STOP_LOCAL',version:'v1',description:'Synthetic abortable local effect',upstreamHost:'fixture.example.test',effect:'write',inputSchema:{type:'object',additionalProperties:false,required:[],properties:{}}};
  f.services.gateway.registerTool(tool);
  const connection=f.services.gateway.connectAccount({profileId:f.bot.profileId,toolkit:'fixture',label:'Synthetic stop',upstreamAccountRef:'fixture-only',credentialRef:'stop-fixture',allowedHosts:['fixture.example.test']});
  f.services.store.setGrant({botId:f.bot.id,tool:tool.name,destination:connection.id,policy:'ask'});
  const live=f.live(f.services.gateway),pending=await f.call(live,tool.name,'owner-stop',{},connection.id);
  f.services.store.finishTurn(live.turn.id,'completed',null);f.services.gateway.revokeCapability(live.token);
  f.services.runtime.decideAction(pending.actionId,{decision:'allow',requestHash:pending.requestHash});
  await until(()=>f.services.store.getAction(pending.actionId).state==='running');await f.services.shutdown();
  assert.equal(aborted,true);assert.equal(effects,1);assert.equal(readFileSync(effectFile,'utf8'),'partial');
  const reopened=new HostStore({dataDir:f.options.dataDir});try{assert.equal(reopened.getAction(pending.actionId).state,'unknown');}finally{reopened.close();}
});

test('R2 passive expiry uses the host deadline scheduler after turn end and releases model selection', {timeout:10000}, async t=>{
  const f=await fixture(t);
  f.services.store.setGrant({botId:f.bot.id,tool:'dexter.harness.files.write',destination:HARNESS_OPERATION_DESTINATION,policy:'ask',expiresAt:f.services.store.now()+350});
  const live=f.live(),pending=await f.call(live,'dexter.harness.files.write','natural-expiry',{path:'expired.txt',text:'must not exist'});
  f.services.store.finishTurn(live.turn.id,'completed',null);live.surface.revokeCapability(live.token);
  const answer=await f.resumed(pending.actionId);
  assert.equal(answer.receipt.state,'denied');assert.equal(answer.receipt.reason,'approval_expired');
  assert.equal(existsSync(join(f.options.dataDir,'bot-files',f.bot.id,'expired.txt')),false);
  assert.doesNotThrow(()=>f.services.store.assertEngineSelectionIdle(f.thread.id));
});

test('R2 populated v10 legacy tool proposals become explicit blocked receipts without invented origin', {timeout:10000}, async t=>{
  const f=await fixture(t),live=f.live(),pending=await f.call(live,'dexter.harness.files.write','legacy-pending',{path:'legacy.txt',text:'must not exist'});
  f.services.store.finishTurn(live.turn.id,'completed',null);await live.surface.close();await f.services.shutdown();
  const old=new DatabaseSync(join(f.options.dataDir,'dexter.sqlite'));
  old.exec('DROP TABLE tool_action_continuations;PRAGMA user_version=10;');old.close();
  await f.restart();await until(()=>f.services.store.getAction(pending.actionId).state==='blocked');
  const receipt=f.services.store.getAction(pending.actionId);
  assert.equal(receipt.result.code,'legacy_origin_missing');assert.equal(receipt.result.effectDispatched,false);
  assert.equal(f.services.store.toolActionOrigin(receipt.id),null);assert.doesNotThrow(()=>f.services.store.assertEngineSelectionIdle(f.thread.id));
  const response=await createHostApp(f.services.store,{runtime:f.services.runtime}).request('/v1/actions/'+receipt.id+'/decisions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:'allow',requestHash:receipt.requestHash})});
  assert.equal(response.status,409);await f.restart();assert.equal(f.services.store.getAction(receipt.id).state,'blocked');
  // The store-only decision boundary must reject a legacy action too, even without runtime recovery.
  const unbound=f.services.store.requestAction({botId:f.bot.id,threadId:f.thread.id,tool:'dexter.harness.files.write',destination:HARNESS_OPERATION_DESTINATION,
    arguments:{input:{path:'unbound.txt',text:'must not exist'}},idempotencyKey:'synthetic-legacy-without-runtime'});
  assert.throws(()=>f.services.store.decideAction(unbound.id,{decision:'allow',requestHash:unbound.requestHash}),error=>error.code==='conflict');
  assert.equal(f.services.store.getAction(unbound.id).result.code,'legacy_origin_missing');
  assert.equal(f.services.store.getAction(unbound.id).state,'blocked');assert.equal(f.services.store.toolActionOrigin(unbound.id),null);
});

test('R2 an old original turn records response interruption without automatic engine dispatch', {timeout:10000}, async t=>{
  const f=await fixture(t),live=f.live(),pending=await f.call(live,'dexter.harness.files.write','stale-origin',{path:'stale.txt',text:'must not exist'});
  f.services.store.finishTurn(live.turn.id,'completed',null);live.surface.revokeCapability(live.token);
  const raw=new DatabaseSync(f.services.store.databasePath);
  try{raw.prepare('UPDATE turns SET created_at=? WHERE id=?').run(f.services.store.now()-25*60*60*1000,live.turn.id);}finally{raw.close();}
  await f.decision(pending,'deny');
  const progress=await until(()=>{const progress=f.services.store.toolActionProgress(pending.actionId);return progress?.responseState==='interrupted'&&progress;});
  assert.equal(f.services.store.getTurn(progress.responseTurnId).code,'host_interrupted');
  assert.equal(f.services.store.turnOutput(progress.responseTurnId),null);
  assert.equal(f.services.store.listTurnEvents({turnId:progress.responseTurnId}).at(-1).data.responseUnavailable,true);
  assert.equal(existsSync(join(f.options.dataDir,'bot-files',f.bot.id,'stale.txt')),false);
  assert.doesNotThrow(()=>f.services.store.assertEngineSelectionIdle(f.thread.id));
});

test('R2 a queued receipt response from a previous process retains the explicit resume gate', async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-p0-held-response-')));let store=new HostStore({dataDir:root});
  const bot=store.createBot({name:'Held response',profileId:'synthetic',engine:'claude'}),thread=store.createThread(bot.id);
  const {turn}=store.createTurn(thread.id,{clientRequestId:'held-origin',content:'Synthetic original'});store.claimNextTurn(thread.id);
  store.setGrant({botId:bot.id,tool:'fixture.local',destination:'local',policy:'ask'});
  const action=store.requestAction({botId:bot.id,threadId:thread.id,tool:'fixture.local',destination:'local',arguments:{},idempotencyKey:'held-action'});
  store.bindToolAction(action.id,turn.id,'held-call');store.decideAction(action.id,{decision:'deny',requestHash:action.requestHash});store.finishTurn(turn.id,'completed',null);
  const response=store.createActionResultTurn(action.id);store.close();store=new HostStore({dataDir:root});let dispatches=0;
  const runtime=new ConversationRuntime({store,drivers:[{id:'claude',async openThread(){dispatches++;throw new Error('Synthetic unexpected dispatch.');}}]});
  t.after(async()=>{await runtime.shutdown();rmSync(root,{recursive:true,force:true});});
  await runtime.recoverOwnerActions();await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(dispatches,0);assert.equal(store.getTurn(response.id).state,'queued');
  assert.equal(store.toolActionProgress(action.id).responseTurnId,response.id);assert.equal(store.listTurns(thread.id).length,2);
});

test('R2 all sibling outcomes share one response, wait for all decisions and replay both exact old intents', {timeout:15000}, async t=>{
  const f=await fixture(t),live=f.live(),proposals=[];
  for(let i=0;i<2;i++)proposals.push(await f.call(live,'dexter.harness.files.write','multi-'+i,{path:'multi-'+i+'.txt',text:'multi-'+i}));
  f.services.store.finishTurn(live.turn.id,'completed',null);live.surface.revokeCapability(live.token);
  await f.decision(proposals[0]);
  assert.equal(f.services.store.toolActionProgress(proposals[0].actionId).responseTurnId,null);
  await f.decision(proposals[1],'deny');
  const answer=await f.resumed(proposals[1].actionId);
  assert.deepEqual(answer.receipt.receipts.map(receipt=>receipt.state),['succeeded','denied']);
  assert.deepEqual(answer.replayActionIds,proposals.map(proposal=>proposal.actionId));
  assert.equal(f.services.store.toolActionProgress(proposals[0].actionId).responseTurnId,f.services.store.toolActionProgress(proposals[1].actionId).responseTurnId);
  assert.equal(f.services.store.listTurns(f.thread.id).length,2);assert.equal(f.services.store.listActions().length,2);
  assert.doesNotThrow(()=>f.services.store.assertEngineSelectionIdle(f.thread.id));
  assert.equal(readFileSync(join(f.options.dataDir,'bot-files',f.bot.id,'multi-0.txt'),'utf8'),'multi-0');
  assert.equal(existsSync(join(f.options.dataDir,'bot-files',f.bot.id,'multi-1.txt')),false);
});

test('R2 terminal timeout and nonzero exit have bounded diagnostics without raw stderr or false success', {timeout:15000}, async t=>{
  const f=await fixture(t);
  for(const [name,command,timeout,expected] of [['timeout',"printf 'partial' > partial.txt; sleep 2; printf 'late' >> partial.txt",80,'interrupted'],['error',"printf 'synthetic private diagnostic' >&2; exit 7",1000,'failed']]){
    const live=f.live(),pending=await f.call(live,'dexter.harness.terminal.run',name,{runtime:'sh',command,timeout_ms:timeout});
    f.services.store.finishTurn(live.turn.id,'completed',null);await f.decision(pending);
    const answer=await f.resumed(pending.actionId),receipt=f.services.store.getAction(pending.actionId);
    assert.equal(receipt.result.commandOutcome,expected);assert.equal(answer.receipt.result.commandOutcome,expected);
    assert.equal(receipt.result.diagnostic.stderrAvailable,false);assert.equal(receipt.result.diagnostic.retryAutomatically,false);
    assert(!JSON.stringify(receipt.result).includes('synthetic private diagnostic'));
    if(expected==='interrupted'){assert.equal(receipt.state,'unknown');assert.equal(receipt.result.termination,'timeout');assert.equal(receipt.result.exitCode,null);assert.equal(receipt.result.signal,'SIGTERM');}
    else assert.equal(receipt.result.exitCode,7);
  }
  assert.equal(readFileSync(join(f.options.dataDir,'bot-files',f.bot.id,'partial.txt'),'utf8'),'partial');
});

test('R2 owner Stop withdraws unstarted proposals and stale approvals cannot produce an effect', {timeout:10000}, async t=>{
  const f=await fixture(t),{turn}=f.services.runtime.startTurn(f.thread.id,{clientRequestId:'stop',content:'P0_ALLOW'});
  const action=await until(()=>f.services.store.listActions('awaiting_approval')[0]);f.services.runtime.cancelTurn(turn.id);
  await f.services.runtime.waitForTurn(turn.id,7000);
  assert.equal(f.services.store.getAction(action.id).state,'denied');assert.equal(f.services.store.getAction(action.id).result.code,'cancelled');
  await assert.rejects(f.decision(action),/409/);
  assert.equal(existsSync(join(f.options.dataDir,'bot-files',f.bot.id,'proof.txt')),false);
});

test('R2 v11 backup/restore preserves durable receipts and rejects malformed continuation schema and identities', async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-p0-v11-ops-'))),store=new HostStore({dataDir:join(root,'host')});
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const bot=store.createBot({name:'Synthetic backup',profileId:'synthetic',engine:'claude'}),thread=store.createThread(bot.id);
  const {turn}=store.createTurn(thread.id,{clientRequestId:'ops-origin',content:'Synthetic original'});store.claimNextTurn(thread.id);
  store.setGrant({botId:bot.id,tool:'fixture.local',destination:'local',policy:'ask'});
  const action=store.requestAction({botId:bot.id,threadId:thread.id,tool:'fixture.local',destination:'local',arguments:{},idempotencyKey:'ops-receipt'});
  store.bindToolAction(action.id,turn.id,'ops-call');store.decideAction(action.id,{decision:'allow',requestHash:action.requestHash});
  store.claimAction(action.id);store.completeAction(action.id,{safe:'synthetic outcome'});store.recordToolOutcome(action.id,store.getAction(action.id).result);store.finishTurn(turn.id,'completed',null);
  const response=store.createActionResultTurn(action.id);store.claimNextTurn(thread.id);store.finishTurn(response.id,'completed',null);
  assert.equal(readSourceAuthority(join(root,'host')).schemaVersion,11);
  assert.equal(doctor(join(root,'host')).hub.supported,true);
  const key={keyId:'synthetic-only',use:operation=>operation(createSecretKey(Buffer.alloc(32,17)))},artifact=join(root,'backup.dxg8');
  captureInspectionSnapshot({source:store,key,output:artifact,include:{context:false,agenda:false,deviceRegistry:false,deviceSurface:false}});
  const copy=restoreForInspection({artifact,key,destination:join(root,'inspection')});assert(copy);
  const restored=new DatabaseSync(join(root,'inspection','inspection','hub.inspect.sqlite'),{readOnly:true});
  try{checkHubExact(restored);assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM tool_action_continuations').get().n,1);}finally{restored.close();}
  const raw=new DatabaseSync(store.databasePath);
  try{
    raw.exec('CREATE INDEX unexpected_tool_origin ON tool_action_continuations(profile_id)');
    assert.throws(()=>readSourceAuthority(join(root,'host')),error=>error.code==='unsupported_schema');raw.exec('DROP INDEX unexpected_tool_origin');
    raw.prepare('UPDATE tool_action_continuations SET profile_id=? WHERE action_id=?').run('foreign-profile',action.id);
    assert.throws(()=>readSourceAuthority(join(root,'host')),error=>error.code==='reference_broken');
    assert.equal(doctor(join(root,'host')).hub.supported,false);
    raw.prepare('UPDATE tool_action_continuations SET profile_id=? WHERE action_id=?').run(bot.profileId,action.id);
    assert.equal(readSourceAuthority(join(root,'host')).schemaVersion,11);
  }finally{raw.close();}
});

test('R2 plain host process survives changed team origin and restart without an unhandled rejection or effect', {timeout:20000}, async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-p0-team-process-'))),executable=join(root,'synthetic-claude.mjs'),script=join(root,'host.mjs');
  for(const directory of ['home','tmp'])mkdirSync(join(root,directory));
  writeFileSync(executable,`#!${process.execPath}\n${nativeFixture.replace('MCP_DIRECTORY_CLIENT_FACTORY',mcpDirectoryClient.toString())}`,{mode:0o700});
  writeFileSync(script,`
import {HostServices} from ${JSON.stringify(new URL('../packages/cli/dist/host-services.js',import.meta.url).href)};
import {HarnessOperationSurface,HARNESS_OPERATION_DESTINATION} from ${JSON.stringify(new URL('../packages/cli/dist/harness-operation-surface.js',import.meta.url).href)};
const root=${JSON.stringify(root)},options={dataDir:root+'/host',enableMcp:true,enableEngines:true,engineCommands:{claude:root+'/synthetic-claude.mjs'},engineCatalog:()=>${JSON.stringify(catalog())}};
const services=new HostServices(options);let surface;let stage="seed";
try{
 let bot,thread,action;
 if(process.argv[2]==='seed'){
  bot=services.store.createBot({name:'Coordinator',profileId:'synthetic',engine:'claude'});
  const other=services.store.createBot({name:'Replacement',profileId:'synthetic',engine:'claude'});
  const team=services.teamsHttp.create({expectedHostID:services.store.hostId,clientRequestId:${JSON.stringify(randomUUID())},name:'Synthetic',coordinatorBotId:bot.id,botIds:[bot.id,other.id]});
  const request=${JSON.stringify(randomUUID())},teamThread=services.store.createTeamThread(bot.id,team.id,request);services.teamsHttp.bindThread(team.id,teamThread.id,team.revision,request);
  const {turn}=services.store.createTurn(teamThread.id,{clientRequestId:'team-origin',content:'Synthetic pending'});services.store.claimNextTurn(teamThread.id);
  surface=new HarnessOperationSurface({store:services.store,base:services.gateway,catalog:services.engineCatalog,runtime:()=>services.runtime,skills:()=>services.skillsHttp,effectiveSkills:()=>[],workspace:()=>services.botWorkspaceTools});
  const token=surface.issueCapability({turnId:turn.id}).token;
  const pending=await surface.call(token,{connectionId:HARNESS_OPERATION_DESTINATION,tool:'dexter.harness.files.write',callId:'team-action',arguments:{path:'must-not-exist.txt',text:'forbidden effect'}});
  services.store.finishTurn(turn.id,'completed',null);surface.revokeCapability(token);
  services.teamsHttp.update(team.id,{expectedHostID:services.store.hostId,expectedRevision:team.revision,coordinatorBotId:other.id});
  action=services.store.getAction(pending.actionId);
  stage='decision';services.runtime.decideAction(action.id,{decision:'allow',requestHash:action.requestHash});
  stage='recovery';await services.runtime.recoverOwnerActions();
  thread=services.store.createThread(bot.id,"thr_synthetic_unrelated");
 }else{bot=services.store.listBots().find(bot=>bot.name==='Coordinator');thread=services.store.getThread("thr_synthetic_unrelated");action=services.store.listActions()[0];await services.runtime.recoverOwnerActions();}
 stage='unrelated';const {turn}=services.runtime.startTurn(thread.id,{clientRequestId:'unrelated-'+process.argv[2],content:'P0_NO_TOOLS'});
 const ended=await services.runtime.waitForTurn(turn.id,7000);
 const receipt=services.store.getAction(action.id),progress=services.store.toolActionProgress(action.id);
 console.log(JSON.stringify({turn:ended.state,action:receipt.state,originValid:progress.originValid,responseState:progress.responseState}));
}catch(error){console.log(JSON.stringify({fixtureFailure:stage,code:["forbidden","conflict","invalid_input","host_locked"].includes(error.code)?error.code:"unexpected"}));process.exitCode=1;}finally{await surface?.close();await services.shutdown();}
`);
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const phase of ['seed','restart']){
    const child=spawn(process.execPath,[script,phase],{env:{PATH:'/usr/bin:/bin',HOME:join(root,'home'),TMPDIR:join(root,'tmp')},stdio:['ignore','pipe','ignore']});
    let output='';child.stdout.on('data',data=>output+=data.toString());
    const code=await new Promise(resolve=>child.once('close',resolve));
    assert.equal(code,0,'owned plain Node host must survive without a rejection handler: '+output.trim());
    assert.deepEqual(JSON.parse(output.trim()),{turn:'completed',action:'blocked',originValid:false,responseState:'interrupted'});
  }
});
