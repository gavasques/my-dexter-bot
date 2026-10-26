// Relay scope mirrors after `outputs.read` / `outputs.manage` (synthetic E2E): real canonical pairing registry, real relay
// store, real signed + encrypted envelopes (in-memory lab custody), real RelayHost consumer and the Operations checkpoint
// validator. The relay admits a binding carrying the closed 14-scope set, still only `turn.submit` needs a scope
// (chat.write), and outputs.* never authorize a relayed operation. No account, provider, cloud relay or product port.
import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HostStore, ConversationRuntime, CLIENT_DEVICE_SCOPES, type ClientDeviceScope, type RuntimeDriver } from '@dexter/hub';
import { ClientPairingRegistry } from '@dexter/devices';
import { RelayStore, RelayEndpoint, type DevicePin, type Envelope } from '@dexter/relay';
import { MAX_CIPHERTEXT_BYTES } from '@dexter/relay/protocol';
import { RelayHost, validateRelayHostOptions, type RelayHostOptions } from '@dexter/relay-host';
import { RELAY_PRINCIPAL_SCOPES, type HostPort, type RelayTransport } from '@dexter/relay-consumer';
import { CLIENT_DEVICE_SCOPES as OPERATIONS_SCOPES, OperationsError } from '@dexter/operations';
import { memoryCustody, until } from './fixtures/relay-host-lab.js';
const { validateRelayAssociations } = await import(new URL('../../packages/operations/dist/checkpoint.js', import.meta.url).href) as { validateRelayAssociations(db:DatabaseSync):void };

const LEGACY:ClientDeviceScope[]=['approvals.decide','approvals.read','chat.read','chat.write','devices.manage','devices.read','grants.manage','grants.read'];
const ALL:ClientDeviceScope[]=[...CLIENT_DEVICE_SCOPES].sort();
const code=(name:string)=>(e:unknown)=>!!e&&typeof e==='object'&&'code'in e&&e.code===name;
const broken=(e:unknown)=>e instanceof OperationsError&&e.code==='reference_broken';

function lab(t:TestContext,scopes:readonly ClientDeviceScope[]){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'relay-output-scopes-')));chmodSync(dir,0o700);
 const data=join(dir,'host'),store=new HostStore({dataDir:data}),registry=new ClientPairingRegistry(store);
 const pair=(s:readonly ClientDeviceScope[],r:ClientPairingRegistry=registry)=>{const offer=r.createOffer({kind:'pair',role:'client-mac',scopes:[...s]});
  const claim=r.claim({offerId:offer.offerId,code:offer.code,name:'Synthetic relay app',clientFingerprint:createHash('sha256').update(randomUUID()).digest('hex')});return r.approveClaim(claim.claimId).deviceId;};
 const device=pair(scopes);
 let calls=0;const driver:RuntimeDriver={id:'claude',sessionReuse:'turn',async open(threadId){return {threadId,nativeCursor:'synthetic'};},async *turn(session,turnId){calls++;yield {type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},async close(){},async interrupt(){},async respondToTool(){}};
 const runtime=new ConversationRuntime({store,drivers:[driver]});
 const host:HostPort=Object.freeze({hostId:store.hostId,ownerId:store.ownerId,withWriterLease:<T>(fn:()=>T)=>store.withWriterLease(fn),
  startTurn:(id:string,v:{clientRequestId:string;content:string},hash:string)=>runtime.startTurn(id,v,hash).turn,findTurn:(id:string,request:string)=>store.findTurn(id,request),
  turnInput:(id:string)=>store.turnInput(id),sourceHash:(id:string)=>store.relaySourceHash(id),checkThread:(id:string)=>{store.withWriterLease(()=>{assert.equal(store.getBot(store.getThread(id).botId).ownerId,store.ownerId);});}});
 const bindings=Object.freeze({binding:(id:string)=>store.withWriterLease(()=>registry.binding(id))});
 const custody=memoryCustody({installationId:store.hostId,ownerId:store.ownerId,deviceId:'relay_host',generation:1,keyId:'host_key'});
 const relay=new RelayStore({dataDir:join(dir,'relay'),ownerId:store.ownerId,installationId:store.hostId,maximumPendingPerRecipient:131});relay.registerDevice(custody.pin);
 const transport:RelayTransport={async poll(r){return relay.poll(r);},async ack(r){return relay.ack(r);},async close(){}};
 const options:RelayHostOptions={recipient:custody.pin,custody:custody.provider,custodyMode:'laboratory-memory',transport,transportOwnership:'borrowed',deployment:{maximumPendingPerRecipient:131},maximumAssociations:64};
 let consumer=new RelayHost(host,bindings,data,validateRelayHostOptions(options));consumer.transferOwnership();
 const bot=store.createBot({name:'Relay fixture',profileId:'personal',engine:'claude'}),thread=store.createThread(bot.id);
 const sender=(deviceId:string,generation=1,installationId=store.hostId)=>{const endpoint=new RelayEndpoint({installationId,ownerId:store.ownerId,deviceId,generation,keyId:`key_${generation}_${randomUUID().slice(0,8)}`});let sequence=0;
  return {pin:endpoint.publicPin,seal:(type:Envelope['type'],body:unknown)=>{const now=Date.now(),sealed=endpoint.seal(custody.pin,{messageId:'message_'+randomUUID(),sequence:sequence+1,type,createdAt:now,expiresAt:now+60000},Buffer.from(JSON.stringify(body)));sequence++;return sealed;}};};
 const enroll=(deviceId:string,pin:DevicePin,expectedRevision:number|null=null,binding:unknown=registry.binding(deviceId))=>consumer.admin.enroll({expectedRevision,expectedHostRevision:consumer.admin.recipient().revision,binding:binding as never,senderPin:pin});
 const submit=(operationId:string,extra:Record<string,unknown>={})=>({version:1,operation:'turn.submit',operationId,threadId:thread.id,content:'synthetic content',...extra});
 const notice=(operationId:string)=>({version:1,operation:'notice.received',operationId,noticeId:'inert'});
 const turns=()=>store.listTurns(thread.id).length;
 t.after(async()=>{await consumer.close();await runtime.shutdown({closeStore:false});registry.close();relay.close();store.close();rmSync(dir,{recursive:true,force:true});});
 return {dir,data,store,registry,device,relay,custody,thread,pair,sender,enroll,submit,notice,turns,get consumer(){return consumer;},get calls(){return calls;},
  async restart(){await consumer.close();consumer=new RelayHost(host,bindings,data,validateRelayHostOptions({...options,custody:custody.freshProvider()}));consumer.transferOwnership();},
  rotate(deviceId:string){const offer=registry.createOffer({kind:'rotate',deviceId}),claim=registry.claim({offerId:offer.offerId,code:offer.code,name:'rotated',clientFingerprint:createHash('sha256').update(randomUUID()).digest('hex')});registry.approveClaim(claim.claimId);},
  // The live association store is exclusively locked: close the consumer, copy the closed file, resume a fresh consumer.
  async associations(){await consumer.close();const copy=join(dir,`assoc-${randomUUID()}.sqlite`),live=join(data,'relay-host','relay-associations.sqlite');
   for(const suffix of ['','-wal'])if(existsSync(live+suffix))copyFileSync(live+suffix,copy+suffix);
   consumer=new RelayHost(host,bindings,data,validateRelayHostOptions({...options,custody:custody.freshProvider()}));consumer.transferOwnership();return copy;}};
}
const checkpoint=(path:string,mutate?:string,...params:string[])=>{const db=new DatabaseSync(path);try{if(mutate)db.prepare(mutate).run(...params);validateRelayAssociations(db);}finally{db.close();}};

test('relay scope mirrors are exactly the closed host set; outputs.* are members, nothing else',()=>{
 assert.deepEqual([...RELAY_PRINCIPAL_SCOPES].sort(),ALL);assert.deepEqual([...OPERATIONS_SCOPES].sort(),ALL);
 assert.equal(RELAY_PRINCIPAL_SCOPES.length,14);assert.ok(Object.isFrozen(RELAY_PRINCIPAL_SCOPES));
 assert.deepEqual(ALL.filter(s=>!LEGACY.includes(s)),['connections.manage','connections.read','mcp.manage','mcp.read','outputs.manage','outputs.read']);
});

test('explicit 14-scope binding enrolls over the relay, submits exactly once, replay repeats nothing; checkpoint accepts it',async t=>{
 const l=lab(t,ALL),s=l.sender(l.device);l.relay.registerDevice(s.pin);l.enroll(l.device,s.pin);
 assert.deepEqual([...l.consumer.admin.binding(l.device)!.scopes],ALL);
 const first=s.seal('command',l.submit('op_all'));l.relay.enqueue(first);
 const r=await l.consumer.wake();assert.equal(r.accepted,1);assert.equal(r.acked,1);await until(()=>l.calls===1);
 l.relay.enqueue(s.seal('command',l.submit('op_all')));assert.equal((await l.consumer.wake()).replayed,1);assert.equal(l.calls,1);assert.equal(l.turns(),1);
 checkpoint(await l.associations()); // Operations relayBinding: the 14-scope association is a valid checkpoint member
 assert.equal(existsSync(join(l.data,'output-files.sqlite')),false,'the relay never touches output folders');
});

test('the old 8 stay valid and never gain outputs.* at pairing, rotation, resume or restore',async t=>{
 const l=lab(t,LEGACY);let s=l.sender(l.device);l.relay.registerDevice(s.pin);l.enroll(l.device,s.pin);
 assert.deepEqual([...l.registry.binding(l.device)!.scopes],LEGACY);
 l.relay.enqueue(s.seal('command',l.submit('op_legacy')));assert.equal((await l.consumer.wake()).accepted,1);await until(()=>l.calls===1);
 l.rotate(l.device);assert.deepEqual([...l.registry.binding(l.device)!.scopes],LEGACY,'rotation keeps exactly the approved scopes');
 s=l.sender(l.device,2);l.relay.registerDevice(s.pin);l.enroll(l.device,s.pin,1);
 await l.restart();assert.deepEqual([...l.consumer.admin.binding(l.device)!.scopes],LEGACY,'resume restores the enrolled binding as stored');
 l.relay.enqueue(s.seal('command',l.submit('op_after_rotation')));assert.equal((await l.consumer.wake()).accepted,1);await until(()=>l.calls===2);
 const copy=await l.associations();checkpoint(copy);
 const db=new DatabaseSync(copy);try{for(const row of db.prepare('SELECT binding_json FROM history').all())assert.deepEqual(JSON.parse(String(row.binding_json)).scopes,LEGACY);}finally{db.close();}
});

test('outputs-only binding enrolls but cannot submit or run any output operation over the relay; body cannot grant',async t=>{
 const l=lab(t,['outputs.manage','outputs.read']),s=l.sender(l.device);l.relay.registerDevice(s.pin);l.enroll(l.device,s.pin);
 l.relay.enqueue(s.seal('command',l.submit('op_outputs')));
 l.relay.enqueue(s.seal('command',l.submit('op_claims',{scopes:['chat.write'],role:'client-mac'})));
 l.relay.enqueue(s.seal('command',{version:1,operation:'outputs.destination',operationId:'op_dest',expectedRevision:1,destination:{kind:'host_data_default'}}));
 l.relay.enqueue(s.seal('command',{version:1,operation:'outputs.content',operationId:'op_read',namespace:'general',path:'x'}));
 assert.equal((await l.consumer.wake()).blocked,4);
 l.relay.enqueue(s.seal('event',l.notice('op_notice')));{const w=await l.consumer.wake();assert.equal(w.inert,1);assert.equal(w.accepted,0);}
 assert.equal(l.turns(),0);assert.equal(l.calls,0);assert.equal(existsSync(join(l.data,'output-files.sqlite')),false);
 const read=l.pair(['outputs.read']),r=l.sender(read);l.relay.registerDevice(r.pin);l.enroll(read,r.pin);
 l.relay.enqueue(r.seal('command',l.submit('op_read_only')));{const w=await l.consumer.wake();assert.equal(w.accepted,0);assert.equal(w.blocked,w.delivered,'blocked deliveries stay unacknowledged; the new one too');}assert.equal(l.turns(),0);
});

test('unknown, oversized or forged scope sets have no bypass at pairing, enrollment, consumption or checkpoint',async t=>{
 const l=lab(t,ALL),s=l.sender(l.device);l.relay.registerDevice(s.pin);
 assert.throws(()=>l.registry.createOffer({kind:'pair',role:'client-mac',scopes:['outputs.admin' as ClientDeviceScope]}),code('invalid_input'));
 const live=l.registry.binding(l.device)!;
 for(const scopes of [[...ALL.slice(0,9),'outputs.admin'],[...ALL,'outputs.write'],['chat.write','chat.write'],[...ALL,...ALL].slice(0,15)])
  assert.throws(()=>l.enroll(l.device,s.pin,null,{...live,scopes}),code('invalid_input'),JSON.stringify(scopes));
 const narrow=l.pair(['chat.read']),n=l.sender(narrow);l.relay.registerDevice(n.pin);
 assert.throws(()=>l.enroll(narrow,n.pin,null,{...l.registry.binding(narrow)!,scopes:['chat.read','chat.write']}),code('forbidden'),'a valid but unapproved scope is not a grant');
 l.enroll(l.device,s.pin);
 // A live canonical binding that grew an unknown scope (private storage tampered) is no authority for the relay.
 const db=new DatabaseSync(l.registry.databasePath),row=db.prepare('SELECT scopes FROM client_bindings WHERE device_id=?').get(l.device)!;
 db.prepare('UPDATE client_bindings SET scopes=? WHERE device_id=?').run('["chat.write","outputs.admin"]',l.device);
 l.relay.enqueue(s.seal('command',l.submit('op_tampered')));
 {const w=await l.consumer.wake();assert.equal(w.accepted,0);assert.equal(w.blocked,1);assert.equal(w.acked,0);}
 assert.equal(l.turns(),0);db.prepare('UPDATE client_bindings SET scopes=? WHERE device_id=?').run(String(row.scopes),l.device);db.close();
 const copy=await l.associations(),forged=JSON.stringify({...live,scopes:[...ALL.slice(0,9),'outputs.admin']});
 assert.throws(()=>checkpoint(copy,'UPDATE associations SET binding_json=? WHERE device_id=?',forged,l.device),broken);
 const copy2=await l.associations(),eleven=JSON.stringify({...live,scopes:[...ALL,'outputs.extra']});
 assert.throws(()=>checkpoint(copy2,'UPDATE history SET binding_json=? WHERE device_id=?',eleven,l.device),broken);
});

test('revoked, wrong host and wrong client stay denied with outputs.* present; encrypted relay limits unchanged',async t=>{
 const l=lab(t,ALL),s=l.sender(l.device);l.relay.registerDevice(s.pin);l.enroll(l.device,s.pin);
 // wrong client: a paired device never enrolled on the relay, and a sender pin of another device for this binding
 const other=l.pair(ALL),o=l.sender(other);l.relay.registerDevice(o.pin);
 l.relay.enqueue(o.seal('command',l.submit('op_other')));assert.equal((await l.consumer.wake()).blocked,1);
 assert.throws(()=>l.enroll(l.device,o.pin,1),code('forbidden'));
 // wrong host: a binding approved by another installation is never this host's authority
 const foreignStore=new HostStore({dataDir:join(l.dir,'foreign')}),foreignRegistry=new ClientPairingRegistry(foreignStore);
 t.after(()=>{foreignRegistry.close();foreignStore.close();});
 const foreign=l.pair(ALL,foreignRegistry),f=new RelayEndpoint({installationId:foreignStore.hostId,ownerId:foreignStore.ownerId,deviceId:foreign,generation:1,keyId:'foreign_key'});
 assert.throws(()=>l.consumer.admin.enroll({expectedRevision:null,expectedHostRevision:1,binding:foreignRegistry.binding(foreign)!,senderPin:f.publicPin}),(e:unknown)=>code('forbidden')(e)||code('invalid_input')(e));
 // encrypted relay limit: same ciphertext ceiling for every scope set
 assert.equal(MAX_CIPHERTEXT_BYTES,32_768);
 assert.throws(()=>s.seal('command',l.submit('op_huge',{content:'x'.repeat(MAX_CIPHERTEXT_BYTES)})),code('invalid_input'));
 // revoked: nothing admitted afterwards
 l.relay.enqueue(s.seal('command',l.submit('op_ok')));assert.equal((await l.consumer.wake()).accepted,1);await until(()=>l.calls===1);
 l.registry.revokeDevice(l.device);l.relay.enqueue(s.seal('command',l.submit('op_revoked')));assert.ok((await l.consumer.wake()).blocked>=1);assert.equal(l.turns(),1);
});
