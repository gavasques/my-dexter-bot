import { createHash } from "node:crypto";
import { BrowserUseBotPolicySchema, defaultBrowserUseBotPolicy, type Action, type BrowserUseBotPolicy, type JsonValue } from "@dexter/contracts";
import { BrowserUseClient, BrowserUseKeyVault, browserUseContainsSecret, browserUseStartUrlAllowed } from "@dexter/connectors";
import { GatewayError, MCP_AUTHORIZED_INVENTORY_LIMIT, type CapabilityScope, type GatewayCallResult, type InputSchema, type ToolView, type TurnToolSurface } from "@dexter/gateway";
import { canonicalJson, dispatchAction, HostError, type HostStore } from "@dexter/hub";
import { isWellFormedText } from "./text-input.js";

export const BROWSER_USE_DESTINATION = "browser-use-cloud";
const PREFIX = "dexter.browseruse.";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const same = (a: JsonValue, b: JsonValue): boolean => canonicalJson(a) === canonicalJson(b);
function fail(code: "invalid_input" | "forbidden" | "conflict" | "unauthorized" | "unavailable"): never { throw new GatewayError(code, `Browser Use refused: ${code}.`); }
function object(value: unknown): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid_input"); return value as Record<string, unknown>; }
const project = (action: Action): GatewayCallResult => ({ actionId: action.id, status: action.state, requestHash: action.requestHash, reason: action.reason, result: action.result });
type Values = Record<string, JsonValue>;
interface Capability { token: string; scope: Readonly<CapabilityScope>; controllers: Set<AbortController>; baseTargets: ReadonlySet<string>; ownerActionId?: string }
interface Execution { botId: string; revision: number; controller: AbortController }
interface Definition { name: "status" | "run" | "configure"; description: string; write: boolean; inputSchema: InputSchema }
const definitions: Definition[] = [
  { name: "status", write: false, description: "Read only your own Browser Use Cloud policy and process key availability. Presence never proves authentication. Local Mac browser grants are separate. No cookies, key values, live URLs, remote tasks or other bots are returned.", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } },
  { name: "run", write: true, description: "Propose one complete Browser Use Cloud task, covering all autonomous browser steps under an exact owner approval in Ask mode or the human-selected Approve all policy for already enabled runs. This schema is discoverable before activation; its presence does not grant access. Read status for live runAvailable, including after an approved configure, then continue the original task in the same turn if ready. Runs only inside this bot's allowed domains, maximum steps and local deadline. The provider may bill this task; there is no hard spending cap. No personal browser cookies are imported. Cancellation attempts to stop the known task and session; uncertain delivery is never resent. Read the receipt before any new proposal.", inputSchema: { type: "object", properties: { task: { type: "string", minLength: 1, maxLength: 8192 }, start_url: { type: "string", minLength: 1, maxLength: 2048 } }, required: ["task", "start_url"], additionalProperties: false } },
  { name: "configure", write: true, description: "Propose replacing only your own Browser Use policy with expectedRevision and exact owner approval. Global activation and private API key remain in owner settings. Enabled access needs explicit domain names. An empty profile_id uses a fresh one-off browser; a configured profile remains isolated to this bot. The run grant remains ask; the human-selected bot approval policy may cover already enabled runs. Configuration is metadata, not authentication.", inputSchema: { type: "object", properties: { expectedRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }, enabled: { type: "boolean" }, allowed_domains: { type: "array", items: { type: "string", minLength: 1, maxLength: 253 }, maxItems: 32 }, max_steps: { type: "integer", minimum: 1, maximum: 100 }, timeout_seconds: { type: "integer", minimum: 30, maximum: 240 }, profile_id: { type: "string", minLength: 0, maxLength: 36 } }, required: ["expectedRevision", "enabled", "allowed_domains", "max_steps", "timeout_seconds", "profile_id"], additionalProperties: false } },
];

export interface BrowserUseTurnSurfaceOptions { store: HostStore; base: TurnToolSurface; vault: BrowserUseKeyVault; client?: BrowserUseClient }

/** Host-owned facade: no generic MCP validator exceptions and no model-selected identity or credentials. */
export class BrowserUseTurnSurface implements TurnToolSurface {
  readonly #options: BrowserUseTurnSurfaceOptions;
  readonly #client: BrowserUseClient;
  readonly #capabilities = new Map<string, Capability>();
  readonly #calls = new Set<Promise<GatewayCallResult>>();
  readonly #ownerControllers = new Set<AbortController>();
  readonly #executions = new Map<string, Promise<GatewayCallResult>>();
  readonly #flights = new Set<Execution>();
  readonly #cleanupPending = new Set<string>();
  readonly #admissions = new Map<string, Set<string>>();
  readonly #unhook: () => void;
  #stopped = false;
  #closing: Promise<void> | null = null;
  constructor(options: BrowserUseTurnSurfaceOptions) {
    this.#options = options; this.#client = options.client ?? new BrowserUseClient();
    this.#unhook = options.vault.onLock(async () => {
      for (const flight of this.#flights) flight.controller.abort();
      await Promise.allSettled([...this.#executions.values()]);
    });
  }
  status(): { available: boolean; activeTasks: number; cleanupPending: boolean; credential: { unlocked: boolean; expiresAt: number | null }; authentication: "unverified"; apiVersion: "v2" } {
    return { available: !this.#stopped, activeTasks: this.#flights.size, cleanupPending: this.#cleanupPending.size > 0,
      credential: this.#options.vault.status(), authentication: "unverified", apiVersion: "v2" };
  }
  configurationChanged(): void {
    const revision = this.#options.store.getBrowserUseConfiguration().revision;
    for (const flight of this.#flights) if (flight.revision !== revision) flight.controller.abort();
  }
  issueCapability(input: { turnId: string; ttlMs?: number }): { token: string; scope: CapabilityScope } {
    if (this.#stopped) fail("unavailable");
    for (const [key, cap] of this.#capabilities) { try { this.#validate(cap); } catch { this.#remove(key, cap); } }
    for (const turnId of this.#admissions.keys()) if (this.#options.store.getTurn(turnId).state !== "running") this.#admissions.delete(turnId);
    if (this.#capabilities.size >= 128) fail("unavailable");
    const issued = this.#options.base.issueCapability(input);
    const cap: Capability = { token: issued.token, scope: Object.freeze({ ...issued.scope }), controllers: new Set(), baseTargets: new Set() };
    try {
      if (!TOKEN.test(cap.token) || cap.scope.turnId !== input.turnId) fail("unauthorized"); this.#validate(cap);
      const views = this.#options.base.listTools(cap.token); if (views.length > MCP_AUTHORIZED_INVENTORY_LIMIT) fail("unavailable");
      cap.baseTargets = new Set(views.map(view => `${view.connectionId}\0${view.name}`));
      // Bound the actual full eligible inventory, not a reservation for potentially hidden definitions.
      // Use the just-validated initial views; a second base lookup would add no authority and can
      // consume an intentionally tiny capability TTL before issuance has even returned.
      this.#catalogue(cap, views);
      this.#capabilities.set(sha(cap.token), cap);
      return { token: cap.token, scope: { ...cap.scope } };
    } catch (error) { this.#capabilities.delete(sha(cap.token)); this.#options.base.revokeCapability(cap.token); throw error; }
  }
  #validate(cap: Capability, signal?: AbortSignal): void {
    const store = this.#options.store, scope = cap.scope;
    if (this.#stopped || signal?.aborted || scope.expiresAt <= store.now()) fail("unauthorized");
    store.assertActiveWriter(); store.assertTeamTurn(scope.turnId);
    const turn = store.getTurn(scope.turnId), thread = store.getThread(scope.threadId), bot = store.getBot(scope.botId);
    if(cap.ownerActionId && store.ownerToolScope(cap.ownerActionId).turnId!==scope.turnId)fail("forbidden");
    if ((!cap.ownerActionId && turn.state !== "running") || turn.threadId !== thread.id || turn.botId !== bot.id || thread.botId !== bot.id
      || scope.installationId !== store.hostId || scope.ownerId !== store.ownerId || bot.ownerId !== scope.ownerId || bot.profileId !== scope.profileId) fail("unauthorized");
  }
  #resolve(token: string, signal?: AbortSignal): Capability {
    if (typeof token !== "string" || !TOKEN.test(token)) fail("unauthorized");
    const cap = this.#capabilities.get(sha(token)); if (!cap) fail("unauthorized"); this.#validate(cap, signal); return cap;
  }
  #policy(botId: string): BrowserUseBotPolicy { return this.#options.store.getBrowserUseConfiguration().bots[botId] ?? defaultBrowserUseBotPolicy(); }
  #available(cap: Capability, definition: Definition): boolean {
    if (!definition.write) return true;
    const grant = this.#options.store.getGrant(cap.scope.botId, PREFIX + definition.name, BROWSER_USE_DESTINATION);
    if (grant && (grant.policy !== "ask" || grant.expiresAt !== null && grant.expiresAt <= this.#options.store.now())) return false;
    if (definition.name === "configure") return true;
    const config = this.#options.store.getBrowserUseConfiguration();
    return config.enabled && this.#policy(cap.scope.botId).enabled && grant?.policy === "ask" && this.#options.vault.status().unlocked;
  }
  listTools(token: string): ToolView[] {
    const cap = this.#resolve(token);
    return this.#catalogue(cap, this.#options.base.listTools(token).filter(view => cap.baseTargets.has(`${view.connectionId}\0${view.name}`)));
  }
  #catalogue(cap: Capability, baseViews: readonly ToolView[]): ToolView[] {
    const views = [...baseViews];
    // Outer surfaces and the native MCP turn lease snapshot tool identities at issuance. Keep run's
    // schema in that original catalog so an approved configure can enable it within the same turn.
    // Discovery is not admission: #call still checks the live grant, policy, key and execution pins.
    for (const definition of definitions) if (definition.name === "run" || this.#available(cap, definition)) views.push({ name: PREFIX + definition.name,
      connectionId: BROWSER_USE_DESTINATION, connectionLabel: "Browser Use Cloud", description: definition.description, effect: definition.write ? "write" : "read",
      requiresApproval: definition.write && this.#options.store.actionRequiresApproval(cap.scope.botId, PREFIX + definition.name, BROWSER_USE_DESTINATION, definition.name === "run" ? "browser_use" : undefined,cap.scope.threadId), inputSchema: structuredClone(definition.inputSchema) });
    if (views.length > MCP_AUTHORIZED_INVENTORY_LIMIT) fail("unavailable"); return views;
  }
  call(token: string, raw: unknown, options: { signal?: AbortSignal } = {}): Promise<GatewayCallResult> {
    let cap: Capability; try { cap = this.#resolve(token, options.signal); } catch (error) { return Promise.reject(error); }
    const controller = new AbortController(), abort = (): void => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true }); cap.controllers.add(controller);
    const operation = this.#call(cap, raw, controller).catch(error => {
      if (error instanceof GatewayError || error instanceof HostError && error.code === "host_locked") throw error;
      throw new GatewayError("unavailable", "Browser Use operation unavailable.");
    });
    this.#calls.add(operation);
    const release = (): void => { this.#calls.delete(operation); cap.controllers.delete(controller); options.signal?.removeEventListener("abort", abort); };
    void operation.then(release, release); return operation;
  }
  #arguments(definition: Definition, value: unknown): Values {
    const args = object(value), schema = definition.inputSchema;
    if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key)) || schema.required.some(key => !Object.hasOwn(args, key))) fail("invalid_input");
    for (const [key, value] of Object.entries(args)) {
      const property = schema.properties[key]!;
      if (property.type === "string") {
        if (typeof value !== "string" || value.length > property.maxLength || value.length < (property.minLength ?? 0)
          || !isWellFormedText(value) || browserUseContainsSecret(value) || this.#options.vault.contains(value)) fail("invalid_input");
      } else if (property.type === "boolean") { if (typeof value !== "boolean") fail("invalid_input"); }
      else if (property.type === "integer") {
        if (!Number.isSafeInteger(value) || property.minimum !== undefined && (value as number) < property.minimum || property.maximum !== undefined && (value as number) > property.maximum) fail("invalid_input");
      } else if (property.type === "array") {
        if (!Array.isArray(value) || value.length > property.maxItems || value.some(item => typeof item !== "string" || property.items.type !== "string"
          || item.length < (property.items.minLength ?? 0) || item.length > property.items.maxLength || !isWellFormedText(item) || browserUseContainsSecret(item) || this.#options.vault.contains(item))) fail("invalid_input");
      } else fail("invalid_input");
    }
    if (definition.name === "configure") {
      const policy = BrowserUseBotPolicySchema.safeParse({ enabled: args.enabled, allowedDomains: args.allowed_domains, maxSteps: args.max_steps,
        timeoutSeconds: args.timeout_seconds, profileId: args.profile_id === "" ? null : args.profile_id });
      if (!policy.success) fail("invalid_input"); return { expectedRevision: args.expectedRevision as number, policy: json(policy.data) };
    }
    if (definition.name === "run") { if (!(args.task as string).trim()) fail("invalid_input"); return { task: args.task as string, startUrl: args.start_url as string }; }
    return {};
  }
  #pin(cap: Capability, definition: Definition, args: Values): Values {
    const config = this.#options.store.getBrowserUseConfiguration(), policy = this.#policy(cap.scope.botId);
    if (definition.name === "configure") {
      if (config.revision !== args.expectedRevision) fail("conflict"); return { revision: config.revision, policy: json(policy) };
    }
    if (!config.enabled || !policy.enabled || !browserUseStartUrlAllowed(args.startUrl as string, policy.allowedDomains)) fail("forbidden");
    return { revision: config.revision, policy: json(policy), keyGeneration: this.#options.vault.generation() };
  }
  #validateRunning(cap: Capability, actionId: string, signal: AbortSignal, pin: Values, definition: Definition, args: Values): void {
    this.#validate(cap, signal); const store = this.#options.store, action = store.getAction(actionId);
    const grant = store.getGrant(cap.scope.botId, action.request.tool, BROWSER_USE_DESTINATION);
    if (action.state !== "running" || action.request.botId !== cap.scope.botId || action.request.threadId !== cap.scope.threadId || action.request.destination !== BROWSER_USE_DESTINATION
      || !grant || grant.policy !== "ask" || grant.revision !== action.grantRevision || grant.expiresAt !== null && grant.expiresAt <= store.now()
      || !same(this.#pin(cap, definition, args), pin)) fail("forbidden");
  }
  async #call(cap: Capability, raw: unknown, controller: AbortController): Promise<GatewayCallResult> {
    if (this.#calls.size >= 64) fail("unavailable"); const signal = controller.signal, call = object(raw);
    if (call.connectionId !== BROWSER_USE_DESTINATION) {
      if (typeof call.connectionId !== "string" || typeof call.tool !== "string" || !cap.baseTargets.has(`${call.connectionId}\0${call.tool}`)) fail("forbidden");
      return this.#options.base.call(cap.token, raw, { signal });
    }
    if (Object.keys(call).sort().join(",") !== "arguments,callId,connectionId,tool" || typeof call.callId !== "string" || !CALL_ID.test(call.callId)
      || typeof call.tool !== "string") fail("invalid_input");
    const definition = definitions.find(item => PREFIX + item.name === call.tool); if (!definition) fail("forbidden");
    const args = cap.ownerActionId ? object(call.arguments) as Values : this.#arguments(definition, call.arguments), store = this.#options.store;
    if (!definition.write) {
      const config = store.getBrowserUseConfiguration(), policy = this.#policy(cap.scope.botId);
      const requestHash = sha(canonicalJson({ tool: call.tool, callId: call.callId, turnId: cap.scope.turnId, input: args }));
      return { actionId: `browser-read-${requestHash.slice(0, 24)}`, status: "succeeded", requestHash, reason: null,
        result: { revision: config.revision, globallyEnabled: config.enabled, policy: json(policy), credential: json(this.#options.vault.status()),
          runAvailable: this.#available(cap, definitions.find(item => item.name === "run")!),
          authentication: "unverified", apiVersion: "v2", activeTasks: [...this.#flights].filter(flight => flight.botId === cap.scope.botId).length,
          cleanupPending: this.#cleanupPending.has(cap.scope.botId), localMacBrowserIsSeparate: true,
          approvalPolicy: json(store.getBotApprovalPolicy(cap.scope.botId)),
          runsRequireApproval: store.actionRequiresApproval(cap.scope.botId, PREFIX + "run", BROWSER_USE_DESTINATION, "browser_use",cap.scope.threadId), hardSpendingCap: false } };
    }
    const continued=store.replayedContinuationAction(cap.scope.turnId,call.tool as string,BROWSER_USE_DESTINATION,args);
    if(continued)return project(continued);
    const key = `browser_${sha(`${cap.scope.turnId}\0${call.callId}`).slice(0, 48)}`;
    let action = store.findAction(cap.scope.botId, key);
    if (action) {
      if(cap.ownerActionId && cap.ownerActionId!==action.id)fail("forbidden");
      if (action.request.tool !== call.tool || action.request.threadId !== cap.scope.threadId || action.request.destination !== BROWSER_USE_DESTINATION
        || !same(action.request.arguments.input ?? null, args)) fail("conflict");
      if (action.state !== "ready") { const ongoing = this.#executions.get(action.id); return ongoing ?? project(action); }
    } else {
      if(cap.ownerActionId)fail("forbidden");
      if (!this.#available(cap, definition)) fail("forbidden"); this.#validate(cap, signal);
      const admitted = this.#admissions.get(cap.scope.turnId) ?? new Set<string>(); if (admitted.size >= 32) fail("unavailable");
      const pin = this.#pin(cap, definition, args), grant = store.getGrant(cap.scope.botId, call.tool, BROWSER_USE_DESTINATION);
      // Configuration alone may be proposed without a run grant. The owner must approve the complete policy.
      if (!grant && definition.name === "configure") store.setProposalGrant({ botId: cap.scope.botId, tool: call.tool, destination: BROWSER_USE_DESTINATION, policy: "ask" });
      else if (!grant || grant.policy !== "ask") fail("forbidden");
      action = store.requestAction({ botId: cap.scope.botId, threadId: cap.scope.threadId, tool: call.tool, destination: BROWSER_USE_DESTINATION,
        idempotencyKey: key, arguments: { input: args, pin } }, definition.name === "run" ? "browser_use" : undefined);
      store.bindToolAction(action.id,cap.scope.turnId,call.callId);
      admitted.add(action.id); this.#admissions.set(cap.scope.turnId, admitted);
      if (action.state !== "ready") return project(action);
    }
    const pin = object(action.request.arguments.pin) as Values;
    try { this.#validate(cap, signal); if (!this.#available(cap, definition) || !same(this.#pin(cap, definition, args), pin)) fail("forbidden"); }
    catch (error) { if (error instanceof HostError && error.code === "host_locked") throw error; return project(store.blockAction(action.id)); }
    const id = action.id, hash = action.requestHash;
    const executionCap:Capability={...cap,scope:store.ownerToolScope(id),ownerActionId:id};
    const execution = dispatchAction(store, id, async (_request, context) => {
      this.#validateRunning(executionCap, id, context.signal, pin, definition, args);
      if (definition.name === "configure") {
        const result = store.patchBrowserUseBotPolicy(executionCap.scope.botId, { expectedHostID: store.hostId, expectedRevision: args.expectedRevision,
          policy: args.policy }); this.configurationChanged();
        // The successful CAS intentionally changes its pin and run grant; do not compare that old pin afterwards.
        this.#validate(executionCap, context.signal); return { revision: result.revision, policy: json(this.#policy(executionCap.scope.botId)), runsRequireApproval: store.actionRequiresApproval(executionCap.scope.botId, PREFIX + "run", BROWSER_USE_DESTINATION, "browser_use",cap.scope.threadId), authenticationVerified: false };
      }
      const executionController=new AbortController(),abort=():void=>executionController.abort();
      context.signal.addEventListener("abort",abort,{once:true});if(context.signal.aborted)abort();
      const lease = this.#options.vault.use(), flight: Execution = { botId: executionCap.scope.botId, revision: pin.revision as number, controller:executionController };
      this.#flights.add(flight);
      try {
        const result = await this.#client.run({ task: args.task as string, startUrl: args.startUrl as string, policy: BrowserUseBotPolicySchema.parse(pin.policy), operationId: id, requestHash: hash },
          { lease, signal: executionController.signal, assertCurrent: () => this.#validateRunning(executionCap, id, context.signal, pin, definition, args),
            cleanup: confirmed => { if (!confirmed) this.#cleanupPending.add(executionCap.scope.botId); } });
        this.#validateRunning(executionCap, id, context.signal, pin, definition, args); return json(result);
      } finally { context.signal.removeEventListener("abort",abort);this.#flights.delete(flight); }
    }, signal).then(receipt=>{store.recordToolOutcome(id,receipt.result);return project(receipt);});
    this.#executions.set(id, execution);
    try { return await execution; } finally { this.#executions.delete(id); }
  }
  /** Private host replay of the exact already admitted action, with all current pins enforced. */
  async continueOwnerAction(action: Action): Promise<Action> {
    if(action.request.destination!==BROWSER_USE_DESTINATION || action.state!=="ready")return this.#options.store.getAction(action.id);
    const store=this.#options.store, origin=store.toolActionOrigin(action.id);
    if(!origin)fail("forbidden");
    const cap:Capability={token:"",scope:store.ownerToolScope(action.id),controllers:new Set(),baseTargets:new Set(),ownerActionId:action.id};
    const controller=new AbortController();this.#ownerControllers.add(controller);
    const operation=this.#call(cap,{connectionId:BROWSER_USE_DESTINATION,tool:action.request.tool,callId:origin.callId,arguments:action.request.arguments.input},controller);
    const tracked=operation.then(outcome=>{store.recordToolOutcome(action.id,outcome.result);return store.getAction(action.id);});
    this.#calls.add(operation);
    try { return await tracked; } finally { this.#calls.delete(operation);this.#ownerControllers.delete(controller); }
  }
  #remove(key: string, cap: Capability): void { this.#capabilities.delete(key); for (const controller of cap.controllers) controller.abort(); this.#options.base.revokeCapability(cap.token); }
  revokeCapability(token: string): void { if (typeof token !== "string") return; const key = sha(token), cap = this.#capabilities.get(key); if (cap) this.#remove(key, cap); }
  stopAdmission(): void { this.#options.store.stopApprovedExecutions(undefined,BROWSER_USE_DESTINATION); for(const controller of this.#ownerControllers)controller.abort(); this.#stopped = true; for (const [key, cap] of this.#capabilities) this.#remove(key, cap); for (const flight of this.#flights) flight.controller.abort(); }
  close(): Promise<void> { this.stopAdmission(); return this.#closing ??= Promise.allSettled([...this.#calls]).then(() => { this.#unhook(); }); }
}
