import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MEMORY_ROUTINE_META_KEY, MEMORY_ROUTINE_METADATA_BYTES, MemoryRoutineMetadataSchema, MemoryRoutinePolicyInputSchema,
  type MemoryRoutineMetadata, type MemoryRoutinePolicy, type JsonValue, ToolRequestSchema } from '@dexter/contracts';
import { canonicalJson, hashRequest } from '@dexter/hub';
import { fail } from './errors.js';
import type { GitSnapshot } from './git.js';
import { all, one } from './schemas.js';

const POLICY_TOOL = 'dexter.memory.policy.update', DESTINATION = 'dexter-memory-routines', HARNESS = 'dexter-harness-owner-proposals';
const canonical = (value: unknown): string => canonicalJson(value as JsonValue);
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const credentialShaped = (text: string): boolean => /(?:\b(?:sk-|sk_live_|sk_test_|github_pat_|gh[pousr]_|xox[abprs]-|glpat-|AIza|AKIA|ASIA|ya29\.)[A-Za-z0-9_+=./-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|passphrase)\s*[:=]\s*["']?(?:Bearer\s+)?[A-Za-z0-9_+=./-]{12,})/i.test(text);
const broken = (): never => fail('reference_broken', 'Memory routine provenance is not valid.');
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return broken();
  return value as Record<string, unknown>;
};
const keys = (value: unknown, expected: string): Record<string, unknown> => {
  const result = record(value); if (Object.keys(result).sort().join(',') !== expected) broken(); return result;
};
const duplicateRemoval = (text: string): string => {
  const seen = new Set<string>();
  return text.split('\n\n').filter(block => { if (!block) return true; if (seen.has(block)) return false; seen.add(block); return true; }).join('\n\n');
};

/** Optional typed registry in Context.meta. This admits no SQL, extra key, permission or second writer. */
export function readMemoryRoutineMetadata(db: DatabaseSync): MemoryRoutineMetadata | null {
  const raw = one(db, 'SELECT value FROM meta WHERE key=?', MEMORY_ROUTINE_META_KEY)?.value;
  if (raw === undefined) return null;
  if (!['2','3'].includes(String(one(db, "SELECT value FROM meta WHERE key='schema'")?.value))) fail('unsupported_schema', 'Memory routines require Context document history.');
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MEMORY_ROUTINE_METADATA_BYTES) fail('corrupt', 'Memory routine registry exceeds its bound.');
  let value: unknown; try { value = JSON.parse(raw); } catch { return fail('corrupt', 'Memory routine registry is not JSON.'); }
  const parsed = MemoryRoutineMetadataSchema.safeParse(value);
  if (!parsed.success || canonical(parsed.data) !== raw) return fail('corrupt', 'Memory routine registry is not closed canonical data.');
  const data = parsed.data, ownCounts = new Map<string, number>();
  for (const [id, job] of Object.entries(data.jobs)) {
    if (id !== job.id || job.updatedAt < job.createdAt) broken();
    ownCounts.set(job.botId, (ownCounts.get(job.botId) ?? 0) + 1);
  }
  if ([...ownCounts.values()].some(n => n > 16)) fail('corrupt', 'Memory routine per-bot journal exceeds its bound.');
  for (const [id, receipt] of Object.entries(data.receipts)) if (id !== receipt.actionId) broken();
  return data;
}

/** Cross-store and Git byte checks run on bounded staged copies after the existing document ledger validator. */
export function validateMemoryRoutines(db: DatabaseSync, hub: DatabaseSync, git: GitSnapshot): void {
  const data = readMemoryRoutineMetadata(db); if (!data) return;
  const owner = one(db, "SELECT value FROM meta WHERE key='owner'")?.value;
  const installation = one(db, "SELECT value FROM meta WHERE key='installation'")?.value;
  const ownBot = (botId: string) => { const bot = one(hub, 'SELECT * FROM bots WHERE id=? AND owner_id=?', botId, String(owner)); if (!bot) broken(); return bot!; };
  const actionOf = (actionId: string, botId: string) => {
    const action = one(hub, 'SELECT * FROM actions WHERE id=? AND bot_id=?', actionId, botId);
    if (!action) return broken();
    let request: unknown; try { request = JSON.parse(String(action.request)); } catch { return broken(); }
    const parsed = ToolRequestSchema.safeParse(request);
    if (!parsed.success || hashRequest(parsed.data) !== action.request_hash || canonical(parsed.data) !== action.request) return broken();
    const origin = one(hub, 'SELECT * FROM tool_action_continuations WHERE action_id=?', actionId);
    const turn = origin ? one(hub, 'SELECT * FROM turns WHERE id=? AND bot_id=? AND thread_id=?', String(origin.origin_turn_id), botId, String(action.thread_id)) : null;
    const inputMessage = turn ? one(hub, "SELECT * FROM messages WHERE id=? AND thread_id=? AND role='user'", String(turn.input_message_id), String(turn.thread_id)) : null;
    if (!origin || !turn || !inputMessage || parsed.data.botId !== botId || parsed.data.threadId !== turn.thread_id || parsed.data.tool !== action.tool || parsed.data.destination !== action.destination) return broken();
    return { action, origin, turn, request: parsed.data, args: record(parsed.data.arguments) };
  };
  const history = new Map<string, Map<number, MemoryRoutinePolicy>>(); let reserveDisableReceipts = 0;
  for (const receipt of Object.values(data.receipts)) {
    ownBot(receipt.botId);
    const { action, origin, args } = actionOf(receipt.actionId, receipt.botId);
    const authorization = one(hub, "SELECT * FROM action_authorizations WHERE action_id=? AND source='exact_owner'", receipt.actionId);
    const parsed = MemoryRoutinePolicyInputSchema.safeParse(args.input), pin = keys(args.pin, 'botRevision,epoch,profileId,revision');
    const policy = receipt.policy;
    const normalizedInput = parsed.success ? { enabled: parsed.data.enabled, maintenanceEnabled: parsed.data.maintenanceEnabled, minIntervalMs: parsed.data.minIntervalMs,
      maxNotesPerDay: parsed.data.maxNotesPerDay, maxNoteCharacters: parsed.data.maxNoteCharacters } : null;
    if (Object.keys(args).sort().join(',') !== 'input,pin' || !parsed.success || action.tool !== POLICY_TOOL || action.destination !== DESTINATION
      || action.decided_by !== owner || authorization?.owner_id !== owner || receipt.ownerId !== owner || receipt.actionRequestHash !== action.request_hash
      || receipt.inputHash !== sha(canonical(parsed.data)) || receipt.previousRevision !== parsed.data.expectedRevision
      || policy.actionId !== receipt.actionId || policy.revision !== receipt.previousRevision + 1 || policy.epoch !== policy.revision
      || pin.revision !== receipt.previousRevision || pin.epoch !== receipt.previousRevision || pin.botRevision !== policy.botRevision || pin.profileId !== policy.profileId
      || origin.profile_id !== policy.profileId || policy.grantRevision !== action.grant_revision
      || receipt.committedAt < policy.updatedAt || policy.updatedAt < Number(action.created_at)
      || canonical(normalizedInput) !== canonical({ enabled: policy.enabled, maintenanceEnabled: policy.maintenanceEnabled, minIntervalMs: policy.minIntervalMs, maxNotesPerDay: policy.maxNotesPerDay, maxNoteCharacters: policy.maxNoteCharacters })) broken();
    const byRevision = history.get(receipt.botId) ?? new Map<number, MemoryRoutinePolicy>();
    if (byRevision.has(policy.revision)) broken(); byRevision.set(policy.revision, policy); history.set(receipt.botId, byRevision);
    if (new Set(receipt.withdrawnJobIds).size !== receipt.withdrawnJobIds.length) broken();
    for (const id of receipt.withdrawnJobIds) { const job = data.jobs[id]; if (!job || job.botId !== receipt.botId || job.policyRevision >= policy.revision || job.updatedAt < receipt.committedAt) broken(); }
  }
  for (const [botId, policy] of Object.entries(data.policies)) {
    ownBot(botId); const byRevision = history.get(botId);
    if (!byRevision || policy.revision < 1 || policy.epoch !== policy.revision || canonical(byRevision.get(policy.revision)) !== canonical(policy) || byRevision.size !== policy.revision) broken();
    for (let revision = 1; revision <= policy.revision; revision++) {
      const item = byRevision!.get(revision); if (!item || item.updatedAt < (byRevision!.get(revision - 1)?.updatedAt ?? 0)) broken();
      if (!item!.enabled && byRevision!.get(revision - 1)?.enabled) reserveDisableReceipts++;
    }
  }
  if ([...history.keys()].some(id => !data.policies[id]) || Object.keys(data.receipts).length - reserveDisableReceipts > 128) broken();
  const documentCache = new Map<string, { soul: string; user: string; memory: string }>();
  const document = (botId: string, revision: number) => {
    if (revision === 0) return { soul: '', user: '', memory: '' };
    const cached = documentCache.get(`${botId}/${revision}`); if (cached) return cached;
    const row = one(db, 'SELECT * FROM bot_document_revisions WHERE bot_id=? AND revision=?', botId, revision); if (!row) return broken();
    const text = (column: string) => { const pin = record(JSON.parse(String(row[column]))); return git.documentText(String(pin.commit), String(pin.path), String(pin.sha256)); };
    const docs = { soul: text('soul_pin_json'), user: text('user_pin_json'), memory: text('memory_pin_json') };
    documentCache.set(`${botId}/${revision}`, docs); return docs;
  };
  const boundActions = new Set<string>();
  for (const job of Object.values(data.jobs)) {
    ownBot(job.botId); const policy = history.get(job.botId)?.get(job.policyRevision);
    if (!policy || !policy.enabled || policy.epoch !== job.epoch || policy.profileId !== job.profileId || policy.botRevision !== job.botRevision || job.createdAt < policy.updatedAt) broken();
    const before = document(job.botId, job.baseRevision);
    if (sha(before.soul) !== job.soulHash || sha(before.user) !== job.userHash || sha(before.memory) !== job.memoryHash) broken();
    if (job.kind === 'capture') {
      const source = job.source; if (!source || job.nextMemoryHash !== null || ['candidate', 'proposed', 'committed'].includes(job.state) && job.note === null
        || ['extracting','empty','invalid','unknown','conflict'].includes(job.state) && job.note !== null) broken();
      const turn = one(hub, "SELECT * FROM turns WHERE id=? AND bot_id=? AND thread_id=? AND state='completed'", source!.turnId, job.botId, source!.threadId);
      const output = one(hub, "SELECT * FROM messages WHERE id=? AND thread_id=? AND role='assistant'", source!.outputMessageId, source!.threadId);
      const input = one(hub, "SELECT * FROM messages WHERE id=? AND thread_id=? AND role='user'", source!.inputMessageId, source!.threadId);
      if (!turn || !output || !input || turn.input_message_id !== source!.inputMessageId || turn.output_message_id !== source!.outputMessageId
        || turn.finished_at !== source!.finishedAt || source!.outputHash !== sha(String(output.content)) || source!.outputCharacters !== String(output.content).length
        || job.createdAt < source!.finishedAt || job.id !== sha(`${installation}/${job.botId}/${job.epoch}/${source!.turnId}`) || credentialShaped(String(output.content))
        || job.note !== null && (job.note.length < 1 || !job.note.trim() || job.note.length > policy!.maxNoteCharacters || credentialShaped(job.note))) broken();
    } else if (job.source !== null || job.note !== null || !policy!.maintenanceEnabled || job.nextMemoryHash === null
      || credentialShaped(before.memory) || job.nextMemoryHash !== sha(duplicateRemoval(before.memory)) || job.nextMemoryHash === job.memoryHash) broken();
    if ((job.actionId === null) !== (job.proposalTurnId === null)) broken();
    if (job.actionId === null) { if (['proposed', 'committed'].includes(job.state)) broken(); continue; }
    if (!['proposed','withdrawn','committed'].includes(job.state)) broken();
    if (boundActions.has(job.actionId)) broken(); boundActions.add(job.actionId);
    const { action, origin, turn, args } = actionOf(job.actionId, job.botId);
    const marker = keys(args.routine, 'jobId,version'), pin = keys(args.pin, 'memoryHash,revision,soulHash,userHash');
    if (Object.keys(args).sort().join(',') !== 'input,pin,routine' || action.destination !== HARNESS || marker.version !== 1 || marker.jobId !== job.id
      || origin.origin_turn_id !== job.proposalTurnId || origin.profile_id !== job.profileId || turn.id !== job.proposalTurnId
      || pin.revision !== job.baseRevision || pin.soulHash !== job.soulHash || pin.userHash !== job.userHash || pin.memoryHash !== job.memoryHash) broken();
    const expected = job.kind === 'capture' ? { expectedRevision: job.baseRevision, note: job.note }
      : { expectedRevision: job.baseRevision, document: 'MEMORY', markdown: duplicateRemoval(before.memory) };
    if (action.tool !== (job.kind === 'capture' ? 'dexter.harness.memory.append' : 'dexter.harness.documents.update') || canonical(args.input) !== canonical(expected)
      || job.kind === 'maintenance' && job.id !== sha(`${job.botId}/${job.epoch}/${job.proposalTurnId}/${job.memoryHash}/${job.nextMemoryHash}`)) broken();
    const receipt = one(db, 'SELECT * FROM bot_document_receipts WHERE bot_id=? AND operation_key=?', job.botId, `action:${job.actionId}`);
    if (receipt) {
      const authorization = one(hub, "SELECT * FROM action_authorizations WHERE action_id=? AND source='exact_owner'", job.actionId);
      const source = record(JSON.parse(String(receipt.origin_json))), after = document(job.botId, Number(receipt.revision));
      if (authorization?.owner_id !== owner || action.decided_by !== owner || source.actionId !== job.actionId || source.turnId !== job.proposalTurnId || source.callId !== origin.call_id
        || sha(after.soul) !== job.soulHash || sha(after.user) !== job.userHash || job.kind === 'maintenance' && sha(after.memory) !== job.nextMemoryHash) broken();
    } else if (job.state === 'committed') broken();
  }
  // An orphan request may exist at the request/bind boundary, but may never carry a document effect.
  for (const row of all(db, "SELECT bot_id,origin_json FROM bot_document_receipts WHERE operation_key GLOB 'action:*'")) {
    const source = record(JSON.parse(String(row.origin_json)));
    const action = one(hub, 'SELECT request FROM actions WHERE id=?', String(source.actionId));
    if (action && record(JSON.parse(String(action.request))).arguments && record(record(JSON.parse(String(action.request))).arguments).routine !== undefined && !boundActions.has(String(source.actionId))) broken();
  }
}

/** Existing checkpoint copy only: retain all history, withdraw in-flight extraction, and deny effective capture. */
export function sanitizeMemoryRoutines(contextPath: string, hubPath: string, capturedAt: number): void {
  const context = new DatabaseSync(contextPath);
  try {
    const data = readMemoryRoutineMetadata(context); if (!data) return;
    for (const job of Object.values(data.jobs)) if (job.state === 'extracting') { job.state = 'unknown'; job.updatedAt = Math.max(job.updatedAt, capturedAt); }
    context.prepare('UPDATE meta SET value=? WHERE key=?').run(canonical(data), MEMORY_ROUTINE_META_KEY);
    const hub = new DatabaseSync(hubPath);
    try {
      hub.prepare("UPDATE grants SET policy='deny',revision=revision+1 WHERE tool=? AND destination=? AND policy<>'deny'").run(POLICY_TOOL, DESTINATION);
      hub.prepare('DELETE FROM proposal_only_grants WHERE tool=? AND destination=?').run(POLICY_TOOL, DESTINATION);
    } finally { hub.close(); }
  } finally { context.close(); }
}
