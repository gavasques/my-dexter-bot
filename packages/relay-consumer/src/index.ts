import { randomUUID } from "node:crypto";
import { inspect, TextDecoder, types } from "node:util";
import { z } from "zod";
import { IdSchema, StartTurnSchema } from "@dexter/contracts";
import type { AckRequest, Delivery, DevicePin, Envelope } from "@dexter/relay";
import { ConsumerError, RELAY_PRINCIPAL_SCOPES, type CurrentRelayAuthority, type HostPort, type RelayOpener, type RelayPrincipal, type RelayTransport } from "./ports.js";
import { ConsumerJournal, digest, type JournalState, type PendingAck } from "./journal.js";
export * from "./ports.js";
export { JOURNAL_FILE, type PendingAck } from "./journal.js";
/**
 * Disposition of one retained pending ACK. Only `reconcilable` may be acknowledged, and only by an explicit owner call
 * with the CURRENT recipient custody. `obsolete_recipient_generation` is terminal: recipient generations are monotonic
 * and persisted (associations metadata + issuer provenance), so such a receipt can never be ACKed by this host again.
 * `effect_unconfirmed`/`proof_missing`/`provenance_unverifiable` are never ACKed (no fabricated success);
 * `requires_custody` is the same-generation row seen without custody (recovery/inspection).
 */
export type AckDisposition="reconcilable"|"requires_custody"|"obsolete_recipient_generation"|"effect_unconfirmed"|"proof_missing"|"provenance_unverifiable";
export type PendingAckView=PendingAck&{disposition:AckDisposition};
export interface PendingAckPage {items:PendingAckView[];pending:number;truncated:boolean}
export type AckReconcileStatus="acked"|"unknown"|Exclude<AckDisposition,"reconcilable"|"requires_custody">;
export interface AckReconcileInput {deviceId:string;operationId:string;messageId:string;receiptId:string;issuerHash:string}
export const ACK_DISPOSITIONS:readonly AckDisposition[]=Object.freeze(["reconcilable","requires_custody","obsolete_recipient_generation","effect_unconfirmed","proof_missing","provenance_unverifiable"]);
const RECEIPT=/^[A-Za-z0-9_-]{1,80}$/;const HEX=/^[0-9a-f]{64}$/;
/** Recipient/effect/canonical-turn proof for one retained row; pure apart from read-only Host lookups. */
export function classifyPendingAck(row:Readonly<PendingAck>,recipient:Readonly<DevicePin>,host:Pick<HostPort,"findTurn"|"sourceHash">,custody:boolean):AckDisposition{
  const r=row.recipient;if(!r||r.deviceId!==recipient.deviceId||r.generation>recipient.generation)return "provenance_unverifiable";
  if(r.generation<recipient.generation)return "obsolete_recipient_generation";
  if(r.keyId!==recipient.keyId||r.signingPublicKey!==recipient.signingPublicKey||r.encryptionPublicKey!==recipient.encryptionPublicKey)return "provenance_unverifiable";
  if(row.operationState!=="committed"&&row.operationState!=="acked")return "effect_unconfirmed";
  if(row.threadId!==null){try{const t=row.turnId===null?null:host.findTurn(row.threadId,row.requestId);if(!t||t.id!==row.turnId||t.threadId!==row.threadId||t.clientRequestId!==row.requestId||host.sourceHash(t.id)!==row.logicalHash)return "proof_missing";}catch{return "proof_missing";}}
  else if(row.turnId!==null)return "proof_missing";
  return custody?"reconcilable":"requires_custody";
}
function pageInput(value:unknown):{limit:number;after:string|null}{
  if(!value||typeof value!=="object"||types.isProxy(value)||Object.keys(value).some(k=>k!=="limit"&&k!=="after"))throw new ConsumerError("invalid_input");
  const v=value as {limit?:unknown;after?:unknown};if(typeof v.limit!=="number"||!Number.isSafeInteger(v.limit)||v.limit<1||v.limit>64||(v.after!==undefined&&(typeof v.after!=="string"||!ID.test(v.after))))throw new ConsumerError("invalid_input");
  return {limit:v.limit,after:(v.after as string|undefined)??null};
}
function reconcileInput(value:unknown):AckReconcileInput{
  const keys=["deviceId","operationId","messageId","receiptId","issuerHash"];
  if(!value||typeof value!=="object"||types.isProxy(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(k=>!keys.includes(k)))throw new ConsumerError("invalid_input");
  const v=value as Record<string,unknown>;
  if(!keys.slice(0,3).every(k=>typeof v[k]==="string"&&ID.test(v[k] as string))||typeof v.receiptId!=="string"||!RECEIPT.test(v.receiptId)||typeof v.issuerHash!=="string"||!HEX.test(v.issuerHash))throw new ConsumerError("invalid_input");
  return {deviceId:v.deviceId as string,operationId:v.operationId as string,messageId:v.messageId as string,receiptId:v.receiptId,issuerHash:v.issuerHash};
}
/**
 * Trusted read-only inspection of an EXISTING retained journal without custody, opener, transport or wake (recovery /
 * pre-cut reporting). Never bootstraps; exclusive with a live RelayConsumer on the same file; closes before return.
 */
export function inspectPendingAcks(host:HostPort,directory:string,recipient:Readonly<DevicePin>,input:{limit:number;after?:string}|"all"):PendingAckPage{
  const journal=new ConsumerJournal(host,directory,100000,{existingOnly:true});
  try{
    if(input==="all"){const rows=journal.allPendingAcks();return {items:rows.map(r=>Object.freeze({...r,disposition:classifyPendingAck(r,recipient,host,false)})),pending:rows.length,truncated:false};}
    const page=pageInput(input),out=journal.pendingAcks(page.limit,page.after);
    return {...out,items:out.items.map(r=>Object.freeze({...r,disposition:classifyPendingAck(r,recipient,host,false)}))};
  }finally{journal.close();}
}
/** Public per-disposition counts only. */
export function summarizePendingAcks(page:PendingAckPage):Record<AckDisposition|"pending",number>{
  const out={pending:page.pending,reconcilable:0,requires_custody:0,obsolete_recipient_generation:0,effect_unconfirmed:0,proof_missing:0,provenance_unverifiable:0};
  for(const item of page.items)out[item.disposition]++;return out;
}
const Turn=z.strictObject({version:z.literal(1),operation:z.literal("turn.submit"),operationId:IdSchema,threadId:IdSchema,content:StartTurnSchema.shape.content});
const Notice=z.strictObject({version:z.literal(1),operation:z.literal("notice.received"),operationId:IdSchema,noticeId:IdSchema});
const Plain=z.discriminatedUnion("operation",[Turn,Notice]);
const ID=/^[A-Za-z0-9_-]{1,128}$/;const FP=/^[0-9a-f]{64}$/;
export interface RelayConsumerOptions { host:HostPort;directory:string;transport:RelayTransport;opener:RelayOpener;authority:CurrentRelayAuthority;transportOwnership?:"borrowed"|"owned";maximumOperations?:number;dispatchMs?:number;clock?:()=>number;maximumPendingPerRecipient?:number }
export interface WakeReport { delivered:number;accepted:number;replayed:number;inert:number;acked:number;blocked:number;unknown:number }
export interface RelayConsumerStatus { admission:"open"|"stopped";inFlight:0|1;closed:boolean;lastOutcome:"idle"|"completed"|"unavailable";counts:Record<JournalState,number> }
const equalPin=(a:RelayPrincipal["senderPin"],b:RelayPrincipal["senderPin"])=>digest([a.ownerId,a.installationId,a.deviceId,a.generation,a.keyId,a.signingPublicKey,a.encryptionPublicKey])===digest([b.ownerId,b.installationId,b.deviceId,b.generation,b.keyId,b.signingPublicKey,b.encryptionPublicKey]);
function deliverySnapshot(value:Delivery):Delivery {
  const check=(object:unknown,depth=0):void=>{
    if(typeof object!=='object'||object===null)return;
    if(types.isProxy(object)||Array.isArray(object)||Object.getPrototypeOf(object)!==Object.prototype||depth>1)throw new ConsumerError('invalid_input');
    const descriptors=Object.getOwnPropertyDescriptors(object),keys=Reflect.ownKeys(descriptors);if(keys.length>24)throw new ConsumerError('invalid_input');
    for(const key of keys){if(typeof key!=='string'||!descriptors[key]!.enumerable||!('value' in descriptors[key]!))throw new ConsumerError('invalid_input');check(descriptors[key]!.value,depth+1);}
  };
  check(value);const out=structuredClone(value);
  if(Object.keys(out).length!==3||!Object.hasOwn(out,'envelope')||!Object.hasOwn(out,'cursor')||!Object.hasOwn(out,'receiptId')||!Number.isSafeInteger(out.cursor)||out.cursor<1||typeof out.receiptId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(out.receiptId)||!out.envelope)throw new ConsumerError('invalid_input');
  Object.freeze(out.envelope);return Object.freeze(out);
}
/** Host-only explicit bounded acceptance. No background polling, remote admin, resume, action dispatch or automatic retries. */
export class RelayConsumer {
  readonly #host:HostPort;readonly #journal:ConsumerJournal;readonly #transport:RelayTransport;readonly #opener:RelayOpener;readonly #authority:CurrentRelayAuthority;readonly #owned:boolean;readonly #clock:()=>number;
  readonly #dispatchMs:number;readonly #maximumPages:number;readonly #hostId:string;readonly #ownerId:string;readonly #recipient:DevicePin;
  #after=0;#pages=0;
  #expired=false;#stopped=false;#closed=false;#used=false;#flight:Promise<unknown>|null=null;#wake:Promise<WakeReport>|null=null;#closing:Promise<void>|null=null;#transportClose:Promise<void>|null=null;#disposeFailure:{error:unknown}|null=null;
  #last:RelayConsumerStatus["lastOutcome"]="idle";#counts:Record<JournalState,number>={prepared:0,committed:0,acked:0,blocked:0,unknown:0};
  constructor(options:RelayConsumerOptions){
    if(Object.keys(options).some(k=>!['host','directory','transport','opener','authority','transportOwnership','maximumOperations','dispatchMs','clock','maximumPendingPerRecipient'].includes(k))||!options.host||!options.transport||!options.opener||!options.authority||!['borrowed','owned'].includes(options.transportOwnership??'borrowed'))throw new ConsumerError("invalid_input");
    for(const [port,names] of [[options.host,['withWriterLease','startTurn','findTurn','turnInput','sourceHash','checkThread']],[options.transport,['poll','ack','close']],[options.opener,['open','poll','ack']],[options.authority,['candidate','isCurrent']]] as const)for(const name of names)if(typeof (port as unknown as Record<string,unknown>)[name]!=="function")throw new ConsumerError('invalid_input');
    // Trusted relay deployment capacity, never taken from a delivery/body. Match the producer's
    // configured recipient bound; finite sweep revisits denied entries without starving later ones.
    const capacity=options.maximumPendingPerRecipient===undefined?128:options.maximumPendingPerRecipient;
    if(!Number.isSafeInteger(capacity)||capacity<1||capacity>4096)throw new ConsumerError("invalid_input");
    this.#maximumPages=Math.ceil(capacity/10);
    this.#dispatchMs=options.dispatchMs??10000;if(!Number.isSafeInteger(this.#dispatchMs)||this.#dispatchMs<10||this.#dispatchMs>60000)throw new ConsumerError("invalid_input");
    this.#host=options.host;this.#hostId=options.host.hostId;this.#ownerId=options.host.ownerId;this.#transport=options.transport;this.#opener=options.opener;this.#authority=options.authority;this.#owned=options.transportOwnership==='owned';this.#clock=options.clock??Date.now;
    if(!ID.test(this.#hostId)||!ID.test(this.#ownerId)||typeof this.#host.sourceHash!=="function")throw new ConsumerError("invalid_input");
    const pin=structuredClone(this.#opener.publicPin);if(pin.installationId!==this.#hostId||pin.ownerId!==this.#ownerId)throw new ConsumerError("forbidden");this.#recipient=Object.freeze(pin);this.fence();
    // Last fallible construction step. No ownership transfer of transport on constructor failure.
    this.#journal=new ConsumerJournal(this.#host,options.directory,options.maximumOperations);
  }
  private fence():void{this.#host.withWriterLease(()=>{if(this.#host.hostId!==this.#hostId||this.#host.ownerId!==this.#ownerId||!equalPin(this.#recipient,this.#opener.publicPin))throw new ConsumerError("host_locked");});}
  private admit():void{if(this.#stopped)throw new ConsumerError("unavailable");this.fence();}
  private async current(principal:Readonly<RelayPrincipal>):Promise<void>{this.admit();if(!await this.#authority.isCurrent(principal))throw new ConsumerError("forbidden");this.admit();}
  private principal(value:RelayPrincipal,envelope:Envelope):Readonly<RelayPrincipal>{
    const p=structuredClone(value);const sender=p.senderPin,recipient=p.recipientPin;
    if(p.hostId!==this.#hostId||p.ownerId!==this.#ownerId||!ID.test(p.canonicalDeviceId)||!FP.test(p.tlsFingerprint)||!['client-ios','client-mac'].includes(p.role)||!Array.isArray(p.scopes)||p.scopes.length>RELAY_PRINCIPAL_SCOPES.length||new Set(p.scopes).size!==p.scopes.length||!p.scopes.every(s=>typeof s==='string'&&(RELAY_PRINCIPAL_SCOPES as readonly string[]).includes(s))||!Number.isSafeInteger(p.pinGeneration)||p.pinGeneration<1||!Number.isSafeInteger(p.bindingRevision)||p.bindingRevision<1)throw new ConsumerError("forbidden");
    if(envelope.installationId!==p.hostId||envelope.ownerId!==p.ownerId||sender.installationId!==p.hostId||sender.ownerId!==p.ownerId||sender.deviceId!==envelope.senderId||sender.generation!==envelope.senderGeneration||sender.keyId!==envelope.senderKeyId||recipient.deviceId!==envelope.recipientId||recipient.generation!==envelope.recipientGeneration||recipient.keyId!==envelope.recipientKeyId||!equalPin(recipient,this.#opener.publicPin))throw new ConsumerError("forbidden");
    Object.freeze(p.scopes);Object.freeze(p.senderPin);Object.freeze(p.recipientPin);return Object.freeze(p);
  }
  private provenance(p:Readonly<RelayPrincipal>):unknown[]{return [p.hostId,p.ownerId,p.canonicalDeviceId,p.tlsFingerprint,p.role,[...p.scopes].sort(),p.pinGeneration,p.bindingRevision,p.senderPin.deviceId,p.senderPin.generation,p.senderPin.keyId,p.senderPin.signingPublicKey,p.senderPin.encryptionPublicKey,p.recipientPin.deviceId,p.recipientPin.generation,p.recipientPin.keyId,p.recipientPin.signingPublicKey,p.recipientPin.encryptionPublicKey];}
  wake():Promise<WakeReport>{
    this.#used=true;if(arguments.length!==0)return Promise.reject(new ConsumerError("invalid_input"));try{this.admit();}catch(e){return Promise.reject(e);}if(this.#wake)return this.#wake;
    // One raw flight at a time: an explicit ACK reconciliation in progress refuses a concurrent wake (no overlap).
    if(this.#flight)return Promise.reject(new ConsumerError("conflict"));
    // Absolute dispatch deadline bounds caller latency. The raw flight remains owned until it drains;
    // a stalled trusted port cannot release journal/Host custody or cause a second dispatch.
    let timer:ReturnType<typeof setTimeout>;
    const expired=new Promise<WakeReport>((_,reject)=>{timer=setTimeout(()=>{this.#expired=true;this.stopAdmission();this.#last='unavailable';reject(new ConsumerError('unavailable'));},this.#dispatchMs);});
    const flight=this.pass().then(report=>{this.#last='completed';return report;},e=>{this.#last='unavailable';throw e;}).finally(()=>{clearTimeout(timer);if(this.#flight===flight)this.#flight=null;});this.#flight=flight;
    const waking=Promise.race([flight,expired]).finally(()=>{if(this.#wake===waking)this.#wake=null;});this.#wake=waking;return waking;
  }
  private now():number{const now=this.#clock();if(!Number.isSafeInteger(now)||now<1)throw new ConsumerError("invalid_input");return now;}
  private async pass():Promise<WakeReport>{
    // Ephemeral bounded sweep: revisit even recoverable denied input; never journal a skip cursor.
    // The finite sweep derives from trusted recipient capacity; reset even under endless arrivals.
    const after=this.#after;
    this.admit();const poll=await this.#opener.poll({requestId:randomUUID(),issuedAt:this.now(),after,limit:10});this.admit();
    const out=await this.#transport.poll(poll);this.admit();if(!Array.isArray(out.deliveries)||out.deliveries.length>10||!Number.isSafeInteger(out.cursor)||out.cursor<after)throw new ConsumerError("invalid_input");
    // Freeze every delivery before the first authority await. Even denied payloads need ordered own-data cursors.
    let previous=after;
    const page=out.deliveries.map(value=>{
      if(types.isProxy(value)||typeof value!=='object'||value===null)throw new ConsumerError('invalid_input');
      const descriptor=Object.getOwnPropertyDescriptor(value,'cursor');
      if(!descriptor||!('value' in descriptor)||!Number.isSafeInteger(descriptor.value)||descriptor.value<=previous)throw new ConsumerError('invalid_input');
      previous=descriptor.value as number;
      try{return deliverySnapshot(value);}catch{return null;}
    });
    if(out.cursor!==previous)throw new ConsumerError('invalid_input');
    const report:WakeReport={delivered:page.length,accepted:0,replayed:0,inert:0,acked:0,blocked:0,unknown:0};
    for(const delivery of page){this.admit();try{if(!delivery)throw new ConsumerError('invalid_input');await this.consume(delivery,report);}catch(e){if(e instanceof ConsumerError&&e.code==='unknown')report.unknown++;else report.blocked++;}this.fence();}
    // Only a fully processed page advances. Errors/deadlines retain custody and cannot persist a skip.
    this.#pages++;
    if(page.length<10||this.#pages>=this.#maximumPages){this.#after=0;this.#pages=0;}else this.#after=out.cursor;
    if(this.#expired)throw new ConsumerError("unavailable");this.#counts=this.#journal.counts();return report;
  }
  private async consume(delivery:Delivery,report:WakeReport):Promise<void>{
    delivery=deliverySnapshot(delivery);const e=delivery.envelope;const candidate=await this.#authority.candidate(e);this.admit();if(!candidate)throw new ConsumerError("forbidden");const principal=this.principal(candidate,e);await this.current(principal);
    const bytes=await this.#opener.open(e,principal.senderPin);this.admit();await this.current(principal);if(!(bytes instanceof Uint8Array)||bytes.length>32768)throw new ConsumerError("invalid_input");
    let input:z.infer<typeof Plain>;try{input=Plain.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)));}catch{throw new ConsumerError("invalid_input");}
    if(input.operation==='turn.submit'?(e.type!=='command'||!principal.scopes.includes('chat.write')):!['event','receipt'].includes(e.type))throw new ConsumerError("forbidden");
    const logical=input.operation==='turn.submit'?[input.version,input.operation,input.operationId,input.threadId,input.content]:[input.version,input.operation,input.operationId,input.noticeId];
    const hash=digest([this.#hostId,this.#ownerId,principal.canonicalDeviceId,...logical]);const requestId='rly_'+digest([this.#hostId,principal.canonicalDeviceId,input.operationId]);const provenance=this.provenance(principal);const issuer=digest(provenance);
    await this.current(principal);if(input.operation==='turn.submit'){this.#host.checkThread(input.threadId);this.fence();}
    let entry=this.#journal.prepare({deviceId:principal.canonicalDeviceId,operationId:input.operationId,hash,threadId:input.operation==='turn.submit'?input.threadId:null,requestId,issuerHash:issuer,state:'prepared',turnId:null},e.messageId,delivery.receiptId,issuer,JSON.stringify(provenance));
    if(input.operation==='notice.received'){
      if(entry.state==='prepared'||entry.state==='blocked'){this.#journal.state(entry.deviceId,entry.operationId,'committed',null);report.inert++;entry=this.#journal.get(entry.deviceId,entry.operationId)!;}
    }else{
      await this.current(principal);this.#host.checkThread(input.threadId);this.fence();
      let canonical=this.#host.findTurn(input.threadId,requestId);
      if(!canonical){
        if(entry.state==='unknown'||entry.state==='committed'||entry.state==='acked')throw new ConsumerError('unknown');
        try {canonical=this.#host.startTurn(input.threadId,{clientRequestId:requestId,content:input.content},hash);report.accepted++;}
        catch(error){
          this.fence();const recorded=this.#host.findTurn(input.threadId,requestId);
          const code=typeof error==='object'&&error!==null&&'code' in error?error.code:null;
          const blocked=!recorded&&['conflict','unavailable','host_locked'].includes(String(code));
          this.#journal.state(entry.deviceId,entry.operationId,blocked?'blocked':'unknown',entry.turnId);throw new ConsumerError(blocked?'unavailable':'unknown');
        }
      }else report.replayed++;
      this.fence();const confirmed=this.#host.findTurn(input.threadId,requestId);
      if(!confirmed||confirmed.id!==canonical.id||confirmed.threadId!==input.threadId||confirmed.clientRequestId!==requestId||this.#host.turnInput(confirmed.id)!==input.content||this.#host.sourceHash(confirmed.id)!==hash)throw new ConsumerError('conflict');
      await this.current(principal);this.#journal.state(entry.deviceId,entry.operationId,'committed',confirmed.id);entry=this.#journal.get(entry.deviceId,entry.operationId)!;
    }
    if(!['committed','acked'].includes(entry.state))throw new ConsumerError('unknown');
    await this.current(principal);const retained=this.#journal.ackRequest(e.messageId,delivery.receiptId),pin=this.#opener.publicPin;
    const now=this.now();const reusable=retained&&Math.abs(now-retained.issuedAt)<=30000&&retained.deviceId===pin.deviceId&&retained.generation===pin.generation&&retained.keyId===pin.keyId;
    const ack:AckRequest=reusable?retained:await this.#opener.ack({requestId:randomUUID(),issuedAt:now,messages:[{messageId:e.messageId,receiptId:delivery.receiptId}]});
    if(ack.kind!=='ack'||ack.installationId!==this.#hostId||ack.ownerId!==this.#ownerId||ack.deviceId!==pin.deviceId||ack.generation!==pin.generation||ack.keyId!==pin.keyId||ack.messages.length!==1||ack.messages[0]!.messageId!==e.messageId||ack.messages[0]!.receiptId!==delivery.receiptId)throw new ConsumerError('forbidden');
    await this.current(principal);this.#journal.rememberAck(e.messageId,delivery.receiptId,ack);
    await this.current(principal);this.fence();
    try {await this.#transport.ack(ack);}catch {throw new ConsumerError('unknown');}
    // ACK response is not an engine result. Current writer/principal is still required to publish a local receipt.
    await this.current(principal);this.#journal.acknowledged(entry.deviceId,entry.operationId,e.messageId,delivery.receiptId);report.acked++;
  }
  /** Bounded public page of retained pending ACK rows, classified against this consumer's CURRENT recipient pin. */
  pendingAcks(input:{limit:number;after?:string}):PendingAckPage{
    this.admit();const page=pageInput(input),out=this.#journal.pendingAcks(page.limit,page.after);
    return {...out,items:out.items.map(r=>Object.freeze({...r,disposition:classifyPendingAck(r,this.#opener.publicPin,this.#host,true)}))};
  }
  /**
   * Explicit owner reconciliation of ONE retained pending ACK (e.g. pre-cut at the source while the old custody is
   * still current). Requires the exact public row identity incl. issuer hash, a confirmed canonical effect (committed/acked
   * plus the canonical turn with the same source hash) and the CURRENT recipient generation/keys. Signs a FRESH ACK with
   * the current custody and publishes `acked` only after the relay confirmed it, under a final synchronous writer fence.
   * Transport loss/ambiguity leaves the row pending and returns `unknown` (never retried automatically). Never dispatches,
   * resumes, redelivers or starts a turn; never runs concurrently with a wake (same single raw flight, drained by close).
   */
  reconcileAck(value:AckReconcileInput):Promise<{status:AckReconcileStatus}>{
    this.#used=true;let input:AckReconcileInput;try{input=reconcileInput(value);this.admit();}catch(e){return Promise.reject(e);}
    if(this.#flight)return Promise.reject(new ConsumerError("conflict"));
    let timer:ReturnType<typeof setTimeout>;let sent=false;
    const expired=new Promise<{status:AckReconcileStatus}>((_,reject)=>{timer=setTimeout(()=>{this.#expired=true;this.stopAdmission();this.#last='unavailable';reject(new ConsumerError(sent?'unknown':'unavailable'));},this.#dispatchMs);});
    const flight=(async():Promise<{status:AckReconcileStatus}>=>{
      const row=this.#journal.pendingAck(input.messageId,input.receiptId);
      if(!row||row.deviceId!==input.deviceId||row.operationId!==input.operationId||row.issuerHash!==input.issuerHash)throw new ConsumerError("conflict");
      const disposition=classifyPendingAck(row,this.#opener.publicPin,this.#host,true);
      if(disposition!=="reconcilable")return {status:disposition as AckReconcileStatus};
      const pin=this.#opener.publicPin,retained=this.#journal.ackRequest(input.messageId,input.receiptId);
      if(retained&&(retained.kind!=='ack'||retained.deviceId!==pin.deviceId||retained.generation!==pin.generation||retained.keyId!==pin.keyId||retained.messages.length!==1||retained.messages[0]!.messageId!==input.messageId||retained.messages[0]!.receiptId!==input.receiptId))throw new ConsumerError("conflict");
      this.admit();const ack=await this.#opener.ack({requestId:randomUUID(),issuedAt:this.now(),messages:[{messageId:input.messageId,receiptId:input.receiptId}]});this.admit();
      if(ack.kind!=='ack'||ack.installationId!==this.#hostId||ack.ownerId!==this.#ownerId||ack.deviceId!==pin.deviceId||ack.generation!==pin.generation||ack.keyId!==pin.keyId||ack.messages.length!==1||ack.messages[0]!.messageId!==input.messageId||ack.messages[0]!.receiptId!==input.receiptId)throw new ConsumerError('forbidden');
      const again=this.#journal.pendingAck(input.messageId,input.receiptId);if(!again||again.issuerHash!==input.issuerHash||classifyPendingAck(again,pin,this.#host,true)!=="reconcilable")throw new ConsumerError("conflict");
      this.#journal.rememberAck(input.messageId,input.receiptId,ack);this.admit();
      sent=true;try{await this.#transport.ack(ack);}catch{return {status:"unknown"};}
      // Final synchronous admission + writer fence after the last await, immediately before the local publication.
      try{this.admit();this.#journal.acknowledged(input.deviceId,input.operationId,input.messageId,input.receiptId);}catch{return {status:"unknown"};}
      return {status:"acked"};
    })().finally(()=>{clearTimeout(timer);if(this.#flight===flight)this.#flight=null;});
    this.#flight=flight;void flight.catch(()=>undefined);
    return Promise.race([flight,expired]).then(out=>{this.#last='completed';return out;});
  }
  stopAdmission():void{this.#stopped=true;}
  close():Promise<void>{
    this.stopAdmission();if(this.#closing)return this.#closing;
    if(this.#owned){try{const drain=this.#transport.close();if(!drain||typeof drain.then!=='function')throw new ConsumerError('unavailable');this.#transportClose=Promise.resolve(drain);}catch(e){this.#transportClose=Promise.reject(e);}this.#transportClose.catch(()=>undefined);}
    this.#closing=(async()=>{if(this.#flight)await Promise.allSettled([this.#flight]);if(this.#transportClose)await this.#transportClose;this.fence();this.#journal.close();this.fence();this.#closed=true;})();this.#closing.catch(()=>undefined);return this.#closing;
  }
  disposeUnstarted():void{
    if(this.#closed)return;if(this.#disposeFailure)throw this.#disposeFailure.error;if(this.#used||this.#flight||this.#closing||this.#owned)throw new ConsumerError('conflict');this.stopAdmission();
    try{this.fence();this.#journal.close();this.fence();this.#closed=true;this.#closing=Promise.resolve();}catch(e){this.#disposeFailure={error:e};this.#closing=Promise.reject(e);this.#closing.catch(()=>undefined);throw e;}
  }
  status():RelayConsumerStatus{return {admission:this.#stopped?'stopped':'open',inFlight:this.#flight?1:0,closed:this.#closed,lastOutcome:this.#last,counts:{...this.#counts}};}
  toJSON():RelayConsumerStatus{return this.status();}[inspect.custom]():RelayConsumerStatus{return this.status();}
}
