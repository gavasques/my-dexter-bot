import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryCaptureIntent } from '@dexter/contracts';
/** Separate memory migration. Root combines Groups v15 and this SQL in Hub v16. */
export const MEMORY_CAPTURE_INTENTS_SQL=`
CREATE TABLE memory_capture_intents (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id), thread_id TEXT NOT NULL REFERENCES threads(id), bot_id TEXT NOT NULL REFERENCES bots(id), input_message_id TEXT NOT NULL REFERENCES messages(id), output_message_id TEXT NOT NULL REFERENCES messages(id), input_hash TEXT NOT NULL CHECK(length(input_hash)=64), output_hash TEXT NOT NULL CHECK(length(output_hash)=64), finished_at INTEGER NOT NULL, audience TEXT NOT NULL CHECK(audience IN ('private','team')), audience_revision INTEGER NOT NULL CHECK(audience_revision>=0), scope_epoch INTEGER CHECK(scope_epoch>=0), policy_revision INTEGER CHECK(policy_revision>=0), state TEXT NOT NULL CHECK(state IN ('queued','consumed','withdrawn')), CHECK((scope_epoch IS NULL)=(policy_revision IS NULL))) STRICT;
CREATE INDEX memory_capture_intents_pending ON memory_capture_intents(state,finished_at,id);
`;
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
/** Invoked only INSIDE HostStore.finishTurn's admitted write, after canonical messages+turn are present. */
export function insertCompletedMemoryCaptureIntent(db:DatabaseSync,turnId:string,audience:{audience:'private'|'team';revision:number;scopeEpoch:number|null;policyRevision:number|null}):void {
 if(!db.isTransaction)throw new Error('capture_intent_requires_finish_transaction');
 const turn=db.prepare("SELECT * FROM turns WHERE id=? AND state='completed'").get(turnId);if(!turn||turn.output_message_id===null)return;
 const input=db.prepare("SELECT content,role,thread_id FROM messages WHERE id=?").get(turn.input_message_id!),output=db.prepare("SELECT content,role,thread_id FROM messages WHERE id=?").get(turn.output_message_id!);
 if(!input||!output||input.role!=='user'||output.role!=='assistant'||input.thread_id!==turn.thread_id||output.thread_id!==turn.thread_id)throw new Error('capture_intent_canonical_lineage_required');
 const inputHash=sha(String(input.content)),outputHash=sha(String(output.content)),id='mci_'+sha(String(turn.id)+':'+String(turn.input_message_id)+':'+String(turn.output_message_id!)+':'+inputHash+':'+outputHash+':'+audience.audience+':'+audience.revision+':'+audience.scopeEpoch+':'+audience.policyRevision);
 db.prepare('INSERT INTO memory_capture_intents VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,turn.id!,turn.thread_id!,turn.bot_id!,turn.input_message_id!,turn.output_message_id!,inputHash,outputHash,turn.finished_at!,audience.audience,audience.revision,audience.scopeEpoch,audience.policyRevision,'queued');
}
export function memoryCaptureIntentRow(r:Record<string,unknown>):MemoryCaptureIntent {return {id:String(r.id),turnId:String(r.turn_id),threadId:String(r.thread_id),botId:String(r.bot_id),inputMessageId:String(r.input_message_id),outputMessageId:String(r.output_message_id),inputHash:String(r.input_hash),outputHash:String(r.output_hash),finishedAt:Number(r.finished_at),audience:r.audience as 'private'|'team',audienceRevision:Number(r.audience_revision),scopeEpoch:r.scope_epoch===null?null:Number(r.scope_epoch),policyRevision:r.policy_revision===null?null:Number(r.policy_revision),state:r.state as MemoryCaptureIntent['state']};}
