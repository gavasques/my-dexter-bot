import { join } from 'node:path';
import { inspect, types } from 'node:util';
import { RelayConsumer, type HostPort, type RelayTransport, type WakeReport, type RelayConsumerStatus, type PendingAckPage, type AckReconcileInput, type AckReconcileStatus } from '@dexter/relay-consumer';
import type { DevicePin } from '@dexter/relay';
import { RelayAssociations, type BindingSource, type Enrollment } from './associations.js';
import { StableRelayOpener, custodySnapshot, type CustodyMode, type RelayCustodyProvider } from './custody.js';
import { counter, fail, object, publicPin, same, RelayCleanupIncompleteError } from './validation.js';
export { RelayCleanupIncompleteError } from './validation.js';
export * from './associations.js';export * from './custody.js';export * from './recovery.js';
/** One explicit trusted deployment bound, also passed to the producer. Never queue metadata. */
export function relayDeployment(value:unknown):Readonly<{maximumPendingPerRecipient:number}>{const d=object(value,['maximumPendingPerRecipient']);return Object.freeze({maximumPendingPerRecipient:counter(d.maximumPendingPerRecipient,1,4096)});}
export interface RelayHostOptions {recipient:DevicePin;custody:RelayCustodyProvider;custodyMode:CustodyMode;transport:RelayTransport;transportOwnership:'borrowed'|'owned';deployment:{maximumPendingPerRecipient:number};maximumAssociations?:number;maximumOperations?:number;dispatchMs?:number}
export function validateRelayHostOptions(value:RelayHostOptions):Readonly<RelayHostOptions>{
 try{if(!value||typeof value!=='object'||types.isProxy(value))fail();const optional=['maximumAssociations','maximumOperations','dispatchMs'];const keys=Reflect.ownKeys(value);const raw=object(value,['recipient','custody','custodyMode','transport','transportOwnership','deployment',...optional.filter(k=>keys.includes(k))]);
 const recipient=publicPin(raw.recipient);const custody=custodySnapshot(raw.custody as RelayCustodyProvider,raw.custodyMode as CustodyMode,recipient);
 const t=object(raw.transport,['poll','ack','close']);for(const k of ['poll','ack','close'])if(typeof t[k]!=='function')fail();if((typeof raw.transportOwnership!=='string'||!['borrowed','owned'].includes(raw.transportOwnership)))fail();
 const transport=Object.freeze({poll:(t.poll as RelayTransport['poll']).bind(raw.transport),ack:(t.ack as RelayTransport['ack']).bind(raw.transport),close:(t.close as RelayTransport['close']).bind(raw.transport)});
 const out:RelayHostOptions={recipient,custody,custodyMode:raw.custodyMode as CustodyMode,transport,transportOwnership:raw.transportOwnership as 'owned'|'borrowed',deployment:relayDeployment(raw.deployment)};
 if(raw.maximumAssociations!==undefined)out.maximumAssociations=counter(raw.maximumAssociations,1,100000);if(raw.maximumOperations!==undefined)out.maximumOperations=counter(raw.maximumOperations,1,100000);if(raw.dispatchMs!==undefined)out.dispatchMs=counter(raw.dispatchMs,10,60000);return Object.freeze(out);
 }catch{return fail();}
}
export interface RelayHostAdmin {binding(deviceId:string):ReturnType<BindingSource["binding"]>;enroll(input:Enrollment):{deviceId:string;revision:number};revoke(deviceId:string,expectedRevision:number):void;rotateRecipient(pin:DevicePin,expectedRevision:number):void;recipient():Readonly<{pin:DevicePin;revision:number}>;
 /** Bounded public page of retained pending ACK rows with their disposition (pre-cut reconciliation input). */
 pendingAcks(input:{limit:number;after?:string}):PendingAckPage;
 /** Explicit owner reconciliation of one exact row with the CURRENT custody; never automatic, never a dispatch. */
 reconcileAck(input:AckReconcileInput):Promise<{status:AckReconcileStatus}>}
/** Actual composition. Both auxiliary journals borrow the canonical writer; registry stays externally owned. */
export class RelayHost {
 readonly admin:Readonly<RelayHostAdmin>;readonly #opener:StableRelayOpener;readonly #associations:RelayAssociations;readonly #consumer:RelayConsumer;readonly #options:Readonly<RelayHostOptions>;
 #stopped=false;#owned=false;#closing:Promise<void>|null=null;#closed=false;
 constructor(host:HostPort,bindings:BindingSource,dataDir:string,options:Readonly<RelayHostOptions>){
  this.#options=options;this.#opener=new StableRelayOpener(options.custody,()=>{host.withWriterLease(()=>undefined);if(!same(this.#associations.recipient().pin,this.#opener.publicPin))fail('unavailable');});
  this.#associations=new RelayAssociations(host,bindings,join(dataDir,'relay-host'),options.recipient,options.maximumAssociations);
  try{this.#consumer=new RelayConsumer({host,directory:join(dataDir,'relay-host'),transport:options.transport,transportOwnership:'borrowed',opener:this.#opener,authority:this.#associations,maximumPendingPerRecipient:options.deployment.maximumPendingPerRecipient,...(options.maximumOperations!==undefined?{maximumOperations:options.maximumOperations}:{}),...(options.dispatchMs!==undefined?{dispatchMs:options.dispatchMs}:{})});}catch(e){try{this.#associations.close();}catch(cleanup){throw new RelayCleanupIncompleteError(cleanup,e);}throw e;}
  const call=<T>(fn:()=>T):T=>{if(this.#stopped||!this.#owned)fail('unavailable');return fn();};
  this.admin=Object.freeze({binding:(id:string)=>call(()=>bindings.binding(id)),enroll:(v:Enrollment)=>call(()=>this.#associations.enroll(v)),revoke:(id:string,rev:number)=>call(()=>this.#associations.revoke(id,rev)),rotateRecipient:(pin:DevicePin,rev:number)=>call(()=>this.#associations.rotateRecipient(pin,rev)),recipient:()=>call(()=>this.#associations.recipient()),pendingAcks:(input:{limit:number;after?:string})=>call(()=>this.#consumer.pendingAcks(input)),reconcileAck:(input:AckReconcileInput)=>call(()=>this.#consumer.reconcileAck(input))});
 }
 /** Ownership transfers only after successful HostServices final construction step. */
 transferOwnership(){if(this.#owned||this.#stopped)fail('conflict');this.#owned=true;this.#opener.transferOwnership();}
 wake():Promise<WakeReport>{if(this.#stopped||!this.#owned)return Promise.reject(new Error('relay host unavailable'));return this.#consumer.wake();}
 stopAdmission(){this.#stopped=true;this.#consumer.stopAdmission();this.#associations.stopAdmission();this.#opener.stopAdmission();}
 close():Promise<void>{this.stopAdmission();if(this.#closing)return this.#closing;
  // Start owned transport abort/drain synchronously, then retain raw consumer/opener flights.
  let transport:Promise<void>=Promise.resolve();if(this.#owned&&this.#options.transportOwnership==='owned'){try{transport=Promise.resolve(this.#options.transport.close());}catch(e){transport=Promise.reject(e);}void transport.catch(()=>undefined);}
  return this.#closing=(async()=>{const errors:unknown[]=[];for(const fn of [()=>this.#consumer.close(),()=>transport,()=>this.#opener.close(),()=>this.#associations.close()]){try{await fn();}catch{errors.push(new Error('Relay auxiliary cleanup failed'));}}if(errors.length)throw new AggregateError(errors,'Relay drain incomplete');this.#closed=true;})();
 }
 disposeUnstarted(){if(this.#owned||this.#closing)fail('conflict');this.stopAdmission();this.#consumer.disposeUnstarted();this.#opener.disposeUnstarted();this.#associations.close();this.#closed=true;}
 status():RelayConsumerStatus & {configured:true;custodyMode:CustodyMode;persistentCustodyVerified:false}{return {...this.#consumer.status(),configured:true,closed:this.#closed,custodyMode:this.#options.custodyMode,persistentCustodyVerified:false};}
 toJSON(){return this.status();}[inspect.custom](){return this.status();}
}
