import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { HostStore, dispatchAction, canonicalJson } from '../packages/hub/dist/index.js';
import { ContextHost, FixtureMemoryAdapter } from '../packages/context/dist/index.js';
import { AppendBotMemoryNoteSchema, APPROVAL_POLICY_SCOPE_VERSION } from '../packages/contracts/dist/index.js';
import { validateContext } from '../packages/operations/dist/validate.js';
import { GitSnapshot, readContextGit } from '../packages/operations/dist/git.js';
import { resolveLimits, gitLimits } from '../packages/operations/dist/manifest.js';

const tool='dexter.harness.memory.append',destination='dexter-harness-owner-proposals';
const sha=value=>createHash('sha256').update(value).digest('hex');
const code=expected=>error=>error?.code===expected;
function fixture(t){
 const root=realpathSync(mkdtempSync('/private/tmp/memory-notes-fixture-')),clock={now:1000};let store,context,sequence=0;
 const open=()=>{store=new HostStore({dataDir:root,clock:()=>clock.now});context=new ContextHost(store,new FixtureMemoryAdapter([]));};open();
 t.after(()=>{context.close();store.close();rmSync(root,{recursive:true,force:true});});
 const bot=()=>store.createBot({name:'Synthetic note bot',profileId:'synthetic',engine:'codex'});
 const live=(b,thread=store.createThread(b.id))=>{
  const turn=store.createTurn(thread.id,{clientRequestId:`turn-${++sequence}`,content:'Synthetic explicit memory note'}).turn;store.claimNextTurn(thread.id);
  return {bot:b,thread,turn,token:context.issue(turn.id)};
 };
 const save=(b,memory,soul='HUMAN SOUL 🦊',user='HUMAN USER')=>context.compareAndSetBotDocuments(b.id,{expectedRevision:context.readBotDocuments(b.id).revision,memory,soul,user,clientRequestId:`owner-${++sequence}`});
 const request=(p,input,key=`note-${++sequence}`,over={})=>{
  const current=context.botDocuments(p.token);clock.now++;
  const pin={revision:current.revision,soulHash:sha(current.soul),userHash:sha(current.user),memoryHash:sha(current.memory)};
  if(!store.getGrant(p.bot.id,tool,destination))store.setGrant({botId:p.bot.id,tool,destination,policy:'ask'});
  const request={botId:p.bot.id,threadId:p.thread.id,tool,destination,arguments:{input,pin},idempotencyKey:key,...over};
  const action=store.requestAction(request);store.bindToolAction(action.id,p.turn.id,key);return action;
 };
 const approve=action=>{store.decideAction(action.id,{decision:'allow',requestHash:action.requestHash});return store.claimAction(action.id);};
 const execute=action=>{approve(action);const result=context.executeDocumentAction(action.id);store.completeAction(action.id,{documents:result});return result;};
 const counts=()=>{const db=new DatabaseSync(context.databasePath,{readOnly:true});try{return {revisions:db.prepare('SELECT COUNT(*) n FROM bot_document_revisions').get().n,receipts:db.prepare('SELECT COUNT(*) n FROM bot_document_receipts').get().n};}finally{db.close();}};
 return {root,clock,get store(){return store;},get context(){return context;},bot,live,save,request,approve,execute,counts,
  reopen(){context.close();store.close();open();}};
}

test('memory note: exact owner action/capability appends once, literal repeat only records receipt, unchanged human docs and original replay',t=>{
 const f=fixture(t),b=f.bot(),p=f.live(b),initial=f.save(b,'Human text\r\nwith spacing  \n');
 f.store.setBotApprovalPolicy(b.id,{expectedHostId:f.store.hostId,expectedRevision:0,clientRequestId:'approve-all',mode:'approve_all',eligibleScopeVersion:APPROVAL_POLICY_SCOPE_VERSION});
 const input={expectedRevision:1,note:'Prefiro relatórios curtos. 🚀 e\u0301'},action=f.request(p,input,'one');
 assert.equal(action.state,'awaiting_approval');assert.throws(()=>f.context.executeDocumentAction(action.id),code('forbidden'));
 const beforeBot=f.store.getBot(b.id),result=f.execute(action);
 assert.equal(result.memory,initial.memory+'\n\n'+input.note);assert.equal(result.revision,2);assert.equal(result.soul,initial.soul);assert.equal(result.user,initial.user);
 assert.deepEqual(f.store.getBot(b.id),beforeBot);assert.equal(result.memoryHead.source.kind,'harness_action');assert.equal(result.memoryHead.source.turnId,p.turn.id);assert.equal(result.memoryHead.source.callId,'one');
 assert.deepEqual(result.receipt.note,{sha256:sha(input.note),outcome:'appended'});assert.equal(result.receipt.operation,'append');
 assert.deepEqual(f.context.executeDocumentAction(action.id),result);assert.deepEqual(f.context.memoryNoteReceipt(p.token,action.id),result);
 assert.throws(()=>f.store.requestAction({...action.request,arguments:{...action.request.arguments,input:{...input,note:'Changed note'}}}),code('conflict'));
 const repeated=f.execute(f.request(p,{expectedRevision:2,note:input.note},'literal-repeat'));
 assert.equal(repeated.memory,result.memory);assert.equal(repeated.revision,2);assert.deepEqual(repeated.memoryHead,result.memoryHead);assert.equal(repeated.receipt.note.outcome,'already_present');assert.ok(repeated.receipt.committedAt>result.updatedAt);
 assert.equal(f.context.botMemoryHistory(b.id).items.length,2);assert.deepEqual(f.counts(),{revisions:2,receipts:3});
 // A substring is not an exact standalone note; no case/whitespace/Unicode semantic normalization.
 const substring=f.execute(f.request(p,{expectedRevision:2,note:'relatórios curtos.'},'substring'));assert.equal(substring.revision,3);assert.ok(substring.memory.endsWith('\n\nrelatórios curtos.'));
 const canonical=f.execute(f.request(p,{expectedRevision:3,note:'Prefiro relatórios curtos. 🚀 é'},'different-unicode'));assert.equal(canonical.revision,4);
});

test('memory note: invalid, empty, overflow, denied and forged fields leave head/history/receipt unchanged; receipt isolation uses live host capability',t=>{
 const f=fixture(t),b=f.bot(),p=f.live(b),other=f.bot(),foreign=f.live(other);f.save(b,'Original human memory');
 const denied=f.request(p,{expectedRevision:1,note:'Denied note'},'deny');f.store.decideAction(denied.id,{decision:'deny',requestHash:denied.requestHash});assert.throws(()=>f.context.executeDocumentAction(denied.id),code('forbidden'));
 const stable=f.context.readBotDocuments(b.id),counts=f.counts();
 for(const [index,input]of[{expectedRevision:1,note:''},{expectedRevision:1,note:' \n\t '},{expectedRevision:1,note:'x'.repeat(2049)},{expectedRevision:1,note:'\ud800'},{expectedRevision:1,note:'sk-'+'A'.repeat(30)},
  ...['botId','source','author','grants','document','sourceReference'].map(key=>({expectedRevision:1,note:'A note',[key]:key==='botId'?other.id:'spoof'}))].entries()){
  const action=f.request(p,input,`invalid-${index}`);f.approve(action);assert.throws(()=>f.context.executeDocumentAction(action.id),code('invalid_input'));assert.deepEqual(f.context.readBotDocuments(b.id),stable);assert.deepEqual(f.counts(),counts);
 }
 assert.equal(AppendBotMemoryNoteSchema.safeParse({expectedRevision:1,note:'good',botId:b.id}).success,false);
 const badPin=f.request(p,{expectedRevision:1,note:'Pinned note'},'bad-pin',{arguments:{input:{expectedRevision:1,note:'Pinned note'},pin:{revision:1,soulHash:sha(stable.soul),userHash:sha(stable.user),memoryHash:'0'.repeat(64)}}});f.approve(badPin);assert.throws(()=>f.context.executeDocumentAction(badPin.id),code('conflict'));
 const good=f.execute(f.request(p,{expectedRevision:1,note:'Approved own note'},'good'));
 assert.throws(()=>f.context.memoryNoteReceipt(foreign.token,good.receipt.source.actionId),code('forbidden'));
 const otherConversation=f.live(b);assert.throws(()=>f.context.memoryNoteReceipt(otherConversation.token,good.receipt.source.actionId),code('forbidden'));
 f.context.revoke(otherConversation.token);assert.throws(()=>f.context.memoryNoteReceipt(otherConversation.token,good.receipt.source.actionId),code('forbidden'));
 assert.equal(f.context.readBotDocuments(other.id).revision,0);
 f.save(b,'a'.repeat(8190));const full=f.context.readBotDocuments(b.id),fullCounts=f.counts(),overflow=f.request(p,{expectedRevision:full.revision,note:'x'},'overflow');f.approve(overflow);
 assert.throws(()=>f.context.executeDocumentAction(overflow.id),error=>error.code==='invalid_input'&&error.name==='MemoryNoteCapacityError'&&error.capacity===8192&&error.currentCharacters===8190&&error.requiredCharacters===8193);
 assert.deepEqual(f.context.readBotDocuments(b.id),full);assert.deepEqual(f.counts(),fullCounts);
});

test('memory note: concurrent approved CAS and later human edit never lose text; history and restore remain canonical',async t=>{
 const f=fixture(t),b=f.bot(),p=f.live(b);f.save(b,'Human base');
 const one=f.request(p,{expectedRevision:1,note:'First note'},'race-one'),two=f.request(p,{expectedRevision:1,note:'Second note'},'race-two');
 for(const action of [one,two])f.store.decideAction(action.id,{decision:'allow',requestHash:action.requestHash});
 const outcomes=await Promise.all([one,two].map(action=>dispatchAction(f.store,action.id,async()=>({documents:f.context.executeDocumentAction(action.id)}))));
 // This strict lower-level fixture preserves dispatchAction's generic-error unknown projection;
 // the shared surface must map Context CAS failures to its bounded conflict outcome during Root composition.
 assert.deepEqual(outcomes.map(x=>x.state),['succeeded','unknown']);assert.equal(f.context.memoryNoteReceipt(p.token,two.id),null);assert.equal(f.context.readBotDocuments(b.id).memory,'Human base\n\nFirst note');
 const humanRace=f.request(p,{expectedRevision:2,note:'Stale note'},'human-race');f.save(b,'Human preserved replacement','Current SOUL','Current USER');f.approve(humanRace);assert.throws(()=>f.context.executeDocumentAction(humanRace.id),code('conflict'));
 const restored=f.context.restoreBotMemory(b.id,{expectedRevision:3,fromRevision:2,clientRequestId:'restore-two'});
 assert.equal(restored.revision,4);assert.equal(restored.memory,'Human base\n\nFirst note');assert.equal(restored.soul,'Current SOUL');assert.equal(restored.user,'Current USER');assert.equal(restored.memoryHead.restoredFrom,2);
 assert.deepEqual(f.context.botMemoryHistory(b.id,{limit:2}).items.map(x=>x.revision),[4,3]);assert.equal(f.context.readBotMemoryRevision(b.id,2).markdown,'Human base\n\nFirst note');
});

test('memory note: lost postcommit response is unknown; reopen/query returns exact original receipt with no second mutation',async t=>{
 const f=fixture(t),b=f.bot(),p=f.live(b);f.save(b,'Persisted human text');const action=f.request(p,{expectedRevision:1,note:'Durable note'},'postcommit');
 f.store.decideAction(action.id,{decision:'allow',requestHash:action.requestHash});let effects=0,original;
 const unknown=await dispatchAction(f.store,action.id,async()=>{effects++;original=f.context.executeDocumentAction(action.id);throw new Error('Synthetic loss after Context commit');});
 assert.equal(unknown.state,'unknown');assert.equal(effects,1);assert.deepEqual(f.context.memoryNoteReceipt(p.token,action.id),original);assert.equal(f.context.readBotDocuments(b.id).revision,2);
 f.store.finishTurn(p.turn.id,'completed',null);f.reopen();assert.throws(()=>f.context.memoryNoteReceipt(p.token,action.id),code('forbidden'));
 const resumed=f.live(f.store.getBot(b.id),f.store.getThread(p.thread.id));assert.deepEqual(f.context.memoryNoteReceipt(resumed.token,action.id),original);assert.deepEqual(f.context.executeDocumentAction(action.id),original);
 assert.equal(f.store.getAction(action.id).state,'unknown');assert.equal(f.context.botMemoryHistory(b.id).items.length,2);assert.equal(effects,1);
 await assert.rejects(dispatchAction(f.store,action.id,async()=>{effects++;return null;}),code('conflict'));assert.equal(effects,1);
});

test('memory note: separate backup overlay accepts old receipts and strict append correlation, rejects adulterated marker/input/head/time/approval',t=>{
 const f=fixture(t),b=f.bot(),p=f.live(b);f.save(b,'Backup human text');
 const first=f.execute(f.request(p,{expectedRevision:1,note:'Backup literal note'},'backup-one'));
 const duplicate=f.execute(f.request(p,{expectedRevision:2,note:'Backup literal note'},'backup-repeat'));
 f.context.restoreBotMemory(b.id,{expectedRevision:2,fromRevision:1,clientRequestId:'backup-restore'});
 const contextCopy=join(f.root,'context-copy.sqlite'),hubCopy=join(f.root,'hub-copy.sqlite');
 f.store.withWriterLease(()=>{
  for(const [path,target]of[[f.context.databasePath,contextCopy],[f.store.databasePath,hubCopy]]){const db=new DatabaseSync(path);try{db.prepare('VACUUM INTO ?').run(target);}finally{db.close();}}
 });
 const db=new DatabaseSync(contextCopy),hub=new DatabaseSync(hubCopy),limits=resolveLimits();
 const check=()=>validateContext(db,hub,new GitSnapshot(readContextGit(f.context.repositoryPath,gitLimits(limits),()=>{}),gitLimits(limits)));
 try{
  check();const row=db.prepare('SELECT * FROM bot_document_receipts WHERE operation_key=?').get(duplicate.receipt.operationKey);
  const mutation=sql=>{db.exec('BEGIN');try{sql();assert.throws(check,code('reference_broken'));}finally{db.exec('ROLLBACK');}check();};
  mutation(()=>db.prepare('UPDATE bot_document_receipts SET created_at=? WHERE operation_key=?').run(first.updatedAt-1,row.operation_key));
  mutation(()=>db.prepare('UPDATE bot_document_receipts SET revision=1 WHERE operation_key=?').run(row.operation_key));
  mutation(()=>{const origin=JSON.parse(row.origin_json);origin.memoryNote.sha256='0'.repeat(64);db.prepare('UPDATE bot_document_receipts SET origin_json=? WHERE operation_key=?').run(canonicalJson(origin),row.operation_key);});
  mutation(()=>{const origin=JSON.parse(row.origin_json);origin.memoryNote.outcome='appended';db.prepare('UPDATE bot_document_receipts SET origin_json=? WHERE operation_key=?').run(canonicalJson(origin),row.operation_key);});
  mutation(()=>{const origin=JSON.parse(row.origin_json);origin.memoryNote.baseMemoryHash='0'.repeat(64);db.prepare('UPDATE bot_document_receipts SET origin_json=? WHERE operation_key=?').run(canonicalJson(origin),row.operation_key);});
  mutation(()=>{const input=canonicalJson({expectedRevision:2,note:'Changed note'});db.prepare('UPDATE bot_document_receipts SET input_json=?,request_hash=? WHERE operation_key=?').run(input,sha(input),row.operation_key);});
  mutation(()=>db.prepare("UPDATE bot_document_receipts SET operation='update' WHERE operation_key=?").run(row.operation_key));
  hub.exec('BEGIN');try{hub.prepare("UPDATE action_authorizations SET source='bounded_grant' WHERE action_id=?").run(duplicate.receipt.source.actionId);assert.throws(check,code('reference_broken'));}finally{hub.exec('ROLLBACK');}check();
 }finally{db.close();hub.close();}
});
