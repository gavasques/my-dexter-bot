import { mcpDirectoryClient } from './fixtures/mcp-directory-client.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,existsSync,rmSync,appendFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {serve} from '@hono/node-server';
import {HostServices} from '../packages/cli/dist/host-services.js';
import {createHostApp,createAuthorizedHostRouter} from '../packages/hub/dist/http.js';
import {HostStore,SCHEMA_VERSION,dispatchAction} from '../packages/hub/dist/index.js';
import {APPROVAL_POLICY_SCOPE_VERSION,BOT_EXECUTION_ACCESS_SCOPE_VERSION} from '../packages/contracts/dist/index.js';
import {checkHubExact,EXACT_SCHEMAS} from '../packages/operations/dist/exact.js';
import {FULL_SCHEMAS,checkFullSchema} from '../packages/operations/dist/full-schemas.js';
const nativeFixture=readFileSync(new URL('./p0-approval-continuation.test.mjs',import.meta.url),'utf8').match(/const nativeFixture = String.raw`([\s\S]*?)`;/)?.[1];
assert.ok(nativeFixture);
const catalog=()=>[{id:'claude',available:true,models:[{id:'fixture-opus',reasoningEfforts:['high'],speeds:[]}],defaultModel:'fixture-opus',reasoningEfforts:['high'],speeds:[]}];
async function until(read){for(let i=0;i<240;i++){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,25));}assert.fail('bounded synthetic observation timeout');}
async function fixture(t){
 const root=realpathSync(mkdtempSync(join(process.env.TMPDIR??'/private/tmp','d03-r2-flow-'))),executable=join(root,'synthetic-claude.mjs');
 const r3Native=nativeFixture.replace("command:input.includes('P0_ENGINE_DIES')?", "command:input.includes('R3_ENABLE_LONG')?\"printf 'begin\\\\n' >> enable-partial.txt; sleep 1; printf 'end\\\\n' >> enable-partial.txt; printf 'ENABLE_DONE'\":input.includes('P0_ENGINE_DIES')?");
 const engine=r3Native.replace('input.includes(\'P0_ENGINE_DIES\')?', 'input.includes(\'R2_LONG\')?"printf \'begin\\\\n\' >> partial.txt; sleep 20; printf \'end\\\\n\' >> partial.txt":input.includes(\'P0_ENGINE_DIES\')?');
 writeFileSync(executable,`#!${process.execPath}\n${engine.replace('MCP_DIRECTORY_CLIENT_FACTORY',mcpDirectoryClient.toString())}`,{mode:0o700});
 const options={dataDir:join(root,'host'),enableMcp:true,enableEngines:true,engineCommands:{claude:executable},engineCatalog:catalog};
 let services=new HostServices(options),server,base;
 async function openHTTP(){const app=createHostApp(services.store,{runtime:services.runtime});server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});await until(()=>server.listening);base=`http://127.0.0.1:${server.address().port}`;}
 await openHTTP();
 const bot=services.store.createBot({name:'R2 synthetic bot',profileId:'synthetic',engine:'claude',defaultSelection:{engine:'claude',model:'fixture-opus',reasoningEffort:'high',speed:null}}),thread=services.store.createThread(bot.id);
 async function request(path,body,method='GET'){const response=await fetch(base+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};}
 const accessPath=`/v1/bots/${bot.id}/execution-access`,policyPath=`/v1/bots/${bot.id}/approval-policy`;
 async function accessInput(key,operation='terminal',enabled=true){const {status,body}=await request(accessPath);assert.equal(status,200);return {expectedHostId:body.hostId,clientRequestId:key,expectedBotRevision:body.botRevision,expectedInventoryHash:body.inventoryHash,scopeVersion:BOT_EXECUTION_ACCESS_SCOPE_VERSION,operation,enabled};}
 async function policy(mode,key){const previous=(await request(policyPath)).body;const res=await request(policyPath,{expectedHostId:previous.hostId,clientRequestId:key,expectedRevision:previous.revision,mode,eligibleScopeVersion:APPROVAL_POLICY_SCOPE_VERSION},'PATCH');assert.equal(res.status,200);return res.body;}
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await services.shutdown();rmSync(root,{recursive:true,force:true});});
 return {root,bot,thread,request,accessPath,policyPath,accessInput,policy,get services(){return services;},async restart(){await new Promise(resolve=>server.close(resolve));await services.shutdown();services=new HostServices(options);await openHTTP();}};
}

test('R2 product HTTP enablement: provisional/deny -> human receipt -> auto one effect and consumed answer; ask retains access; revoke aborts unknown', {timeout:30000},async t=>{
 const f=await fixture(t),file=join(f.root,'host','bot-files',f.bot.id,'proof.txt');
 const before=(await f.request(f.accessPath)).body;assert.ok(before.entries.every(entry=>entry.grant===null && !entry.enabled));
 await f.policy('full_access','mode-auto');
 let turn=f.services.runtime.startTurn(f.thread.id,{clientRequestId:'provisional',content:'R2_FIRST_TERMINAL'}).turn;
 const pending=await until(()=>f.services.store.listActions('awaiting_approval')[0]);
 assert.deepEqual(pending.approvalRequirement,{reason:'access_not_enabled',policyRevision:1});assert.equal(existsSync(file),false);
 assert.equal((await f.request(`/v1/actions/${pending.id}/decisions`,{decision:'deny',requestHash:pending.requestHash},'POST')).status,200);
 await f.services.runtime.waitForTurn(turn.id,7000);assert.equal(existsSync(file),false);
 const input=await f.accessInput('human-enable-terminal'),enabled=await f.request(f.accessPath,input,'PATCH');assert.equal(enabled.status,200);
 const grant=enabled.body.access.entries[0].grant;assert.equal(grant.policy,'ask');assert.equal(grant.revision,2);assert.equal(enabled.body.previous.entries[0].provisional,true);assert.equal(enabled.body.access.entries[0].provisional,false);
 // Proof client fixture is emitted only from the real product route, never fabricated by a grant setter.
 if(process.env.D03_R2_CLIENT_FIXTURE)writeFileSync(process.env.D03_R2_CLIENT_FIXTURE,JSON.stringify({before:enabled.body.previous,input,receipt:enabled.body,policy:f.services.store.getBotApprovalPolicy(f.bot.id)}));
 turn=f.services.runtime.startTurn(f.thread.id,{clientRequestId:'automatic',content:'R2_AUTO_TERMINAL'}).turn;
 assert.equal((await f.services.runtime.waitForTurn(turn.id,7000)).state,'completed');
 const action=f.services.store.listActions().find(value=>value.authorization?.source==='owner_policy');assert.ok(action);assert.equal(action.state,'succeeded');
 assert.equal(action.authorization.policyRevision,1);assert.equal(action.authorization.policyReceiptId,f.services.store.getBotApprovalPolicy(f.bot.id).receiptId);
 assert.equal(readFileSync(file,'utf8'),'effect\n');assert.equal(f.services.store.toolActionProgress(action.id).consumedByEngine,true);
 assert.equal(JSON.parse(f.services.store.turnOutput(turn.id)).receipt.actionId,action.id);
 assert.equal(f.services.store.requestAction(action.request).id,action.id);assert.equal(readFileSync(file,'utf8'),'effect\n');
 await f.policy('ask','mode-ask');assert.equal(f.services.store.getGrant(f.bot.id,grant.tool,grant.destination).revision,2);
 turn=f.services.runtime.startTurn(f.thread.id,{clientRequestId:'ask-again',content:'R2_ASK_TERMINAL'}).turn;
 const ask=await until(()=>f.services.store.listActions('awaiting_approval')[0]);assert.equal(readFileSync(file,'utf8'),'effect\n');
 await f.request(`/v1/actions/${ask.id}/decisions`,{decision:'deny',requestHash:ask.requestHash},'POST');await f.services.runtime.waitForTurn(turn.id,7000);
 assert.equal(f.services.store.getGrant(f.bot.id,grant.tool,grant.destination).revision,2);
 await f.policy('full_access','mode-auto-again');
 turn=f.services.runtime.startTurn(f.thread.id,{clientRequestId:'long-owned',content:'R2_LONG'}).turn;
 const partial=join(f.root,'host','bot-files',f.bot.id,'partial.txt');const running=await until(()=>existsSync(partial)&&f.services.store.listActions('running')[0]);
 const revoked=await f.request(f.accessPath,await f.accessInput('human-revoke-terminal','terminal',false),'PATCH');assert.equal(revoked.status,200);
 assert.deepEqual(revoked.body.revocationEffects.abortedActionIds,[running.id]);
 await f.services.runtime.waitForTurn(turn.id,7000);const outcome=f.services.store.getAction(running.id);
 assert.equal(outcome.state,'unknown');assert.equal(readFileSync(partial,'utf8'),'begin\n');assert.equal(outcome.result.diagnostic.retryAutomatically,false);
 assert.equal(f.services.store.toolActionProgress(running.id).consumedByEngine,true);assert.equal(f.services.store.getGrant(f.bot.id,grant.tool,grant.destination).policy,'deny');
 assert.equal(f.services.store.listActions().length,4,'no automatic retry after denial or partial effect');
 const replay=await f.request(f.accessPath,input,'PATCH');assert.deepEqual(replay.body,enabled.body);assert.equal(f.services.store.getGrant(f.bot.id,grant.tool,grant.destination).revision,3);
 await f.restart();assert.deepEqual((await f.request(f.accessPath,input,'PATCH')).body,enabled.body);
 assert.equal((await f.request(f.accessPath+'/receipts/human-enable-terminal')).body.id,enabled.body.id);
 const db=new DatabaseSync(join(f.root,'host','dexter.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bot_execution_access_receipts').get().n,2);assert.equal(checkHubExact(db).ownerId,f.services.store.ownerId);db.close();
 const proof={state:'PRIVATE_PATCH_READY_NOT_INTEGRATED',initialGrantMissing:true,provisionalRequiredIndividualApproval:true,
  deniedEffects:0,enabledVia:'PATCH owner-loopback /v1/bots/:botId/execution-access',grantRevisionAfterEnable:2,
  grantMutationReceipts:2,automaticEffectCount:1,automaticAuthorization:action.authorization.source,policyRevision:action.authorization.policyRevision,
  engineConsumedAutomaticReceipt:true,automaticResponseCorrelated:true,modeAskRetainedGrantRevision:2,
  revokeDuringProcess:true,abortedActionState:outcome.state,partialEffectCount:1,partialFileHasEnd:false,
  partialCommandOutcome:outcome.result.commandOutcome??null,partialTermination:outcome.result.termination??null,partialSignal:outcome.result.signal??null,
  partialEngineReceiptConsumed:true,retryAutomatically:false,replayBeforeCASAfterRevokeAndRestart:true,finalGrantRevision:3,
  totalActions:4,ownHostShutdownRegistered:true,noAuthenticatedEngineOrGUI:true};
 if(process.env.D03_R2_PRIMARY_PROOF)writeFileSync(process.env.D03_R2_PRIMARY_PROOF,JSON.stringify(proof,null,2)+'\n');

});

test('R2 strict human registry, bot isolation, missing first-gesture enablement, exact replay/CAS/restart and paired rejection', {timeout:20000},async t=>{
 const f=await fixture(t),other=f.services.store.createBot({name:'Other synthetic',profileId:'synthetic',engine:'codex'}),input=await f.accessInput('first-human','files_write');
 for(const extra of [{botId:other.id},{tool:'dexter.harness.terminal.run'},{destination:'arbitrary'},{policy:'allow'},{ownerId:f.bot.id}])assert.equal((await f.request(f.accessPath,{...input,...extra},'PATCH')).status,400);
 assert.equal((await f.request(f.accessPath,{...input,operation:'dexter.harness.terminal.run'},'PATCH')).status,400);
 assert.equal((await f.request(f.accessPath,{...input,expectedHostId:'other-host'},'PATCH')).status,403);
 const enabled=await f.request(f.accessPath,input,'PATCH');assert.equal(enabled.status,200);assert.equal(enabled.body.previous.entries[2].grant,null);assert.equal(enabled.body.access.entries[2].grant.revision,1);
 assert.deepEqual((await f.request(f.accessPath,input,'PATCH')).body,enabled.body);
 assert.equal((await f.request(f.accessPath,{...input,enabled:false},'PATCH')).status,409);
 assert.equal((await f.request(f.accessPath,{...input,clientRequestId:'stale-inventory'},'PATCH')).status,409);
 assert.ok((await f.request(`/v1/bots/${other.id}/execution-access`)).body.entries.every(entry=>entry.grant===null));
 const edited=await f.accessInput('bot-revision-stale','cli');f.services.store.patchBot(f.bot.id,{expectedRevision:f.bot.revision,name:'Renamed synthetic'});
 assert.equal((await f.request(f.accessPath,edited,'PATCH')).status,409);
 const authority={principal:'paired-client',installationId:f.services.store.hostId,ownerId:f.services.store.ownerId,deviceId:'dev_synthetic',pinGeneration:1,bindingRevision:1,role:'client-ios',scopes:['chat.read','chat.write','approvals.decide'],assertCurrent(){},noteSelfRevoke(){}};
 const paired=createAuthorizedHostRouter(f.services.store);
 for(const method of ['GET','PATCH'])assert.equal((await paired.fetch(new Request(`https://paired.invalid${f.accessPath}`,{method,...(method==='PATCH'?{headers:{'content-type':'application/json'},body:JSON.stringify(input)}:{})}),{authority})).status,403);
 for(const operation of ['terminal','cli','automation']){
  const result=await f.request(f.accessPath,await f.accessInput('human-'+operation,operation),'PATCH');assert.equal(result.status,200);
  assert.equal(result.body.access.entries.find(entry=>entry.operation===operation).grant.policy,'ask');
 }
 // The policy does not make raw alias or human-only bot configuration eligible.
 await f.policy('full_access','auto-negative');
 const turn=f.services.store.createTurn(f.thread.id,{clientRequestId:'synthetic-raw',content:'synthetic'}).turn;f.services.store.claimNextTurn(f.thread.id);
 const request={botId:f.bot.id,threadId:f.thread.id,tool:'dexter.harness.files.write',destination:'dexter-harness-owner-proposals',arguments:{},idempotencyKey:'raw-alias'};
 assert.equal(f.services.store.requestAction(request).state,'awaiting_approval');
 const ready=f.services.store.requestAction({...request,idempotencyKey:'trusted-before-revoke'},'files_write');
 f.services.store.bindToolAction(ready.id,turn.id,'trusted-before-revoke');assert.equal(ready.state,'ready');
 const revoke=await f.request(f.accessPath,await f.accessInput('human-revoke-write','files_write',false),'PATCH');assert.equal(revoke.status,200);
 assert.ok(revoke.body.revocationEffects.blockedActionIds.includes(ready.id));assert.equal(f.services.store.getAction(ready.id).state,'blocked');
 assert.throws(()=>f.services.store.claimAction(ready.id),error=>error.code==='conflict');
 f.services.store.finishTurn(turn.id,'completed',null);
 const db=new DatabaseSync(join(f.root,'host','dexter.sqlite'));
 db.prepare("UPDATE grants SET expires_at=0,revision=revision+1 WHERE bot_id=? AND tool='dexter.harness.cli.run'").run(f.bot.id);db.close();
 const expired=await f.accessInput('expired-cannot-renew','cli');assert.equal((await f.request(f.accessPath,expired,'PATCH')).status,409);
 assert.equal(f.services.store.getGrant(f.bot.id,'dexter.harness.cli.run','dexter-harness-owner-proposals').expiresAt,0);
 await f.restart();assert.deepEqual((await f.request(f.accessPath,input,'PATCH')).body,enabled.body);
});

// Construct a genuine historical catalog. Dropping v13 tables from a Hub14 leaves the v14 CHECKs/new tables and is not a v12 fixture.
function replaceWithHistoricalHub(root,dbFile,version){
 const source=new DatabaseSync(dbFile,{readOnly:true}),temporary=join(root,`vintage-${version}.sqlite`),target=new DatabaseSync(temporary);
 try{
  target.exec(EXACT_SCHEMAS[`hub${version}`].sql);target.exec(`PRAGMA foreign_keys=OFF; PRAGMA user_version=${version};`);
  const tables=target.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for(const {name} of tables){
   const columns=target.prepare(`PRAGMA table_info("${name}")`).all().map(c=>c.name);
   const insert=target.prepare(`INSERT INTO "${name}" (${columns.map(c=>`"${c}"`).join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
   for(const row of source.prepare(`SELECT * FROM "${name}"`).all())insert.run(...columns.map(c=>row[c]));
  }
 }finally{source.close();target.close();}
 renameSync(temporary,dbFile);
}

test('R2 exact hub14/13/12/11 schemas and forward-only migration preserve provisional grants; counterfeit receipt/schema fail closed', t=>{
 const root=realpathSync(mkdtempSync(join(process.env.TMPDIR??'/private/tmp','d03-r2-schema-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const dbFile=join(root,'dexter.sqlite');let store=new HostStore({dataDir:root,clock:()=>1000});
 const bot=store.createBot({name:'Migration synthetic',profileId:'synthetic',engine:'codex'});
 store.setProposalGrant({botId:bot.id,tool:'dexter.harness.terminal.run',destination:'dexter-harness-owner-proposals',policy:'ask'});store.close();
 let db=new DatabaseSync(dbFile);assert.equal(SCHEMA_VERSION,14);assert.equal(checkHubExact(db).ownerId,bot.ownerId);assert.equal(checkFullSchema(db,'hub').ownerId,bot.ownerId);
 assert.ok(FULL_SCHEMAS.hub.sql.includes('bot_execution_access_receipts'));
 db.close();replaceWithHistoricalHub(root,dbFile,12);db=new DatabaseSync(dbFile);assert.equal(checkHubExact(db).ownerId,bot.ownerId);db.close();
 store=new HostStore({dataDir:root,clock:()=>1000});assert.equal(store.getBotApprovalPolicy(bot.id).mode,'ask');assert.equal(store.getBotExecutionAccess(bot.id).entries[0].provisional,true);store.close();
 replaceWithHistoricalHub(root,dbFile,11);db=new DatabaseSync(dbFile);assert.equal(checkHubExact(db).ownerId,bot.ownerId);db.close();
 store=new HostStore({dataDir:root,clock:()=>1000});assert.equal(store.getBotExecutionAccess(bot.id).entries[0].provisional,true);assert.equal(store.getBotApprovalPolicy(bot.id).revision,0);store.close();
 db=new DatabaseSync(dbFile);db.exec('CREATE TABLE counterfeit(x TEXT);');assert.throws(()=>checkHubExact(db));db.close();assert.throws(()=>new HostStore({dataDir:root}));
 for(const version of [11,12,13,14]){const memory=new DatabaseSync(':memory:');memory.exec(EXACT_SCHEMAS[`hub${version}`].sql);memory.exec(`PRAGMA user_version=${version}`);memory.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('owner_id','own_synthetic');memory.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('host_id','host_synthetic');assert.equal(checkHubExact(memory).ownerId,'own_synthetic');memory.close();}
});


// R3: exact owner execution continuity. This is a trusted synthetic executor, not inference or GUI.
const r3Evidence=(name,value)=>{if(process.env.D03_R3_EVIDENCE_FILE)appendFileSync(process.env.D03_R3_EVIDENCE_FILE,JSON.stringify({name,...value})+'\n');};
function r3Store(t,{expiresAt=null}={}){
 const root=realpathSync(mkdtempSync(join(process.env.TMPDIR??'/private/tmp','d03-r3-store-')));let now=1000;
 let store=new HostStore({dataDir:root,clock:()=>now});
 const bot=store.createBot({name:'R3 exact synthetic',profileId:'synthetic',engine:'codex'}),thread=store.createThread(bot.id);
 const turn=store.createTurn(thread.id,{clientRequestId:'r3-input',content:'synthetic exact grant continuity'}).turn;store.claimNextTurn(thread.id);
 store.setProposalGrant({botId:bot.id,tool:'dexter.harness.terminal.run',destination:'dexter-harness-owner-proposals',policy:'ask',expiresAt});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const f={root,bot,thread,turn,get store(){return store;},setNow(value){now=value;},reopen(){store.close();store=new HostStore({dataDir:root,clock:()=>now});},
  input(key,enabled=true){const before=store.getBotExecutionAccess(bot.id);return {expectedHostId:store.hostId,clientRequestId:key,expectedBotRevision:before.botRevision,expectedInventoryHash:before.inventoryHash,scopeVersion:BOT_EXECUTION_ACCESS_SCOPE_VERSION,operation:'terminal',enabled};},
  proposal(name,allow=false){const action=store.requestAction({botId:bot.id,threadId:thread.id,tool:'dexter.harness.terminal.run',destination:'dexter-harness-owner-proposals',arguments:{input:{runtime:'sh',command:'synthetic held effect '+name}},idempotencyKey:name});store.bindToolAction(action.id,turn.id,name);return allow?store.decideAction(action.id,{decision:'allow',requestHash:action.requestHash}):action;},
  journal(){const db=new DatabaseSync(store.databasePath,{readOnly:true});try{return db.prepare("SELECT data FROM turn_events WHERE json_extract(data,'$.kind')='execution_access_continued' ORDER BY cursor").all().map(row=>JSON.parse(row.data));}finally{db.close();}},
  mutate(sql,...params){const db=new DatabaseSync(store.databasePath);try{db.prepare(sql).run(...params);}finally{db.close();}}};
 return f;
}
async function r3Held(t,f,name='running'){
 const ready=f.proposal(name,true);let release,resolveStarted,effects=0,signal;
 const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{resolveStarted=resolve;});
 const promise=dispatchAction(f.store,ready.id,async(_request,context)=>{
  effects++;signal=context.signal;resolveStarted();await gate;
  if(signal.aborted)throw Error('synthetic interrupted executor');
  return {termination:'completed',exitCode:0,signal:null,stdout:'R3_SYNTHETIC_EFFECT',stdoutTruncated:false};
 });
 t.after(async()=>{release();await promise.catch(()=>{});});await started;
 return {id:ready.id,request:ready.request,grantRevision:ready.grantRevision,promise,release,get signal(){return signal;},get effects(){return effects;}};
}

test('R3 enable preserves running exact owner across two ask revisions; old pending/ready block, receipts replay and completed never dispatches again',{timeout:15000},async t=>{
 const f=r3Store(t),running=await r3Held(t,f),pending=f.proposal('pending'),ready=f.proposal('ready',true);
 const input=f.input('enable-1'),receipt=f.store.setBotExecutionAccess(f.bot.id,input);
 assert.deepEqual(receipt.revocationEffects.blockedActionIds.slice().sort(),[pending.id,ready.id].sort());assert.deepEqual(receipt.revocationEffects.abortedActionIds,[]);
 assert.equal(receipt.previous.entries[0].provisional,true);assert.equal(receipt.access.entries[0].grant.policy,'ask');assert.equal(receipt.access.entries[0].grant.revision,2);
 await new Promise(resolve=>setTimeout(resolve,250));assert.equal(running.signal.aborted,false);assert.equal(f.store.getAction(running.id).state,'running');
 for(const id of [running.id,pending.id,ready.id])assert.equal(f.store.getAction(id).grantRevision,1,'stored action pins never advance');
 for(const id of [pending.id,ready.id]){assert.equal(f.store.getAction(id).reason,'permission_changed');assert.throws(()=>f.store.claimAction(id),e=>e.code==='conflict');assert.throws(()=>f.store.decideAction(id,{decision:'allow',requestHash:f.store.getAction(id).requestHash}),e=>e.code==='conflict');}
 assert.deepEqual(f.store.setBotExecutionAccess(f.bot.id,input),receipt);assert.equal(f.journal().length,1);
 assert.throws(()=>f.store.setBotExecutionAccess(f.bot.id,{...input,enabled:false}),e=>e.code==='conflict');
 assert.throws(()=>f.store.setBotExecutionAccess(f.bot.id,{...input,clientRequestId:'stale'}),e=>e.code==='conflict');
 const second=f.store.setBotExecutionAccess(f.bot.id,f.input('enable-2'));assert.equal(second.access.entries[0].grant.revision,3);assert.deepEqual(second.revocationEffects.abortedActionIds,[]);
 assert.equal(f.journal().length,2);await new Promise(resolve=>setTimeout(resolve,250));assert.equal(running.signal.aborted,false);
 running.release();const result=await running.promise;assert.equal(result.state,'succeeded');assert.equal(running.effects,1);
 f.store.recordToolOutcome(running.id,result.result);f.store.finishTurn(f.turn.id,'completed',null);
 const response=f.store.createActionResultTurn(running.id);assert.match(f.store.turnInput(response.id),/R3_SYNTHETIC_EFFECT/);
 assert.equal(f.store.requestAction(running.request).id,running.id);assert.throws(()=>f.store.claimAction(running.id),e=>e.code==='conflict');assert.equal(running.effects,1);
 f.reopen();assert.deepEqual(f.store.setBotExecutionAccess(f.bot.id,input),receipt);assert.match(f.store.turnInput(response.id),/R3_SYNTHETIC_EFFECT/);
 const completedEnable=f.store.setBotExecutionAccess(f.bot.id,f.input('enable-after-completion'));assert.equal(completedEnable.access.entries[0].grant.revision,4);assert.equal(f.journal().length,2,'terminal action receives no new continuity proof');
 assert.equal(f.store.getAction(running.id).state,'succeeded');assert.throws(()=>f.store.claimAction(running.id),e=>e.code==='conflict');
 r3Evidence('exact_chain',{runningPin:1,currentRevision:4,chainEvents:2,pendingBlocked:2,abortedByEnable:0,effects:1,responseBodyAcrossReopen:true,replay:true,staleAndChangedRequestConflict:true,terminalNotRevived:true});
});

test('R3 continued exact effect still aborts on revoke, generic ask/deny gap, TTL, Stop, bot/origin change, lease/authority fence and invalid proof',{timeout:20000},async t=>{
 const results=[];
 for(const kind of ['revoke','generic_ask','deny_then_enable','ttl','stop','bot','origin','lease','authority','receipt_hash','chain_gap']){
  const f=r3Store(t,{expiresAt:kind==='ttl'?2000:null}),held=await r3Held(t,f,kind);
  const first=f.store.setBotExecutionAccess(f.bot.id,f.input('enable-'+kind));assert.deepEqual(first.revocationEffects.abortedActionIds,[]);
  assert.equal(held.signal.aborted,false);
  if(kind==='revoke'){const receipt=f.store.setBotExecutionAccess(f.bot.id,f.input('revoke',false));assert.deepEqual(receipt.revocationEffects.abortedActionIds,[held.id]);}
  if(kind==='generic_ask')f.store.setGrant({botId:f.bot.id,tool:held.request.tool,destination:held.request.destination,policy:'ask'});
  if(kind==='deny_then_enable'){f.store.setGrant({botId:f.bot.id,tool:held.request.tool,destination:held.request.destination,policy:'deny'});const receipt=f.store.setBotExecutionAccess(f.bot.id,f.input('reenable'));assert.deepEqual(receipt.revocationEffects.abortedActionIds,[held.id]);assert.equal(f.journal().length,1);}
  if(kind==='ttl')f.setNow(2000);
  if(kind==='stop')f.store.withdrawTurnToolActions(f.turn.id);
  if(kind==='bot')f.store.patchBot(f.bot.id,{expectedRevision:f.bot.revision,name:'Changed synthetic'});
  if(kind==='origin')f.mutate('UPDATE tool_action_continuations SET call_id=? WHERE action_id=?','changed-call',held.id);
  if(kind==='lease')f.mutate('UPDATE host_lease SET token=? WHERE id=1','synthetic-lost-lease');
  if(kind==='authority')f.mutate('UPDATE host_authority SET epoch=epoch+1 WHERE id=1');
  if(kind==='receipt_hash')f.mutate("UPDATE bot_execution_access_receipts SET receipt=json_set(receipt,'$.inputHash',?) WHERE id=?",'0'.repeat(64),first.id);
  if(kind==='chain_gap')f.mutate("DELETE FROM turn_events WHERE json_extract(data,'$.kind')='execution_access_continued' AND json_extract(data,'$.actionId')=?",held.id);
  await until(()=>held.signal.aborted);assert.equal(held.signal.aborted,true);held.release();
  if(['lease','authority'].includes(kind)){await assert.rejects(held.promise,e=>e.code==='host_locked');assert.throws(()=>f.store.setBotExecutionAccess(f.bot.id,f.input('fenced-enable')),e=>e.code==='host_locked');}
  else{const result=await held.promise;assert.equal(result.state,'unknown');assert.equal(result.result.diagnostic.retryAutomatically,false);assert.throws(()=>f.store.claimAction(held.id),e=>e.code==='conflict');
   if(['generic_ask','receipt_hash','chain_gap'].includes(kind)){const next=f.store.setBotExecutionAccess(f.bot.id,f.input('enable-after-unknown'));assert.equal(next.revocationEffects.abortedActionIds.length,0);assert.equal(f.store.getAction(held.id).state,'unknown');assert.throws(()=>f.store.claimAction(held.id),e=>e.code==='conflict');}}
  assert.equal(held.effects,1);results.push({kind,aborted:true,effects:1,automaticRetry:false});
 }
 r3Evidence('negative_boundaries',{scenarios:results});
});

test('R3 enable cannot inherit policy/bounded grants, another bot or an already revoked/expired exact pin',{timeout:15000},async t=>{
 const f=r3Store(t),policy=f.store.getBotApprovalPolicy(f.bot.id);
 f.store.setBotApprovalPolicy(f.bot.id,{expectedHostId:f.store.hostId,clientRequestId:'auto',expectedRevision:policy.revision,mode:'full_access',eligibleScopeVersion:APPROVAL_POLICY_SCOPE_VERSION});
 f.store.setBotExecutionAccess(f.bot.id,f.input('initial-enable'));
 const auto=f.store.requestAction({botId:f.bot.id,threadId:f.thread.id,tool:'dexter.harness.terminal.run',destination:'dexter-harness-owner-proposals',arguments:{},idempotencyKey:'auto'},'terminal');f.store.bindToolAction(auto.id,f.turn.id,'auto');f.store.claimAction(auto.id);const scope=f.store.approvedExecution(auto.id);t.after(()=>scope.dispose());
 assert.equal(auto.authorization.source,'owner_policy');const receipt=f.store.setBotExecutionAccess(f.bot.id,f.input('enable-policy-running'));assert.deepEqual(receipt.revocationEffects.abortedActionIds,[auto.id]);assert.equal(scope.signal.aborted,true);assert.equal(f.journal().length,0);
 f.store.markUnknown(auto.id,'executor_error');
 const other=f.store.createBot({name:'Other R3 synthetic',profileId:'synthetic-other',engine:'codex'}),own=await r3Held(t,f,'other-bot-isolation');
 const state=f.store.getBotExecutionAccess(other.id);f.store.setBotExecutionAccess(other.id,{expectedHostId:f.store.hostId,clientRequestId:'other-enable',expectedBotRevision:state.botRevision,expectedInventoryHash:state.inventoryHash,scopeVersion:BOT_EXECUTION_ACCESS_SCOPE_VERSION,operation:'terminal',enabled:true});
 await new Promise(resolve=>setTimeout(resolve,150));assert.equal(own.signal.aborted,false);assert.equal(f.journal().length,0);own.release();assert.equal((await own.promise).state,'succeeded');
 const expired=r3Store(t,{expiresAt:1100}),held=await r3Held(t,expired,'expired');expired.setNow(1100);assert.throws(()=>expired.store.setBotExecutionAccess(expired.bot.id,expired.input('expired-enable')),e=>e.code==='conflict');assert.equal(expired.journal().length,0);await until(()=>held.signal.aborted);held.release();assert.equal((await held.promise).state,'unknown');
 r3Evidence('scope_restriction',{ownerPolicyNotContinued:true,otherBotUnaffected:true,expiredEnableRefused:true});
});

test('R3 real owner HTTP enable during approved shell keeps effect, receipt and engine response once; no action repin',{timeout:20000},async t=>{
 const f=await fixture(t);await f.policy('full_access','r3-auto-with-provisional');
 const turn=f.services.runtime.startTurn(f.thread.id,{clientRequestId:'r3-enable-running',content:'R3_ENABLE_LONG'}).turn;
 const pending=await until(()=>f.services.store.listActions('awaiting_approval')[0]);assert.equal(pending.approvalRequirement.reason,'access_not_enabled');
 assert.equal((await f.request(`/v1/actions/${pending.id}/decisions`,{decision:'allow',requestHash:pending.requestHash},'POST')).status,200);
 const partial=join(f.root,'host','bot-files',f.bot.id,'enable-partial.txt');await until(()=>existsSync(partial)&&f.services.store.getAction(pending.id).state==='running');
 const running=f.services.store.getAction(pending.id);assert.equal(running.authorization.source,'exact_owner');
 const input=await f.accessInput('r3-human-enable'),enabled=await f.request(f.accessPath,input,'PATCH');assert.equal(enabled.status,200);assert.deepEqual(enabled.body.revocationEffects.abortedActionIds,[]);
 assert.deepEqual((await f.request(f.accessPath,input,'PATCH')).body,enabled.body);
 assert.equal((await f.services.runtime.waitForTurn(turn.id,10000)).state,'completed');const result=f.services.store.getAction(pending.id);
 assert.equal(result.state,'succeeded');assert.equal(result.grantRevision,running.grantRevision);assert.equal(result.result.termination,'completed');assert.equal(readFileSync(partial,'utf8'),'begin\nend\n');
 assert.equal(f.services.store.toolActionProgress(pending.id).consumedByEngine,true);assert.equal(JSON.parse(f.services.store.turnOutput(turn.id)).receipt.actionId,pending.id);
 assert.equal(f.services.store.requestAction(result.request).id,result.id);assert.equal(f.services.store.listActions().length,1);assert.throws(()=>f.services.store.claimAction(result.id),e=>e.code==='conflict');
 r3Evidence('real_http_shell',{state:result.state,authorization:result.authorization.source,originalGrantPin:running.grantRevision,currentRevision:enabled.body.access.entries[0].grant.revision,abortedByEnable:0,file:'begin/end',effects:1,engineConsumedReceipt:true,responseCorrelated:true,noRetry:true});
});
