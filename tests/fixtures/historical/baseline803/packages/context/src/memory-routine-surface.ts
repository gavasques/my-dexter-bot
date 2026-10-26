import { createHash } from 'node:crypto';
import { MemoryRoutinePolicyInputSchema, type Action, type JsonValue } from '@dexter/contracts';
import { GatewayError, type CapabilityScope, type GatewayCallResult, type InputSchema, type ToolView, type TurnToolSurface } from '@dexter/gateway';
import { canonicalJson, dispatchAction, type HostStore } from '@dexter/hub';
import { MemoryRoutineStore, MEMORY_ROUTINE_DESTINATION, MEMORY_ROUTINE_POLICY_TOOL } from './memory-routine-store.js';
import { MemoryRoutineRunner } from './memory-routine-runner.js';
const sha = (s: string) => createHash('sha256').update(s).digest('hex'), json = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v)), id = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.:-]+$' } as const, digest = { type: 'string', minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' } as const, revision = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 } as const;
const schema = (properties: InputSchema['properties'], required: string[] = []): InputSchema => ({ type: 'object', properties, required, additionalProperties: false });
const definitions = [
    { name: 'policy.read', write: false, description: 'Read your own opt-in candidate/review policy, revision/epoch, effective authorization, extractor availability and finite journal limits. Unconfigured means no extractor or automatic capture; no MEMORY writes or dreaming are enabled.', inputSchema: schema({}) },
    { name: 'policy.update', write: true, description: 'Propose the exact own-bot policy and limits. Always requires exact owner approval, including Approve all. This enables candidate review only, never automatic MEMORY writes, tools or peer access. Every change increments epoch and invalidates old jobs/proposals. No bot/owner/profile/epoch fields are accepted.', inputSchema: schema({ expectedRevision: revision, enabled: { type: 'boolean' }, maintenanceEnabled: { type: 'boolean' }, minIntervalMs: { type: 'integer', minimum: 60000, maximum: 86400000 }, maxNotesPerDay: { type: 'integer', minimum: 1, maximum: 16 }, maxNoteCharacters: { type: 'integer', minimum: 1, maximum: 512 } }, ['expectedRevision', 'enabled', 'maintenanceEnabled']) },
    { name: 'policy.receipt', write: false, description: 'Read the actual own policy effect receipt of an action from this conversation without retrying it. Unknown dispatcher state stays literal.', inputSchema: schema({ action_id: id }, ['action_id']) },
    { name: 'jobs.list', write: false, description: 'Read at most16 own candidates/maintenance proposals and their actual document receipts, including source-turn provenance and uncertainty. No other bot or conversation transcript is returned; this never runs extraction.', inputSchema: schema({ limit: { type: 'integer', minimum: 1, maximum: 16 } }) },
    { name: 'jobs.read', write: false, description: 'Read one own candidate/proposal by its non-authoritative selector. Its source is assistant text of a finished real turn, not fact or instruction. Receipt is queried from the existing Context ledger; no replay.', inputSchema: schema({ job_id: digest }, ['job_id']) },
    { name: 'capture.propose', write: true, description: 'Propose a staged own candidate through the existing exact-owner memory.append action. The host supplies literal note, source lineage, epoch and CAS pin; owner review is required for every MEMORY write. Disable/revocation/head conflict blocks stale proposals. No model-generated IDs, source or replacement texts are accepted.', inputSchema: schema({ job_id: digest }, ['job_id']) },
    { name: 'maintenance.preview', write: false, description: 'Read a deterministic plan that removes only exact repeated nonempty LF-separated blocks from your own MEMORY. Show bounded literal samples, hashes and revision before proposing. No normalization or semantic dreaming; no write, deletion or tool action occurs.', inputSchema: schema({}) },
    { name: 'maintenance.propose', write: true, description: 'Propose the exact duplicate-removal plan through existing documents.update/MEMORY, under an enabled explicit maintenance policy and exact owner approval. Current revision and before/after hashes are required; SOUL/USER preserved. History/receipt/restore provide undo as a new owner-approved CAS revision; no automatic mutation or new rights.', inputSchema: schema({ expectedRevision: revision, memoryHash: digest, nextMemoryHash: digest }, ['expectedRevision', 'memoryHash', 'nextMemoryHash']) },
];
const project = (a: Action): GatewayCallResult => ({ actionId: a.id, status: a.state, requestHash: a.requestHash, reason: a.reason, result: a.result });
function fail(code: 'invalid_input' | 'forbidden' | 'unauthorized' | 'conflict'): never {
    throw new GatewayError(code, 'Memory routine operation refused.');
}
export class MemoryRoutineSurface implements TurnToolSurface {
    private readonly caps = new Map<string, CapabilityScope>();
    private readonly executions = new Map<string, Promise<Action>>();
    private stopped = false;
    constructor(private readonly host: HostStore, private readonly base: TurnToolSurface, private readonly routines: MemoryRoutineStore, private readonly runner: MemoryRoutineRunner) {
    }
    issueCapability(input: {
        turnId: string;
        ttlMs?: number;
    }) {
        for (const [key, scope] of this.caps) {
            try {
                if (scope.expiresAt <= this.host.now() || this.host.getTurn(scope.turnId).state !== 'running')
                    this.caps.delete(key);
            }
            catch {
                this.caps.delete(key);
            }
        }
        if (this.stopped || this.caps.size >= 128)
            fail('forbidden');
        const issued = this.base.issueCapability(input);
        this.caps.set(sha(issued.token), Object.freeze({ ...issued.scope }));
        this.scope(issued.token);
        return issued;
    }
    private scope(token: string) {
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
            fail('unauthorized');
        const scope = this.caps.get(sha(token));
        if (this.stopped || !scope || scope.expiresAt <= this.host.now())
            fail('unauthorized');
        this.host.assertActiveWriter();
        this.host.assertTeamTurn(scope.turnId);
        const turn = this.host.getTurn(scope.turnId), bot = this.host.getBot(scope.botId);
        if (turn.state !== 'running' || turn.botId !== scope.botId || turn.threadId !== scope.threadId || bot.profileId !== scope.profileId || scope.installationId !== this.host.hostId || scope.ownerId !== this.host.ownerId)
            fail('unauthorized');
        return scope;
    }
    listTools(token: string): ToolView[] {
        const scope = this.scope(token), list = this.base.listTools(token);
        if (!this.routines.privateTurnAllowed(scope.turnId)) return list;
        for (const def of definitions) {
            if (def.name === 'policy.update') {
                const grant = this.host.getGrant(scope.botId, MEMORY_ROUTINE_POLICY_TOOL, MEMORY_ROUTINE_DESTINATION);
                if (grant && (grant.policy !== 'ask' || grant.expiresAt !== null && grant.expiresAt <= this.host.now()))
                    continue;
            }
            list.push({ connectionId: MEMORY_ROUTINE_DESTINATION, connectionLabel: 'Dexter own memory review', name: 'dexter.memory.' + def.name, effect: def.write ? 'write' : 'read', requiresApproval: def.write, description: def.description, inputSchema: structuredClone(def.inputSchema) });
        }
        if (list.length > 256)
            fail('forbidden');
        return list;
    }
    async call(token: string, raw: unknown, options: {
        signal?: AbortSignal;
    } = {}): Promise<GatewayCallResult> {
        const scope = this.scope(token), call = raw as Record<string, unknown>;
        if (!call || typeof call !== 'object' || Array.isArray(call))
            fail('invalid_input');
        if (call.connectionId !== MEMORY_ROUTINE_DESTINATION)
            return this.base.call(token, raw, options);
        if (options.signal?.aborted)
            fail('unauthorized');
        if (Object.keys(call).sort().join(',') !== 'arguments,callId,connectionId,tool' || typeof call.callId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(call.callId) || typeof call.tool !== 'string')
            fail('invalid_input');
        const def = definitions.find(d => 'dexter.memory.' + d.name === call.tool);
        if (!def || !this.listTools(token).some(v => v.connectionId === MEMORY_ROUTINE_DESTINATION && v.name === call.tool))
            fail('forbidden');
        const args = call.arguments as Record<string, unknown>;
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !Object.hasOwn(def.inputSchema.properties, k)) || def.inputSchema.required.some(k => !Object.hasOwn(args, k)))
            fail('invalid_input');
        for (const [k, v] of Object.entries(args)) {
            const s = def.inputSchema.properties[k]!;
            if (s.type === 'string' && (typeof v !== 'string' || v.length > (s.maxLength ?? 0) || v.length < (s.minLength ?? 0) || s.pattern && !new RegExp(s.pattern).test(v)) || s.type === 'integer' && (typeof v !== 'number' || !Number.isSafeInteger(v) || s.minimum !== undefined && v < s.minimum || s.maximum !== undefined && v > s.maximum) || s.type === 'boolean' && typeof v !== 'boolean')
                fail('invalid_input');
        }
        if (def.name === 'policy.update')
            return project(await this.policyCall(scope, call.callId, args, options.signal));
        if (def.name === 'capture.propose')
            return project(this.routines.propose(scope.botId, scope.turnId, call.callId, { jobId: args.job_id as string }));
        if (def.name === 'maintenance.propose')
            return project(this.routines.propose(scope.botId, scope.turnId, call.callId, args as {
                expectedRevision: number;
                memoryHash: string;
                nextMemoryHash: string;
            }));
        let result: unknown;
        if (def.name === 'policy.read')
            result = this.routines.status(scope.botId, this.runner.configured, this.runner.extractorKind);
        else if (def.name === 'policy.receipt') {
            const action = this.host.getAction(args.action_id as string);
            if (action.request.threadId !== scope.threadId || action.request.botId !== scope.botId)
                fail('forbidden');
            result = { policyReceipt: this.routines.policyReceipt(scope.botId, action.id), dispatcher: action };
        }
        else if (def.name === 'jobs.list')
            result = { items: this.routines.jobs(scope.botId, args.limit as number | undefined) };
        else if (def.name === 'jobs.read') {
            const job = this.routines.job(scope.botId, args.job_id as string);
            const documents = job.actionId === null ? null : this.routines.documents.receipt(scope.botId, `action:${job.actionId}`);
            result = { job: { ...job, state: documents ? 'committed' : job.state }, documents };
        }
        else if (def.name === 'maintenance.preview') {
            const { after, ...preview } = this.routines.maintenancePreview(scope.botId);
            result = preview;
        }
        else
            fail('invalid_input');
        this.scope(token);
        const requestHash = sha(canonicalJson(json({ turnId: scope.turnId, tool: call.tool, callId: call.callId, input: args })));
        return { actionId: 'memory-read-' + requestHash.slice(0, 24), status: 'succeeded', requestHash, reason: null, result: json(result) };
    }
    private async policyCall(scope: CapabilityScope, callId: string, raw: Record<string, unknown>, signal?: AbortSignal) {
        const parsed = MemoryRoutinePolicyInputSchema.safeParse(raw);
        if (!parsed.success)
            fail('invalid_input');
        const input = json(parsed.data), key = 'memory_policy_' + sha(scope.turnId + '/' + callId).slice(0, 48);
        let action = this.host.findAction(scope.botId, key);
        if (action) {
            if (action.request.tool !== MEMORY_ROUTINE_POLICY_TOOL || action.request.threadId !== scope.threadId || canonicalJson(action.request.arguments.input ?? null) !== canonicalJson(input))
                fail('conflict');
        }
        else {
            if (this.host.toolActionsForOrigin(scope.turnId).length >= 32)
                fail('conflict');
            const policy = this.routines.policy(scope.botId), bot = this.host.getBot(scope.botId);
            if (policy.revision !== parsed.data.expectedRevision)
                fail('conflict');
            const grant = this.host.getGrant(scope.botId, MEMORY_ROUTINE_POLICY_TOOL, MEMORY_ROUTINE_DESTINATION);
            if (!grant)
                this.host.setProposalGrant({ botId: scope.botId, tool: MEMORY_ROUTINE_POLICY_TOOL, destination: MEMORY_ROUTINE_DESTINATION, policy: 'ask' });
            else if (grant.policy !== 'ask')
                fail('forbidden');
            action = this.host.requestAction({ botId: scope.botId, threadId: scope.threadId, tool: MEMORY_ROUTINE_POLICY_TOOL, destination: MEMORY_ROUTINE_DESTINATION, idempotencyKey: key, arguments: { input, pin: { revision: policy.revision, epoch: policy.epoch, botRevision: bot.revision, profileId: bot.profileId } } });
            this.host.bindToolAction(action.id, scope.turnId, callId);
        }
        if (action.state === 'ready')
            return this.settle(action, signal);
        return action;
    }
    private async settle(action: Action, signal?: AbortSignal): Promise<Action> {
        const prior = this.executions.get(action.id);
        if (prior)
            return prior;
        const promise = dispatchAction(this.host, action.id, async () => {
            const origin = this.host.ownerToolScope(action.id);
            if (origin.botId !== action.request.botId || signal?.aborted)
                fail('forbidden');
            const receipt = this.routines.executePolicyAction(action.id);
            this.runner.invalidate(receipt.botId);
            for (const id of receipt.withdrawnJobIds) {
                const job = this.routines.job(receipt.botId, id);
                if (job.actionId)
                    this.host.blockAction(job.actionId);
            }
            return json({ policyReceipt: receipt, automaticMemoryWrites: false, extractor: this.runner.extractorKind, semanticExtractor: 'unconfigured' });
        }, signal).then(receipt => {
            this.host.recordToolOutcome(receipt.id, receipt.result);
            return receipt;
        });
        this.executions.set(action.id, promise);
        try {
            return await promise;
        }
        finally {
            this.executions.delete(action.id);
        }
    }
    async continueOwnerAction(action: Action) {
        if (action.request.destination !== MEMORY_ROUTINE_DESTINATION || action.request.tool !== MEMORY_ROUTINE_POLICY_TOOL || action.state !== 'ready')
            return action;
        return this.settle(action);
    }
    revokeCapability(token: string) {
        this.caps.delete(sha(token));
        this.base.revokeCapability(token);
    }
    stopAdmission() {
        this.stopped = true;
        for (const token of this.caps.keys())
            this.caps.delete(token);
    }
    async close() {
        this.stopAdmission();
        await Promise.allSettled([...this.executions.values()]);
    }
}
