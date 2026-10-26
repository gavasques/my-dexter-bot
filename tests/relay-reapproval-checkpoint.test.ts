// G8 relay reapproval (Opus author round 1): authority checkpoint capture + restore AFTER a real recipient rotation.
// Uses only pre-existing public APIs, so the same file discriminates the unpatched operations validator.
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { OperationsError } from '@dexter/operations';
import { ASSOC_TABLES, CONSUMER_TABLES, assocPath, consumerPath, dump, seedRotatedSource, transfer, workspace, type Json } from './fixtures/relay-reapproval-lab.js';
const { validateRelayAssociations } = await import(new URL('../../packages/operations/dist/checkpoint.js', import.meta.url).href) as { validateRelayAssociations(db:DatabaseSync):void };
const actions=(rows:Json[],device:string)=>rows.filter(r=>r.device_id===device).sort((a,b)=>a.revision-b.revision).map(r=>`${r.action}@${r.host_revision}`);
const broken=(e:unknown)=>e instanceof OperationsError&&e.code==='reference_broken';

test('checkpoint captures and restores after a REAL recipient rotation: pins, history, tombstones and consumer rows survive exactly',async t=>{
 const s=await seedRotatedSource(t);
 const assoc=dump(assocPath(s.data),ASSOC_TABLES),consumer=dump(consumerPath(s.data),CONSUMER_TABLES);
 // Real rotation shape produced by relay-host itself (not a hand-written fixture).
 assert.equal(assoc.metadata![0].host_revision,2);assert.equal(JSON.parse(assoc.metadata![0].recipient_json).generation,2);
 assert.deepEqual(actions(assoc.history!,s.peer),['enroll@1','recipient@2','enroll@2']);
 assert.deepEqual(actions(assoc.history!,s.revokedPeer),['enroll@1','revoke@1']);
 assert.deepEqual(actions(assoc.history!,s.rotatedPeer),['enroll@1','recipient@2']);
 assert.deepEqual(assoc.associations!.map((r:Json)=>`${r.device_id===s.peer?'peer':r.device_id===s.revokedPeer?'revoked':'rotated'}:${r.status}:${r.revision}`).sort(),['peer:active:3','revoked:revoked:2','rotated:revoked:2']);
 assert.deepEqual(assoc.pins!.filter((p:Json)=>p.device_id==='relay_host').map((p:Json)=>p.generation),[1,2]);
 assert.deepEqual(Object.fromEntries(['prepared','committed','acked','blocked','unknown'].map(k=>[k,consumer.operations!.filter((o:Json)=>o.state===k).length])),{prepared:1,committed:1,acked:1,blocked:0,unknown:1});
 const pendingAck=consumer.acknowledgements!.find((a:Json)=>a.message_id===s.pendingMessage.messageId);assert.equal(pendingAck.state,'pending');assert.ok(pendingAck.request_json);

 const {dest,activated}=await transfer(s);
 assert.equal(activated.epoch,2);
 // Exact semantic preservation: nothing reactivated, compacted, migrated, replayed or resolved by restore.
 assert.deepEqual(dump(assocPath(dest),ASSOC_TABLES),assoc);
 assert.deepEqual(dump(consumerPath(dest),CONSUMER_TABLES),consumer);
 // The source stays permanently revoked and its relay metadata is untouched.
 assert.deepEqual(dump(assocPath(s.data),ASSOC_TABLES),assoc);
});

test('rotation tombstones are valid only with the rotation invariants; unrelated malformed history still refused',async t=>{
 const s=await seedRotatedSource(t),dir=workspace(t,'g8rr-copy-');let n=0;
 const check=(mutate:string|null,stored?:(db:DatabaseSync)=>void)=>{const p=join(dir,`a${n++}.sqlite`);copyFileSync(assocPath(s.data),p);const db=new DatabaseSync(p);try{if(mutate)db.exec(mutate);stored?.(db);validateRelayAssociations(db);}finally{db.close();}};
 check(null); // genuine relay-host rotation accepted
 const rotated=`device_id='${s.rotatedPeer}' AND action='recipient'`;
 for(const [label,sql] of [
  ['rotation host revision not after its enrollment',`UPDATE history SET host_revision=1 WHERE ${rotated}`],
  ['rotation newer than the host',`UPDATE history SET host_revision=3 WHERE ${rotated}`],
  ['rotation without its archived recipient pin generation',`DELETE FROM pins WHERE device_id='relay_host' AND generation=2`],
  ['rotation changed the sender',`UPDATE history SET sender_json='{"x":1}' WHERE ${rotated}`],
  ['rotation tombstone left active',`UPDATE associations SET status='active' WHERE device_id='${s.rotatedPeer}'`],
  ['revoke relabelled as a rotation (no rotation of a revoked association)',`UPDATE history SET action='recipient' WHERE device_id='${s.revokedPeer}' AND action='revoke'`],
  ['rotation as first history entry',`DELETE FROM history WHERE device_id='${s.rotatedPeer}' AND revision=1; UPDATE history SET revision=1 WHERE ${rotated}; UPDATE associations SET revision=1 WHERE device_id='${s.rotatedPeer}'`],
  ['association disagrees with its last history entry',`UPDATE associations SET sender_json='{"y":1}' WHERE device_id='${s.rotatedPeer}'`],
  // Pre-existing protections, unchanged:
  ['revoked association whose last action is enroll',`UPDATE associations SET status='revoked' WHERE device_id='${s.peer}'`],
  ['history gap',`DELETE FROM history WHERE device_id='${s.peer}' AND revision=2`],
  ['association newer than its host',`UPDATE associations SET host_revision=9 WHERE device_id='${s.revokedPeer}'`],
 ] as const)assert.throws(()=>check(sql),broken,label);
 // Sol R1 (round 2 regression): the non-STRICT INTEGER column keeps the enrollment's host revision as TEXT 'invalid'
 // (Number -> NaN, and `rotated <= NaN` is false); 0 and REAL 1.5 are the other impossible predecessors that ordering
 // alone accepted. Everything else about the genuine rotation (enroll, binding, sender, host, pin) is left intact.
 const predecessor=`device_id='${s.rotatedPeer}' AND revision=1`;
 for(const [value,type] of [["'invalid'",'text'],['0','integer'],['1.5','real']] as const){
  const stored=(db:DatabaseSync)=>assert.deepEqual({...db.prepare(`SELECT action,typeof(host_revision) AS type FROM history WHERE ${predecessor}`).get()},{action:'enroll',type});
  assert.throws(()=>check(`UPDATE history SET host_revision=${value} WHERE ${predecessor}`,stored),broken,`rotation predecessor host revision stored as ${type} ${value}`);
 }
 // O1: revoked row revisions may precede the current recipient; malformed stored revisions never may.
 for(const [value,type] of [["'invalid'",'text'],['0','integer'],['-1','integer'],['1.5','real'],['1e20','real'],['3','integer']] as const){
  const where=`device_id='${s.revokedPeer}'`;
  assert.throws(()=>check(`UPDATE associations SET host_revision=${value} WHERE ${where}`,db=>assert.equal(db.prepare(`SELECT typeof(host_revision) AS type FROM associations WHERE ${where}`).get()!.type,type)),broken,`association row host revision ${value}`);
 }
 check(`UPDATE associations SET host_revision=2 WHERE device_id='${s.revokedPeer}'`);

});
