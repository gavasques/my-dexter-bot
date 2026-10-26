import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { HostStore, canonicalJson } from '../packages/hub/dist/index.js';
import { ContextHost, FixtureMemoryAdapter } from '../packages/context/dist/index.js';
import { BOT_MEMORY_MAX_CHARACTERS } from '../packages/contracts/dist/index.js';
import { GitSnapshot, GIT_HEAD, GIT_PREFIX, readContextGit } from '../packages/operations/dist/git.js';
import { resolveLimits, gitLimits } from '../packages/operations/dist/manifest.js';
import { validateContext } from '../packages/operations/dist/validate.js';

const sha=(value,algorithm='sha256')=>createHash(algorithm).update(value).digest('hex');
const code=expected=>error=>error?.code===expected;
const limits=gitLimits(resolveLimits());
const path='memory/bot_synthetic/MEMORY-r1-00000000-0000-4000-8000-000000000001.md';
function addCommit(input,path,body,parent=null){
 const members=new Map(input),objects=[];
 const put=(type,bytes)=>{const raw=Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`),bytes]),id=sha(raw,'sha1');members.set(`${GIT_PREFIX}objects/${id.slice(0,2)}/${id.slice(2)}`,deflateSync(raw));objects.push({type,bytes:raw.length,bodyBytes:bytes.length});return id;};
 let id=put('blob',Buffer.from(body)),parts=path.split('/');
 for(let i=parts.length-1;i>=0;i--)id=put('tree',Buffer.concat([Buffer.from(`${i===parts.length-1?'100644':'40000'} ${parts[i]}\0`),Buffer.from(id,'hex')]));
 const commitBody=Buffer.from(`tree ${id}\n${parent?`parent ${parent}\n`:''}author Synthetic <fixture.invalid> 1 +0000\ncommitter Synthetic <fixture.invalid> 1 +0000\n\nSynthetic snapshot\n`);
 const commit=put('commit',commitBody);members.set(`${GIT_PREFIX}HEAD`,Buffer.from(GIT_HEAD));members.set(`${GIT_PREFIX}refs/heads/master`,Buffer.from(commit+'\n'));
 return {members,pin:{commit,path,sha256:sha(body)},objects,metadataReadBytes:commitBody.length*2+objects.filter(o=>o.type==='tree').reduce((n,o)=>n+o.bodyBytes,0)};
}
function fixture(t,{empty=false}={}){
 const root=realpathSync(mkdtempSync('/private/tmp/memory-note-backup-bytes-r2-fixture-')),clock={now:1000};
 const store=new HostStore({dataDir:root,clock:()=>clock.now}),context=new ContextHost(store,new FixtureMemoryAdapter([]));
 const bot=store.createBot({name:'Synthetic bytes',profileId:'synthetic',engine:'codex'}),thread=store.createThread(bot.id),turn=store.createTurn(thread.id,{clientRequestId:'turn',content:'Synthetic approved note'}).turn;store.claimNextTurn(thread.id);const token=context.issue(turn.id);
 const tool='dexter.harness.memory.append',destination='dexter-harness-owner-proposals';store.setGrant({botId:bot.id,tool,destination,policy:'ask'});
 const human='\ufeffHuman text\r\nline e\u0301 🚀  ',note='Nota literal e\u0301 🚀';
 if(!empty)context.compareAndSetBotDocuments(bot.id,{expectedRevision:0,soul:'Human SOUL 🦊',user:'Human USER e\u0301',memory:human,clientRequestId:'owner-update'});
 const append=key=>{const current=context.botDocuments(token);clock.now++;const action=store.requestAction({botId:bot.id,threadId:thread.id,tool,destination,idempotencyKey:key,arguments:{input:{expectedRevision:current.revision,note},pin:{revision:current.revision,soulHash:sha(current.soul),userHash:sha(current.user),memoryHash:sha(current.memory)}}});store.bindToolAction(action.id,turn.id,key);store.decideAction(action.id,{decision:'allow',requestHash:action.requestHash});store.claimAction(action.id);const value=context.executeDocumentAction(action.id);store.completeAction(action.id,{documents:value});return value;};
 const first=append('append'),duplicate=append('duplicate');
 if(!empty){clock.now++;context.restoreBotMemory(bot.id,{expectedRevision:2,fromRevision:1,clientRequestId:'owner-restore'});}
 const contextCopy=join(root,'context-copy.sqlite'),hubCopy=join(root,'hub-copy.sqlite');
 store.withWriterLease(()=>{for(const [source,target]of[[context.databasePath,contextCopy],[store.databasePath,hubCopy]]){const db=new DatabaseSync(source);try{db.prepare('VACUUM INTO ?').run(target);}finally{db.close();}}});
 const db=new DatabaseSync(contextCopy),hub=new DatabaseSync(hubCopy),members=readContextGit(context.repositoryPath,limits,()=>{});
 t.after(()=>{db.close();hub.close();context.close();store.close();rmSync(root,{recursive:true,force:true});});
 const check=(data=members)=>validateContext(db,hub,new GitSnapshot(data,limits));
 const replacePin=(revision,column,body)=>{
  const row=db.prepare('SELECT * FROM bot_document_revisions WHERE bot_id=? AND revision=?').get(bot.id,revision),old=JSON.parse(row[column]),next=addCommit(members,old.path,body,members.get(`${GIT_PREFIX}refs/heads/master`).toString().trim());
  const pinJSON=canonicalJson(next.pin);db.prepare(`UPDATE bot_document_revisions SET ${column}=? WHERE bot_id=? AND revision=?`).run(pinJSON,bot.id,revision);db.prepare(`UPDATE bot_documents SET ${column}=? WHERE bot_id=? AND revision=?`).run(pinJSON,bot.id,revision);return next.members;
 };
 return {db,hub,bot,first,duplicate,human,note,members,check,replacePin};
}

test('R2 GitSnapshot exact UTF-8/BOM bytes, immutable eligibility, hash/path/commit checks and pre-decode/inflation budgets',()=>{
 const body=Buffer.from('\ufeffLiteral\r\ne\u0301 🚀'),graph=addCommit(new Map(),path,body),snapshot=new GitSnapshot(graph.members,limits);
 assert.equal(snapshot.documentText(graph.pin.commit,path,graph.pin.sha256),body.toString('utf8'));
 assert.equal(snapshot.blobSha256(graph.pin.commit,path),graph.pin.sha256);
 assert.throws(()=>snapshot.documentText(graph.pin.commit,path,'0'.repeat(64)),code('reference_broken'));
 assert.throws(()=>snapshot.documentText(graph.pin.commit,'memory/../config',graph.pin.sha256),code('reference_broken'));
 const orphan=addCommit(graph.members,path,Buffer.from('Orphan'));orphan.members.set(`${GIT_PREFIX}refs/heads/master`,Buffer.from(graph.pin.commit+'\n'));
 const orphanView=new GitSnapshot(orphan.members,limits);orphanView.reachable().add(orphan.pin.commit);assert.throws(()=>orphanView.documentText(orphan.pin.commit,path,orphan.pin.sha256),code('reference_broken'));
 for(const bytes of [Buffer.from([0xc0,0xaf]),Buffer.from([0xed,0xa0,0x80]),Buffer.from([0xf0,0x9f])]){
  const bad=addCommit(new Map(),path,bytes),s=new GitSnapshot(bad.members,limits);assert.throws(()=>s.documentText(bad.pin.commit,path,bad.pin.sha256),code('corrupt'));
 }
 for(const bytes of [Buffer.alloc(BOT_MEMORY_MAX_CHARACTERS+1,0x61),Buffer.alloc(3*BOT_MEMORY_MAX_CHARACTERS+1,0x61)]){
  const large=addCommit(new Map(),path,bytes),s=new GitSnapshot(large.members,limits);assert.throws(()=>s.documentText(large.pin.commit,path,large.pin.sha256),code('quota_exceeded'));
 }
 const max=addCommit(new Map(),path,Buffer.from('界'.repeat(BOT_MEMORY_MAX_CHARACTERS))),maxView=new GitSnapshot(max.members,limits);assert.equal(maxView.documentText(max.pin.commit,path,max.pin.sha256).length,BOT_MEMORY_MAX_CHARACTERS);
 const decodeBudget=new GitSnapshot(graph.members,{...limits,maxTraversalBytes:graph.metadataReadBytes+body.length-1});assert.throws(()=>decodeBudget.documentText(graph.pin.commit,path,graph.pin.sha256),code('quota_exceeded'));
 const inflated=graph.objects.reduce((sum,item)=>sum+item.bytes,0);assert.throws(()=>new GitSnapshot(graph.members,{...limits,maxInflatedBytes:inflated-1}),code('quota_exceeded'));
 // Public source buffers cannot change already-inflated bytes held by the snapshot.
 for(const [key,bytes]of graph.members)if(key.startsWith(GIT_PREFIX+'objects/'))bytes.fill(0);assert.equal(snapshot.documentText(graph.pin.commit,path,graph.pin.sha256),body.toString('utf8'));
});

test('R2 staged validator accepts exact append/dedup, first empty MEMORY and legacy owner update/restore receipts',t=>{
 const full=fixture(t);full.check();assert.equal(full.first.receipt.note.outcome,'appended');assert.equal(full.duplicate.receipt.note.outcome,'already_present');
 const empty=fixture(t,{empty:true});empty.check();assert.equal(empty.first.revision,1);assert.equal(empty.duplicate.revision,1);
});

test('R2 correct marker/action/base pin cannot substitute for literal head bytes: wrong note, separator, Unicode/BOM, UTF-8 and schema overflow',t=>{
 const f=fixture(t),expected=f.human+'\n\n'+f.note;
 const wrong=[Buffer.from(f.human+'\n\n'+'Different note'),Buffer.from(f.human+'\r\n\r\n'+f.note),Buffer.from(expected.normalize('NFC')),Buffer.from(expected.slice(1)),Buffer.from([0xc0,0xaf]),Buffer.alloc(BOT_MEMORY_MAX_CHARACTERS+1,0x61)];
 for(const [index,bytes]of wrong.entries()){
  f.db.exec('BEGIN');try{const candidate=f.replacePin(f.first.revision,'memory_pin_json',bytes);assert.throws(()=>f.check(candidate),code(index===4?'corrupt':index===5?'quota_exceeded':'reference_broken'));}finally{f.db.exec('ROLLBACK');}
 }
 f.check();
});

test('R2 rejects altered predecessor/SOUL/USER and correlated already_present receipt with no literal block',t=>{
 const f=fixture(t);
 for(const [revision,column,body]of[[1,'memory_pin_json','Changed predecessor'],[f.first.revision,'soul_pin_json','Changed human SOUL'],[f.first.revision,'user_pin_json','Changed human USER']]){
  f.db.exec('BEGIN');try{const candidate=f.replacePin(revision,column,Buffer.from(body));assert.throws(()=>f.check(candidate),code('reference_broken'));}finally{f.db.exec('ROLLBACK');}
 }
 // Keep every marker/hash/pin correlated and preserve the successful first append. Change only the duplicate
 // action/input/marker to an approved literal fragment that is not a standalone block in the committed head.
 const actionId=f.duplicate.receipt.source.actionId,key=f.duplicate.receipt.operationKey,input={expectedRevision:2,note:'Nota literal'},inputJSON=canonicalJson(input),origin=structuredClone(f.duplicate.receipt.source);origin.memoryNote.sha256=sha(input.note);
 f.db.exec('BEGIN');f.hub.exec('BEGIN');try{
  f.db.prepare('UPDATE bot_document_receipts SET input_json=?,request_hash=?,origin_json=? WHERE operation_key=?').run(inputJSON,sha(inputJSON),canonicalJson(origin),key);
  const row=f.hub.prepare('SELECT request FROM actions WHERE id=?').get(actionId),request=JSON.parse(row.request);request.arguments.input=input;f.hub.prepare('UPDATE actions SET request=?,request_hash=? WHERE id=?').run(canonicalJson(request),sha(canonicalJson(request)),actionId);
  assert.throws(()=>f.check(),code('reference_broken'));
 }finally{f.db.exec('ROLLBACK');f.hub.exec('ROLLBACK');}
 f.check();
});
