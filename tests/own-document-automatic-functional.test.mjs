import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {HostServices} from '../packages/cli/dist/host-services.js';
import {HarnessOperationSurface,HARNESS_OPERATION_DESTINATION} from '../packages/cli/dist/harness-operation-surface.js';
import {createHostApp} from '../packages/hub/dist/http.js';
import {APPROVAL_POLICY_SCOPE_VERSION,TEAM_WORKSPACES_META_KEY,teamWorkspacesCanonicalJSON} from '../packages/contracts/dist/index.js';
import {validateContext} from '../packages/operations/dist/validate.js';
import {GitSnapshot,readContextGit} from '../packages/operations/dist/git.js';
import {resolveLimits,gitLimits} from '../packages/operations/dist/manifest.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const code=expected=>error=>error?.code===expected;
const tool='dexter.harness.memory.append';
const catalog=()=>[{id:'codex',available:true,defaultModel:'synthetic-model',models:[{id:'synthetic-model',reasoningEfforts:[],speeds:[]}],reasoningEfforts:[],speeds:[]}];
async function bounded(read,predicate){const end=Date.now()+5000;for(;;){const value=read();if(predicate(value))return value;if(Date.now()>end)throw Error('Synthetic memory condition timeout');await new Promise(resolve=>setTimeout(resolve,10));}}
function fixture(t,{integrated=false}={}){
 const root=realpathSync(mkdtempSync('/private/tmp/memory-harness-r3-fixture-')),dataDir=join(root,'host'),surfaces=[],observed=[];let services,app,sequence=0;
 const makeDriver=id=>({id,capabilities:{resume:true,interrupt:true,fork:false,steer:false},status:async()=>({engine:id,installed:true,authentication:'unverified',billing:'unknown'}),
  open:async threadId=>({threadId,nativeCursor:"synthetic-r3-session"}),async *turn(session,turnId,input){observed.push({turnId,input});yield{type:'text.delta',threadId:session.threadId,turnId,text:'Synthetic receipt observed'};yield{type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},respondToTool:async()=>{},interrupt:async()=>{},close:async()=>{}});
 const open=()=>{services=new HostServices({dataDir,enableMcp:true,enableEngines:true,engineCommands:{codex:'/usr/bin/false'},engineCatalog:catalog,makeDriver});app=createHostApp(services.store,{...(integrated?{runtime:services.runtime}:{}),botDocuments:services.botDocumentsHttp});};open();
 const surface=(documents=()=>services.botDocumentsHttp)=>{const s=new HarnessOperationSurface({store:services.store,base:services.gateway,catalog:services.engineCatalog,runtime:()=>services.runtime,skills:()=>services.skillsHttp,documents,effectiveSkills:()=>[]});surfaces.push(s);return s;};
 const bot=()=>services.store.createBot({name:'Synthetic memory bot',engine:'codex',profileId:'synthetic'});
 const live=(b,s=surface(),thread=services.store.createThread(b.id))=>{const turn=services.store.createTurn(thread.id,{clientRequestId:`synthetic-${++sequence}`,content:'Explicit synthetic memory note'}).turn;assert.equal(services.store.claimNextTurn(thread.id).id,turn.id);return{bot:b,surface:s,thread,turn,token:s.issueCapability({turnId:turn.id}).token};};
 const save=(b,memory,soul='Human SOUL 🦊',user='Human USER')=>services.botDocumentsHttp.compareAndSet(b.id,{expectedRevision:services.botDocumentsHttp.read(b.id).revision,soul,user,memory,clientRequestId:`human-${++sequence}`});
 const request=(method,path,body)=>app.request(`http://127.0.0.1${path}`,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const decide=async(action,decision='allow',requestHash=action.requestHash)=>{const response=await request('POST',`/v1/actions/${action.actionId}/decisions`,{decision,requestHash});return{status:response.status,body:await response.json()};};
 const counts=()=>{const db=new DatabaseSync(services.context.databasePath,{readOnly:true});try{return{revisions:db.prepare('SELECT COUNT(*) n FROM bot_document_revisions').get().n,receipts:db.prepare('SELECT COUNT(*) n FROM bot_document_receipts').get().n};}finally{db.close();}};
 const finish=()=>{for(const turn of services.store.listTurnsByState('running'))services.store.finishTurn(turn.id,'completed',null);};
 const shutdown=async()=>{for(const s of surfaces.splice(0))await s.close();finish();await services.shutdown();};
 t.after(async()=>{await shutdown();rmSync(root,{recursive:true,force:true});});
 return{root,get services(){return services;},observed,bot,surface,live,save,request,decide,counts,finish,async reopen(){await shutdown();open();}};
}
const call=(p,name,callId,args={})=>p.surface.call(p.token,{connectionId:HARNESS_OPERATION_DESTINATION,tool:`dexter.harness.${name}`,callId,arguments:args});

test('own documents: automatic direct SOUL USER MEMORY and append in Ask mode retain receipts, exact CAS and replay',async t=>{
 const f=fixture(t),b=f.bot(),other=f.bot(),p=f.live(b);
 const initial=await call(p,'documents.read','read');assert.deepEqual(initial.result.documents.automation,{version:'own-documents.v1',scope:'own_private',updates:'automatic',append:'automatic',clear:'exact_owner',restore:'exact_owner'});
 assert.equal(p.surface.listTools(p.token).find(v=>v.name===tool).requiresApproval,false);
 let revision=0;
 for(const document of ['SOUL','USER','MEMORY']){
  const input={expectedRevision:revision,document,markdown:`Synthetic own ${document}`},result=await call(p,'documents.update',`save-${document}`,input);
  assert.equal(result.status,'succeeded');assert.equal(result.result.documents.revision,++revision);
  const action=f.services.store.getAction(result.actionId);assert.equal(action.authorization.source,'bounded_grant');assert.equal(action.decidedBy,f.services.store.ownerId);assert.ok(f.services.store.ownDocumentAuthorizationValid(action.id));
  assert.deepEqual(await call(p,'documents.update',`save-${document}`,input),result);assert.equal(result.result.documents.receipt.source.turnId,p.turn.id);
 }
 const input={expectedRevision:revision,note:'Literal durable note'},result=await call(p,'memory.append','append',input);assert.equal(result.status,'succeeded');revision++;
 assert.equal(result.result.documents.soul,'Synthetic own SOUL');assert.equal(result.result.documents.user,'Synthetic own USER');assert.equal(result.result.documents.memory,'Synthetic own MEMORY\n\n'+input.note);
 assert.equal((await call(p,'memory.receipt','receipt',{action_id:result.actionId})).result.documents.receipt.note.outcome,'appended');
 assert.deepEqual(await call(p,'memory.append','append',input),result);
 assert.equal(f.services.botDocumentsHttp.read(other.id).revision,0);
 await assert.rejects(call(p,'memory.append','stale',input),code('conflict'));
 for(const args of [{expectedRevision:revision,note:'Secret api_key='+ 's'.repeat(32)},{expectedRevision:revision,note:'Foreign',botId:other.id}])await assert.rejects(call(p,'memory.append','invalid-'+Object.keys(args).length,args),code('invalid_input'));
 const duplicate=await call(p,'memory.append','duplicate',{...input,expectedRevision:revision});assert.equal(duplicate.status,'succeeded');assert.equal(duplicate.result.documents.revision,revision);assert.equal(duplicate.result.documents.receipt.note.outcome,'already_present');
 // Neither clearing nor restoring can use the automatic grant, including Full access.
 f.services.store.setBotApprovalPolicy(b.id,{expectedHostId:f.services.store.hostId,expectedRevision:0,clientRequestId:'synthetic-full',mode:'full_access',eligibleScopeVersion:APPROVAL_POLICY_SCOPE_VERSION});
 const clear=await call(p,'documents.update','clear',{expectedRevision:revision,document:'SOUL',markdown:''});assert.equal(clear.status,'awaiting_approval');assert.equal((await f.decide(clear,'deny')).status,200);assert.equal((await call(p,'documents.update','clear',{expectedRevision:revision,document:'SOUL',markdown:''})).status,'denied');
 const restore=await call(p,'memory.restore','restore',{expectedRevision:revision,fromRevision:3});assert.equal(restore.status,'awaiting_approval');
 assert.equal(f.services.botDocumentsHttp.read(b.id).revision,revision);
});

test('own documents: preserve explicit Ask deny expired; upgrade only provisional Ask; old outcomes never replay',async t=>{
 const f=fixture(t),b=f.bot(),p=f.live(b),store=f.services.store,destination=HARNESS_OPERATION_DESTINATION,update='dexter.harness.documents.update';
 store.setGrant({botId:b.id,tool:update,destination,policy:'ask'});
 assert.equal(store.ownDocumentAutomationStatus(b.id).updates,'ask');
 const args={expectedRevision:0,document:'SOUL',markdown:'Review explicit request'},pending=await call(p,'documents.update','explicit',args);assert.equal(pending.status,'awaiting_approval');assert.equal((await f.decide(pending,'deny')).status,200);
 store.setProposalGrant({botId:b.id,tool:update,destination,policy:'ask'});
 const automatic=await call(p,'documents.update','provisional',args);assert.equal(automatic.status,'succeeded');assert.equal(store.getGrant(b.id,update,destination).policy,'allow');
 assert.equal((await call(p,'documents.update','explicit',args)).status,'denied');assert.equal(f.services.botDocumentsHttp.read(b.id).revision,1);
 store.setGrant({botId:b.id,tool,destination,policy:'deny'});assert.equal(store.ownDocumentAutomationStatus(b.id).append,'denied');assert.ok(!p.surface.listTools(p.token).some(v=>v.name===tool));await assert.rejects(call(p,'memory.append','denied',{expectedRevision:1,note:'Do not write'}),code('forbidden'));
 store.setGrant({botId:b.id,tool,destination,policy:'allow',expiresAt:store.now()-1});assert.equal(store.ownDocumentAutomationStatus(b.id).append,'expired');await assert.rejects(call(p,'memory.append','expired',{expectedRevision:1,note:'Do not revive'}),code('forbidden'));
 assert.equal(store.getGrant(b.id,tool,destination).expiresAt<store.now(),true);
 const teamSurface=new HarnessOperationSurface({store,base:f.services.gateway,catalog:f.services.engineCatalog,runtime:()=>f.services.runtime,skills:()=>f.services.skillsHttp,documents:()=>f.services.botDocumentsHttp,effectiveSkills:()=>[],privateMemoryTurn:()=>false});t.after(()=>teamSurface.close());const teamToken=teamSurface.issueCapability({turnId:p.turn.id}).token;
 assert.ok(!teamSurface.listTools(teamToken).some(v=>v.name===tool||v.name==='dexter.harness.documents.read'));await assert.rejects(teamSurface.call(teamToken,{connectionId:destination,tool:update,callId:'team',arguments:{...args,expectedRevision:1}}),code('forbidden'));
});

test('own documents: automatic receipts survive grant revocation and restart; backup refuses forged bounded authority',async t=>{
 const f=fixture(t),b=f.bot(),p=f.live(b),store=f.services.store;
 const team=f.services.teamsHttp.create({expectedHostID:store.hostId,clientRequestId:'00000000-0000-4000-8000-000000000001',name:'Synthetic Team',coordinatorBotId:b.id,botIds:[b.id]});
 const teamThread=store.createThread(b.id);assert.ok(!teamThread.id.startsWith('thr_team_'));f.services.teamsHttp.bindThread(team.id,teamThread.id,team.revision,'00000000-0000-4000-8000-000000000002');
 const teamLive=f.live(b,undefined,teamThread);assert.equal(store.isOwnDocumentTurnPrivate(teamLive.turn.id),false);assert.ok(!teamLive.surface.listTools(teamLive.token).some(v=>v.name===tool||v.name==='dexter.harness.documents.read'));
 await assert.rejects(call(teamLive,'memory.append','team-refused',{expectedRevision:0,note:'Private note must not enter group context'}),code('forbidden'));
 const result=await call(p,'memory.append','auto',{expectedRevision:0,note:'Exact automatic note'});assert.equal(result.status,'succeeded');
 store.setGrant({botId:b.id,tool,destination:HARNESS_OPERATION_DESTINATION,policy:'deny'});
 assert.equal(f.services.botDocumentsHttp.receipt(b.id,`action:${result.actionId}`).memory,'Exact automatic note');
 const contextPath=join(f.root,'context-inspect.sqlite'),hubPath=join(f.root,'hub-inspect.sqlite');store.withWriterLease(()=>{for(const [source,dest]of[[f.services.context.databasePath,contextPath],[store.databasePath,hubPath]]){const db=new DatabaseSync(source);try{db.prepare('VACUUM INTO ?').run(dest);}finally{db.close();}}});
 const db=new DatabaseSync(contextPath),hub=new DatabaseSync(hubPath),limits=gitLimits(resolveLimits()),git=new GitSnapshot(readContextGit(f.services.context.repositoryPath,limits,()=>{}),limits);
 try{
  validateContext(db,hub,git);
  const original=hub.prepare('SELECT context FROM action_approval_contexts WHERE action_id=?').get(result.actionId).context,c=JSON.parse(original);c.eligibility='files_write';hub.prepare('UPDATE action_approval_contexts SET context=? WHERE action_id=?').run(JSON.stringify(c),result.actionId);assert.throws(()=>validateContext(db,hub,git),error=>error?.code==='reference_broken');
  hub.prepare('UPDATE action_approval_contexts SET context=? WHERE action_id=?').run(original,result.actionId);validateContext(db,hub,git);
  const originalCall=hub.prepare('SELECT call_id FROM tool_action_continuations WHERE action_id=?').get(result.actionId).call_id;
  hub.prepare('UPDATE tool_action_continuations SET call_id=? WHERE action_id=?').run('forged-call-id',result.actionId);
  for(const [table,column]of[['bot_document_revisions','memory_source_json'],['bot_document_receipts','origin_json']]){
   const row=db.prepare(`SELECT ${column} value FROM ${table} WHERE bot_id=?`).get(b.id),source=JSON.parse(row.value);source.callId='forged-call-id';db.prepare(`UPDATE ${table} SET ${column}=? WHERE bot_id=?`).run(teamWorkspacesCanonicalJSON(source),b.id);
  }
  assert.throws(()=>validateContext(db,hub,git),error=>error?.code==='reference_broken'&&error.message==='Document append action pin invalid.');
  hub.prepare('UPDATE tool_action_continuations SET call_id=? WHERE action_id=?').run(originalCall,result.actionId);
  for(const [table,column]of[['bot_document_revisions','memory_source_json'],['bot_document_receipts','origin_json']]){
   const row=db.prepare(`SELECT ${column} value FROM ${table} WHERE bot_id=?`).get(b.id),source=JSON.parse(row.value);source.callId=originalCall;db.prepare(`UPDATE ${table} SET ${column}=? WHERE bot_id=?`).run(teamWorkspacesCanonicalJSON(source),b.id);
  }
  validateContext(db,hub,git);
  // A correlated staged Team binding on a normal private UUID thread remains forbidden for automatic receipts.
  const raw=db.prepare('SELECT value FROM meta WHERE key=?').get(TEAM_WORKSPACES_META_KEY).value,metadata=JSON.parse(raw),binding=metadata.bindings[teamThread.id];
  metadata.bindings[p.thread.id]={...binding};metadata.threadReceipts['00000000-0000-4000-8000-000000000003']={...metadata.threadReceipts['00000000-0000-4000-8000-000000000002'],threadId:p.thread.id,
   requestHash:sha(teamWorkspacesCanonicalJSON({teamId:team.id,expectedRevision:team.revision,clientRequestId:'00000000-0000-4000-8000-000000000003'}))};
  db.prepare('UPDATE meta SET value=? WHERE key=?').run(teamWorkspacesCanonicalJSON(metadata),TEAM_WORKSPACES_META_KEY);
  assert.throws(()=>validateContext(db,hub,git),error=>error?.code==='reference_broken'&&error.message==='Document append action pin invalid.');
  db.prepare('UPDATE meta SET value=? WHERE key=?').run(raw,TEAM_WORKSPACES_META_KEY);validateContext(db,hub,git);
 }finally{db.close();hub.close();}
 f.finish();await f.reopen();assert.equal(f.services.botDocumentsHttp.receipt(b.id,`action:${result.actionId}`).memory,'Exact automatic note');
});

test('own documents: lost automatic response reads its effect without retry; forged bounded action cannot execute',async t=>{
 const f=fixture(t),b=f.bot();let effects=0;
 const broken=f.surface(()=>({...f.services.botDocumentsHttp,executeAction:id=>{effects++;f.services.botDocumentsHttp.executeAction(id);throw Error('Synthetic lost response');}})),p=f.live(b,broken),input={expectedRevision:0,note:'Durable direct note'};
 const result=await call(p,'memory.append','lost',input);assert.equal(result.status,'unknown');assert.equal(effects,1);
 const receipt=(await call(p,'memory.receipt','read-lost',{action_id:result.actionId})).result.documents;assert.equal(receipt.memory,input.note);assert.deepEqual(await call(p,'memory.append','lost',input),result);assert.equal(effects,1);
 const store=f.services.store,origin=store.ownerToolScope(result.actionId),revision=receipt.revision;
 const forged=store.requestAction({botId:b.id,threadId:p.thread.id,tool,destination:HARNESS_OPERATION_DESTINATION,idempotencyKey:'forged-not-a-harness-call',arguments:{input:{expectedRevision:revision,note:'Forged new effect'},pin:{revision,soulHash:sha(''),userHash:sha(''),memoryHash:sha(input.note)},origin}},'own_documents');
 store.bindToolAction(forged.id,p.turn.id,'forged');assert.equal(store.ownDocumentAuthorizationValid(forged.id),false);assert.throws(()=>f.services.botDocumentsHttp.executeAction(forged.id),code('forbidden'));assert.throws(()=>store.claimAction(forged.id),code('forbidden'));assert.equal(store.getAction(forged.id).state,'blocked');assert.equal(f.services.botDocumentsHttp.read(b.id).revision,revision);
});
