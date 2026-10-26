import {validateNativeVoiceJournal} from './native-voice.js';
import {one} from './schemas.js';
import type {DatabaseSync} from 'node:sqlite';
import {validateMemoryCaptureIntents} from './memory-learning.js';
/** Static final-Hub16 journal integration point. Unknown metadata keys remain refused by exact.ts.
 * Hash-verified native-voice-final validator is integrated here; exact.ts admits ONLY native_voice_journal_v1 on Hub15/16.
 * No arbitrary callback, plugin registry or prototype journal is accepted. */
export function validateHub16Journals(db:DatabaseSync):void {
 validateMemoryCaptureIntents(db);
 validateNativeVoiceJournal(db,{installationId:String(one(db,"SELECT value FROM meta WHERE key='host_id'")?.value),ownerId:String(one(db,"SELECT value FROM meta WHERE key='owner_id'")?.value)});
}
