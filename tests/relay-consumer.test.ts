// Structural G6 lab: real RelayStore/crypto + canonical HostStore/Runtime with explicitly PRIVATE source-receipt stage.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { ConversationRuntime, HostStore, type RuntimeDriver } from "@dexter/hub";
import { RelayEndpoint, RelayStore, type DevicePin, type Envelope } from "@dexter/relay";
import { ConsumerError, RelayConsumer, DENY_RELAY_AUTHORITY, type CurrentRelayAuthority, type HostPort, type RelayPrincipal, type RelayTransport } from "../packages/relay-consumer/src/index.js";
import { crashFixtureURL } from "./fixtures/relay-consumer-crash.js";
import { tlsHostComposition } from './fixtures/relay-consumer-tls-round2.js';
import { canonicalHost } from "./fixtures/relay-consumer-host.js";
const code=(c:string)=>(e:unknown)=>e instanceof ConsumerError&&e.code===c;
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
async function until(check:()=>boolean){const end=Date.now()+10000;while(!check()){assert.ok(Date.now()<end,'owned barrier');await new Promise(r=>setTimeout(r,5));}}
function tlsSidecars(root:string):string[]{
  const found:string[]=[];
  const walk=(directory:string,relative="")=>{for(const entry of readdirSync(directory,{withFileTypes:true})){const path=join(directory,entry.name),name=relative?`${relative}/${entry.name}`:entry.name;if(entry.isDirectory())walk(path,name);else if(/\.(?:pem|key|csr|ext|p12|pfx|x963)$/i.test(entry.name))found.push(name);}};
  walk(root);return found.sort();
}
function assertNoTlsSidecars(root:string):void{assert.deepEqual(tlsSidecars(root),[],"real TLS identity remains in memory without PEM/key/CSR/extension sidecars");}
function lab(t:TestContext,options:{maximum?:number;noDriver?:boolean;clock?:()=>number}={}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-relay-consumer-')));chmodSync(root,0o700);const data=join(root,'host');const store=new HostStore({dataDir:data});
  const bot=store.createBot({name:'Synthetic',profileId:'fixture',engine:'claude'}),thread=store.createThread(bot.id);
  const enrollment=store.registerClientDeviceForClaim({namespace:'app-client-v1',claimId:'approved_fixture',name:'Synthetic Client',fingerprint:'a'.repeat(64),role:'client-ios',scopes:['chat.write']});
  let calls=0;const driver:RuntimeDriver={id:'claude',sessionReuse:'turn',async open(threadId){return {threadId,nativeCursor:'synthetic'};},async *turn(session,turnId){calls++;yield {type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},async close(){},async respondToTool(){},async interrupt(){}};
  const runtime=new ConversationRuntime({store,drivers:options.noDriver?[]:[driver]});const host=canonicalHost(store,runtime);
  const relay=new RelayStore({dataDir:join(root,'relay'),ownerId:store.ownerId,installationId:store.hostId,...(options.clock?{clock:options.clock}:{})});
  let sender=new RelayEndpoint({ownerId:store.ownerId,installationId:store.hostId,deviceId:'relay_client',generation:1,keyId:'client_key_1'});
  const receiver=new RelayEndpoint({ownerId:store.ownerId,installationId:store.hostId,deviceId:'relay_host',generation:1,keyId:'host_key_1'});relay.registerDevice(sender.publicPin);relay.registerDevice(receiver.publicPin);
  let current=true,scopes=['chat.write'],revision=1,sequence=0,ackCalls=0;const consumers:RelayConsumer[]=[];const cleanup:Array<()=>void|Promise<void>>=[];
  let transport:RelayTransport={async poll(request){return relay.poll(request);},async ack(request){ackCalls++;return relay.ack(request);},async close(){}};
  const principal=():RelayPrincipal=>({hostId:store.hostId,ownerId:store.ownerId,canonicalDeviceId:enrollment.deviceId,tlsFingerprint:enrollment.fingerprint,role:enrollment.role,scopes:[...scopes],pinGeneration:revision,bindingRevision:revision,senderPin:sender.publicPin,recipientPin:receiver.publicPin});
  const authority:CurrentRelayAuthority={candidate(e){const active=store.findClientDeviceEnrollment({namespace:'app-client-v1',claimId:'approved_fixture'});return active&&e.senderId===sender.publicPin.deviceId&&e.senderGeneration===sender.publicPin.generation&&e.senderKeyId===sender.publicPin.keyId?principal():null;},isCurrent(p){const active=store.findClientDeviceEnrollment({namespace:'app-client-v1',claimId:'approved_fixture'});return current&&active?.deviceId===p.canonicalDeviceId&&store.getDevice(p.canonicalDeviceId).revokedAt===null&&p.pinGeneration===revision&&p.bindingRevision===revision&&JSON.stringify(p.scopes)===JSON.stringify(scopes)&&p.senderPin.keyId===sender.publicPin.keyId;}};
  const make=(override:Partial<HostPort>={},owned=false)=>{const c=new RelayConsumer({host:{...host,...override},directory:data,transport,opener:receiver,authority,transportOwnership:owned?'owned':'borrowed',...(options.maximum?{maximumOperations:options.maximum}:{}),...(options.clock?{clock:options.clock}:{})});consumers.push(c);return c;};
  const send=(operationId='operation_1',content='synthetic input',extra:Record<string,unknown>={},messageId='message_'+(sequence+1),kind:Envelope['type']='command')=>{const now=Date.now();const plain=kind==='command'?{version:1,operation:'turn.submit',operationId,threadId:thread.id,content,...extra}:{version:1,operation:'notice.received',operationId,noticeId:'notice_fixture',...extra};const envelope=sender.seal(receiver.publicPin,{messageId,sequence:++sequence,type:kind,createdAt:now,expiresAt:now+60000},Buffer.from(JSON.stringify(plain)));return relay.enqueue(envelope);};
  t.after(async()=>{for(const fn of cleanup.reverse())await fn();for(const c of consumers.reverse())await c.close().catch(()=>undefined);await runtime.shutdown({closeStore:false});relay.close();store.close();rmSync(root,{recursive:true,force:true});});
  return {cleanup: (fn:()=>void|Promise<void>)=>cleanup.push(fn),driver,track:(c:RelayConsumer)=>consumers.push(c),root,data,store,host,runtime,relay,receiver,thread,bot,enrollment,authority,principal,make,send,get calls(){return calls;},get ackCalls(){return ackCalls;},setTransport(value:RelayTransport){transport=value;},getTransport(){return transport;},revoke(){current=false;store.revokeDevice(enrollment.deviceId);},scopeLoss(){scopes=[];revision++;},rotate(){sender=new RelayEndpoint({ownerId:store.ownerId,installationId:store.hostId,deviceId:'relay_client',generation:sender.publicPin.generation+1,keyId:'client_key_'+(sender.publicPin.generation+1)});relay.registerDevice(sender.publicPin);revision++;sequence=0;},senderPin:():DevicePin=>sender.publicPin};
}
test('manual singleflight durable acceptance and repeated logical operation across envelopes causes one engine execution',async t=>{
  const l=lab(t),c=l.make();assert.equal(l.calls,0);l.send();const first=c.wake();assert.equal(c.wake(),first);const report=await first;assert.equal(report.accepted,1);assert.equal(report.acked,1);await until(()=>l.calls===1);const turn=l.store.listTurns(l.thread.id)[0]!;await l.runtime.waitForTurn(turn.id);
  l.send();const replay=await c.wake();assert.equal(replay.replayed,1);assert.equal(replay.acked,1);assert.equal(l.store.listTurns(l.thread.id).length,1);assert.equal(l.calls,1);await c.close();assert.equal(c.close(),c.close());assert.ok(l.store.getThread(l.thread.id));
});
test('journal survives consumer restart and current relay generation does not reset logical dedup',async t=>{
  const l=lab(t);let c=l.make();l.send();await c.wake();await l.runtime.waitForTurn(l.store.listTurns(l.thread.id)[0]!.id);await c.close();l.rotate();c=l.make();l.send('operation_1','synthetic input',{},'recycled_message');const report=await c.wake();assert.equal(report.replayed,1);assert.equal(l.calls,1);assert.equal(l.store.listTurns(l.thread.id).length,1);
});
test('changed content, foreign thread, principal body fields and forbidden operation schema never ACK or replace canonical turn',async t=>{
  const l=lab(t),c=l.make();l.send();await c.wake();l.send('operation_1','changed');assert.equal((await c.wake()).blocked,1);assert.equal(l.ackCalls,1);assert.equal(l.store.listTurns(l.thread.id).length,1);
  l.send('op_foreign','x',{threadId:'thread_foreign'});l.send('op_principal','x',{deviceId:'dev_attacker'});l.send('op_tool','x',{operation:'action.dispatch'});const report=await c.wake();assert.equal(report.blocked,4);assert.equal(l.ackCalls,1);assert.equal(l.store.listTurns(l.thread.id).length,1);
});
test('inert event receipt accepts durable notice without any runtime or engine execution',async t=>{
  const l=lab(t),c=l.make();l.send('notice_op','unused',{},'notice_message','event');const report=await c.wake();assert.equal(report.inert,1);assert.equal(report.acked,1);assert.equal(l.store.listTurns(l.thread.id).length,0);assert.equal(l.calls,0);
});
test('commit then lost acceptance response recovers exact canonical source and never kicks twice',async t=>{
  const l=lab(t);let lost=true;const c=l.make({startTurn(id,input,hash){const turn=l.host.startTurn(id,input,hash);if(lost){lost=false;throw Error('fixture lost return');}return turn;}});l.send();const first=await c.wake();assert.equal(first.unknown,1);assert.equal(l.ackCalls,0);await l.runtime.waitForTurn(l.store.listTurns(l.thread.id)[0]!.id);assert.equal((await c.wake()).replayed,1);assert.equal(l.calls,1);assert.equal(l.ackCalls,1);
});
test('ACK unavailable before remote commit uses exact retained signed request on explicit retry within its window',async t=>{
  const l=lab(t),base=l.getTransport();let lost=true;const signed:string[]=[];l.setTransport({...base,async ack(request){signed.push(JSON.stringify(request));if(lost){lost=false;throw Error('fixture response lost before ACK');}return base.ack(request);}});const c=l.make();l.send();assert.equal((await c.wake()).unknown,1);assert.equal((await c.wake()).replayed,1);assert.equal(l.store.listTurns(l.thread.id).length,1);await until(()=>l.calls===1);assert.equal(signed[0],signed[1],'same signed ACK is reused within its control window');
});
test('scope loss after decrypt or revoke before ACK preserves pending and never publishes receipt',async t=>{
  const l=lab(t);const base=l.getTransport();let lose=true;const opener=l.receiver;const c=new RelayConsumer({host:l.host,directory:l.data,transport:base,authority:l.authority,opener:{publicPin:opener.publicPin,poll:r=>opener.poll(r),ack:r=>opener.ack(r),open(e,p){const bytes=opener.open(e,p);if(lose){lose=false;l.scopeLoss();}return bytes;}}});l.track(c);l.send();assert.equal((await c.wake()).blocked,1);assert.equal(l.store.listTurns(l.thread.id).length,0);assert.equal(l.ackCalls,0);
});
test('actual canonical writer stolen after acceptance prevents journal commit and ACK',async t=>{
  const l=lab(t);const raw=new DatabaseSync(l.store.databasePath);const token=String(raw.prepare("SELECT token FROM host_lease WHERE id=1").get()!.token);l.cleanup(()=>{raw.prepare("UPDATE host_lease SET token=? WHERE id=1").run(token);raw.close();});const c=l.make({startTurn(id,input,hash){const accepted=l.host.startTurn(id,input,hash);raw.exec("UPDATE host_lease SET token='fixture_stolen' WHERE id=1");return accepted;}});l.send();await assert.rejects(c.wake(),e=>typeof e==='object'&&e!==null&&'code' in e&&e.code==='host_locked');assert.equal(l.ackCalls,0);assert.equal(c.status().closed,false);await assert.rejects(c.close());assert.equal(c.status().closed,false);
});
test('close stops admissions synchronously and waits held opener/ACK; borrowed Host and transport stay owned by caller',async t=>{
  const l=lab(t),base=l.getTransport(),held=gate();let started=false,closes=0;l.setTransport({...base,async ack(request){started=true;await held.promise;return base.ack(request);},async close(){closes++;}});const c=l.make();l.send();const waking=c.wake();await until(()=>started);let done=false;const closing=c.close().then(()=>done=true);await assert.rejects(c.wake(),code('unavailable'));assert.equal(c.close(),c.close());await new Promise(r=>setTimeout(r,10));assert.equal(done,false);assert.throws(()=>new HostStore({dataDir:l.data}));held.resolve();await Promise.all([waking,closing]);assert.equal(closes,0);assert.equal(l.runtime.status().state,'running');assert.ok(l.store.getThread(l.thread.id));
});
test('owned transport close rejection quarantines auxiliary journal and caches one close call',async t=>{
  const l=lab(t),base=l.getTransport();let closes=0;l.setTransport({...base,async close(){closes++;throw Error('fixture refusal');}});const c=l.make({},true);const first=c.close();assert.equal(c.close(),first);await assert.rejects(first);assert.equal(c.status().closed,false);assert.equal(closes,1);assert.throws(()=>new HostStore({dataDir:l.data}));
});
test('quota, schema extra object, host metadata and symlink fail closed without automatic dedup eviction',async t=>{
  const l=lab(t,{maximum:1}),c=l.make();l.send();await c.wake();l.send('operation_2');assert.equal((await c.wake()).blocked,1);assert.equal(l.ackCalls,1);await c.close();const path=join(l.data,'relay-consumer.sqlite'),db=new DatabaseSync(path);db.exec('CREATE TABLE imported_extra(x TEXT)');db.close();assert.throws(()=>l.make(),code('conflict'));
  const other=join(l.root,'symlinked');symlinkSync(l.data,other);assert.throws(()=>new RelayConsumer({host:l.host,directory:other,transport:l.getTransport(),opener:l.receiver,authority:l.authority}),code('forbidden'));
  assert.ok(existsSync(path));assert.ok(readFileSync(path).length>0);
});
test('unknown without canonical receipt is permanently held and no replacement ID or automatic resume is invented',async t=>{
  const l=lab(t);let attempts=0;const c=l.make({startTurn(){attempts++;throw Error('fixture ambiguous before acceptance');}});l.send();assert.equal((await c.wake()).unknown,1);assert.equal((await c.wake()).unknown,1);assert.equal(attempts,1);assert.equal(l.store.listTurns(l.thread.id).length,0);assert.equal(l.ackCalls,0);
});
test('same request ID preoccupied by a turn without relay source receipt conflicts before ACK',async t=>{
  const l=lab(t);const c=l.make();l.send();const crypto=await import('node:crypto');const id='rly_'+crypto.createHash('sha256').update(JSON.stringify([l.store.hostId,l.enrollment.deviceId,'operation_1'])).digest('hex');l.store.createTurn(l.thread.id,{clientRequestId:id,content:'synthetic input'});assert.equal((await c.wake()).blocked,1);assert.equal(l.ackCalls,0);assert.equal(l.store.listTurns(l.thread.id).length,1);assert.equal(l.calls,0);
});
test('unused dispose closes only auxiliary; used dispose refused and stopped wake never launches deferred work',async t=>{
  const l=lab(t),c=l.make();c.disposeUnstarted();assert.equal(c.status().closed,true);c.disposeUnstarted();assert.ok(l.store.getThread(l.thread.id));const another=l.make();const waking=another.wake();another.stopAdmission();await assert.rejects(waking);assert.throws(()=>another.disposeUnstarted(),code('conflict'));await another.close();assert.equal(l.calls,0);
});

test('private canonical source seam keeps ordinary API and rejects user metadata, missing argument, malformed and duplicate receipts',async t=>{
  const l=lab(t);const ordinary=l.runtime.startTurn(l.thread.id,{clientRequestId:'ordinary_1',content:'ordinary'});assert.equal(l.runtime.startTurn(l.thread.id,{clientRequestId:'ordinary_1',content:'ordinary'}).turn.id,ordinary.turn.id);
  assert.throws(()=>l.runtime.startTurn(l.thread.id,{clientRequestId:'ordinary_bad',content:'x',sourceHash:'a'.repeat(64)}));
  const staged=l.runtime as ConversationRuntime&{startTurn(threadId:string,input:unknown,hash?:string):{turn:{id:string}}};const store=l.store as HostStore&{relaySourceHash(id:string):string};
  const bound=staged.startTurn(l.thread.id,{clientRequestId:'bound_source',content:'bound'},'b'.repeat(64));assert.equal(store.relaySourceHash(bound.turn.id),'b'.repeat(64));assert.throws(()=>l.runtime.startTurn(l.thread.id,{clientRequestId:'bound_source',content:'bound'}));assert.throws(()=>staged.startTurn(l.thread.id,{clientRequestId:'bound_source',content:'bound'},'c'.repeat(64)));assert.throws(()=>staged.startTurn(l.thread.id,{clientRequestId:'bad_source',content:'bad'},'B'.repeat(64)));assert.throws(()=>store.relaySourceHash(ordinary.turn.id));assert.throws(()=>staged.startTurn(l.thread.id,{clientRequestId:'coerced_source',content:'bad'},{toString:()=> 'd'.repeat(64)} as unknown as string));
  const raw=new DatabaseSync(l.store.databasePath);raw.prepare("UPDATE turn_events SET data=? WHERE turn_id=? AND kind='turn.queued'").run(JSON.stringify({source:'relay-consumer-v1',hash:'b'.repeat(64),extra:true}),bound.turn.id);assert.throws(()=>store.relaySourceHash(bound.turn.id));raw.prepare("UPDATE turn_events SET data=? WHERE turn_id=? AND kind='turn.queued'").run(JSON.stringify({source:'relay-consumer-v1',hash:'b'.repeat(64)}),bound.turn.id);raw.prepare("INSERT INTO turn_events(turn_id,thread_id,kind,text,data,created_at) SELECT turn_id,thread_id,kind,text,data,created_at FROM turn_events WHERE turn_id=? AND kind='turn.queued'").run(bound.turn.id);assert.throws(()=>store.relaySourceHash(bound.turn.id));raw.close();
});

test('absent canonical engine leaves relay pending with no acceptance or ACK',async t=>{
  const l=lab(t,{noDriver:true}),c=l.make();l.send();assert.equal((await c.wake()).blocked,1);assert.equal(l.store.listTurns(l.thread.id).length,0);assert.equal(l.ackCalls,0);
});
test('busy acceptance stays blocked and only an explicit later wake can accept the exact same operation',async t=>{
  const l=lab(t);let busy=true;let calls=0;const c=l.make({startTurn(id,input,hash){calls++;if(busy)throw new ConsumerError('conflict');return l.host.startTurn(id,input,hash);}});l.send();assert.equal((await c.wake()).blocked,1);assert.equal(l.ackCalls,0);assert.equal(l.store.listTurns(l.thread.id).length,0);busy=false;assert.equal((await c.wake()).accepted,1);assert.equal(calls,2);assert.equal(l.store.listTurns(l.thread.id).length,1);
});

test('separate process SIGKILL at prepared/Host/journal/ACK boundaries preserves one logical turn and never reruns unknown',async t=>{
  for(const point of ['before-host','after-host','after-journal','after-ack'])await t.test(point,async sub=>{
    const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-relay-consumer-crash-')));chmodSync(root,0o700);const directory=join(root,'host');const admin=new HostStore({dataDir:directory});const hostId=admin.hostId,ownerId=admin.ownerId;const bot=admin.createBot({name:'Crash Fixture',profileId:'lab',engine:'claude'}),thread=admin.createThread(bot.id);admin.registerClientDeviceForClaim({namespace:'app-client-v1',claimId:'crash_enrollment',name:'Lab',fingerprint:'d'.repeat(64),role:'client-ios',scopes:['chat.write']});admin.close();
    const relay=new RelayStore({dataDir:join(root,'relay'),ownerId,installationId:hostId}),sender=new RelayEndpoint({ownerId,installationId:hostId,deviceId:'crash_client',generation:1,keyId:'crash_client_key'});relay.registerDevice(sender.publicPin);
    const children=new Set<ReturnType<typeof spawn>>();sub.after(async()=>{for(const child of children)child.kill('SIGKILL');await Promise.all([...children].map(child=>new Promise<void>(resolve=>child.once('close',()=>resolve()))));relay.close();rmSync(root,{recursive:true,force:true});});
    const child=async(generation:number,failpoint:string)=>{
      const processChild=spawn(process.execPath,[fileURLToPath(crashFixtureURL),'laboratory-relay-consumer-crash'],{env:{},stdio:['pipe','pipe','pipe','ipc']});children.add(processChild);const events:Array<Record<string,unknown>>=[];let bytes='';let stderr=0;processChild.stderr!.on('data',(b:Buffer)=>{stderr+=b.length;assert.ok(stderr<=16384);});processChild.stdout!.on('data',(b:Buffer)=>{bytes+=b.toString('utf8');assert.ok(bytes.length<=100000);let index;while((index=bytes.indexOf('\n'))>=0){events.push(JSON.parse(bytes.slice(0,index)) as Record<string,unknown>);bytes=bytes.slice(index+1);}});
      processChild.on('message',message=>{const req=message as {kind:string;id:number;request:Parameters<RelayTransport['poll']>[0]&Parameters<RelayTransport['ack']>[0]};if(req.kind==='poll')processChild.send?.({kind:'reply',id:req.id,value:relay.poll(req.request)});else if(req.kind==='ack')processChild.send?.({kind:'reply',id:req.id,value:relay.ack(req.request)});});processChild.once('close',()=>children.delete(processChild));
      const closed=new Promise<void>(resolve=>processChild.once('close',()=>resolve()));processChild.send?.({directory,generation,senderPin:sender.publicPin,threadId:thread.id,point:failpoint,enrollmentId:'crash_enrollment'});await until(()=>events.some(e=>e.kind==='ready'));const pin=events.find(e=>e.kind==='ready')!.pin as unknown as DevicePin;relay.registerDevice(pin);
      const now=Date.now();relay.enqueue(sender.seal(pin,{messageId:'boundary_message_'+generation,sequence:1,type:'command',createdAt:now,expiresAt:now+60000},Buffer.from(JSON.stringify({version:1,operation:'turn.submit',operationId:'crash_operation',threadId:thread.id,content:'synthetic crash input'}))));processChild.send?.({kind:'wake'});return {processChild,events,closed};
    };
    const first=await child(1,point);await until(()=>first.events.some(e=>e.kind==='boundary'));first.processChild.kill('SIGKILL');await first.closed;
    const second=await child(2,'none');await until(()=>second.events.some(e=>e.kind==='completed'));second.processChild.send?.({kind:'close'});await second.closed;
    const check=new HostStore({dataDir:directory});const turns=check.listTurns(thread.id);assert.equal(turns.length,1,'logical operation survives new relay message/recipient generation');assert.equal(check.turnInput(turns[0]!.id),'synthetic crash input');
    const log=join(directory,'fixture-engine-turns.log');const executions=existsSync(log)?readFileSync(log,'utf8').trim().split('\n').length:0;assert.equal(executions,point==='after-host'?0:1,'unknown after Host commit remains held; every other boundary executes only once');if(point==='after-host')assert.equal(turns[0]!.state,'unknown');check.close();
  });
});

test('logical conflict remains a conflict after rotation while previous operation is only prepared/blocked',async t=>{
  const l=lab(t);let busy=true;const c=l.make({startTurn(id,input,hash){if(busy)throw new ConsumerError('conflict');return l.host.startTurn(id,input,hash);}});l.send();assert.equal((await c.wake()).blocked,1);busy=false;l.rotate();l.send('operation_1','different logical input',{},'rotated_conflict_message');assert.equal((await c.wake()).blocked,1);assert.equal(l.store.listTurns(l.thread.id).length,0);assert.equal(l.ackCalls,0);
});
test('canonical revocation during asynchronous ACK signing prevents ACK after durable Host acceptance',async t=>{
  const l=lab(t),endpoint=l.receiver;const c=new RelayConsumer({host:l.host,directory:l.data,transport:l.getTransport(),authority:l.authority,opener:{publicPin:endpoint.publicPin,open:(e,p)=>endpoint.open(e,p),poll:r=>endpoint.poll(r),async ack(r){const ack=endpoint.ack(r);l.revoke();return ack;}}});l.track(c);l.send();assert.equal((await c.wake()).blocked,1);assert.equal(l.store.listTurns(l.thread.id).length,1);assert.equal(l.ackCalls,0);
});
test('recovered canonical queued turn is accepted as same receipt and remains held without resume or engine kick',async t=>{
  const l=lab(t);const crypto=await import('node:crypto');const hash=(v:unknown)=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');const operationId='queued_operation',content='queued synthetic input',requestId='rly_'+hash([l.store.hostId,l.enrollment.deviceId,operationId]);
  const source=hash([l.store.hostId,l.store.ownerId,l.enrollment.deviceId,1,'turn.submit',operationId,l.thread.id,content]);const staged=l.store as HostStore&{createTurn(threadId:string,input:unknown,sourceHash:string):{turn:{id:string}}};const canonical=staged.createTurn(l.thread.id,{clientRequestId:requestId,content},source);await l.runtime.shutdown({closeStore:false});const runtime=new ConversationRuntime({store:l.store,drivers:[l.driver]});l.cleanup(()=>runtime.shutdown({closeStore:false}));
  const c=new RelayConsumer({host:canonicalHost(l.store,runtime),directory:l.data,transport:l.getTransport(),authority:l.authority,opener:l.receiver});l.track(c);l.send(operationId,content);const report=await c.wake();assert.equal(report.accepted,0);assert.equal(report.replayed,1);assert.equal(report.acked,1);assert.equal(runtime.status().heldQueuedTurns,1);assert.equal(l.store.getTurn(canonical.turn.id).state,'queued');assert.equal(l.calls,0);
});

test('actual remote ACK commit followed by response loss never repeats Host mutation or infers engine completion',async t=>{
  const l=lab(t),base=l.getTransport();let lost=true;l.setTransport({...base,async ack(request){const out=await base.ack(request);if(lost){lost=false;throw Error('fixture response lost after remote ACK');}return out;}});const c=l.make();l.send();assert.equal((await c.wake()).unknown,1);assert.equal(l.ackCalls,1);assert.equal((await c.wake()).delivered,0);assert.equal(l.store.listTurns(l.thread.id).length,1);l.send();assert.equal((await c.wake()).replayed,1);assert.equal(l.store.listTurns(l.thread.id).length,1);await until(()=>l.calls===1);
});
test('explicit ACK retry beyond signed window changes only nonce/time and preserves exact delivery pairs',async t=>{
  let now=Date.now();const l=lab(t,{clock:()=>now}),base=l.getTransport();const requests:Array<Parameters<RelayTransport['ack']>[0]>=[];let fail=true;l.setTransport({...base,async ack(request){requests.push(request);if(fail){fail=false;throw Error('fixture uncommitted ACK');}return base.ack(request);}});const c=l.make();l.send();assert.equal((await c.wake()).unknown,1);now+=30001;assert.equal((await c.wake()).acked,1);assert.notEqual(requests[0]!.requestId,requests[1]!.requestId);assert.equal(requests[1]!.issuedAt,now);assert.deepEqual(requests[0]!.messages,requests[1]!.messages);assert.equal(l.store.listTurns(l.thread.id).length,1);
});


test('absolute dispatch deadline stops admissions but retains actual stalled flight and canonical writer until drain',async t=>{
  const l=lab(t),base=l.getTransport(),held=gate();let polls=0;l.setTransport({...base,async poll(request){polls++;await held.promise;return base.poll(request);}});
  const c=new RelayConsumer({host:l.host,directory:l.data,transport:l.getTransport(),authority:l.authority,opener:l.receiver,dispatchMs:40});l.track(c);const waking=c.wake();await assert.rejects(waking,code('unavailable'));assert.equal(polls,1);assert.equal(c.status().admission,'stopped');assert.equal(c.status().inFlight,1);assert.throws(()=>new HostStore({dataDir:l.data}));
  let closed=false;const closing=c.close().then(()=>closed=true);await new Promise(r=>setTimeout(r,10));assert.equal(closed,false);await assert.rejects(c.wake(),code('unavailable'));assert.equal(polls,1);held.resolve();await closing;assert.equal(c.status().closed,true);assert.equal(l.calls,0);
});
test('second consumer under same canonical Host cannot open the auxiliary writer and releases only after actual close',async t=>{
  const l=lab(t),c=l.make();assert.throws(()=>l.make(),code('host_locked'));await c.close();const replacement=l.make();await replacement.close();
});

test("actual pinned TLS relay to consumer to current HostServices canonical runtime uses one synthetic engine effect and denies revoked replay",t=>tlsHostComposition(t,(root,stage)=>{if(stage==="certificates"||stage==="host"||stage==="service")assertNoTlsSidecars(root);}));

test('default-deny authority placeholder cannot decrypt accept or ACK a valid queued envelope',async t=>{
  const l=lab(t);const c=new RelayConsumer({host:l.host,directory:l.data,transport:l.getTransport(),opener:l.receiver,authority:DENY_RELAY_AUTHORITY});l.track(c);l.send();const out=await c.wake();assert.equal(out.blocked,1);assert.equal(out.accepted,0);assert.equal(out.acked,0);assert.equal(l.store.listTurns(l.thread.id).length,0);assert.equal(l.calls,0);
});

test('separate process cannot admit a second SQLite journal connection while exclusive canonical-fenced handle is retained',async t=>{
  const l=lab(t),c=l.make();const path=join(l.data,'relay-consumer.sqlite');const probe=spawnSync(process.execPath,['--input-type=module','-e',`import { DatabaseSync } from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=5');try {db.prepare('SELECT * FROM metadata').all();process.exitCode=2;}catch(e){process.exitCode=e.code==='ERR_SQLITE_ERROR'&&e.errcode===5?0:3;}finally{db.close();}`,path],{env:{},encoding:'utf8',timeout:10000});assert.equal(probe.status,0,'a distinct process must fail journal admission with SQLITE_BUSY, not an incidental error');await c.close();
  const after=spawnSync(process.execPath,['--input-type=module','-e',`import { DatabaseSync } from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);if(db.prepare('SELECT * FROM metadata').all().length!==1)process.exitCode=2;db.close();`,path],{env:{},encoding:'utf8',timeout:10000});assert.equal(after.status,0,'actual close releases journal exclusive lock');
});

test('M1 fairness: denied head does not starve valid queued delivery and denied input is never ACKed',async t=>{
  const l=lab(t),c=l.make();for(let i=0;i<10;i++)l.send('denied_'+i,'invalid',{engine:'forbidden'});l.send('tail');
  assert.equal((await c.wake()).blocked,10);const second=await c.wake();assert.equal(second.accepted,1);assert.equal(second.acked,1);assert.equal(l.ackCalls,1);assert.equal(l.relay.status().pending,10);await until(()=>l.calls===1);
  for(let i=0;i<3;i++)await c.wake();assert.equal(l.calls,1);assert.equal(l.ackCalls,1);
});
test('M1 fairness: maximum backlog, fresh arrivals and restart retain bounded traversal',async t=>{
  const l=lab(t);let c=l.make();for(let i=0;i<127;i++)l.send('invalid_'+i,'invalid',{engine:'forbidden'});l.send('last_valid');
  for(let i=0;i<12;i++){const r=await c.wake();assert.equal(r.blocked,10);assert.equal(r.acked,0);}
  assert.equal((await c.wake()).accepted,1);await until(()=>l.calls===1);assert.equal(l.relay.status().pending,127);
  l.send('new_valid');for(let i=0;i<12;i++)assert.equal((await c.wake()).acked,0);assert.equal((await c.wake()).accepted,1);await until(()=>l.calls===2);
  await c.close();c=l.make();l.send('after_restart');for(let i=0;i<12;i++)assert.equal((await c.wake()).acked,0);assert.equal((await c.wake()).accepted,1);await until(()=>l.calls===3);assert.equal(l.ackCalls,3);
});
test('M1 fairness: earlier temporarily denied authority is revisited after tail traversal and rotation',async t=>{
  const l=lab(t),base=l.authority;let permit=false;const c=new RelayConsumer({host:l.host,directory:l.data,transport:l.getTransport(),opener:l.receiver,authority:{candidate:e=>base.candidate(e),isCurrent:p=>permit&&base.isCurrent(p)}});l.track(c);
  for(let i=0;i<10;i++)l.send('recover_'+i,'same');l.send('tail_invalid','invalid',{engine:'forbidden'});
  assert.equal((await c.wake()).blocked,10);assert.equal((await c.wake()).blocked,1);permit=true;
  // Avoid canonical busy interference: notices demonstrate every recoverable slot being revisited.
  const r=await c.wake();assert.ok(r.accepted>=1);assert.equal(l.store.listTurns(l.thread.id).length,r.accepted);assert.equal(l.ackCalls,r.acked);
  await until(()=>l.calls>=1);await l.runtime.waitForTurn(l.store.listTurns(l.thread.id)[0]!.id);
  l.rotate();l.send('recover_0','same',{},'rotated_replay');let replayed=0;for(let i=0;i<4;i++)replayed+=(await c.wake()).replayed;assert.ok(replayed>=1);assert.equal(l.store.listTurns(l.thread.id).filter(x=>x.clientRequestId===l.store.listTurns(l.thread.id)[0]!.clientRequestId).length,1);
});
test('M1 fairness: unknown journal at head stays held while later valid delivery executes once',async t=>{
  const l=lab(t);let fail=true;const c=l.make({startTurn(...args){if(fail)throw new Error('ambiguous before host');return l.host.startTurn(...args);}});
  for(let i=0;i<10;i++)l.send('unknown_'+i);assert.equal((await c.wake()).unknown,10);fail=false;l.send('later');assert.equal((await c.wake()).accepted,1);await until(()=>l.calls===1);
  assert.equal((await c.wake()).unknown,10);assert.equal(l.store.listTurns(l.thread.id).length,1);assert.equal(l.ackCalls,1);
});
test('M1 page ordering and cursor mismatch fail closed without consuming or skipping the head',async t=>{
  for(const mode of ['reverse','same','mismatch'])await t.test(mode,async sub=>{
    const l=lab(sub),base=l.getTransport();let corrupt=true;l.setTransport({...base,async poll(request){const out=await base.poll(request);if(corrupt){if(mode==='reverse')out.deliveries.reverse();else if(mode==='same')out.deliveries[1]!.cursor=out.deliveries[0]!.cursor;else out.cursor++;}return out;}});const c=l.make();l.send('first', 'input',{},'notice_first','event');l.send('second','input',{},'notice_second','event');
    await assert.rejects(c.wake(),code('invalid_input'));assert.equal(l.ackCalls,0);corrupt=false;assert.equal((await c.wake()).inert,2);assert.equal(l.ackCalls,2);
  });
});
test('M1 page snapshot protects later delivery from mutation during earlier authority await',async t=>{
  const l=lab(t),base=l.getTransport();let deliveries:Awaited<ReturnType<RelayTransport['poll']>>['deliveries']=[];l.setTransport({...base,async poll(r){const out=await base.poll(r);deliveries=out.deliveries;return out;}});
  const authority=l.authority;let first=true;const c=new RelayConsumer({host:l.host,directory:l.data,transport:l.getTransport(),opener:l.receiver,authority:{candidate(e){if(first){first=false;deliveries[1]!.envelope={...deliveries[0]!.envelope};}return authority.candidate(e);},isCurrent:p=>authority.isCurrent(p)}});l.track(c);
  l.send('notice_a','input',{},'snap_a','event');l.send('notice_b','input',{},'snap_b','event');assert.equal((await c.wake()).inert,2);assert.equal(l.ackCalls,2);
});
test('L1 case-alias SQLite BUSY becomes host_locked and cannot admit a second writer',async t=>{
  const l=lab(t),c=l.make(),alias=join(l.root,'HOST');assert.ok(existsSync(alias),'fixture expects case-insensitive APFS');
  assert.throws(()=>new RelayConsumer({host:{...l.host},directory:alias,transport:l.getTransport(),opener:l.receiver,authority:l.authority}),code('host_locked'));
  l.send();assert.equal((await c.wake()).accepted,1);await c.close();const replacement=new RelayConsumer({host:l.host,directory:alias,transport:l.getTransport(),opener:l.receiver,authority:l.authority});l.track(replacement);await replacement.close();
});
test('L2 TLS fixture registers cleanup before in-memory certificate creation and removes its directory after early failure',async()=>{
  let cleanup:(()=>Promise<void>)|undefined,root='';const context={after(fn:()=>Promise<void>){cleanup=fn;}} as unknown as TestContext;
  await assert.rejects(tlsHostComposition(context,(p,stage)=>{root=p;assert.ok(cleanup,'cleanup registered before the factory creates TLS material');if(stage==='certificates'){assertNoTlsSidecars(root);throw new Error('early in-memory failure');}}),/early in-memory failure/);
  assert.ok(existsSync(root));assertNoTlsSidecars(root);await cleanup!();assert.equal(existsSync(root),false);
});
test('M1 fairness: an endless full-page stream cannot postpone the bounded head revisit',async t=>{
  const l=lab(t),base=l.getTransport(),afters:number[]=[];let source:Awaited<ReturnType<RelayTransport['poll']>>['deliveries']=[];
  for(let i=0;i<10;i++)l.send('endless_'+i,'invalid',{engine:'forbidden'});
  l.setTransport({...base,async poll(request){afters.push(request.after);const out=await base.poll(request);if(!source.length)source=out.deliveries;return {deliveries:source.map((d,i)=>({...d,cursor:request.after+i+1})),cursor:request.after+10};}});const c=l.make();
  for(let i=0;i<14;i++)assert.equal((await c.wake()).blocked,10);
  assert.deepEqual(afters,[...Array.from({length:13},(_,i)=>i*10),0]);assert.equal(l.ackCalls,0);assert.equal(l.calls,0);
});
test('M1 fairness: revoked device head cannot starve another current canonical device',async t=>{
  const l=lab(t);for(let i=0;i<10;i++)l.send('revoked_'+i);l.revoke();
  const enrolled=l.store.registerClientDeviceForClaim({namespace:'app-client-v1',claimId:'second_fixture',name:'Second synthetic',fingerprint:'b'.repeat(64),role:'client-mac',scopes:['chat.write']});
  const sender=new RelayEndpoint({ownerId:l.store.ownerId,installationId:l.store.hostId,deviceId:'second_relay',generation:1,keyId:'second_key'});l.relay.registerDevice(sender.publicPin);
  const now=Date.now();l.relay.enqueue(sender.seal(l.receiver.publicPin,{messageId:'second_message',sequence:1,type:'command',createdAt:now,expiresAt:now+60000},Buffer.from(JSON.stringify({version:1,operation:'turn.submit',operationId:'second_operation',threadId:l.thread.id,content:'other canonical device'}))));
  const principal:RelayPrincipal={...l.principal(),canonicalDeviceId:enrolled.deviceId,tlsFingerprint:enrolled.fingerprint,role:'client-mac',senderPin:sender.publicPin};
  const c=new RelayConsumer({host:l.host,directory:l.data,transport:l.getTransport(),opener:l.receiver,authority:{candidate:e=>e.senderId===sender.publicPin.deviceId?principal:null,isCurrent:p=>l.store.getDevice(p.canonicalDeviceId).revokedAt===null}});l.track(c);
  assert.equal((await c.wake()).blocked,10);assert.equal((await c.wake()).accepted,1);await until(()=>l.calls===1);assert.equal(l.ackCalls,1);assert.equal(l.relay.status().pending,10);assert.equal((await c.wake()).blocked,10);assert.equal(l.calls,1);
});
test('L2 TLS fixture closes real HostServices and started RelayService after staged failures without writing TLS sidecars',async()=>{
  for(const stage of ['certificates','host','service'] as const){
    let cleanup:(()=>Promise<void>)|undefined,root='';const context={after(fn:()=>Promise<void>){cleanup=fn;}} as unknown as TestContext;
    await assert.rejects(tlsHostComposition(context,(p,at)=>{root=p;if(at===stage){assert.ok(cleanup);assertNoTlsSidecars(root);throw new Error('staged early failure');}}),/staged early failure/);
    assert.ok(existsSync(root));assertNoTlsSidecars(root);await cleanup!();assert.equal(existsSync(root),false);
  }
});
