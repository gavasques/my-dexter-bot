import assert from 'node:assert/strict';
import { createHash, createSecretKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { HostStore } from '../packages/hub/dist/index.js';
import { ContextHost, FixtureMemoryAdapter } from '../packages/context/dist/index.js';
import { AuthorityCoordinator, LocalAuthorityController, captureInspectionSnapshot, restoreForInspection,
 openCheckpointArtifact, INSPECTION_DIR, INSPECTION_FILES } from '../packages/operations/dist/index.js';
import { validateMemoryLedger } from '../packages/operations/dist/memory-ledger.js';
import { checkFullSchema, contextSchemaLabel } from '../packages/operations/dist/full-schemas.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const mapper=botId=>({mapperVersion:1,workspaceId:'synthetic-workspace',botId,accountId:'dx1_'+Buffer.from('synthetic-workspace').toString('hex'),userId:'bot1_'+Buffer.from(botId).toString('hex')});
const key={keyId:'synthetic-ledger-key',use:fn=>fn(createSecretKey(Buffer.alloc(32,7)))};
const code=expected=>error=>error?.code===expected;
function readDB(path,work){const db=new DatabaseSync(path,{readOnly:true});try{return work(db);}finally{db.close();}}
function fixture(t){
 const root=realpathSync(mkdtempSync('/private/tmp/dexter-memory-ledger-backup-r1-')),clock={now:1000};
 const store=new HostStore({dataDir:join(root,'data'),clock:()=>clock.now}),bot=store.createBot({name:'Synthetic',profileId:'synthetic',engine:'codex'}),context=new ContextHost(store,new FixtureMemoryAdapter([]),{memoryIdentityMapper:mapper});
 const ledger=context.memoryLedger;ledger.provisionBotSubject(bot.id);const scope={kind:'bot',botId:bot.id};
 context.compareAndSetBotDocuments(bot.id,{expectedRevision:0,soul:'Synthetic SOUL',user:'Synthetic USER',memory:'Legacy synthetic MEMORY',clientRequestId:'owner-synthetic'});
 const input=(recordId,key,extra={})=>({recordId,botId:bot.id,scope,kind:'fact',expectedRevision:0,policyEpoch:ledger.scopeEpoch(scope),content:'Memória sintética '+recordId,evidenceRefs:['source:'+recordId],operationKey:key,...extra});
 const forgotten=ledger.acceptRevision(input('forgotten-record','forgotten-r1'));ledger.forgetRecord({recordId:forgotten.recordId,expectedRevision:1,policyEpoch:0,operationKey:'forget-operation',suppressionSignature:'forgotten-source'});
 const accepted=ledger.acceptRevision(input('active-record','active-r1'));
 ledger.acceptRevision(input('active-record','active-r2',{expectedRevision:1,content:'Segunda versão sintética'}));
 ledger.createCandidate({...input('candidate-record','candidate-op'),candidateId:'candidate-id',extractorVersion:'synthetic-v1'});
 ledger.enqueueJob({jobId:'claimed-job',recordId:'job-record',botId:bot.id,scope,kind:'synthetic',inputHash:sha('job-source'),evidenceRefs:['source:job-record'],expectedRevision:0,policyEpoch:1,configVersion:'synthetic-v1',operationKey:'job-op'});ledger.claimJob('claimed-job','synthetic-worker',10);
 t.after(()=>{context.close();store.close();rmSync(root,{recursive:true,force:true});});
 return {root,clock,store,bot,context,ledger,scope,input,accepted};
}

test('M02 inspection snapshot/restore includes every ledger row and preserves D24; process work is unknown and cannot run',async t=>{
 const f=fixture(t),latest=f.ledger.listPendingProjections(f.bot.id).items.find(row=>row.recordId==='active-record');assert.ok(latest);
 await f.ledger.projectionJournal('synthetic-projection',10).claim(latest);
 const captured=captureInspectionSnapshot({source:f.store,include:{context:true,agenda:false,deviceRegistry:false,deviceSurface:false},key,output:join(f.root,'inspection.dxg8')});
 assert.equal(captured.counts.context.memoryRecords,2);assert.equal(captured.counts.context.memoryRevisions,3);assert.equal(captured.counts.context.memoryTombstones,1);assert.equal(captured.counts.context.memoryCandidates,1);assert.equal(captured.counts.context.memoryJobs,1);
 const destination=join(f.root,'inspection-restore'),restored=restoreForInspection({artifact:captured.path,key,destination,expect:{ownerId:f.store.ownerId,installationId:f.store.hostId}});
 assert.equal(restored.counts.context.memoryRecords,2);
 readDB(join(destination,INSPECTION_DIR,INSPECTION_FILES.context),db=>{
  assert.equal(contextSchemaLabel(db),'context-v3-memory-ledger');checkFullSchema(db,'context');
  readDB(join(destination,INSPECTION_DIR,INSPECTION_FILES.hub),hub=>validateMemoryLedger(db,hub));
  assert.equal(db.prepare('SELECT state,lease_owner FROM memory_jobs').get().state,'unknown');assert.equal(db.prepare('SELECT lease_owner FROM memory_jobs').get().lease_owner,null);
  assert.equal(db.prepare("SELECT state FROM memory_projection_outbox WHERE record_id='active-record' AND revision=2").get().state,'unknown');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bot_document_revisions').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bot_document_receipts').get().n,1);
  assert.equal(db.prepare("SELECT state FROM memory_records WHERE id='forgotten-record'").get().state,'forgotten');
 });
 // Sanitization touched the staged copy only; live lease and dispatch are still exactly the source's work.
 readDB(f.context.databasePath,db=>{assert.equal(db.prepare('SELECT state FROM memory_jobs').get().state,'claimed');assert.equal(db.prepare("SELECT state FROM memory_projection_outbox WHERE record_id='active-record' AND revision=2").get().state,'dispatched');});
});

test('M02 authority checkpoint + owner-receipted restore retains identities/revisions/operations/tombstones and reconciles unknown without another send',async t=>{
 const f=fixture(t),latest=f.ledger.listPendingProjections(f.bot.id).items.find(row=>row.recordId==='active-record');await f.ledger.projectionJournal('synthetic-projection',10).claim(latest);
 const before=f.ledger.subject(f.bot.id),firstInput=f.input('active-record','active-r1'),keys=generateKeyPairSync('ed25519'),owner={publicKey:keys.publicKey,sign:bytes=>sign(null,bytes,keys.privateKey)};
 const coordinator=AuthorityCoordinator.open(join(f.root,'coordinator'),{ownerId:f.store.ownerId,ownerPublicKey:owner.publicKey}),controller=new LocalAuthorityController({coordinator,clock:()=>f.clock.now});t.after(()=>coordinator.close());
 f.context.close();const hold=await controller.quiesce({quiesceForMaintenance:async()=>f.store}),prepared=controller.prepare(hold,{key,output:join(f.root,'checkpoint.dxg8')}),opened=openCheckpointArtifact(prepared.artifact.path,key);
 assert.equal(opened.manifest.schemas.context,'context-v3-memory-ledger');assert.equal(opened.manifest.counts.context.memoryProjectionOutbox,4);
 const destination=join(f.root,'activated');controller.revokeSource({store:f.store},prepared.checkpointId,destination);const receipt=controller.issueReceipt(owner,prepared.checkpointId);controller.activate({artifact:prepared.artifact.path,key,receipt});
 const restoredStore=new HostStore({dataDir:destination,clock:()=>f.clock.now}),restoredContext=new ContextHost(restoredStore,new FixtureMemoryAdapter([]),{memoryIdentityMapper:mapper});
 try{
  const ledger=restoredContext.memoryLedger;assert.deepEqual(ledger.subject(f.bot.id),before);assert.deepEqual(ledger.acceptRevision(firstInput),f.accepted);
  assert.equal(ledger.readRevision('active-record').content,'Segunda versão sintética');assert.equal(restoredContext.readBotDocuments(f.bot.id).memory,'Legacy synthetic MEMORY');
  assert.throws(()=>ledger.readRevision('forgotten-record'),code('forbidden'));
  assert.throws(()=>ledger.acceptRevision({...firstInput,recordId:'resurrection-record',operationKey:'resurrection',content:'Different paraphrase',evidenceRefs:['source:forgotten-record']}),code('conflict'));
  assert.throws(()=>ledger.claimJob('claimed-job','restored-worker'),code('conflict'),'restored unknown job needs explicit reconciliation');
  const binding=ledger.projectionBinding(latest.operationKey),journal=ledger.projectionJournal('restored-projection');assert.equal(await journal.claim(binding),'reconcile');await journal.record({...binding,outcome:'confirmed',indexing:'unproven',taskId:null,reason:null});
  readDB(restoredContext.databasePath,db=>readDB(restoredStore.databasePath,hub=>{checkFullSchema(db,'context');validateMemoryLedger(db,hub);}));
 }finally{restoredContext.close();restoredStore.close();}
});

test('M02 staged validator rejects altered canonical hash, orphan intent, incomplete tombstone and spoofed identity',t=>{
 const f=fixture(t);
 f.store.withWriterLease(()=>{
  const db=new DatabaseSync(f.context.databasePath),hub=new DatabaseSync(f.store.databasePath,{readOnly:true});try{
   validateMemoryLedger(db,hub);
   for(const sql of ["UPDATE memory_projection_outbox SET content_hash='0000000000000000000000000000000000000000000000000000000000000000' WHERE record_id='active-record' AND revision=2", "DELETE FROM memory_projection_outbox WHERE record_id='active-record' AND revision=2", "UPDATE memory_tombstones SET evidence_json='[]'", "UPDATE memory_subjects SET user_id='bot1_spoofed'"]){
    db.exec('BEGIN');try{if(sql.includes('memory_tombstones'))db.exec('DROP TRIGGER memory_tombstones_immutable_update');if(sql.includes('memory_subjects'))db.exec('DROP TRIGGER memory_subjects_immutable_update');db.exec(sql);assert.throws(()=>validateMemoryLedger(db,hub),code('reference_broken'));}finally{db.exec('ROLLBACK');}
   }
   validateMemoryLedger(db,hub);
  }finally{db.close();hub.close();}
 });
});
