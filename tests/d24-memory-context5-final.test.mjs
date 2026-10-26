import { mcpDirectoryClient } from './fixtures/mcp-directory-client.mjs';
import {BACKEND_COUNT_TABLES} from '../packages/operations/dist/memory-backend-schema.js';
import { LEARNING_COUNT_TABLES } from '../packages/operations/dist/memory-learning-schema.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { HostServices } from '../packages/cli/dist/host-services.js';
import { HarnessOperationSurface, HARNESS_OPERATION_DESTINATION } from '../packages/cli/dist/harness-operation-surface.js';
import { createHostApp } from '../packages/hub/dist/http.js';
import { ContextRepository } from '../packages/context/dist/repository.js';
import { LEDGER_COUNT_TABLES } from '../packages/operations/dist/memory-ledger.js';
import { checkFullSchema, contextSchemaLabel, FULL_SCHEMAS } from '../packages/operations/dist/full-schemas.js';
import { validateContext } from '../packages/operations/dist/validate.js';
import { readContextGit } from '../packages/operations/dist/git.js';
import { gitSnapshotOf } from '../packages/operations/dist/checkpoint.js';
import { resolveLimits, gitLimits, contextCounts } from '../packages/operations/dist/manifest.js';
import { gatewayReceiptEvidence } from '../packages/engines/dist/mcp-options.js';
import { APPROVAL_POLICY_SCOPE_VERSION } from '../packages/contracts/dist/index.js';
const catalog=()=>[{id:'codex',available:true,models:[{id:'synthetic',reasoningEfforts:['medium'],speeds:[]}],defaultModel:'synthetic',reasoningEfforts:['medium'],speeds:[]}];
const driver=id=>({id,capabilities:{resume:true,interrupt:true,fork:false,steer:false},status:async()=>({engine:id,installed:true}),open:async threadId=>({threadId,nativeCursor:'synthetic'}),async *turn(session,turnId){yield{type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},respondToTool:async()=>{},interrupt:async()=>{},close:async()=>{}});
function fixture(t){
 const root=realpathSync(mkdtempSync(new URL('../../proof/d24-final-fixture-',import.meta.url).pathname)),surfaces=[],turns=[];let services,app,sequence=0;
 const open=()=>{services=new HostServices({dataDir:join(root,'host'),enableEngines:true,enableMcp:true,engineCommands:{codex:'/usr/bin/false'},makeDriver:driver,engineCatalog:catalog});app=createHostApp(services.store,{runtime:services.runtime,botDocuments:services.botDocumentsHttp});};open();
 const surface=over=>{const value=new HarnessOperationSurface({store:services.store,base:services.gateway,catalog:services.engineCatalog,runtime:()=>services.runtime,skills:()=>services.skillsHttp,documents:()=>services.botDocumentsHttp,effectiveSkills:()=>[],...over});surfaces.push(value);return value;};
 const live=(bot,thread=services.store.createThread(bot.id),s=surface())=>{const{turn}=services.store.createTurn(thread.id,{clientRequestId:`manual-${++sequence}`,content:'Synthetic memory request'});services.store.claimNextTurn(thread.id);turns.push(turn);return {thread,turn,surface:s,token:s.issueCapability({turnId:turn.id}).token};};
 const request=(path,method='GET',input)=>app.request(`http://127.0.0.1${path}`,{method,...(input===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(input)})});
 const decide=async(receipt,decision='allow')=>{const response=await request(`/v1/actions/${receipt.actionId}/decisions`,'POST',{decision,requestHash:receipt.requestHash});assert.equal(response.status,200);};
 const stop=async()=>{for(const s of surfaces.splice(0))await s.close();for(const turn of turns.splice(0))if(services.store.getTurn(turn.id).state==='running')services.store.finishTurn(turn.id,'completed',null);await services.shutdown();};
 t.after(async()=>{await stop();rmSync(root,{recursive:true,force:true});});
 return {root,get services(){return services;},get app(){return app;},surface,live,request,decide,stop,open,bot:()=>services.store.createBot({name:'Synthetic',profileId:'synthetic',engine:'codex'})};
}
const call=(live,name,callId,args={})=>live.surface.call(live.token,{connectionId:HARNESS_OPERATION_DESTINATION,tool:`dexter.harness.${name}`,callId,arguments:args});
async function approved(f,live,name,id,args){const pending=await call(live,name,id,args);assert.equal(pending.status,'awaiting_approval');await f.decide(pending);return call(live,name,id,args);}
const save=(f,bot,revision,memory,soul=`SOUL-${revision+1}`,user=`USER-${revision+1}`)=>f.services.botDocumentsHttp.compareAndSet(bot.id,{expectedRevision:revision,soul,user,memory,clientRequestId:`owner-${revision}`,sourceReference:`declared citation ${revision}`});

test('D24 real owner HTTP/Context/Git: r1→r4 preserves current SOUL/USER, canonical pagination, exact replay/restart and legacy migration plus snapshot',async t=>{
 const f=fixture(t),a=f.bot();save(f,a,0,'MEMORY 一 🚀 e\u0301');save(f,a,1,'MEMORY TWO');const current=save(f,a,2,'MEMORY THREE','CURRENT SOUL 🦊','CURRENT USER');
 const before=f.services.store.getBot(a.id),path=`/v1/bots/${a.id}/documents`,input={expectedRevision:3,fromRevision:1,clientRequestId:'restore-r1',sourceReference:'User-declared archive'};
 const response=await f.request(path+'/memory/restore','POST',input);assert.equal(response.status,200);const restored=await response.json();
 assert.equal(restored.revision,4);assert.equal(restored.memory,'MEMORY 一 🚀 e\u0301');assert.equal(restored.soul,current.soul);assert.equal(restored.user,current.user);assert.equal(restored.memoryHead.restoredFrom,1);assert.equal(restored.memoryHead.source.kind,'owner_ui');assert.equal(restored.memoryHead.source.ownerId,a.ownerId);assert.deepEqual(f.services.store.getBot(a.id),before);
 const replay=await(await f.request(path+'/memory/restore','POST',input)).json();assert.deepEqual(replay,restored);
 assert.equal((await f.request(path+'/memory/restore','POST',{...input,fromRevision:2})).status,409);
 assert.equal((await f.request(path+'/memory/restore','POST',{...input,clientRequestId:'other',grants:[]})).status,400);
 assert.equal((await f.request(path+'/memory/restore','POST',{...input,clientRequestId:'stale'})).status,409);
 for(const body of [{...input,sourceReference:'\ud800'},{...input,sourceReference:'sk-'+ 'A'.repeat(30)}])assert.equal((await f.request(path+'/memory/restore','POST',body)).status,400);
 assert.equal((await f.request(path+'?botId=other')).status,400);
 assert.equal((await f.app.request('http://127.0.0.1'+path+'/memory/history',{headers:{origin:'https://foreign.invalid'}})).status,403);
 const page=f.services.botDocumentsHttp.history(a.id,{limit:2});assert.deepEqual(page.items.map(x=>x.revision),[4,3]);assert.equal(page.nextCursor,'r3');assert.deepEqual(f.services.botDocumentsHttp.history(a.id,{before:page.nextCursor,limit:2}).items.map(x=>x.revision),[2,1]);
 const threadBot=f.bot(),own=f.live(threadBot);assert.equal((await call(own,'memory.history','history')).result.items.length,0);await assert.rejects(call(own,'memory.read_revision','foreign',{revision:1}),e=>e.code==='unavailable');await assert.rejects(call(own,'memory.history','spoof',{botId:a.id}),e=>e.code==='invalid_input');
 await f.stop();f.open();assert.deepEqual(f.services.botDocumentsHttp.restore(a.id,input),restored);assert.deepEqual(f.services.botDocumentsHttp.receipt(a.id,'owner:restore-r1'),restored);assert.equal(f.services.botDocumentsHttp.history(a.id).items.length,4);
 // A real v1 migration preserves only its canonical head/pins and admits no fabricated exact legacy ledger.
 await f.stop();const old=new DatabaseSync(join(f.root,'host/context.sqlite'),{enableForeignKeyConstraints:false});for(const table of [...Object.values(BACKEND_COUNT_TABLES).reverse(),...Object.values(LEARNING_COUNT_TABLES).reverse(),...Object.values(LEDGER_COUNT_TABLES).reverse()])old.exec(`DROP TABLE ${table}`);old.exec("DROP TABLE bot_document_receipts; DROP TABLE bot_document_revisions; UPDATE meta SET value='1' WHERE key='schema'");assert.equal(contextSchemaLabel(old),'context-v1-bot-documents');checkFullSchema(old,'context');const pins=old.prepare('SELECT * FROM bot_documents WHERE bot_id=?').get(a.id);old.close();f.open();
 const legacy=f.services.botDocumentsHttp.read(a.id);assert.equal(legacy.revision,4);assert.equal(legacy.memoryHead.source.kind,'legacy_unknown');assert.equal(f.services.botDocumentsHttp.history(a.id).items.length,1);assert.equal(f.services.botDocumentsHttp.receipt(a.id,'owner:restore-r1'),null);
 const db=new DatabaseSync(f.services.context.databasePath);assert.deepEqual(db.prepare('SELECT * FROM bot_documents WHERE bot_id=?').get(a.id),pins);assert.equal(contextSchemaLabel(db),'context-v5-memory-learning-backend');checkFullSchema(db,'context');
 // Fenced VACUUM snapshots of the real DBs plus real Git object capture, then shared capture/recovery validator.
 const snapshot=join(f.root,'context-snapshot.sqlite'),hubSnapshot=join(f.root,'hub-snapshot.sqlite');
 f.services.store.withWriterLease(()=>{db.prepare('VACUUM INTO ?').run(snapshot);const hub=new DatabaseSync(f.services.store.databasePath);hub.prepare('VACUUM INTO ?').run(hubSnapshot);hub.close();});db.close();
 const frozen=new DatabaseSync(snapshot,{readOnly:true}),hub=new DatabaseSync(hubSnapshot,{readOnly:true});
 try {checkFullSchema(frozen,'context');const limits=resolveLimits(),git=readContextGit(f.services.context.repositoryPath,gitLimits(limits),()=>{}),captured=gitSnapshotOf(git,limits);validateContext(frozen,hub,captured.snapshot);assert.deepEqual(contextCounts(frozen,captured.objects),{artifacts:0,revisions:0,skills:0,activations:0,memories:0,gitObjects:captured.objects,botDocuments:1,documentRevisions:1,documentReceipts:0,...Object.fromEntries([...Object.keys(LEDGER_COUNT_TABLES),...Object.keys(LEARNING_COUNT_TABLES),...Object.keys(BACKEND_COUNT_TABLES)].map(key=>[key,0]))});}finally{frozen.close();hub.close();}
});

test('D24 harness exact Ask, denial, source identity, CAS race, postcommit unknown → GETreceipt and restart never re-execute',async t=>{
 const f=fixture(t),a=f.bot(),other=f.bot();save(f,a,0,'FIRST');save(f,a,1,'SECOND');save(f,a,2,'THIRD','CURRENT SOUL','CURRENT USER');const live=f.live(a);
 f.services.store.setBotApprovalPolicy(a.id,{expectedHostId:f.services.store.hostId,expectedRevision:0,clientRequestId:'mode',mode:'approve_all',eligibleScopeVersion:APPROVAL_POLICY_SCOPE_VERSION});
 const args={expectedRevision:3,fromRevision:1,sourceReference:'A declared source'};
 const deny=await call(live,'memory.restore','deny',args);assert.equal(deny.status,'awaiting_approval');await f.decide(deny,'deny');assert.equal((await call(live,'memory.restore','deny',args)).status,'denied');assert.equal(f.services.botDocumentsHttp.read(a.id).revision,3);
 for(const extra of [{botId:other.id},{target:other.id},{grants:[]},{source:{kind:'owner_ui'}}])await assert.rejects(call(live,'memory.restore','extra'+Object.keys(extra)[0],{...args,...extra}),e=>e.code==='invalid_input');
 const raced=await call(live,'memory.restore','race',args);save(f,a,3,'FOURTH');await f.decide(raced);assert.equal((await call(live,'memory.restore','race',args)).status,'blocked');assert.equal(f.services.botDocumentsHttp.read(a.id).memory,'FOURTH');
 let effects=0;const actual=f.services.botDocumentsHttp,s=f.surface({documents:()=>({...actual,executeAction:id=>{effects++;actual.executeAction(id);throw new Error('Synthetic crash after Context commit');}})}),uncertain=f.live(a,undefined,s),uncertainArgs={expectedRevision:4,fromRevision:1};
 const result=await approved(f,uncertain,'memory.restore','postcommit',uncertainArgs);assert.equal(result.status,'unknown');assert.equal(result.reason,'executor_error');assert.equal(effects,1);assert.equal((await call(uncertain,'memory.restore','postcommit',uncertainArgs)).status,'unknown');assert.equal(effects,1);
 const recovered=(await call(uncertain,'memory.receipt','get',{action_id:result.actionId})).result;assert.equal(recovered.dispatcher.state,'unknown');assert.equal(recovered.documents.revision,5);assert.equal(recovered.documents.memory,'FIRST');assert.equal(recovered.documents.memoryHead.source.kind,'harness_action');assert.equal(recovered.documents.memoryHead.source.turnId,uncertain.turn.id);assert.equal(recovered.documents.memoryHead.source.callId,'postcommit');
 const foreign=f.live(other);await assert.rejects(call(foreign,'memory.receipt','crossbot',{action_id:result.actionId}),e=>e.code==='forbidden');const sameBotOtherConversation=f.live(a);await assert.rejects(call(sameBotOtherConversation,'memory.receipt','crossconversation',{action_id:result.actionId}),e=>e.code==='forbidden');await assert.rejects(call(uncertain,'memory.restore','postcommit',{...uncertainArgs,fromRevision:2}),e=>e.code==='conflict');
 const thread=uncertain.thread;await f.stop();f.open();const resumed=f.live(f.services.store.getBot(a.id),thread);assert.equal((await call(resumed,'memory.receipt','restart',{action_id:result.actionId})).result.documents.revision,5);assert.equal(f.services.botDocumentsHttp.history(a.id).items.length,5);assert.equal(effects,1);
 const updated=await approved(f,resumed,'documents.update','memory-update',{expectedRevision:5,document:'MEMORY',markdown:'SIX 🦉',sourceReference:'Citation six'});assert.equal(updated.status,'succeeded');assert.equal(updated.result.documents.receipt.source.actionId,updated.actionId);assert.equal(updated.result.documents.memoryHead.source.reference,'Citation six');
 const user=await approved(f,resumed,'documents.update','user-update',{expectedRevision:6,document:'USER',markdown:'NEW USER'});assert.equal(user.status,'succeeded');assert.equal(user.result.documents.memory,'SIX 🦉');assert.equal(user.result.documents.memoryHead.source.actionId,updated.actionId);
 // Shared backup validator reads every indexed history pin and exact action receipt against real Hub/Git.
 const db=new DatabaseSync(f.services.context.databasePath,{readOnly:true}),hub=new DatabaseSync(f.services.store.databasePath,{readOnly:true});try{const limits=resolveLimits();validateContext(db,hub,gitSnapshotOf(readContextGit(f.services.context.repositoryPath,gitLimits(limits),()=>{}),limits).snapshot);}finally{db.close();hub.close();}
});

test('D24 adulterated immutable pin fails closed; Git orphan cannot enter canonical history or restore',async t=>{
 const f=fixture(t),a=f.bot();save(f,a,0,'FIRST');save(f,a,1,'SECOND');const source=f.services.botDocumentsHttp.readRevision(a.id,1);
 const orphan=new ContextRepository(f.services.context.repositoryPath).write(`memory/${a.id}/MEMORY-r99-00000000-0000-0000-0000-000000000000.md`,'ORPHAN');assert.ok(orphan.commit);assert.equal(f.services.botDocumentsHttp.history(a.id).items.length,2);assert.throws(()=>f.services.botDocumentsHttp.readRevision(a.id,99),e=>e.code==='not_found');assert.throws(()=>f.services.botDocumentsHttp.restore(a.id,{expectedRevision:2,fromRevision:99,clientRequestId:'orphan'}),e=>e.code==='not_found');
 writeFileSync(join(f.services.context.repositoryPath,source.pin.path),'ADULTERATED');assert.throws(()=>f.services.botDocumentsHttp.readRevision(a.id,1),e=>e.code==='tampered');assert.throws(()=>f.services.botDocumentsHttp.restore(a.id,{expectedRevision:2,fromRevision:1,clientRequestId:'tampered'}),e=>e.code==='tampered');assert.equal(f.services.botDocumentsHttp.read(a.id).revision,2);assert.equal(f.services.botDocumentsHttp.receipt(a.id,'owner:tampered'),null);
});

function socketRpc(path){
 const socket=createConnection(path),pending=new Map();let sequence=0,buffer='';
 const ready=new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});socket.on('error',()=>{});
 socket.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const i=buffer.indexOf('\n'),msg=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);const p=pending.get(msg.id);if(p){pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(new Error('Synthetic RPC refusal')):p.resolve(msg.result);}}});
 socket.on('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Synthetic RPC closed'));}pending.clear();});
 const rpc=async(method,params)=>{await ready;const id=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Synthetic RPC deadline'));},8000);pending.set(id,{resolve,reject,timer});socket.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});};
 return{rpc,initialize:async()=>{await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'D04-synthetic',version:'1'}});socket.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');},close:()=>socket.destroy()};
}

test('D24 real HostServices/Unix bridge/HTTP/action driver: restored effect consumed, old turn snapshot stays old, next turn gets MEMORY', {timeout:30000},async t=>{
 const root=realpathSync(mkdtempSync('/private/tmp/d24-engine-')),clients=[];let services,app,round=0;const inputs=[];
 const until=async predicate=>{const end=Date.now()+8000;while(!predicate()){if(Date.now()>end)throw new Error('Synthetic decision deadline');await new Promise(resolve=>setTimeout(resolve,10));}};
 const makeDriver=(id,options)=>({id,capabilities:{resume:true,interrupt:true,fork:false,steer:false},status:async()=>({engine:id,installed:true}),open:async threadId=>{const rpc=socketRpc(options.localMcpServer.args[1]);clients.push(rpc);await rpc.initialize();return{threadId,nativeCursor:'synthetic',rpc};},
 async *turn(session,turnId,input){inputs.push(input);round++;const directory=mcpDirectoryClient(session.rpc.rpc),find=name=>directory.find(name);
  if(round===1){
   const history=await directory.call(await find('dexter.harness.memory.history'),'history',{limit:2});assert.equal(history.structuredContent.result.items.length,2);
   const args={expectedRevision:3,fromRevision:1,sourceReference:'Declared old source'},operation=directory.call(await find('dexter.harness.memory.restore'),'restore',args);
   await until(()=>services.store.listActions('awaiting_approval').some(x=>x.request.tool==='dexter.harness.memory.restore'));const action=services.store.listActions('awaiting_approval').find(x=>x.request.tool==='dexter.harness.memory.restore');
   const decision=await app.request(`http://127.0.0.1/v1/actions/${action.id}/decisions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:'allow',requestHash:action.requestHash})});assert.equal(decision.status,200);
   const response=await operation;assert.equal(response.isError,false);const receipt=response.structuredContent;assert.equal(receipt.status,'succeeded');assert.equal(receipt.result.documents.revision,4);assert.equal(receipt.result.documents.memory,'FIRST TURN MEMORY');assert.equal(receipt.result.documents.soul,'CURRENT SOUL');assert.equal(receipt.result.documents.user,'CURRENT USER');
   for(const proof of gatewayReceiptEvidence(receipt))yield{type:'tool.result.observed',threadId:session.threadId,turnId,...proof};
   assert.ok(input.includes('THIRD TURN MEMORY'));assert.ok(!input.includes('FIRST TURN MEMORY'));yield{type:'text.delta',threadId:session.threadId,turnId,text:JSON.stringify({memory:receipt.result.documents.memory,revision:receipt.result.documents.revision,operationKey:receipt.result.documents.receipt.operationKey})};
  }else{assert.ok(input.includes('FIRST TURN MEMORY'));assert.ok(!input.includes('THIRD TURN MEMORY'));yield{type:'text.delta',threadId:session.threadId,turnId,text:'Next-turn snapshot contains FIRST TURN MEMORY'};}
  yield{type:'turn.completed',threadId:session.threadId,turnId,usage:{}};
 },respondToTool:async()=>{},interrupt:async()=>{},close:async session=>session.rpc.close()});
 t.after(async()=>{for(const client of clients)client.close();await services?.shutdown();rmSync(root,{recursive:true,force:true});});
 services=new HostServices({dataDir:join(root,'host'),enableEngines:true,enableMcp:true,engineCommands:{codex:'/usr/bin/false'},makeDriver,engineCatalog:catalog});app=createHostApp(services.store,{runtime:services.runtime,botDocuments:services.botDocumentsHttp});const bot=services.store.createBot({name:'Synthetic engine',profileId:'synthetic',engine:'codex'}),thread=services.store.createThread(bot.id);
 for(const [index,memory]of['FIRST TURN MEMORY','SECOND TURN MEMORY','THIRD TURN MEMORY'].entries())services.botDocumentsHttp.compareAndSet(bot.id,{expectedRevision:index,soul:'CURRENT SOUL',user:'CURRENT USER',memory,clientRequestId:`setup-${index}`});
 const first=services.runtime.startTurn(thread.id,{clientRequestId:'restore',content:'Restore the permitted memory revision'}).turn;assert.equal((await services.runtime.waitForTurn(first.id,12000)).state,'completed');const second=services.runtime.startTurn(thread.id,{clientRequestId:'next',content:'Read your next-turn memory'}).turn;assert.equal((await services.runtime.waitForTurn(second.id,12000)).state,'completed');
 const actions=services.store.listActions();assert.equal(actions.length,1);assert.equal(actions[0].state,'succeeded');assert.ok(services.store.toolActionProgress(actions[0].id).consumedByEngine);assert.equal(JSON.parse(services.store.turnOutput(first.id)).revision,4);assert.equal(services.botDocumentsHttp.history(bot.id).items.length,4);assert.equal(inputs.length,2);
});
