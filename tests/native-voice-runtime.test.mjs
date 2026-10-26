import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash,generateKeyPairSync,createSecretKey,randomBytes,sign} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {serve} from '@hono/node-server';
import {HostServices} from '../packages/cli/dist/host-services.js';
import {HostStore,ConversationRuntime,NativeVoiceRuntime} from '../packages/hub/dist/index.js';
import {createHostApp} from '../packages/hub/dist/http-routes.js';
import {CodexNativeVoiceBackend} from '../packages/engines/dist/index.js';
import {LocalAuthorityController,AuthorityCoordinator,openCheckpointArtifact,checkFullSchema} from '../packages/operations/dist/index.js';
import {readAppConfigurationGuidePage,readHarnessGuideTopic} from '../packages/context/dist/index.js';
import {campaignLab,campaignEvidence,campaignSDKProbe} from './fixtures/portable-campaign-assets.mjs';
const lab=()=>campaignLab('native-voice');
const node=process.execPath;
const fixture=fileURLToPath(new URL('./fixtures/codex-native-voice-fixture.mjs',import.meta.url));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+5000;while(Date.now()<end){const value=fn();if(value)return value;await pause(10);}throw new Error(label);}
const evidence={syntheticOnly:true,accounts:false,inference:false,microphone:false,effects:[]};
campaignEvidence('native-voice',evidence);
const records=file=>{try{return readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));}catch{return[];}};
const backend=(root,mode='normal')=>new CodexNativeVoiceBackend({command:node,prefixArgs:[fixture,'--fixture-mode',mode,'--record',join(root,'rpc.jsonl')],cwd:root,requestTimeoutMs:1000,killGraceMs:10},join(root,'schema'));
function fake(s,id,calls=[],held=false) {return {id,capabilities:{resume:false,fork:false,interrupt:true,steer:false},async status(){return {engine:id,installed:true,version:'synthetic',authentication:'unknown',billing:'subscription'};},async open(threadId){return {threadId,nativeCursor:'synthetic_canonical'};},async *turn(session,turnId,input,signal){calls.push(turnId);if(held)await new Promise(r=>signal.aborted?r():signal.addEventListener('abort',r,{once:true}));yield signal.aborted?{type:'turn.interrupted',threadId:session.threadId,turnId}:{type:'text.delta',threadId:session.threadId,turnId,text:'Canonical Host reply'};if(!signal.aborted)yield {type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},async respondToTool(){},async interrupt(){},async close(){}};}
function setup(root,b,calls=[],held=false){let s;s=new HostServices({dataDir:join(root,'data'),enableEngines:true,enableMcp:true,enableWorkspaceTools:false,nativeVoiceBackend:b,makeDriver:id=>fake(s,id,calls,held)});const bot=s.store.createBot({name:'Voice actor',profileId:'synthetic',engine:'codex'}),thread=s.store.createThread(bot.id);return {s,bot,thread};}
const request=(s,b,t,key='start',extra={})=>({expectedHostId:s.hostId,expectedBotId:b.id,expectedBotRevision:b.revision,expectedSelectionRevision:s.getThreadEngineSelection(t.id).revision,clientRequestId:key,expectedRevision:0,sessionId:randomUUID(),generation:randomUUID(),sdpOffer:'v=0\nSYNTHETIC_PRIVATE_OFFER',voice:'cove',...extra});
const stop=(s,key='stop')=>({expectedHostId:s.hostId,expectedBotId:s.botId,generation:s.generation,clientRequestId:key,expectedRevision:s.revision});
const json=(method,body)=>({method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const rawJournal=store=>{const db=new DatabaseSync(store.databasePath,{readOnly:true});try{return db.prepare("SELECT value FROM meta WHERE key='native_voice_journal_v1'").get()?.value??'';}finally{db.close();}};

test('actual synthetic stdio RPC + HostServices canonical turn: exact handoff text, native denial, author reply and no raw media persistence',async()=>{
 const root=lab(),calls=[],{s,bot,thread}=setup(root,backend(root,'handoff'),calls);
 try{
   const status=await s.nativeVoice.status(thread.id);assert.equal(status.supported,true);assert.equal(status.authentication,'unknown');assert.equal(records(join(root,'rpc.jsonl')).filter(x=>x.kind==='account_gate').length,0);
   const start=request(s.store,bot,thread),result=await s.nativeVoice.start(thread.id,start);assert.equal(result.session.state,'active');assert.equal(s.nativeVoice.exchange(start.sessionId,s.store.hostId,start.generation).sdpAnswer,'v=0\nSYNTHETIC_PRIVATE_ANSWER');
   await until(()=>records(join(root,'rpc.jsonl')).some(x=>x.kind==='speech'),'speech');assert.equal(calls.length,1);
   const turn=s.store.getTurn(calls[0]);assert.equal(turn.botId,bot.id);assert.equal(turn.threadId,thread.id);assert.equal(s.store.listMessages(thread.id)[0].content,'Canonical spoken request','uses handoff input_transcript, not previous greeting');assert.equal(turn.state,'completed');
   const r=records(join(root,'rpc.jsonl'));assert.ok(r.some(x=>x.kind==='initialize'&&x.experimental));assert.ok(r.some(x=>x.kind==='fresh_native_thread'&&x.ambientDisabled&&x.sandbox==='read-only'&&x.approvalPolicy==='untrusted'));assert.ok(r.some(x=>x.kind==='native_denial'&&x.id==='native_command'&&x.decision==='decline'));assert.ok(r.some(x=>x.kind==='native_denial'&&x.id==='native_dynamic'&&x.success===false));assert.ok(r.some(x=>x.kind==='native_interrupted'));assert.equal(r.find(x=>x.kind==='speech').textHash,createHash('sha256').update('Canonical Host reply').digest('hex'));
   const current=s.nativeVoice.get(start.sessionId);const stopped=await s.nativeVoice.stop(start.sessionId,stop(current));assert.equal(stopped.session.state,'closed');
   const exported=JSON.stringify([s.nativeVoice.events(start.sessionId),rawJournal(s.store),s.store.listEvents(0,500)]);
   for(const value of ['SYNTHETIC_PRIVATE_OFFER','SYNTHETIC_PRIVATE_ANSWER','SYNTHETIC_AUDIO_NEVER_STORE','SYNTHETIC_PROVIDER_DETAIL_NEVER_EXPOSE'])assert.ok(!exported.includes(value));
   assert.equal(s.nativeVoice.receipt(thread.id,'start').session.state,'closed');assert.equal((await s.nativeVoice.start(thread.id,start)).session.state,'closed','no start replay');assert.equal(records(join(root,'rpc.jsonl')).filter(x=>x.kind==='start').length,1);
   const db=new DatabaseSync(s.store.databasePath,{readOnly:true});try{checkFullSchema(db,'hub');}finally{db.close()}
   evidence.effects.push({test:'stdio-HostServices',canonicalTurns:calls.length,exactNativeHandoff:true,nativeCommandDenied:true,nativeDynamicDenied:true,nativeTurnInterrupted:true,rawMediaPersisted:false,experimental:true});
 }finally{await s.shutdown()}
});

test('owner HTTP exact CAS, GET-only lost ACK, current scope revocation, private audience and safe provider failures',async()=>{
 const root=lab(),{s,bot,thread}=setup(root,backend(root));const app=createHostApp(s.store,{runtime:s.runtime,nativeVoice:s.nativeVoice,groups:s.groups});
 try{
   const body=request(s.store,bot,thread);const response=await app.request('http://127.0.0.1/v1/threads/'+thread.id+'/native-voice/start',json('POST',body));assert.equal(response.status,201);assert.equal((await response.json()).session.state,'active');
   const receipt=await app.request('http://127.0.0.1/v1/threads/'+thread.id+'/native-voice/receipts/start');assert.equal(receipt.status,200);assert.equal((await receipt.json()).session.id,body.sessionId);
   assert.equal((await app.request('http://foreign.invalid/v1/native-voice/sessions/'+body.sessionId)).status,403);
   const x=await app.request('http://127.0.0.1/v1/native-voice/sessions/'+body.sessionId+'/exchange?expectedHostId='+s.store.hostId+'&generation='+body.generation);assert.equal(x.headers.get('cache-control'),'no-store');assert.equal(x.status,200);
   const changed={...body,sdpOffer:'v=0\nDIFFERENT'};assert.equal((await app.request('http://127.0.0.1/v1/threads/'+thread.id+'/native-voice/start',json('POST',changed))).status,409);
   assert.equal((await app.request('http://127.0.0.1/v1/native-voice/sessions/'+body.sessionId+'/stop',json('POST',stop({...s.nativeVoice.get(body.sessionId),generation:randomUUID()})))).status,403);
   s.store.patchBot(bot.id,{expectedRevision:bot.revision,name:'Changed voice actor'});assert.equal(s.nativeVoice.get(body.sessionId).code,'scope_changed');assert.throws(()=>s.nativeVoice.exchange(body.sessionId,s.store.hostId,body.generation),e=>e.code==='not_found');
   const team=s.store.createTeamThread(bot.id,'team_synthetic','synthetic_team'),status=await s.nativeVoice.status(team.id);assert.equal(status.supported,false);await assert.rejects(s.nativeVoice.start(team.id,request(s.store,s.store.getBot(bot.id),team,'team')),e=>e.code==='forbidden');
   const group=s.store.groups.create({expectedHostId:s.store.hostId,clientRequestId:'group',expectedRevision:0,name:'Synthetic group',botIds:[bot.id],historyBotIds:[]}).result,conversation=s.store.groups.createConversation(group.id,{expectedHostId:s.store.hostId,clientRequestId:'conversation',expectedRevision:1}).result,dispatch=s.groups.send(conversation.id,{expectedHostId:s.store.hostId,clientRequestId:'group-turn',expectedRevision:1,content:'Group question',recipients:{kind:'all'}});await s.groups.wait(dispatch.id);const lane=s.groups.get(dispatch.id).recipients[0].threadId;assert.equal((await s.nativeVoice.status(lane)).supported,false);await assert.rejects(s.nativeVoice.start(lane,request(s.store,s.store.getBot(bot.id),s.store.getThread(lane),'group-voice')),e=>e.code==='forbidden');
   assert.equal(records(join(root,'rpc.jsonl')).filter(x=>x.kind==='start').length,1);
 }finally{await s.shutdown()}
 for(const [mode,code] of [['old','native_voice_unsupported'],['auth','auth_needed'],['error','provider_failed']]){
   const root2=lab(),v=setup(root2,backend(root2,mode));try{const r=await v.s.nativeVoice.start(v.thread.id,request(v.s.store,v.bot,v.thread));assert.equal(r.session.code,code);assert.ok(!JSON.stringify(v.s.nativeVoice.events(r.session.id)).includes('SYNTHETIC_PROVIDER_DETAIL'));if(mode==='old')assert.equal(records(join(root2,'rpc.jsonl')).filter(x=>x.kind==='account_gate').length,0);}finally{await v.s.shutdown()}
 }
 evidence.effects.push({test:'HTTP-scope-and-failure',lostACKReadOnly:true,CAS:true,botRevisionRevokes:true,teamAndGroupBlocked:true,codes:['native_voice_unsupported','auth_needed','provider_failed']});
});

test('voice handoff action runs only on real canonical Host turn and retains exact owner approval/dispatcher receipt',async()=>{
 const root=lab(),store=new HostStore({dataDir:join(root,'data')}),bot=store.createBot({name:'Action voice',profileId:'synthetic',engine:'codex'}),thread=store.createThread(bot.id);let emit,effects=0,spoken=0;
 const b={async capabilities(){return {supported:true,voices:['cove'],cliVersion:'synthetic'};},async start(_,cb){emit=cb;cb({kind:'sdp',sdp:'v=0\nSYNTHETIC'});cb({kind:'started'});return {async speech(){spoken++;},async text(){},async stop(){},async close(){}};}};
 const driver={id:'codex',capabilities:{resume:false},async open(threadId){return {threadId,nativeCursor:'synthetic'};},async *turn(session,turnId){yield {type:'tool.request',threadId:session.threadId,turnId,request:{botId:bot.id,threadId:thread.id,tool:'synthetic.write',destination:'synthetic',arguments:{target:'owned-fixture'},idempotencyKey:'speech-effect'}};yield {type:'text.delta',threadId:session.threadId,turnId,text:'Approved canonical result'};yield {type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},async respondToTool(){},async interrupt(){},async close(){}};
 store.setGrant({botId:bot.id,tool:'synthetic.write',destination:'synthetic',policy:'ask'});
 const runtime=new ConversationRuntime({store,drivers:[driver],executor:async()=>{effects++;return {synthetic:true};},approvalPollMs:5,abortGraceMs:50}),voice=new NativeVoiceRuntime(store,runtime,b),app=createHostApp(store,{runtime,nativeVoice:voice});
 try{const start=request(store,bot,thread);await voice.start(thread.id,start);emit({kind:'handoff',handoffId:'approved_handoff',text:'Owner spoken request'});const action=await until(()=>store.listActions('awaiting_approval')[0],'canonical approval');assert.equal(effects,0);assert.equal(spoken,0);const turns=runtime.listTurns(thread.id);assert.equal(turns.length,1);assert.ok(runtime.listTurnEvents({turnId:turns[0].id}).some(e=>e.kind==='tool.requested'&&e.data.actionId===action.id));
  const response=await app.request('http://127.0.0.1/v1/actions/'+action.id+'/decisions',json('POST',{decision:'allow',requestHash:action.requestHash}));assert.equal(response.status,200);await runtime.waitForTurn(turns[0].id);await until(()=>spoken===1,'only approved reply spoken');assert.equal(effects,1);assert.equal(store.getAction(action.id).state,'succeeded');emit({kind:'handoff',handoffId:'approved_handoff',text:'Owner spoken request'});await pause(10);assert.equal(effects,1);assert.equal(runtime.listTurns(thread.id).length,1);evidence.effects.push({test:'canonical-action',turnId:turns[0].id,actionId:action.id,exactApproval:true,effects,spoken,duplicateReplay:0});
 }finally{await voice.close();await runtime.shutdown()}
});

test('Stop cancels only call-owned canonical turns; stale/missing handoff and backend silence fail closed',async()=>{
 const root=lab(),calls=[];let emit,closeCount=0;
 const b={async capabilities(){return {supported:true,voices:['cove'],cliVersion:'synthetic'};},async start(_,cb){emit=cb;cb({kind:'sdp',sdp:'v=0\nSYNTHETIC'});cb({kind:'started'});return {async speech(){},async text(){},async stop(){},async close(){closeCount++;}};}};
 const {s,bot,thread}=setup(root,b,calls,true);
 try{const unrelated=s.store.createThread(bot.id),outside=s.runtime.startTurn(unrelated.id,{clientRequestId:'outside',content:'Unrelated work'}).turn;await until(()=>s.store.getTurn(outside.id).state==='running','outside running');const start=request(s.store,bot,thread);await s.nativeVoice.start(thread.id,start);emit({kind:'handoff',handoffId:'owned',text:'Owned request'});await until(()=>s.nativeVoice.events(start.sessionId).items.find(e=>e.kind==='turn'&&e.turnId),'owned turn');const own=s.runtime.listTurns(thread.id)[0];await s.nativeVoice.stop(start.sessionId,stop(s.nativeVoice.get(start.sessionId)));await s.runtime.waitForTurn(own.id);assert.equal(s.store.getTurn(own.id).state,'interrupted');assert.equal(s.store.getTurn(outside.id).state,'running');assert.equal(closeCount,1);s.runtime.cancelTurn(outside.id);await s.runtime.waitForTurn(outside.id);emit({kind:'handoff',handoffId:'late',text:'Late request'});assert.equal(s.runtime.listTurns(thread.id).length,1);
  const next=request(s.store,bot,thread,'next');await s.nativeVoice.start(thread.id,next);emit({kind:'handoff',handoffId:'missing'});assert.equal(s.nativeVoice.get(next.sessionId).code,'handoff_missing_transcript');assert.equal(s.runtime.listTurns(thread.id).length,1);evidence.effects.push({test:'owned-stop',outsidePreserved:true,lateTurnAdmitted:false,missingHandoffRejected:true});
 }finally{await s.shutdown()}
});

test('full encrypted checkpoint/authority restore retain safe voice receipts and never SDP or automatic realtime replay',async()=>{
 const root=lab(),v=setup(root,backend(root));await v.s.nativeVoice.patchPreference(v.bot.id,{expectedHostId:v.s.store.hostId,expectedBotId:v.bot.id,expectedBotRevision:v.bot.revision,expectedRevision:0,clientRequestId:'backup-preference',voice:'cove'});const start=request(v.s.store,v.bot,v.thread),r=await v.s.nativeVoice.start(v.thread.id,start);await v.s.nativeVoice.stop(r.session.id,stop(v.s.nativeVoice.get(r.session.id)));
 const keys=generateKeyPairSync('ed25519'),secret=createSecretKey(randomBytes(32)),key={keyId:'synthetic-memory-key',use:fn=>fn(secret)},owner={publicKey:keys.publicKey,sign:m=>sign(null,m,keys.privateKey)},coordinator=AuthorityCoordinator.open(join(root,'coord'),{ownerId:v.s.store.ownerId,ownerPublicKey:keys.publicKey}),controller=new LocalAuthorityController({coordinator});
 const hold=await controller.quiesce(v.s),prepared=controller.prepare(hold,{key,output:join(root,'voice.dxg8')}),opened=openCheckpointArtifact(prepared.artifact.path,key),copy=join(root,'artifact.sqlite');writeFileSync(copy,opened.members.get('hub.sqlite'));const db=new DatabaseSync(copy,{readOnly:true});try{checkFullSchema(db,'hub');const journal=db.prepare("SELECT value FROM meta WHERE key='native_voice_journal_v1'").get().value;assert.equal(JSON.parse(journal).receipts.length,2);for(const sentinel of ['SYNTHETIC_PRIVATE_OFFER','SYNTHETIC_PRIVATE_ANSWER','SYNTHETIC_PROVIDER_DETAIL','SYNTHETIC_AUDIO'])assert.ok(!journal.includes(sentinel));}finally{db.close()}
 const dest=join(root,'restored');controller.revokeSource({store:v.s.store},prepared.checkpointId,dest);const receipt=controller.issueReceipt(owner,prepared.checkpointId);controller.activate({artifact:prepared.artifact.path,key,receipt});await v.s.shutdown();coordinator.close();
 let starts=0;const next=new HostServices({dataDir:dest,enableEngines:true,enableMcp:true,enableWorkspaceTools:false,nativeVoiceBackend:{async capabilities(){return {supported:true,voices:['cove'],cliVersion:'synthetic'};},async start(){starts++;throw new Error();}},makeDriver:id=>fake(next,id)});
 try{assert.equal(next.nativeVoice.preference(v.bot.id).voice,'cove');assert.equal(next.nativeVoice.preferenceReceipt(v.bot.id,'backup-preference').preference.revision,1);assert.equal(next.nativeVoice.receipt(v.thread.id,'start').session.state,'closed');assert.equal(next.nativeVoice.receipt(v.thread.id,'stop').session.state,'closed');assert.throws(()=>next.nativeVoice.exchange(start.sessionId,next.store.hostId,start.generation),e=>e.code==='not_found');assert.equal(starts,0);evidence.effects.push({test:'encrypted-backup-restore',receiptCount:2,preferenceRestored:true,noSDP:true,automaticReplay:starts,schema:opened.manifest.schemas.hub});}finally{await next.shutdown()}
});

test('actual compiled Swift SDK -> real owner HTTP, lost start/stop ACK uses GET only; positive event cursor and exchange decoding',async()=>{
 const root=lab(),v=setup(root,backend(root,'handoff')),app=createHostApp(v.s.store,{runtime:v.s.runtime,nativeVoice:v.s.nativeVoice});const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port;
 try{const executable=await campaignSDKProbe('NativeVoiceSDKProbe');const child=spawn(executable,[url,v.thread.id,v.s.store.hostId,v.bot.id],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.resume();const exit=await new Promise((resolve,reject)=>{let timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('Owned Swift SDK probe timed out'));},60000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);resolve(code);});});assert.equal(exit,0,output);assert.ok(output.includes('NATIVE_VOICE_SDK_REAL_HTTP_PASS'));assert.equal(records(join(root,'rpc.jsonl')).filter(r=>r.kind==='start').length,1);assert.equal(records(join(root,'rpc.jsonl')).filter(r=>r.kind==='stop').length,1);evidence.effects.push({test:'native-SDK-realHTTP',proof:output.trim(),startEffects:1,stopEffects:1,receiptGETOnly:true});}finally{await new Promise(r=>server.close(r));await v.s.shutdown()}
});

test('persisted per-bot native preference has own CAS/receipt; active voice stays captured and next call inherits; history pages duration and transcript refs',async()=>{
 const root=lab(),store=new HostStore({dataDir:join(root,'data')}),bot=store.createBot({name:'Preference voice',profileId:'synthetic',engine:'codex'}),thread=store.createThread(bot.id),runtime=new ConversationRuntime({store,drivers:[]});let time=100000,voices=[];
 const backend={async capabilities(){return {supported:true,voices:['cove','juniper'],cliVersion:'synthetic'};},async start(input,emit){voices.push(input.voice??null);emit({kind:'sdp',sdp:'v=0\nSYNTHETIC'});emit({kind:'started'});return {async speech(){},async text(){},async stop(){},async close(){}};}};
 const voice=new NativeVoiceRuntime(store,runtime,backend,()=>time),app=createHostApp(store,{runtime,nativeVoice:voice});
 try{assert.equal(voice.preference(bot.id).voice,null);let input=request(store,bot,thread);delete input.voice;await voice.start(thread.id,input);const first=voice.get(input.sessionId);assert.equal(first.voice,null);
  const patch={expectedHostId:store.hostId,expectedBotId:bot.id,expectedBotRevision:bot.revision,expectedRevision:0,clientRequestId:'choose-cove',voice:'cove'};assert.equal((await app.request('http://127.0.0.1/v1/bots/'+bot.id+'/native-voice/preferences',json('PATCH',patch))).status,200);assert.equal(voice.preferenceReceipt(bot.id,'choose-cove').preference.voice,'cove');assert.equal((await voice.patchPreference(bot.id,patch)).preference.revision,1);assert.equal(store.getBot(bot.id).revision,bot.revision);assert.equal(voice.get(first.id).voice,null);assert.equal(voice.get(first.id).state,'active');
  await assert.rejects(voice.patchPreference(bot.id,{...patch,voice:'juniper'}),e=>e.code==='conflict');await assert.rejects(voice.patchPreference(bot.id,{...patch,clientRequestId:'stale'}),e=>e.code==='conflict');
  time+=8000;await voice.stop(first.id,stop(voice.get(first.id)));input=request(store,bot,thread,'next-call');delete input.voice;await voice.start(thread.id,input);assert.equal(voice.get(input.sessionId).voice,'cove');await voice.stop(input.sessionId,stop(voice.get(input.sessionId),'next-stop'));assert.deepEqual(voices,[null,'cove']);
  const page=voice.history(thread.id,0,1);assert.equal(page.items[0].durationMs,8000);assert.ok(page.nextCursor>0);const next=voice.history(thread.id,page.nextCursor,1);assert.equal(next.items.length,1);assert.equal(next.nextCursor,null);assert.equal(next.items[0].session.voice,'cove');const db=new DatabaseSync(store.databasePath,{readOnly:true});try{checkFullSchema(db,'hub');}finally{db.close()}
  evidence.effects.push({test:'preferences-history',nilDefault:true,CAS:true,GETReceipt:true,activeVoiceUnchanged:true,nextVoice:'cove',botEngineRevisionUnchanged:true,firstDurationMs:8000,positiveHistoryCursor:true});
 }finally{await voice.close();await runtime.shutdown()}
});

test('owned synthetic host crash -> actual reopen keeps start receipt unknown and never starts backend or recovers SDP',async()=>{
 const root=lab(),data=join(root,'data'),worker=fileURLToPath(new URL('./fixtures/native-voice-crash-worker.mjs',import.meta.url)),child=spawn(node,[worker,data],{stdio:['ignore','pipe','pipe']});let text='';child.stdout.on('data',b=>text+=b);child.stderr.resume();await until(()=>text.includes('\n'),'worker active');const pin=JSON.parse(text.trim());const exited=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await exited;let effects=0;
 const backend={async capabilities(){return {supported:true,voices:['cove'],cliVersion:'synthetic'};},async start(){effects++;throw new Error();}};let s;s=new HostServices({dataDir:data,enableEngines:true,nativeVoiceBackend:backend,makeDriver:id=>fake(s,id)});
 try{assert.equal(s.nativeVoice.get(pin.sessionId).state,'unknown');assert.equal(s.nativeVoice.receipt(pin.threadId,'crash-start').session.id,pin.sessionId);assert.equal(effects,0);assert.throws(()=>s.nativeVoice.exchange(pin.sessionId,s.store.hostId,pin.generation),e=>e.code==='not_found');assert.ok(!rawJournal(s.store).includes('SYNTHETIC_EPHEMERAL'));evidence.effects.push({test:'crash-reopen',unknown:true,startReceiptRetained:true,automaticBackendStarts:0,SDPAbsent:true});}finally{await s.shutdown()}
});

test('missing audio client and unsupported voice fail before account gate; silent startup has a finite timeout',async()=>{
 for(const kind of ['missing','voice']){
  const root=lab(),v=setup(root,backend(root)),input=request(v.s.store,v.bot,v.thread);if(kind==='missing')delete input.sdpOffer;else input.voice='not_a_voice';
  try{const result=await v.s.nativeVoice.start(v.thread.id,input);assert.equal(result.session.code,kind==='missing'?'audio_client_missing':'model_unsupported');assert.equal(records(join(root,'rpc.jsonl')).filter(r=>r.kind==='account_gate').length,0);}finally{await v.s.shutdown()}
 }
 const root=lab(),store=new HostStore({dataDir:join(root,'data')}),bot=store.createBot({name:'Silent frontend',profileId:'synthetic',engine:'codex'}),thread=store.createThread(bot.id),runtime=new ConversationRuntime({store,drivers:[]});let time=100000,closes=0;
 const b={async capabilities(){return {supported:true,voices:['cove'],cliVersion:'synthetic'};},async start(){return {async speech(){},async text(){},async stop(){},async close(){closes++;}};}};
 const voice=new NativeVoiceRuntime(store,runtime,b,()=>time);try{const input=request(store,bot,thread);const result=await voice.start(thread.id,input);assert.equal(result.session.state,'starting');time+=16000;await until(()=>voice.get(input.sessionId).code==='timeout','finite startup timeout');await voice.close();assert.equal(closes,1);evidence.effects.push({test:'audio-voice-timeout',audioMissing:true,voiceUnsupported:true,authGateCalls:0,finiteStartup:true});}finally{await voice.close();await runtime.shutdown()}
});

test('focused first-party operational docs have stable controls, scope/approval/recovery and progressive native voice topic',()=>{
 const page=readAppConfigurationGuidePage('native-codex-voice');assert.equal(page.version,'1.2.0');assert.equal(page.fields.length,26);for(const id of ['native-voice.status','native-voice.start','native-voice.preference','native-voice.history','native-voice.voice','native-voice.exchange','native-voice.events','native-voice.actions','native-voice.stop','native-voice.receipt'])assert.ok(page.fields.some(f=>f.id===id));for(const f of page.fields)for(const key of ['purpose','scope','read','change','approval','result','recovery','availability'])assert.ok(f[key]);assert.ok(readHarnessGuideTopic('native-voice').markdown.includes('native-voice.receipt'));
});
