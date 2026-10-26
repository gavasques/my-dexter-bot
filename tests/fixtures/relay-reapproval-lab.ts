// G8 relay destination reapproval lab: real HostStore/AppClient registry/RelayHost/RelayStore/relay-consumer journal,
// real operations CLI transfer. Synthetic custody keys stay in process memory; no key or auth file is ever written.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, createPrivateKey, createPublicKey, createSecretKey, sign } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { HostStore, ConversationRuntime, type RuntimeDriver } from '@dexter/hub';
import { ClientPairingRegistry } from '@dexter/devices';
import { RelayStore, RelayEndpoint, type DevicePin, type Envelope } from '@dexter/relay';
import { RelayHost, validateRelayHostOptions, type RelayHostOptions } from '@dexter/relay-host';
import type { HostPort, RelayTransport } from '@dexter/relay-consumer';
import { runCli, type CustodyProvider, type OwnerAuthority, type SnapshotKey } from '@dexter/operations';
import { memoryCustody, until } from './relay-host-lab.js';
// Real relay consumer journal (not re-exported by the package), loaded from this lab's own build.
const { ConsumerJournal } = await import(new URL('../../../packages/relay-consumer/dist/journal.js', import.meta.url).href) as {
 ConsumerJournal: new (host:HostPort,directory:string)=>{prepare(e:object,m:string,r:string,i:string,p:string):unknown;state(d:string,o:string,s:string,t:string|null):void;close():void};
};
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json=any;
export const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
export const code=(name:string)=>(e:unknown)=>!!e&&typeof e==='object'&&'code' in e&&(e as {code:unknown}).code===name;
const stacks=new WeakMap<TestContext,Array<()=>unknown>>();
/** One LIFO cleanup stack per test: handles close before their directories are removed. */
export function defer(t:TestContext,fn:()=>unknown):void{let stack=stacks.get(t);if(!stack){const created:Array<()=>unknown>=[];stack=created;stacks.set(t,created);t.after(async()=>{while(created.length)await created.pop()!();});}stack.push(fn);}
export function workspace(t:TestContext,prefix='g8rr-'):string{const d=realpathSync(mkdtempSync(join(tmpdir(),prefix)));chmodSync(d,0o700);defer(t,()=>rmSync(d,{recursive:true,force:true}));return d;}
/** Operations custody (owner signer + snapshot key) held in memory only. */
export function operationsCustody():{provider:CustodyProvider}{
 const {privateKey}=generateKeyPairSync('ed25519');const pk=createPrivateKey({key:privateKey.export({format:'der',type:'pkcs8'}),format:'der',type:'pkcs8'});
 const owner:OwnerAuthority={publicKey:createPublicKey(pk),sign:(m)=>sign(null,m,pk)};const secret=createSecretKey(randomBytes(32));const key:SnapshotKey={keyId:'g8-rr-key',use:(op)=>op(secret)};
 return {provider:{snapshotKey:()=>key,ownerSigner:()=>owner}};
}
export async function cli(argv:string[],custody:{provider:CustodyProvider}):Promise<Json>{const lines:string[]=[];const c=await runCli(argv,{write:(l)=>lines.push(l),custody:custody.provider});assert.equal(lines.length,1);const out=JSON.parse(lines[0]!);assert.equal(out.ok,true,lines[0]);assert.equal(c,0);return out;}
/** Exact semantic dump of a SQLite file (immutable read; never creates sidecars or writes). */
export function dump(path:string,tables:readonly string[]):Record<string,Json[]>{const url=pathToFileURL(path);url.search='immutable=1';const db=new DatabaseSync(url,{readOnly:true});try{return Object.fromEntries(tables.map(t=>[t,(db.prepare(`SELECT * FROM ${t} ORDER BY 1,2`).all() as Json[]).map(r=>({...r}))]));}finally{db.close();}}
export const ASSOC_TABLES=['metadata','associations','history','pins'] as const;
export const CONSUMER_TABLES=['metadata','operations','issuers','acknowledgements'] as const;
export const assocPath=(data:string)=>join(data,'relay-host','relay-associations.sqlite');
export const consumerPath=(data:string)=>join(data,'relay-host','relay-consumer.sqlite');
export const fileSha=(p:string)=>sha(readFileSync(p));
export function pair(registry:ClientPairingRegistry,scopes:readonly ('chat.write'|'chat.read')[]=['chat.write']):string{const offer=registry.createOffer({kind:'pair',role:'client-ios',scopes}),claim=registry.claim({offerId:offer.offerId,code:offer.code,name:'Synthetic relay app',clientFingerprint:sha(randomUUID())});return registry.approveClaim(claim.claimId).deviceId;}
export function rotateTls(registry:ClientPairingRegistry,deviceId:string){const offer=registry.createOffer({kind:'rotate',deviceId}),claim=registry.claim({offerId:offer.offerId,code:offer.code,name:'rotated',clientFingerprint:sha(randomUUID())});registry.approveClaim(claim.claimId);}
export interface Composed {store:HostStore;registry:ClientPairingRegistry;runtime:ConversationRuntime;host:HostPort;bindings:{binding(id:string):Json};calls():number;close():Promise<void>}
/** Canonical HostPort over the real HostStore/runtime with a counting synthetic driver (no engine/inference). */
export function compose(dataDir:string):Composed{
 const store=new HostStore({dataDir}),registry=new ClientPairingRegistry(store);let calls=0;
 const driver:RuntimeDriver={id:'claude',sessionReuse:'turn',async open(threadId){return {threadId,nativeCursor:'synthetic'};},async *turn(session,turnId){calls++;yield {type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},async close(){},async interrupt(){},async respondToTool(){}};
 const runtime=new ConversationRuntime({store,drivers:[driver]});
 const host:HostPort=Object.freeze({hostId:store.hostId,ownerId:store.ownerId,withWriterLease:<T>(fn:()=>T)=>store.withWriterLease(fn),startTurn:(id:string,v:{clientRequestId:string;content:string},hash:string)=>runtime.startTurn(id,v,hash).turn,findTurn:(id:string,r:string)=>store.findTurn(id,r),turnInput:(id:string)=>store.turnInput(id),sourceHash:(id:string)=>store.relaySourceHash(id),checkThread:(id:string)=>{store.withWriterLease(()=>{assert.ok(runtime.isBoundTo(store));assert.equal(store.getBot(store.getThread(id).botId).ownerId,store.ownerId);});}});
 const bindings=Object.freeze({binding:(id:string)=>store.withWriterLease(()=>registry.binding(id))});
 return {store,registry,runtime,host,bindings,calls:()=>calls,async close(){await runtime.shutdown({closeStore:false});registry.close();store.close();}};
}
export function hostOptions(custody:{provider:Json;pin:DevicePin},transport:RelayTransport):Readonly<RelayHostOptions>{return validateRelayHostOptions({recipient:custody.pin,custody:custody.provider,custodyMode:'laboratory-memory',transport,transportOwnership:'borrowed',deployment:{maximumPendingPerRecipient:64}});}
export const recipientCustody=(store:{hostId:string;ownerId:string},generation:number)=>memoryCustody({installationId:store.hostId,ownerId:store.ownerId,deviceId:'relay_host',generation,keyId:`host_key_${generation}`});
export function seal(sender:RelayEndpoint,recipient:DevicePin,sequence:number,operationId:string,threadId:string,content='synthetic content'):Envelope{const now=Date.now();return sender.seal(recipient,{messageId:'message_'+randomUUID(),sequence,type:'command',createdAt:now,expiresAt:now+600000},Buffer.from(JSON.stringify({version:1,operation:'turn.submit',operationId,threadId,content})));}
export interface SourceState {
 root:string;data:string;relay:RelayStore;hostId:string;ownerId:string;threadId:string;peer:string;revokedPeer:string;rotatedPeer:string;
 recipient2:DevicePin;senderGen2:RelayEndpoint;pendingMessage:{messageId:string;receiptId:string;request:Json};acks:{failNext:boolean};transport:RelayTransport;
}
/**
 * Source installation with a REAL recipient rotation: peer enrolled → rotated (tombstone `recipient`) → re-enrolled
 * with sender gen2; revokedPeer tombstoned by `revoke`; rotatedPeer left with last history action `recipient`.
 * Consumer: one committed+acked turn, one committed turn whose ACK transport failed (pending ACK with retained
 * gen2 request_json), plus explicit prepared and unknown entries. All stores closed on return; remote RelayStore
 * (outside the data directory, never in the artifact) stays open for the caller.
 */
export async function seedRotatedSource(t:TestContext):Promise<SourceState>{
 const root=workspace(t),data=join(root,'source');const c=compose(data);
 const peer=pair(c.registry),revokedPeer=pair(c.registry),rotatedPeer=pair(c.registry);
 const custody1=recipientCustody(c.store,1),custody2=recipientCustody(c.store,2);
 const relay=new RelayStore({dataDir:join(root,'relay'),ownerId:c.store.ownerId,installationId:c.store.hostId,maximumPendingPerRecipient:64});defer(t,()=>relay.close());
 const acks={failNext:false};const transport:RelayTransport={async poll(r){return relay.poll(r);},async ack(r){if(acks.failNext){acks.failNext=false;throw Error('synthetic ACK transport loss');}return relay.ack(r);},async close(){}};
 const endpoint=(device:string,generation:number)=>new RelayEndpoint({installationId:c.store.hostId,ownerId:c.store.ownerId,deviceId:device,generation,keyId:`${device}_k${generation}`});
 const s1=[peer,revokedPeer,rotatedPeer].map(d=>endpoint(d,1));
 relay.registerDevice(custody1.pin);for(const e of s1)relay.registerDevice(e.publicPin);
 const h1=new RelayHost(c.host,c.bindings,data,hostOptions(custody1,transport));h1.transferOwnership();
 for(const [i,d] of [peer,revokedPeer,rotatedPeer].entries())h1.admin.enroll({expectedRevision:null,expectedHostRevision:1,binding:c.registry.binding(d)!,senderPin:s1[i]!.publicPin});
 h1.admin.revoke(revokedPeer,1);h1.admin.rotateRecipient(custody2.pin,1);await h1.close();
 const h2=new RelayHost(c.host,c.bindings,data,hostOptions(custody2,transport));h2.transferOwnership();
 const senderGen2=endpoint(peer,2);h2.admin.enroll({expectedRevision:2,expectedHostRevision:2,binding:c.registry.binding(peer)!,senderPin:senderGen2.publicPin});
 relay.registerDevice(custody2.pin);relay.registerDevice(senderGen2.publicPin);
 const bot=c.store.createBot({name:'Relay reapproval fixture',profileId:'personal',engine:'claude'}),thread=c.store.createThread(bot.id);
 relay.enqueue(seal(senderGen2,custody2.pin,1,'op_acked',thread.id));const first=await h2.wake();assert.equal(first.accepted,1);assert.equal(first.acked,1);
 const pending=seal(senderGen2,custody2.pin,2,'op_pending',thread.id);const queued=relay.enqueue(pending);acks.failNext=true;const second=await h2.wake();assert.equal(second.accepted,1);assert.equal(second.unknown,1);
 await until(()=>c.calls()===2&&c.store.listTurns(thread.id).every(turn=>turn.state==='completed'));
 await h2.close();
 const journal=new ConsumerJournal(c.host,join(data,'relay-host'));const provenance=JSON.stringify(['synthetic-issuer']),issuer=sha(provenance);
 const entry=(operationId:string)=>({deviceId:peer,operationId,hash:sha(operationId),threadId:thread.id,requestId:'rq_'+operationId,issuerHash:issuer,state:'prepared',turnId:null});
 journal.prepare(entry('op_prepared'),'msg_prepared','rcpt_prepared',issuer,provenance);journal.prepare(entry('op_unknown'),'msg_unknown','rcpt_unknown',issuer,provenance);journal.state(peer,'op_unknown','unknown',null);journal.close();
 const ackRow=(dump(consumerPath(data),['acknowledgements']).acknowledgements as Json[]).find(r=>r.message_id===pending.messageId);
 assert.equal(ackRow.state,'pending');assert.equal(ackRow.receipt_id,queued.receiptId);const request=JSON.parse(ackRow.request_json);assert.equal(request.generation,2);
 const hostId=c.store.hostId,ownerId=c.store.ownerId;await c.close();
 return {root,data,relay,hostId,ownerId,threadId:thread.id,peer,revokedPeer,rotatedPeer,recipient2:custody2.pin,senderGen2,pendingMessage:{messageId:pending.messageId,receiptId:queued.receiptId,request},acks,transport};
}
/** Real offline transfer through the operations CLI (in-process, injected in-memory custody). */
export async function transfer(s:SourceState,custody=operationsCustody()):Promise<{dest:string;prepared:Json;activated:Json}>{
 const coord=join(s.root,'coordinator'),art=join(s.root,'checkpoint.dxg8'),rcpt=join(s.root,'receipt.json'),dest=join(s.root,'destination');
 await cli(['coordinator','init','--coordinator',coord,'--owner-id',s.ownerId],custody);
 const prepared=await cli(['transfer','prepare','--data-dir',s.data,'--coordinator',coord,'--output',art],custody);
 await cli(['transfer','revoke','--data-dir',s.data,'--coordinator',coord,'--checkpoint',prepared.checkpointId,'--destination',dest],custody);
 await cli(['transfer','receipt','--coordinator',coord,'--checkpoint',prepared.checkpointId,'--output',rcpt],custody);
 const activated=await cli(['transfer','activate','--coordinator',coord,'--artifact',art,'--receipt',rcpt],custody);
 return {dest,prepared,activated};
}
