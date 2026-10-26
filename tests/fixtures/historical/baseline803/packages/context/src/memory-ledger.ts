import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { canonicalJson, type HostStore } from '@dexter/hub';
import { ContextError } from './types.js';
import { sha256 } from './repository.js';

/** Additive Context schema 3. D24 documents, Git pins and MemoryRoutines remain separate and untouched. */
export const MEMORY_LEDGER_SQL = `
CREATE TABLE memory_subjects (bot_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, account_id TEXT NOT NULL,
  user_id TEXT NOT NULL UNIQUE, mapper_version INTEGER NOT NULL CHECK(mapper_version > 0), created_at INTEGER NOT NULL) STRICT;
CREATE TRIGGER memory_subjects_immutable_update BEFORE UPDATE ON memory_subjects BEGIN SELECT RAISE(ABORT,'immutable memory identity'); END;
CREATE TRIGGER memory_subjects_immutable_delete BEFORE DELETE ON memory_subjects BEGIN SELECT RAISE(ABORT,'immutable memory identity'); END;
CREATE TABLE memory_scopes (scope_key TEXT PRIMARY KEY, epoch INTEGER NOT NULL CHECK(epoch >= 0)) STRICT;
CREATE TABLE memory_records (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES memory_subjects(bot_id),
  scope_key TEXT NOT NULL REFERENCES memory_scopes(scope_key), kind TEXT NOT NULL, head_revision INTEGER NOT NULL CHECK(head_revision > 0),
  state TEXT NOT NULL CHECK(state IN ('active','archived','expired','forgotten')), created_at INTEGER NOT NULL) STRICT;
CREATE TABLE memory_revisions (record_id TEXT NOT NULL REFERENCES memory_records(id), revision INTEGER NOT NULL CHECK(revision > 0),
  content TEXT NOT NULL, content_hash TEXT NOT NULL CHECK(length(content_hash)=64), evidence_json TEXT NOT NULL,
  policy_epoch INTEGER NOT NULL CHECK(policy_epoch >= 0), valid_from INTEGER, valid_until INTEGER, supersedes INTEGER,
  operation_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, PRIMARY KEY(record_id,revision)) STRICT;
CREATE TRIGGER memory_revisions_immutable_update BEFORE UPDATE ON memory_revisions BEGIN SELECT RAISE(ABORT,'immutable memory revision'); END;
CREATE TRIGGER memory_revisions_immutable_delete BEFORE DELETE ON memory_revisions BEGIN SELECT RAISE(ABORT,'immutable memory revision'); END;
CREATE TABLE memory_candidates (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES memory_subjects(bot_id), scope_key TEXT NOT NULL,
  record_id TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, evidence_json TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0), policy_epoch INTEGER NOT NULL CHECK(policy_epoch >= 0),
  extractor_version TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','accepted','rejected','withdrawn')),
  operation_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE memory_jobs (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES memory_subjects(bot_id), scope_key TEXT NOT NULL,
  record_id TEXT NOT NULL, kind TEXT NOT NULL, input_hash TEXT NOT NULL, evidence_json TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0), policy_epoch INTEGER NOT NULL CHECK(policy_epoch >= 0),
  config_version TEXT NOT NULL, operation_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('queued','claimed','committed','unknown','conflict','withdrawn')),
  lease_owner TEXT, lease_until INTEGER, fence INTEGER NOT NULL CHECK(fence >= 0), attempts INTEGER NOT NULL CHECK(attempts >= 0),
  committed_operation_key TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE memory_ledger_operations (operation_key TEXT PRIMARY KEY, kind TEXT NOT NULL,
  request_hash TEXT NOT NULL, request_json TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TRIGGER memory_ledger_operations_immutable_update BEFORE UPDATE ON memory_ledger_operations BEGIN SELECT RAISE(ABORT,'immutable memory operation'); END;
CREATE TRIGGER memory_ledger_operations_immutable_delete BEFORE DELETE ON memory_ledger_operations BEGIN SELECT RAISE(ABORT,'immutable memory operation'); END;
CREATE TABLE memory_projection_outbox (operation_key TEXT PRIMARY KEY, revision_operation_key TEXT NOT NULL,
  record_id TEXT NOT NULL, revision INTEGER NOT NULL, scope_key TEXT NOT NULL, policy_epoch INTEGER NOT NULL,
  account_id TEXT NOT NULL, user_id TEXT NOT NULL, uri TEXT NOT NULL, content_hash TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('create','delete')),
  state TEXT NOT NULL CHECK(state IN ('queued','dispatched','confirmed','unknown','conflict','withdrawn')),
  lease_owner TEXT, lease_until INTEGER, fence INTEGER NOT NULL CHECK(fence >= 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  FOREIGN KEY(record_id,revision) REFERENCES memory_revisions(record_id,revision), UNIQUE(uri,operation)) STRICT;
CREATE TABLE memory_projection_receipts (operation_key TEXT NOT NULL REFERENCES memory_projection_outbox(operation_key),
  fence INTEGER NOT NULL CHECK(fence > 0), binding_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('confirmed','unknown','conflict')), indexing TEXT NOT NULL CHECK(indexing='unproven'),
  task_id TEXT, reason TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(operation_key,fence)) STRICT;
CREATE TRIGGER memory_projection_receipts_immutable_update BEFORE UPDATE ON memory_projection_receipts BEGIN SELECT RAISE(ABORT,'immutable projection receipt'); END;
CREATE TRIGGER memory_projection_receipts_immutable_delete BEFORE DELETE ON memory_projection_receipts BEGIN SELECT RAISE(ABORT,'immutable projection receipt'); END;
CREATE TABLE memory_tombstones (record_id TEXT PRIMARY KEY REFERENCES memory_records(id), scope_key TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch > 0), evidence_json TEXT NOT NULL, hashes_json TEXT NOT NULL,
  suppression_signature TEXT NOT NULL, operation_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL) STRICT;
CREATE TRIGGER memory_tombstones_immutable_update BEFORE UPDATE ON memory_tombstones BEGIN SELECT RAISE(ABORT,'immutable memory suppression'); END;
CREATE TRIGGER memory_tombstones_immutable_delete BEFORE DELETE ON memory_tombstones BEGIN SELECT RAISE(ABORT,'immutable memory suppression'); END;
CREATE INDEX memory_jobs_claim ON memory_jobs(state,lease_until,id);
CREATE INDEX memory_projection_pending ON memory_projection_outbox(state,operation,record_id,revision);
`;

export const MEMORY_LEDGER_TABLES = Object.freeze(['memory_subjects','memory_scopes','memory_records','memory_revisions',
  'memory_candidates','memory_jobs','memory_ledger_operations','memory_projection_outbox','memory_projection_receipts','memory_tombstones'] as const);
let ledgerCatalog: string | undefined;
/** The host refuses missing/altered ledger triggers and indexes instead of silently repairing history. */
export function assertMemoryLedgerSchema(db: DatabaseSync): void {
  const names = MEMORY_LEDGER_TABLES.map(() => '?').join(',');
  const catalog = (value: DatabaseSync) => value.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name IN (${names}) ORDER BY type,name`).all(...MEMORY_LEDGER_TABLES)
    .map(row=>JSON.stringify([row.type,row.name,row.tbl_name,typeof row.sql==='string'?row.sql.replace(/\s+/g,' ').trim().replace(/;$/,''):null])).join('\n');
  if (ledgerCatalog===undefined) { const reference=new DatabaseSync(':memory:');try{reference.exec(MEMORY_LEDGER_SQL);ledgerCatalog=catalog(reference);}finally{reference.close();} }
  if(catalog(db)!==ledgerCatalog)throw new ContextError('tampered','memory ledger schema is not the admitted exact catalog');
}
export const MEMORY_LEDGER_LIMITS = Object.freeze({ contentBytes: 131_072, evidenceRefs: 64, identifierBytes: 128, leaseMs: 300_000 });
export interface MemorySubjectIdentity { mapperVersion: number; workspaceId: string; botId: string; accountId: string; userId: string }
/** Only the trusted host supplies this deterministic, versioned mapper; names are never mapping inputs. */
export type MemoryIdentityMapper = (botId: string) => MemorySubjectIdentity;
export interface MemoryLedgerScope { kind: 'bot' | 'confidential'; botId: string }
export interface MemoryRevisionInput {
  recordId: string; botId: string; scope: MemoryLedgerScope; kind: string; expectedRevision: number; policyEpoch: number;
  content: string; evidenceRefs: readonly string[]; operationKey: string; validFrom?: number | null; validUntil?: number | null;
  candidateId?: string;
}
export interface MemoryLedgerAccepted {
  recordId: string; revision: number; sha256: string; operationKey: string; projectionOperationKey: string; uri: string; policyEpoch: number;
}
export interface MemoryRecordReference {
  recordId:string;botId:string;scope:MemoryLedgerScope;kind:string;state:'active'|'archived'|'expired'|'forgotten';
  revision:number;sha256:string;policyEpoch:number;scopeEpoch:number;createdAt:number;
}
export interface MemoryActiveReferenceInput {recordId:string;revision:number;sha256:string;scopeEpoch:number}
export interface MemoryPendingProjection extends MemoryProjectionBinding {state:'queued'|'dispatched'|'unknown';policyEpoch:number;scopeEpoch:number}
export interface MemoryCandidateInput {
  candidateId: string; recordId: string; botId: string; scope: MemoryLedgerScope; content: string; evidenceRefs: readonly string[];
  expectedRevision: number; policyEpoch: number; extractorVersion: string; operationKey: string;
}
export interface MemoryJobInput {
  jobId: string; recordId: string; botId: string; scope: MemoryLedgerScope; kind: string; inputHash: string; evidenceRefs: readonly string[];
  expectedRevision: number; policyEpoch: number; configVersion: string; operationKey: string;
}
export interface MemoryJobClaim { jobId: string; workerId: string; fence: number; leaseUntil: number }
/** Structural contract of OpenVikingProjectionJournal; no provider dependency or token lives in this ledger. */
export interface MemoryProjectionBinding {
  operationKey: string; accountId: string; userId: string; recordId: string; revision: number; uri: string; sha256: string;
}
export interface MemoryProjectionReceipt extends MemoryProjectionBinding {
  outcome: 'confirmed' | 'unknown' | 'conflict'; indexing: 'unproven'; taskId: string | null; reason: string | null;
}
export interface MemoryProjectionJournal {
  claim(binding: MemoryProjectionBinding): Promise<'send' | 'reconcile'>;
  record(receipt: MemoryProjectionReceipt): Promise<void>;
}
type Row = Record<string, unknown>;
const canonical = (value: unknown): string => canonicalJson(JSON.parse(JSON.stringify(value)));
const fail = (code: 'invalid_input' | 'conflict' | 'forbidden' | 'not_found' | 'tampered', message?: string): never => { throw new ContextError(code, message); };
function identifier(value: unknown, bytes: number = MEMORY_LEDGER_LIMITS.identifierBytes): string {
  if (typeof value !== 'string' || !value || value!==value.trim() || !value.isWellFormed() || Buffer.byteLength(value) > bytes || /[\x00-\x1f\x7f]/.test(value)) return fail('invalid_input');
  return value;
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return fail('invalid_input'); return value;
}
function digest(value: unknown): string { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) return fail('invalid_input'); return value; }
function evidence(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > MEMORY_LEDGER_LIMITS.evidenceRefs) return fail('invalid_input');
  const refs = value.map(ref => identifier(ref, 512));
  if (new Set(refs).size !== refs.length) return fail('invalid_input'); return refs.sort();
}
function content(value: unknown): string {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || Buffer.byteLength(value) > MEMORY_LEDGER_LIMITS.contentBytes) return fail('invalid_input'); return value;
}
function namespaceID(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,261}$/.test(value)) return fail('invalid_input'); return value;
}
export function memoryProjectionOperationKey(operationKey:string):string { return `mlp1_${sha256('memory-ledger-projection-v1:'+identifier(operationKey,512))}`; }
/** Immutable URI, complete UTF-8 record identity; revision and hash make overwrite unnecessary. */
export function memoryProjectionURI(userId: string, recordId: string, revision: number, hash: string): string {
  return `viking://user/${namespaceID(userId)}/resources/dexter/memory/rec1_${Buffer.from(identifier(recordId),'utf8').toString('hex')}/v${integer(revision,1)}-${digest(hash)}.md`;
}

/** Trusted administration only. Every mutation runs through ContextHost's existing SQLite transaction/writer. */
export class MemoryLedgerStore {
  constructor(private readonly db: DatabaseSync, private readonly host: HostStore,
    private readonly write: <T>(operation: () => T) => T, private readonly mapper?: MemoryIdentityMapper) {}
  private read<T>(fn: () => T): T { return this.host.withWriterLease(fn); }
  private one(sql: string, ...args: SQLInputValue[]): Row | undefined { this.host.assertActiveWriter(); return this.db.prepare(sql).get(...args) as Row | undefined; }
  private all(sql: string, ...args: SQLInputValue[]): Row[] { this.host.assertActiveWriter(); return this.db.prepare(sql).all(...args) as Row[]; }
  private run(sql: string, ...args: SQLInputValue[]): void { this.host.assertActiveWriter(); this.db.prepare(sql).run(...args); }
  private own(botId: string): void { const bot = this.host.getBot(identifier(botId)); if (bot.ownerId !== this.host.ownerId) fail('forbidden'); }
  private scope(value: MemoryLedgerScope, botId: string): string {
    this.own(botId);
    if (!value || !['bot','confidential'].includes(value.kind) || value.botId !== botId || Object.keys(value).sort().join(',') !== 'botId,kind') return fail('forbidden');
    return `${value.kind}:${botId}`;
  }
  private identity(botId: string): MemorySubjectIdentity {
    this.own(botId);
    const row = this.one('SELECT * FROM memory_subjects WHERE bot_id=?', botId);
    if (!row) return fail('conflict', 'memory identity is not provisioned');
    return {botId, mapperVersion:Number(row.mapper_version), workspaceId:String(row.workspace_id), accountId:String(row.account_id), userId:String(row.user_id)};
  }
  provisionBotSubject(botId: string): MemorySubjectIdentity {
    return this.write(() => {
      this.own(botId);
      if (!this.mapper) return fail('conflict', 'trusted memory identity mapper is unconfigured');
      const mapped = this.mapper(botId);
      if (mapped.botId !== botId) return fail('forbidden');
      const fixed: MemorySubjectIdentity = {botId,mapperVersion:integer(mapped.mapperVersion,1),workspaceId:identifier(mapped.workspaceId),accountId:namespaceID(mapped.accountId),userId:namespaceID(mapped.userId)};
      if(fixed.mapperVersion!==1||fixed.accountId!==`dx1_${Buffer.from(fixed.workspaceId).toString('hex')}`||fixed.userId!==`bot1_${Buffer.from(botId).toString('hex')}`)fail('invalid_input','unsupported deterministic memory mapper');
      const previous = this.one('SELECT * FROM memory_subjects WHERE bot_id=?',botId);
      if (previous) { if (canonical(this.identity(botId)) !== canonical(fixed)) fail('conflict','stable memory identity cannot be rebound'); return fixed; }
      if (this.one('SELECT bot_id FROM memory_subjects WHERE user_id=?',fixed.userId)) fail('conflict','memory user identity is already bound');
      this.run('INSERT INTO memory_subjects VALUES (?,?,?,?,?,?)',botId,fixed.workspaceId,fixed.accountId,fixed.userId,fixed.mapperVersion,this.host.now());
      for (const kind of ['bot','confidential']) this.run('INSERT INTO memory_scopes VALUES (?,0)',`${kind}:${botId}`);
      return fixed;
    });
  }
  subject(botId: string): MemorySubjectIdentity { return this.read(() => this.identity(botId)); }
  private epoch(scopeKey: string): number { const row=this.one('SELECT epoch FROM memory_scopes WHERE scope_key=?',scopeKey); if(!row)return fail('conflict','memory scope is not provisioned');return Number(row.epoch); }
  scopeEpoch(scope: MemoryLedgerScope): number { return this.read(()=>this.epoch(this.scope(scope,scope.botId))); }
  private guardEpoch(scopeKey: string, epoch: number): void { if(this.epoch(scopeKey)!==integer(epoch))fail('conflict','memory policy epoch changed'); }
  private invalidate(scopeKey: string): void {
    this.run("UPDATE memory_candidates SET state='withdrawn' WHERE scope_key=? AND state='pending'",scopeKey);
    this.run("UPDATE memory_jobs SET state='withdrawn',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE scope_key=? AND state IN ('queued','claimed','unknown')",this.host.now(),scopeKey);
    this.run("UPDATE memory_projection_outbox SET state='withdrawn',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE scope_key=? AND operation='create' AND state NOT IN ('confirmed','conflict','withdrawn')",this.host.now(),scopeKey);
  }
  advanceScopeEpoch(scope: MemoryLedgerScope, expectedEpoch: number): number {
    return this.write(()=>{const key=this.scope(scope,scope.botId);this.guardEpoch(key,expectedEpoch);const next=expectedEpoch+1;integer(next);this.run('UPDATE memory_scopes SET epoch=? WHERE scope_key=?',next,key);this.invalidate(key);return next;});
  }
  private head(recordId: string): Row | undefined { return this.one('SELECT * FROM memory_records WHERE id=?',recordId); }
  private guardHead(recordId: string, botId: string, scopeKey: string, expected: number): void {
    const row=this.head(recordId);integer(expected);
    if(row&&(row.bot_id!==botId||row.scope_key!==scopeKey))fail('forbidden');
    if(row?.state==='forgotten'||Number(row?.head_revision??0)!==expected)fail('conflict','memory head changed or forgotten');
  }
  private guardSuppressed(scopeKey: string, recordId: string, refs: readonly string[], hash?: string): void {
    for(const tombstone of this.all('SELECT * FROM memory_tombstones WHERE scope_key=?',scopeKey)) {
      const sources=JSON.parse(String(tombstone.evidence_json)) as string[],hashes=JSON.parse(String(tombstone.hashes_json)) as string[];
      if(tombstone.record_id===recordId||refs.some(ref=>sources.includes(ref))||hash!==undefined&&hashes.includes(hash))fail('conflict','memory suppression blocks this source or content');
    }
  }
  private replay<T>(operationKey: string, kind: string, input: unknown): T | null {
    const row=this.one('SELECT * FROM memory_ledger_operations WHERE operation_key=?',operationKey);
    if(!row)return null;
    if(row.kind!==kind||row.request_hash!==sha256(canonical(input)))fail('conflict','operation key is bound to another request');
    return JSON.parse(String(row.receipt_json)) as T;
  }
  private receipt(operationKey: string, kind: string, input: unknown, output: unknown): void {
    this.run('INSERT INTO memory_ledger_operations VALUES (?,?,?,?,?,?)',operationKey,kind,sha256(canonical(input)),canonical(input),canonical(output),this.host.now());
  }
  private revisionInput(input: MemoryRevisionInput) {
    const fixed={recordId:identifier(input.recordId),botId:identifier(input.botId),scope:input.scope,kind:identifier(input.kind,64),expectedRevision:integer(input.expectedRevision),policyEpoch:integer(input.policyEpoch),
      content:content(input.content),evidenceRefs:evidence(input.evidenceRefs),operationKey:identifier(input.operationKey,512),validFrom:input.validFrom==null?null:integer(input.validFrom),validUntil:input.validUntil==null?null:integer(input.validUntil),candidateId:input.candidateId===undefined?null:identifier(input.candidateId)};
    if(fixed.validUntil!==null&&fixed.validFrom!==null&&fixed.validUntil<fixed.validFrom)fail('invalid_input');
    return fixed;
  }
  private accept(input: MemoryRevisionInput): MemoryLedgerAccepted {
    const fixed=this.revisionInput(input),scopeKey=this.scope(fixed.scope,fixed.botId),identity=this.identity(fixed.botId);
    const previous=this.replay<MemoryLedgerAccepted>(fixed.operationKey,'accept_revision',fixed);if(previous)return previous;
    this.guardEpoch(scopeKey,fixed.policyEpoch);this.guardHead(fixed.recordId,fixed.botId,scopeKey,fixed.expectedRevision);
    const hash=sha256(fixed.content);this.guardSuppressed(scopeKey,fixed.recordId,fixed.evidenceRefs,hash);
    if(fixed.candidateId!==null){
      const row=this.one('SELECT * FROM memory_candidates WHERE id=?',fixed.candidateId);
      if(!row||row.state!=='pending'||row.bot_id!==fixed.botId||row.scope_key!==scopeKey||row.record_id!==fixed.recordId||row.expected_revision!==fixed.expectedRevision||row.policy_epoch!==fixed.policyEpoch||row.content!==fixed.content||row.evidence_json!==canonical(fixed.evidenceRefs))fail('conflict','candidate is not the reviewed version');
    }
    const revision=fixed.expectedRevision+1,now=this.host.now(),projectionOperationKey=memoryProjectionOperationKey(fixed.operationKey);
    const uri=memoryProjectionURI(identity.userId,fixed.recordId,revision,hash);
    if(fixed.expectedRevision===0)this.run('INSERT INTO memory_records VALUES (?,?,?,?,?,?,?)',fixed.recordId,fixed.botId,scopeKey,fixed.kind,revision,'active',now);
    else{
      if(this.head(fixed.recordId)!.kind!==fixed.kind)fail('conflict','memory kind is stable');
      this.run("UPDATE memory_records SET head_revision=?,state='active' WHERE id=?",revision,fixed.recordId);
    }
    this.run('INSERT INTO memory_revisions VALUES (?,?,?,?,?,?,?,?,?,?,?)',fixed.recordId,revision,fixed.content,hash,canonical(fixed.evidenceRefs),fixed.policyEpoch,fixed.validFrom,fixed.validUntil,fixed.expectedRevision===0?null:fixed.expectedRevision,fixed.operationKey,now);
    // The intent and accepted revision have one Context transaction; a collision rolls back both.
    this.run('INSERT INTO memory_projection_outbox VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',projectionOperationKey,fixed.operationKey,fixed.recordId,revision,scopeKey,fixed.policyEpoch,identity.accountId,identity.userId,uri,hash,'create','queued',null,null,0,now,now);
    if(fixed.candidateId!==null)this.run("UPDATE memory_candidates SET state='accepted' WHERE id=?",fixed.candidateId);
    const output={recordId:fixed.recordId,revision,sha256:hash,operationKey:fixed.operationKey,projectionOperationKey,uri,policyEpoch:fixed.policyEpoch};
    this.receipt(fixed.operationKey,'accept_revision',fixed,output);return output;
  }
  acceptRevision(input: MemoryRevisionInput): MemoryLedgerAccepted { return this.write(()=>this.accept(input)); }
  createCandidate(input: MemoryCandidateInput): {candidateId:string;state:'pending'} {
    return this.write(()=>{
      const fixed={scope:input.scope,candidateId:identifier(input.candidateId),recordId:identifier(input.recordId),botId:identifier(input.botId),content:content(input.content),evidenceRefs:evidence(input.evidenceRefs),expectedRevision:integer(input.expectedRevision),policyEpoch:integer(input.policyEpoch),extractorVersion:identifier(input.extractorVersion),operationKey:identifier(input.operationKey,512)};
      const key=this.scope(fixed.scope,fixed.botId);this.identity(fixed.botId);
      const previous=this.replay<{candidateId:string;state:'pending'}>(fixed.operationKey,'candidate',fixed);if(previous)return previous;
      this.guardEpoch(key,fixed.policyEpoch);this.guardHead(fixed.recordId,fixed.botId,key,fixed.expectedRevision);this.guardSuppressed(key,fixed.recordId,fixed.evidenceRefs,sha256(fixed.content));
      this.run('INSERT INTO memory_candidates VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',fixed.candidateId,fixed.botId,key,fixed.recordId,fixed.content,sha256(fixed.content),canonical(fixed.evidenceRefs),fixed.expectedRevision,fixed.policyEpoch,fixed.extractorVersion,'pending',fixed.operationKey,this.host.now());
      const output={candidateId:fixed.candidateId,state:'pending' as const};this.receipt(fixed.operationKey,'candidate',fixed,output);return output;
    });
  }
  enqueueJob(input: MemoryJobInput): {jobId:string} {
    return this.write(()=>{
      const fixed={scope:input.scope,jobId:identifier(input.jobId),recordId:identifier(input.recordId),botId:identifier(input.botId),kind:identifier(input.kind,64),inputHash:digest(input.inputHash),evidenceRefs:evidence(input.evidenceRefs),expectedRevision:integer(input.expectedRevision),policyEpoch:integer(input.policyEpoch),configVersion:identifier(input.configVersion),operationKey:identifier(input.operationKey,512)};
      const key=this.scope(fixed.scope,fixed.botId);this.identity(fixed.botId);
      const previous=this.replay<{jobId:string}>(fixed.operationKey,'job',fixed);if(previous)return previous;
      this.guardEpoch(key,fixed.policyEpoch);this.guardHead(fixed.recordId,fixed.botId,key,fixed.expectedRevision);this.guardSuppressed(key,fixed.recordId,fixed.evidenceRefs);
      const now=this.host.now();this.run('INSERT INTO memory_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',fixed.jobId,fixed.botId,key,fixed.recordId,fixed.kind,fixed.inputHash,canonical(fixed.evidenceRefs),fixed.expectedRevision,fixed.policyEpoch,fixed.configVersion,fixed.operationKey,'queued',null,null,0,0,null,now,now);
      const output={jobId:fixed.jobId};this.receipt(fixed.operationKey,'job',fixed,output);return output;
    });
  }
  claimJob(jobId: string, workerId: string, leaseMs = 30_000): MemoryJobClaim {
    return this.write(()=>{
      identifier(jobId);identifier(workerId);integer(leaseMs,1);if(leaseMs>MEMORY_LEDGER_LIMITS.leaseMs)fail('invalid_input');
      const row=this.one('SELECT * FROM memory_jobs WHERE id=?',jobId);if(!row)return fail('not_found');this.own(String(row.bot_id));
      if(!['queued','claimed'].includes(String(row.state))||row.state==='claimed'&&Number(row.lease_until)>this.host.now())fail('conflict','job is leased or terminal');
      this.guardEpoch(String(row.scope_key),Number(row.policy_epoch));this.guardHead(String(row.record_id),String(row.bot_id),String(row.scope_key),Number(row.expected_revision));this.guardSuppressed(String(row.scope_key),String(row.record_id),JSON.parse(String(row.evidence_json)) as string[]);
      const fence=Number(row.fence)+1,leaseUntil=this.host.now()+leaseMs;integer(fence,1);integer(leaseUntil);
      this.run("UPDATE memory_jobs SET state='claimed',lease_owner=?,lease_until=?,fence=?,attempts=attempts+1,updated_at=? WHERE id=?",workerId,leaseUntil,fence,this.host.now(),jobId);
      return {jobId,workerId,fence,leaseUntil};
    });
  }
  private guardJob(claim: MemoryJobClaim): Row {
    const row=this.one('SELECT * FROM memory_jobs WHERE id=?',identifier(claim.jobId));if(!row)return fail('not_found');this.own(String(row.bot_id));
    if(row.state!=='claimed'||row.lease_owner!==claim.workerId||row.fence!==claim.fence||row.lease_until!==claim.leaseUntil||Number(row.lease_until)<=this.host.now())fail('conflict','stale job lease/fence');
    this.guardEpoch(String(row.scope_key),Number(row.policy_epoch));this.guardHead(String(row.record_id),String(row.bot_id),String(row.scope_key),Number(row.expected_revision));
    this.guardSuppressed(String(row.scope_key),String(row.record_id),JSON.parse(String(row.evidence_json)) as string[]);return row;
  }
  commitJobRevision(claim: MemoryJobClaim, input: MemoryRevisionInput): MemoryLedgerAccepted {
    return this.write(()=>{
      const fixed=this.revisionInput(input),previous=this.replay<MemoryLedgerAccepted>(fixed.operationKey,'accept_revision',fixed);
      const job=this.one('SELECT * FROM memory_jobs WHERE id=?',identifier(claim.jobId));
      if(previous&&job?.state==='committed'&&job.committed_operation_key===fixed.operationKey)return previous;
      const row=this.guardJob(claim),key=this.scope(fixed.scope,fixed.botId);
      if(row.bot_id!==fixed.botId||row.record_id!==fixed.recordId||row.scope_key!==key||row.expected_revision!==fixed.expectedRevision||row.policy_epoch!==fixed.policyEpoch||row.evidence_json!==canonical(fixed.evidenceRefs))fail('conflict','job result does not match its bound input');
      const result=this.accept(input);this.run("UPDATE memory_jobs SET state='committed',committed_operation_key=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?",fixed.operationKey,this.host.now(),claim.jobId);return result;
    });
  }
  markJobUnknown(claim: MemoryJobClaim): void { this.write(()=>{this.guardJob(claim);this.run("UPDATE memory_jobs SET state='unknown',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?",this.host.now(),claim.jobId);}); }
  revisionMetadata(recordId: string, revision?: number): Omit<MemoryLedgerAccepted,'projectionOperationKey'|'uri'> & {state:string} {
    return this.read(()=>{const head=this.head(identifier(recordId));if(!head)return fail('not_found');this.own(String(head.bot_id));const row=this.one('SELECT * FROM memory_revisions WHERE record_id=? AND revision=?',recordId,revision===undefined?Number(head.head_revision):integer(revision,1));if(!row)return fail('not_found');return {recordId,revision:Number(row.revision),sha256:String(row.content_hash),operationKey:String(row.operation_key),policyEpoch:Number(row.policy_epoch),state:String(head.state)};});
  }
  readRevision(recordId: string, revision?: number): {content:string;evidenceRefs:string[];sha256:string;revision:number} {
    return this.read(()=>{const head=this.head(identifier(recordId));if(!head)return fail('not_found');this.own(String(head.bot_id));if(head.state==='forgotten')fail('forbidden','forgotten bytes are historical backup data only');
      const row=this.one('SELECT * FROM memory_revisions WHERE record_id=? AND revision=?',recordId,revision===undefined?Number(head.head_revision):integer(revision,1));if(!row)return fail('not_found');return {content:String(row.content),evidenceRefs:JSON.parse(String(row.evidence_json)) as string[],sha256:String(row.content_hash),revision:Number(row.revision)};});
  }
  private reference(row:Row):MemoryRecordReference {
    const botId=String(row.bot_id),key=String(row.scope_key),scope:MemoryLedgerScope={kind:key.startsWith('confidential:')?'confidential':'bot',botId};
    return {recordId:String(row.id),botId,scope,kind:String(row.kind),state:row.state as MemoryRecordReference['state'],revision:Number(row.head_revision),sha256:String(row.content_hash),policyEpoch:Number(row.policy_epoch),scopeEpoch:this.epoch(key),createdAt:Number(row.created_at)};
  }
  /** Bounded metadata inventory for the trusted composer. This is not a policy/capability authorization. */
  listRecordReferences(botId:string,query:{scopeKind?:'bot'|'confidential';includeInactive?:boolean;after?:string;limit?:number}={}):{items:MemoryRecordReference[];nextCursor:string|null} {
    return this.read(()=>{
      this.own(botId);this.identity(botId);const limit=integer(query.limit??20,1);if(limit>100)fail('invalid_input');
      if(query.scopeKind!==undefined&&!['bot','confidential'].includes(query.scopeKind)||query.includeInactive!==undefined&&typeof query.includeInactive!=='boolean')fail('invalid_input');
      const after=query.after===undefined?'':identifier(query.after),scopes=query.scopeKind===undefined?[`bot:${botId}`,`confidential:${botId}`]:[`${query.scopeKind}:${botId}`];
      const rows=this.all(`SELECT m.*,r.content_hash,r.policy_epoch FROM memory_records m JOIN memory_revisions r ON r.record_id=m.id AND r.revision=m.head_revision WHERE m.bot_id=? AND m.scope_key IN (${scopes.map(()=>'?').join(',')}) AND m.id>? ${query.includeInactive?'':"AND m.state='active' AND (r.valid_from IS NULL OR r.valid_from<=?) AND (r.valid_until IS NULL OR r.valid_until>?) AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.record_id=m.id)"} ORDER BY m.id LIMIT ?`,botId,...scopes,after,...(query.includeInactive?[]:[this.host.now(),this.host.now()]),limit+1);
      return {items:rows.slice(0,limit).map(row=>this.reference(row)),nextCursor:rows.length>limit?String(rows[limit-1]!.id):null};
    });
  }
  /** Revalidate after every asynchronous backend call before exposing any bytes, summaries or citations. */
  readActiveReference(botId:string,input:MemoryActiveReferenceInput):MemoryRecordReference&{content:string;evidenceRefs:string[]} {
    return this.read(()=>{
      this.own(botId);this.identity(botId);const recordId=identifier(input.recordId),row=this.one('SELECT m.*,r.content,r.content_hash,r.evidence_json,r.policy_epoch,r.valid_from,r.valid_until FROM memory_records m JOIN memory_revisions r ON r.record_id=m.id AND r.revision=m.head_revision WHERE m.id=?',recordId);
      if(!row)return fail('not_found');if(row.bot_id!==botId)fail('forbidden');
      if(row.state!=='active'||row.head_revision!==integer(input.revision,1)||row.content_hash!==digest(input.sha256)||this.epoch(String(row.scope_key))!==integer(input.scopeEpoch)||this.one('SELECT record_id FROM memory_tombstones WHERE record_id=?',recordId)||row.valid_from!==null&&Number(row.valid_from)>this.host.now()||row.valid_until!==null&&Number(row.valid_until)<=this.host.now())fail('conflict','memory reference is no longer active');
      const bytes=content(row.content),refs=evidence(JSON.parse(String(row.evidence_json)) as string[]);
      if(sha256(bytes)!==row.content_hash||canonical(refs)!==row.evidence_json)fail('tampered','canonical memory bytes or evidence changed');
      return {...this.reference(row),content:bytes,evidenceRefs:refs};
    });
  }
  /** Includes durable unknown/dispatched work for GET-only reconciliation; no delete executor is implied. */
  listPendingProjections(botId:string,query:{limit?:number;after?:string}={}):{items:MemoryPendingProjection[];nextCursor:string|null} {
    return this.read(()=>{
      this.own(botId);this.identity(botId);const limit=integer(query.limit??20,1);if(limit>100)fail('invalid_input');const after=query.after===undefined?'':identifier(query.after,1024);
      const rows=this.all("SELECT p.*,s.epoch AS scope_epoch FROM memory_projection_outbox p JOIN memory_records m ON m.id=p.record_id JOIN memory_scopes s ON s.scope_key=p.scope_key JOIN memory_revisions r ON r.record_id=p.record_id AND r.revision=p.revision WHERE m.bot_id=? AND m.state='active' AND m.head_revision=p.revision AND p.operation='create' AND p.state IN ('queued','dispatched','unknown') AND p.policy_epoch=s.epoch AND (p.lease_until IS NULL OR p.lease_until<=?) AND (r.valid_from IS NULL OR r.valid_from<=?) AND (r.valid_until IS NULL OR r.valid_until>?) AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.record_id=m.id) AND p.operation_key>? ORDER BY p.operation_key LIMIT ?",botId,this.host.now(),this.host.now(),this.host.now(),after,limit+1);
      const items=rows.slice(0,limit).map(row=>({operationKey:String(row.operation_key),accountId:String(row.account_id),userId:String(row.user_id),recordId:String(row.record_id),revision:Number(row.revision),uri:String(row.uri),sha256:String(row.content_hash),state:row.state as MemoryPendingProjection['state'],policyEpoch:Number(row.policy_epoch),scopeEpoch:Number(row.scope_epoch)}));
      return {items,nextCursor:rows.length>limit?String(rows[limit-1]!.operation_key):null};
    });
  }
  private binding(value: MemoryProjectionBinding): MemoryProjectionBinding {
    return {operationKey:identifier(value.operationKey,1024),accountId:namespaceID(value.accountId),userId:namespaceID(value.userId),recordId:identifier(value.recordId),revision:integer(value.revision,1),uri:identifier(value.uri,2048),sha256:digest(value.sha256)};
  }
  private projection(binding: MemoryProjectionBinding): Row {
    const row=this.one('SELECT * FROM memory_projection_outbox WHERE operation_key=?',binding.operationKey);if(!row)return fail('not_found');
    if(row.operation!=='create'||row.account_id!==binding.accountId||row.user_id!==binding.userId||row.record_id!==binding.recordId||row.revision!==binding.revision||row.uri!==binding.uri||row.content_hash!==binding.sha256)fail('conflict','projection binding mismatch');
    const head=this.head(binding.recordId);if(!head)return fail('tampered');this.own(String(head.bot_id));
    if(head.state==='forgotten'||head.head_revision!==binding.revision||row.state==='withdrawn')fail('conflict','projection is superseded or forgotten');
    this.guardEpoch(String(row.scope_key),Number(row.policy_epoch));return row;
  }
  /** One journal belongs to one worker. Dispatch is durable before HTTP; restart/unknown always reconciles via GET. */
  projectionJournal(workerId: string, leaseMs = 30_000): MemoryProjectionJournal {
    identifier(workerId);integer(leaseMs,1);if(leaseMs>MEMORY_LEDGER_LIMITS.leaseMs)fail('invalid_input');
    const claims=new Map<string,{fence:number;binding:MemoryProjectionBinding}>();
    return {
      claim:async value=>this.write(()=>{
        const binding=this.binding(value),row=this.projection(binding);
        if(row.state==='conflict')fail('conflict','projection conflict needs host review');
        if(row.lease_owner!==null&&Number(row.lease_until)>this.host.now())fail('conflict','projection is leased');
        const fence=Number(row.fence)+1,send=row.state==='queued';integer(fence,1);
        this.run('UPDATE memory_projection_outbox SET state=?,lease_owner=?,lease_until=?,fence=?,updated_at=? WHERE operation_key=?',send?'dispatched':String(row.state),workerId,this.host.now()+leaseMs,fence,this.host.now(),binding.operationKey);
        claims.set(binding.operationKey,{fence,binding});return send?'send':'reconcile';
      }),
      record:async value=>this.write(()=>{
        const binding=this.binding(value),claim=claims.get(binding.operationKey);if(!claim||canonical(claim.binding)!==canonical(binding))return fail('conflict','receipt has no matching worker claim');
        const row=this.projection(binding);
        if(row.lease_owner!==workerId||row.fence!==claim.fence||Number(row.lease_until)<=this.host.now())fail('conflict','stale projection lease/fence');
        if(!['confirmed','unknown','conflict'].includes(value.outcome)||value.indexing!=='unproven')fail('invalid_input');
        if(row.state==='confirmed'&&value.outcome!=='confirmed')fail('conflict','a confirmed receipt cannot be downgraded by replay');
        const taskId=value.taskId===null?null:identifier(value.taskId,512),reason=value.reason===null?null:identifier(value.reason,128);
        this.run('INSERT INTO memory_projection_receipts VALUES (?,?,?,?,?,?,?,?)',binding.operationKey,claim.fence,canonical(binding),value.outcome,'unproven',taskId,reason,this.host.now());
        this.run('UPDATE memory_projection_outbox SET state=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE operation_key=?',value.outcome,this.host.now(),binding.operationKey);
        claims.delete(binding.operationKey);
      }),
    };
  }
  projectionBinding(operationKey: string): MemoryProjectionBinding {
    return this.read(()=>{const row=this.one('SELECT * FROM memory_projection_outbox WHERE operation_key=?',identifier(operationKey,1024));if(!row)return fail('not_found');const head=this.head(String(row.record_id));if(!head)return fail('tampered');this.own(String(head.bot_id));return {operationKey:String(row.operation_key),accountId:String(row.account_id),userId:String(row.user_id),recordId:String(row.record_id),revision:Number(row.revision),uri:String(row.uri),sha256:String(row.content_hash)};});
  }
  forgetRecord(input: {recordId:string;expectedRevision:number;policyEpoch:number;operationKey:string;suppressionSignature:string}): {recordId:string;epoch:number;purgePending:number} {
    return this.write(()=>{
      const fixed={recordId:identifier(input.recordId),expectedRevision:integer(input.expectedRevision,1),policyEpoch:integer(input.policyEpoch),operationKey:identifier(input.operationKey,512),suppressionSignature:identifier(input.suppressionSignature,512)};
      const previous=this.replay<{recordId:string;epoch:number;purgePending:number}>(fixed.operationKey,'forget',fixed);if(previous)return previous;
      const head=this.head(fixed.recordId);if(!head)return fail('not_found');this.own(String(head.bot_id));const key=String(head.scope_key);
      this.guardEpoch(key,fixed.policyEpoch);this.guardHead(fixed.recordId,String(head.bot_id),key,fixed.expectedRevision);
      const revisions=this.all('SELECT * FROM memory_revisions WHERE record_id=? ORDER BY revision',fixed.recordId),refs=[...new Set(revisions.flatMap(row=>JSON.parse(String(row.evidence_json)) as string[]))].sort(),hashes=[...new Set(revisions.map(row=>String(row.content_hash)))].sort(),epoch=fixed.policyEpoch+1,now=this.host.now();
      integer(epoch,1);this.run('INSERT INTO memory_tombstones VALUES (?,?,?,?,?,?,?,?)',fixed.recordId,key,epoch,canonical(refs),canonical(hashes),fixed.suppressionSignature,fixed.operationKey,now);
      this.run("UPDATE memory_records SET state='forgotten' WHERE id=?",fixed.recordId);this.run('UPDATE memory_scopes SET epoch=? WHERE scope_key=?',epoch,key);this.invalidate(key);
      let purgePending=0;
      for(const row of this.all("SELECT * FROM memory_projection_outbox WHERE record_id=? AND operation='create'",fixed.recordId)){
        // A delete gets a distinct durable key and URI slot. It is intentionally not executable by the create adapter.
        const operationKey=`${fixed.operationKey}:purge:${row.revision}`;
        this.run('INSERT INTO memory_projection_outbox VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',operationKey,String(row.revision_operation_key),fixed.recordId,Number(row.revision),key,epoch,String(row.account_id),String(row.user_id),String(row.uri),String(row.content_hash),'delete','queued',null,null,0,now,now);purgePending++;
      }
      const output={recordId:fixed.recordId,epoch,purgePending};this.receipt(fixed.operationKey,'forget',fixed,output);return output;
    });
  }
  status(): {version:1;identityMapper:'injected'|'unconfigured';automaticCapture:false;remotePurge:'not_implemented';counts:Record<string,number>} {
    return this.read(()=>({version:1,identityMapper:this.mapper?'injected':'unconfigured',automaticCapture:false,remotePurge:'not_implemented',counts:Object.fromEntries(MEMORY_LEDGER_TABLES.map(table=>[table,Number(this.one(`SELECT COUNT(*) AS n FROM ${table}`)!.n)]))}));
  }
}
