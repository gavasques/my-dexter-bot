// G8 relay destination reapproval (Opus author round 1): owner-local recovery port on a REAL restored destination.
// Real HostStore/AppClient registry/RelayHost/RelayStore/consumer journal; synthetic in-memory custody only.
// SQLite dumps are taken only after the exclusive handle is closed (an immutable read ignores an open WAL).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { RelayEndpoint, RelayStore, type DevicePin } from '@dexter/relay';
import { RelayAssociations, RelayHost, RelayRecoveryMaintenance, validateRelayHostOptions, type RelayRecoveryPort } from '@dexter/relay-host';
import { until } from './fixtures/relay-host-lab.js';
import {
 ASSOC_TABLES, CONSUMER_TABLES, assocPath, code, compose, consumerPath, defer, dump, fileSha, hostOptions, pair, recipientCustody, rotateTls, seal,
 seedRotatedSource, transfer, workspace, type Composed, type Json, type SourceState,
} from './fixtures/relay-reapproval-lab.js';

interface Destination {s:SourceState;dest:string;c:Composed;quarantine():void;open():RelayRecoveryPort}
async function restored(t:TestContext):Promise<Destination>{
 const s=await seedRotatedSource(t);const {dest}=await transfer(s);const c=compose(dest);let quarantined=false;
 defer(t,async()=>{if(quarantined){await c.runtime.shutdown({closeStore:false}).catch(()=>undefined);return;}await c.close();});
 return {s,dest,c,quarantine:()=>{quarantined=true;},open:()=>new RelayRecoveryMaintenance(c.host,c.bindings,dest)};
}
const relayBytes=(dest:string)=>({assoc:fileSha(assocPath(dest)),consumer:fileSha(consumerPath(dest)),files:readdirSync(join(dest,'relay-host')).sort()});
const endpoint=(s:{hostId:string;ownerId:string},device:string,generation:number,keyId=`${device}_k${generation}`)=>new RelayEndpoint({installationId:s.hostId,ownerId:s.ownerId,deviceId:device,generation,keyId});
const association=(dest:string,device:string):Json=>dump(assocPath(dest),['associations']).associations!.find((a:Json)=>a.device_id===device);
/** Run against an open port, then close it so the result can be dumped exactly. */
function withPort<T>(d:{open():RelayRecoveryPort},fn:(port:RelayRecoveryPort)=>T):T{const port=d.open();try{return fn(port);}finally{port.close();}}

test('restored destination: old recipient with absent or new UNAPPROVED custody never activates relay and writes nothing',async t=>{
 const {s,dest,c}=await restored(t);const before=relayBytes(dest),assoc=dump(assocPath(dest),ASSOC_TABLES),consumer=dump(consumerPath(dest),CONSUMER_TABLES);
 const transport=s.transport,newCustody=recipientCustody(s,3);
 // No private custody was exported: the old public recipient alone cannot form options.
 assert.throws(()=>validateRelayHostOptions({recipient:s.recipient2,custodyMode:'laboratory-memory',transport,transportOwnership:'borrowed',deployment:{maximumPendingPerRecipient:64}} as never),code('invalid_input'));
 // A new provider presented under the OLD recipient label is refused (provider pin must equal the requested recipient).
 assert.throws(()=>validateRelayHostOptions({recipient:s.recipient2,custody:newCustody.provider,custodyMode:'laboratory-memory',transport,transportOwnership:'borrowed',deployment:{maximumPendingPerRecipient:64}}),code('invalid_input'));
 // A new, not yet approved recipient cannot open the restored metadata (persisted recipient differs): refused before any writable open.
 assert.throws(()=>new RelayHost(c.host,c.bindings,dest,hostOptions(newCustody,transport)),code('conflict'));
 assert.equal(newCustody.closes,0);assert.equal(newCustody.signStarted,false);assert.equal(newCustody.decryptStarted,false);
 assert.deepEqual(relayBytes(dest),before);assert.deepEqual(dump(assocPath(dest),ASSOC_TABLES),assoc);assert.deepEqual(dump(consumerPath(dest),CONSUMER_TABLES),consumer);
 assert.equal(c.calls(),0);assert.equal(c.store.summary().counts.grants,0);
});

test('recovery port never bootstraps a missing recovery source and is exclusive with RelayHost and itself',async t=>{
 const d=await restored(t),{c,dest}=d;const empty=join(workspace(t,'g8rr-empty-'),'data');
 // Missing relay-host directory: refused, and nothing is created.
 mkdirSync(empty,{mode:0o700});assert.throws(()=>new RelayRecoveryMaintenance(c.host,c.bindings,empty),code('unavailable'));assert.deepEqual(readdirSync(empty),[]);
 // Existing directory but missing associations database: refused without creating the file.
 mkdirSync(join(empty,'relay-host'),{mode:0o700});assert.throws(()=>new RelayRecoveryMaintenance(c.host,c.bindings,empty),code('unavailable'));assert.deepEqual(readdirSync(join(empty,'relay-host')),[]);
 assert.throws(()=>new RelayRecoveryMaintenance(c.host,c.bindings,empty,{maximumAssociations:0}),code('invalid_input'));
 assert.throws(()=>new RelayRecoveryMaintenance(c.host,c.bindings,dest,{maximumAssociations:1,extra:true} as never),code('invalid_input'));
 withPort(d,port=>{
  assert.throws(()=>d.open(),code('host_locked'));
  assert.throws(()=>new RelayHost(c.host,c.bindings,dest,hostOptions(recipientCustody(c.store,3),d.s.transport)),code('host_locked'));
  // Status is public counts only.
  const st=port.status();assert.deepEqual(Object.keys(st).sort(),['active','history','hostRevision','pins','recipient','relay','revoked']);
  assert.deepEqual({rev:st.hostRevision,gen:st.recipient.generation,active:st.active,revoked:st.revoked,history:st.history,pins:st.pins,relay:st.relay},{rev:2,gen:2,active:1,revoked:2,history:7,pins:6,relay:'inactive'});
 });
 assert.throws(()=>{const p=d.open();p.close();p.status();},code('unavailable'),'closed port refuses');
 assert.equal(c.calls(),0);assert.equal(c.store.summary().counts.grants,0);
});

test('CAS rotation to the next public recipient pin; stale/same/skipped/reused/foreign pins refused with no writes',async t=>{
 const d=await restored(t),{s,dest,c}=d;const next=recipientCustody(s,3);
 withPort(d,()=>undefined);// first owner open converts the restored rollback-journal file to WAL; compare semantics from here on
 const before=dump(assocPath(dest),ASSOC_TABLES);
 withPort(d,port=>{
  const refusals:Array<[string,()=>unknown,string]>=[
   ['stale host CAS',()=>port.rotateRecipient(next.pin,1),'conflict'],
   ['same (old) recipient pin',()=>port.rotateRecipient(s.recipient2,2),'conflict'],
   ['skipped generation',()=>port.rotateRecipient(recipientCustody(s,4).pin,2),'conflict'],
   ['reused old keys at next generation',()=>port.rotateRecipient({...s.recipient2,generation:3,keyId:'reuse'} as DevicePin,2),'conflict'],
   ['foreign owner',()=>port.rotateRecipient({...next.pin,ownerId:'foreign_owner'} as DevicePin,2),'conflict'],
   ['other recipient device',()=>port.rotateRecipient({...next.pin,deviceId:'other_host'} as DevicePin,2),'conflict'],
   ['malformed pin',()=>port.rotateRecipient({...next.pin,signingPublicKey:'x'} as DevicePin,2),'invalid_input'],
  ];
  for(const [label,fn,expected] of refusals)assert.throws(fn,code(expected),label);
 });
 assert.deepEqual(dump(assocPath(dest),ASSOC_TABLES),before);
 const r=withPort(d,port=>{const out=port.rotateRecipient(next.pin,2);assert.throws(()=>port.rotateRecipient(recipientCustody(s,4).pin,2),code('conflict'),'replayed CAS after success');return out;});
 assert.deepEqual({rev:r.hostRevision,tombstoned:r.tombstoned,gen:r.recipient.generation},{rev:3,tombstoned:1,gen:3});
 const after=dump(assocPath(dest),ASSOC_TABLES);
 assert.equal(after.metadata![0].host_revision,3);assert.deepEqual(JSON.parse(after.metadata![0].recipient_json),{...next.pin});
 assert.deepEqual(after.pins!.filter((p:Json)=>p.device_id==='relay_host').map((p:Json)=>p.generation),[1,2,3]);
 // Generations, pins and history preserved append-only; the previously active peer tombstoned with a `recipient` entry.
 for(const table of ['pins','history'] as const)for(const row of before[table]!)assert.ok(after[table]!.some((h:Json)=>JSON.stringify(h)===JSON.stringify(row)),`${table} preserved`);
 assert.deepEqual(after.associations!.map((a:Json)=>a.status),['revoked','revoked','revoked']);
 assert.deepEqual(after.history!.filter((h:Json)=>h.action==='recipient'&&h.host_revision===3).map((h:Json)=>h.device_id),[s.peer]);
 assert.equal(c.calls(),0);assert.equal(c.store.summary().counts.grants,0);
});

test('destination: restored peers stay tombstoned (activation revoked their bindings); only a re-paired CURRENT binding + next sender pin + exact revisions enrolls',async t=>{
 const d=await restored(t),{s,dest,c}=d;
 withPort(d,port=>port.rotateRecipient(recipientCustody(s,3).pin,2));
 const peerRev=association(dest,s.peer).revision as number,rotatedRev=association(dest,s.rotatedPeer).revision as number;
 // Activation revoked every restored Hub device: the restored AppClient bindings are revoked, never re-activated.
 for(const id of [s.peer,s.revokedPeer,s.rotatedPeer])assert.equal(c.registry.binding(id)!.status,'revoked');
 const repaired=pair(c.registry),binding=c.registry.binding(repaired)!,gen1=endpoint(s,repaired,1),before=dump(assocPath(dest),ASSOC_TABLES);
 withPort(d,port=>{
  const refuse=(label:string,input:Json,expected:string)=>assert.throws(()=>port.enroll(input),code(expected),label);
  refuse('restored peer, revoked binding (as stored)',{expectedRevision:peerRev,expectedHostRevision:3,binding:c.registry.binding(s.peer)!,senderPin:endpoint(s,s.peer,3).publicPin},'forbidden');
  refuse('restored peer, revoked binding relabelled active',{expectedRevision:peerRev,expectedHostRevision:3,binding:{...c.registry.binding(s.peer)!,status:'active'},senderPin:endpoint(s,s.peer,3).publicPin},'forbidden');
  refuse('rotated peer, revoked binding relabelled active',{expectedRevision:rotatedRev,expectedHostRevision:3,binding:{...c.registry.binding(s.rotatedPeer)!,status:'active'},senderPin:endpoint(s,s.rotatedPeer,2).publicPin},'forbidden');
  refuse('restored peer, someone else\'s current binding',{expectedRevision:peerRev,expectedHostRevision:3,binding,senderPin:endpoint(s,s.peer,3).publicPin},'conflict');
  refuse('new peer claims a revision it does not have',{expectedRevision:1,expectedHostRevision:3,binding,senderPin:gen1.publicPin},'conflict');
  refuse('new peer skips a sender generation',{expectedRevision:null,expectedHostRevision:3,binding,senderPin:endpoint(s,repaired,2).publicPin},'conflict');
  refuse('new peer reuses an archived sender key',{expectedRevision:null,expectedHostRevision:3,binding,senderPin:{...s.senderGen2.publicPin,deviceId:repaired,generation:1}},'conflict');
  refuse('sender pin of another device',{expectedRevision:null,expectedHostRevision:3,binding,senderPin:endpoint(s,s.rotatedPeer,2).publicPin},'forbidden');
  refuse('stale host CAS',{expectedRevision:null,expectedHostRevision:2,binding,senderPin:gen1.publicPin},'forbidden');
  // Drifted binding (TLS rotated after it was read): the remembered binding is refused; only the live one is accepted.
  rotateTls(c.registry,repaired);refuse('drifted binding',{expectedRevision:null,expectedHostRevision:3,binding,senderPin:gen1.publicPin},'forbidden');
 });
 assert.deepEqual(dump(assocPath(dest),ASSOC_TABLES),before);
 const live=c.registry.binding(repaired)!;assert.notEqual(live.revision,binding.revision);
 withPort(d,port=>{
  assert.deepEqual(port.enroll({expectedRevision:null,expectedHostRevision:3,binding:live,senderPin:gen1.publicPin}),{deviceId:repaired,revision:1});
  assert.throws(()=>port.enroll({expectedRevision:1,expectedHostRevision:3,binding:live,senderPin:endpoint(s,repaired,2).publicPin}),code('conflict'),'an active association is never bumped by recovery');
 });
 const after=dump(assocPath(dest),ASSOC_TABLES);
 assert.deepEqual(after.associations!.filter((a:Json)=>a.status==='active').map((a:Json)=>a.device_id),[repaired]);
 for(const id of [s.peer,s.revokedPeer,s.rotatedPeer])assert.equal(after.associations!.find((a:Json)=>a.device_id===id).status,'revoked');
 const enrolled=after.history!.filter((h:Json)=>h.device_id===repaired);
 assert.deepEqual(enrolled.map((h:Json)=>({action:h.action,host:h.host_revision,binding:JSON.parse(h.binding_json).revision,sender:JSON.parse(h.sender_json).generation})),[{action:'enroll',host:3,binding:live.revision,sender:1}]);
 assert.equal(c.store.summary().counts.grants,0);assert.equal(c.calls(),0);
});

test('live installation (no transfer): tombstone re-enrollment needs the current binding, the NEXT sender generation and exact CAS',async t=>{
 const s=await seedRotatedSource(t);const c=compose(s.data);defer(t,()=>c.close());
 const open=()=>new RelayRecoveryMaintenance(c.host,c.bindings,s.data);
 withPort({open},port=>port.rotateRecipient(recipientCustody(s,3).pin,2));
 const peerRev=association(s.data,s.peer).revision as number,binding=c.registry.binding(s.peer)!;assert.equal(binding.status,'active');
 const gen3=endpoint(s,s.peer,3),before=dump(assocPath(s.data),ASSOC_TABLES);
 withPort({open},port=>{
  const refuse=(label:string,input:Json,expected:string)=>assert.throws(()=>port.enroll(input),code(expected),label);
  refuse('old (same) sender pin',{expectedRevision:peerRev,expectedHostRevision:3,binding,senderPin:s.senderGen2.publicPin},'conflict');
  refuse('skipped sender generation',{expectedRevision:peerRev,expectedHostRevision:3,binding,senderPin:endpoint(s,s.peer,4).publicPin},'conflict');
  refuse('reused sender keys at next generation',{expectedRevision:peerRev,expectedHostRevision:3,binding,senderPin:{...s.senderGen2.publicPin,generation:3,keyId:'reused'}},'conflict');
  refuse('stale peer CAS',{expectedRevision:peerRev-1,expectedHostRevision:3,binding,senderPin:gen3.publicPin},'conflict');
  refuse('null revision for an existing tombstone',{expectedRevision:null,expectedHostRevision:3,binding,senderPin:gen3.publicPin},'conflict');
  refuse('stale host CAS',{expectedRevision:peerRev,expectedHostRevision:2,binding,senderPin:gen3.publicPin},'forbidden');
  c.registry.revokeDevice(s.rotatedPeer);
  refuse('revoked canonical binding',{expectedRevision:association(s.data,s.rotatedPeer).revision,expectedHostRevision:3,binding:{...c.registry.binding(s.rotatedPeer)!,status:'active'},senderPin:endpoint(s,s.rotatedPeer,2).publicPin},'forbidden');
 });
 assert.deepEqual(dump(assocPath(s.data),ASSOC_TABLES),before);
 withPort({open},port=>assert.deepEqual(port.enroll({expectedRevision:peerRev,expectedHostRevision:3,binding,senderPin:gen3.publicPin}),{deviceId:s.peer,revision:peerRev+1}));
 assert.deepEqual(dump(assocPath(s.data),['history']).history!.filter((h:Json)=>h.device_id===s.peer).map((h:Json)=>`${h.action}@${h.host_revision}`),['enroll@1','recipient@2','enroll@2','recipient@3','enroll@3']);
 assert.equal(c.calls(),0);
});

test('lost writer/authority refuses at the final mutation boundary; nothing written',async t=>{
 const d=await restored(t),{s,dest,c}=d;withPort(d,()=>undefined);const before=dump(assocPath(dest),ASSOC_TABLES);
 const port=d.open();const status=port.status();assert.equal(status.hostRevision,2);
 const raw=new DatabaseSync(join(dest,'dexter.sqlite'));raw.prepare('UPDATE host_lease SET token=? WHERE id=1').run('synthetic_lost_writer_'+randomUUID());raw.close();d.quarantine();
 assert.throws(()=>port.rotateRecipient(recipientCustody(s,3).pin,2),code('host_locked'));
 assert.throws(()=>port.enroll({expectedRevision:2,expectedHostRevision:2,binding:c.registry.binding(s.rotatedPeer)!,senderPin:endpoint(s,s.rotatedPeer,2).publicPin}),code('host_locked'));
 assert.throws(()=>port.status(),code('host_locked'));
 // Close fails closed too: the handle stays quarantined (existing associations semantics), never reopened in-process.
 assert.throws(()=>port.close());assert.throws(()=>d.open(),code('host_locked'));
 assert.deepEqual(dump(assocPath(dest),ASSOC_TABLES),before);
});

test('after approval only the EXACT new provider reopens; old generation/ACKs fail on the real RelayStore; no replay of unknown/prepared, no grants',async t=>{
 const d=await restored(t),{s,dest,c}=d;const custody3=recipientCustody(s,3),repaired=pair(c.registry),gen1=endpoint(s,repaired,1);
 withPort(d,port=>port.rotateRecipient(custody3.pin,2));
 withPort(d,port=>port.enroll({expectedRevision:null,expectedHostRevision:3,binding:c.registry.binding(repaired)!,senderPin:gen1.publicPin}));
 const consumerBefore=dump(consumerPath(dest),CONSUMER_TABLES),assocBefore=dump(assocPath(dest),ASSOC_TABLES);
 // Old custody (gen2) refused; a different provider under the new pin refused; nothing written by refusals.
 assert.throws(()=>new RelayHost(c.host,c.bindings,dest,hostOptions(recipientCustody(s,2),s.transport)),code('conflict'));
 const impostor=recipientCustody(s,3);
 assert.throws(()=>validateRelayHostOptions({recipient:custody3.pin,custody:impostor.provider,custodyMode:'laboratory-memory',transport:s.transport,transportOwnership:'borrowed',deployment:{maximumPendingPerRecipient:64}}),code('invalid_input'));
 assert.deepEqual(dump(assocPath(dest),ASSOC_TABLES),assocBefore);
 // Separate owner action on the persistent remote RelayStore: register the new public recipient and sender pins.
 s.relay.registerDevice(custody3.pin);s.relay.registerDevice(gen1.publicPin);
 // The retained gen2 ACK request (restored request_json) no longer authenticates.
 assert.throws(()=>s.relay.ack(s.pendingMessage.request),code('forbidden'));
 const host=new RelayHost(c.host,c.bindings,dest,hostOptions(custody3,s.transport));host.transferOwnership();let hostClosed=false;
 defer(t,async()=>{if(!hostClosed)await host.close();});
 const thread=c.store.createThread(c.store.createBot({name:'dest',profileId:'personal',engine:'claude'}).id);
 s.relay.enqueue(seal(gen1,custody3.pin,1,'op_after_reapproval',thread.id));
 // The restored (tombstoned) peer still holds its registered gen2 sender pin remotely, but cannot act on the new host.
 s.relay.enqueue(seal(s.senderGen2,custody3.pin,1,'op_from_tombstone',thread.id));
 // The real new custody (gen3) polls: the stale gen2 receipt is not offered; the approved envelope runs once, the tombstoned peer is blocked.
 const report=await host.wake();
 assert.deepEqual({delivered:report.delivered,accepted:report.accepted,acked:report.acked,replayed:report.replayed,unknown:report.unknown,blocked:report.blocked},{delivered:2,accepted:1,acked:1,replayed:0,unknown:0,blocked:1});
 assert.deepEqual({...(await host.wake())},{delivered:1,accepted:0,replayed:0,inert:0,acked:0,blocked:1,unknown:0},'tombstoned peer stays blocked (no ACK, no turn)');
 await until(()=>c.calls()===1);await new Promise(r=>setTimeout(r,50));
 assert.equal(c.calls(),1,'exactly the newly approved turn ran; unknown/prepared/pending were not replayed');
 await host.close();hostClosed=true;
 const consumerAfter=dump(consumerPath(dest),CONSUMER_TABLES);
 // Every restored row remains exactly (unknown/prepared, pending ACK with retained request_json stays unresolved).
 for(const table of CONSUMER_TABLES)for(const row of consumerBefore[table]!)assert.ok(consumerAfter[table]!.some((r:Json)=>JSON.stringify(r)===JSON.stringify(row)),`${table} row preserved`);
 assert.equal(consumerAfter.operations!.length,consumerBefore.operations!.length+1);
 assert.equal(consumerAfter.acknowledgements!.find((a:Json)=>a.message_id===s.pendingMessage.messageId).state,'pending');
 assert.equal(c.store.summary().counts.grants,0);
});

test('real RelayStore: after recipient re-registration the old generation cannot poll/ACK and old receipts are not offered to the new one',async t=>{
 const ids={hostId:'inst_store_probe',ownerId:'owner_store_probe'};const dir=workspace(t,'g8rr-store-');
 const store=new RelayStore({dataDir:dir,ownerId:ids.ownerId,installationId:ids.hostId,maximumPendingPerRecipient:16});defer(t,()=>store.close());
 const r1=endpoint(ids,'relay_host',1,'r_k1'),r2=endpoint(ids,'relay_host',2,'r_k2'),sender=endpoint(ids,'peer_a',1,'p_k1');
 store.registerDevice(r1.publicPin);store.registerDevice(sender.publicPin);
 const env=seal(sender,r1.publicPin,1,'op_old','thread_x');const q=store.enqueue(env);
 assert.equal(store.poll(r1.poll({requestId:randomUUID(),issuedAt:Date.now(),after:0,limit:10})).deliveries.length,1);
 const retainedAck=r1.ack({requestId:randomUUID(),issuedAt:Date.now(),messages:[{messageId:env.messageId,receiptId:q.receiptId}]});
 store.registerDevice(r2.publicPin);// separate owner-approved rotation of the recipient pin
 assert.throws(()=>store.poll(r1.poll({requestId:randomUUID(),issuedAt:Date.now(),after:0,limit:10})),code('forbidden'),'old generation cannot poll');
 assert.throws(()=>store.ack(retainedAck),code('forbidden'),'retained old-generation ACK refused');
 assert.equal(store.poll(r2.poll({requestId:randomUUID(),issuedAt:Date.now(),after:0,limit:10})).deliveries.length,0,'old receipt not offered to the new generation');
 assert.throws(()=>store.ack(r2.ack({requestId:randomUUID(),issuedAt:Date.now(),messages:[{messageId:env.messageId,receiptId:q.receiptId}]})),code('forbidden'),'old receipt cannot be ACKed with the new generation');
 assert.throws(()=>store.registerDevice(r1.publicPin),code('conflict'),'old recipient pin cannot be re-registered');
 assert.ok(existsSync(join(dir,'relay.sqlite')));
});


test('association row host revisions: full relay open refuses malformed revoked rows and projects legitimate tombstones',async t=>{
 const s=await seedRotatedSource(t),c=compose(s.data);defer(t,()=>c.close());
 const dir=workspace(t,'g8rr-row-');let n=0;
 const before=dump(assocPath(s.data),ASSOC_TABLES),consumer=dump(consumerPath(s.data),CONSUMER_TABLES);
 const open=(sql?:string)=>{const directory=join(dir,`row${n++}`);mkdirSync(directory,{mode:0o700});const path=join(directory,'relay-associations.sqlite');copyFileSync(assocPath(s.data),path);
  if(sql){const db=new DatabaseSync(path);try{db.exec(sql);}finally{db.close();}}
  return new RelayAssociations(c.host,c.bindings,directory,s.recipient2);
 };
 for(const value of ["'invalid'",'0','-1','1.5','1e20','3'])assert.throws(()=>open(`UPDATE associations SET host_revision=${value} WHERE device_id='${s.revokedPeer}'`),code(value==='3'?'conflict':'invalid_input'),`revoked row ${value}`);
 for(const current of [false,true]){
  const a=open(current?`UPDATE associations SET host_revision=2 WHERE device_id='${s.revokedPeer}'`:undefined);
  try{
   assert.deepEqual(a.association(s.revokedPeer),{revision:2,status:'revoked',hostRevision:current?2:1});
   assert.deepEqual(a.association(s.rotatedPeer),{revision:2,status:'revoked',hostRevision:1});
   assert.deepEqual(a.association(s.peer),{revision:3,status:'active',hostRevision:2});
  }finally{a.close();}
 }
 const a=open();try{
  const binding=c.registry.binding(s.revokedPeer)!;
  assert.throws(()=>a.enroll({binding,senderPin:endpoint(s,s.revokedPeer,1).publicPin,expectedRevision:2,expectedHostRevision:2}),code('conflict'));
  assert.deepEqual(a.enroll({binding,senderPin:endpoint(s,s.revokedPeer,2).publicPin,expectedRevision:2,expectedHostRevision:2}),{deviceId:s.revokedPeer,revision:3});
  assert.deepEqual(a.association(s.revokedPeer),{revision:3,status:'active',hostRevision:2});
 }finally{a.close();}
 const after=dump(join(dir,`row${n-1}`,'relay-associations.sqlite'),ASSOC_TABLES);
 for(const table of ['history','pins'] as const)for(const row of before[table]!)assert.ok(after[table]!.some((r:Json)=>JSON.stringify(r)===JSON.stringify(row)),`${table} preserved`);
 assert.deepEqual(dump(assocPath(s.data),ASSOC_TABLES),before);assert.deepEqual(dump(consumerPath(s.data),CONSUMER_TABLES),consumer);
 assert.equal(c.calls(),0);assert.equal(c.store.summary().counts.grants,0);
});
