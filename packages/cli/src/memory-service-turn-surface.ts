import { createHash } from 'node:crypto';
import type { Action, JsonValue } from '@dexter/contracts';
import { MemoryServiceError, type ContextHost, type MemoryService, type MemoryServiceMemory } from '@dexter/context';
import { GatewayError, MCP_AUTHORIZED_INVENTORY_LIMIT, validateArguments, type CapabilityScope, type GatewayCallResult, type InputSchema, type ToolView, type TurnToolSurface } from '@dexter/gateway';
import { canonicalJson, dispatchAction, type HostStore } from '@dexter/hub';
import { isWellFormedText } from './text-input.js';

export const MEMORY_SERVICE_CONNECTION = 'dexter-harness-memory-service';
export const MEMORY_SERVICE_READ_LIMITS = Object.freeze({ waitingPerTurn: 8, totalPerTurn: 64, capabilities: 128 });
const id = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' } as const;
const schema = (properties: InputSchema['properties'], required: string[]): InputSchema => ({ type: 'object', additionalProperties: false, properties, required });
export const MEMORY_SERVICE_READ_TOOLS = Object.freeze([
  { name: 'dexter.harness.memory.recall', description: 'Read at most8 approved current own private ledger memories through the configured OpenViking bot user. Query <=2000 characters. Host derives identity and private audience; no team/group/confidential/global/peer fallback. DENY and current Context policy apply; ASK requires the exact host owner decision. Canonical head/hash/epoch and authority are checked after IO. Does not capture, project or configure a backend. Repeated direct read call IDs are refused without repeat HTTP; after timeout query current state and do not blindly replay.', inputSchema: schema({ query: { type: 'string', minLength: 1, maxLength: 2000 }, limit: { type: 'integer', minimum: 1, maximum: 8 } }, ['query']) },
  { name: 'dexter.harness.memory.details', description: 'Read one exact own private current ledger record pinned by recordId, revision and lowercase SHA256, through the same protected backend. Returns canonical markdown/provenance or null when the exact remote revision is missing. Cross-bot/source, confidential, forgotten, superseded or stale references are refused; no namespace override, mutation or backend fallback. ASK uses an exact owner action; a stored receipt never authorizes a stale body.', inputSchema: schema({ recordId: id, revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER - 1 }, sha256: { type: 'string', minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' } }, ['recordId', 'revision', 'sha256']) },
]);
export interface MemoryServiceTurnSurfaceOptions {
  readonly store: HostStore; readonly base: TurnToolSurface; readonly context: ContextHost; readonly memory: MemoryService;
}
interface Cap { token: string; scope: Readonly<CapabilityScope>; controller: AbortController }
interface Pin { authorizationStamp: string; scopeEpoch: number; grantRevision: number | null; grantPolicy: 'allow' | 'ask' | null }
interface ReadCall { tool: string; callId: string; arguments: Record<string, JsonValue> }
interface Admission { hash: string; cap: Cap; call: ReadCall; pin: Pin; actionId: string | null }
interface Lane { tail: Promise<void>; active: number; waiting: number; admissions: Map<string, Admission> }
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const json = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v));
const project = (a: Action): GatewayCallResult => ({ actionId: a.id, status: a.state, requestHash: a.requestHash, reason: a.reason, result: a.state === 'succeeded' ? a.result : null });
function fail(code: 'unauthorized' | 'forbidden' | 'conflict' | 'invalid_input' | 'unavailable'): never { throw new GatewayError(code, `Memory read refused: ${code}.`); }

/** Host-owned private read facade. It borrows base/Context/service lifetimes and never creates a grant. */
export class MemoryServiceTurnSurface implements TurnToolSurface {
  readonly #o: MemoryServiceTurnSurfaceOptions;
  readonly #caps = new Map<string, Cap>();
  readonly #lanes = new Map<string, Lane>();
  readonly #actions = new Map<string, Admission>();
  readonly #calls = new Set<Promise<GatewayCallResult>>();
  readonly #executions = new Map<string, Promise<Action>>();
  #stopped = false; #closing: Promise<void> | null = null; #cleanupFailed = false;
  constructor(options: MemoryServiceTurnSurfaceOptions) { this.#o = Object.freeze({ ...options }); }
  toJSON(): object { return this.status(); }
  status(): object { return { accepting: !this.#stopped, calls: this.#calls.size, queued: [...this.#lanes.values()].reduce((n, l) => n + l.waiting, 0), cleanupConfirmed: !this.#cleanupFailed, effectiveBoundary: 'context_private_own_active_ledger_only', limits: MEMORY_SERVICE_READ_LIMITS }; }
  issueCapability(input: { turnId: string; ttlMs?: number }): { token: string; scope: CapabilityScope } {
    if (this.#stopped) fail('unavailable');
    for (const [key, cap] of this.#caps) { try { this.#validate(cap); } catch { this.#remove(key, cap); } }
    for (const [turnId, lane] of this.#lanes) if (!lane.active && !lane.waiting && this.#o.store.getTurn(turnId).state !== 'running') {
      for (const admission of lane.admissions.values()) if (admission.actionId) this.#actions.delete(admission.actionId);
      this.#lanes.delete(turnId);
    }
    if (this.#caps.size >= MEMORY_SERVICE_READ_LIMITS.capabilities || this.#lanes.size >= MEMORY_SERVICE_READ_LIMITS.capabilities && !this.#lanes.has(input.turnId)) fail('unavailable');
    const issued = this.#o.base.issueCapability(input);
    const cap: Cap = { token: issued.token, scope: Object.freeze({ ...issued.scope }), controller: new AbortController() };
    try {
      if (!/^[A-Za-z0-9_-]{43}$/.test(cap.token) || cap.scope.turnId !== input.turnId) fail('unauthorized');
      this.#validate(cap); this.#catalogue(cap);
      this.#caps.set(sha(cap.token), cap); return { token: cap.token, scope: { ...cap.scope } };
    } catch (error) { this.#o.base.revokeCapability(cap.token); throw this.#safe(error); }
  }
  #validate(cap: Cap, signal?: AbortSignal): void {
    const store = this.#o.store, s = cap.scope;
    if (this.#stopped || cap.controller.signal.aborted || signal?.aborted || s.expiresAt <= store.now()) fail('unauthorized');
    store.assertActiveWriter(); store.assertTeamTurn(s.turnId);
    const turn = store.getTurn(s.turnId), thread = store.getThread(s.threadId), bot = store.getBot(s.botId);
    if (turn.state !== 'running' || turn.botId !== s.botId || turn.threadId !== s.threadId || thread.botId !== s.botId
      || bot.profileId !== s.profileId || bot.ownerId !== s.ownerId || s.installationId !== store.hostId || s.ownerId !== store.ownerId) fail('unauthorized');
  }
  #resolve(token: string, signal?: AbortSignal): Cap {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail('unauthorized');
    const cap = this.#caps.get(sha(token)); if (!cap) fail('unauthorized'); this.#validate(cap, signal); return cap;
  }
  #pin(cap: Cap, tool: string, requireEpoch = true): Pin {
    this.#validate(cap);
    const policy = this.#o.context.privateMemoryReadPolicy(cap.scope.turnId);
    if (!policy.privateRecallAllowed) fail('forbidden');
    const grant = this.#o.store.getGrant(cap.scope.botId, tool, MEMORY_SERVICE_CONNECTION);
    if (grant && (grant.policy === 'deny' || grant.expiresAt !== null && grant.expiresAt <= this.#o.store.now())) fail('forbidden');
    return { authorizationStamp: policy.authorizationStamp, scopeEpoch: requireEpoch ? this.#o.context.memoryLedger.scopeEpoch({ kind: 'bot', botId: cap.scope.botId }) : 0,
      grantRevision: grant?.revision ?? null, grantPolicy: grant?.policy as 'allow' | 'ask' | undefined ?? null };
  }
  #catalogue(cap: Cap): ToolView[] {
    const base = this.#o.base.listTools(cap.token);
    if (base.some(v => v.connectionId === MEMORY_SERVICE_CONNECTION)) fail('conflict');
    const views = [...base];
    for (const tool of MEMORY_SERVICE_READ_TOOLS) {
      let pin: Pin;
      try { pin = this.#pin(cap, tool.name, false); } catch (error) { if (error instanceof GatewayError && error.code === 'forbidden') continue; throw error; }
      views.push({ name: tool.name, connectionId: MEMORY_SERVICE_CONNECTION, connectionLabel: 'Dexter memória privada própria', effect: 'read',
        requiresApproval: pin.grantPolicy === 'ask', description: tool.description, inputSchema: structuredClone(tool.inputSchema) });
    }
    if (views.length > MCP_AUTHORIZED_INVENTORY_LIMIT) fail('unavailable'); return views;
  }
  listTools(token: string): ToolView[] { try { return this.#catalogue(this.#resolve(token)); } catch (error) { throw this.#safe(error); } }
  #guard(admission: Admission, signal?: AbortSignal): void {
    this.#resolve(admission.cap.token, signal);
    if (canonicalJson(json(this.#pin(admission.cap, admission.call.tool))) !== canonicalJson(json(admission.pin))) fail('forbidden');
  }
  call(token: string, raw: unknown, options: { signal?: AbortSignal } = {}): Promise<GatewayCallResult> {
    let promise: Promise<GatewayCallResult>;
    try {
      const cap = this.#resolve(token, options.signal), input = structuredClone(raw) as Record<string, unknown>;
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_input');
      if (input.connectionId !== MEMORY_SERVICE_CONNECTION) promise = this.#o.base.call(token, input, options).then(outcome => {
        // Generic action history is metadata, not a second unguarded memory-read route. The owner retains
        // its canonical historical receipt; engine reads through this facade never retrieve its memory body.
        if (input.connectionId === 'dexter-harness-owner-proposals' && input.tool === 'dexter.harness.actions.read') {
          this.#resolve(token, options.signal);
          const action = outcome.result as { request?: { destination?: unknown }; result?: unknown } | null;
          if (action?.request?.destination === MEMORY_SERVICE_CONNECTION) return { ...outcome, result: json({ ...action, result: null }) };
        }
        return outcome;
      });
      else promise = this.#admit(cap, input, options.signal);
    } catch (error) { return Promise.reject(this.#safe(error)); }
    const tracked = promise.catch(error => { throw this.#safe(error); }); this.#calls.add(tracked);
    const release = () => this.#calls.delete(tracked); void tracked.then(release, release); return tracked;
  }
  #admit(cap: Cap, input: Record<string, unknown>, signal?: AbortSignal): Promise<GatewayCallResult> {
    if (Object.keys(input).sort().join(',') !== 'arguments,callId,connectionId,tool' || typeof input.callId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.callId)) fail('invalid_input');
    const def = MEMORY_SERVICE_READ_TOOLS.find(d => d.name === input.tool); if (!def) fail('forbidden');
    const args = validateArguments(def.inputSchema, input.arguments);
    if (def.name.endsWith('.recall') && (!(args.query as string).trim() || !isWellFormedText(args.query as string))) fail('invalid_input');
    const call: ReadCall = { tool: def.name, callId: input.callId, arguments: args };
    const hash = sha(canonicalJson(json({ turnId: cap.scope.turnId, tool: call.tool, callId: call.callId, input: args })));
    const lane = this.#lanes.get(cap.scope.turnId) ?? { tail: Promise.resolve(), active: 0, waiting: 0, admissions: new Map<string, Admission>() };
    const previous = lane.admissions.get(call.callId);
    if (previous) {
      if (previous.hash !== hash || !previous.actionId) fail('conflict');
      this.#guard(previous, signal); const action = this.#o.store.getAction(previous.actionId);
      if (action.state === 'ready') return this.#execute(previous, action, signal).then(a => this.#disclose(previous, a, signal));
      return Promise.resolve(this.#disclose(previous, action, signal));
    }
    if (lane.admissions.size >= MEMORY_SERVICE_READ_LIMITS.totalPerTurn) fail('unavailable');
    this.#pin(cap, call.tool, false);
    // Local deterministic subject metadata only, as in MemoryService. No remote account/user/grant is created.
    this.#o.context.memoryLedger.provisionBotSubject(cap.scope.botId);
    const admission: Admission = { hash, cap, call, pin: this.#pin(cap, call.tool), actionId: null };
    this.#guard(admission, signal);
    if (admission.pin.grantPolicy !== 'ask' && lane.active && lane.waiting >= MEMORY_SERVICE_READ_LIMITS.waitingPerTurn) fail('unavailable');
    // Existing ASK only. No setGrant/setProposalGrant, no owner action or origin supplied by a caller.
    if (admission.pin.grantPolicy === 'ask') {
      if (this.#o.store.findAction(cap.scope.botId, 'memory_service_' + sha(cap.scope.turnId + '\0' + call.callId).slice(0, 48))) fail('conflict');
      const action = this.#o.store.requestAction({ botId: cap.scope.botId, threadId: cap.scope.threadId, tool: call.tool, destination: MEMORY_SERVICE_CONNECTION,
        idempotencyKey: 'memory_service_' + sha(cap.scope.turnId + '\0' + call.callId).slice(0, 48), arguments: { input: args, pin: json(admission.pin) } });
      this.#o.store.bindToolAction(action.id, cap.scope.turnId, call.callId);
      admission.actionId = action.id; this.#actions.set(action.id, admission); lane.admissions.set(call.callId, admission); this.#lanes.set(cap.scope.turnId, lane);
      return action.state === 'ready' ? this.#execute(admission, action, signal).then(a => this.#disclose(admission, a, signal)) : Promise.resolve(project(action));
    }
    lane.admissions.set(call.callId, admission); this.#lanes.set(cap.scope.turnId, lane);
    return this.#enqueue(admission, signal).then(result => {
      this.#guard(admission, signal);
      const body = result as { memories?: MemoryServiceMemory[]; memory?: MemoryServiceMemory | null };
      this.#checkRecords(admission, body.memories ?? body.memory ?? null);
      return { actionId: 'memory-service-read-' + hash.slice(0, 24), status: 'succeeded', requestHash: hash, reason: null, result };
    });
  }
  #enqueue(admission: Admission, signal?: AbortSignal): Promise<JsonValue> {
    const lane = this.#lanes.get(admission.cap.scope.turnId)!;
    if (lane.active && lane.waiting >= MEMORY_SERVICE_READ_LIMITS.waitingPerTurn) return Promise.reject(new GatewayError('unavailable', 'Memory read queue full.'));
    const queued = lane.active > 0; if (queued) lane.waiting++; lane.active++;
    const work = lane.tail.then(async () => {
      if (queued) lane.waiting--;
      this.#guard(admission, signal);
      const controller = new AbortController(); const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true }); admission.cap.controller.signal.addEventListener('abort', abort, { once: true });
      if (signal?.aborted || admission.cap.controller.signal.aborted) abort();
      let token: string | undefined;
      try {
        this.#guard(admission, controller.signal); token = this.#o.context.issue(admission.cap.scope.turnId);
        const authority = canonicalJson(json(this.#o.memory.readAuthority(token)));
        const guard = () => this.#guard(admission, controller.signal);
        const lease = admission.call.tool.endsWith('.recall')
          ? this.#o.memory.beginRecall(token, admission.call.arguments as unknown as { query: string; limit?: number }, { signal: controller.signal, guard })
          : this.#o.memory.beginRead(token, admission.call.arguments as unknown as { recordId: string; revision: number; sha256: string }, { signal: controller.signal, guard });
        let result: MemoryServiceMemory[] | MemoryServiceMemory | null;
        try { result = await lease.result; } finally { await lease.whenDrained(); }
        guard();
        if (canonicalJson(json(this.#o.memory.readAuthority(token))) !== authority) fail('forbidden');
        this.#checkRecords(admission, result);
        return json(admission.call.tool.endsWith('.recall') ? { memories: result } : { memory: result });
      } finally {
        // Revoke only AFTER the exact service job, ignored-abort fetch and body/cancel closures drain.
        if (token) try { this.#o.context.revoke(token); } catch { this.#cleanupFailed = true; fail('unavailable'); }
        signal?.removeEventListener('abort', abort); admission.cap.controller.signal.removeEventListener('abort', abort);
      }
    });
    const complete = work.finally(() => { lane.active--; }); lane.tail = complete.then(() => {}, () => {}); return complete;
  }
  #checkRecords(admission: Admission, result: unknown): void {
    const rows = Array.isArray(result) ? result : result === null ? [] : [result];
    for (const item of rows) {
      const ref = item as MemoryServiceMemory;
      const record = this.#o.context.memoryLedger.readActiveReference(admission.cap.scope.botId,
        { recordId: ref.recordId, revision: ref.revision, sha256: ref.sha256, scopeEpoch: admission.pin.scopeEpoch });
      if (record.scope.kind !== 'bot' || record.scope.botId !== admission.cap.scope.botId) fail('forbidden');
    }
  }
  #execute(admission: Admission, action: Action, signal?: AbortSignal): Promise<Action> {
    const prior = this.#executions.get(action.id); if (prior) return prior;
    this.#guard(admission, signal);
    if (action.request.botId !== admission.cap.scope.botId || action.request.threadId !== admission.cap.scope.threadId
      || action.request.tool !== admission.call.tool || canonicalJson(action.request.arguments) !== canonicalJson({ input: admission.call.arguments, pin: json(admission.pin) })) fail('conflict');
    const result = dispatchAction(this.#o.store, action.id, async (_request, context) => this.#enqueue(admission, context.signal), signal)
      .then(a => { this.#o.store.recordToolOutcome(a.id, a.result); return a; });
    this.#executions.set(action.id, result); void result.then(() => this.#executions.delete(action.id), () => this.#executions.delete(action.id)); return result;
  }
  #disclose(admission: Admission, action: Action, signal?: AbortSignal): GatewayCallResult {
    this.#guard(admission, signal);
    if (action.state === 'succeeded') {
      const result = action.result as { memories?: MemoryServiceMemory[]; memory?: MemoryServiceMemory | null } | null;
      this.#checkRecords(admission, result?.memories ?? result?.memory ?? null);
    }
    return project(action);
  }
  async continueOwnerAction(action: Action): Promise<Action> {
    if (action.request.destination !== MEMORY_SERVICE_CONNECTION || action.state !== 'ready') return action;
    const admission = this.#actions.get(action.id);
    if (!admission || this.#stopped) return this.#o.store.blockAction(action.id);
    let receipt: Action;
    try { receipt = await this.#execute(admission, action); } catch { return this.#o.store.blockAction(action.id); }
    try { return { ...receipt, result: this.#disclose(admission, receipt).result }; }
    catch { return { ...receipt, result: null }; } // Withhold late bytes without rewriting the committed outcome.
  }
  revokeCapability(token: string): void { if (typeof token !== 'string') return; const key = sha(token), cap = this.#caps.get(key); if (cap) this.#remove(key, cap); }
  #remove(key: string, cap: Cap): void { this.#caps.delete(key); cap.controller.abort(); this.#o.base.revokeCapability(cap.token); }
  stopAdmission(): void { this.#stopped = true; for (const [key, cap] of this.#caps) this.#remove(key, cap); }
  close(): Promise<void> {
    this.stopAdmission(); return this.#closing ??= (async () => {
      while (this.#calls.size || this.#executions.size || [...this.#lanes.values()].some(l => l.active))
        await Promise.allSettled([...this.#calls, ...this.#executions.values(), ...[...this.#lanes.values()].map(l => l.tail)]);
      if (this.#cleanupFailed) fail('unavailable');
    })();
  }
  #safe(error: unknown): GatewayError {
    if (error instanceof GatewayError) return error;
    if (error instanceof MemoryServiceError) return new GatewayError(error.code === 'invalid_input' ? 'invalid_input' : ['forbidden', 'revoked', 'not_implemented'].includes(error.code) ? 'forbidden' : 'unavailable', `Memory service ${error.code}.`);
    return new GatewayError('unavailable', 'Memory read unavailable.');
  }
}
