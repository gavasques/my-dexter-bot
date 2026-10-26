import { createHash } from "node:crypto";
import { validateAutomationWhen } from "@dexter/agenda";
import type { Action, JsonValue } from "@dexter/contracts";
import { GatewayError, MCP_AUTHORIZED_INVENTORY_LIMIT, type CapabilityScope, type GatewayCallResult, type InputSchema, type ToolView, type TurnToolSurface } from "@dexter/gateway";
import { canonicalJson, dispatchAction, HostError, type HostStore } from "@dexter/hub";
import type { HostAutomationPort } from "@dexter/hub/http";
import { isWellFormedText } from "./text-input.js";

export const AUTOMATION_DESTINATION = "dexter-automations";
const PREFIX = "dexter.automations.";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const same = (a: JsonValue, b: JsonValue): boolean => canonicalJson(a) === canonicalJson(b);
type Values = Record<string, JsonValue>;
const credentialText = (text: string): boolean => /(?:\b(?:sk-|sk_live_|sk_test_|github_pat_|gh[pousr]_|xox[abprs]-|glpat-|AIza|AKIA|ASIA|ya29\.)[A-Za-z0-9_+=./-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|passphrase)\s*[:=]\s*["']?(?:Bearer\s+)?[A-Za-z0-9_+=./-]{12,})/i.test(text);
function fail(code: "invalid_input" | "forbidden" | "conflict" | "unauthorized" | "unavailable"): never { throw new GatewayError(code, `Automation operation refused: ${code}.`); }
function object(value: unknown): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid_input"); return value as Record<string, unknown>; }
const project = (action: Action): GatewayCallResult => ({ actionId: action.id, status: action.state, requestHash: action.requestHash, reason: action.reason, result: action.result });
interface Capability { token: string; scope: Readonly<CapabilityScope>; controllers: Set<AbortController>; baseTargets: ReadonlySet<string>; ownerActionId?: string }
interface Definition { name: "list" | "preview" | "create" | "update" | "state" | "run" | "history"; description: string; write: boolean; inputSchema: InputSchema }
const recurrence: InputSchema["properties"] = {
  kind: { type: "string", enum: ["once", "interval", "cron"], minLength: 1, maxLength: 8 },
  at: { type: "integer", minimum: 0, maximum: MAX_TIMESTAMP },
  every_ms: { type: "integer", minimum: 60_000, maximum: 30 * 24 * 60 * 60_000 },
  first_at: { type: "integer", minimum: 0, maximum: MAX_TIMESTAMP },
  cron: { type: "string", minLength: 9, maxLength: 128 },
  time_zone: { type: "string", minLength: 1, maxLength: 100 },
};
const target: InputSchema["properties"] = { schedule_id: { type: "string", minLength: 1, maxLength: 128 }, expectedRevision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER - 1 } };
const body: InputSchema["properties"] = { title: { type: "string", minLength: 1, maxLength: 160 }, content: { type: "string", minLength: 1, maxLength: 32_768 }, ...recurrence };
const schema = (properties: InputSchema["properties"], required: string[]): InputSchema => ({ type: "object", properties, required, additionalProperties: false });
const definitions: Definition[] = [
  { name: "list", write: false, description: "List automations belonging only to this bot in the current conversation. Returns revision, state and next due date; schedules in other bots, other private conversations or other team conversations are not visible. No inference or tools run. Use the returned cursor for the next bounded page.", inputSchema: schema({ limit: { type: "integer", minimum: 1, maximum: 100 }, after_created_at: { type: "integer", minimum: 0, maximum: MAX_TIMESTAMP }, after_id: { type: "string", minLength: 1, maxLength: 128 } }, []) },
  { name: "preview", write: false, description: "Preview up to eight UTC dates for a proposed automation using the host's canonical recurrence and IANA time zone. once requires at; interval requires every_ms and first_at; cron requires a five-field cron and time_zone. Unrelated recurrence fields are refused. Preview creates no schedule, approval, turn or tool action.", inputSchema: schema({ ...recurrence, after: { type: "integer", minimum: 0, maximum: MAX_TIMESTAMP }, count: { type: "integer", minimum: 1, maximum: 8 } }, ["kind"]) },
  { name: "create", write: true, description: "Propose creating an active automation for this bot in this exact conversation. Exact owner approval binds title, instruction, recurrence, bot and conversation. Identity and request id are derived by the host. Future runs use this bot's current grants and approval mode; changes to authority still require explicit human approval. This does not activate cloud hosting: the current host must be running. Read preview first; use the same call id when recovering an uncertain receipt.", inputSchema: schema(body, ["title", "content", "kind"]) },
  { name: "update", write: true, description: "Propose replacing title, instruction and recurrence of your own current-conversation automation with expectedRevision and exact owner approval. Bot and conversation remain fixed. A stale revision or changed state blocks the proposal. It does not cancel an already accepted turn or grant tool permissions.", inputSchema: schema({ ...target, ...body }, ["schedule_id", "expectedRevision", "title", "content", "kind"]) },
  { name: "state", write: true, description: "Propose pausing (disabled) or resuming (active) one own current-conversation automation, with expectedRevision and exact owner approval. Pausing prevents future admissions but does not cancel accepted work or reverse effects. Completed one-off schedules cannot be resumed; create a new approved schedule. Other bots and conversations remain inaccessible.", inputSchema: schema({ ...target, state: { type: "string", enum: ["active", "disabled"], minLength: 1, maxLength: 8 } }, ["schedule_id", "expectedRevision", "state"]) },
  { name: "run", write: true, description: "Run one immediate occurrence of your own current-conversation automation with expectedRevision. Ask mode requests exact owner approval; Approve all covers only an already enabled run tool. The durable receipt confirms admission preparation, not a successful model answer or external effect. The regular next due date is preserved. Check history; unknown receipts are never automatically resent and tool execution retains the current grants and approval policy.", inputSchema: schema(target, ["schedule_id", "expectedRevision"]) },
  { name: "history", write: false, description: "Read bounded execution history of one automation belonging to this bot and current conversation, including the actual canonical turn state when available. Prepared or accepted does not mean completed successfully. No other bots, private conversations or team conversations are exposed.", inputSchema: schema({ schedule_id: target.schedule_id!, limit: { type: "integer", minimum: 1, maximum: 100 }, after_scheduled_at: { type: "integer", minimum: 0, maximum: MAX_TIMESTAMP } }, ["schedule_id"]) },
];

export interface AutomationTurnSurfaceOptions { store: HostStore; base: TurnToolSurface; port: () => Readonly<HostAutomationPort> | undefined }

/** First-party host-only tools. This facade neither relaxes generic MCP schemas nor starts its own scheduler. */
export class AutomationTurnSurface implements TurnToolSurface {
  readonly #options: AutomationTurnSurfaceOptions;
  readonly #capabilities = new Map<string, Capability>();
  readonly #calls = new Set<Promise<GatewayCallResult>>();
  readonly #ownerControllers = new Set<AbortController>();
  readonly #executions = new Map<string, Promise<GatewayCallResult>>();
  readonly #admissions = new Map<string, Set<string>>();
  #stopped = false;
  #closing: Promise<void> | null = null;
  constructor(options: AutomationTurnSurfaceOptions) { this.#options = options; }

  issueCapability(input: { turnId: string; ttlMs?: number }): { token: string; scope: CapabilityScope } {
    if (this.#stopped) fail("unavailable");
    for (const [key, cap] of this.#capabilities) { try { this.#validate(cap); } catch { this.#remove(key, cap); } }
    for (const turnId of this.#admissions.keys()) if (this.#options.store.getTurn(turnId).state !== "running") this.#admissions.delete(turnId);
    if (this.#capabilities.size >= 128) fail("unavailable");
    const issued = this.#options.base.issueCapability(input);
    const cap: Capability = { token: issued.token, scope: Object.freeze({ ...issued.scope }), controllers: new Set(), baseTargets: new Set() };
    try {
      if (!TOKEN.test(cap.token) || cap.scope.turnId !== input.turnId) fail("unauthorized");
      this.#validate(cap); const views = this.#options.base.listTools(cap.token);
      if (views.length > MCP_AUTHORIZED_INVENTORY_LIMIT) fail("unavailable");
      cap.baseTargets = new Set(views.map(view => `${view.connectionId}\0${view.name}`)); this.#capabilities.set(sha(cap.token), cap);
      this.listTools(cap.token);
      return { token: cap.token, scope: { ...cap.scope } };
    } catch (error) { this.#capabilities.delete(sha(cap.token)); this.#options.base.revokeCapability(cap.token); throw error; }
  }
  #validate(cap: Capability, signal?: AbortSignal): void {
    const store = this.#options.store, scope = cap.scope;
    if (this.#stopped || signal?.aborted || scope.expiresAt <= store.now()) fail("unauthorized");
    store.assertActiveWriter(); store.assertTeamTurn(scope.turnId);
    const turn = store.getTurn(scope.turnId), thread = store.getThread(scope.threadId), bot = store.getBot(scope.botId);
    if(cap.ownerActionId && store.ownerToolScope(cap.ownerActionId).turnId!==scope.turnId)fail("forbidden");
    if ((!cap.ownerActionId && turn.state !== "running") || turn.botId !== bot.id || turn.threadId !== thread.id || thread.botId !== bot.id
      || scope.installationId !== store.hostId || scope.ownerId !== store.ownerId || bot.ownerId !== scope.ownerId || bot.profileId !== scope.profileId) fail("unauthorized");
  }
  #resolve(token: string, signal?: AbortSignal): Capability {
    if (typeof token !== "string" || !TOKEN.test(token)) fail("unauthorized");
    const cap = this.#capabilities.get(sha(token)); if (!cap) fail("unauthorized"); this.#validate(cap, signal); return cap;
  }
  #port(): Readonly<HostAutomationPort> {
    const port = this.#options.port(); if (!port) fail("unavailable");
    const status = object(port.status()); if (status.hostId !== this.#options.store.hostId) fail("unavailable"); return port;
  }
  #available(cap: Capability, definition: Definition): boolean {
    if (!this.#options.port()) return false;
    if (!definition.write) return true;
    const grant = this.#options.store.getGrant(cap.scope.botId, PREFIX + definition.name, AUTOMATION_DESTINATION);
    // Owner-controlled configuration stays human-only; an already granted own run may use the bot policy.
    return !grant || grant.policy === "ask" && (grant.expiresAt === null || grant.expiresAt > this.#options.store.now());
  }
  listTools(token: string): ToolView[] {
    const cap = this.#resolve(token), views = this.#options.base.listTools(token).filter(view => cap.baseTargets.has(`${view.connectionId}\0${view.name}`));
    for (const definition of definitions) if (this.#available(cap, definition)) views.push({ name: PREFIX + definition.name,
      connectionId: AUTOMATION_DESTINATION, connectionLabel: "Dexter automations", description: definition.description,
      effect: definition.write ? "write" : "read", requiresApproval: definition.write && this.#options.store.actionRequiresApproval(cap.scope.botId, PREFIX + definition.name, AUTOMATION_DESTINATION, definition.name === "run" ? "automation" : undefined,cap.scope.threadId), inputSchema: structuredClone(definition.inputSchema) });
    if (views.length > MCP_AUTHORIZED_INVENTORY_LIMIT) fail("unavailable"); return views;
  }
  call(token: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<GatewayCallResult> {
    let cap: Capability; try { cap = this.#resolve(token, options.signal); } catch (error) { return Promise.reject(error); }
    const controller = new AbortController(), abort = (): void => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true }); cap.controllers.add(controller);
    const operation = this.#call(cap, input, controller.signal).catch(error => {
      if (error instanceof GatewayError || error instanceof HostError && error.code === "host_locked") throw error;
      throw new GatewayError("unavailable", "Automation operation unavailable.");
    });
    this.#calls.add(operation);
    const release = (): void => { this.#calls.delete(operation); cap.controllers.delete(controller); options.signal?.removeEventListener("abort", abort); };
    void operation.then(release, release); return operation;
  }
  #arguments(definition: Definition, raw: unknown): Values {
    const args = object(raw), schema = definition.inputSchema;
    if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key)) || schema.required.some(key => !Object.hasOwn(args, key))) fail("invalid_input");
    for (const [key, value] of Object.entries(args)) {
      const property = schema.properties[key]!;
      if (property.type === "string") {
        if (typeof value !== "string" || value.length < (property.minLength ?? 0) || value.length > property.maxLength
          || !isWellFormedText(value) || credentialText(value) || property.enum && !property.enum.includes(value)) fail("invalid_input");
      } else if (property.type === "integer") {
        if (!Number.isSafeInteger(value) || property.minimum !== undefined && (value as number) < property.minimum
          || property.maximum !== undefined && (value as number) > property.maximum) fail("invalid_input");
      } else fail("invalid_input");
    }
    if (definition.name === "list" && (args.after_id === undefined) !== (args.after_created_at === undefined)) fail("invalid_input");
    if (definition.name === "preview" || definition.name === "create" || definition.name === "update") {
      const selected = args.kind === "once" ? ["at"] : args.kind === "interval" ? ["every_ms", "first_at"] : ["cron", "time_zone"];
      for (const key of ["at", "every_ms", "first_at", "cron", "time_zone"]) if (selected.includes(key) !== Object.hasOwn(args, key)) fail("invalid_input");
      const when = args.kind === "once" ? { kind: "once", at: args.at } : args.kind === "interval" ? { kind: "interval", everyMs: args.every_ms, firstAt: args.first_at }
        : { kind: "cron", expression: args.cron, timeZone: args.time_zone };
      let checked: JsonValue; try { checked = json(validateAutomationWhen(when)); } catch { fail("invalid_input"); }
      if (definition.name === "preview") return { when: checked, ...(args.after === undefined ? {} : { after: args.after as number }), ...(args.count === undefined ? {} : { count: args.count as number }) };
      if (!(args.title as string).trim() || !(args.content as string).trim()) fail("invalid_input");
      return { ...(definition.name === "update" ? { scheduleId: args.schedule_id as string, expectedRevision: args.expectedRevision as number } : {}), title: (args.title as string).trim(), content: args.content as string, when: checked };
    }
    if (definition.name === "list") return { limit: (args.limit as number | undefined) ?? 100, ...(args.after_id === undefined ? {} : { after: { createdAt: args.after_created_at as number, id: args.after_id as string } }) };
    if (definition.name === "history") return { scheduleId: args.schedule_id as string, limit: (args.limit as number | undefined) ?? 100,
      ...(args.after_scheduled_at === undefined ? {} : { after: { scheduleId: args.schedule_id as string, scheduledAt: args.after_scheduled_at as number } }) };
    return { scheduleId: args.schedule_id as string, expectedRevision: args.expectedRevision as number,
      ...(definition.name === "state" ? { state: args.state as string } : {}) };
  }
  #ownSchedule(cap: Capability, id: string): Values {
    let row: Record<string, unknown>; try { row = object(this.#port().get(id)); } catch { fail("forbidden"); }
    if (row.id !== id || row.botId !== cap.scope.botId || row.threadId !== cap.scope.threadId || row.ownerId !== cap.scope.ownerId
      || row.installationId !== cap.scope.installationId || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1) fail("forbidden");
    return json(row) as Values;
  }
  #scheduleProjection(row: Values): Values {
    const fields = ["id", "botId", "threadId", "title", "content", "kind", "at", "intervalMs", "firstAt", "cron", "timeZone", "nextAt", "state", "revision", "createdAt", "updatedAt"];
    return Object.fromEntries(fields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]!])) as Values;
  }
  #pin(cap: Capability, definition: Definition, args: Values): Values {
    const common: Values = { hostId: cap.scope.installationId, ownerId: cap.scope.ownerId, botId: cap.scope.botId, threadId: cap.scope.threadId, profileId: cap.scope.profileId };
    if (definition.name === "create" || definition.name === "update") {
      const when = object(args.when);
      if (when.kind !== "cron" && (when.kind === "once" ? when.at as number : when.firstAt as number) <= this.#options.store.now()) fail("conflict");
    }
    if (definition.name === "create") return { ...common, expectedRevision: 0 };
    const row = this.#ownSchedule(cap, args.scheduleId as string);
    if (row.revision !== args.expectedRevision) fail("conflict");
    // Tick can update nextAt/updatedAt without changing the approved schedule revision; these are not CAS fields.
    const snapshot = this.#scheduleProjection(row); delete snapshot.nextAt; delete snapshot.updatedAt;
    return { ...common, schedule: snapshot };
  }
  #validateRunning(cap: Capability, id: string, signal: AbortSignal): void {
    this.#validate(cap, signal); const store = this.#options.store, action = store.getAction(id), grant = store.getGrant(cap.scope.botId, action.request.tool, AUTOMATION_DESTINATION);
    if (action.state !== "running" || action.request.botId !== cap.scope.botId || action.request.threadId !== cap.scope.threadId || action.request.destination !== AUTOMATION_DESTINATION
      || !grant || grant.policy !== "ask" || grant.revision !== action.grantRevision || grant.expiresAt !== null && grant.expiresAt <= store.now()) fail("forbidden");
  }
  #list(cap: Capability, args: Values): JsonValue {
    const store = this.#options.store, port = this.#port(), limit = args.limit as number;
    let after = args.after === undefined ? undefined : object(args.after);
    if (after) { const own = this.#ownSchedule(cap, after.id as string); if (own.createdAt !== after.createdAt) fail("invalid_input"); }
    const items: Values[] = [];
    // The canonical agenda caps schedules at 10,000. Keyset reads stay bounded and never return a foreign-thread cursor.
    for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
      const page = object(port.list({ hostId: store.hostId, botId: cap.scope.botId, limit: 500, ...(after ? { after } : {}) }));
      if (!Array.isArray(page.items) || page.items.length > 500) fail("unavailable");
      for (const raw of page.items) {
        const row = object(raw); if (row.botId !== cap.scope.botId) fail("unavailable");
        if (row.threadId !== cap.scope.threadId) continue;
        const own = this.#ownSchedule(cap, row.id as string); items.push(this.#scheduleProjection(own));
        if (items.length > limit) return { items: items.slice(0, limit), nextCursor: { createdAt: items[limit - 1]!.createdAt!, id: items[limit - 1]!.id! } };
      }
      if (page.nextCursor === null) return { items, nextCursor: null };
      const next = object(page.nextCursor); if (same(json(next), json(after ?? null))) fail("unavailable"); after = next;
    }
    fail("unavailable");
  }
  #read(cap: Capability, definition: Definition, args: Values): JsonValue {
    const store = this.#options.store, port = this.#port();
    if (definition.name === "list") return this.#list(cap, args);
    if (definition.name === "preview") return json(port.preview({ hostId: store.hostId, ...args }));
    this.#ownSchedule(cap, args.scheduleId as string);
    const page = object(port.history({ hostId: store.hostId, botId: cap.scope.botId, ...args }));
    if (!Array.isArray(page.items) || page.items.length > (args.limit as number)) fail("unavailable");
    for (const raw of page.items) {
      const item = object(raw); if (item.scheduleId !== args.scheduleId) fail("unavailable");
      if (item.turnId !== null && item.turnId !== undefined) {
        const turn = store.getTurn(item.turnId as string); if (turn.botId !== cap.scope.botId || turn.threadId !== cap.scope.threadId) fail("forbidden");
      }
    }
    if (page.nextCursor !== null && object(page.nextCursor).scheduleId !== args.scheduleId) fail("unavailable");
    return json(page);
  }
  #execute(cap: Capability, definition: Definition, args: Values, id: string): JsonValue {
    const store = this.#options.store, port = this.#port(), clientRequestId = `automation_${sha(id).slice(0, 48)}`;
    const common = { hostId: store.hostId, clientRequestId, expectedRevision: definition.name === "create" ? 0 : args.expectedRevision };
    const input = definition.name === "create" ? { ...common, botId: cap.scope.botId, threadId: cap.scope.threadId, title: args.title, content: args.content, when: args.when }
      : definition.name === "update" ? { ...common, title: args.title, content: args.content, when: args.when }
      : definition.name === "state" ? { ...common, state: args.state } : common;
    const receipt = object(definition.name === "create" ? port.create(input) : definition.name === "update" ? port.update(args.scheduleId as string, input)
      : definition.name === "state" ? port.state(args.scheduleId as string, input) : port.run(args.scheduleId as string, input));
    if (receipt.hostId !== store.hostId || receipt.clientRequestId !== clientRequestId || receipt.operation !== definition.name || typeof receipt.scheduleId !== "string") fail("unavailable");
    const row = this.#ownSchedule(cap, receipt.scheduleId);
    if (definition.name !== "create" && row.id !== args.scheduleId || row.revision !== receipt.revision) fail("unavailable");
    const result: Values = { ...json(receipt) as Values, schedule: this.#scheduleProjection(row) };
    if (definition.name === "run") result.executionConfirmed = false;
    if (definition.name === "state") result.acceptedTurnsCancelled = false;
    result.toolPermissionsChanged = false; return result;
  }
  async #call(cap: Capability, raw: unknown, signal: AbortSignal): Promise<GatewayCallResult> {
    if (this.#calls.size >= 64) fail("unavailable"); const call = object(raw);
    if (call.connectionId !== AUTOMATION_DESTINATION) {
      if (typeof call.connectionId !== "string" || typeof call.tool !== "string" || !cap.baseTargets.has(`${call.connectionId}\0${call.tool}`)) fail("forbidden");
      const result = await this.#options.base.call(cap.token, raw, { signal }); this.#validate(cap, signal); return result;
    }
    if (Object.keys(call).sort().join(",") !== "arguments,callId,connectionId,tool" || typeof call.callId !== "string" || !CALL_ID.test(call.callId)
      || typeof call.tool !== "string") fail("invalid_input");
    const definition = definitions.find(item => PREFIX + item.name === call.tool); if (!definition) fail("forbidden");
    const args = cap.ownerActionId ? object(call.arguments) as Values : this.#arguments(definition, call.arguments), store = this.#options.store;
    if (!definition.write) {
      if (!this.#available(cap, definition)) fail("forbidden"); const result = this.#read(cap, definition, args); this.#validate(cap, signal);
      const requestHash = sha(canonicalJson({ tool: call.tool, turnId: cap.scope.turnId, callId: call.callId, input: args }));
      return { actionId: `automation-read-${requestHash.slice(0, 24)}`, status: "succeeded", requestHash, reason: null, result };
    }
    const continued=store.replayedContinuationAction(cap.scope.turnId,call.tool as string,AUTOMATION_DESTINATION,args);
    if(continued)return project(continued);
    const key = `automation_${sha(`${cap.scope.turnId}\0${call.callId}`).slice(0, 48)}`;
    let action = store.findAction(cap.scope.botId, key);
    if (action) {
      if(cap.ownerActionId && cap.ownerActionId!==action.id)fail("forbidden");
      if (action.request.tool !== call.tool || action.request.threadId !== cap.scope.threadId || action.request.destination !== AUTOMATION_DESTINATION
        || !same(action.request.arguments.input ?? null, args)) fail("conflict");
      const ongoing = this.#executions.get(action.id); if (ongoing) return ongoing;
      // Never rerun an unknown/terminal mutation, even if the canonical agenda already contains its receipt.
      if (action.state !== "ready") return project(action);
    } else {
      if(cap.ownerActionId)fail("forbidden");
      if (!this.#available(cap, definition)) fail("forbidden"); this.#validate(cap, signal);
      const admitted = this.#admissions.get(cap.scope.turnId) ?? new Set<string>(); if (admitted.size >= 32) fail("unavailable");
      const pin = this.#pin(cap, definition, args), grant = store.getGrant(cap.scope.botId, call.tool, AUTOMATION_DESTINATION);
      if (!grant) store.setProposalGrant({ botId: cap.scope.botId, tool: call.tool, destination: AUTOMATION_DESTINATION, policy: "ask" });
      else if (grant.policy !== "ask") fail("forbidden");
      action = store.requestAction({ botId: cap.scope.botId, threadId: cap.scope.threadId, tool: call.tool, destination: AUTOMATION_DESTINATION,
        idempotencyKey: key, arguments: { input: args, pin } }, definition.name === "run" ? "automation" : undefined);
      store.bindToolAction(action.id,cap.scope.turnId,call.callId);
      if (!["awaiting_approval", "ready"].includes(action.state)) fail("forbidden"); admitted.add(action.id); this.#admissions.set(cap.scope.turnId, admitted);
      if (action.state !== "ready") return project(action);
    }
    const pin = object(action.request.arguments.pin) as Values;
    try { this.#validate(cap, signal); if (!this.#available(cap, definition) || !same(this.#pin(cap, definition, args), pin)) fail("forbidden"); }
    catch (error) { if (error instanceof HostError && error.code === "host_locked") throw error; return project(store.blockAction(action.id)); }
    const id = action.id;
    const executionCap:Capability={...cap,scope:store.ownerToolScope(id),ownerActionId:id};
    const execution = dispatchAction(store, id, async (_request, context) => {
      this.#validateRunning(executionCap, id, context.signal); if (!same(this.#pin(executionCap, definition, args), pin)) fail("forbidden");
      const result = this.#execute(executionCap, definition, args, id);
      // Successful CAS intentionally changes its schedule pin. Scope and exact grant still must remain valid.
      this.#validateRunning(executionCap, id, context.signal); return result;
    }, signal).then(receipt=>{store.recordToolOutcome(id,receipt.result);return project(receipt);});
    this.#executions.set(id, execution);
    try { return await execution; } finally { this.#executions.delete(id); }
  }
  /** Private host replay of the exact already admitted action, with all current pins enforced. */
  async continueOwnerAction(action: Action): Promise<Action> {
    if(action.request.destination!==AUTOMATION_DESTINATION || action.state!=="ready")return this.#options.store.getAction(action.id);
    const store=this.#options.store, origin=store.toolActionOrigin(action.id);
    if(!origin)fail("forbidden");
    const cap:Capability={token:"",scope:store.ownerToolScope(action.id),controllers:new Set(),baseTargets:new Set(),ownerActionId:action.id};
    const controller=new AbortController();this.#ownerControllers.add(controller);
    const operation=this.#call(cap,{connectionId:AUTOMATION_DESTINATION,tool:action.request.tool,callId:origin.callId,arguments:action.request.arguments.input},controller.signal);
    const tracked=operation.then(outcome=>{store.recordToolOutcome(action.id,outcome.result);return store.getAction(action.id);});
    this.#calls.add(operation);
    try { return await tracked; } finally { this.#calls.delete(operation);this.#ownerControllers.delete(controller); }
  }
  #remove(key: string, cap: Capability): void { this.#capabilities.delete(key); for (const controller of cap.controllers) controller.abort(); this.#options.base.revokeCapability(cap.token); }
  revokeCapability(token: string): void { if (typeof token !== "string") return; const key = sha(token), cap = this.#capabilities.get(key); if (cap) this.#remove(key, cap); }
  stopAdmission(): void { this.#options.store.stopApprovedExecutions(undefined,AUTOMATION_DESTINATION); for(const controller of this.#ownerControllers)controller.abort(); this.#stopped = true; for (const [key, cap] of this.#capabilities) this.#remove(key, cap); }
  drain(): Promise<void> { return Promise.allSettled([...this.#calls]).then(() => {}); }
  close(): Promise<void> { this.stopAdmission(); return this.#closing ??= this.drain(); }
}
