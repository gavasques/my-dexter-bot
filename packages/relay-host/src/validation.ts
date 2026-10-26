import { types } from 'node:util';
import { ConsumerError, RELAY_PRINCIPAL_SCOPES } from '@dexter/relay-consumer';
import { pin } from '@dexter/relay/protocol';
import type { ClientBinding } from '@dexter/devices';
export function fail(code:'invalid_input'|'forbidden'|'conflict'|'quota'|'host_locked'|'unavailable'='invalid_input'):never{throw new ConsumerError(code);}
export function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||types.isProxy(value)||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)fail();
 const d=Object.getOwnPropertyDescriptors(value),k=Reflect.ownKeys(d);if(k.length!==keys.length||k.some(x=>typeof x!=='string'||!keys.includes(x)||!d[x]!.enumerable||!('value' in d[x]!)))fail();
 return Object.fromEntries(keys.map(k=>[k,d[k]!.value]));
}
export function id(v:unknown):string{if(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(v))fail();return v;}
export function counter(v:unknown,min=1,max=Number.MAX_SAFE_INTEGER):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)fail();return v;}
export function publicPin(v:unknown){try{return Object.freeze(pin(v));}catch{return fail();}}
export function binding(v:unknown):Readonly<ClientBinding>{
 const x=object(v,['installationId','ownerId','deviceId','role','scopes','fingerprint','generation','revision','status']);
 for(const k of ['installationId','ownerId','deviceId'])id(x[k]);counter(x.generation);counter(x.revision);
 if((typeof x.role!=='string'||!['client-ios','client-mac'].includes(x.role))||(typeof x.status!=='string'||!['active','revoked'].includes(x.status))||typeof x.fingerprint!=='string'||!/^[0-9a-f]{64}$/.test(x.fingerprint))fail();
 const a=x.scopes;if(!Array.isArray(a)||types.isProxy(a)||a.length>RELAY_PRINCIPAL_SCOPES.length||Reflect.ownKeys(a).length!==a.length+1||Object.getPrototypeOf(a)!==Array.prototype)fail();
 const scopes:string[]=[];for(let i=0;i<a.length;i++){const d=Object.getOwnPropertyDescriptor(a,String(i));if(!d||!('value'in d)||typeof d.value!=='string'||!(RELAY_PRINCIPAL_SCOPES as readonly string[]).includes(d.value)||scopes.includes(d.value))fail();scopes.push(d.value);}
 return Object.freeze({...x,scopes:Object.freeze(scopes.sort())}) as unknown as Readonly<ClientBinding>;
}
export const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function next(v:number):number{if(!Number.isSafeInteger(v+1))fail('conflict');return v+1;}

/** Trusted local construction failure whose first rollback did not safely close its DB.
 * The caller must quarantine its canonical writer; never classify an ordinary input failure this way. */
export class RelayCleanupIncompleteError extends AggregateError {
 constructor(cleanup:unknown,cause:unknown){super([cleanup],cleanup instanceof Error?cleanup.message:'Relay construction cleanup incomplete.',{cause});}
}
