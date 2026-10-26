import { createHash } from 'node:crypto';
import { GroupListSchema, GroupReadSchema, GroupPostSchema, GroupToolCreateSchema, GroupToolUpdateSchema, JsonSchema, type Action, type JsonValue } from '@dexter/contracts';
import { GatewayError, type CapabilityScope, type GatewayCallResult, type InputSchema, type ToolView, type TurnToolSurface } from '@dexter/gateway';
import { canonicalJson, dispatchAction, type HostStore } from '@dexter/hub';
export const GROUP_TOOL_DESTINATION = 'dexter-groups-first-party';
const sha = (s: string) => createHash('sha256').update(s).digest('hex'), json = (x: unknown): JsonValue => JsonSchema.parse(x);
const id = { type: 'string' as const, minLength: 1, maxLength: 128 }, rev = { type: 'integer' as const, minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 };
const schema = (properties: InputSchema['properties'], required: string[] = []): InputSchema => ({ type: 'object', properties, required, additionalProperties: false });
const config = { expectedRevision: rev, name: { type: 'string' as const, minLength: 1, maxLength: 120 }, botIds: { type: 'array' as const, items: id, maxItems: 8 }, historyBotIds: { type: 'array' as const, items: id, maxItems: 8 } };
const definitions = [
    { name: 'dexter.groups.list', effect: 'read' as const, description: 'List only Groups you currently belong to. A Group shares transcript only, without a coordinator or inherited tools.', inputSchema: schema({after:{type:"integer",minimum:0},limit:{type:"integer",minimum:1,maximum:50}}) },
    { name: 'dexter.groups.read', effect: 'read' as const, description: 'Read current Group configuration and bounded shared transcript within your explicitly granted history window. No other bot documents, grants or 1:1 history.', inputSchema: schema({ groupId: id, conversationId: id, conversationAfter:{type:"integer",minimum:0}, after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['groupId']) },
    { name: 'dexter.groups.post', effect: 'write' as const, description: 'Post once as your capability-derived bot to a current Group, with expectedRevision and durable receipt/dedup. Posting NEVER dispatches recipients. Four posts per turn maximum.', inputSchema: schema({ groupId: id, conversationId: id, expectedRevision: rev, content: { type: 'string', minLength: 1, maxLength: 8192 } }, ['groupId', 'conversationId', 'expectedRevision', 'content']) },
    { name: 'dexter.groups.create', effect: 'write' as const, description: 'Propose an exact Group name/roster/explicit historical visibility choice. Exact owner approval required; include yourself. No grants, flags, fake bot or coordinator are created.', inputSchema: schema(config, ['expectedRevision', 'name', 'botIds', 'historyBotIds']) },
    { name: 'dexter.groups.update', effect: 'write' as const, description: 'Propose a full current Group name/roster/history selection with CAS. Exact owner approval required even under Approve all. Your membership generation and revision are pinned and revalidated before mutation; removal invalidates an old proposal.', inputSchema: schema({ groupId: id, ...config }, ['groupId', 'expectedRevision', 'name', 'botIds', 'historyBotIds']) }
];
/** Tool identity comes exclusively from the host-issued base capability; no bot/owner/profile caller args. */
export class GroupConversationSurface implements TurnToolSurface {
    private stopped = false;
    private readonly caps = new Map<string, CapabilityScope>();
    constructor(private readonly store: HostStore, private readonly base: TurnToolSurface) { }
    issueCapability(input: {
        turnId: string;
        ttlMs?: number;
    }) { if (this.stopped)
        throw new GatewayError('unavailable', 'Group tools stopped.'); for (const [key, s] of this.caps) {
        if (s.expiresAt <= this.store.now() || this.store.getTurn(s.turnId).state !== 'running')
            this.caps.delete(key);
    } if (this.caps.size >= 128)
        throw new GatewayError('unavailable', 'Group capability budget.'); const issued = this.base.issueCapability(input); this.caps.set(sha(issued.token), Object.freeze({ ...issued.scope })); return issued; }
    private scope(token: string): CapabilityScope { const s = this.caps.get(sha(token)); if (this.stopped || !s || s.expiresAt <= this.store.now())
        throw new GatewayError('unauthorized', 'Group capability unavailable.'); this.store.assertTeamTurn(s.turnId); const t = this.store.getTurn(s.turnId), b = this.store.getBot(t.botId); if (t.state !== 'running' || t.botId !== s.botId || t.threadId !== s.threadId || b.profileId !== s.profileId || s.ownerId !== this.store.ownerId || s.installationId !== this.store.hostId)
        throw new GatewayError('unauthorized', 'Group capability unavailable.'); return s; }
    listTools(token: string): ToolView[] { const scope = this.scope(token), groups = this.store.groups.listForTurn(scope.turnId); const own = this.store.getBot(scope.botId); return [...this.base.listTools(token), ...definitions.filter(d => d.name === 'dexter.groups.list' || d.name === 'dexter.groups.create' ? d.name.endsWith('list') || own.canSeeBots : groups.length > 0).filter(d => { if (!['dexter.groups.create', 'dexter.groups.update'].includes(d.name))
            return true; const grant = this.store.getGrant(scope.botId, d.name, GROUP_TOOL_DESTINATION); return !grant || grant.policy === 'ask' && (grant.expiresAt === null || grant.expiresAt > this.store.now()); }).map(d => ({ ...d, connectionId: GROUP_TOOL_DESTINATION, connectionLabel: 'Dexter Groups', requiresApproval: ['dexter.groups.create', 'dexter.groups.update'].includes(d.name) }))]; }
    async call(token: string, input: unknown, options: {
        signal?: AbortSignal;
    } = {}): Promise<GatewayCallResult> {
        const scope = this.scope(token);
        if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new GatewayError('invalid_input', 'Group call refused.');
        const raw = input as Record<string, unknown>;
        if (raw.connectionId !== GROUP_TOOL_DESTINATION)
            return this.base.call(token, input, options);
        if (options.signal?.aborted || Object.keys(raw).sort().join(',') !== 'arguments,callId,connectionId,tool' || typeof raw.callId !== 'string' || raw.callId.length < 1 || raw.callId.length > 128 || !this.listTools(token).some(x => x.connectionId === GROUP_TOOL_DESTINATION && x.name === raw.tool))
            throw new GatewayError('forbidden', 'Group call refused.');
        let result: JsonValue;
        const requestHash = sha(canonicalJson(json({ turnId: scope.turnId, ...raw })));
        if (raw.tool === 'dexter.groups.list') {
            const v=GroupListSchema.parse(raw.arguments);
            result = json(this.store.groups.listPageForTurn(scope.turnId,v.after,v.limit));
        }
        else if (raw.tool === 'dexter.groups.read') {
            const v = GroupReadSchema.parse(raw.arguments);
            result = json(this.store.groups.readForTurn(scope.turnId, v.groupId, v.conversationId, v.after, v.limit, v.conversationAfter));
        }
        else if (raw.tool === 'dexter.groups.post') {
            const v = GroupPostSchema.parse(raw.arguments);
            result = json(this.store.groups.postForTurn(scope.turnId, raw.callId, v));
        }
        else {
            const tool = String(raw.tool), v = tool === 'dexter.groups.create' ? GroupToolCreateSchema.parse(raw.arguments) : GroupToolUpdateSchema.parse(raw.arguments);
            const key = 'group-proposal-' + sha(scope.turnId + '\0' + raw.callId).slice(0, 48);
            const old = this.store.findAction(scope.botId, key);
            let action: Action;
            if (old) {
                if (old.request.tool !== tool || old.request.threadId !== scope.threadId || old.request.destination !== GROUP_TOOL_DESTINATION || canonicalJson(old.request.arguments.input ?? null) !== canonicalJson(json(v)))
                    throw new GatewayError('conflict', 'Group proposal ID reused.');
                action = old;
            }
            else {
                if (this.store.toolActionsForOrigin(scope.turnId).length >= 32)
                    throw new GatewayError('unavailable', 'Group proposal budget exceeded.');
                let pin: JsonValue;
                if ('groupId' in v) {
                    const member = this.store.groups.assertMemberForTurn(scope.turnId, v.groupId), g = this.store.groups.get(v.groupId);
                    if (g.revision !== v.expectedRevision)
                        throw new GatewayError('conflict', 'Group revision changed.');
                    pin = json({ groupId: g.id, revision: g.revision, joinedRevision: member.joinedRevision, visibleAfter: member.visibleAfter });
                }
                else {
                    if (!this.store.getBot(scope.botId).canSeeBots || !v.botIds.includes(scope.botId))
                        throw new GatewayError('forbidden', 'Group creation scope refused.');
                    pin = { botRevision: this.store.getBot(scope.botId).revision };
                }
                for (const botId of v.botIds)
                    this.store.getBot(botId);
                const grant = this.store.getGrant(scope.botId, tool, GROUP_TOOL_DESTINATION);
                if (!grant)
                    this.store.setProposalGrant({ botId: scope.botId, tool, destination: GROUP_TOOL_DESTINATION, policy: 'ask' });
                else if (grant.policy !== 'ask')
                    throw new GatewayError('forbidden', 'Group proposal grant refused.');
                action = this.store.requestAction({ botId: scope.botId, threadId: scope.threadId, tool, destination: GROUP_TOOL_DESTINATION, idempotencyKey: key, arguments: { input: json(v), pin } });
            }
            this.store.bindToolAction(action.id, scope.turnId, raw.callId);
            return { actionId: action.id, requestHash: action.requestHash, status: action.state, reason: action.reason, result: action.result };
        }
        this.scope(token);
        return { actionId: 'group-read-' + requestHash.slice(0, 24), requestHash, status: 'succeeded', reason: null, result };
    }
    async continueOwnerAction(action: Action): Promise<Action> { if (action.request.destination !== GROUP_TOOL_DESTINATION || !['dexter.groups.create', 'dexter.groups.update'].includes(action.request.tool) || action.state !== 'ready')
        return action; const input = action.request.arguments.input, pin = action.request.arguments.pin as Record<string, JsonValue>; try {
        const origin = this.store.ownerToolScope(action.id);
        if (action.request.tool === 'dexter.groups.update') {
            const v = GroupToolUpdateSchema.parse(input), g = this.store.groups.get(v.groupId), m = g.members.find(x => x.active && x.botId === origin.botId);
            if (!m || m.joinedRevision !== pin.joinedRevision || m.visibleAfter !== pin.visibleAfter || g.revision !== pin.revision)
                return this.store.blockAction(action.id);
        }
        const receipt = await dispatchAction(this.store, action.id, async () => { const s = this.store.ownerToolScope(action.id); if (s.botId !== origin.botId || s.profileId !== origin.profileId)
            throw new GatewayError('forbidden', 'Group proposal identity changed.'); const mutation = { expectedHostId: this.store.hostId, clientRequestId: 'action:' + action.id }; if (action.request.tool === 'dexter.groups.create') {
            const v = GroupToolCreateSchema.parse(input);
            if (this.store.getBot(s.botId).revision !== pin.botRevision || !this.store.getBot(s.botId).canSeeBots || !v.botIds.includes(s.botId))
                throw new GatewayError('forbidden', 'Group creation authorization changed.');
            return json(this.store.groups.create({ ...v, ...mutation }));
        } const v = GroupToolUpdateSchema.parse(input); const m = this.store.groups.get(v.groupId).members.find(x => x.active && x.botId === s.botId); if (!m || m.joinedRevision !== pin.joinedRevision || m.visibleAfter !== pin.visibleAfter || this.store.groups.get(v.groupId).revision !== pin.revision)
            throw new GatewayError('forbidden', 'Stale Group proposal membership or revision.'); const { groupId, ...config } = v; return json(this.store.groups.update(groupId, { ...config, ...mutation })); });
        this.store.recordToolOutcome(receipt.id, receipt.result);
        return receipt;
    }
    catch {
        const current = this.store.getAction(action.id);
        return current.state === 'ready' ? this.store.blockAction(action.id) : current;
    } }
    revokeCapability(token: string): void { this.caps.delete(sha(token)); this.base.revokeCapability(token); }
    stopAdmission(): void { this.stopped = true; this.caps.clear(); }
}
