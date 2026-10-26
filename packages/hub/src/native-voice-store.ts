import type { DatabaseSync } from 'node:sqlite';
import { NativeVoiceJournalSchema, NATIVE_VOICE_META_KEY, MAX_NATIVE_VOICE_JOURNAL_BYTES, type NativeVoiceJournal } from '@dexter/contracts';
import type { HostStore } from './store.js';
import { canonicalJson } from './store.js';
import { HostError } from './errors.js';

export function nativeVoiceJournalJSON(value:NativeVoiceJournal):string {
  return canonicalJson(NativeVoiceJournalSchema.parse(value));
}
/** Same Hub writer/metadata. No raw media, SDP, provider error or native cursor is admitted. */
export class NativeVoiceStore {
  constructor(private readonly store:HostStore,private readonly db:DatabaseSync,private readonly write:<T>(fn:()=>T)=>T) {}
  read():NativeVoiceJournal {
    this.store.assertActiveWriter();
    const encoded=this.db.prepare('SELECT value FROM meta WHERE key=?').get(NATIVE_VOICE_META_KEY)?.value;
    if(encoded===undefined)return {version:1,sessions:[],receipts:[],preferences:[],preferenceReceipts:[]};
    try {
      if(typeof encoded!=='string'||Buffer.byteLength(encoded)>MAX_NATIVE_VOICE_JOURNAL_BYTES)throw new Error();
      const value=NativeVoiceJournalSchema.parse(JSON.parse(encoded));
      if(nativeVoiceJournalJSON(value)!==encoded)throw new Error();
      if(new Set(value.sessions.map(s=>s.id)).size!==value.sessions.length||new Set(value.receipts.map(r=>r.threadId+':'+r.clientRequestId)).size!==value.receipts.length)throw new Error();
      for(const s of value.sessions)if(s.hostId!==this.store.hostId||this.store.getThread(s.threadId).botId!==s.botId)throw new Error();
      for(const r of value.receipts)if(r.hostId!==this.store.hostId||!value.sessions.some(s=>s.id===r.sessionId&&s.threadId===r.threadId&&s.generation===r.generation))throw new Error();
      if(new Set(value.sessions.map(s=>s.cursor)).size!==value.sessions.length||new Set(value.preferences.map(p=>p.botId)).size!==value.preferences.length||new Set(value.preferenceReceipts.map(r=>r.botId+':'+r.clientRequestId)).size!==value.preferenceReceipts.length)throw new Error();
      for(const p of value.preferences)if(p.hostId!==this.store.hostId||this.store.getBot(p.botId).ownerId!==this.store.ownerId)throw new Error();
      for(const r of value.preferenceReceipts)if(r.hostId!==this.store.hostId||r.preference.botId!==r.botId||!value.preferences.some(p=>p.botId===r.botId&&p.revision>=r.preference.revision))throw new Error();
      return value;
    } catch {throw new HostError('conflict','Native voice metadata is not canonical.');}
  }
  save(value:NativeVoiceJournal):void {
    const encoded=nativeVoiceJournalJSON(value);
    if(Buffer.byteLength(encoded)>MAX_NATIVE_VOICE_JOURNAL_BYTES)throw new HostError('conflict','Native voice receipt capacity reached.');
    this.write(()=>{this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(NATIVE_VOICE_META_KEY,encoded);});
  }
}
