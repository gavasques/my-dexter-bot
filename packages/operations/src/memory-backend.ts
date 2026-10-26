import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson,sha256Text,type Json} from './canonical.js';
import {all,one} from './schemas.js';
import {fail} from './errors.js';
export {MEMORY_BACKEND_SQL,MEMORY_BACKEND_TABLES,BACKEND_COUNT_TABLES} from './memory-backend-schema.js';
const broken=(message:string):never=>fail('reference_broken','Memory backend: '+message);
const natural=(value:unknown):number=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)return broken('natural integer required');return value;};
const positive=(value:unknown):number=>{const n=natural(value);if(n===0)return broken('positive revision required');return n;};
const id=(value:unknown):string=>{if(typeof value!=='string'||value.length<1||value.length>160||!/^[A-Za-z0-9_.:-]+$/.test(value))return broken('closed identifier required');return value;};
function closed(value:unknown,keys:readonly string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))return broken('closed metadata required');return value as Record<string,unknown>;}
function json(raw:unknown,keys:readonly string[]):Record<string,unknown>{if(typeof raw!=='string'||Buffer.byteLength(raw)>8192)return broken('bounded metadata JSON required');let value:unknown;try{value=JSON.parse(raw);}catch{return broken('metadata JSON invalid');}const fixed=closed(value,keys);if(canonicalJson(fixed as Json)!==raw)return broken('canonical metadata required');return fixed;}
function origin(raw:unknown):string {
 if(typeof raw!=='string'||raw.length>512||/[?#@\\\s]/u.test(raw))return broken('metadata origin contains private fields');
 let url:URL;try{url=new URL(raw);}catch{return broken('origin invalid');}
 if(raw!==url.origin||url.pathname!=='/'||url.username||url.password||url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)&&url.port))return broken('canonical origin required');
 return raw;
}
interface Settings {revision:number;origin:string;enabled:boolean;updatedAt:number}
const settings=(raw:unknown):Settings=>{const value=closed(raw,['revision','origin','enabled','updatedAt']);if(typeof value.enabled!=='boolean')return broken('enabled metadata required');return {revision:positive(value.revision),origin:origin(value.origin),enabled:value.enabled,updatedAt:natural(value.updatedAt)};};
const OUTCOMES=['account_exists','identity_verified','unknown','credential_required','blocked_configuration'] as const;
/** Metadata only. Historical receipts never constitute custody, authentication, grants or backend readiness. */
export function validateMemoryBackend(db:DatabaseSync,hub:DatabaseSync):void {
 if(one(db,"SELECT value FROM meta WHERE key='schema'")?.value!=='5')return;
 if(all(db,'PRAGMA foreign_key_check').length!==0)broken('foreign references');
 const hostId=String(one(db,"SELECT value FROM meta WHERE key='installation'")?.value),ownerId=String(one(db,"SELECT value FROM meta WHERE key='owner'")?.value);
 if(one(hub,"SELECT value FROM meta WHERE key='host_id'")?.value!==hostId||one(hub,"SELECT value FROM meta WHERE key='owner_id'")?.value!==ownerId)broken('installation ownership');
 const head=one(db,'SELECT * FROM memory_backend_settings WHERE singleton=1'),receipts=all(db,'SELECT * FROM memory_backend_setting_receipts'),history=new Map<number,Settings>(),requests=new Map<number,string>();
 for(const row of receipts){
  const receipt=json(row.receipt_json,['hostId','ownerId','clientRequestId','requestHash','previousRevision','settings','committedAt']),requestId=id(row.request_id),current=settings(receipt.settings),previous=natural(receipt.previousRevision),committed=natural(receipt.committedAt);
  const expected=sha256Text(canonicalJson({expectedHostId:hostId,clientRequestId:requestId,expectedRevision:previous,origin:current.origin,enabled:current.enabled}));
  if(receipt.hostId!==hostId||receipt.ownerId!==ownerId||receipt.clientRequestId!==requestId||receipt.requestHash!==expected||row.request_hash!==expected||current.revision!==previous+1||row.created_at!==committed||current.updatedAt!==committed||history.has(current.revision))broken('settings CAS receipt lineage');
  history.set(current.revision,current);requests.set(current.revision,requestId);
 }
 if(!head){if(receipts.length||all(db,'SELECT operation_key FROM memory_backend_provisioning').length)broken('metadata has no configuration');return;}
 const revision=positive(head.revision),current=history.get(revision);
 if(head.singleton!==1||receipts.length!==revision||!current||head.origin!==current.origin||head.enabled!==(current.enabled?1:0)||head.updated_at!==current.updatedAt||head.request_id!==requests.get(revision))broken('settings head receipt');
 for(let n=1;n<=revision;n++)if(!history.has(n))broken('settings history gap');
 const accountId='dx1_'+Buffer.from(hostId,'utf8').toString('hex');
 for(const row of all(db,'SELECT * FROM memory_backend_provisioning')){
  const operationKey=id(row.operation_key),configRevision=positive(row.config_revision),config=history.get(configRevision),kind=String(row.kind),userId=String(row.user_id);
  if(!config||!config.enabled||row.account_id!==accountId||!['account','bot_user'].includes(kind)||!/^[A-Za-z0-9_-]{1,261}$/.test(userId))broken('provisioning configuration/scope');
  if(kind==='account'){if(userId!=='svc1_'+Buffer.from(hostId,'utf8').toString('hex'))broken('account admin scope');}
  else{const encoded=userId.slice(5),botId=Buffer.from(encoded,'hex').toString('utf8');if(!userId.startsWith('bot1_')||!encoded||Buffer.from(botId,'utf8').toString('hex')!==encoded||one(hub,'SELECT owner_id FROM bots WHERE id=?',botId)?.owner_id!==ownerId)broken('bot identity ownership');}
  const binding={operationKey,kind,accountId,userId},expected=sha256Text(canonicalJson({...binding,origin:config!.origin,configRevision}));
  if(row.request_hash!==expected||natural(row.updated_at)<natural(row.created_at))broken('provisioning immutable binding/hash');
  if(row.state==='dispatched'){if(row.receipt_json!==null)broken('dispatched receipt');}
  else if(row.state==='recorded'){
   const receipt=json(row.receipt_json,['operationKey','kind','accountId','userId','outcome','content','indexing']);
   if(receipt.operationKey!==operationKey||receipt.kind!==kind||receipt.accountId!==accountId||receipt.userId!==userId||!OUTCOMES.includes(receipt.outcome as typeof OUTCOMES[number])||receipt.content!=='unproven'||receipt.indexing!=='unproven')broken('provisioning safe receipt');
   if(kind==='account'&&!['account_exists','unknown'].includes(String(receipt.outcome))||kind==='bot_user'&&receipt.outcome==='account_exists')broken('provisioning receipt kind');
  }else broken('provisioning state');
 }
}
export interface MemoryBackendMetadataSummary {configuration:{configured:boolean;enabled:boolean;revision:number};journal:{dispatched:number;recorded:number};custody:'excluded';readiness:'not_checked'}
/** Value-free diagnosis. Never returns origin, IDs, receipt bodies, content or credentials. */
export function memoryBackendMetadataSummary(db:DatabaseSync,hub:DatabaseSync):MemoryBackendMetadataSummary {
 validateMemoryBackend(db,hub);const row=one(db,'SELECT revision,enabled FROM memory_backend_settings WHERE singleton=1');
 return {configuration:{configured:!!row,enabled:row?.enabled===1,revision:row?Number(row.revision):0},journal:{dispatched:Number(one(db,"SELECT COUNT(*) AS n FROM memory_backend_provisioning WHERE state='dispatched'")?.n),recorded:Number(one(db,"SELECT COUNT(*) AS n FROM memory_backend_provisioning WHERE state='recorded'")?.n)},custody:'excluded',readiness:'not_checked'};
}
