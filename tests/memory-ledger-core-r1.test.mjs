import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { HostStore } from '../packages/hub/dist/index.js';
import { ContextHost, FixtureMemoryAdapter, MEMORY_LEDGER_TABLES } from '../packages/context/dist/index.js';
import { MEMORY_ROUTINE_META_KEY } from '../packages/contracts/dist/index.js';
import { checkFullSchema, contextSchemaLabel } from '../packages/operations/dist/full-schemas.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const code=expected=>error=>error?.code===expected;
const mapper=botId=>({mapperVersion:1,workspaceId:'synthetic-workspace',botId,accountId:'dx1_'+Buffer.from('synthetic-workspace').toString('hex'),userId:'bot1_'+Buffer.from(botId).toString('hex')});
function fixture(t){
 const root=realpathSync(mkdtempSync('/private/tmp/dexter-memory-ledger-core-r1-')),clock={now:1000};
 const store=new HostStore({dataDir:join(root,'data'),clock:()=>clock.now}),bot=store.createBot({name:'Synthetic',profileId:'synthetic',engine:'codex'});
 let context=new ContextHost(store,new FixtureMemoryAdapter([]),{memoryIdentityMapper:mapper});context.memoryLedger.provisionBotSubject(bot.id);
 const sql=work=>store.withWriterLease(()=>{const db=new DatabaseSync(context.databasePath);try{return work(db);}finally{db.close();}});
 const scope={kind:'bot',botId:bot.id};
 const input=(key='accept-r1',extra={})=>({recordId:'record-synthetic',botId:bot.id,scope,kind:'fact',expectedRevision:0,policyEpoch:0,content:'Texto sintético e\u0301 🚀',evidenceRefs:['turn-synthetic:message-1'],operationKey:key,...extra});
 const reopen=()=>{context.close();context=new ContextHost(store,new FixtureMemoryAdapter([]),{memoryIdentityMapper:mapper});return context.memoryLedger;};
 t.after(()=>{context.close();store.close();rmSync(root,{recursive:true,force:true});});
 return {root,store,bot,clock,scope,input,sql,reopen,get context(){return context;},get ledger(){return context.memoryLedger;}};
}

test('M02 stable versioned full identity survives rename/reopen; no mapper or scope escalation is admitted',t=>{
 const f=fixture(t),identity=f.ledger.subject(f.bot.id);
 f.store.patchBot(f.bot.id,{expectedRevision:f.bot.revision,name:'Renamed synthetic'});
 assert.deepEqual(f.ledger.provisionBotSubject(f.bot.id),identity);assert.deepEqual(f.reopen().subject(f.bot.id),identity);
 const other=f.store.createBot({name:'Other synthetic',profileId:'synthetic',engine:'codex'});f.ledger.provisionBotSubject(other.id);
 assert.throws(()=>f.ledger.acceptRevision(f.input('scope-escalation',{scope:{kind:'bot',botId:other.id}})),code('forbidden'));
 assert.throws(()=>f.ledger.acceptRevision(f.input('team-unimplemented',{scope:{kind:'team',teamId:'synthetic-team'}})),code('forbidden'));
 f.context.close();const unconfigured=new ContextHost(f.store,new FixtureMemoryAdapter([]));
 assert.equal(unconfigured.memoryLedger.status().identityMapper,'unconfigured');assert.throws(()=>unconfigured.memoryLedger.provisionBotSubject(other.id),code('conflict'));unconfigured.close();
});

test('M02 accepted revisions and operation keys replay exactly; head/content reuse conflict and immutable history stays intact',t=>{
 const f=fixture(t),first=f.ledger.acceptRevision(f.input());
 assert.deepEqual(f.ledger.acceptRevision(f.input()),first);
 assert.throws(()=>f.ledger.acceptRevision(f.input('accept-r1',{content:'Alterado'})),code('conflict'));
 const second=f.ledger.acceptRevision(f.input('accept-r2',{expectedRevision:1,content:'Segunda revisão'}));assert.equal(second.revision,2);
 assert.deepEqual(f.ledger.acceptRevision(f.input()),first);
 assert.throws(()=>f.ledger.acceptRevision(f.input('stale-head')),code('conflict'));
 assert.throws(()=>f.ledger.acceptRevision(f.input('stale-epoch',{expectedRevision:2,policyEpoch:1})),code('conflict'));
 assert.equal(f.ledger.readRevision('record-synthetic',1).content,f.input().content);
});

test('M02 a projection insertion failure rolls back the accepted revision, head and durable receipt together',t=>{
 const f=fixture(t);f.ledger.acceptRevision(f.input());
 f.sql(db=>db.exec("CREATE TRIGGER synthetic_projection_failure BEFORE INSERT ON memory_projection_outbox BEGIN SELECT RAISE(ABORT,'synthetic fault'); END;"));
 assert.throws(()=>f.ledger.acceptRevision(f.input('failed-r2',{expectedRevision:1,content:'Segunda revisão'})),/synthetic fault/);
 f.sql(db=>{
  assert.equal(db.prepare('SELECT head_revision FROM memory_records').get().head_revision,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_revisions').get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_projection_outbox WHERE revision=2").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_ledger_operations WHERE operation_key='failed-r2'").get().n,0);
  db.exec('DROP TRIGGER synthetic_projection_failure');
 });
 const next=f.ledger.acceptRevision(f.input('failed-r2',{expectedRevision:1,content:'Segunda revisão'}));assert.equal(next.revision,2);
 assert.throws(()=>f.sql(db=>db.exec("UPDATE memory_revisions SET content='tampered'")),/immutable memory revision/);
 assert.throws(()=>f.sql(db=>db.exec('DELETE FROM memory_revisions')),/immutable memory revision/);
});

test('M02 candidates are staging only; accept requires their exact source/version and persists candidate state with acceptance',t=>{
 const f=fixture(t),input={...f.input('candidate-operation'),candidateId:'candidate-synthetic',extractorVersion:'synthetic-v1'};delete input.kind;
 assert.deepEqual(f.ledger.createCandidate(input),{candidateId:'candidate-synthetic',state:'pending'});
 assert.deepEqual(f.ledger.createCandidate(input),{candidateId:'candidate-synthetic',state:'pending'});
 assert.throws(()=>f.ledger.readRevision('record-synthetic'),code('not_found'));
 assert.throws(()=>f.ledger.acceptRevision(f.input('accept-candidate-bad',{candidateId:input.candidateId,content:'Outro texto'})),code('conflict'));
 const accepted=f.ledger.acceptRevision(f.input('accept-candidate',{candidateId:input.candidateId}));assert.equal(accepted.revision,1);
 f.sql(db=>assert.equal(db.prepare('SELECT state FROM memory_candidates').get().state,'accepted'));
});

test('M02 job lease/fence, expected head and epoch block late workers; committed result replay is durable',t=>{
 const f=fixture(t),job={jobId:'job-synthetic',recordId:'record-synthetic',botId:f.bot.id,scope:f.scope,kind:'synthetic-extract',inputHash:sha('source'),evidenceRefs:f.input().evidenceRefs,expectedRevision:0,policyEpoch:0,configVersion:'synthetic-v1',operationKey:'job-operation'};
 f.ledger.enqueueJob(job);assert.deepEqual(f.ledger.enqueueJob(job),{jobId:job.jobId});
 const first=f.ledger.claimJob(job.jobId,'worker-A',10);assert.throws(()=>f.ledger.claimJob(job.jobId,'worker-B'),code('conflict'));
 f.clock.now+=11;const second=f.ledger.claimJob(job.jobId,'worker-B',10);assert.equal(second.fence,first.fence+1);
 assert.throws(()=>f.ledger.commitJobRevision(first,f.input('job-accept')),code('conflict'));
 const accepted=f.ledger.commitJobRevision(second,f.input('job-accept'));assert.deepEqual(f.ledger.commitJobRevision(second,f.input('job-accept')),accepted);
 const secondJob={...job,jobId:'epoch-job',recordId:'epoch-record',operationKey:'epoch-operation'};f.ledger.enqueueJob(secondJob);const claim=f.ledger.claimJob(secondJob.jobId,'worker-C');
 assert.equal(f.ledger.advanceScopeEpoch(f.scope,0),1);
 assert.throws(()=>f.ledger.commitJobRevision(claim,f.input('epoch-accept',{recordId:'epoch-record'})),code('conflict'));
});

test('M02 dispatch journal survives reopen: sent operation reconciles, stale fence/binding cannot confirm, confirmed receipt cannot downgrade',async t=>{
 const f=fixture(t),accepted=f.ledger.acceptRevision(f.input()),binding=f.ledger.projectionBinding(accepted.projectionOperationKey),first=f.ledger.projectionJournal('worker-A',10);
 assert.equal(await first.claim(binding),'send');
 await assert.rejects(first.claim({...binding,sha256:'0'.repeat(64)}),code('conflict'));
 f.clock.now+=11;const reopened=f.reopen(),second=reopened.projectionJournal('worker-B',10);assert.equal(await second.claim(binding),'reconcile');
 // A separate facade with the old fence is rejected after the durable reclaim.
 const stale=f.ledger.projectionJournal('worker-C',10);await assert.rejects(stale.claim(binding),code('conflict'));
 await second.record({...binding,outcome:'unknown',indexing:'unproven',taskId:null,reason:'missing'});
 const third=f.ledger.projectionJournal('worker-D',10);assert.equal(await third.claim(binding),'reconcile');await third.record({...binding,outcome:'confirmed',indexing:'unproven',taskId:null,reason:null});
 const fourth=f.ledger.projectionJournal('worker-E',10);assert.equal(await fourth.claim(binding),'reconcile');await assert.rejects(fourth.record({...binding,outcome:'unknown',indexing:'unproven',taskId:null,reason:'missing'}),code('conflict'));
 await fourth.record({...binding,outcome:'confirmed',indexing:'unproven',taskId:null,reason:null});
 f.sql(db=>{assert.equal(db.prepare('SELECT state FROM memory_projection_outbox').get().state,'confirmed');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_projection_receipts').get().n,3);});
});

test('M02 forget is durable, suppresses source replay and late confirmations; purge stays explicitly pending',async t=>{
 const f=fixture(t),accepted=f.ledger.acceptRevision(f.input()),binding=f.ledger.projectionBinding(accepted.projectionOperationKey),journal=f.ledger.projectionJournal('worker-A');await journal.claim(binding);
 const job={jobId:'forget-job',recordId:'record-synthetic',botId:f.bot.id,scope:f.scope,kind:'synthetic',inputHash:sha('source'),evidenceRefs:f.input().evidenceRefs,expectedRevision:1,policyEpoch:0,configVersion:'synthetic-v1',operationKey:'forget-job-operation'};f.ledger.enqueueJob(job);const claim=f.ledger.claimJob(job.jobId,'worker-B');
 const input={recordId:'record-synthetic',expectedRevision:1,policyEpoch:0,operationKey:'forget-operation',suppressionSignature:'source-synthetic'};
 assert.deepEqual(f.ledger.forgetRecord(input),{recordId:'record-synthetic',epoch:1,purgePending:1});assert.deepEqual(f.ledger.forgetRecord(input),{recordId:'record-synthetic',epoch:1,purgePending:1});
 await assert.rejects(journal.record({...binding,outcome:'confirmed',indexing:'unproven',taskId:null,reason:null}),code('conflict'));
 assert.throws(()=>f.ledger.commitJobRevision(claim,f.input('forgotten-job-accept',{expectedRevision:1})),code('conflict'));
 assert.throws(()=>f.ledger.readRevision('record-synthetic'),code('forbidden'));
 assert.throws(()=>f.ledger.acceptRevision(f.input('resurrection',{recordId:'paraphrase-record',policyEpoch:1,content:'Paráfrase diferente'})),code('conflict'));
 assert.throws(()=>f.reopen().acceptRevision(f.input('resurrection-restart',{policyEpoch:1,expectedRevision:1})),code('conflict'));
 f.sql(db=>{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_tombstones').get().n,1);assert.equal(db.prepare("SELECT state FROM memory_projection_outbox WHERE operation='create'").get().state,'withdrawn');assert.equal(db.prepare("SELECT state FROM memory_projection_outbox WHERE operation='delete'").get().state,'queued');});
 assert.equal(f.ledger.status().remotePurge,'not_implemented');
});

test('M02 read references enforce own bot/latest head/hash, live epoch and validity; post-await forget invalidates the pinned reference',async t=>{
 const f=fixture(t),first=f.ledger.acceptRevision(f.input()),ref=f.ledger.listRecordReferences(f.bot.id,{scopeKind:'bot'}).items[0];
 assert.equal(f.ledger.readActiveReference(f.bot.id,ref).content,f.input().content);
 const other=f.store.createBot({name:'Other synthetic',profileId:'synthetic',engine:'codex'});f.ledger.provisionBotSubject(other.id);assert.throws(()=>f.ledger.readActiveReference(other.id,ref),code('forbidden'));
 assert.throws(()=>f.ledger.readActiveReference(f.bot.id,{...ref,sha256:'0'.repeat(64)}),code('conflict'));
 const latest=f.ledger.acceptRevision(f.input('active-r2',{expectedRevision:1,content:'Temporal fact',validUntil:1005}));assert.throws(()=>f.ledger.readActiveReference(f.bot.id,ref),code('conflict'));
 const pinned=f.ledger.listRecordReferences(f.bot.id).items[0];await Promise.resolve();f.clock.now=1006;
 assert.throws(()=>f.ledger.readActiveReference(f.bot.id,pinned),code('conflict'));assert.deepEqual(f.ledger.listRecordReferences(f.bot.id).items,[]);
 assert.equal(f.ledger.listRecordReferences(f.bot.id,{includeInactive:true}).items.length,1);
 f.ledger.forgetRecord({recordId:latest.recordId,expectedRevision:2,policyEpoch:0,operationKey:'forget-reference',suppressionSignature:'source'});
 assert.throws(()=>f.ledger.readActiveReference(f.bot.id,{...pinned,revision:first.revision}),code('conflict'));
});

test('M02 schema2 upgrade retains D24 bytes/history/receipts and MemoryRoutines metadata; schema3 refuses missing immutable guard',t=>{
 const f=fixture(t);f.context.compareAndSetBotDocuments(f.bot.id,{expectedRevision:0,soul:'Synthetic SOUL',user:'Synthetic USER',memory:'Synthetic MEMORY',clientRequestId:'legacy-owner'});
 f.context.compareAndSetBotDocuments(f.bot.id,{expectedRevision:1,soul:'Synthetic SOUL',user:'Synthetic USER',memory:'Synthetic MEMORY r2',clientRequestId:'legacy-owner-r2'});
 f.context.restoreBotMemory(f.bot.id,{expectedRevision:2,fromRevision:1,clientRequestId:'legacy-restore'});
 const routineJSON='{"jobs":{},"policies":{},"receipts":{},"version":1}';
 let before;f.sql(db=>{
  db.prepare('INSERT INTO meta VALUES (?,?)').run(MEMORY_ROUTINE_META_KEY,routineJSON);
  before=Object.fromEntries(['bot_documents','bot_document_revisions','bot_document_receipts'].map(table=>[table,JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())]));
 });
 f.context.close();f.store.withWriterLease(()=>{
  const db=new DatabaseSync(join(f.root,'data/context.sqlite'),{enableForeignKeyConstraints:false});try{db.exec('BEGIN');for(const table of [...MEMORY_LEDGER_TABLES].reverse())db.exec(`DROP TABLE ${table}`);db.exec("UPDATE meta SET value='2' WHERE key='schema'; COMMIT");assert.equal(contextSchemaLabel(db),'context-v2-document-history-memory-routines-v1');checkFullSchema(db,'context');}finally{db.close();}
 });
 const ledger=f.reopen();assert.equal(ledger.status().counts.memory_records,0);
 f.sql(db=>{assert.equal(contextSchemaLabel(db),'context-v3-memory-ledger-memory-routines-v1');checkFullSchema(db,'context');for(const [table,rows]of Object.entries(before))assert.equal(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()),rows);assert.equal(db.prepare('SELECT value FROM meta WHERE key=?').get(MEMORY_ROUTINE_META_KEY).value,routineJSON);db.exec('DROP TRIGGER memory_revisions_immutable_update');});
 f.context.close();assert.throws(()=>new ContextHost(f.store,new FixtureMemoryAdapter([])),code('tampered'));
});
