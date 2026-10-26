import { NativeVoiceJournalSchema,NATIVE_VOICE_META_KEY,MAX_NATIVE_VOICE_JOURNAL_BYTES } from '@dexter/contracts';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '@dexter/hub';
import {one,type Identity} from './schemas.js';
import {fail} from './errors.js';
// Exact authored semantic validator mechanically extracted from native-voice-final/exact.ts.
export function validateNativeVoiceJournal(db:DatabaseSync,identity:Identity):void {
 const {installationId,ownerId}=identity,meta=new Map(db.prepare('SELECT key,value FROM meta').all().map(r=>[String(r.key),r.value]));
    if(meta.has(NATIVE_VOICE_META_KEY)){
      const encoded=meta.get(NATIVE_VOICE_META_KEY);
      if(typeof encoded!=='string'||Buffer.byteLength(encoded)>MAX_NATIVE_VOICE_JOURNAL_BYTES)fail('corrupt','Native voice metadata invalid.');
      let journal:ReturnType<typeof NativeVoiceJournalSchema.parse>;
      try{journal=NativeVoiceJournalSchema.parse(JSON.parse(encoded));}catch{fail('corrupt','Native voice metadata invalid.');}
      if(canonicalJson(journal)!==encoded||new Set(journal.sessions.map(s=>s.id)).size!==journal.sessions.length||new Set(journal.receipts.map(r=>r.threadId+':'+r.clientRequestId)).size!==journal.receipts.length)fail('corrupt','Native voice metadata invalid.');
      for(const s of journal.sessions)if(s.hostId!==installationId||!one(db,'SELECT t.id FROM threads t JOIN bots b ON b.id=t.bot_id WHERE t.id=? AND t.bot_id=? AND b.owner_id=?',s.threadId,s.botId,ownerId)||one(db,'SELECT 1 FROM group_thread_audiences WHERE thread_id=?',s.threadId)||s.threadId.startsWith('thr_team_'))fail('reference_broken','Native voice scope invalid.');
      for(const r of journal.receipts)if(r.hostId!==installationId||!journal.sessions.some(s=>s.id===r.sessionId&&s.generation===r.generation&&s.threadId===r.threadId))fail('reference_broken','Native voice receipt invalid.');
      if(new Set(journal.sessions.map(s=>s.cursor)).size!==journal.sessions.length||new Set(journal.preferences.map(p=>p.botId)).size!==journal.preferences.length||new Set(journal.preferenceReceipts.map(r=>r.botId+':'+r.clientRequestId)).size!==journal.preferenceReceipts.length)fail('corrupt','Native voice metadata invalid.');
      for(const s of journal.sessions)for(const id of s.turnIds)if(!one(db,'SELECT id FROM turns WHERE id=? AND thread_id=? AND bot_id=?',id,s.threadId,s.botId))fail('reference_broken','Native voice transcript reference invalid.');
      for(const p of journal.preferences)if(p.hostId!==installationId||!one(db,'SELECT id FROM bots WHERE id=? AND owner_id=?',p.botId,ownerId))fail('reference_broken','Native voice preference invalid.');
      for(const r of journal.preferenceReceipts)if(r.hostId!==installationId||r.preference.botId!==r.botId||!journal.preferences.some(p=>p.botId===r.botId&&p.revision>=r.preference.revision))fail('reference_broken','Native voice preference receipt invalid.');
    }
}
