import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {generateKeyPairSync,createSecretKey,randomBytes,sign} from 'node:crypto';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {serve} from '@hono/node-server';
import {HostServices} from '../packages/cli/dist/host-services.js';
import {HostStore,SCHEMA_VERSION,ConversationRuntime,GroupConversationRuntime} from '../packages/hub/dist/index.js';
import {campaignLab,campaignEvidence,campaignSDKProbe,historicalBaseline} from './fixtures/portable-campaign-assets.mjs';
const {hub:{HostStore:Hub14Store}}=await historicalBaseline();
import {APPROVAL_POLICY_SCOPE_VERSION} from '../packages/contracts/dist/index.js';
import {createHostApp} from '../packages/hub/dist/http-routes.js';
import {ContextHost,FixtureMemoryAdapter,groupAudienceForTurn} from '../packages/context/dist/index.js';
import {AuthorityCoordinator,LocalAuthorityController,openCheckpointArtifact,checkFullSchema,captureInspectionSnapshot,restoreForInspection} from '../packages/operations/dist/index.js';
import {validateGroups,GROUP_COUNT_TABLES} from '../packages/operations/dist/groups.js';
const lab=()=>campaignLab('groups-completion');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const config=(s,ids,key,name='Synthetic Group',rev=0,history=[])=>({expectedHostId:s.hostId,clientRequestId:key,expectedRevision:rev,name,botIds:ids,historyBotIds:history});
const conv=(s,g,key)=>s.groups.createConversation(g.id,{expectedHostId:s.hostId,clientRequestId:key,expectedRevision:g.revision}).result;
const send=(s,g,key)=>({expectedHostId:s.hostId,clientRequestId:key,expectedRevision:g.revision,content:'Synthetic question '+key,recipients:{kind:'all'}});
const custody=()=>{const keys=generateKeyPairSync('ed25519'),secret=createSecretKey(randomBytes(32));return {owner:{publicKey:keys.publicKey,sign:m=>sign(null,m,keys.privateKey)},key:{keyId:'groups-synthetic-memory-key',use:fn=>fn(secret)}};};
const evidence={syntheticOnly:true,accounts:false,inference:false,effects:[]};
function fake(s,id,calls){return {id,capabilities:{resume:false,fork:false,interrupt:true,steer:false},async status(){return {engine:id,installed:true,version:'synthetic',authentication:'unknown',billing:'subscription'}},async open(threadId,cursor){calls.push({kind:'open',threadId,cursor});return {threadId,nativeCursor:'SYNTHETIC_'+id}},async *turn(session,turnId,input){calls.push({kind:'turn',turnId,botId:s.store.getTurn(turnId).botId,engine:id,input});yield {type:'text.delta',threadId:session.threadId,turnId,text:'Distinct actual actor '+id};yield {type:'turn.completed',threadId:session.threadId,turnId,usage:{}}},async respondToTool(){},async interrupt(){},async close(){}}}

test('actual HostServices default Groups, two different actors, explicit audience excludes private core/skills/notes/native cursor',async()=>{
 const root=lab(),calls=[],inspections=[],privateIDs=[];let s;
 s=new HostServices({dataDir:join(root,'host'),enableEngines:true,enableMcp:true,enableWorkspaceTools:false,engineCatalog:()=>['claude','codex'].map(id=>({id,available:true,models:[],defaultModel:null,reasoningEfforts:[],speeds:[]})),makeDriver:(id,native)=>{
  const actor=fake(s,id,calls),original=actor.turn;actor.turn=async function*(session,turnId,input){
   const audience=groupAudienceForTurn(s.store,turnId);
   if(audience){const token=s.context.issue(turnId);try{
     assert.equal(s.context.memoryServiceAuthority(token).audience,'group');assert.equal(s.context.isPrivateMemoryTurn(turnId),false);assert.deepEqual(s.context.skills(token),[]);assert.deepEqual(await s.context.recall(token,{query:'PRIVATE',locale:'pt-BR'}),[]);
     assert.throws(()=>s.context.botDocuments(token));assert.throws(()=>s.context.createArtifact(token,'PRIVATE_NOTE','fixture'));
     inspections.push({engine:id,audience,cwd:native.cwd});
   }finally{s.context.revoke(token)}}
   yield* original.call(this,session,turnId,input);
  };return actor;
 }});
 try{
  const bots=['claude','codex'].map(engine=>s.store.createBot({name:'Actor '+engine,profileId:'synthetic-'+engine,engine}));
  for(const b of bots){s.context.compareAndSetBotDocuments(b.id,{expectedRevision:0,soul:'PRIVATE_SOUL_SENTINEL',user:'PRIVATE_USER_SENTINEL',memory:'PRIVATE_MEMORY_SENTINEL'});const t=s.store.createThread(b.id);privateIDs.push(t.id);const turn=s.store.createTurn(t.id,{clientRequestId:'private-'+b.id,content:'PRIVATE_INPUT_SENTINEL'}).turn;s.store.claimNextTurn(t.id);s.store.appendTurnDelta(turn.id,'PRIVATE_OLD_RESULT_SENTINEL');s.store.finishTurn(turn.id,'completed',null,'PRIVATE_NATIVE_CURSOR_SENTINEL');}
  s.context.activateSkill({kind:'global'},s.context.registerSkill('private_skill','1.0.0','PRIVATE_SKILL_SENTINEL'));s.context.createMemory({scope:{kind:'global'},locale:'pt-BR',markdown:'PRIVATE_NOTES_SENTINEL',origin:'fixture',classification:'context'});
  const g=s.store.groups.create(config(s.store,bots.map(b=>b.id),'create')).result,c=conv(s.store,g,'conversation');const d=s.groups.send(c.id,send(s.store,g,'round'));
  assert.equal((await s.groups.wait(d.id)).state,'completed');const outputs=s.store.groups.messages(c.id).filter(m=>m.origin==='bot');assert.deepEqual(outputs.map(m=>m.authorBotId).sort(),bots.map(b=>b.id).sort());for(const bot of bots)assert.equal(outputs.find(m=>m.authorBotId===bot.id).content,'Distinct actual actor '+bot.engine);
  assert.equal(inspections.length,2);const opens=calls.filter(c=>c.kind==='open');assert.equal(opens.length,2);assert.ok(opens.every(c=>c.cursor===undefined));assert.ok(calls.filter(c=>c.kind==='turn').every(c=>c.input.includes('GROUP AUDIENCE:')&&!c.input.includes('PRIVATE_')));
  const second=s.groups.send(c.id,send(s.store,g,'round2'));await s.groups.wait(second.id);assert.equal(new Set(calls.filter(c=>c.kind==='open').map(c=>c.threadId)).size,4);
  for(const recipient of s.groups.get(second.id).recipients){const lane=s.store.getThread(recipient.threadId);assert.equal(lane.audience,'group');assert.equal(lane.groupId,g.id);assert.throws(()=>s.store.listMessages(lane.id),e=>e.code==='forbidden');assert.throws(()=>s.store.liveVoiceHistory(lane.id),e=>e.code==='forbidden');}
  assert.deepEqual(s.store.listEvents(0,500).filter(e=>e.kind==='thread.created').map(e=>e.threadId).sort(),privateIDs.sort());
  const raw=new DatabaseSync(s.store.databasePath,{readOnly:true});try{for(const recipient of s.groups.get(second.id).recipients){const turn=s.store.getTurn(recipient.turnId);assert.equal(raw.prepare('SELECT content FROM messages WHERE id=?').get(turn.inputMessageId).content,'Synthetic question round2');}}finally{raw.close()}
  const db=new DatabaseSync(s.store.databasePath,{readOnly:true});try{checkFullSchema(db,'hub');validateGroups(db,s.store.hostId);}finally{db.close()}
  await s.shutdown();s=new HostServices({dataDir:join(root,'host'),enableEngines:true,enableMcp:true,enableWorkspaceTools:false,makeDriver:id=>fake(s,id,[])});assert.equal(s.groups.get(second.id).state,'completed');assert.equal(s.store.getThread(s.groups.get(second.id).recipients[0].threadId).audience,'group');for(const bot of bots)assert.deepEqual(s.store.listPrivateThreads(bot.id).map(t=>t.id),privateIDs.filter(id=>s.store.getThread(id).botId===bot.id));
  evidence.effects.push({test:'HostServices-actors-and-audience',authors:outputs.map(m=>m.authorBotId),engines:['claude','codex'],groupTurns:4,privateSentinelsAbsent:true,freshNativeLanes:4});
 }finally{await s.shutdown()}
});

test('native Swift SDK talks to real loopback HostServices: four next pages and GET-only create/send lost ACK',async()=>{
 const root=lab();let s;const calls=[];s=new HostServices({dataDir:join(root,'host'),enableEngines:true,enableMcp:true,enableWorkspaceTools:false,makeDriver:id=>fake(s,id,calls)});
 const bot=s.store.createBot({name:'Synthetic API bot',profileId:'native-sdk',engine:'claude'}),groups=[];
 for(let i=0;i<55;i++)groups.push(s.store.groups.create(config(s.store,[bot.id],'group-'+i)).result);
 const privateThread=s.store.createThread(bot.id);s.store.appendMessage(privateThread.id,{clientMessageId:'private-only',content:'PRIVATE_ONE_TO_ONE_ONLY'});
 const g=groups[0],conversations=[];for(let i=0;i<55;i++)conversations.push(conv(s.store,g,'conversation-'+i));const c=conversations[0];for(let i=0;i<55;i++)s.store.groups.send(c.id,send(s.store,g,'dispatch-'+i));
 const app=createHostApp(s.store,{runtime:s.runtime,groups:s.groups,teams:s.teamsHttp,engineCatalog:s.engineCatalog,skills:s.skillsHttp,botDocuments:s.botDocumentsHttp});const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});await new Promise(r=>server.listening?r():server.once('listening',r));
 const address=server.address(),url='http://127.0.0.1:'+address.port;
 const other=new HostServices({dataDir:join(root,'other-host'),enableEngines:true,enableMcp:true,enableWorkspaceTools:false,makeDriver:id=>fake(other,id,[])});const otherApp=createHostApp(other.store,{runtime:other.runtime,groups:other.groups,teams:other.teamsHttp,engineCatalog:other.engineCatalog});const otherServer=serve({fetch:otherApp.fetch,hostname:'127.0.0.1',port:0});await new Promise(r=>otherServer.listening?r():otherServer.once('listening',r));const otherURL='http://127.0.0.1:'+otherServer.address().port;
 try{
  const invalid=await fetch(url+'/v1/groups?limit=51');assert.equal(invalid.status,400);
  const executable=await campaignSDKProbe('GroupsSDKProbe');assert.ok(existsSync(executable),'compiled actual SDK probe');
  const child=spawn(executable,[url,g.id,c.id,s.store.hostId,bot.id,privateThread.id,otherURL],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const timer=setTimeout(()=>child.kill('SIGTERM'),60000);const code=await new Promise(r=>child.once('close',r));clearTimeout(timer);assert.equal(code,0,output);assert.match(output,/NATIVE_SDK_REAL_HTTP_PASS/);assert.match(output,/NATIVE_APP_PROJECTION_PASS/);
  const d=s.store.groups.sendReceipt(c.id,'swift-lost-send-ack');await s.groups.wait(d.id);assert.equal(s.store.groups.counts().groups,56);assert.equal(s.store.groups.counts().dispatches,56);assert.equal(calls.filter(x=>x.kind==='turn').length,1,'one actual recipient; GET did not replay');
  const created=s.store.groups.receipt('create',s.store.hostId,'swift-lost-create-ack');assert.ok(created);const before=s.store.groups.counts();for(let i=0;i<2;i++){assert.equal((await fetch(url+'/v1/groups/receipts/swift-lost-create-ack')).status,200);assert.equal((await fetch(url+'/v1/group-conversations/'+c.id+'/send-receipts/swift-lost-send-ack')).status,200)}assert.deepEqual(s.store.groups.counts(),before);
  evidence.effects.push({test:'native-SDK-realHTTP-pagination-and-ACK',proof:output.trim(),lists:4,firstPage:50,nextPage:5,afterPositive:true,createSendGETOnly:true,actualDispatchEffects:1});
 }finally{await new Promise(r=>server.close(r));await new Promise(r=>otherServer.close(r));await other.shutdown();await s.shutdown()}
});

test('current Hub complete encrypted backup and authority restore preserve transcript, roster, dispatch input, receipts and queued effects stay held',async()=>{
 const root=lab(),data=join(root,'source');let s;s=new HostServices({dataDir:data,enableEngines:true,enableMcp:true,enableWorkspaceTools:false,makeDriver:id=>fake(s,id,[])});
 const bot=s.store.createBot({name:'Backup bot',profileId:'synthetic-backup',engine:'claude'}),g=s.store.groups.create(config(s.store,[bot.id],'create')).result,c=conv(s.store,g,'conversation');const d=s.groups.send(c.id,send(s.store,g,'done'));await s.groups.wait(d.id);const queued=s.store.groups.send(c.id,send(s.store,g,'never-admitted')).dispatch;
 const expectedMessages=s.store.groups.messages(c.id);const keys=custody(),coordinator=AuthorityCoordinator.open(join(root,'coordinator'),{ownerId:s.store.ownerId,ownerPublicKey:keys.owner.publicKey}),controller=new LocalAuthorityController({coordinator});
 const hold=await controller.quiesce(s),prepared=controller.prepare(hold,{key:keys.key,output:join(root,'checkpoint.dxg8')});const opened=openCheckpointArtifact(prepared.artifact.path,keys.key);assert.equal(opened.manifest.schemas.hub,`hub-v${SCHEMA_VERSION}`);for(const k of Object.keys(GROUP_COUNT_TABLES))assert.ok(Number.isSafeInteger(opened.manifest.counts.hub[k]));
 const artifactDB=join(root,'copied.sqlite');writeFileSync(artifactDB,opened.members.get('hub.sqlite'));let db=new DatabaseSync(artifactDB);try{checkFullSchema(db,'hub');db.prepare("UPDATE group_dispatches SET input_hash=? WHERE id=?").run('0'.repeat(64),d.id);assert.throws(()=>checkFullSchema(db,'hub'),e=>e.code==='reference_broken');}finally{db.close()}
 const dest=join(root,'destination');controller.revokeSource({store:s.store},prepared.checkpointId,dest);const receipt=controller.issueReceipt(keys.owner,prepared.checkpointId);const restored=controller.activate({artifact:prepared.artifact.path,key:keys.key,receipt});assert.equal(restored.epoch,2);assert.equal(controller.activate({artifact:prepared.artifact.path,key:keys.key,receipt}).hub,'already_published');await s.shutdown();coordinator.close();
 let next;const calls=[];next=new HostServices({dataDir:dest,enableEngines:true,enableMcp:true,enableWorkspaceTools:false,makeDriver:id=>fake(next,id,calls)});
 try{assert.deepEqual(next.store.groups.messages(c.id),expectedMessages);assert.deepEqual(next.store.groups.get(g.id),g);assert.equal(next.groups.get(queued.id).state,'held');assert.equal(next.store.groups.receipt('create',next.store.hostId,'create').result.id,g.id);assert.equal(next.store.groups.sendReceipt(c.id,'done').id,d.id);await pause(25);assert.equal(calls.length,0);evidence.effects.push({test:'backup-authority-restore',schema:SCHEMA_VERSION,groupCounts:opened.manifest.counts.hub,transcriptPreserved:true,heldQueue:true,automaticReplay:0,invalidHashRefused:true});}finally{await next.shutdown()}
});

test('frozen actual Hub14 fixture: forward open and historical authority activation retain approval modes and saved type receipts',async()=>{
 const root=lab(),data=join(root,'old14'),old=new Hub14Store({dataDir:data}),bot=old.createBot({name:'Old14',profileId:'synthetic-old',engine:'claude'}),thread=old.createThread(bot.id),turn=old.createTurn(thread.id,{clientRequestId:'origin',content:'Synthetic origin'}).turn;old.claimNextTurn(thread.id);
 old.setBotApprovalPolicy(bot.id,{expectedHostId:old.hostId,clientRequestId:'mode',expectedRevision:0,mode:'accept_edits',eligibleScopeVersion:APPROVAL_POLICY_SCOPE_VERSION});
 old.setThreadApprovalPolicy(thread.id,{expectedHostId:old.hostId,clientRequestId:'chat',expectedRevision:0,overrideMode:'ask'});
 old.setGrant({botId:bot.id,tool:'dexter.harness.terminal.run',destination:'dexter-harness-owner-proposals',policy:'ask'});
 const action=old.requestAction({botId:bot.id,threadId:thread.id,tool:'dexter.harness.terminal.run',destination:'dexter-harness-owner-proposals',idempotencyKey:'synthetic-action',arguments:{input:{runtime:'sh',cwd:'synthetic-only'},pin:{manifestHash:'synthetic',schemaHash:'synthetic',turnId:turn.id}}},'terminal');old.bindToolAction(action.id,turn.id,'call');
 const saved=old.decideApprovalPreference(action.id,{expectedHostId:old.hostId,clientRequestId:'saved-type',requestHash:action.requestHash,decision:'allow',alwaysAccept:true,expectedTypeKey:action.approvalType.key,expectedPreferenceRevision:action.approvalType.revision});old.finishTurn(turn.id,'completed',null);
 const policies=old.getBotApprovalPolicy(bot.id),chat=old.getThreadApprovalPolicy(thread.id),pref=old.getApprovalPreferenceReceipt(bot.id,'saved-type');
 const keys=custody(),coordinator=AuthorityCoordinator.open(join(root,'coord'),{ownerId:old.ownerId,ownerPublicKey:keys.owner.publicKey}),controller=new LocalAuthorityController({coordinator});
 const hold=await controller.quiesce({quiesceForMaintenance:async()=>old}),prepared=controller.prepare(hold,{key:keys.key,output:join(root,'old14.dxg8')});const opened=openCheckpointArtifact(prepared.artifact.path,keys.key);assert.equal(opened.manifest.schemas.hub,'hub-v14');
 const dest=join(root,'restored');controller.revokeSource({store:old},prepared.checkpointId,dest);const receipt=controller.issueReceipt(keys.owner,prepared.checkpointId);controller.activate({artifact:prepared.artifact.path,key:keys.key,receipt});old.close();coordinator.close();
 const current=new HostStore({dataDir:dest});try{assert.equal(current.summary().schemaVersion,SCHEMA_VERSION);assert.deepEqual(current.getBotApprovalPolicy(bot.id),policies);assert.deepEqual(current.getThreadApprovalPolicy(thread.id),chat);assert.deepEqual(current.getApprovalPreferenceReceipt(bot.id,'saved-type'),pref);assert.equal(current.getAction(action.id).authorization.source,'owner_type');assert.equal(current.groups.counts().groups,0);const db=new DatabaseSync(current.databasePath,{readOnly:true});try{assert.equal(checkFullSchema(db,'hub').installationId,current.hostId);assert.equal(db.prepare('SELECT count(*) n FROM approval_type_preferences').get().n,1)}finally{db.close()}evidence.effects.push({test:'real-frozen-Hub14-authority-migration',from:14,to:SCHEMA_VERSION,modesPreserved:true,typeReceiptPreserved:saved.receipt.id,contextSchemaUnchanged:true});}finally{current.close()}
});
campaignEvidence('groups-completion',evidence);

test('removal plus re-entry fences the old generation, stale capability and late output; archive has CAS, receipt and no physical transcript deletion',async()=>{
 const root=lab(),s=new HostStore({dataDir:join(root,'host')}),a=s.createBot({name:'A',profileId:'a',engine:'claude'}),b=s.createBot({name:'B',profileId:'b',engine:'claude'});
 const g=s.groups.create(config(s,[a.id,b.id],'create')).result,c=conv(s,g,'conversation');let release,entered=false,oldTurn,oldToken;const gate=new Promise(r=>release=r),context=new ContextHost(s,new FixtureMemoryAdapter());
 const driver={id:'claude',capabilities:{resume:false},async open(threadId){return {threadId,nativeCursor:'synthetic'}},async *turn(session,turnId){oldTurn=turnId;oldToken=context.issue(turnId);entered=true;await gate;yield {type:'text.delta',threadId:session.threadId,turnId,text:'LATE_OLD_GENERATION_OUTPUT'};yield {type:'turn.completed',threadId:session.threadId,turnId,usage:{}}},async interrupt(){},async close(){}};
 const runtime=new ConversationRuntime({store:s,drivers:[driver],abortGraceMs:25}),groups=new GroupConversationRuntime(s,runtime,3000);
 try{
  const d=groups.send(c.id,{...send(s,g,'late'),recipients:{kind:'one',botId:a.id}});for(let i=0;i<100&&!entered;i++)await pause(5);assert.ok(entered);
  const removed=s.groups.update(g.id,config(s,[b.id],'remove','Synthetic Group',1)).result;assert.throws(()=>context.skills(oldToken));assert.throws(()=>s.groups.assertMemberForTurn(oldTurn,g.id));
  const readded=s.groups.update(g.id,config(s,[a.id,b.id],'readd','Synthetic Group',2)).result;assert.equal(readded.members.find(m=>m.botId===a.id).joinedRevision,3);assert.ok(readded.members.find(m=>m.botId===a.id).visibleAfter>0);assert.throws(()=>context.skills(oldToken));assert.throws(()=>s.groups.assertMemberForTurn(oldTurn,g.id));release();await groups.wait(d.id);assert.equal(groups.get(d.id).recipients[0].state,'revoked');assert.equal(s.groups.messages(c.id).some(m=>m.content.includes('LATE_OLD')),false);context.revoke(oldToken);
  const archive={expectedHostId:s.hostId,clientRequestId:'archive',expectedRevision:readded.revision};const receipt=s.groups.archive(g.id,archive);assert.equal(receipt.operation,'delete');assert.equal(s.groups.archive(g.id,archive).id,receipt.id);assert.equal(s.groups.listPage().items.length,0);assert.equal(s.groups.messages(c.id).length,1);assert.equal(s.groups.get(g.id).archived,true);assert.throws(()=>s.groups.update(g.id,config(s,[a.id],'bad','New',4)));const db=new DatabaseSync(s.databasePath,{readOnly:true});try{checkFullSchema(db,'hub')}finally{db.close()}
  evidence.effects.push({test:'reentry-generation-and-archive',oldGeneration:1,reentryGeneration:3,lateOutputPublished:false,oldCapabilityRevoked:true,archiveCAS:true,transcriptRetained:true});
 }finally{release?.();context.close();await groups.close();await runtime.shutdown({closeStore:false});s.close()}
});

test('plain forward open of exact Hub14 preserves owner policy receipts without approval reset',()=>{
 const root=lab(),data=join(root,'old');let s=new Hub14Store({dataDir:data});const b=s.createBot({name:'Migration policy',profileId:'migration',engine:'claude'}),t=s.createThread(b.id),policy=s.setBotApprovalPolicy(b.id,{expectedHostId:s.hostId,clientRequestId:'mode',expectedRevision:0,mode:'full_access',eligibleScopeVersion:APPROVAL_POLICY_SCOPE_VERSION}),chat=s.setThreadApprovalPolicy(t.id,{expectedHostId:s.hostId,clientRequestId:'chat',expectedRevision:0,overrideMode:'accept_edits'});s.close();s=new HostStore({dataDir:data});try{assert.equal(s.summary().schemaVersion,SCHEMA_VERSION);assert.deepEqual(s.getBotApprovalPolicy(b.id),policy.policy);assert.deepEqual(s.getThreadApprovalPolicy(t.id),chat.state);assert.equal(s.getApprovalPreferenceReceipt(b.id,'chat').id,chat.id);const db=new DatabaseSync(s.databasePath,{readOnly:true});try{checkFullSchema(db,'hub')}finally{db.close()};evidence.effects.push({test:'plain-Hub14-forward-open',to:SCHEMA_VERSION,ownerModesPreserved:true,receiptRetained:true})}finally{s.close()}
});

test('actual HostServices owned delegation descendant receives explicit Group audience and never its private documents or skills',async()=>{
 const root=lab(),calls=[],observations=[];let s,parent,child;
 s=new HostServices({dataDir:join(root,'host'),enableEngines:true,enableMcp:true,enableBotDelegation:true,enableWorkspaceTools:false,makeDriver:(id)=>{
  const actor=fake(s,id,calls),original=actor.turn;actor.turn=async function*(session,turnId,input){const audience=groupAudienceForTurn(s.store,turnId);if(audience){const token=s.context.issue(turnId);try{assert.equal(s.context.isPrivateMemoryTurn(turnId),false);assert.deepEqual(s.context.skills(token),[]);assert.throws(()=>s.context.botDocuments(token));assert.equal(s.context.memoryServiceAuthority(token).audience,'group');observations.push({botId:s.store.getTurn(turnId).botId,recipientId:audience.recipientId});}finally{s.context.revoke(token)}}if(s.store.getTurn(turnId).botId===parent.id)await s.botDelegation.delegate(turnId,'synthetic-child',{targetBotId:child.id,task:'Explicit bounded synthetic Group child'});yield* original.call(this,session,turnId,input)};return actor;
 }});
 try{
  parent=s.store.createBot({name:'Parent',profileId:'parent',engine:'claude'});parent=s.store.patchBot(parent.id,{expectedRevision:parent.revision,canSeeBots:true,canSendActions:true});child=s.store.createBot({name:'Outside Group child',profileId:'child',engine:'codex'});child=s.store.patchBot(child.id,{expectedRevision:child.revision,canReceiveOrders:true});
  s.context.compareAndSetBotDocuments(child.id,{expectedRevision:0,soul:'PRIVATE_CHILD_SOUL_SENTINEL',user:'PRIVATE_CHILD_USER_SENTINEL',memory:'PRIVATE_CHILD_MEMORY_SENTINEL'});s.context.activateSkill({kind:'global'},s.context.registerSkill('private_child_skill','1.0.0','PRIVATE_CHILD_SKILL_SENTINEL'));
  const g=s.store.groups.create(config(s.store,[parent.id],'create')).result,c=conv(s.store,g,'conversation'),d=s.groups.send(c.id,send(s.store,g,'owned-chain'));const done=await s.groups.wait(d.id);assert.equal(done.state,'completed');assert.equal(observations.length,2);assert.deepEqual(observations.map(x=>x.botId).sort(),[parent.id,child.id].sort());assert.equal(new Set(observations.map(x=>x.recipientId)).size,1);assert.ok(calls.filter(x=>x.kind==='turn').every(x=>!x.input.includes('PRIVATE_CHILD_')));assert.equal(s.store.groups.messages(c.id).filter(m=>m.origin==='bot')[0].authorBotId,parent.id);
  evidence.effects.push({test:'actual-owned-descendant-audience',parentAndChildContextChecks:2,outsideMemberPrivateCoreBlocked:true,recipientCorrelationPreserved:true});
 }finally{await s.shutdown()}
});
