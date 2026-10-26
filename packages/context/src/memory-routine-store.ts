import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, type HostStore, type BotDocuments } from '@dexter/hub';
import { MemoryRoutineMetadataSchema, MemoryRoutinePolicyInputSchema, MEMORY_ROUTINE_META_KEY, MEMORY_ROUTINE_METADATA_BYTES, type MemoryRoutineMetadata, type MemoryRoutinePolicy, type MemoryRoutineJob, type MemoryRoutinePolicyReceipt } from '@dexter/contracts';
import { ContextError } from './types.js';
import { sha256 } from './repository.js';
import { appendLiteralMemoryNote } from './memory-notes.js';
export const MEMORY_ROUTINE_DESTINATION = 'dexter-memory-routines';
export const MEMORY_ROUTINE_POLICY_TOOL = 'dexter.memory.policy.update';
const HARNESS = 'dexter-harness-owner-proposals', MAX_AGE = 86400000;
const canonical = (value: unknown) => canonicalJson(JSON.parse(JSON.stringify(value)));
export const routineSecret = (value: string) => /(?:\b(?:sk-|sk_live_|sk_test_|github_pat_|gh[pousr]_|xox[abprs]-|glpat-|AIza|AKIA|ASIA|ya29\.)[A-Za-z0-9_+=./-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|passphrase)\s*[:=]\s*["']?(?:Bearer\s+)?[A-Za-z0-9_+=./-]{12,})/i.test(value);
export interface MemoryRoutineDocuments {
    read(botId: string): BotDocuments;
    receipt(botId: string, key: string, threadId?: string): BotDocuments | null;
}
/** Only metadata shares Context's existing writer. MEMORY writes remain the existing exact-owner document action. */
export class MemoryRoutineStore {
    constructor(private readonly db: DatabaseSync, readonly host: HostStore, readonly documents: MemoryRoutineDocuments, private readonly write: <T>(fn: () => T) => T, readonly privateTurnAllowed: (turnId: string) => boolean = () => true) {
        const data = this.load();
        let changed = false;
        for (const job of Object.values(data.jobs))
            if (job.state === 'extracting') {
                job.state = 'unknown';
                job.updatedAt = host.now();
                changed = true;
            }
        if (changed)
            this.write(() => this.save(data, true));
    }
    private own(botId: string) {
        const bot = this.host.getBot(botId);
        if (bot.ownerId !== this.host.ownerId)
            throw new ContextError('forbidden');
        return bot;
    }
    private load(): MemoryRoutineMetadata {
        this.host.assertActiveWriter();
        const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(MEMORY_ROUTINE_META_KEY);
        if (!row)
            return { version: 1, policies: {}, receipts: {}, jobs: {} };
        try {
            const raw = String(row.value);
            if (Buffer.byteLength(raw) > MEMORY_ROUTINE_METADATA_BYTES)
                throw Error();
            const parsed = MemoryRoutineMetadataSchema.parse(JSON.parse(raw));
            if (canonical(parsed) !== raw)
                throw Error();
            return parsed;
        }
        catch {
            throw new ContextError('tampered');
        }
    }
    private save(data: MemoryRoutineMetadata, reserved = false) {
        const parsed = MemoryRoutineMetadataSchema.safeParse(data);
        if (!parsed.success)
            throw new ContextError('tampered');
        const value = canonical(parsed.data);
        if (Buffer.byteLength(value) > (reserved ? MEMORY_ROUTINE_METADATA_BYTES : MEMORY_ROUTINE_METADATA_BYTES - 65536))
            throw new ContextError('conflict');
        this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(MEMORY_ROUTINE_META_KEY, value);
    }
    policy(botId: string): MemoryRoutinePolicy {
        const bot = this.own(botId);
        return this.load().policies[botId] ?? { revision: 0, epoch: 0, enabled: false, maintenanceEnabled: false, minIntervalMs: 60000, maxNotesPerDay: 4, maxNoteCharacters: 512, actionId: null, botRevision: bot.revision, profileId: bot.profileId, grantRevision: 0, updatedAt: 0 };
    }
    effective(botId: string, policy = this.policy(botId)): boolean {
        const bot = this.own(botId);
        if (!policy.enabled || policy.actionId === null || bot.profileId !== policy.profileId || bot.revision !== policy.botRevision)
            return false;
        const action = this.host.getAction(policy.actionId), grant = this.host.getGrant(botId, MEMORY_ROUTINE_POLICY_TOOL, MEMORY_ROUTINE_DESTINATION), receipt = this.policyReceipt(botId, action.id);
        return receipt !== null && receipt.botId === botId && receipt.ownerId === this.host.ownerId && receipt.actionRequestHash === action.requestHash && canonical(receipt.policy) === canonical(policy) && action.decidedBy === this.host.ownerId && action.authorization?.source === 'exact_owner' && !!grant && grant.policy === 'ask' && grant.revision === policy.grantRevision && (grant.expiresAt === null || grant.expiresAt > this.host.now());
    }
    status(botId: string, extractorConfigured: boolean, extractorKind: 'literal_excerpt' | 'injected' | 'unconfigured' = extractorConfigured ? 'injected' : 'unconfigured') {
        const policy = this.policy(botId);
        const data = this.load();
        return { policy, effectiveEnabled: this.effective(botId, policy), mode: 'candidate_review_only', extractor: extractorKind, semanticExtractor: 'unconfigured', candidateMeaning: extractorKind === 'literal_excerpt' ? 'literal_suggested_excerpt' : 'unverified_context_candidate', automaticMemoryWrites: false, dreaming: 'not_implemented', source: 'completed_own_assistant_text_only', journal: { jobs: Object.values(data.jobs).filter(job => job.botId === botId).length, ownJobLimit: 16, installationJobLimit: 128, policyReceipts: Object.values(data.receipts).filter(receipt => receipt.botId === botId).length, installationReceiptLimit: 128, reservedDisableReceipts: 32, reservedMetadataBytes: 65536 } };
    }
    policyReceipt(botId: string, actionId: string) {
        this.own(botId);
        const action = this.host.getAction(actionId);
        if (action.request.botId !== botId || action.request.tool !== MEMORY_ROUTINE_POLICY_TOOL || action.request.destination !== MEMORY_ROUTINE_DESTINATION)
            throw new ContextError('forbidden');
        return this.load().receipts[actionId] ?? null;
    }
    executePolicyAction(actionId: string): MemoryRoutinePolicyReceipt {
        return this.write(() => {
            const action = this.host.getAction(actionId), origin = this.host.toolActionOrigin(actionId), bot = this.own(action.request.botId), data = this.load();
            if (!origin || action.request.tool !== MEMORY_ROUTINE_POLICY_TOOL || action.request.destination !== MEMORY_ROUTINE_DESTINATION || action.decidedBy !== this.host.ownerId || action.authorization?.source !== 'exact_owner')
                throw new ContextError('forbidden');
            const value = MemoryRoutinePolicyInputSchema.safeParse(action.request.arguments.input);
            if (!value.success)
                throw new ContextError('invalid_input');
            const previous = data.receipts[actionId], inputHash = sha256(canonical(value.data));
            if (previous) {
                if (previous.inputHash !== inputHash || previous.actionRequestHash !== action.requestHash)
                    throw new ContextError('conflict');
                return previous;
            }
            if (action.state !== 'running')
                throw new ContextError('forbidden');
            const current = this.policy(bot.id), pin = action.request.arguments.pin;
            if (canonical(pin) !== canonical({ revision: current.revision, epoch: current.epoch, botRevision: bot.revision, profileId: bot.profileId }) || current.revision !== value.data.expectedRevision)
                throw new ContextError('conflict');
            if (Object.keys(data.receipts).length >= 128 && !(current.enabled && !value.data.enabled && Object.keys(data.receipts).length < 160))
                throw new ContextError('conflict');
            const policy: MemoryRoutinePolicy = { ...value.data, revision: current.revision + 1, epoch: current.epoch + 1, actionId: action.id, botRevision: bot.revision, profileId: bot.profileId, grantRevision: action.grantRevision, updatedAt: this.host.now() };
            delete (policy as Partial<MemoryRoutinePolicyInputSchemaType>).expectedRevision;
            const withdrawnJobIds: string[] = [];
            for (const job of Object.values(data.jobs))
                if (job.botId === bot.id && !['committed', 'empty', 'invalid', 'withdrawn'].includes(job.state) && !this.documentReceipt(job)) {
                    job.state = 'withdrawn';
                    job.updatedAt = this.host.now();
                    withdrawnJobIds.push(job.id);
                }
            data.policies[bot.id] = policy;
            const receipt: MemoryRoutinePolicyReceipt = { actionId: action.id, botId: bot.id, ownerId: this.host.ownerId, actionRequestHash: action.requestHash, inputHash, previousRevision: current.revision, policy, withdrawnJobIds, committedAt: this.host.now() };
            data.receipts[action.id] = receipt;
            this.save(data, !policy.enabled);
            return receipt;
        });
    }
    private documentReceipt(job: MemoryRoutineJob) {
        return job.actionId === null ? null : this.documents.receipt(job.botId, `action:${job.actionId}`);
    }
    jobs(botId: string, limit = 16) {
        this.own(botId);
        if (!Number.isInteger(limit) || limit < 1 || limit > 16)
            throw new ContextError('invalid_input');
        return Object.values(this.load().jobs).filter(job => job.botId === botId).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).slice(0, limit).map(job => ({ ...job, state: this.documentReceipt(job) ? 'committed' : job.state, receipt: this.documentReceipt(job)?.receipt ?? null }));
    }
    job(botId: string, id: string): MemoryRoutineJob {
        this.own(botId);
        const job = this.load().jobs[id];
        if (!job || job.botId !== botId)
            throw new ContextError('forbidden');
        return job;
    }
    private valid(job: MemoryRoutineJob, maintenance = false) {
        const policy = this.policy(job.botId), bot = this.own(job.botId);
        if (!this.effective(job.botId, policy) || policy.epoch !== job.epoch || policy.revision !== job.policyRevision || bot.revision !== job.botRevision || bot.profileId !== job.profileId || this.host.now() - job.createdAt > MAX_AGE || maintenance && !policy.maintenanceEnabled)
            throw new ContextError('forbidden');
        if (job.source) {
            const turn = this.host.getTurn(job.source.turnId), output = this.host.turnOutput(turn.id);
            this.host.assertTeamTurn(turn.id);
            if (!this.privateTurnAllowed(turn.id)) throw new ContextError("forbidden");
            if (turn.state !== 'completed' || turn.botId !== job.botId || turn.threadId !== job.source.threadId || turn.inputMessageId !== job.source.inputMessageId || turn.outputMessageId !== job.source.outputMessageId || turn.finishedAt !== job.source.finishedAt || output === null || sha256(output) !== job.source.outputHash)
                throw new ContextError('forbidden');
        }
        return policy;
    }
    beginCapture(turnId: string): {
        job: MemoryRoutineJob;
        excerpt: string;
    } | null {
        return this.write(() => {
            const turn = this.host.getTurn(turnId), bot = this.own(turn.botId), policy = this.policy(bot.id), output = this.host.turnOutput(turn.id);
            this.host.assertTeamTurn(turn.id);
            if (!this.privateTurnAllowed(turn.id)) return null;
            if (turn.state !== 'completed' || turn.finishedAt === null || turn.outputMessageId === null || output === null || output.length === 0 || !this.effective(bot.id, policy) || routineSecret(output) || this.host.toolActionsForOrigin(turn.id).some(action => action.state === 'unknown' || ['awaiting_approval', 'ready', 'running'].includes(action.state)))
                return null;
            const data = this.load(), id = sha256(`${this.host.hostId}/${bot.id}/${policy.epoch}/${turn.id}`);
            if (data.jobs[id])
                return null;
            const jobs = Object.values(data.jobs).filter(job => job.botId === bot.id), recent = jobs.filter(job => job.kind === 'capture');
            if (Object.keys(data.jobs).length >= 128 || jobs.length >= 16 || recent.some(job => this.host.now() - job.createdAt < policy.minIntervalMs) || recent.filter(job => Math.floor(job.createdAt / 86400000) === Math.floor(this.host.now() / 86400000)).length >= policy.maxNotesPerDay)
                return null;
            const docs = this.documents.read(bot.id);
            const job: MemoryRoutineJob = { id, botId: bot.id, profileId: bot.profileId, botRevision: bot.revision, epoch: policy.epoch, policyRevision: policy.revision, kind: 'capture', state: 'extracting', source: { turnId: turn.id, threadId: turn.threadId, inputMessageId: turn.inputMessageId, outputMessageId: turn.outputMessageId, finishedAt: turn.finishedAt, outputHash: sha256(output), outputCharacters: output.length, role: 'assistant' }, note: null, baseRevision: docs.revision, soulHash: sha256(docs.soul), userHash: sha256(docs.user), memoryHash: sha256(docs.memory), nextMemoryHash: null, actionId: null, proposalTurnId: null, createdAt: this.host.now(), updatedAt: this.host.now() };
            data.jobs[id] = job;
            this.save(data);
            let excerpt = output.slice(0, 2048);
            if (/[\uD800-\uDBFF]$/.test(excerpt))
                excerpt = excerpt.slice(0, -1);
            return { job, excerpt };
        });
    }
    settleCapture(jobId: string, note: string | null, state: 'candidate' | 'empty' | 'invalid' | 'withdrawn' | 'unknown' | 'conflict') {
        return this.write(() => {
            const data = this.load(), job = data.jobs[jobId];
            if (!job || job.state !== 'extracting')
                return;
            try {
                const policy = this.valid(job);
                if (note !== null && (note.length > policy.maxNoteCharacters || note.length < 1 || !note.isWellFormed() || !note.trim() || routineSecret(note)))
                    throw new ContextError('invalid_input');
                const docs = this.documents.read(job.botId);
                if (docs.revision !== job.baseRevision || sha256(docs.memory) !== job.memoryHash)
                    throw new ContextError('conflict');
                if (note !== null)
                    appendLiteralMemoryNote(docs.memory, note);
                job.note = note;
                job.state = state;
            }
            catch (error) {
                job.state = error instanceof ContextError && error.code === 'conflict' ? 'conflict' : 'withdrawn';
                job.note = null;
            }
            job.updatedAt = this.host.now();
            try {
                this.save(data, job.state !== 'candidate');
            }
            catch {
                job.state = 'conflict';
                job.note = null;
                this.save(data, true);
            }
        });
    }
    maintenancePreview(botId: string) {
        const policy = this.policy(botId);
        if (!this.effective(botId, policy) || !policy.maintenanceEnabled)
            throw new ContextError('forbidden');
        const docs = this.documents.read(botId);
        if (routineSecret(docs.memory))
            throw new ContextError('forbidden');
        const seen = new Set<string>(), removed: Array<{
            sha256: string;
            characters: number;
            sample: string;
            sampleTruncated: boolean;
        }> = [];
        const parts = docs.memory.split('\n\n').filter(block => {
            if (block.length === 0)
                return true;
            if (seen.has(block)) {
                removed.push({ sha256: sha256(block), characters: block.length, sample: block.slice(0, 256).replace(/[\uD800-\uDBFF]$/, ''), sampleTruncated: block.length > 256 });
                return false;
            }
            seen.add(block);
            return true;
        });
        const after = parts.join('\n\n');
        return { expectedRevision: docs.revision, memoryHash: sha256(docs.memory), nextMemoryHash: sha256(after), removed, after };
    }
    propose(botId: string, turnId: string, callId: string, input: {
        jobId: string;
    } | {
        expectedRevision: number;
        memoryHash: string;
        nextMemoryHash: string;
    }) {
        const turn = this.host.getTurn(turnId), bot = this.own(botId);
        if (turn.state !== 'running' || turn.botId !== bot.id)
            throw new ContextError('forbidden');
        this.host.assertTeamTurn(turnId);
        const existing = this.host.toolActionsForOrigin(turnId).find(a => this.host.toolActionOrigin(a.id)?.callId === callId);
        if (existing) {
            const old = Object.values(this.load().jobs).find(j => j.actionId === existing.id);
            if (!old || ('jobId' in input ? old.id !== input.jobId : old.kind !== 'maintenance' || old.baseRevision !== input.expectedRevision || old.memoryHash !== input.memoryHash || old.nextMemoryHash !== input.nextMemoryHash))
                throw new ContextError('conflict');
            return existing;
        }
        if (this.host.toolActionsForOrigin(turnId).length >= 32)
            throw new ContextError('conflict');
        let job: MemoryRoutineJob, args: Record<string, unknown>, tool: string;
        const docs = this.documents.read(bot.id);
        if ('jobId' in input) {
            job = this.job(bot.id, input.jobId);
            if (job.actionId !== null) {
                const action = this.host.getAction(job.actionId);
                if (action.request.threadId !== turn.threadId)
                    throw new ContextError('forbidden');
                return action;
            }
            this.valid(job);
            if (job.kind !== 'capture' || job.note === null || job.state !== 'candidate')
                throw new ContextError('forbidden');
            if (job.baseRevision !== docs.revision || sha256(docs.memory) !== job.memoryHash)
                throw new ContextError('conflict');
            tool = 'dexter.harness.memory.append';
            args = { expectedRevision: job.baseRevision, note: job.note };
        }
        else {
            const preview = this.maintenancePreview(bot.id);
            if (preview.expectedRevision !== input.expectedRevision || preview.memoryHash !== input.memoryHash || preview.nextMemoryHash !== input.nextMemoryHash || preview.removed.length === 0)
                throw new ContextError('conflict');
            const policy = this.policy(bot.id), id = sha256(`${bot.id}/${policy.epoch}/${turnId}/${preview.memoryHash}/${preview.nextMemoryHash}`);
            job = { id, botId: bot.id, profileId: bot.profileId, botRevision: bot.revision, epoch: policy.epoch, policyRevision: policy.revision, kind: 'maintenance', state: 'candidate', source: null, note: null, baseRevision: docs.revision, soulHash: sha256(docs.soul), userHash: sha256(docs.user), memoryHash: sha256(docs.memory), nextMemoryHash: preview.nextMemoryHash, actionId: null, proposalTurnId: null, createdAt: this.host.now(), updatedAt: this.host.now() };
            const old = this.load().jobs[id];
            if (old?.actionId)
                return this.host.getAction(old.actionId);
            this.write(() => {
                const data = this.load();
                if (Object.keys(data.jobs).length >= 128 || Object.values(data.jobs).filter(j => j.botId === bot.id).length >= 16)
                    throw new ContextError('conflict');
                data.jobs[id] = job;
                this.save(data);
            });
            tool = 'dexter.harness.documents.update';
            args = { expectedRevision: docs.revision, document: 'MEMORY', markdown: preview.after };
        }
        let grant = this.host.getGrant(bot.id, tool, HARNESS);
        if (!grant) {
            this.host.setProposalGrant({ botId: bot.id, tool, destination: HARNESS, policy: 'ask' });
            grant = this.host.getGrant(bot.id, tool, HARNESS);
        }
        // The direct own-document default may already have an ALLOW grant. This legacy routine
        // still requests with no automatic eligibility, so admission always asks the exact owner.
        if (!grant || !['ask','allow'].includes(grant.policy))
            throw new ContextError('forbidden');
        const action = this.host.requestAction({ botId: bot.id, threadId: turn.threadId, tool, destination: HARNESS, idempotencyKey: `routine_${job.id.slice(0, 48)}`, arguments: { input: JSON.parse(canonical(args)), pin: { revision: docs.revision, soulHash: sha256(docs.soul), userHash: sha256(docs.user), memoryHash: sha256(docs.memory) }, routine: { version: 1, jobId: job.id } } });
        this.host.bindToolAction(action.id, turnId, callId);
        this.write(() => {
            const data = this.load(), current = data.jobs[job.id];
            if (!current)
                throw new ContextError('tampered');
            this.valid(current, current.kind === 'maintenance');
            current.actionId = action.id;
            current.proposalTurnId = turnId;
            current.state = 'proposed';
            current.updatedAt = this.host.now();
            this.save(data);
        });
        return action;
    }
    guardDocumentAction(actionId: string) {
        const action = this.host.getAction(actionId), routine = action.request.arguments.routine, data = this.load(), linked = Object.values(data.jobs).find(job => job.actionId === actionId);
        if (routine === undefined) {
            if (linked)
                throw new ContextError('tampered');
            return;
        }
        if (!routine || typeof routine !== 'object' || Array.isArray(routine) || Object.keys(routine).sort().join(',') !== 'jobId,version' || routine.version !== 1 || typeof routine.jobId !== 'string')
            throw new ContextError('forbidden');
        const job = this.job(action.request.botId, routine.jobId);
        if (job.actionId !== action.id || action.request.destination !== HARNESS || job.proposalTurnId === null || this.host.toolActionOrigin(action.id)?.turnId !== job.proposalTurnId)
            throw new ContextError('forbidden');
        if (this.documentReceipt(job))
            return;
        this.valid(job, job.kind === 'maintenance');
        if (job.state !== 'proposed')
            throw new ContextError('forbidden');
        const docs = this.documents.read(job.botId), input = action.request.arguments.input;
        if (docs.revision !== job.baseRevision || sha256(docs.soul) !== job.soulHash || sha256(docs.user) !== job.userHash || sha256(docs.memory) !== job.memoryHash || !input || typeof input !== 'object' || Array.isArray(input))
            throw new ContextError('conflict');
        if (job.kind === 'capture') {
            if (action.request.tool !== 'dexter.harness.memory.append' || input.note !== job.note || input.expectedRevision !== job.baseRevision)
                throw new ContextError('forbidden');
        }
        else if (action.request.tool !== 'dexter.harness.documents.update' || input.document !== 'MEMORY' || typeof input.markdown !== 'string' || sha256(input.markdown) !== job.nextMemoryHash || this.maintenancePreview(job.botId).nextMemoryHash !== job.nextMemoryHash)
            throw new ContextError('forbidden');
    }
}
type MemoryRoutinePolicyInputSchemaType = {
    expectedRevision: number;
};
