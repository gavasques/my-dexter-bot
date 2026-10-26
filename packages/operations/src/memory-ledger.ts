import {validateMemoryBackend} from './memory-backend.js';
import { validateMemoryLearning } from './memory-learning.js';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '@dexter/hub';
import { fail } from './errors.js';
import { all, count, one } from './schemas.js';
import { checkFullSchema } from './full-schemas.js';

export const LEDGER_COUNT_TABLES = Object.freeze({memorySubjects:'memory_subjects',memoryScopes:'memory_scopes',memoryRecords:'memory_records',memoryRevisions:'memory_revisions',
  memoryCandidates:'memory_candidates',memoryJobs:'memory_jobs',memoryOperations:'memory_ledger_operations',memoryProjectionOutbox:'memory_projection_outbox',memoryProjectionReceipts:'memory_projection_receipts',memoryTombstones:'memory_tombstones'});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const projectionKey=(key:string)=>`mlp1_${hash('memory-ledger-projection-v1:'+key)}`;
const broken=(message:string):never=>fail('reference_broken',`memory ledger: ${message}`);
const int=(value:unknown,min=0):number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min?value:broken('invalid integer');
const wellFormed=(value:string):boolean=>{for(let i=0;i<value.length;i++){const unit=value.charCodeAt(i);if(unit>=0xd800&&unit<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}else if(unit>=0xdc00&&unit<=0xdfff)return false;}return true;};
const str=(value:unknown,max=128):string=>typeof value==='string'&&value.length>0&&value===value.trim()&&wellFormed(value)&&Buffer.byteLength(value)<=max&&!/[\x00-\x1f\x7f]/.test(value)?value:broken('invalid identifier');
const hex=(value:unknown):string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)?value:broken('invalid hash');
const namespace=(value:unknown):string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,261}$/.test(value)?value:broken('invalid remote identity');
function json(raw:unknown,max=2*1024*1024):unknown{
  if(typeof raw!=='string'||Buffer.byteLength(raw)>max)broken('invalid bounded JSON');
  try{const value:unknown=JSON.parse(raw as string);if(canonicalJson(value as never)!==raw)broken('noncanonical JSON');return value;}catch{return broken('invalid JSON');}
}
function refs(raw:unknown,limit=64):string[]{const value=json(raw,limit===64?262_144:64*1024*1024);if(!Array.isArray(value)||value.length>limit)broken('invalid evidence');const result=(value as unknown[]).map(value=>str(value,512));if(new Set(result).size!==result.length||JSON.stringify([...result].sort())!==JSON.stringify(result))broken('unordered evidence');return result;}
function closed(value:unknown,keys:string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))broken('invalid receipt shape');return value as Record<string,unknown>;}
function uri(userId:string,recordId:string,revision:number,sha:string):string{return `viking://user/${userId}/resources/dexter/memory/rec1_${Buffer.from(recordId).toString('hex')}/v${revision}-${sha}.md`;}

/** Independent read-only staged validation. A schema label alone does not prove canonical row integrity. */
export function validateMemoryLedger(db:DatabaseSync,hub:DatabaseSync):void{
  if(!['3','4','5'].includes(String(one(db,"SELECT value FROM meta WHERE key='schema'")?.value)))return;
  const owner=str(one(db,"SELECT value FROM meta WHERE key='owner'")?.value);
  const subjects=new Map(all(db,'SELECT * FROM memory_subjects').map(row=>[str(row.bot_id),row]));
  const scopes=new Map(all(db,'SELECT * FROM memory_scopes').map(row=>[str(row.scope_key,512),int(row.epoch)]));
  const records=new Map(all(db,'SELECT * FROM memory_records').map(row=>[str(row.id),row]));
  const operations=new Map(all(db,'SELECT * FROM memory_ledger_operations').map(row=>[str(row.operation_key,512),row]));
  for(const [botId,row] of subjects){
    str(row.workspace_id);namespace(row.account_id);namespace(row.user_id);int(row.mapper_version,1);int(row.created_at);
    // Only mapper v1 is implemented by this delivery. Full identity bytes survive rename and restore.
    if(row.mapper_version!==1||row.account_id!==`dx1_${Buffer.from(String(row.workspace_id)).toString('hex')}`||row.user_id!==`bot1_${Buffer.from(botId).toString('hex')}`)broken('unsupported identity mapping');
    if(count(hub,'SELECT COUNT(*) AS n FROM bots WHERE id=? AND owner_id=?',botId,owner)!==1)broken('subject has no owner bot');
    for(const kind of ['bot','confidential'])if(!scopes.has(`${kind}:${botId}`))broken('subject scope missing');
  }
  const scope=(key:unknown,botId:string):string=>{const value=str(key,512);if(!subjects.has(botId)||!scopes.has(value)||![`bot:${botId}`,`confidential:${botId}`].includes(value))broken('scope/subject mismatch');return value;};
  for(const key of scopes.keys())if(![...subjects.keys()].some(botId=>key===`bot:${botId}`||key===`confidential:${botId}`))broken('scope has no subject');
  const getRevision=(recordId:string,revision:number)=>one(db,'SELECT * FROM memory_revisions WHERE record_id=? AND revision=?',recordId,revision)??broken('revision missing');
  for(const [recordId,row] of records){
    const botId=str(row.bot_id);scope(row.scope_key,botId);str(row.kind,64);int(row.created_at);const head=int(row.head_revision,1);
    if(!['active','archived','expired','forgotten'].includes(String(row.state)))broken('invalid record state');
    const revisions=all(db,'SELECT * FROM memory_revisions WHERE record_id=? ORDER BY revision',recordId);
    if(revisions.length!==head||revisions.some((row,index)=>row.revision!==index+1))broken('noncontiguous immutable history');
    for(const revision of revisions){
      int(revision.revision,1);int(revision.policy_epoch);int(revision.created_at);refs(revision.evidence_json);hex(revision.content_hash);
      if(typeof revision.content!=='string'||!revision.content||!wellFormed(revision.content)||Buffer.byteLength(revision.content)>131_072||hash(revision.content)!==revision.content_hash)broken('revision bytes/hash mismatch');
      if(revision.valid_from!==null)int(revision.valid_from);if(revision.valid_until!==null)int(revision.valid_until);
      if(revision.valid_from!==null&&revision.valid_until!==null&&Number(revision.valid_until)<Number(revision.valid_from))broken('invalid temporal validity');
      if(revision.supersedes!==(revision.revision===1?null:Number(revision.revision)-1)||Number(revision.policy_epoch)>scopes.get(String(row.scope_key))!)broken('revision lineage/epoch mismatch');
      const operation=operations.get(str(revision.operation_key,512));if(!operation||operation.kind!=='accept_revision')broken('revision lacks durable acceptance');
      if(count(db,"SELECT COUNT(*) AS n FROM memory_projection_outbox WHERE record_id=? AND revision=? AND operation='create' AND revision_operation_key=?",recordId,Number(revision.revision),String(revision.operation_key))!==1)broken('revision lacks one transactionally accepted projection');
    }
    const tombstone=one(db,'SELECT * FROM memory_tombstones WHERE record_id=?',recordId);
    if((row.state==='forgotten')!==!!tombstone)broken('forget state/tombstone mismatch');
  }
  for(const row of all(db,'SELECT * FROM memory_revisions'))if(!records.has(String(row.record_id)))broken('orphan revision');
  for(const row of all(db,'SELECT * FROM memory_candidates')){
    str(row.id);str(row.record_id);const botId=str(row.bot_id),key=scope(row.scope_key,botId);int(row.expected_revision);int(row.policy_epoch);int(row.created_at);str(row.extractor_version);refs(row.evidence_json);hex(row.content_hash);
    if(typeof row.content!=='string'||!row.content||!wellFormed(row.content)||Buffer.byteLength(row.content)>131_072||hash(row.content)!==row.content_hash||!['pending','accepted','rejected','withdrawn'].includes(String(row.state)))broken('invalid candidate');
    if(Number(row.policy_epoch)>scopes.get(key)!||row.state==='pending'&&Number(row.policy_epoch)!==scopes.get(key))broken('stale pending candidate');
    const operation=operations.get(str(row.operation_key,512));if(!operation||operation.kind!=='candidate')broken('candidate lacks durable operation');
    if(row.state==='accepted'&&!all(db,'SELECT * FROM memory_revisions WHERE record_id=?',String(row.record_id)).some(rev=>rev.content===row.content&&rev.evidence_json===row.evidence_json&&rev.revision===Number(row.expected_revision)+1))broken('accepted candidate lacks revision');
  }
  for(const row of all(db,'SELECT * FROM memory_jobs')){
    str(row.id);str(row.record_id);str(row.kind,64);str(row.config_version);hex(row.input_hash);refs(row.evidence_json);int(row.expected_revision);int(row.policy_epoch);int(row.fence);int(row.attempts);int(row.created_at);int(row.updated_at);
    const key=scope(row.scope_key,str(row.bot_id));if(!['queued','claimed','committed','unknown','conflict','withdrawn'].includes(String(row.state))||Number(row.policy_epoch)>scopes.get(key)!)broken('invalid job state/epoch');
    if((row.state==='claimed')!==(row.lease_owner!==null&&row.lease_until!==null)||(row.lease_owner===null)!==(row.lease_until===null))broken('job lease mismatch');
    if(row.state==='claimed'){str(row.lease_owner);int(row.lease_until,1);int(row.fence,1);if(Number(row.policy_epoch)!==scopes.get(key))broken('stale claimed job');}
    const operation=operations.get(str(row.operation_key,512));if(!operation||operation.kind!=='job')broken('job lacks durable operation');
    if(row.state==='committed'){
      const acceptance=operations.get(str(row.committed_operation_key,512));if(!acceptance||acceptance.kind!=='accept_revision')return broken('committed job lacks acceptance');
      const receipt=json(acceptance.receipt_json) as Record<string,unknown>;if(receipt.recordId!==row.record_id||receipt.revision!==Number(row.expected_revision)+1)broken('job acceptance mismatch');
    }else if(row.committed_operation_key!==null)broken('uncommitted job carries acceptance');
  }
  for(const row of all(db,'SELECT * FROM memory_projection_outbox')){
    const recordId=str(row.record_id),revision=int(row.revision,1),record=records.get(recordId);if(!record)broken('projection record missing');
    const key=scope(row.scope_key,String(record!.bot_id)),subject=subjects.get(String(record!.bot_id))!,canonical=getRevision(recordId,revision);
    str(row.operation_key,1024);str(row.revision_operation_key,512);hex(row.content_hash);int(row.policy_epoch);int(row.fence);int(row.created_at);int(row.updated_at);
    if(row.account_id!==subject.account_id||row.user_id!==subject.user_id||row.content_hash!==canonical.content_hash||row.revision_operation_key!==canonical.operation_key||row.uri!==uri(String(subject.user_id),recordId,revision,String(canonical.content_hash)))broken('projection identity/version/hash/URI mismatch');
    if(!['create','delete'].includes(String(row.operation))||!['queued','dispatched','confirmed','unknown','conflict','withdrawn'].includes(String(row.state))||Number(row.policy_epoch)>scopes.get(key)!)broken('invalid projection state/epoch');
    if((row.lease_owner===null)!==(row.lease_until===null))broken('projection lease incomplete');
    if(row.lease_owner!==null){str(row.lease_owner);int(row.lease_until,1);int(row.fence,1);}
    if(row.state==='queued'&&row.fence!==0||row.state==='dispatched'&&row.lease_owner===null)broken('projection dispatch/fence mismatch');
    if(row.operation==='create'){
      if(row.operation_key!==projectionKey(String(canonical.operation_key))||row.policy_epoch!==canonical.policy_epoch)broken('create projection lineage mismatch');
      if(record!.state==='forgotten'&&['queued','dispatched','unknown'].includes(String(row.state)))broken('forgotten create projection is runnable');
    }else{
      const tombstone=one(db,'SELECT * FROM memory_tombstones WHERE record_id=?',recordId);if(!tombstone||row.policy_epoch!==tombstone.epoch||row.operation_key!==`${tombstone.operation_key}:purge:${revision}`)broken('delete projection lacks tombstone');
    }
  }
  for(const row of all(db,'SELECT * FROM memory_projection_receipts')){
    const operationKey=str(row.operation_key,1024),outbox=one(db,'SELECT * FROM memory_projection_outbox WHERE operation_key=?',operationKey);if(!outbox)broken('receipt outbox missing');int(row.fence,1);int(row.created_at);
    const binding=closed(json(row.binding_json,4096),['operationKey','accountId','userId','recordId','revision','uri','sha256']);
    if(binding.operationKey!==operationKey||binding.accountId!==outbox!.account_id||binding.userId!==outbox!.user_id||binding.recordId!==outbox!.record_id||binding.revision!==outbox!.revision||binding.uri!==outbox!.uri||binding.sha256!==outbox!.content_hash||Number(row.fence)>Number(outbox!.fence)||!['confirmed','unknown','conflict'].includes(String(row.outcome))||row.indexing!=='unproven')broken('receipt binding/fence/outcome mismatch');
    if(row.task_id!==null)str(row.task_id,512);if(row.reason!==null)str(row.reason,128);
  }
  for(const row of all(db,'SELECT * FROM memory_tombstones')){
    const recordId=str(row.record_id),record=records.get(recordId);if(!record||record.state!=='forgotten'||row.scope_key!==record.scope_key||int(row.epoch,1)>scopes.get(String(row.scope_key))!)broken('invalid tombstone scope/epoch');
    str(row.suppression_signature,512);int(row.created_at);const sources=refs(row.evidence_json,Number.MAX_SAFE_INTEGER),hashes=json(row.hashes_json,64*1024*1024) as unknown[];
    if(!Array.isArray(hashes)||new Set(hashes).size!==hashes.length||JSON.stringify([...hashes].sort())!==JSON.stringify(hashes))broken('invalid suppression hashes');hashes.forEach(hex);
    const revisions=all(db,'SELECT * FROM memory_revisions WHERE record_id=?',recordId);
    if(revisions.some(rev=>!hashes.includes(rev.content_hash)||refs(rev.evidence_json).some(ref=>!sources.includes(ref))))broken('tombstone loses source suppression');
    const operation=operations.get(str(row.operation_key,512));if(!operation||operation.kind!=='forget')broken('tombstone lacks durable forget');
    if(revisions.some(rev=>count(db,"SELECT COUNT(*) AS n FROM memory_projection_outbox WHERE record_id=? AND revision=? AND operation='delete'",recordId,Number(rev.revision))!==1))broken('tombstone lacks durable purge intents');
  }
  for(const [operationKey,row] of operations){
    int(row.created_at);hex(row.request_hash);const request=json(row.request_json),receipt=json(row.receipt_json);
    if(hash(String(row.request_json))!==row.request_hash)broken('operation request hash mismatch');
    const shapes:Record<string,string[]>={accept_revision:['recordId','botId','scope','kind','expectedRevision','policyEpoch','content','evidenceRefs','operationKey','validFrom','validUntil','candidateId'],candidate:['scope','candidateId','recordId','botId','content','evidenceRefs','expectedRevision','policyEpoch','extractorVersion','operationKey'],job:['scope','jobId','recordId','botId','kind','inputHash','evidenceRefs','expectedRevision','policyEpoch','configVersion','operationKey'],record_state:['recordId','expectedRevision','policyEpoch','state','operationKey'],forget:['recordId','expectedRevision','policyEpoch','operationKey','suppressionSignature']};
    const shape=shapes[String(row.kind)];if(!shape)return broken('unsupported durable operation');
    const input=closed(request,shape);int(input.expectedRevision);int(input.policyEpoch);str(input.recordId);
    if(input.operationKey!==operationKey)broken('operation input/key mismatch');
    if(row.kind==='accept_revision'){
      const output=closed(receipt,['recordId','revision','sha256','operationKey','projectionOperationKey','uri','policyEpoch']);
      const recordId=str(output.recordId),revision=getRevision(recordId,int(output.revision,1));
      if(output.operationKey!==operationKey||output.projectionOperationKey!==projectionKey(operationKey)||output.sha256!==revision.content_hash||output.policyEpoch!==revision.policy_epoch||revision.operation_key!==operationKey||output.recordId!==input.recordId||output.revision!==Number(input.expectedRevision)+1||input.content!==revision.content||canonicalJson(input.evidenceRefs as never)!==revision.evidence_json||input.policyEpoch!==revision.policy_epoch)broken('acceptance receipt mismatch');
      const projection=one(db,"SELECT * FROM memory_projection_outbox WHERE operation_key=? AND operation='create'",String(output.projectionOperationKey));if(!projection||output.uri!==projection.uri)broken('acceptance projection receipt mismatch');
      const record=records.get(recordId)!;const target=closed(input.scope,['kind','botId']);
      if(input.botId!==record.bot_id||input.kind!==record.kind||target.botId!==record.bot_id||`${target.kind}:${target.botId}`!==record.scope_key||input.validFrom!==revision.valid_from||input.validUntil!==revision.valid_until||row.created_at!==revision.created_at)broken('acceptance request identity/validity mismatch');
      if(input.candidateId!==null){const candidate=one(db,'SELECT * FROM memory_candidates WHERE id=?',str(input.candidateId));if(!candidate||candidate.state!=='accepted'||candidate.record_id!==recordId||candidate.content!==revision.content)broken('acceptance candidate lineage mismatch');}
    }else if(row.kind==='candidate'){
      const output=closed(receipt,['candidateId','state']);const candidate=one(db,'SELECT * FROM memory_candidates WHERE id=?',str(output.candidateId));if(!candidate||candidate.operation_key!==operationKey||output.state!=='pending'||input.candidateId!==output.candidateId||input.content!==candidate.content||input.expectedRevision!==candidate.expected_revision||input.policyEpoch!==candidate.policy_epoch||canonicalJson(input.evidenceRefs as never)!==candidate.evidence_json)broken('candidate receipt mismatch');
      const target=closed(input.scope,['kind','botId']);if(input.botId!==candidate!.bot_id||input.recordId!==candidate!.record_id||`${target.kind}:${target.botId}`!==candidate!.scope_key||target.botId!==input.botId||input.extractorVersion!==candidate!.extractor_version||row.created_at!==candidate!.created_at)broken('candidate request identity mismatch');
    }else if(row.kind==='job'){
      const output=closed(receipt,['jobId']);const job=one(db,'SELECT * FROM memory_jobs WHERE id=?',str(output.jobId));if(!job||job.operation_key!==operationKey||input.jobId!==output.jobId||input.inputHash!==job.input_hash||input.expectedRevision!==job.expected_revision||input.policyEpoch!==job.policy_epoch||canonicalJson(input.evidenceRefs as never)!==job.evidence_json)broken('job receipt mismatch');
      const target=closed(input.scope,['kind','botId']);if(input.botId!==job!.bot_id||input.recordId!==job!.record_id||`${target.kind}:${target.botId}`!==job!.scope_key||target.botId!==input.botId||input.kind!==job!.kind||input.configVersion!==job!.config_version||row.created_at!==job!.created_at)broken('job request identity mismatch');
    }else if(row.kind==='record_state'){
      const output=closed(receipt,['recordId','state','revision']);const record=records.get(String(input.recordId));if(!record||output.recordId!==input.recordId||output.state!==input.state||output.revision!==input.expectedRevision||!['active','archived'].includes(String(output.state))||Number(output.revision)>Number(record.head_revision))broken('record state receipt mismatch');
    }else if(row.kind==='forget'){
      const output=closed(receipt,['recordId','epoch','purgePending']);const tombstone=one(db,'SELECT * FROM memory_tombstones WHERE record_id=?',str(output.recordId));if(!tombstone||tombstone.operation_key!==operationKey||output.epoch!==tombstone.epoch||input.recordId!==output.recordId||input.policyEpoch!==Number(output.epoch)-1||input.suppressionSignature!==tombstone.suppression_signature||int(output.purgePending)!==count(db,"SELECT COUNT(*) AS n FROM memory_projection_outbox WHERE record_id=? AND operation='delete'",String(output.recordId)))broken('forget receipt mismatch');
      if(input.expectedRevision!==records.get(String(output.recordId))!.head_revision||row.created_at!==tombstone!.created_at)broken('forget request head mismatch');
    }else broken('unsupported durable operation');
  }
}

/** Staged backup copies carry unknown work, never a reusable process lease. Dispatch history is retained. */
export function sanitizeMemoryLedger(contextPath:string,hubPath:string):void{
  const db=new DatabaseSync(contextPath),hub=new DatabaseSync(hubPath,{readOnly:true});
  try{
    if(!['3','4','5'].includes(String(one(db,"SELECT value FROM meta WHERE key='schema'")?.value)))return;
    checkFullSchema(db,'context');validateMemoryLedger(db,hub);validateMemoryLearning(db,hub);validateMemoryBackend(db,hub);
    db.exec('BEGIN IMMEDIATE');
    try{db.exec("UPDATE memory_jobs SET state='unknown',lease_owner=NULL,lease_until=NULL,fence=fence+1 WHERE state='claimed'; UPDATE memory_projection_outbox SET state=CASE WHEN state='dispatched' THEN 'unknown' ELSE state END,lease_owner=NULL,lease_until=NULL,fence=fence+1 WHERE lease_owner IS NOT NULL;");if(['4','5'].includes(String(one(db,"SELECT value FROM meta WHERE key='schema'")?.value)))db.exec("UPDATE memory_learning_jobs SET state=CASE WHEN state='dispatched' THEN 'unknown' ELSE state END,lease_owner=NULL,lease_until=NULL,fence=fence+1 WHERE lease_owner IS NOT NULL; UPDATE memory_learning_jobs SET state='withdrawn' WHERE state IN ('queued','claimed'); UPDATE memory_learning_candidates SET state='withdrawn' WHERE state='pending';");db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
  }finally{db.close();hub.close();}
}
