import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, type HostStore, type BotDocuments, type SetBotDocuments } from '@dexter/hub';
import { MemorySourceSchema, SetBotDocumentsSchema, RestoreBotMemorySchema, AppendBotMemoryNoteSchema,
  type MemorySource, type BotMemoryHistory, type BotMemoryVersion, type DocumentMutationReceipt, type RestoreBotMemory } from '@dexter/contracts';
import { ContextError, id } from './types.js';
import { ContextRepository, sha256 } from './repository.js';
import { appendLiteralMemoryNote } from './memory-notes.js';

/** Context schema 2: exact revision registry and effect receipt share the head transaction. */
export const BOT_DOCUMENT_HISTORY_SQL = `
CREATE TABLE bot_document_revisions (bot_id TEXT NOT NULL, revision INTEGER NOT NULL,
  soul_pin_json TEXT NOT NULL, user_pin_json TEXT NOT NULL, memory_pin_json TEXT NOT NULL,
  memory_source_json TEXT NOT NULL, restored_from INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY(bot_id, revision));
CREATE TABLE bot_document_receipts (bot_id TEXT NOT NULL, operation_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  input_json TEXT NOT NULL, operation TEXT NOT NULL, origin_json TEXT NOT NULL, revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY(bot_id, operation_key));
`;
type Row = Record<string, unknown>;
const legacy: MemorySource = {kind:'legacy_unknown',reference:null};
const secret = (value: string): boolean => /(?:\b(?:sk-|sk_live_|sk_test_|github_pat_|gh[pousr]_|xox[abprs]-|glpat-|AIza|AKIA|ASIA|ya29\.)[A-Za-z0-9_+=./-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|passphrase)\s*[:=]\s*["']?(?:Bearer\s+)?[A-Za-z0-9_+=./-]{12,})/i.test(value);
const body = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 8192 || !value.isWellFormed() || secret(value)) throw new ContextError('invalid_input');
  return value;
};
const number = (value: unknown, minimum=1): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER) throw new ContextError('invalid_input');
  return value;
};
const parse = <T>(fn: () => T): T => {try {return fn();} catch {throw new ContextError('invalid_input');}};
const canonical = (value: unknown): string => canonicalJson(JSON.parse(JSON.stringify(value)));
const source = (value: unknown): MemorySource => parse(() => MemorySourceSchema.parse(value));
export class BotDocumentStore {
  constructor(private db: DatabaseSync, private repository: ContextRepository, private store: HostStore,
    private write: <T>(fn: () => T) => T) {}
  private one(sql: string, ...args: Array<string|number>): Row|undefined {return this.db.prepare(sql).get(...args) as Row|undefined;}
  private own(botId: string): string {
    const key=id(botId); if(this.store.getBot(key).ownerId!==this.store.ownerId)throw new ContextError('forbidden');return key;
  }
  private pin(botId: string, revision: number, name: string, raw: unknown): {path:string;sha256:string;commit:string} {
    try {
      if(typeof raw!=='string'||raw.length>512)throw 0;
      const value=JSON.parse(raw),prefix=`memory/${botId}/${name}-r${revision}-`;
      if(!value||Object.keys(value).sort().join(',')!=='commit,path,sha256'||typeof value.path!=='string'||!value.path.startsWith(prefix)
        ||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.md$/.test(value.path.slice(prefix.length))
        ||typeof value.sha256!=='string'||!/^[0-9a-f]{64}$/.test(value.sha256)||typeof value.commit!=='string'||!/^[0-9a-f]{40,64}$/.test(value.commit))throw 0;
      return value;
    }catch{throw new ContextError('tampered');}
  }
  private snapshot(botId: string, row: Row): BotDocuments {
    try {
      const revision=number(row.revision),updatedAt=number(row.updated_at,0);
      const memoryPin=this.pin(botId,revision,'MEMORY',row.memory_pin_json);
      const memorySource=source(JSON.parse(row.memory_source_json as string));
      const restoredFrom=row.restored_from===null?null:number(row.restored_from);
      if(restoredFrom!==null&&(restoredFrom>=revision||!this.one('SELECT revision FROM bot_document_revisions WHERE bot_id=? AND revision=?',botId,restoredFrom)))throw 0;
      // Existing legacy data remains readable; rejection of newly supplied secrets happens only on mutations.
      const read=(name:string,raw:unknown):string=>{const text=this.repository.read(this.pin(botId,revision,name,raw));if(text.length>8192||!text.isWellFormed())throw 0;return text;};
      return {botId,revision,soul:read('SOUL',row.soul_pin_json),user:read('USER',row.user_pin_json),memory:read('MEMORY',row.memory_pin_json),updatedAt,
        memoryHead:{botId,revision,pin:memoryPin,source:memorySource,restoredFrom,updatedAt}};
    }catch{throw new ContextError('tampered');}
  }
  private revisionRow(botId: string, revision: number): Row {
    const row=this.one('SELECT * FROM bot_document_revisions WHERE bot_id=? AND revision=?',botId,number(revision));
    if(!row)throw new ContextError('not_found');return row;
  }
  read(botId: string): BotDocuments {
    const key=this.own(botId),head=this.one('SELECT * FROM bot_documents WHERE bot_id=?',key);
    if(!head)return {botId:key,revision:0,soul:'',user:'',memory:'',updatedAt:null,memoryHead:null};
    const row=this.revisionRow(key,number(head.revision));
    for(const field of ['soul_pin_json','user_pin_json','memory_pin_json','updated_at'])if(head[field]!==row[field])throw new ContextError('tampered');
    return this.snapshot(key,row);
  }
  history(botId: string, query: {limit?:number;before?:string}={}): BotMemoryHistory {
    const key=this.own(botId);
    if(!query||Object.keys(query).some(k=>!['limit','before'].includes(k)))throw new ContextError('invalid_input');
    const limit=query.limit??20;
    if(!Number.isInteger(limit)||limit<1||limit>50)throw new ContextError('invalid_input');
    let before=Number.MAX_SAFE_INTEGER;
    if(query.before!==undefined){if(typeof query.before!=='string'||!/^r[1-9][0-9]{0,15}$/.test(query.before))throw new ContextError('invalid_input');before=number(Number(query.before.slice(1)));this.revisionRow(key,before);}
    const rows=this.db.prepare('SELECT * FROM bot_document_revisions WHERE bot_id=? AND revision<? ORDER BY revision DESC LIMIT ?').all(key,before,limit+1) as Row[];
    const items=rows.slice(0,limit).map(row=>this.snapshot(key,row).memoryHead!);
    return {items,nextCursor:rows.length>limit?`r${items.at(-1)!.revision}`:null};
  }
  readRevision(botId:string,revision:number): BotMemoryVersion {
    const key=this.own(botId),value=this.snapshot(key,this.revisionRow(key,revision));return {...value.memoryHead!,markdown:value.memory};
  }
  receipt(botId:string,key:string,threadId?:string): BotDocuments|null {
    const bot=this.own(botId);
    if(typeof key!=='string'||!/^(owner|action):[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(key))throw new ContextError('invalid_input');
    const row=this.one('SELECT * FROM bot_document_receipts WHERE bot_id=? AND operation_key=?',bot,key);
    if(!row)return null;
    try {
      const origin=source(JSON.parse(row.origin_json as string));
      if(threadId!==undefined&&(origin.kind!=='harness_action'||origin.threadId!==threadId))throw new ContextError('forbidden');
      if(typeof row.input_json!=='string'||sha256(row.input_json)!==row.request_hash||!['update','restore','append'].includes(row.operation as string))throw 0;
      const value=this.snapshot(bot,this.revisionRow(bot,number(row.revision)));
      const receipt:DocumentMutationReceipt={botId:bot,operationKey:key,requestHash:row.request_hash as string,operation:row.operation as DocumentMutationReceipt['operation'],revision:value.revision,source:origin,committedAt:number(row.created_at,0)};
      if(origin.kind==='harness_action'){
        const action=this.store.getAction(origin.actionId),bound=this.store.toolActionOrigin(action.id);
        if(action.request.botId!==bot || action.request.threadId!==origin.threadId || action.decidedBy!==this.store.ownerId || !bound
          || bound.turnId!==origin.turnId || bound.callId!==origin.callId || canonical(action.request.arguments.input)!==row.input_json
          || action.authorization?.source!=='exact_owner' && (row.operation==='restore' || !this.store.ownDocumentAuthorizationValid(action.id)))throw 0;
      }
      if(row.operation==='append'){
        const input=AppendBotMemoryNoteSchema.parse(JSON.parse(row.input_json));body(input.note);
        if(origin.kind!=='harness_action'||!origin.memoryNote||origin.memoryNote.baseRevision!==input.expectedRevision||origin.memoryNote.sha256!==sha256(input.note))throw 0;
        const appended=origin.memoryNote.outcome==='appended',base=appended?(input.expectedRevision===0?{soul:'',user:'',memory:''}:this.snapshot(bot,this.revisionRow(bot,input.expectedRevision))):value;
        if(value.revision!==input.expectedRevision+(appended?1:0)||sha256(base.memory)!==origin.memoryNote.baseMemoryHash)throw 0;
        const effect=appendLiteralMemoryNote(base.memory,input.note);
        if(effect.outcome!==origin.memoryNote.outcome||effect.memory!==value.memory||value.soul!==base.soul||value.user!==base.user)throw 0;
        if(appended&&(canonical(value.memoryHead!.source)!==canonical(origin)||value.memoryHead!.restoredFrom!==null))throw 0;
        if(appendLiteralMemoryNote(value.memory,input.note).outcome!=='already_present')throw 0;
        const action=this.store.getAction(origin.actionId),actionOrigin=this.store.toolActionOrigin(origin.actionId),pin=action.request.arguments.pin;
        if(action.request.botId!==bot||action.request.threadId!==origin.threadId||action.request.tool!=='dexter.harness.memory.append'||action.request.destination!=='dexter-harness-owner-proposals'
          ||action.decidedBy!==this.store.ownerId||action.authorization?.source!=='exact_owner'&&!this.store.ownDocumentAuthorizationValid(action.id)||!actionOrigin||actionOrigin.turnId!==origin.turnId||actionOrigin.callId!==origin.callId
          ||canonical(action.request.arguments.input)!==row.input_json||!pin||typeof pin!=='object'||Array.isArray(pin)||Object.keys(pin).sort().join(',')!=='memoryHash,revision,soulHash,userHash'
          ||pin.revision!==input.expectedRevision||pin.soulHash!==sha256(base.soul)||pin.userHash!==sha256(base.user)||pin.memoryHash!==sha256(base.memory))throw 0;
        if(receipt.committedAt<value.updatedAt!||receipt.committedAt<action.createdAt||appended&&receipt.committedAt!==value.updatedAt)throw 0;
        receipt.note={sha256:origin.memoryNote.sha256,outcome:origin.memoryNote.outcome};
      }
      return {...value,receipt};
    }catch(error){if(error instanceof ContextError&&error.code==='forbidden')throw error;throw new ContextError('tampered');}
  }
  private replay(botId:string,key:string|null,inputJSON:string): BotDocuments|null {
    if(key===null)return null;
    const row=this.one('SELECT request_hash,input_json FROM bot_document_receipts WHERE bot_id=? AND operation_key=?',botId,key);
    if(!row)return null;
    if(row.input_json!==inputJSON||row.request_hash!==sha256(inputJSON))throw new ContextError('conflict');
    return this.receipt(botId,key);
  }
  private append(botId:string,current:BotDocuments,next:{soul:string;user:string;memory:string},memorySource:MemorySource,restoredFrom:number|null,
    key:string|null,inputJSON:string,operation:DocumentMutationReceipt['operation'],origin:MemorySource): BotDocuments {
    const revision=current.revision+1,nonce=randomUUID(),updatedAt=number(this.store.now(),0);
    const pins=['SOUL','USER','MEMORY'].map(name=>canonical(this.repository.write(`memory/${botId}/${name}-r${revision}-${nonce}.md`,next[name.toLowerCase() as keyof typeof next])));
    // Git writes can survive a failed SQLite commit as orphans; only this index grants revision eligibility.
    this.db.prepare('INSERT INTO bot_document_revisions VALUES (?,?,?,?,?,?,?,?)').run(botId,revision,pins[0]!,pins[1]!,pins[2]!,canonical(memorySource),restoredFrom,updatedAt);
    this.db.prepare(`INSERT INTO bot_documents VALUES (?,?,?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET revision=excluded.revision,
      soul_pin_json=excluded.soul_pin_json,user_pin_json=excluded.user_pin_json,memory_pin_json=excluded.memory_pin_json,updated_at=excluded.updated_at`).run(botId,revision,pins[0]!,pins[1]!,pins[2]!,updatedAt);
    if(key!==null)this.db.prepare('INSERT INTO bot_document_receipts VALUES (?,?,?,?,?,?,?,?)').run(botId,key,sha256(inputJSON),inputJSON,operation,canonical(origin),revision,updatedAt);
    return key===null?this.read(botId):this.receipt(botId,key)!;
  }
  update(botId:string,input:SetBotDocuments): BotDocuments {
    const value=parse(()=>SetBotDocumentsSchema.parse(input));
    for(const text of [value.soul,value.user,value.memory,value.sourceReference??''])body(text);
    if(value.sourceReference!==undefined&&value.clientRequestId===undefined)throw new ContextError('invalid_input');
    return this.write(()=>{
      const bot=this.own(botId),key=value.clientRequestId===undefined?null:`owner:${value.clientRequestId}`,inputJSON=canonical(value);
      const replay=this.replay(bot,key,inputJSON);if(replay)return replay;
      const current=this.read(bot);if(current.revision!==value.expectedRevision)throw new ContextError('conflict');
      const origin:MemorySource=value.clientRequestId===undefined?legacy:{kind:'owner_ui',ownerId:this.store.ownerId,clientRequestId:value.clientRequestId,reference:value.sourceReference??null};
      const memorySource=current.memory!==value.memory||current.memoryHead===null||value.sourceReference!==undefined?origin:current.memoryHead!.source;
      return this.append(bot,current,value,memorySource,current.memory===value.memory&&value.sourceReference===undefined?current.memoryHead?.restoredFrom??null:null,key,inputJSON,'update',origin);
    });
  }
  restore(botId:string,input:RestoreBotMemory): BotDocuments {
    const value=parse(()=>RestoreBotMemorySchema.parse(input));body(value.sourceReference??'');
    return this.write(()=>{
      const bot=this.own(botId),key=`owner:${value.clientRequestId}`,inputJSON=canonical(value),replay=this.replay(bot,key,inputJSON);if(replay)return replay;
      const current=this.read(bot);if(current.revision!==value.expectedRevision)throw new ContextError('conflict');
      const from=this.readRevision(bot,value.fromRevision);if(from.revision>current.revision)throw new ContextError('conflict');body(from.markdown);
      const origin:MemorySource={kind:'owner_ui',ownerId:this.store.ownerId,clientRequestId:value.clientRequestId,reference:value.sourceReference??null};
      return this.append(bot,current,{soul:current.soul,user:current.user,memory:from.markdown},origin,from.revision,key,inputJSON,'restore',origin);
    });
  }
  /** Only the host action ID is accepted. Identity, input and call origin come from the approved stored action. */
  executeAction(actionId:string): BotDocuments {
    return this.write(()=>{
      const action=this.store.getAction(id(actionId)),origin=this.store.toolActionOrigin(action.id),bot=this.own(action.request.botId);
      if(!origin||action.request.destination!=='dexter-harness-owner-proposals'||!['dexter.harness.documents.update','dexter.harness.memory.restore','dexter.harness.memory.append'].includes(action.request.tool)
        ||action.decidedBy!==this.store.ownerId)throw new ContextError('forbidden');
      const appendNote=action.request.tool==='dexter.harness.memory.append';
      if(action.authorization?.source!=='exact_owner' && (action.request.tool==='dexter.harness.memory.restore' || !this.store.ownDocumentAuthorizationValid(action.id)))throw new ContextError('forbidden');
      const raw=action.request.arguments.input;
      if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ContextError('invalid_input');
      const input:Record<string,unknown>=appendNote?parse(()=>AppendBotMemoryNoteSchema.parse(raw)):raw as Record<string,unknown>,restore=action.request.tool.endsWith('memory.restore');
      if(appendNote)body(input.note);
      const allowed=appendNote?['expectedRevision','note']:restore?['expectedRevision','fromRevision','sourceReference']:['expectedRevision','document','markdown','sourceReference'];
      if(Object.keys(input).some(key=>!allowed.includes(key))||typeof input.sourceReference==='string'&&(input.sourceReference.length>512||secret(input.sourceReference)))throw new ContextError('invalid_input');
      const expected=number(input.expectedRevision,0),inputJSON=canonical(input),key=`action:${action.id}`;
      const replay=this.replay(bot,key,inputJSON);if(replay)return replay;
      if(action.state!=='running')throw new ContextError('forbidden');
      const current=this.read(bot);if(current.revision!==expected)throw new ContextError('conflict');
      const actionPin=action.request.arguments.pin;
      if(!actionPin||typeof actionPin!=='object'||Array.isArray(actionPin)||Object.keys(actionPin).filter(key=>key!=='sourcePin').sort().join(',')!=='memoryHash,revision,soulHash,userHash')throw new ContextError('invalid_input');
      if(actionPin.revision!==current.revision||actionPin.soulHash!==sha256(current.soul)||actionPin.userHash!==sha256(current.user)||actionPin.memoryHash!==sha256(current.memory))throw new ContextError('conflict');
      if(appendNote){
        const pin=action.request.arguments.pin;
        if(!pin||typeof pin!=='object'||Array.isArray(pin)||Object.keys(pin).sort().join(',')!=='memoryHash,revision,soulHash,userHash')throw new ContextError('invalid_input');
        if(pin.revision!==current.revision||pin.soulHash!==sha256(current.soul)||pin.userHash!==sha256(current.user)||pin.memoryHash!==sha256(current.memory))throw new ContextError('conflict');
        const result=appendLiteralMemoryNote(current.memory,input.note as string);
        const actor:MemorySource=source({kind:'harness_action',ownerId:this.store.ownerId,actionId:action.id,threadId:action.request.threadId,turnId:origin.turnId,callId:origin.callId,reference:null,
          memoryNote:{sha256:result.sha256,outcome:result.outcome,baseRevision:current.revision,baseMemoryHash:sha256(current.memory)}});
        if(result.outcome==='already_present'){
          this.db.prepare('INSERT INTO bot_document_receipts VALUES (?,?,?,?,?,?,?,?)').run(bot,key,sha256(inputJSON),inputJSON,'append',canonical(actor),current.revision,number(this.store.now(),0));
          return this.receipt(bot,key)!;
        }
        return this.append(bot,current,{soul:current.soul,user:current.user,memory:result.memory},actor,null,key,inputJSON,'append',actor);
      }
      const next={soul:current.soul,user:current.user,memory:current.memory};let from:number|null=null;
      if(restore){from=number(input.fromRevision);next.memory=body(this.readRevision(bot,from).markdown);}
      else {if(!['SOUL','USER','MEMORY'].includes(input.document as string))throw new ContextError('invalid_input');next[(input.document as string).toLowerCase() as keyof typeof next]=body(input.markdown);}
      const actor:MemorySource=source({kind:'harness_action',ownerId:this.store.ownerId,actionId:action.id,threadId:action.request.threadId,turnId:origin.turnId,callId:origin.callId,reference:input.sourceReference??null});
      const memorySource=restore||input.document==='MEMORY'?actor:current.memoryHead?.source??legacy;
      return this.append(bot,current,next,memorySource,restore?from:input.document==='MEMORY'?null:current.memoryHead?.restoredFrom??null,key,inputJSON,restore?'restore':'update',actor);
    });
  }
}
