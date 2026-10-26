import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {HostServices} from '../packages/cli/dist/host-services.js';
import {HarnessOperationSurface,HARNESS_OPERATION_DESTINATION} from '../packages/cli/dist/harness-operation-surface.js';
import {createHostApp} from '../packages/hub/dist/http.js';
import {APPROVAL_POLICY_SCOPE_VERSION} from '../packages/contracts/dist/index.js';
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
 // These legacy exact-approval campaigns explicitly select Ask; product default is covered separately.
 const live=(b,s=surface(),thread=services.store.createThread(b.id))=>{if(!services.store.getGrant(b.id,tool,HARNESS_OPERATION_DESTINATION))services.store.setGrant({botId:b.id,tool,destination:HARNESS_OPERATION_DESTINATION,policy:'ask'});const turn=services.store.createTurn(thread.id,{clientRequestId:`synthetic-${++sequence}`,content:'Explicit synthetic memory note'}).turn;assert.equal(services.store.claimNextTurn(thread.id).id,turn.id);return{bot:b,surface:s,thread,turn,token:s.issueCapability({turnId:turn.id}).token};};
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
async function approved(f,p,callId,args){const pending=await call(p,'memory.append',callId,args);assert.equal(pending.status,'awaiting_approval');assert.equal((await f.decide(pending)).status,200);return call(p,'memory.append',callId,args);}

test('memory harness: exact Allow appends once; deny and forged identities write zero; replay is exact',async t=>{
 const f=fixture(t),b=f.bot(),p=f.live(b),other=f.bot(),initial=f.save(b,'\ufeffHuman\r\nspacing  \n'),beforeBot=f.services.store.getBot(b.id);
 const view=p.surface.listTools(p.token).find(view=>view.name===tool);assert.ok(view);assert.equal(view.requiresApproval,true);assert.deepEqual(Object.keys(view.inputSchema.properties).sort(),['expectedRevision','note']);assert.equal(f.services.store.summary().counts.grants,1);
 const stable=f.counts();
 for(const [index,args]of[{expectedRevision:1,note:''},{expectedRevision:1,note:' \n '},{expectedRevision:1,note:'\ud800'},...['botId','author','source','sourceReference','origin','actionId','document','soul','user','memory','grants'].map(key=>({expectedRevision:1,note:'Synthetic note',[key]:key==='botId'?other.id:'forged'}))].entries()){
  await assert.rejects(call(p,'memory.append',`forged-${index}`,args),code('invalid_input'));assert.deepEqual(f.counts(),stable);assert.equal(f.services.botDocumentsHttp.read(b.id).memory,initial.memory);
 }
 const denied=await call(p,'memory.append','deny',{expectedRevision:1,note:'Denied note'});assert.equal((await f.decide(denied,'deny')).status,200);assert.equal((await call(p,'memory.append','deny',{expectedRevision:1,note:'Denied note'})).status,'denied');assert.deepEqual(f.counts(),stable);
 const args={expectedRevision:1,note:'Literal approved note 🚀 e\u0301'},pending=await call(p,'memory.append','allow',args);assert.equal((await f.decide(pending,'allow','0'.repeat(64))).status,409);assert.deepEqual(f.counts(),stable);
 assert.equal((await f.decide(pending)).status,200);const result=await call(p,'memory.append','allow',args),doc=result.result.documents;assert.equal(result.status,'succeeded');assert.equal(doc.memory,initial.memory+'\n\n'+args.note);assert.equal(doc.soul,initial.soul);assert.equal(doc.user,initial.user);assert.equal(doc.revision,2);
 assert.equal(doc.receipt.operation,'append');assert.deepEqual(doc.receipt.note,{sha256:sha(args.note),outcome:'appended'});assert.equal(doc.receipt.source.ownerId,f.services.store.ownerId);assert.equal(doc.receipt.source.actionId,result.actionId);assert.equal(doc.receipt.source.turnId,p.turn.id);assert.equal(doc.receipt.source.threadId,p.thread.id);assert.equal(doc.receipt.source.callId,'allow');assert.equal(doc.receipt.source.reference,null);
 assert.deepEqual(await call(p,'memory.append','allow',args),result);await assert.rejects(call(p,'memory.append','allow',{...args,note:'different'}),code('conflict'));assert.deepEqual(f.counts(),{revisions:2,receipts:2});assert.deepEqual(f.services.store.getBot(b.id),beforeBot);assert.equal(f.services.botDocumentsHttp.read(other.id).revision,0);
 const receipt=await call(p,'memory.receipt','read-effect',{action_id:result.actionId});assert.deepEqual(receipt.result.documents,doc);assert.equal(receipt.result.dispatcher.state,'succeeded');
});

test('memory harness: aggregate hashes/CAS and grant revalidation preserve concurrent human edits; Approve all still asks',async t=>{
 const f=fixture(t),b=f.bot(),p=f.live(b);f.save(b,'Human initial');f.services.store.setBotApprovalPolicy(b.id,{expectedHostId:f.services.store.hostId,expectedRevision:0,clientRequestId:'synthetic-all',mode:'approve_all',eligibleScopeVersion:APPROVAL_POLICY_SCOPE_VERSION});
 assert.equal(p.surface.listTools(p.token).find(view=>view.name===tool).requiresApproval,true);
 const input={expectedRevision:1,note:'Stale note'},pending=await call(p,'memory.append','stale',input),visible=f.services.store.getAction(pending.actionId);assert.deepEqual(visible.request.arguments.pin,{revision:1,soulHash:sha('Human SOUL 🦊'),userHash:sha('Human USER'),memoryHash:sha('Human initial')});
 const human=f.save(b,'Human replacement','Current SOUL','Current USER'),count=f.counts();assert.equal((await f.decide(pending)).status,200);assert.equal((await call(p,'memory.append','stale',input)).status,'blocked');assert.deepEqual((({automation,...snapshot})=>snapshot)(f.services.botDocumentsHttp.read(b.id)),(({receipt,...snapshot})=>snapshot)(human));assert.deepEqual(f.counts(),count);
 await assert.rejects(call(p,'memory.append','new-stale',{expectedRevision:1,note:'No new stale proposal'}),code('conflict'));
 const revoked=await call(p,'memory.append','revoke',{expectedRevision:2,note:'Revoked note'});f.services.store.setGrant({botId:b.id,tool,destination:HARNESS_OPERATION_DESTINATION,policy:'deny'});assert.equal((await f.decide(revoked)).status,409);assert.equal(f.services.store.getAction(revoked.actionId).state,'blocked');assert.deepEqual(f.counts(),count);
 assert.ok(!p.surface.listTools(p.token).some(view=>view.name===tool));await assert.rejects(call(p,'memory.append','deny-grant',{expectedRevision:2,note:'No bypass'}),code('forbidden'));
});

test('memory harness: literal duplicate, Unicode/BOM/newlines and canonical history/restore retain existing backup validation',async t=>{
 const f=fixture(t),b=f.bot(),p=f.live(b),initial=f.save(b,'\ufeffHuman\r\nbase');const input={expectedRevision:1,note:'e\u0301\r\nLiteral 🚀'},first=await approved(f,p,'literal',input),repeated=await approved(f,p,'duplicate',{...input,expectedRevision:2});
 assert.equal(repeated.result.documents.revision,2);assert.equal(repeated.result.documents.receipt.note.outcome,'already_present');assert.deepEqual(repeated.result.documents.memoryHead,first.result.documents.memoryHead);
 const normalized=await approved(f,p,'nfc',{expectedRevision:2,note:'é\r\nLiteral 🚀'});assert.equal(normalized.result.documents.revision,3);assert.equal(normalized.result.documents.memory,initial.memory+'\n\n'+input.note+'\n\né\r\nLiteral 🚀');
 const history=await call(p,'memory.history','history',{limit:2});assert.deepEqual(history.result.items.map(row=>row.revision),[3,2]);const revision=await call(p,'memory.read_revision','revision',{revision:2});assert.equal(revision.result.markdown,first.result.documents.memory);
 const restoreInput={expectedRevision:3,fromRevision:1},restorePending=await call(p,'memory.restore','restore',restoreInput);assert.equal((await f.decide(restorePending)).status,200);const restored=await call(p,'memory.restore','restore',restoreInput);assert.equal(restored.result.documents.revision,4);assert.equal(restored.result.documents.memory,initial.memory);assert.equal(restored.result.documents.soul,initial.soul);assert.equal(restored.result.documents.user,initial.user);
 // One valid synthetic current snapshot exercises the retained R2 checker; the old negative campaigns are not rerun.
 const contextPath=join(f.root,'context-inspect.sqlite'),hubPath=join(f.root,'hub-inspect.sqlite');f.services.store.withWriterLease(()=>{for(const [source,dest]of[[f.services.context.databasePath,contextPath],[f.services.store.databasePath,hubPath]]){const db=new DatabaseSync(source);try{db.prepare('VACUUM INTO ?').run(dest);}finally{db.close();}}});
 const db=new DatabaseSync(contextPath,{readOnly:true}),hub=new DatabaseSync(hubPath,{readOnly:true}),limits=gitLimits(resolveLimits());try{validateContext(db,hub,new GitSnapshot(readContextGit(f.services.context.repositoryPath,limits,()=>{}),limits));}finally{db.close();hub.close();}
});

test('memory harness: lost postcommit response and restart recover original receipt without retry, with own conversation isolation',async t=>{
 const f=fixture(t),b=f.bot();f.save(b,'Persistent human base');let effects=0;
 const broken=f.surface(()=>({...f.services.botDocumentsHttp,executeAction:id=>{effects++;const doc=f.services.botDocumentsHttp.executeAction(id);throw new Error('Synthetic response loss after commit '+doc.revision);}})),p=f.live(b,broken),input={expectedRevision:1,note:'Durable approved note'};
 const original=await approved(f,p,'lost',input);assert.equal(original.status,'unknown');assert.equal(original.result.code,'executor_error');assert.equal(original.result.diagnostic.effectMayBePartial,true);assert.equal(original.result.diagnostic.retryAutomatically,false);assert.equal(effects,1);const committed=(await call(p,'memory.receipt','recover',{action_id:original.actionId})).result.documents;assert.equal(committed.revision,2);assert.equal(committed.receipt.note.outcome,'appended');assert.deepEqual(await call(p,'memory.append','lost',input),original);assert.equal(effects,1);
 const other=f.bot(),foreign=f.live(other);await assert.rejects(call(foreign,'memory.receipt','foreign',{action_id:original.actionId}),code('forbidden'));
 const ownOther=f.live(b);await assert.rejects(call(ownOther,'memory.receipt','other-thread',{action_id:original.actionId}),code('forbidden'));ownOther.surface.revokeCapability(ownOther.token);await assert.rejects(call(ownOther,'memory.receipt','revoked',{action_id:original.actionId}),code('unauthorized'));
 const threadId=p.thread.id,botId=b.id,actionId=original.actionId,oldCounts=f.counts();await f.reopen();await f.services.runtime.recoverOwnerActions();await bounded(()=>f.services.store.listTurns(threadId),turns=>turns.every(turn=>!['queued','running'].includes(turn.state)));const resumed=f.live(f.services.store.getBot(botId),f.surface(),f.services.store.getThread(threadId));
 const recovered=await call(resumed,'memory.receipt','restart-receipt',{action_id:actionId});assert.deepEqual(recovered.result.documents,committed);assert.equal(recovered.result.dispatcher.state,'unknown');assert.deepEqual(f.services.botDocumentsHttp.executeAction(actionId),committed);assert.deepEqual(f.counts(),oldCounts);assert.equal(effects,1);
 const ownerRead=await f.request('GET',`/v1/bots/${botId}/documents/receipts/action:${actionId}`);assert.equal(ownerRead.status,200);assert.deepEqual(await ownerRead.json(),committed);
});

test('memory harness: only a real document-origin action can query a receipt; invalid and over-capacity notes have zero documentary effects',async t=>{
 const f=fixture(t),b=f.bot(),p=f.live(b);f.save(b,'x'.repeat(8190));const counts=f.counts();
 const full=await approved(f,p,'overflow',{expectedRevision:1,note:'x'});assert.equal(full.status,'unknown');assert.equal((await call(p,'memory.receipt','absent',{action_id:full.actionId})).result.documents,null);assert.deepEqual(f.counts(),counts);assert.equal(f.services.botDocumentsHttp.read(b.id).memory.length,8190);
 f.services.store.setGrant({botId:b.id,tool:'dexter.harness.bots.create',destination:HARNESS_OPERATION_DESTINATION,policy:'ask'});
 const unrelated=f.services.store.requestAction({botId:b.id,threadId:p.thread.id,tool:'dexter.harness.bots.create',destination:HARNESS_OPERATION_DESTINATION,idempotencyKey:'unrelated',arguments:{input:{},pin:{}}});f.services.store.bindToolAction(unrelated.id,p.turn.id,'unrelated');await assert.rejects(call(p,'memory.receipt','not-document',{action_id:unrelated.id}),code('forbidden'));
 const forged=f.services.store.requestAction({botId:b.id,threadId:p.thread.id,tool,destination:HARNESS_OPERATION_DESTINATION,idempotencyKey:'no-origin',arguments:{input:{expectedRevision:1,note:'Forged lower-level note'},pin:{revision:1,soulHash:sha('Human SOUL 🦊'),userHash:sha('Human USER'),memoryHash:sha('x'.repeat(8190))},origin:{botId:b.id,threadId:p.thread.id,turnId:p.turn.id}}});assert.throws(()=>f.services.store.decideAction(forged.id,{decision:'allow',requestHash:forged.requestHash}),code('conflict'));assert.throws(()=>f.services.botDocumentsHttp.executeAction(forged.id),code('forbidden'));await assert.rejects(call(p,'memory.receipt','fake-origin',{action_id:forged.id}),code('forbidden'));assert.deepEqual(f.counts(),counts);
});

test('memory harness: actual HostServices approval records real effect and feeds one engine continuation after the original turn',async t=>{
 const f=fixture(t,{integrated:true}),b=f.bot();f.save(b,'Human continuation base');const p=f.live(b),input={expectedRevision:1,note:'Continuation note'};
 const pending=await call(p,'memory.append','integrated',input);f.services.store.finishTurn(p.turn.id,'completed',null);assert.equal((await f.decide(pending)).status,200);
 const receipt=await bounded(()=>f.services.store.getAction(pending.actionId),action=>action.state==='succeeded'),doc=receipt.result.documents;await bounded(()=>f.observed,rows=>rows.length===1);const turns=await bounded(()=>f.services.store.listTurns(p.thread.id),turns=>turns.length===2&&turns[1].state==='completed');
 assert.equal(doc.memory,'Human continuation base\n\n'+input.note);assert.equal(doc.receipt.note.outcome,'appended');assert.equal(receipt.authorization.source,'exact_owner');assert.equal(f.observed[0].turnId,turns[1].id);assert.ok(f.observed[0].input.includes(pending.actionId));assert.ok(f.observed[0].input.includes(JSON.stringify(doc.receipt)));assert.ok(f.observed[0].input.includes(JSON.stringify(doc.memory)));assert.equal(f.services.store.toolActionProgress(receipt.id).resultBodyAvailable,true);assert.equal(f.services.store.listMessages(p.thread.id).filter(message=>message.role==='user').length,1);assert.deepEqual(f.counts(),{revisions:2,receipts:2});
 assert.equal((await f.decide(pending)).status,200);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.observed.length,1);assert.equal(f.services.store.listTurns(p.thread.id).length,2);
});
