import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import type { ClientBinding } from '@dexter/devices';
import type { DevicePin, Envelope } from '@dexter/relay';
import { envelope } from '@dexter/relay/protocol';
import type { CurrentRelayAuthority, HostPort, RelayPrincipal } from '@dexter/relay-consumer';
import { binding, counter, fail, id, next, object, publicPin, same, RelayCleanupIncompleteError } from './validation.js';
export interface BindingSource {binding(deviceId:string):Readonly<ClientBinding>|null}
export interface Enrollment {expectedRevision:number|null;expectedHostRevision:number;binding:Readonly<ClientBinding>;senderPin:DevicePin}
export const ASSOCIATIONS_FILE='relay-associations.sqlite';
const OPEN=new Set<string>();
let recovering=false;
// Keep failed-close native handles strongly reachable: GC is not a verified rollback.
const QUARANTINED=new Map<string,DatabaseSync>();
const SQL=`CREATE TABLE metadata(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=1),host_id TEXT NOT NULL,owner_id TEXT NOT NULL,host_revision INTEGER NOT NULL,recipient_json TEXT NOT NULL);
CREATE TABLE associations(device_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','revoked')),binding_json TEXT NOT NULL,sender_json TEXT NOT NULL,host_revision INTEGER NOT NULL);
CREATE TABLE history(device_id TEXT NOT NULL,revision INTEGER NOT NULL,action TEXT NOT NULL CHECK(action IN ('enroll','revoke','recipient')),binding_json TEXT NOT NULL,sender_json TEXT NOT NULL,host_revision INTEGER NOT NULL,PRIMARY KEY(device_id,revision));
CREATE TABLE pins(device_id TEXT NOT NULL,generation INTEGER NOT NULL,key_id TEXT NOT NULL UNIQUE,signing_key TEXT NOT NULL UNIQUE,encryption_key TEXT NOT NULL UNIQUE,pin_json TEXT NOT NULL,PRIMARY KEY(device_id,generation));`;
const schema=(d:DatabaseSync)=>JSON.stringify(d.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all());
const expected=(()=>{const d=new DatabaseSync(':memory:');try{d.exec(SQL);return schema(d);}finally{d.close();}})();
/** Exact persisted recipient of a cleanly closed file (no `-wal`: the main file is authoritative), read immutably. Any doubt returns null and the full validated open decides. */
function persistedRecipient(path:string):DevicePin|null{if(!existsSync(path)||existsSync(path+'-wal'))return null;try{const url=pathToFileURL(path);url.search='immutable=1';const d=new DatabaseSync(url,{readOnly:true});try{const row=d.prepare('SELECT recipient_json FROM metadata WHERE id=1').get();return row?publicPin(JSON.parse(String(row.recipient_json))):null;}finally{d.close();}}catch{return null;}}
function privateFile(p:string,dir=false){const s=lstatSync(p);if(s.isSymbolicLink()||(dir?!s.isDirectory():!s.isFile())||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)fail('forbidden');}
/** Public-only metadata. No pairing offers, certificate keys, provider keys, grants or plaintext. */
export class RelayAssociations implements CurrentRelayAuthority {
 readonly path:string;readonly #db:DatabaseSync;readonly #host:HostPort;readonly #bindings:BindingSource;readonly #maximum:number;#closed=false;#stopped=false;#closeError:unknown;
 /** Owner-local recovery only: opens EXISTING public metadata under the canonical writer without a recipient claim.
  * Never creates a directory or database (no bootstrap of a missing recovery source) and never compares custody. */
 static openExisting(host:HostPort,bindings:BindingSource,directory:string,maximum=4096):RelayAssociations{recovering=true;try{return new RelayAssociations(host,bindings,directory,null,maximum);}finally{recovering=false;}}
 constructor(host:HostPort,bindings:BindingSource,directory:string,recipient:DevicePin|null,maximum=4096){
  const recovery=recovering;recovering=false;if(recipient===null&&!recovery)fail();counter(maximum,1,100000);this.#host=host;this.#bindings=bindings;this.#maximum=maximum;
  if(!isAbsolute(directory)||normalize(directory)!==directory)fail();host.withWriterLease(()=>undefined);
  for(let ancestor=directory;;ancestor=dirname(ancestor)){if(existsSync(ancestor)&&lstatSync(ancestor).isSymbolicLink())fail('forbidden');if(dirname(ancestor)===ancestor)break;}
  if(!existsSync(directory)){if(recovery)fail('unavailable');mkdirSync(directory,{recursive:true,mode:0o700});}privateFile(directory,true);if(realpathSync(directory)!==directory)fail('forbidden');
  this.path=join(directory,ASSOCIATIONS_FILE);this.files();if(OPEN.has(this.path))fail('host_locked');
  if(recovery&&!existsSync(this.path))fail('unavailable');
  const p=recipient===null?null:publicPin(recipient);if(p&&(p.installationId!==host.hostId||p.ownerId!==host.ownerId||p.generation!==1&&!existsSync(this.path)))fail('forbidden');
  // Refuse an unapproved recipient before the writable open (which would convert a restored rollback-journal file to WAL).
  if(p){const prior=persistedRecipient(this.path);if(prior&&!same(prior,p))fail('conflict');}
  const existed=existsSync(this.path),d=new DatabaseSync(this.path);this.#db=d;OPEN.add(this.path);
  try{chmodSync(this.path,0o600);d.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;');this.seal();
   host.withWriterLease(()=>{if(!existed){if(!p)fail('unavailable');d.exec('BEGIN IMMEDIATE');try{d.exec(SQL);d.prepare('INSERT INTO metadata VALUES(1,1,?,?,1,?)').run(host.hostId,host.ownerId,JSON.stringify(p));this.addPin(p);d.exec('COMMIT');}catch(e){d.exec('ROLLBACK');throw e;}}this.validate();this.validateRows();if(p&&!same(this.recipientUnsafe(),p))fail('conflict');});this.seal();this.files();
  }catch(e){try{d.close();OPEN.delete(this.path);}catch(cleanup){this.#closeError=cleanup;QUARANTINED.set(this.path,d);throw new RelayCleanupIncompleteError(cleanup,e);}throw e;}
 }
 private seal(){for(const suffix of ['-wal','-shm'])if(existsSync(this.path+suffix))chmodSync(this.path+suffix,0o600);}
 private files(){privateFile(dirname(this.path),true);for(const suffix of ['','-wal','-shm','-journal']){const p=this.path+suffix;try{lstatSync(p);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}privateFile(p);}}
 private validate(){if(this.#closed)fail('unavailable');this.files();if(schema(this.#db)!==expected)fail('conflict');const m=this.#db.prepare('SELECT * FROM metadata').all();if(m.length!==1||m[0]!.host_id!==this.#host.hostId||m[0]!.owner_id!==this.#host.ownerId||m[0]!.version!==1)fail('conflict');counter(m[0]!.host_revision);publicPin(JSON.parse(String(m[0]!.recipient_json)));}
 private validateRows(){
  const recipient=this.recipientUnsafe(),metadata=this.#db.prepare('SELECT host_revision FROM metadata').get()!;if(recipient.installationId!==this.#host.hostId||recipient.ownerId!==this.#host.ownerId||recipient.generation!==metadata.host_revision)fail('conflict');
  for(const table of ['associations','history','pins'])if(Number(this.#db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)>this.#maximum)fail('quota');
  const generations=new Map<string,number>();for(const row of this.#db.prepare('SELECT * FROM pins ORDER BY device_id,generation').all()){const p=publicPin(JSON.parse(String(row.pin_json)));if(p.installationId!==this.#host.hostId||p.ownerId!==this.#host.ownerId||p.deviceId!==row.device_id||p.generation!==row.generation||p.keyId!==row.key_id||p.signingPublicKey!==row.signing_key||p.encryptionPublicKey!==row.encryption_key||p.generation!==(generations.get(p.deviceId)??0)+1)fail('conflict');generations.set(p.deviceId,p.generation);}
  const last=new Map<string,Record<string,unknown>>();for(const row of this.#db.prepare('SELECT * FROM history ORDER BY device_id,revision').all()){const b=binding(JSON.parse(String(row.binding_json))),p=publicPin(JSON.parse(String(row.sender_json)));counter(row.host_revision);counter(row.revision);const old=last.get(b.deviceId);if(row.device_id!==b.deviceId||b.installationId!==this.#host.hostId||b.ownerId!==this.#host.ownerId||p.deviceId!==b.deviceId||p.installationId!==b.installationId||p.ownerId!==b.ownerId||row.revision!==(old?Number(old.revision)+1:1)||(!old&&row.action!=='enroll')||Number(row.host_revision)>Number(metadata.host_revision)||!this.#db.prepare('SELECT 1 FROM pins WHERE device_id=? AND generation=? AND pin_json=?').get(p.deviceId,p.generation,JSON.stringify(p)))fail('conflict');last.set(b.deviceId,row);}
  for(const row of this.#db.prepare('SELECT * FROM associations').all()){this.associationHostRevision(row.host_revision);const h=last.get(String(row.device_id));if(!h||row.revision!==h.revision||row.binding_json!==h.binding_json||row.sender_json!==h.sender_json||(row.status==='active'?(h.action!=='enroll'||row.host_revision!==metadata.host_revision):h.action==='enroll'))fail('conflict');last.delete(String(row.device_id));}if(last.size)fail('conflict');
  const pinned=this.#db.prepare('SELECT pin_json FROM pins WHERE device_id=? AND generation=?').get(recipient.deviceId,recipient.generation);if(!pinned||!same(publicPin(JSON.parse(String(pinned.pin_json))),recipient))fail('conflict');
 }
 private fence<T>(fn:()=>T):T{return this.#host.withWriterLease(()=>{this.validate();return fn();});}
 private admitted(){if(this.#stopped)fail('unavailable');}
 private tx<T>(fn:()=>T):T{return this.fence(()=>{this.admitted();this.#db.exec('BEGIN IMMEDIATE');try{const out=fn();this.#db.exec('COMMIT');return out;}catch(e){this.#db.exec('ROLLBACK');throw e;}});}
 private recipientUnsafe():DevicePin{return publicPin(JSON.parse(String(this.#db.prepare('SELECT recipient_json FROM metadata').get()!.recipient_json)));}
 recipient():Readonly<{pin:DevicePin;revision:number}>{return this.fence(()=>Object.freeze({pin:this.recipientUnsafe(),revision:Number(this.#db.prepare('SELECT host_revision FROM metadata').get()!.host_revision)}));}
 private associationHostRevision(value:unknown):number{const revision=counter(value);if(revision>counter(this.#db.prepare('SELECT host_revision FROM metadata').get()!.host_revision))fail('conflict');return revision;}
 association(deviceId:string):Readonly<{revision:number;status:'active'|'revoked';hostRevision:number}>|null{id(deviceId);return this.fence(()=>{const r=this.#db.prepare('SELECT revision,status,host_revision FROM associations WHERE device_id=?').get(deviceId);return r?Object.freeze({revision:Number(r.revision),status:r.status as 'active'|'revoked',hostRevision:this.associationHostRevision(r.host_revision)}):null;});}
 counts():Readonly<{active:number;revoked:number;history:number;pins:number}>{return this.fence(()=>{const n=(sql:string)=>Number(this.#db.prepare(sql).get()!.n);return Object.freeze({active:n("SELECT count(*) AS n FROM associations WHERE status='active'"),revoked:n("SELECT count(*) AS n FROM associations WHERE status='revoked'"),history:n('SELECT count(*) AS n FROM history'),pins:n('SELECT count(*) AS n FROM pins')});});}
 private quota(table:'history'|'pins'|'associations'){if(Number(this.#db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)>=this.#maximum)fail('quota');}
 private addPin(p:DevicePin){this.quota('pins');if(this.#db.prepare('SELECT 1 FROM pins WHERE key_id=? OR signing_key=? OR encryption_key=?').get(p.keyId,p.signingPublicKey,p.encryptionPublicKey))fail('conflict');this.#db.prepare('INSERT INTO pins VALUES(?,?,?,?,?,?)').run(p.deviceId,p.generation,p.keyId,p.signingPublicKey,p.encryptionPublicKey,JSON.stringify(p));}
 enroll(value:unknown):{deviceId:string;revision:number}{
  const x=object(value,['expectedRevision','expectedHostRevision','binding','senderPin']);if(x.expectedRevision!==null)counter(x.expectedRevision);counter(x.expectedHostRevision);const b=binding(x.binding),p=publicPin(x.senderPin);
  const current=this.#bindings.binding(b.deviceId);
  return this.tx(()=>{if(!current||!same(binding(current),b)||b.status!=='active'||b.installationId!==this.#host.hostId||b.ownerId!==this.#host.ownerId)fail('forbidden');
   const host=this.recipientUnsafe(),hostRevision=Number(this.#db.prepare('SELECT host_revision FROM metadata').get()!.host_revision);if(hostRevision!==x.expectedHostRevision||p.deviceId!==b.deviceId||p.deviceId===host.deviceId||p.ownerId!==b.ownerId||p.installationId!==b.installationId)fail('forbidden');
   const row=this.#db.prepare('SELECT * FROM associations WHERE device_id=?').get(b.deviceId);if((row?Number(row.revision):null)!==x.expectedRevision)fail('conflict');
   const latest=this.#db.prepare('SELECT generation FROM pins WHERE device_id=? ORDER BY generation DESC LIMIT 1').get(p.deviceId);if(p.generation!==(latest?next(Number(latest.generation)):1))fail('conflict');
   const revision=row?next(Number(row.revision)):1;if(!row)this.quota('associations');this.quota('history');this.addPin(p);
   const bj=JSON.stringify(b),pj=JSON.stringify(p);this.#db.prepare("INSERT INTO associations VALUES(?,?,'active',?,?,?) ON CONFLICT(device_id) DO UPDATE SET revision=excluded.revision,status='active',binding_json=excluded.binding_json,sender_json=excluded.sender_json,host_revision=excluded.host_revision").run(b.deviceId,revision,bj,pj,hostRevision);
   this.#db.prepare("INSERT INTO history VALUES(?,?,'enroll',?,?,?)").run(b.deviceId,revision,bj,pj,hostRevision);return {deviceId:b.deviceId,revision};
  });
 }
 revoke(deviceId:string,expectedRevision:number):void{id(deviceId);counter(expectedRevision);this.tx(()=>{const r=this.#db.prepare('SELECT * FROM associations WHERE device_id=?').get(deviceId);if(!r||r.revision!==expectedRevision||r.status!=='active')fail('conflict');this.quota('history');const rev=next(expectedRevision);this.#db.prepare("UPDATE associations SET revision=?,status='revoked' WHERE device_id=?").run(rev,deviceId);this.#db.prepare("INSERT INTO history VALUES(?,?,'revoke',?,?,?)").run(deviceId,rev,String(r.binding_json),String(r.sender_json),Number(r.host_revision));});}
 rotateRecipient(value:unknown,expectedRevision:number):number{const p=publicPin(value);counter(expectedRevision);return this.tx(()=>{const old=this.recipientUnsafe(),r=Number(this.#db.prepare('SELECT host_revision FROM metadata').get()!.host_revision);if(r!==expectedRevision||p.installationId!==old.installationId||p.ownerId!==old.ownerId||p.deviceId!==old.deviceId||p.generation!==next(old.generation))fail('conflict');
   const rows=this.#db.prepare('SELECT * FROM associations WHERE status=\'active\'').all();if(Number(this.#db.prepare('SELECT count(*) AS n FROM history').get()!.n)+rows.length>this.#maximum)fail('quota');this.addPin(p);
   const rev=next(r);this.#db.prepare('UPDATE metadata SET recipient_json=?,host_revision=? WHERE id=1').run(JSON.stringify(p),rev);
   for(const a of rows){const ar=next(Number(a.revision));this.#db.prepare("UPDATE associations SET status='revoked',revision=? WHERE device_id=?").run(ar,String(a.device_id));this.#db.prepare("INSERT INTO history VALUES(?,?,'recipient',?,?,?)").run(String(a.device_id),ar,String(a.binding_json),String(a.sender_json),rev);}
   return rows.length;
  });}
 candidate(value:Envelope):RelayPrincipal|null{this.admitted();let e:Envelope;try{e=envelope(value);}catch{return null;}const live=this.#bindings.binding(e.senderId);return this.fence(()=>{if(e.installationId!==this.#host.hostId||e.ownerId!==this.#host.ownerId)return null;const r=this.#db.prepare("SELECT * FROM associations WHERE device_id=? AND status='active'").get(e.senderId);if(!r)return null;
  const b=binding(JSON.parse(String(r.binding_json))),sender=publicPin(JSON.parse(String(r.sender_json))),recipient=this.recipientUnsafe();const p:RelayPrincipal={hostId:b.installationId,ownerId:b.ownerId,canonicalDeviceId:b.deviceId,tlsFingerprint:b.fingerprint,role:b.role,scopes:b.scopes,pinGeneration:b.generation,bindingRevision:b.revision,senderPin:sender,recipientPin:recipient};
  if(r.host_revision!==this.#db.prepare('SELECT host_revision FROM metadata').get()!.host_revision||e.senderGeneration!==sender.generation||e.senderKeyId!==sender.keyId||e.recipientId!==recipient.deviceId||e.recipientGeneration!==recipient.generation||e.recipientKeyId!==recipient.keyId||!this.currentUnsafe(p,live))return null;return Object.freeze(p);
 });}
 private currentUnsafe(p:Readonly<RelayPrincipal>,raw:Readonly<ClientBinding>|null):boolean{if(!raw)return false;const b=binding(raw);const row=this.#db.prepare("SELECT * FROM associations WHERE device_id=? AND status='active'").get(p.canonicalDeviceId);return !!row&&b.status==='active'&&b.installationId===p.hostId&&b.ownerId===p.ownerId&&b.fingerprint===p.tlsFingerprint&&b.generation===p.pinGeneration&&b.revision===p.bindingRevision&&b.role===p.role&&same(b.scopes,[...p.scopes].sort())&&same(b,binding(JSON.parse(String(row.binding_json))))&&same(p.senderPin,publicPin(JSON.parse(String(row.sender_json))))&&same(p.recipientPin,this.recipientUnsafe());}
 isCurrent(p:Readonly<RelayPrincipal>):boolean{this.admitted();try{const live=this.#bindings.binding(p.canonicalDeviceId);return this.fence(()=>this.currentUnsafe(p,live));}catch{return false;}}
 stopAdmission(){this.#stopped=true;}
 close(){if(this.#closed)return;if(this.#closeError)throw this.#closeError;this.stopAdmission();try{this.fence(()=>{this.#db.close();this.#closed=true;OPEN.delete(this.path);});}catch(e){this.#closeError=e;QUARANTINED.set(this.path,this.#db);throw e;}}
}
