// LAB ONLY subprocess failpoints. SIGSTOP occurs only after a synchronous boundary marker; parent owns SIGKILL.
import { appendFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ConversationRuntime, HostStore, type RuntimeDriver } from "@dexter/hub";
import { RelayEndpoint, type AckRequest, type DevicePin, type PollRequest } from "@dexter/relay";
import { RelayConsumer, type RelayPrincipal, type RelayTransport } from "../../packages/relay-consumer/src/index.js";
import { canonicalHost } from "./relay-consumer-host.js";
export const crashFixtureURL=new URL(import.meta.url);
interface Init {directory:string;generation:number;senderPin:DevicePin;threadId:string;point:string;enrollmentId:string}
const emit=(value:unknown)=>writeSync(1,JSON.stringify(value)+'\n');
if(process.argv[2]==='laboratory-relay-consumer-crash'){
  process.once('message',(raw)=>{void main(raw as Init).catch(()=>{emit({kind:'fixture_failed'});process.exit(2);});});
}
async function main(init:Init):Promise<void>{
  const store=new HostStore({dataDir:init.directory});const engineLog=join(init.directory,'fixture-engine-turns.log');
  const driver:RuntimeDriver={id:'claude',sessionReuse:'turn',async open(threadId){return {threadId,nativeCursor:'synthetic'};},async *turn(session,turnId){appendFileSync(engineLog,turnId+'\n',{mode:0o600});yield {type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},async close(){},async respondToTool(){},async interrupt(){}};
  const runtime=new ConversationRuntime({store,drivers:[driver]});const canonical=canonicalHost(store,runtime);
  const receiver=new RelayEndpoint({ownerId:store.ownerId,installationId:store.hostId,deviceId:'crash_host',generation:init.generation,keyId:'crash_host_key_'+init.generation});
  let serial=0;const pending=new Map<number,{resolve:(value:unknown)=>void;reject:()=>void}>();
  process.on('message',(message)=>{const value=message as {kind:string;id?:number;value?:unknown};if(value.kind==='reply'&&value.id!==undefined){const request=pending.get(value.id);pending.delete(value.id);request?.resolve(value.value);}else if(value.kind==='wake'){void consumer.wake().then(report=>emit({kind:'completed',report}),()=>emit({kind:'wake_failed'}));}else if(value.kind==='close'){void (async()=>{await consumer.close();await runtime.shutdown({closeStore:false});store.close();emit({kind:'closed'});process.disconnect();})();}});
  process.on('disconnect',()=>{for(const request of pending.values())request.reject();pending.clear();});
  const remote=(kind:string,request:PollRequest|AckRequest)=>new Promise<unknown>((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject:()=>reject(Error('fixture IPC closed'))});process.send?.({kind,id,request});});
  let fired=false;const boundary=(point:string)=>{if(!fired&&init.point===point){fired=true;emit({kind:'boundary',point});process.kill(process.pid,'SIGSTOP');}};
  const transport:RelayTransport={async poll(request){return await remote('poll',request) as Awaited<ReturnType<RelayTransport['poll']>>;},async ack(request){boundary('after-journal');const result=await remote('ack',request) as {receiptId:string};boundary('after-ack');return result;},async close(){}};
  const principal=():RelayPrincipal=>{const enrollment=store.findClientDeviceEnrollment({namespace:'app-client-v1',claimId:init.enrollmentId})!;return {hostId:store.hostId,ownerId:store.ownerId,canonicalDeviceId:enrollment.deviceId,tlsFingerprint:enrollment.fingerprint,role:enrollment.role,scopes:enrollment.scopes,pinGeneration:1,bindingRevision:1,senderPin:init.senderPin,recipientPin:receiver.publicPin};};
  const consumer=new RelayConsumer({directory:init.directory,host:{...canonical,startTurn(id,input,hash){boundary('before-host');const result=canonical.startTurn(id,input,hash);boundary('after-host');return result;}},transport,opener:receiver,authority:{candidate(e){return e.senderId===init.senderPin.deviceId?principal():null;},isCurrent(p){return store.getDevice(p.canonicalDeviceId).revokedAt===null&&p.senderPin.keyId===init.senderPin.keyId;}}});
  emit({kind:'ready',pin:receiver.publicPin});
}
