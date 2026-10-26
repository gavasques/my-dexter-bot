import { verify } from 'node:crypto';
import { inspect } from 'node:util';
import { control, controlBytes, envelope, header, publicKey, verifyEnvelope } from '@dexter/relay/protocol';
import type { AckRequest, DevicePin, Envelope, PollRequest } from '@dexter/relay';
import type { RelayOpener } from '@dexter/relay-consumer';
import { fail, object, publicPin, same } from './validation.js';
export interface DecryptionRequest {ephemeralPublicKey:string;nonce:string;ciphertext:string;tag:string;aad:string;installationId:string}
/** Opaque trusted local custody. Implementation must retain private keys internally.
 * Label describes operator-selected provider, not a claim that this code proves physical custody. */
export interface RelayCustodyProvider {
 readonly kind:'persistent_non_exportable'|'laboratory_memory_only'|'operator_sealed_exportable';readonly publicPin:DevicePin;
 current():boolean;sign(bytes:Uint8Array):Promise<Uint8Array>;decrypt(request:Readonly<DecryptionRequest>):Promise<Uint8Array>;close():Promise<void>;
}
export type CustodyMode='persistent'|'laboratory-memory'|'operator-sealed-exportable';
export function custodySnapshot(value:RelayCustodyProvider,mode:CustodyMode,expected:DevicePin):Readonly<RelayCustodyProvider>{
 const x=object(value,['kind','publicPin','current','sign','decrypt','close']);if(!['persistent','laboratory-memory','operator-sealed-exportable'].includes(mode)||x.kind!==(mode==='persistent'?'persistent_non_exportable':mode==='operator-sealed-exportable'?'operator_sealed_exportable':'laboratory_memory_only')||!same(publicPin(x.publicPin),publicPin(expected)))fail('forbidden');
 for(const k of ['current','sign','decrypt','close'])if(typeof x[k]!=='function')fail();
 return Object.freeze({kind:x.kind as RelayCustodyProvider['kind'],publicPin:publicPin(expected),current:(x.current as RelayCustodyProvider['current']).bind(value),sign:(x.sign as RelayCustodyProvider['sign']).bind(value),decrypt:(x.decrypt as RelayCustodyProvider['decrypt']).bind(value),close:(x.close as RelayCustodyProvider['close']).bind(value)});
}
/** Stable endpoint around supplied immutable public pin + actual opaque signer/decryptor.
 * No automatic key generation, file provisioning, retry or exposed private key object. */
export class StableRelayOpener implements RelayOpener {
 readonly publicPin:DevicePin;readonly #provider:Readonly<RelayCustodyProvider>;readonly #fence:()=>void;readonly #flights=new Set<Promise<unknown>>();#stopped=false;#closing:Promise<void>|null=null;#owned=false;
 constructor(provider:Readonly<RelayCustodyProvider>,fence:()=>void){this.#provider=provider;this.publicPin=publicPin(provider.publicPin);this.#fence=fence;}
 transferOwnership(){this.#owned=true;}
 private admit(){this.#fence();if(this.#stopped)fail('unavailable');try{if(!this.#provider.current())fail('unavailable');}catch{fail('unavailable');}}
 private run<T>(fn:()=>Promise<T>):Promise<T>{try{this.admit();}catch{return Promise.reject(new Error('relay custody unavailable'));}const p=Promise.resolve().then(()=>{this.admit();return fn();}).then(out=>{this.admit();return out;},()=>fail('unavailable'));this.#flights.add(p);void p.finally(()=>this.#flights.delete(p)).catch(()=>undefined);return p;}
 open(raw:Envelope,sender:DevicePin):Promise<Uint8Array>{let e:Envelope;try{e=envelope(raw);verifyEnvelope(e,publicPin(sender),this.publicPin);}catch{return Promise.reject(new Error('relay authentication refused'));}
  return this.run(async()=>{const out=await this.#provider.decrypt(Object.freeze({ephemeralPublicKey:e.ephemeralPublicKey,nonce:e.nonce,ciphertext:e.ciphertext,tag:e.tag,aad:header(e),installationId:e.installationId}));if(!(out instanceof Uint8Array)||out.length>32768)fail();return out;});
 }
 private signed(value:PollRequest|AckRequest){const c=control(value);return this.run(async()=>{const signature=await this.#provider.sign(controlBytes(c));if(!(signature instanceof Uint8Array)||signature.length!==64||!verify(null,controlBytes(c),publicKey(this.publicPin.signingPublicKey,'ed25519'),signature))fail('forbidden');return control({...c,signature:Buffer.from(signature).toString('base64')});});}
 poll(input:{requestId:string;issuedAt:number;after:number;limit:number}):Promise<PollRequest>{return this.signed({...this.base(input),kind:'poll',after:input.after,limit:input.limit}) as Promise<PollRequest>;}
 ack(input:{requestId:string;issuedAt:number;messages:AckRequest['messages']}):Promise<AckRequest>{return this.signed({...this.base(input),kind:'ack',messages:input.messages}) as Promise<AckRequest>;}
 private base(input:{requestId:string;issuedAt:number}){const p=this.publicPin;return {version:1 as const,installationId:p.installationId,ownerId:p.ownerId,deviceId:p.deviceId,generation:p.generation,keyId:p.keyId,requestId:input.requestId,issuedAt:input.issuedAt,signature:Buffer.alloc(64).toString('base64')};}
 stopAdmission(){this.#stopped=true;}
 close():Promise<void>{this.stopAdmission();return this.#closing??= (async()=>{await Promise.allSettled([...this.#flights]);if(this.#owned){try{await this.#provider.close();}catch{fail('unavailable');}}})();}
 disposeUnstarted(){if(this.#owned||this.#flights.size||this.#closing)fail('conflict');this.stopAdmission();}
 toJSON(){return {publicPin:this.publicPin,admission:this.#stopped?'stopped':'open',inFlight:this.#flights.size,custody:this.#provider.kind};}[inspect.custom](){return this.toJSON();}
}
