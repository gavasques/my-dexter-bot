import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {createSecretKey} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {HostStore,dispatchAction,SCHEMA_VERSION} from '../packages/hub/dist/index.js';
import {createHostApp,createAuthorizedHostRouter} from '../packages/hub/dist/http.js';
import {checkFullSchema} from '../packages/operations/dist/full-schemas.js';
import {APPROVAL_POLICY_SCOPE_VERSION} from '../packages/contracts/dist/index.js';
import {HostServices} from '../packages/cli/dist/host-services.js';
import {HarnessOperationSurface,HARNESS_OPERATION_DESTINATION} from '../packages/cli/dist/harness-operation-surface.js';
import {readFileSync} from 'node:fs';
import {captureCheckpointArtifact,openCheckpointArtifact} from '../packages/operations/dist/index.js';

const errorCode=expected=>error=>error?.code===expected;
function fixture(t){
 const root=mkdtempSync('/private/tmp/approval-always-auto-test-');let store=new HostStore({dataDir:root});
 const bot=store.createBot({name:'Synthetic approval',profileId:'synthetic',engine:'codex'}),thread=store.createThread(bot.id);
 let {turn}=store.createTurn(thread.id,{clientRequestId:'fixture-turn',content:'Only synthetic effects'});store.claimNextTurn(thread.id);
 let serial=0;const cases={command:['dexter.harness.terminal.run','dexter-harness-owner-proposals','terminal'],
  edit:['dexter.harness.files.write','dexter-harness-owner-proposals','files_write'],
  routine:['mcp.synthetic.read','synthetic-account','native_mcp_read'],other:['mcp.synthetic.delete','synthetic-account','native_mcp']};
 function request(category,extra={}){
  const [tool,destination,eligibility]=cases[category];
  if(!store.getGrant(bot.id,tool,destination))store.setGrant({botId:bot.id,tool,destination,policy:'ask'});
  const key=`request-${++serial}`;
  const action=store.requestAction({botId:bot.id,threadId:thread.id,tool,destination,arguments:{input:{runtime:'sh',cwd:'synthetic-folder'},
   pin:{manifestHash:'synthetic-v1',schemaHash:'synthetic-schema-v1',accountGeneration:1,turnId:turn.id}},idempotencyKey:key,...extra},eligibility);
  store.bindToolAction(action.id,turn.id,key);return action;
 }
 const policy=mode=>store.setBotApprovalPolicy(bot.id,{expectedHostId:store.hostId,clientRequestId:`policy-${++serial}`,
  expectedRevision:store.getBotApprovalPolicy(bot.id).revision,mode,eligibleScopeVersion:APPROVAL_POLICY_SCOPE_VERSION});
 const decide=(action,alwaysAccept=false,decision='allow',key=`decision-${++serial}`)=>({expectedHostId:store.hostId,clientRequestId:key,
  requestHash:action.requestHash,decision,alwaysAccept,expectedTypeKey:action.approvalType.key,expectedPreferenceRevision:action.approvalType.revision});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 return {get store(){return store;},root,bot,thread,turn,cases,request,policy,decide,
  reopen(){store.close();store=new HostStore({dataDir:root});turn=store.createTurn(thread.id,{clientRequestId:`restart-${++serial}`,content:"Explicit synthetic new turn"}).turn;store.claimNextTurn(thread.id);return store;}};
}
test('four modes have distinct real admissions; grants and private flows remain authoritative',t=>{
 const f=fixture(t),matrix={ask:['awaiting_approval','awaiting_approval','awaiting_approval','awaiting_approval'],
  accept_edits:['awaiting_approval','ready','awaiting_approval','awaiting_approval'],approve_all:['awaiting_approval','ready','ready','awaiting_approval'],
  full_access:['ready','ready','ready','awaiting_approval']};
 for(const [mode,expected] of Object.entries(matrix)){
  f.policy(mode);assert.deepEqual(['command','edit','routine','other'].map(c=>f.request(c).state),expected,mode);
 }
 const [tool,destination]=f.cases.command;
 f.store.setGrant({botId:f.bot.id,tool,destination,policy:'deny'});assert.throws(()=>f.request('command'),errorCode('forbidden'));
 const privateTool='dexter.harness.mcp.add';f.store.setGrant({botId:f.bot.id,tool:privateTool,destination,policy:'allow'});
 assert.equal(f.store.requestAction({botId:f.bot.id,threadId:f.thread.id,tool:privateTool,destination,arguments:{},idempotencyKey:'private'},'terminal').state,'awaiting_approval');
 const unsupported='mcp.untrusted.read';f.store.setGrant({botId:f.bot.id,tool:unsupported,destination:'foreign-account',policy:'ask'});
 assert.equal(f.store.requestAction({botId:f.bot.id,threadId:f.thread.id,tool:unsupported,destination:'foreign-account',arguments:{},idempotencyKey:'unsupported'}).state,'awaiting_approval');
});
test('chat override CAS persists independently of the bot default; revocation fences ready work',t=>{
 const f=fixture(t);f.policy('full_access');const other=f.store.createThread(f.bot.id);
 const input={expectedHostId:f.store.hostId,clientRequestId:'chat-supervised',expectedRevision:0,overrideMode:'ask'};
 const receipt=f.store.setThreadApprovalPolicy(f.thread.id,input);assert.equal(f.store.getEffectiveApprovalPolicy(f.thread.id).mode,'ask');
 assert.equal(f.store.getEffectiveApprovalPolicy(other.id).mode,'full_access');assert.equal(f.request('command').state,'awaiting_approval');
 assert.throws(()=>f.store.setThreadApprovalPolicy(f.thread.id,{...input,overrideMode:'full_access'}),errorCode('conflict'));
 f.reopen();assert.deepEqual(f.store.setThreadApprovalPolicy(f.thread.id,input),receipt);
 const override={...input,clientRequestId:'chat-full',expectedRevision:1,overrideMode:'full_access'};
 f.store.setThreadApprovalPolicy(f.thread.id,override);const ready=f.request('command');assert.equal(ready.authorization.source,'thread_policy');
 const revoked=f.store.setThreadApprovalPolicy(f.thread.id,{...input,clientRequestId:'chat-revoke',expectedRevision:2});
 assert.deepEqual(revoked.revocationEffects.blockedActionIds,[ready.id]);assert.equal(f.store.getAction(ready.id).state,'blocked');
});
test('allow once never saves a type; always atomically decides and saves exact receipt across lost ACK/restart',async t=>{
 const f=fixture(t),once=f.request('command');f.store.decideApprovalPreference(once.id,f.decide(once));
 assert.equal(f.store.listApprovalTypes(f.bot.id).length,0);assert.equal(f.request('command').state,'awaiting_approval');
 const pending=f.request('command'),input=f.decide(pending,true,'allow','lost-ack');
 const saved=f.store.decideApprovalPreference(pending.id,input);assert.equal(saved.action.authorization.source,'owner_type');
 assert.equal(saved.receipt.state.preference.enabled,true);assert.equal(f.request('command').state,'ready');
 const changed=f.request('command',{arguments:{input:{runtime:'sh',cwd:'different-folder'},pin:pending.request.arguments.pin}});
 assert.equal(changed.state,'awaiting_approval','different cwd is a distinct type');
 const schema=f.request('command',{arguments:{input:pending.request.arguments.input,pin:{...pending.request.arguments.pin,schemaHash:'schema-v2'}}});
 assert.equal(schema.state,'awaiting_approval','changed schema requires review');
 f.reopen();assert.deepEqual(f.store.decideApprovalPreference(pending.id,input).receipt,saved.receipt);
 assert.throws(()=>f.store.decideApprovalPreference(pending.id,{...input,alwaysAccept:false}),errorCode('conflict'));
 assert.equal(f.store.getApprovalPreferenceReceipt(f.bot.id,'lost-ack').id,saved.receipt.id);
 const pref=f.store.listApprovalTypes(f.bot.id)[0],action=f.request('command');let effects=0;
 const outcome=await dispatchAction(f.store,action.id,async()=>{effects++;return {termination:"completed",signal:null,exitCode:0,stdout:"synthetic",stdoutTruncated:false};});assert.equal(outcome.state,'succeeded');
 await assert.rejects(dispatchAction(f.store,action.id,async()=>{effects++;return null;}),errorCode('conflict'));assert.equal(effects,1);
 const revoked=f.store.revokeApprovalType(f.bot.id,pref.key,{expectedHostId:f.store.hostId,clientRequestId:'revoke-type',expectedRevision:pref.revision});
 assert.equal(revoked.state.enabled,false);assert.equal(f.request('command').state,'awaiting_approval');
});
test('saved type does not cross bot, destination, manifest/grant epoch or absent pins; unknown never executes again',async t=>{
 const f=fixture(t),pending=f.request('other');f.store.decideApprovalPreference(pending.id,f.decide(pending,true));
 const bot2=f.store.createBot({name:'Other synthetic',profileId:'synthetic',engine:'codex'}),thread2=f.store.createThread(bot2.id);
 f.store.setGrant({botId:bot2.id,tool:pending.request.tool,destination:pending.request.destination,policy:'ask'});
 assert.equal(f.store.requestAction({...pending.request,botId:bot2.id,threadId:thread2.id,idempotencyKey:'cross-bot'},'native_mcp').state,'awaiting_approval');
 f.store.setGrant({botId:f.bot.id,tool:pending.request.tool,destination:'different-account',policy:'ask'});
 assert.equal(f.request('other',{destination:'different-account'}).state,'awaiting_approval');
 const missing=f.request('other',{arguments:{input:{}}});assert.equal(missing.approvalType.reason,'pins_unavailable');
 assert.throws(()=>f.store.decideApprovalPreference(missing.id,f.decide(missing,true)),errorCode('conflict'));
 const action=f.request('other');let effects=0;
 const result=await dispatchAction(f.store,action.id,async()=>{effects++;throw new Error('synthetic lost effect ACK');});
 assert.equal(result.state,'unknown');await assert.rejects(dispatchAction(f.store,action.id,async()=>{effects++;return null;}),errorCode('conflict'));assert.equal(effects,1);
 f.store.setGrant({botId:f.bot.id,tool:pending.request.tool,destination:pending.request.destination,policy:'ask'});
 assert.equal(f.request('other').state,'awaiting_approval');
 f.reopen();assert.equal(f.store.getAction(action.id).state,'unknown');
});
test('composed owner HTTP and Operations exact schema preserve modes/types and reject engine/paired elevation',async t=>{
 const f=fixture(t),app=createHostApp(f.store),pending=f.request('command'),input=f.decide(pending,true);
 const post=body=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await app.request(`/v1/actions/${pending.id}/decision-preference`,post({...input,ownerId:'model'}))).status,400);
 const response=await app.request(`/v1/actions/${pending.id}/decision-preference`,post(input));assert.equal(response.status,200);
 const mode={expectedHostId:f.store.hostId,clientRequestId:'http-chat',expectedRevision:0,overrideMode:'accept_edits'};
 assert.equal((await app.request(`/v1/threads/${f.thread.id}/approval-policy`,{...post(mode),method:'PATCH'})).status,200);
 assert.equal((await app.request(`/v1/threads/${f.thread.id}/approval-policy`)).status,200);
 const authority={principal:'paired-client',installationId:f.store.hostId,ownerId:f.store.ownerId,deviceId:'dev_synthetic',
  pinGeneration:1,bindingRevision:1,role:'client-ios',scopes:['chat.read','chat.write','approvals.decide'],assertCurrent(){},noteSelfRevoke(){}};
 const paired=createAuthorizedHostRouter(f.store);
 assert.equal((await paired.fetch(new Request(`https://paired.invalid/v1/threads/${f.thread.id}/approval-policy`,{...post(mode),method:'PATCH'}),{authority})).status,403);
 const db=new DatabaseSync(`${f.root}/dexter.sqlite`,{readOnly:true});t.after(()=>db.close());
 assert.equal(SCHEMA_VERSION,16);assert.equal(db.prepare('PRAGMA user_version').get().user_version,16);
 assert.equal(checkFullSchema(db,'hub').installationId,f.store.hostId);
});
test('actual composed harness executes an admitted edit and full-access synthetic command without a popup; Auto still asks for command',async t=>{
 const root=mkdtempSync('/private/tmp/approval-composed-harness-');
 const makeDriver=engine=>({id:engine,capabilities:{resume:true,interrupt:true,fork:false,steer:false},status:async()=>({engine,installed:true}),
  open:async threadId=>({threadId,nativeCursor:'synthetic-only'}),async *turn(session,turnId){yield {type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},
  respondToTool:async()=>{},interrupt:async()=>{},close:async()=>{}});
 const services=new HostServices({dataDir:root,enableEngines:true,enableMcp:true,enableWorkspaceTools:true,
  engineCommands:{codex:'/usr/bin/false'},makeDriver,engineCatalog:()=>[]});
 const surface=new HarnessOperationSurface({store:services.store,base:services.gateway,catalog:services.engineCatalog,runtime:()=>services.runtime,
  skills:()=>services.skillsHttp,effectiveSkills:()=>[],workspace:()=>services.botWorkspaceTools});
 try {
  const bot=services.store.createBot({name:'Synthetic composed modes',profileId:'synthetic',engine:'codex'}),thread=services.store.createThread(bot.id);
  const {turn}=services.store.createTurn(thread.id,{clientRequestId:'composed-turn',content:'No real provider'});services.store.claimNextTurn(thread.id);
  const token=surface.issueCapability({turnId:turn.id}).token;
  for(const tool of ['dexter.harness.files.write','dexter.harness.terminal.run'])services.store.setGrant({botId:bot.id,tool,destination:HARNESS_OPERATION_DESTINATION,policy:'ask'});
  let serial=0;const mode=mode=>services.store.setBotApprovalPolicy(bot.id,{expectedHostId:services.store.hostId,clientRequestId:`composed-policy-${++serial}`,
   expectedRevision:services.store.getBotApprovalPolicy(bot.id).revision,mode,eligibleScopeVersion:APPROVAL_POLICY_SCOPE_VERSION});
  const call=(name,key,args)=>surface.call(token,{connectionId:HARNESS_OPERATION_DESTINATION,tool:`dexter.harness.${name}`,callId:key,arguments:args});
  mode('accept_edits');const edit=await call('files.write','composed-edit',{path:'only-synthetic.txt',text:'Synthetic content'});
  assert.equal(edit.status,'succeeded');assert.equal(readFileSync(`${root}/bot-files/${bot.id}/only-synthetic.txt`,'utf8'),'Synthetic content');
  assert.equal(services.store.getAction(edit.actionId).authorization.source,'owner_policy');
  mode('approve_all');assert.equal((await call('terminal.run','composed-auto-command',{runtime:'sh',command:'printf synthetic'})).status,'awaiting_approval');
  mode('full_access');const cmd=await call('terminal.run','composed-full-command',{runtime:'sh',command:'printf synthetic'});
  assert.equal(cmd.status,'succeeded');assert.equal(cmd.result.stdout,'synthetic');assert.equal(cmd.result.executionBoundary,'owner_os_permissions');
  assert.equal(cmd.result.cwdIsNotSandbox,true);
  const chatMode=overrideMode=>services.store.setThreadApprovalPolicy(thread.id,{expectedHostId:services.store.hostId,clientRequestId:`composed-chat-${++serial}`,
   expectedRevision:services.store.getThreadApprovalPolicy(thread.id).revision,overrideMode});
  chatMode('ask');
  assert.equal(surface.listTools(token).find(t=>t.name==='dexter.harness.terminal.run').requiresApproval,true);
  assert.equal((await call('terminal.run','chat-ask-over-bot-full',{runtime:'sh',command:'printf chat-ask'})).status,'awaiting_approval');
  mode('ask');chatMode('full_access');
  assert.equal(surface.listTools(token).find(t=>t.name==='dexter.harness.terminal.run').requiresApproval,false);
  const chatCmd=await call('terminal.run','chat-full-over-bot-ask',{runtime:'sh',command:'printf chat-full'});
  assert.equal(chatCmd.status,'succeeded');assert.equal(chatCmd.result.stdout,'chat-full');
  assert.equal(services.store.getAction(chatCmd.actionId).authorization.source,'thread_policy');
  const contextual=await call('status','contextual-status',{});assert.equal(contextual.result.approvalPolicy.mode,'ask');
  assert.equal(contextual.result.effectiveApprovalPolicy.mode,'full_access');assert.equal(contextual.result.effectiveApprovalPolicy.source,'chat_override');
  const status=await call('status','composed-status',{});assert.equal(status.result.effectiveApprovalPolicy.mode,'full_access');
  assert.equal(status.result.approvalBoundary,'host_harness_only_native_provider_approval_unchanged');
 }finally {await surface.close();await services.shutdown();rmSync(root,{recursive:true,force:true});}
});
test('type revocation requests stop on owned running work; unknown partial effect is never retried',async t=>{
 const f=fixture(t),action=f.request('command');f.store.decideApprovalPreference(action.id,f.decide(action,true));
 let effects=0,entered;const started=new Promise(resolve=>entered=resolve);
 const flight=dispatchAction(f.store,action.id,async(_request,{signal})=>{effects++;entered();
  await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
  return {termination:'aborted',signal:'SIGTERM',exitCode:null,stdout:'synthetic partial',stdoutTruncated:false};});
 await started;const pref=f.store.listApprovalTypes(f.bot.id)[0];
 const receipt=f.store.revokeApprovalType(f.bot.id,pref.key,{expectedHostId:f.store.hostId,clientRequestId:'stop-type',expectedRevision:pref.revision});
 assert.deepEqual(receipt.revocationEffects.abortedActionIds,[action.id]);assert.equal((await flight).state,'unknown');assert.equal(effects,1);
 f.reopen();assert.equal(f.store.getAction(action.id).state,'unknown');assert.equal(f.request('command').state,'awaiting_approval');
});
test('encrypted Operations checkpoint roundtrip carries Hub14 mode, type and receipt chains without changing Context',t=>{
 const f=fixture(t),out=mkdtempSync('/private/tmp/approval-backup-test-');t.after(()=>rmSync(out,{recursive:true,force:true}));
 f.policy('accept_edits');f.store.setThreadApprovalPolicy(f.thread.id,{expectedHostId:f.store.hostId,clientRequestId:'checkpoint-chat',expectedRevision:0,overrideMode:'ask'});
 const action=f.request('command'),saved=f.store.decideApprovalPreference(action.id,f.decide(action,true));
 f.store.finishTurn(f.turn.id,'completed',null);
 const checkpoint=f.store.checkpointForTransfer('ckp_approval_fixture_20261012');
 const secret=createSecretKey(Buffer.alloc(32,17)),key={keyId:'synthetic-approval-backup',use:fn=>fn(secret)};
 const artifact=captureCheckpointArtifact({source:f.store,checkpoint,key,output:`${out}/approval.dxg8`});
 const opened=openCheckpointArtifact(artifact.path,key);assert.equal(opened.manifest.schemas.hub,'hub-v16');
 writeFileSync(`${out}/restored-hub.sqlite`,opened.members.get('hub.sqlite'));
 const db=new DatabaseSync(`${out}/restored-hub.sqlite`,{readOnly:true});try {
  assert.equal(checkFullSchema(db,'hub').installationId,f.store.hostId);
  assert.equal(db.prepare('SELECT mode FROM bot_approval_policies').get().mode,'accept_edits');
  assert.equal(db.prepare('SELECT count(*) AS n FROM thread_approval_policies').get().n,1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM approval_type_preferences').get().n,1);
  assert.equal(JSON.parse(db.prepare('SELECT receipt FROM approval_preference_receipts WHERE id=?').get(saved.receipt.id).receipt).inputHash,saved.receipt.inputHash);
 }finally {db.close();}
});
