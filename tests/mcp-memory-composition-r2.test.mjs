import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createSecretKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { HostServices } from '../packages/cli/dist/host-services.js';
import { HarnessOperationSurface } from '../packages/cli/dist/harness-operation-surface.js';
import { MemoryRoutineRunner, MemoryRoutineSurface, MEMORY_ROUTINE_DESTINATION } from '../packages/context/dist/index.js';
import { MEMORY_ROUTINE_META_KEY } from '../packages/contracts/dist/index.js';
import { canonicalJson, dispatchAction } from '../packages/hub/dist/index.js';
import { AuthorityCoordinator, LocalAuthorityController, openCheckpointArtifact } from '../packages/operations/dist/index.js';
import { checkFullSchema, contextSchemaLabel, FULL_SCHEMAS } from '../packages/operations/dist/full-schemas.js';
import { decodeCheckpointManifest, gitSnapshotOf } from '../packages/operations/dist/checkpoint.js';
import { validateContext } from '../packages/operations/dist/validate.js';
import { gitLimits, resolveLimits } from '../packages/operations/dist/manifest.js';
import { readContextGit } from '../packages/operations/dist/git.js';
const sha = s => createHash('sha256').update(s).digest('hex');
const failure = e => ['reference_broken','corrupt','unsupported_schema'].includes(e?.code);
const rows = (path, query) => { const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare(query).all();}finally{db.close();} };

function fixture(t) {
 const root=realpathSync(mkdtempSync('/private/tmp/dexter-composition-r2-synthetic-')),dataDir=join(root,'host');
 const noEngine={enableMcp:true,enableEngines:true,engineCommands:{codex:'/usr/bin/false'},makeDriver:id=>({id,capabilities:{resume:true,interrupt:true,fork:false,steer:false},status:async()=>({engine:id,installed:true,authentication:'unverified',billing:'unknown'}),open:async()=>{throw Error('Synthetic backup must not open a driver');},async*turn(){throw Error('Synthetic backup must not dispatch a driver');},respondToTool:async()=>{},interrupt:async()=>{},close:async()=>{}}),engineCatalog:()=>[{id:'codex',available:true,defaultModel:'synthetic',models:[{id:'synthetic',reasoningEfforts:[],speeds:[]}],reasoningEfforts:[],speeds:[]}]};
 let services=new HostServices({dataDir,...noEngine,memoryRoutines:{}}),sequence=0,extractCalls=0; const active=[],surfaces=[];
 const live=bot=>{const thread=services.store.createThread(bot.id),turn=services.store.createTurn(thread.id,{clientRequestId:'review-'+(++sequence),content:'Synthetic owner review intent'}).turn;services.store.claimNextTurn(thread.id);
  const base=new HarnessOperationSurface({store:services.store,base:services.gateway,catalog:async()=>[],runtime:()=>undefined,skills:()=>undefined,documents:()=>services.botDocumentsHttp,effectiveSkills:()=>[]});
  const runner=new MemoryRoutineRunner(services.context.memoryRoutines,{extract:async()=>{extractCalls++;return{classification:'context',note:'Synthetic short candidate e\u0301 🦊'};}}),surface=new MemoryRoutineSurface(services.store,base,services.context.memoryRoutines,runner);
  active.push(turn);surfaces.push({base,runner,surface});return{bot,thread,turn,runner,surface,token:surface.issueCapability({turnId:turn.id}).token};};
 const call=(p,name,id,args={})=>p.surface.call(p.token,{connectionId:MEMORY_ROUTINE_DESTINATION,tool:'dexter.memory.'+name,callId:id,arguments:args});
 const policy=async(p,id,input)=>{const pending=await call(p,'policy.update',id,input);assert.equal(pending.status,'awaiting_approval');services.store.decideAction(pending.actionId,{decision:'allow',requestHash:pending.requestHash});const done=await call(p,'policy.update',id,input);assert.equal(done.status,'succeeded');return done;};
 const commit=async(action)=>{services.store.decideAction(action.actionId,{decision:'allow',requestHash:action.requestHash});const done=await dispatchAction(services.store,action.actionId,async()=>({documents:services.botDocumentsHttp.executeAction(action.actionId)}));services.store.recordToolOutcome(done.id,done.result);assert.equal(done.state,'succeeded');return done;};
 const finish=()=>{for(const turn of active)if(services.store.getTurn(turn.id).state==='running')services.store.finishTurn(turn.id,'completed',null);};
 const drain=async()=>{finish();for(const {base,runner,surface}of surfaces.splice(0)){await surface.close();await runner.close();await base.close();}};
 t.after(async()=>{await drain();await services.shutdown();rmSync(root,{recursive:true,force:true});});
 return{root,dataDir,get services(){return services;},live,call,policy,commit,finish,drain,get extractCalls(){return extractCalls;},async restored(path){await services.shutdown();services=new HostServices({dataDir:path,...noEngine,memoryRoutines:{extractor:{extract:async()=>{extractCalls++;throw Error('restore must never extract');}}}});}};
}

test('composition R2: opt-in capture and literal maintenance checkpoint/activation retain truthful history, disable namespace and zero replay authority',async t=>{
 const f=fixture(t),bot=f.services.store.createBot({name:'Synthetic memory backup',profileId:'synthetic',engine:'codex'}),p=f.live(bot);
 const initial=f.services.botDocumentsHttp.compareAndSet(bot.id,{expectedRevision:0,soul:'Human SOUL 🦊',user:'Human USER',memory:'\ufeffHuman\r\nbase\n\nRepeat e\u0301\n\nRepeat e\u0301\n\nRepeat é',clientRequestId:'initial-human'});
 const enabled=await f.policy(p,'enable',{expectedRevision:0,enabled:true,maintenanceEnabled:true});
 const sourceThread=f.services.store.createThread(bot.id),source=f.services.store.createTurn(sourceThread.id,{clientRequestId:'completed-source',content:'Synthetic user input is not candidate text'}).turn;
 f.services.store.claimNextTurn(sourceThread.id);f.services.store.appendTurnDelta(source.id,'Synthetic assistant source completed e\u0301 🦊');f.services.store.finishTurn(source.id,'completed',null);await p.runner.observe(source.id);
 const job=f.services.context.memoryRoutines.jobs(bot.id)[0];assert.equal(job.state,'candidate');assert.equal(f.extractCalls,1);
 const proposal=await f.call(p,'capture.propose','capture',{job_id:job.id}),appended=await f.commit(proposal);assert.equal(appended.result.documents.receipt.operation,'append');
 assert.deepEqual(f.services.botDocumentsHttp.executeAction(proposal.actionId),appended.result.documents);assert.equal(f.services.botDocumentsHttp.read(bot.id).revision,2);
 const preview=(await f.call(p,'maintenance.preview','preview')).result,maintenance=await f.call(p,'maintenance.propose','maintain',{expectedRevision:preview.expectedRevision,memoryHash:preview.memoryHash,nextMemoryHash:preview.nextMemoryHash});
 const maintained=await f.commit(maintenance);assert.equal(maintained.result.documents.revision,3);assert.equal(maintained.result.documents.soul,initial.soul);assert.equal(maintained.result.documents.user,initial.user);
 const disabled=await f.policy(p,'disable',{expectedRevision:1,enabled:false,maintenanceEnabled:false});assert.equal(disabled.result.policyReceipt.policy.revision,2);
 const other=f.services.store.createBot({name:'Synthetic in-flight restore',profileId:'synthetic',engine:'codex'}),q=f.live(other);await f.policy(q,'enabled-before-checkpoint',{expectedRevision:0,enabled:true,maintenanceEnabled:false});
 const otherThread=f.services.store.createThread(other.id),otherSource=f.services.store.createTurn(otherThread.id,{clientRequestId:'inflight-source',content:'Synthetic original input'}).turn;f.services.store.claimNextTurn(otherThread.id);f.services.store.appendTurnDelta(otherSource.id,'Synthetic pending literal excerpt');f.services.store.finishTurn(otherSource.id,'completed',null);
 const extracting=f.services.context.memoryRoutines.beginCapture(otherSource.id);assert.equal(extracting.job.state,'extracting');
 const namespace=rows(f.services.context.databasePath,`SELECT value FROM meta WHERE key='${MEMORY_ROUTINE_META_KEY}'`)[0].value;assert.ok(namespace.includes(enabled.actionId));assert.ok(namespace.includes(job.id));
 await f.drain();const originalReceipts=rows(f.services.context.databasePath,'SELECT * FROM bot_document_receipts ORDER BY operation_key');
 const {privateKey,publicKey}=generateKeyPairSync('ed25519'),secret=createSecretKey(randomBytes(32)),key={keyId:'synthetic-composition-r2',use:fn=>fn(secret)},owner={publicKey,sign:bytes=>sign(null,bytes,privateKey)};
 const coordinator=AuthorityCoordinator.open(join(f.root,'coordinator'),{ownerId:f.services.store.ownerId,ownerPublicKey:publicKey});t.after(()=>coordinator.close());
 const control=new LocalAuthorityController({coordinator}),hold=await control.quiesce(f.services),artifact=join(f.root,'routine.dxg8'),dest=join(f.root,'restored');
 const prepared=control.prepare(hold,{output:artifact,key}),decoded=openCheckpointArtifact(artifact,key);assert.equal(decoded.manifest.schemas.context,'context-v2-document-history-memory-routines-v1');
 assert.equal(decoded.manifest.counts.context.routinePolicies,2);assert.equal(decoded.manifest.counts.context.routinePolicyReceipts,3);assert.equal(decoded.manifest.counts.context.routineJobs,3);
 const missing=structuredClone(decoded.manifest);delete missing.counts.context.routineJobs;assert.throws(()=>decodeCheckpointManifest(missing,resolveLimits()),failure);
 const old=structuredClone(decoded.manifest);old.schemas.context='context-v2-document-history';for(const k of ['routinePolicies','routinePolicyReceipts','routineJobs'])delete old.counts.context[k];assert.doesNotThrow(()=>decodeCheckpointManifest(old,resolveLimits()));
 control.revokeSource({store:f.services.store},prepared.checkpointId,dest);control.activate({artifact,key,receipt:control.issueReceipt(owner,prepared.checkpointId)});
 assert.deepEqual(rows(join(dest,'context.sqlite'),'SELECT * FROM bot_document_receipts ORDER BY operation_key'),originalReceipts);
 const recoveredNamespace=JSON.parse(rows(join(dest,'context.sqlite'),`SELECT value FROM meta WHERE key='${MEMORY_ROUTINE_META_KEY}'`)[0].value),originalNamespace=JSON.parse(namespace);
 assert.deepEqual(recoveredNamespace.policies,originalNamespace.policies);assert.deepEqual(recoveredNamespace.receipts,originalNamespace.receipts);assert.deepEqual(recoveredNamespace.jobs[job.id],originalNamespace.jobs[job.id]);assert.equal(recoveredNamespace.jobs[extracting.job.id].state,'unknown');assert.equal(recoveredNamespace.jobs[extracting.job.id].note,null);
 assert.equal(rows(join(dest,'dexter.sqlite'),"SELECT policy FROM grants WHERE tool='dexter.memory.policy.update'")[0].policy,'deny');
 await f.restored(dest);assert.equal(f.services.context.memoryRoutines.status(bot.id,true).effectiveEnabled,false);assert.equal(f.services.context.memoryRoutines.status(other.id,true).effectiveEnabled,false);assert.equal(f.services.context.memoryRoutines.jobs(other.id)[0].state,'unknown');assert.equal(f.extractCalls,1);assert.equal(f.services.botDocumentsHttp.read(bot.id).memory,maintained.result.documents.memory);
 assert.deepEqual(f.services.botDocumentsHttp.executeAction(proposal.actionId),appended.result.documents);assert.equal(f.services.botDocumentsHttp.read(bot.id).revision,3);assert.equal(f.extractCalls,1);
});

test('composition R2: schema1/2 zero histories stay admitted; forged closed metadata, recomputed hashes, source/pins/action correlation and arbitrary maintenance reject',async t=>{
 const f=fixture(t),bot=f.services.store.createBot({name:'Synthetic corruption guard',profileId:'synthetic',engine:'codex'}),p=f.live(bot);
 f.services.botDocumentsHttp.compareAndSet(bot.id,{expectedRevision:0,soul:'Literal SOUL',user:'Literal USER',memory:'A\n\nA',clientRequestId:'base'});await f.policy(p,'enable',{expectedRevision:0,enabled:true,maintenanceEnabled:true});
 const preview=(await f.call(p,'maintenance.preview','preview')).result,proposal=await f.call(p,'maintenance.propose','maintain',{expectedRevision:preview.expectedRevision,memoryHash:preview.memoryHash,nextMemoryHash:preview.nextMemoryHash});await f.commit(proposal);
 const sourceThread=f.services.store.createThread(bot.id),source=f.services.store.createTurn(sourceThread.id,{clientRequestId:'real-capture-source',content:'Synthetic source input'}).turn;f.services.store.claimNextTurn(sourceThread.id);f.services.store.appendTurnDelta(source.id,'Synthetic canonical assistant source');f.services.store.finishTurn(source.id,'completed',null);await p.runner.observe(source.id);f.finish();
 const original=JSON.parse(rows(f.services.context.databasePath,`SELECT value FROM meta WHERE key='${MEMORY_ROUTINE_META_KEY}'`)[0].value),sourcePath=f.services.context.databasePath,hubPath=f.services.store.databasePath;
 const validate=db=>{checkFullSchema(db,'context');const hub=new DatabaseSync(hubPath,{readOnly:true});try{const members=readContextGit(join(f.dataDir,'context-revisions'),gitLimits(resolveLimits()),()=>{});validateContext(db,hub,gitSnapshotOf(members,resolveLimits()).snapshot);}finally{hub.close();}};
 const good=new DatabaseSync(sourcePath,{readOnly:true});try{assert.doesNotThrow(()=>validate(good));assert.equal(contextSchemaLabel(good),'context-v2-document-history-memory-routines-v1');}finally{good.close();}
 const maintenanceJob=data=>Object.values(data.jobs).find(j=>j.kind==='maintenance'),captureJob=data=>Object.values(data.jobs).find(j=>j.kind==='capture');
 const mutations=[data=>{const receipt=Object.values(data.receipts)[0];receipt.inputHash=sha(canonicalJson({expectedRevision:0,enabled:false,maintenanceEnabled:false,minIntervalMs:60000,maxNotesPerDay:4,maxNoteCharacters:512}));receipt.policy.enabled=false;data.policies[bot.id].enabled=false;},data=>{maintenanceJob(data).nextMemoryHash=sha('arbitrary rewrite');},data=>{maintenanceJob(data).actionId=Object.keys(data.receipts)[0];},data=>{captureJob(data).source.outputHash=sha('forged source with recomputed digest');},data=>{const id=Object.keys(data.jobs)[0];data.jobs['0'.repeat(64)]=data.jobs[id];delete data.jobs[id];}];
 for(let i=0;i<mutations.length;i++){const path=join(f.root,'tamper-'+i+'.sqlite'),source=new DatabaseSync(sourcePath,{readOnly:true});try{source.exec(`VACUUM INTO '${path}'`);}finally{source.close();}const db=new DatabaseSync(path);try{const data=structuredClone(original);mutations[i](data);db.prepare('UPDATE meta SET value=? WHERE key=?').run(canonicalJson(data),MEMORY_ROUTINE_META_KEY);assert.throws(()=>validate(db),failure);}finally{db.close();}}
 for(const schema of ['1','2']){const db=new DatabaseSync(':memory:');try{if(schema==='2')db.exec(FULL_SCHEMAS.context.sql);else{const sql=FULL_SCHEMAS.context.sql.split('CREATE TABLE bot_document_revisions')[0];db.exec(sql);}for(const [key,value]of [['owner',f.services.store.ownerId],['installation',f.services.store.hostId],['schema',schema]])db.prepare('INSERT INTO meta VALUES(?,?)').run(key,value);assert.doesNotThrow(()=>checkFullSchema(db,'context'));assert.equal(contextSchemaLabel(db),schema==='2'?'context-v2-document-history':'context-v1-bot-documents');}finally{db.close();}}
});

test('composition R2: default first-party completed assistant excerpt generates only literal suggested text, owner append/replay/undo preserve human docs',async t=>{
 const root=realpathSync(mkdtempSync('/private/tmp/dexter-literal-default-r2-synthetic-')),dataDir=join(root,'host');let driverCalls=0;
 const text='  Synthetic completed assistant excerpt e\u0301 🦊. '+('word '.repeat(140));
 const makeDriver=id=>({id,capabilities:{resume:true,interrupt:true,fork:false,steer:false},status:async()=>({engine:id,installed:true,authentication:'unverified',billing:'unknown'}),open:async threadId=>({threadId,nativeCursor:'synthetic-literal-source'}),async*turn(session,turnId){driverCalls++;yield{type:'text.delta',threadId:session.threadId,turnId,text};yield{type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},respondToTool:async()=>{},interrupt:async()=>{},close:async()=>{}});
 const services=new HostServices({dataDir,enableMcp:true,enableEngines:true,engineCommands:{codex:'/usr/bin/false'},makeDriver,engineCatalog:()=>[{id:'codex',available:true,defaultModel:'synthetic',models:[{id:'synthetic',reasoningEfforts:[],speeds:[]}],reasoningEfforts:[],speeds:[]}]});
 const bot=services.store.createBot({name:'Synthetic literal default',profileId:'synthetic',engine:'codex'}),thread=services.store.createThread(bot.id),turn=services.store.createTurn(thread.id,{clientRequestId:'owner-review',content:'Synthetic explicit owner review'}).turn;services.store.claimNextTurn(thread.id);
 const base=new HarnessOperationSurface({store:services.store,base:services.gateway,catalog:services.engineCatalog,runtime:()=>services.runtime,skills:()=>undefined,documents:()=>services.botDocumentsHttp,effectiveSkills:()=>[]}),runner=new MemoryRoutineRunner(services.context.memoryRoutines),surface=new MemoryRoutineSurface(services.store,base,services.context.memoryRoutines,runner),token=surface.issueCapability({turnId:turn.id}).token;
 t.after(async()=>{if(services.store.getTurn(turn.id).state==='running')services.store.finishTurn(turn.id,'completed',null);await surface.close();await runner.close();await base.close();await services.shutdown();rmSync(root,{recursive:true,force:true});});
 const initial=services.botDocumentsHttp.compareAndSet(bot.id,{expectedRevision:0,soul:'Literal SOUL 🦊',user:'Literal USER',memory:'\ufeffHuman\r\nMEMORY',clientRequestId:'owner-initial'});
 const call=(name,id,args={})=>surface.call(token,{connectionId:MEMORY_ROUTINE_DESTINATION,tool:'dexter.memory.'+name,callId:id,arguments:args});
 const pending=await call('policy.update','enable',{expectedRevision:0,enabled:true,maintenanceEnabled:false});services.store.decideAction(pending.actionId,{decision:'allow',requestHash:pending.requestHash});assert.equal((await call('policy.update','enable',{expectedRevision:0,enabled:true,maintenanceEnabled:false})).status,'succeeded');
 const sourceThread=services.store.createThread(bot.id),source=services.runtime.startTurn(sourceThread.id,{clientRequestId:'literal-default-source',content:'Synthetic source request'}).turn;assert.equal((await services.runtime.waitForTurn(source.id,6000)).state,'completed');
 let job;const deadline=Date.now()+3000;while(!(job=services.context.memoryRoutines.jobs(bot.id).find(j=>j.state==='candidate'))){if(Date.now()>deadline)throw Error('Synthetic literal default candidate missing');await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal(driverCalls,1);assert.ok(job.note.length<=512);assert.ok(job.note.isWellFormed());assert.ok(text.includes(job.note));assert.equal(job.source.outputHash,sha(text));assert.equal(job.source.role,'assistant');assert.equal(services.botDocumentsHttp.read(bot.id).revision,1);
 const proposal=await call('capture.propose','append',{job_id:job.id});services.store.decideAction(proposal.actionId,{decision:'allow',requestHash:proposal.requestHash});const done=await dispatchAction(services.store,proposal.actionId,async()=>({documents:services.botDocumentsHttp.executeAction(proposal.actionId)}));services.store.recordToolOutcome(done.id,done.result);assert.equal(done.state,'succeeded');assert.equal(done.result.documents.memory,initial.memory+'\n\n'+job.note);
 assert.deepEqual(services.botDocumentsHttp.executeAction(proposal.actionId),done.result.documents);assert.equal(services.botDocumentsHttp.read(bot.id).revision,2);
 const restore=await surface.call(token,{connectionId:'dexter-harness-owner-proposals',tool:'dexter.harness.memory.restore',callId:'undo-literal',arguments:{expectedRevision:2,fromRevision:1}});services.store.decideAction(restore.actionId,{decision:'allow',requestHash:restore.requestHash});const undone=await dispatchAction(services.store,restore.actionId,async()=>({documents:services.botDocumentsHttp.executeAction(restore.actionId)}));assert.equal(undone.state,'succeeded');assert.equal(undone.result.documents.memory,initial.memory);assert.equal(undone.result.documents.soul,initial.soul);assert.equal(undone.result.documents.user,initial.user);assert.equal(driverCalls,1);
});
