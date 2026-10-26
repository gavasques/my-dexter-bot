import { join } from 'node:path';
import type { ClientBinding } from '@dexter/devices';
import type { DevicePin } from '@dexter/relay';
import { inspectPendingAcks, type HostPort, type PendingAckPage } from '@dexter/relay-consumer';
import { RelayAssociations, type BindingSource, type Enrollment } from './associations.js';
import { counter, fail, object, publicPin } from './validation.js';
/** Safe public counts only: no binding/sender JSON, journal payload, custody or transport state. */
export interface RelayRecoveryStatus {recipient:DevicePin;hostRevision:number;active:number;revoked:number;history:number;pins:number;relay:'inactive'}
/** Public per-peer state needed for an explicit CAS enrollment: association revision/status only, no keys or JSON. */
export interface RelayRecoveryPeer {deviceId:string;association:Readonly<{revision:number;status:'active'|'revoked';hostRevision:number}>|null}
/** Minimal structural owner-local recovery port. Public pins, canonical binding and CAS only: no custody provider,
 * opener, consumer, transport, poll/wake, engine call or grant. Composition (HostServices/operations) can hold it
 * structurally without importing relay-host internals. */
export interface RelayRecoveryPort {
 status():Readonly<RelayRecoveryStatus>;
 binding(deviceId:string):Readonly<ClientBinding>|null;
 rotateRecipient(pin:DevicePin,expectedHostRevision:number):Readonly<{recipient:DevicePin;hostRevision:number;tombstoned:number}>;
 enroll(input:Enrollment):Readonly<{deviceId:string;revision:number}>;
 close():void;
}
/** Destination recovery after restore: existing `<dataDir>/relay-host/relay-associations.sqlite` only, under the
 * canonical HostPort writer (every mutation re-fences; a lost writer/authority refuses at the final boundary) and the
 * live AppClient BindingSource. Must not be open together with RelayHost (same in-process/exclusive SQLite guards).
 * The normal RelayHost reopens only with a provider whose public pin equals the rotated recipient exactly. */
export class RelayRecoveryMaintenance implements RelayRecoveryPort {
 readonly #associations:RelayAssociations;readonly #bindings:BindingSource;readonly #host:HostPort;readonly #directory:string;#closed=false;#stopped=false;
 constructor(host:HostPort,bindings:BindingSource,dataDir:string,options:{maximumAssociations?:number}={}){
  const o=object(options,options&&typeof options==='object'&&'maximumAssociations' in options?['maximumAssociations']:[]);
  if(!bindings||typeof bindings.binding!=='function')fail();this.#bindings=bindings;this.#host=host;this.#directory=join(dataDir,'relay-host');
  this.#associations=RelayAssociations.openExisting(host,bindings,this.#directory,o.maximumAssociations===undefined?4096:counter(o.maximumAssociations,1,100000));
 }
 /** Synchronous and permanent: every retained reference refuses afterwards (close still drains the handle). */
 stopAdmission(){this.#stopped=true;this.#associations.stopAdmission();}
 private open(){if(this.#closed||this.#stopped)fail('unavailable');}
 /** Association revision/status of one peer (public). */
 peer(deviceId:string):Readonly<RelayRecoveryPeer>{this.open();return Object.freeze({deviceId,association:this.#associations.association(deviceId)});}
 /** Retained pending ACK rows of the restored consumer journal, classified against the PERSISTED recipient without
  * custody: same generation is `requires_custody`, older generations `obsolete_recipient_generation` (terminal). Opens the
  * existing journal only (never bootstraps), read-only queries, closes before returning. */
 pendingAcks(input:{limit:number;after?:string}|'all'):PendingAckPage{this.open();const r=this.#associations.recipient();return inspectPendingAcks(this.#host,this.#directory,r.pin,input);}
 status():Readonly<RelayRecoveryStatus>{this.open();const r=this.#associations.recipient(),c=this.#associations.counts();return Object.freeze({recipient:r.pin,hostRevision:r.revision,...c,relay:'inactive'});}
 binding(deviceId:string){this.open();return this.#bindings.binding(deviceId);}
 rotateRecipient(pin:DevicePin,expectedHostRevision:number){this.open();const p=publicPin(pin);counter(expectedHostRevision);const tombstoned=this.#associations.rotateRecipient(p,expectedHostRevision);const r=this.#associations.recipient();return Object.freeze({recipient:r.pin,hostRevision:r.revision,tombstoned});}
 /** Explicit per-peer enrollment: the exact revision of an existing tombstone (re-enrollment) or `null` for a peer
  * with no association (e.g. re-paired after restore: activation revokes every restored device binding, so restored
  * tombstones stay tombstones). Always the current host revision, the current ACTIVE canonical binding and the
  * sender's next public pin (fresh keys). Never bumps an active association. */
 enroll(input:Enrollment){this.open();const x=object(input,['expectedRevision','expectedHostRevision','binding','senderPin']);const deviceId=(x.binding&&typeof x.binding==='object'?(x.binding as {deviceId?:unknown}).deviceId:undefined);if(typeof deviceId!=='string')fail();
  const current=this.#associations.association(deviceId);if(current?(current.status!=='revoked'||current.revision!==x.expectedRevision):x.expectedRevision!==null)fail('conflict');return Object.freeze(this.#associations.enroll(x));}
 close(){if(this.#closed)return;this.#stopped=true;this.#associations.close();this.#closed=true;}
}
