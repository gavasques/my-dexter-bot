import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HostStore, ConversationRuntime, type RuntimeDriver } from '@dexter/hub';
import { ClientPairingRegistry } from '@dexter/devices';
import { RelayStore, RelayEndpoint, type Envelope } from '@dexter/relay';
import { RelayHost, RelayAssociations, validateRelayHostOptions, type RelayHostOptions } from '@dexter/relay-host';
import type { HostPort, RelayTransport } from '@dexter/relay-consumer';
import { HostServices } from '../packages/cli/src/host-services.js';
import { ownerControlRequest } from '../packages/cli/src/owner-control-client.js';
import { request } from 'node:https';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { PinnedRelayTransport } from '@dexter/relay-service';
import { gate, memoryCustody, memoryTLS, until } from './fixtures/relay-host-lab.js';
const root=(t:TestContext)=>{const d=realpathSync(mkdtempSync(join(tmpdir(),'relay-host-')));chmodSync(d,0o700);t.after(()=>{});return d;};
const code=(name:string)=>(e:unknown)=>!!e&&typeof e==='object'&&'code'in e&&e.code===name;
function canonical(store:HostStore,runtime:ConversationRuntime):HostPort{return Object.freeze({hostId:store.hostId,ownerId:store.ownerId,withWriterLease:<T>(fn:()=>T)=>store.withWriterLease(fn),startTurn:(id:string,v:{clientRequestId:string;content:string},hash:string)=>runtime.startTurn(id,v,hash).turn,findTurn:(id:string,request:string)=>store.findTurn(id,request),turnInput:(id:string)=>store.turnInput(id),sourceHash:(id:string)=>store.relaySourceHash(id),checkThread:(id:string)=>{store.withWriterLease(()=>{assert.ok(runtime.isBoundTo(store));assert.equal(store.getBot(store.getThread(id).botId).ownerId,store.ownerId);});}});}
function canonicalPair(registry:ClientPairingRegistry,role:'client-ios'|'client-mac'='client-ios',scopes:readonly ('chat.write'|'chat.read')[]=['chat.write']){const offer=registry.createOffer({kind:'pair',role,scopes}),fp=createHash('sha256').update(randomUUID()).digest('hex'),claim=registry.claim({offerId:offer.offerId,code:offer.code,name:'Synthetic relay app',clientFingerprint:fp});return registry.approveClaim(claim.claimId).deviceId;}
function lab(t:TestContext,maximum=4096){
 const dir=root(t),data=join(dir,'host'),store=new HostStore({dataDir:data}),registry=new ClientPairingRegistry(store),device=canonicalPair(registry);
 let calls=0;const driver:RuntimeDriver={id:'claude',sessionReuse:'turn',async open(threadId){return {threadId,nativeCursor:'synthetic'};},async *turn(session,turnId){calls++;yield {type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},async close(){},async interrupt(){},async respondToTool(){}};
 const runtime=new ConversationRuntime({store,drivers:[driver]}),host=canonical(store,runtime),bindings=Object.freeze({binding:(id:string)=>store.withWriterLease(()=>registry.binding(id))});
 const custody=memoryCustody({installationId:store.hostId,ownerId:store.ownerId,deviceId:'relay_host',generation:1,keyId:'host_key'});
 let sender=new RelayEndpoint({installationId:store.hostId,ownerId:store.ownerId,deviceId:device,generation:1,keyId:'sender_key'}),sequence=0;
 const relay=new RelayStore({dataDir:join(dir,'relay'),ownerId:store.ownerId,installationId:store.hostId,maximumPendingPerRecipient:131});relay.registerDevice(custody.pin);relay.registerDevice(sender.publicPin);
 const transport:RelayTransport={async poll(r){return relay.poll(r);},async ack(r){return relay.ack(r);},async close(){}};
 const options:RelayHostOptions={recipient:custody.pin,custody:custody.provider,custodyMode:'laboratory-memory',transport,transportOwnership:'borrowed',deployment:{maximumPendingPerRecipient:131},maximumAssociations:maximum};
 const consumer=new RelayHost(host,bindings,data,validateRelayHostOptions(options));consumer.transferOwnership();
 const enroll=(expectedRevision:number|null=null)=>consumer.admin.enroll({expectedRevision,expectedHostRevision:consumer.admin.recipient().revision,binding:registry.binding(device)!,senderPin:sender.publicPin});enroll();
 const envelope=(operationId='op_1',content='synthetic content',extra:Record<string,unknown>={},type:Envelope['type']='command')=>{const now=Date.now();return sender.seal(custody.pin,{messageId:'message_'+randomUUID(),sequence:++sequence,type,createdAt:now,expiresAt:now+60000},Buffer.from(JSON.stringify(type==='command'?{version:1,operation:'turn.submit',operationId,threadId:thread.id,content,...extra}:{version:1,operation:'notice.received',operationId,noticeId:'inert',...extra})));};
 const bot=store.createBot({name:'Relay fixture',profileId:'personal',engine:'claude'}),thread=store.createThread(bot.id);
 let quarantined=false;
 t.after(async()=>{if(quarantined)return;await consumer.close();await runtime.shutdown({closeStore:false});registry.close();relay.close();store.close();rmSync(dir,{recursive:true,force:true});});
 return {dir,data,store,registry,device,runtime,host,bindings,custody,consumer,relay,transport,options,thread,enroll,envelope,get calls(){return calls;},set quarantine(v:boolean){quarantined=v;},rotate(){const offer=registry.createOffer({kind:'rotate',deviceId:device}),claim=registry.claim({offerId:offer.offerId,code:offer.code,name:'rotated',clientFingerprint:createHash('sha256').update(randomUUID()).digest('hex')});registry.approveClaim(claim.claimId);sender=new RelayEndpoint({installationId:store.hostId,ownerId:store.ownerId,deviceId:device,generation:2,keyId:'sender_key_2'});sequence=0;},get sender(){return sender;}};
}
test('canonical registry association + actual custody accepts exactly one durable Hub source hash; changed body and authority fields denied',async t=>{
 const l=lab(t);l.relay.enqueue(l.envelope());const first=await l.consumer.wake();assert.equal(first.accepted,1);assert.equal(first.acked,1);await until(()=>l.calls===1);
 const turn=l.store.listTurns(l.thread.id)[0]!;assert.match(l.store.relaySourceHash(turn.id),/^[0-9a-f]{64}$/);assert.equal(l.store.turnInput(turn.id),'synthetic content');
 l.relay.enqueue(l.envelope());assert.equal((await l.consumer.wake()).replayed,1);assert.equal(l.calls,1);
 l.relay.enqueue(l.envelope('op_1','changed'));l.relay.enqueue(l.envelope('op_authority','x',{deviceId:l.device}));l.relay.enqueue(l.envelope('op_action','x',{operation:'action.dispatch'}));assert.equal((await l.consumer.wake()).blocked,3);assert.equal(l.store.listTurns(l.thread.id).length,1);
 const b=l.consumer.admin.binding(l.device)!;assert.ok(Object.isFrozen(b)&&Object.isFrozen(b.scopes));assert.equal(l.store.summary().counts.grants,0);
});
test('canonical rotation and revoke invalidate remembered relay pins; explicit public CAS reapproval required',async t=>{
 const l=lab(t),old=l.envelope();l.relay.enqueue(old);l.rotate();assert.equal((await l.consumer.wake()).blocked,1);assert.equal(l.store.listTurns(l.thread.id).length,0);
 assert.throws(()=>l.enroll(null),code('conflict'));l.relay.registerDevice(l.sender.publicPin);l.enroll(1);l.relay.enqueue(l.envelope('op_rotated'));assert.equal((await l.consumer.wake()).accepted,1);
 assert.throws(()=>l.enroll(2),code('conflict'));l.registry.revokeDevice(l.device);l.relay.enqueue(l.envelope('op_revoked'));assert.ok((await l.consumer.wake()).blocked>=1);assert.equal(l.store.listTurns(l.thread.id).length,1);
});
test('canonical read-only scope cannot submit; forged signature/header/body cannot create identity or grants',async t=>{
 const l=lab(t),read=canonicalPair(l.registry,'client-mac',['chat.read']),sender=new RelayEndpoint({installationId:l.store.hostId,ownerId:l.store.ownerId,deviceId:read,generation:1,keyId:'read_key'});l.relay.registerDevice(sender.publicPin);l.consumer.admin.enroll({expectedRevision:null,expectedHostRevision:1,binding:l.registry.binding(read)!,senderPin:sender.publicPin});
 let readSequence=0;const now=Date.now(),make=(type:Envelope['type'],content:unknown)=>sender.seal(l.custody.pin,{messageId:randomUUID(),sequence:++readSequence,type,createdAt:now,expiresAt:now+60000},Buffer.from(JSON.stringify(content)));
 l.relay.enqueue(make('command',{version:1,operation:'turn.submit',operationId:'read_op',threadId:l.thread.id,content:'x'}));assert.equal((await l.consumer.wake()).blocked,1);
 l.relay.enqueue(make('event',{version:1,operation:'notice.received',operationId:'notice_op',noticeId:'inert'}));assert.equal((await l.consumer.wake()).inert,1);assert.equal(l.store.listTurns(l.thread.id).length,0);
 const tampered={...l.envelope('tampered'),signature:Buffer.alloc(64).toString('base64')};assert.throws(()=>l.relay.enqueue(tampered));
 const transport:RelayTransport={async poll(){return {deliveries:[{envelope:tampered,cursor:1,receiptId:'fake_receipt'}],cursor:1};},async ack(){throw Error('must not ACK');},async close(){}};
 const other=new RelayHost(l.host,l.bindings,join(l.dir,'forged_host'),validateRelayHostOptions({...l.options,transport}));other.transferOwnership();other.admin.enroll({expectedRevision:null,expectedHostRevision:1,binding:l.registry.binding(l.device)!,senderPin:l.sender.publicPin});assert.equal((await other.wake()).blocked,1);await other.close();assert.equal(l.store.listTurns(l.thread.id).length,0);
});
test('public enrollment rejects accessors/proxies, tuples, stale CAS, duplicate keys and tombstone replay without eviction',async t=>{
 const l=lab(t),input={expectedRevision:1,expectedHostRevision:1,binding:l.registry.binding(l.device)!,senderPin:l.sender.publicPin};let accessed=false;
 assert.throws(()=>l.consumer.admin.enroll(Object.defineProperty({...input},'senderPin',{enumerable:true,get(){accessed=true;return input.senderPin;}})));assert.equal(accessed,false);
 assert.throws(()=>l.consumer.admin.enroll(new Proxy(input,{get(){throw Error('proxy trap');}})));assert.throws(()=>l.consumer.admin.enroll({...input,binding:{...input.binding,fingerprint:'f'.repeat(64)}}),code('forbidden'));
 l.consumer.admin.revoke(l.device,1);assert.throws(()=>l.consumer.admin.revoke(l.device,1),code('conflict'));assert.throws(()=>l.consumer.admin.enroll({...input,expectedRevision:2}),code('conflict'));
});
test('recipient rotation closed restart rejects stale pin then new custody pin reopens public revision and tombstones',async t=>{
 const l=lab(t),fresh=memoryCustody({...l.custody.pin,generation:2,keyId:'recipient_key_2'}),p=fresh.pin;
 assert.throws(()=>l.consumer.admin.rotateRecipient(p,2),code('conflict'));l.consumer.admin.rotateRecipient(p,1);assert.equal(l.consumer.admin.recipient().revision,2);
 await assert.rejects(l.consumer.wake());assert.equal(l.store.listTurns(l.thread.id).length,0);await l.consumer.close();assert.equal(l.custody.closes,1);
 assert.throws(()=>new RelayAssociations(l.host,l.bindings,join(l.data,'relay-host'),l.custody.pin),code('conflict'));
 const reopened=new RelayHost(l.host,l.bindings,l.data,validateRelayHostOptions({...l.options,recipient:p,custody:fresh.provider}));reopened.transferOwnership();assert.equal(reopened.admin.recipient().revision,2);assert.deepEqual(reopened.admin.recipient().pin,p);await reopened.close();assert.equal(fresh.closes,1);
 const db=new DatabaseSync(join(l.data,'relay-host','relay-associations.sqlite'));assert.equal(db.prepare('SELECT status FROM associations').get()!.status,'revoked');assert.equal(Number(db.prepare('SELECT count(*) AS n FROM history').get()!.n),2);db.close();
});
test('association private schema/path/sidecar and double-open guards preserve public history',async t=>{
 const l=lab(t);assert.throws(()=>new RelayAssociations(l.host,l.bindings,join(l.data,'relay-host'),l.custody.pin),code('host_locked'));
 const link=join(l.dir,'alias');symlinkSync(join(l.data,'relay-host'),link);assert.throws(()=>new RelayAssociations(l.host,l.bindings,link,l.custody.pin),code('forbidden'));
 await l.consumer.close();const dbpath=join(l.data,'relay-host','relay-associations.sqlite'),d=new DatabaseSync(dbpath);assert.equal(Number(d.prepare('SELECT count(*) AS n FROM history').get()!.n),1);d.exec('CREATE TABLE wrong_import(x TEXT)');d.close();assert.throws(()=>new RelayAssociations(l.host,l.bindings,join(l.data,'relay-host'),l.custody.pin),code('conflict'));
});
function serviceLab(t:TestContext,extra:Partial<RelayHostOptions>={}){
 const dir=root(t),data=join(dir,'host'),seed=new HostStore({dataDir:data}),identity={installationId:seed.hostId,ownerId:seed.ownerId,deviceId:'relay_host',generation:1,keyId:'host_key'};seed.close();
 const custody=memoryCustody(identity),tls=memoryTLS();let calls=0;
 const transport:RelayTransport={async poll(){return {deliveries:[],cursor:0};},async ack(){throw Error('unexpected ack');},async close(){}};
 const options:RelayHostOptions={recipient:custody.pin,custody:custody.provider,custodyMode:'laboratory-memory',transport,transportOwnership:'owned',deployment:{maximumPendingPerRecipient:131},...extra};
 const services=new HostServices({dataDir:data,enableEngines:true,appClients:{identity:tls},ownerControl:{socketPath:join(dir,'control','owner.sock')},relay:options,makeDriver(engine){return {id:engine,capabilities:{resume:true,interrupt:true,fork:false,steer:false},async status(){return {engine,installed:true,version:'synthetic',authentication:'authenticated',billing:'subscription'};},async open(threadId,cursor){return {threadId,nativeCursor:cursor??'lab'};},async *turn(session,turnId){calls++;yield {type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},async close(){},async interrupt(){},async respondToTool(){}};}});
 const beforeRemove:(()=>void)[]=[];let quarantine=false;t.after(async()=>{if(quarantine)return;await services.shutdown({graceMs:2000});for(const cleanup of beforeRemove)cleanup();rmSync(dir,{recursive:true,force:true});});return {dir,data,custody,tls,options,services,beforeRemove:(cleanup:()=>void)=>beforeRemove.push(cleanup),get calls(){return calls;},set quarantine(v:boolean){quarantine=v;}};
}
async function appCall(origin:string,host:ReturnType<typeof memoryTLS>,phone:ReturnType<typeof memoryTLS>,path:string,body:object){return new Promise<{status:number;json:Record<string,unknown>}>((done,reject)=>{const u=new URL(origin),data=JSON.stringify(body);const r=request({host:u.hostname,port:Number(u.port),servername:'localhost',path,method:'POST',ca:host.certPem,cert:phone.certPem,key:phone.keyPem,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',agent:false,headers:{'content-type':'application/json','content-length':Buffer.byteLength(data)}},res=>{let out='';res.on('data',b=>{out+=b;});res.on('end',()=>{try{done({status:res.statusCode!,json:JSON.parse(out) as Record<string,unknown>});}catch{reject(Error('invalid synthetic response'));}});});r.on('error',()=>reject(Error('synthetic TLS request failed')));r.end(data);});}
async function pairService(l:ReturnType<typeof serviceLab>){const origin=await l.services.startAppClients(),phone=memoryTLS(),bundle=l.services.appClientsAdmin.pairingBundle({kind:'pair',role:'client-ios',scopes:['chat.write']});const claim=await appCall(origin,l.tls,phone,'/app-client/v1/pair/claim',{offerId:bundle.offerId,code:bundle.code,name:'Memory laboratory iOS'});assert.equal(claim.status,200);return l.services.appClientsAdmin.approveClaim(String(claim.json.claimId)).deviceId;}
test('HostServices actual memory TLS pairing and narrow Unix public enrollment use one canonical registry, no grants',async t=>{
 const l=serviceLab(t),device=await pairService(l),socket=await l.services.startOwnerControl(),binding=l.services.relayAdmin.binding(device)!;
 assert.equal(binding.fingerprint.length,64);const sender=new RelayEndpoint({installationId:binding.installationId,ownerId:binding.ownerId,deviceId:device,generation:1,keyId:'sender_key'});
 const reply=await ownerControlRequest(socket,{op:'relay.enroll',args:{expectedRevision:null,expectedHostRevision:1,deviceId:device,bindingRevision:binding.revision,senderPin:sender.publicPin}});assert.equal(reply.kind,'response');if(reply.kind==='response'){assert.equal(reply.response.ok,true);if(reply.response.ok)assert.equal(reply.response.result.grantsCreated,0);}
 const revoked=await ownerControlRequest(socket,{op:'relay.revoke',args:{deviceId:device,expectedRevision:1}});assert.equal(revoked.kind,'response');assert.equal(l.services.store.summary().counts.grants,0);assert.equal(l.services.store.listBots().length,0);
 const borrowed=await l.services.quiesceForMaintenance({graceMs:2000});assert.equal(borrowed,l.services.store);assert.equal(borrowed.summary().hostId,binding.installationId);assert.throws(()=>new HostStore({dataDir:l.data}),code('host_locked'));await assert.rejects(l.services.wakeRelay());assert.throws(()=>l.services.appClientsAdmin);await l.services.shutdown();const reopened=new HostStore({dataDir:l.data});reopened.close();
});
test('pure relay preflight never opens store/provider; constructor rollback keeps caller custody/transport ownership',t=>{
 const dir=root(t),absent=join(dir,'absent'),tls=memoryTLS(),custody=memoryCustody({installationId:'wrong_host',ownerId:'wrong_owner',deviceId:'host',generation:1,keyId:'key'});let closes=0;
 const options:RelayHostOptions={recipient:custody.pin,custody:custody.provider,custodyMode:'laboratory-memory',transport:{async poll(){return {deliveries:[],cursor:0};},async ack(){return {receiptId:'none'};},async close(){closes++;}},transportOwnership:'owned',deployment:{maximumPendingPerRecipient:131}};
 assert.throws(()=>new HostServices({dataDir:absent,relay:options}));assert.equal(existsSync(absent),false);assert.throws(()=>validateRelayHostOptions({...options,custodyMode:'persistent'}));let trapped=false;assert.throws(()=>validateRelayHostOptions(new Proxy(options,{ownKeys(){trapped=true;return [];}})));assert.equal(trapped,false);
 assert.throws(()=>new HostServices({dataDir:absent,enableEngines:true,appClients:{identity:tls},relay:options}));assert.equal(closes,0);assert.equal(custody.closes,0);const reopened=new HostStore({dataDir:absent});reopened.close();rmSync(dir,{recursive:true,force:true});
});
test('held actual custody sign prevents physical drain/writer release; timed-out maintenance stays cached',async t=>{
 const l=serviceLab(t),g=gate();l.custody.setSignHold(g.promise);const wake=l.services.wakeRelay();void wake.catch(()=>{});await until(()=>l.custody.signStarted);
 const q=l.services.quiesceForMaintenance({graceMs:10});await assert.rejects(q);assert.throws(()=>new HostStore({dataDir:l.data}),code('host_locked'));assert.equal(l.custody.closes,0);assert.equal(l.services.quiesceForMaintenance(),q);
 g.resolve();await assert.rejects(wake);await l.services.shutdown({graceMs:2000});assert.equal(l.custody.closes,1);const reopened=new HostStore({dataDir:l.data});reopened.close();
});
test('provider close refusal is cached and quarantines writer while other admitted channels close',async t=>{
 const l=serviceLab(t);await l.services.startOwnerControl();l.custody.failClose();l.quarantine=true;await assert.rejects(l.services.shutdown({graceMs:2000}));await assert.rejects(l.services.shutdown({graceMs:2000}));assert.equal(l.custody.closes,1);assert.throws(()=>new HostStore({dataDir:l.data}),code('host_locked'));await assert.rejects(l.services.startAppClients());await assert.rejects(l.services.quiesceForMaintenance());
});
test('actual separated process pinned TLS relay reaches HostServices canonical runtime exactly once and drains owned child',async t=>{
 const l=serviceLab(t),device=await pairService(l),b=l.services.relayAdmin.binding(device)!,sender=new RelayEndpoint({installationId:b.installationId,ownerId:b.ownerId,deviceId:device,generation:1,keyId:'sender_key'});
 const child=fork(new URL('./fixtures/relay-host-child.js',import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc']});let childClosed=false;const exited=once(child,'exit').then(()=>{childClosed=true;});t.after(async()=>{if(!childClosed){child.kill('SIGTERM');await exited;}});
 const ready=once(child,'message');child.send({op:'start',dataDir:join(l.dir,'relay-process'),ownerId:b.ownerId,installationId:b.installationId,pins:[l.custody.pin,sender.publicPin],capacity:131});const [raw]=await ready;const info=raw as {ready:boolean;host:string;port:number;cert:string;pin:string};assert.equal(info.ready,true);
 const network=new PinnedRelayTransport({host:info.host,port:info.port,servername:'localhost',ca:info.cert,leafSha256:info.pin,timeoutMs:2000});t.after(()=>network.close());
 l.services.relayAdmin.enroll({expectedRevision:null,expectedHostRevision:1,binding:b,senderPin:sender.publicPin});
 const bot=l.services.store.createBot({name:'Process fixture',profileId:'personal',engine:'claude'}),thread=l.services.store.createThread(bot.id);
 await l.services.shutdown();let calls=0;
 const resumed=new HostServices({dataDir:l.data,enableEngines:true,appClients:{identity:l.tls},relay:{...l.options,custody:l.custody.freshProvider(),transport:{poll:network.poll.bind(network),ack:network.ack.bind(network),close:network.close.bind(network)}},makeDriver(engine){return {id:engine,capabilities:{resume:true,interrupt:true,fork:false,steer:false},async status(){return {engine,installed:true,version:'synthetic',authentication:'authenticated',billing:'subscription'};},async open(threadId,cursor){return {threadId,nativeCursor:cursor??'lab'};},async *turn(session,turnId){calls++;yield {type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},async close(){},async interrupt(){},async respondToTool(){}};}});t.after(()=>resumed.shutdown({graceMs:2000}));
 assert.deepEqual(resumed.relayAdmin.recipient().pin,l.custody.pin);assert.equal(resumed.relayAdmin.binding(device)!.fingerprint,b.fingerprint);
 const now=Date.now(),seal=(messageId:string,sequence:number,content='synthetic')=>sender.seal(l.custody.pin,{messageId,sequence,type:'command',createdAt:now,expiresAt:now+60000},Buffer.from(JSON.stringify({version:1,operation:'turn.submit',operationId:'network_op',threadId:thread.id,content})));
 await network.enqueue(seal('network_message',1));assert.equal((await resumed.wakeRelay()).accepted,1);await until(()=>calls===1);await network.enqueue(seal('network_replay',2));assert.equal((await resumed.wakeRelay()).replayed,1);await network.enqueue(seal('network_changed',3,'different'));assert.equal((await resumed.wakeRelay()).blocked,1);assert.equal(calls,1);assert.equal(resumed.store.listTurns(thread.id).length,1);assert.match(resumed.store.relaySourceHash(resumed.store.listTurns(thread.id)[0]!.id),/^[a-f0-9]{64}$/);
 await resumed.shutdown({graceMs:2000});await network.close();child.kill('SIGTERM');await exited;assert.equal(childClosed,true);
});
test('canonical revocation during real provider decrypt is revalidated before Hub persistence and ACK',async t=>{
 const l=lab(t),held=gate();l.custody.setDecryptHold(held.promise);l.relay.enqueue(l.envelope('await_revoke'));const waking=l.consumer.wake();await until(()=>l.custody.decryptStarted);l.registry.revokeDevice(l.device);held.resolve();const report=await waking;assert.equal(report.blocked,1);assert.equal(report.acked,0);assert.equal(l.store.listTurns(l.thread.id).length,0);assert.equal(l.calls,0);
});
test('ambiguous dispatch unknown never retries or starts a second engine; durable quarantine survives manual wake',async t=>{
 const l=lab(t);let attempts=0;l.runtime.startTurn=()=>{attempts++;throw Error('synthetic ambiguity before visible receipt');};l.relay.enqueue(l.envelope('unknown_operation'));assert.equal((await l.consumer.wake()).unknown,1);assert.equal((await l.consumer.wake()).unknown,1);assert.equal(attempts,1);assert.equal(l.calls,0);assert.equal(l.store.listTurns(l.thread.id).length,0);
});
test('owned poll close stops admission synchronously and waits real transport completion before borrowed maintenance store',async t=>{
 const held=gate(),released=gate();let pollStarted=false,closed=0;const transport:RelayTransport={async poll(){pollStarted=true;await held.promise;return {deliveries:[],cursor:0};},async ack(){throw Error('unexpected ack');},async close(){closed++;held.resolve();await released.promise;}};
 const l=serviceLab(t,{transport}),wake=l.services.wakeRelay();void wake.catch(()=>{});await until(()=>pollStarted);const q=l.services.quiesceForMaintenance({graceMs:10});await assert.rejects(q);assert.equal(closed,1);assert.throws(()=>l.services.relayAdmin);assert.throws(()=>new HostStore({dataDir:l.data}),code('host_locked'));released.resolve();await assert.rejects(wake);await l.services.shutdown({graceMs:2000});assert.equal(closed,1);
});
test('finite public history/pin bounds retain tombstones and reject another enrollment instead of evicting',async t=>{
 const l=lab(t,2);l.consumer.admin.revoke(l.device,1);l.rotate();assert.throws(()=>l.enroll(2),code('quota'));await l.consumer.close();const db=new DatabaseSync(join(l.data,'relay-host','relay-associations.sqlite'));assert.equal(db.prepare('SELECT status,revision FROM associations').get()!.status,'revoked');assert.equal(Number(db.prepare('SELECT count(*) AS n FROM history').get()!.n),2);db.close();
});
test('closed schema with internally mismatched imported public rows fails reopening; shared permissions refused',async t=>{
 const l=lab(t);await l.consumer.close();const file=join(l.data,'relay-host','relay-associations.sqlite'),db=new DatabaseSync(file);db.prepare("UPDATE associations SET revision=7").run();db.close();assert.throws(()=>new RelayAssociations(l.host,l.bindings,join(l.data,'relay-host'),l.custody.pin),code('conflict'));chmodSync(file,0o644);assert.throws(()=>new RelayAssociations(l.host,l.bindings,join(l.data,'relay-host'),l.custody.pin),code('forbidden'));chmodSync(file,0o600);
});
test('separate process cannot borrow canonical writer or double-open the exclusive public association database',async t=>{
 const l=lab(t),child=fork(new URL('./fixtures/relay-host-child.js',import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc']}),exit=once(child,'exit');t.after(async()=>{if(child.exitCode===null)child.kill('SIGTERM');await exit;});const message=once(child,'message');child.send({op:'probe',dataDir:l.data,associationFile:join(l.data,'relay-host','relay-associations.sqlite')});const [result]=await message;assert.deepEqual(result,{writerLocked:true,associationLocked:true});await exit;
});
test('actual held ACK after one accepted turn drains before HostServices writer release, with no second submission',async t=>{
 let relay:RelayStore|undefined,ackStarted=false;const held=gate();const transport:RelayTransport={async poll(r){return relay!.poll(r);},async ack(r){ackStarted=true;await held.promise;return relay!.ack(r);},async close(){}};
 const l=serviceLab(t,{transport}),device=await pairService(l),binding=l.services.relayAdmin.binding(device)!,sender=new RelayEndpoint({installationId:binding.installationId,ownerId:binding.ownerId,deviceId:device,generation:1,keyId:'sender_key'});relay=new RelayStore({dataDir:join(l.dir,'relay'),ownerId:binding.ownerId,installationId:binding.installationId,maximumPendingPerRecipient:131});relay.registerDevice(l.custody.pin);relay.registerDevice(sender.publicPin);l.beforeRemove(()=>relay!.close());l.services.relayAdmin.enroll({expectedRevision:null,expectedHostRevision:1,binding,senderPin:sender.publicPin});const bot=l.services.store.createBot({name:'ACK fixture',profileId:'personal',engine:'claude'}),thread=l.services.store.createThread(bot.id),now=Date.now();relay.enqueue(sender.seal(l.custody.pin,{messageId:'ack_message',sequence:1,type:'command',createdAt:now,expiresAt:now+60000},Buffer.from(JSON.stringify({version:1,operation:'turn.submit',operationId:'ack_operation',threadId:thread.id,content:'synthetic'}))));const wake=l.services.wakeRelay();void wake.catch(()=>{});await until(()=>ackStarted);await until(()=>l.calls===1);await assert.rejects(l.services.shutdown({graceMs:10}));assert.throws(()=>new HostStore({dataDir:l.data}),code('host_locked'));assert.equal(l.custody.closes,0);held.resolve();assert.equal((await wake).acked,0);await l.services.shutdown({graceMs:2000});assert.equal(l.calls,1);assert.equal(l.custody.closes,1);
});
test('writer lost during actual decrypt refuses persistence and ACK at the canonical boundary',async t=>{
 const l=lab(t),held=gate();l.custody.setDecryptHold(held.promise);l.relay.enqueue(l.envelope('writer_loss'));const wake=l.consumer.wake();void wake.catch(()=>{});await until(()=>l.custody.decryptStarted);const db=new DatabaseSync(l.store.databasePath),token=String(db.prepare('SELECT token FROM host_lease WHERE id=1').get()!.token);db.prepare('UPDATE host_lease SET token=? WHERE id=1').run('synthetic_lost_writer');held.resolve();await assert.rejects(wake);db.prepare('UPDATE host_lease SET token=? WHERE id=1').run(token);db.close();assert.equal(l.store.listTurns(l.thread.id).length,0);assert.equal(l.calls,0);
});
test('live canonical scope narrowing or role mismatch during decrypt invalidates remembered association',async t=>{
 for(const kind of ['scopes','role']){const l=lab(t),held=gate();l.custody.setDecryptHold(held.promise);l.relay.enqueue(l.envelope('live_'+kind));const wake=l.consumer.wake();await until(()=>l.custody.decryptStarted);const db=new DatabaseSync(l.registry.databasePath),row=db.prepare('SELECT scopes,role FROM client_bindings WHERE device_id=?').get(l.device)!;
 // Discriminant on private public metadata: current API keeps role/scopes fixed on rotation.
 db.prepare(kind==='scopes'?'UPDATE client_bindings SET scopes=? WHERE device_id=?':'UPDATE client_bindings SET role=? WHERE device_id=?').run(kind==='scopes'?'["chat.read"]':'client-mac',l.device);held.resolve();const report=await wake;assert.equal(report.blocked,1);assert.equal(report.acked,0);db.prepare('UPDATE client_bindings SET scopes=?,role=? WHERE device_id=?').run(String(row.scopes),String(row.role),l.device);db.close();assert.equal(l.store.listTurns(l.thread.id).length,0);assert.equal(l.calls,0);}
});
test('held actual custody close is physical drain, timeout keeps writer until close resolves once',async t=>{
 const l=serviceLab(t),held=gate();l.custody.setCloseHold(held.promise);await assert.rejects(l.services.shutdown({graceMs:10}));await until(()=>l.custody.closeStarted);assert.equal(l.custody.closes,1);assert.throws(()=>new HostStore({dataDir:l.data}),code('host_locked'));held.resolve();await l.services.shutdown({graceMs:2000});assert.equal(l.custody.closes,1);
});
test('ACK committed but answer lost, then composition restart plus new ciphertext replays durable receipt without kick',async t=>{
 const l=lab(t);await l.consumer.close();let lost=true;const transport:RelayTransport={poll:l.transport.poll.bind(l.transport),async ack(r){const result=await l.relay.ack(r);if(lost){lost=false;throw Error('synthetic lost ACK answer');}return result;},close:l.transport.close.bind(l.transport)};
 const first=new RelayHost(l.host,l.bindings,l.data,validateRelayHostOptions({...l.options,custody:l.custody.freshProvider(),transport}));first.transferOwnership();l.relay.enqueue(l.envelope('ack_lost'));assert.equal((await first.wake()).unknown,1);await until(()=>l.calls===1);await first.close();
 const restarted=new RelayHost(l.host,l.bindings,l.data,validateRelayHostOptions({...l.options,custody:l.custody.freshProvider(),transport}));restarted.transferOwnership();l.relay.enqueue(l.envelope('ack_lost'));const replay=await restarted.wake();assert.equal(replay.replayed,1);assert.equal(replay.acked,1);assert.equal(l.store.listTurns(l.thread.id).length,1);assert.equal(l.calls,1);await restarted.close();
});
