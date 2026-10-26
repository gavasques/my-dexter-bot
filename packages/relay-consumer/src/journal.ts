import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AckRequest } from "@dexter/relay";
import { createHash } from "node:crypto";
import { ConsumerError, type HostPort } from "./ports.js";
const OPEN_JOURNALS=new Set<string>();
export const JOURNAL_FILE="relay-consumer.sqlite";
export type JournalState="prepared"|"committed"|"acked"|"blocked"|"unknown";
export interface Entry { deviceId:string;operationId:string;hash:string;threadId:string|null;requestId:string;issuerHash:string;state:JournalState;turnId:string|null }
/** Public projection of one retained, unconfirmed ACK row. IDs/hashes/generations only: no payload, request signature,
 * provider key or native cursor. `recipient` is decoded from the issuer provenance only when it hashes to issuerHash. */
export interface PendingAck { deviceId:string;operationId:string;messageId:string;receiptId:string;issuerHash:string;operationState:JournalState;threadId:string|null;requestId:string;logicalHash:string;turnId:string|null;requestRetained:boolean;recipient:Readonly<{deviceId:string;generation:number;keyId:string;signingPublicKey:string;encryptionPublicKey:string}>|null }
const RECIPIENT_AT=13;
const SCHEMA=`CREATE TABLE metadata(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL CHECK(schema_version=1),host_id TEXT NOT NULL,owner_id TEXT NOT NULL);
CREATE TABLE operations(device_id TEXT NOT NULL,operation_id TEXT NOT NULL,logical_hash TEXT NOT NULL CHECK(length(logical_hash)=64),thread_id TEXT,request_id TEXT NOT NULL,issuer_hash TEXT NOT NULL CHECK(length(issuer_hash)=64),state TEXT NOT NULL CHECK(state IN ('prepared','committed','acked','blocked','unknown')),turn_id TEXT,PRIMARY KEY(device_id,operation_id));
CREATE TABLE issuers(hash TEXT PRIMARY KEY CHECK(length(hash)=64),provenance_json TEXT NOT NULL);
CREATE TABLE acknowledgements(device_id TEXT NOT NULL,operation_id TEXT NOT NULL,message_id TEXT NOT NULL,receipt_id TEXT NOT NULL,issuer_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','acked')),request_json TEXT,PRIMARY KEY(message_id,receipt_id),FOREIGN KEY(device_id,operation_id) REFERENCES operations(device_id,operation_id));
CREATE INDEX operation_states ON operations(state,device_id,operation_id);`;
function schema(db:DatabaseSync):string{return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all());}
const expected=(()=>{const db=new DatabaseSync(":memory:");try{db.exec(SCHEMA);return schema(db);}finally{db.close();}})();
function privatePath(path:string,directory=false):void{
  let info;try{info=lstatSync(path);}catch{throw new ConsumerError("forbidden");}
  if(info.isSymbolicLink()||(directory?!info.isDirectory():!info.isFile())||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw new ConsumerError("forbidden");
}
function entry(row:Record<string,unknown>):Entry{return {deviceId:String(row.device_id),operationId:String(row.operation_id),hash:String(row.logical_hash),threadId:row.thread_id===null?null:String(row.thread_id),requestId:String(row.request_id),issuerHash:String(row.issuer_hash),state:row.state as JournalState,turnId:row.turn_id===null?null:String(row.turn_id)};}
/** Owned auxiliary handle. Every operation runs under the borrowed canonical Host writer; no independent lease. */
export class ConsumerJournal {
  readonly path:string;readonly #db:DatabaseSync;#closed=false;
  /** `existingOnly`: trusted inspection of a restored/retained journal. Never creates the directory or database. */
  constructor(readonly host:HostPort,directory:string,readonly maximum=100000,options:{existingOnly?:boolean}={}){
    if(!Number.isSafeInteger(maximum)||maximum<1||maximum>100000)throw new ConsumerError("invalid_input");
    host.withWriterLease(()=>undefined);
    if(!isAbsolute(directory)||normalize(directory)!==directory)throw new ConsumerError("invalid_input");
    const existing=options.existingOnly===true;
    if(!existsSync(directory)){if(existing)throw new ConsumerError("unavailable");mkdirSync(directory,{recursive:true,mode:0o700});}privatePath(directory,true);if(realpathSync(directory)!==directory)throw new ConsumerError("forbidden");this.path=join(directory,JOURNAL_FILE);this.files();
    if(OPEN_JOURNALS.has(this.path))throw new ConsumerError("host_locked");
    if(existing&&!existsSync(this.path))throw new ConsumerError("unavailable");
    const existed=existsSync(this.path),db=new DatabaseSync(this.path);this.#db=db;OPEN_JOURNALS.add(this.path);
    try{
      chmodSync(this.path,0o600);db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;");
      for(const suffix of ["-wal","-shm"])if(existsSync(this.path+suffix))chmodSync(this.path+suffix,0o600);
      host.withWriterLease(()=>{if(!existed){db.exec("BEGIN IMMEDIATE");try{db.exec(SCHEMA);db.prepare("INSERT INTO metadata VALUES(1,1,?,?)").run(host.hostId,host.ownerId);db.exec("COMMIT");}catch(e){db.exec("ROLLBACK");throw e;}}this.validate();});
      for(const suffix of ["-wal","-shm"])if(existsSync(this.path+suffix))chmodSync(this.path+suffix,0o600);this.files();
    }catch(e){db.close();OPEN_JOURNALS.delete(this.path);if(typeof e==='object'&&e!==null&&'errcode' in e&&Number(e.errcode)===5)throw new ConsumerError('host_locked');throw e;}
  }
  private files():void{privatePath(dirname(this.path),true);for(const suffix of ["","-wal","-shm","-journal"]){const p=this.path+suffix;try{lstatSync(p);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")continue;throw e;}privatePath(p);}}
  private validate():void{if(this.#closed)throw new ConsumerError("unavailable");this.files();if(schema(this.#db)!==expected)throw new ConsumerError("conflict");const rows=this.#db.prepare("SELECT * FROM metadata").all();if(rows.length!==1||rows[0]!.schema_version!==1||rows[0]!.host_id!==this.host.hostId||rows[0]!.owner_id!==this.host.ownerId)throw new ConsumerError("conflict");}
  private fenced<T>(work:()=>T):T{return this.host.withWriterLease(()=>{this.validate();return work();});}
  get(deviceId:string,operationId:string):Entry|null{return this.fenced(()=>{const row=this.#db.prepare("SELECT * FROM operations WHERE device_id=? AND operation_id=?").get(deviceId,operationId);return row?entry(row):null;});}
  prepare(value:Entry,messageId:string,receiptId:string,currentIssuer:string,provenance:string):Entry{
    return this.fenced(()=>{this.#db.exec("BEGIN IMMEDIATE");try{
      const existingIssuer=this.#db.prepare("SELECT provenance_json FROM issuers WHERE hash=?").get(currentIssuer);
      if(existingIssuer&&existingIssuer.provenance_json!==provenance)throw new ConsumerError("conflict");
      if(!existingIssuer){const count=this.#db.prepare("SELECT count(*) AS n FROM issuers").get()!;if(Number(count.n)>=this.maximum)throw new ConsumerError("quota");this.#db.prepare("INSERT INTO issuers VALUES(?,?)").run(currentIssuer,provenance);}
      let row=this.#db.prepare("SELECT * FROM operations WHERE device_id=? AND operation_id=?").get(value.deviceId,value.operationId);
      if(row){if(row.logical_hash!==value.hash||row.request_id!==value.requestId||row.thread_id!==value.threadId)throw new ConsumerError("conflict");}
      else {const count=this.#db.prepare("SELECT count(*) AS n FROM operations").get()!;if(Number(count.n)>=this.maximum)throw new ConsumerError("quota");this.#db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?,?)").run(value.deviceId,value.operationId,value.hash,value.threadId,value.requestId,value.issuerHash,value.state,value.turnId);row=this.#db.prepare("SELECT * FROM operations WHERE device_id=? AND operation_id=?").get(value.deviceId,value.operationId)!;}
      const ack=this.#db.prepare("SELECT * FROM acknowledgements WHERE message_id=? AND receipt_id=?").get(messageId,receiptId);
      if(ack&&(ack.device_id!==value.deviceId||ack.operation_id!==value.operationId))throw new ConsumerError("conflict");
      if(!ack){const count=this.#db.prepare("SELECT count(*) AS n FROM acknowledgements").get()!;if(Number(count.n)>=this.maximum)throw new ConsumerError("quota");this.#db.prepare("INSERT INTO acknowledgements VALUES(?,?,?,?,?,'pending',NULL)").run(value.deviceId,value.operationId,messageId,receiptId,currentIssuer);}
      this.#db.exec("COMMIT");return entry(row);
    }catch(e){this.#db.exec("ROLLBACK");throw e;}});
  }
  state(deviceId:string,operationId:string,state:JournalState,turnId:string|null):void{this.fenced(()=>{const row=this.#db.prepare("SELECT state,turn_id FROM operations WHERE device_id=? AND operation_id=?").get(deviceId,operationId);if(!row)throw new ConsumerError("conflict");if(row.turn_id!==null&&row.turn_id!==turnId)throw new ConsumerError("conflict");if(row.state==="acked"&&state!=="acked")return;if(row.state==="unknown"&&state==="prepared")throw new ConsumerError("conflict");this.#db.prepare("UPDATE operations SET state=?,turn_id=? WHERE device_id=? AND operation_id=?").run(state,turnId,deviceId,operationId);});}
  ackRequest(messageId:string,receiptId:string):AckRequest|null{return this.fenced(()=>{const row=this.#db.prepare("SELECT request_json FROM acknowledgements WHERE message_id=? AND receipt_id=?").get(messageId,receiptId);if(!row)throw new ConsumerError("conflict");return row.request_json===null?null:JSON.parse(String(row.request_json)) as AckRequest;});}
  rememberAck(messageId:string,receiptId:string,request:AckRequest):void{this.fenced(()=>{this.#db.prepare("UPDATE acknowledgements SET request_json=? WHERE message_id=? AND receipt_id=?").run(JSON.stringify(request),messageId,receiptId);});}
  acknowledged(deviceId:string,operationId:string,messageId:string,receiptId:string):void{this.fenced(()=>{const row=this.#db.prepare("SELECT state FROM operations WHERE device_id=? AND operation_id=?").get(deviceId,operationId);if(!row||!['committed','acked'].includes(String(row.state)))throw new ConsumerError("conflict");this.#db.exec("BEGIN IMMEDIATE");try{this.#db.prepare("UPDATE acknowledgements SET state='acked' WHERE message_id=? AND receipt_id=? AND device_id=? AND operation_id=?").run(messageId,receiptId,deviceId,operationId);this.#db.prepare("UPDATE operations SET state='acked' WHERE device_id=? AND operation_id=?").run(deviceId,operationId);this.#db.exec("COMMIT");}catch(e){this.#db.exec("ROLLBACK");throw e;}});}
  private pendingView(row:Record<string,unknown>):PendingAck{
    let recipient:PendingAck["recipient"]=null;
    try{const text=String(row.provenance_json);if(createHash("sha256").update(text).digest("hex")===row.issuer_hash){const p=JSON.parse(text) as unknown[];const at=(i:number)=>p[i];
      if(Array.isArray(p)&&p.length===18&&typeof at(RECIPIENT_AT)==="string"&&Number.isSafeInteger(at(RECIPIENT_AT+1))&&typeof at(RECIPIENT_AT+2)==="string"&&typeof at(RECIPIENT_AT+3)==="string"&&typeof at(RECIPIENT_AT+4)==="string")
        recipient=Object.freeze({deviceId:at(RECIPIENT_AT) as string,generation:at(RECIPIENT_AT+1) as number,keyId:at(RECIPIENT_AT+2) as string,signingPublicKey:at(RECIPIENT_AT+3) as string,encryptionPublicKey:at(RECIPIENT_AT+4) as string});}}catch{recipient=null;}
    return Object.freeze({deviceId:String(row.device_id),operationId:String(row.operation_id),messageId:String(row.message_id),receiptId:String(row.receipt_id),issuerHash:String(row.issuer_hash),operationState:row.state as JournalState,
      threadId:row.thread_id===null?null:String(row.thread_id),requestId:String(row.request_id),logicalHash:String(row.logical_hash),turnId:row.turn_id===null?null:String(row.turn_id),requestRetained:row.request_json!==null,recipient});
  }
  private static PENDING="SELECT a.device_id,a.operation_id,a.message_id,a.receipt_id,a.issuer_hash,a.request_json,o.state,o.thread_id,o.request_id,o.logical_hash,o.turn_id,i.provenance_json FROM acknowledgements a JOIN operations o ON o.device_id=a.device_id AND o.operation_id=a.operation_id LEFT JOIN issuers i ON i.hash=a.issuer_hash WHERE a.state='pending'";
  /** Bounded, ordered page of retained pending ACK rows (message_id, receipt_id order) plus the exact total. */
  pendingAcks(limit:number,after:string|null):{items:PendingAck[];pending:number;truncated:boolean}{
    if(!Number.isSafeInteger(limit)||limit<1||limit>64||(after!==null&&(typeof after!=="string"||after.length<1||after.length>128)))throw new ConsumerError("invalid_input");
    return this.fenced(()=>{const pending=Number(this.#db.prepare("SELECT count(*) AS n FROM acknowledgements WHERE state='pending'").get()!.n);
      const rows=this.#db.prepare(`${ConsumerJournal.PENDING}${after===null?"":" AND a.message_id>?"} ORDER BY a.message_id,a.receipt_id LIMIT ?`).all(...(after===null?[limit+1]:[after,limit+1]));
      return {items:rows.slice(0,limit).map(r=>this.pendingView(r)),pending,truncated:rows.length>limit};});
  }
  /** Every pending row, for bounded summaries (journal maximum quota bounds it). */
  allPendingAcks():PendingAck[]{return this.fenced(()=>this.#db.prepare(`${ConsumerJournal.PENDING} ORDER BY a.message_id,a.receipt_id`).all().map(r=>this.pendingView(r)));}
  pendingAck(messageId:string,receiptId:string):PendingAck|null{return this.fenced(()=>{const r=this.#db.prepare(`${ConsumerJournal.PENDING} AND a.message_id=? AND a.receipt_id=?`).get(messageId,receiptId);return r?this.pendingView(r):null;});}
  counts():Record<JournalState,number>{return this.fenced(()=>{const result={prepared:0,committed:0,acked:0,blocked:0,unknown:0};for(const row of this.#db.prepare("SELECT state,count(*) AS n FROM operations GROUP BY state").all())result[row.state as JournalState]=Number(row.n);return result;});}
  close():void{if(this.#closed)return;this.fenced(()=>{this.#db.close();this.#closed=true;OPEN_JOURNALS.delete(this.path);});}
}
export const digest=(value:unknown):string=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
