import { DatabaseSync } from 'node:sqlite';
import { ContextError } from './types.js';
export const MEMORY_LEARNING_SQL=`
CREATE TABLE memory_learning_policies (bot_id TEXT PRIMARY KEY REFERENCES memory_subjects(bot_id), policy_json TEXT NOT NULL CHECK(json_valid(policy_json))) STRICT;
CREATE TABLE memory_learning_jobs (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES memory_subjects(bot_id), kind TEXT NOT NULL CHECK(kind IN ('capture','dreaming')), input_hash TEXT NOT NULL CHECK(length(input_hash)=64), input_json TEXT NOT NULL CHECK(json_valid(input_json)), scope_epoch INTEGER NOT NULL CHECK(scope_epoch>=0), policy_revision INTEGER NOT NULL CHECK(policy_revision>=0), state TEXT NOT NULL CHECK(state IN ('queued','claimed','dispatched','proposed','empty','unknown','withdrawn','conflict')), lease_owner TEXT, lease_until INTEGER, fence INTEGER NOT NULL CHECK(fence>=0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, CHECK((lease_owner IS NULL)=(lease_until IS NULL))) STRICT;
CREATE TABLE memory_learning_candidates (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES memory_subjects(bot_id), job_id TEXT NOT NULL REFERENCES memory_learning_jobs(id), candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json)), content_hash TEXT NOT NULL CHECK(length(content_hash)=64), state TEXT NOT NULL CHECK(state IN ('pending','accepted','rejected','withdrawn'))) STRICT;
CREATE TABLE memory_learning_receipts (action_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES memory_subjects(bot_id), request_hash TEXT NOT NULL CHECK(length(request_hash)=64), command_json TEXT NOT NULL CHECK(json_valid(command_json)), receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json))) STRICT;
CREATE TRIGGER memory_learning_receipts_immutable_update BEFORE UPDATE ON memory_learning_receipts BEGIN SELECT RAISE(ABORT,'immutable learning receipt'); END;
CREATE TRIGGER memory_learning_receipts_immutable_delete BEFORE DELETE ON memory_learning_receipts BEGIN SELECT RAISE(ABORT,'immutable learning receipt'); END;
CREATE TABLE memory_learning_budgets (bot_id TEXT NOT NULL REFERENCES memory_subjects(bot_id), day TEXT NOT NULL, jobs INTEGER NOT NULL CHECK(jobs>=0 AND jobs<=8), PRIMARY KEY(bot_id,day)) STRICT;
CREATE TABLE memory_learning_nights (bot_id TEXT NOT NULL REFERENCES memory_subjects(bot_id), day TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('queued','skipped')), created_at INTEGER NOT NULL, PRIMARY KEY(bot_id,day)) STRICT;
CREATE TABLE memory_learning_intents (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES memory_subjects(bot_id), input_hash TEXT NOT NULL CHECK(length(input_hash)=64), job_id TEXT REFERENCES memory_learning_jobs(id), state TEXT NOT NULL CHECK(state IN ('consumed','withdrawn'))) STRICT;

CREATE TRIGGER memory_learning_jobs_frozen_update BEFORE UPDATE OF id,bot_id,kind,input_hash,input_json,scope_epoch,policy_revision,created_at ON memory_learning_jobs BEGIN SELECT RAISE(ABORT,'immutable learning job input'); END;
CREATE TRIGGER memory_learning_jobs_frozen_delete BEFORE DELETE ON memory_learning_jobs BEGIN SELECT RAISE(ABORT,'retained learning job evidence'); END;
CREATE TRIGGER memory_learning_candidates_frozen_update BEFORE UPDATE OF id,bot_id,job_id,candidate_json,content_hash ON memory_learning_candidates BEGIN SELECT RAISE(ABORT,'immutable learning candidate'); END;
CREATE TRIGGER memory_learning_candidates_frozen_delete BEFORE DELETE ON memory_learning_candidates BEGIN SELECT RAISE(ABORT,'retained learning candidate'); END;
CREATE INDEX memory_learning_jobs_claim ON memory_learning_jobs(state,kind,created_at,id);
`;
export const MEMORY_LEARNING_TABLES=['memory_learning_policies','memory_learning_jobs','memory_learning_candidates','memory_learning_receipts','memory_learning_budgets','memory_learning_nights','memory_learning_intents'] as const;
let expected:string|undefined;
export function assertMemoryLearningSchema(db:DatabaseSync):void {
 const catalog=(d:DatabaseSync)=>JSON.stringify(d.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name IN (${MEMORY_LEARNING_TABLES.map(()=>'?').join(',')}) ORDER BY type,name`).all(...MEMORY_LEARNING_TABLES).map(r=>[r.type,r.name,r.tbl_name,typeof r.sql==='string'?r.sql.replace(/\s+/g,' ').trim().replace(/;$/,''):null]));
 if(expected===undefined){const reference=new DatabaseSync(':memory:');try{reference.exec('PRAGMA foreign_keys=OFF;'+MEMORY_LEARNING_SQL);expected=catalog(reference);}finally{reference.close();}}
 if(catalog(db)!==expected)throw new ContextError('tampered','memory learning exact schema mismatch');
}
