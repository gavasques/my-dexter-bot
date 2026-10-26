import { createHash, randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type { Action, JsonValue, ToolRequest } from "@dexter/contracts";
import { canonicalJson, dispatchAction, HostError, type HostStore, type ToolExecutor } from "@dexter/hub";
import type { CredentialBroker, InjectedAuth } from "./broker.js";
import { GatewayError } from "./errors.js";
import { validateCall, type InputSchema, type ToolManifest } from "./manifest.js";
import { GatewayRegistry, type Connection, type ConnectInput, type RegisteredTool } from "./registry.js";
import { containsSecret, scrub, secretNeedles } from "./secrets.js";

/** What the trusted adapter receives for one upstream call. Identity and target come from the gateway, never the engine. */
export interface AdapterCall {
  readonly toolkit: string;
  readonly upstreamSlug: string;
  readonly version: string;
  readonly host: string;
  /** Namespaced upstream user: installation/owner/profile. Composio `user_id`. */
  readonly upstreamUserId: string;
  /** Pinned upstream account (Composio `connected_account_id`). */
  readonly upstreamAccountRef: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  /** Stable per (turn, callId); forward upstream where supported. */
  readonly idempotencyKey: string;
  /** Gateway connection id the call is pinned to (hub grant destination). */
  readonly connectionId: string;
  /** Trusted identity of the capability, frozen from the hub at issue time. Adapters key per-bot upstream config on it. */
  readonly scope: Readonly<AdapterScope>;
}
/** Identity fields of a capability handed to adapters. Never carries the bearer token or its expiry. */
export interface AdapterScope {
  installationId: string;
  ownerId: string;
  profileId: string;
  botId: string;
  threadId: string;
  turnId: string;
}
/**
 * Trusted upstream adapter (Composio service client, test fake). It alone sees `auth`; it must contact only
 * `call.host` and never echo `auth`. Throwing after an upstream effect is recorded as unknown, never retried.
 */
export interface UpstreamAdapter {
  execute(call: AdapterCall, auth: InjectedAuth, context: { signal: AbortSignal }): Promise<JsonValue>;
}
export interface GatewayOptions {
  store: HostStore;
  broker: CredentialBroker;
  adapter: UpstreamAdapter;
  /** Upper bound of a capability's life; it also ends when its turn stops running. Default 15 minutes. */
  capabilityTtlMs?: number;
}
/** Identity of one capability: fixed at issue time from the hub, never from call arguments. */
export interface CapabilityScope {
  installationId: string;
  ownerId: string;
  profileId: string;
  botId: string;
  threadId: string;
  turnId: string;
  expiresAt: number;
}
export interface GatewayCallInput {
  tool: string;
  connectionId: string;
  /** Engine-chosen id of this call; replays with the same id return the stored outcome. */
  callId: string;
  arguments: Record<string, unknown>;
}
/** Engine-safe projection of an action: no upstream ids, hosts, credential refs or headers. */
export interface GatewayCallResult {
  actionId: string;
  status: Action["state"];
  requestHash: string;
  reason: Action["reason"];
  result: JsonValue | null;
}
/** Engine-safe projection of a usable tool. */
export interface ToolView {
  name: string;
  description: string;
  effect: ToolManifest["effect"];
  inputSchema: InputSchema;
  connectionId: string;
  connectionLabel: string;
  requiresApproval: boolean;
}
/**
 * Frozen into the hub action (and so into its approval hash). `toolRevision` changes on every retire and
 * re-register, even with an identical manifest, so an approval never survives a catalog change.
 */
interface Pin { connectionRevision: number; manifestHash: string; toolRevision: number; turnId: string }

const DEFAULT_CAPABILITY_TTL_MS = 15 * 60_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CALL_KEYS = ["arguments", "callId", "connectionId", "tool"];

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Capability gateway between the engine bridge and trusted upstream adapters.
 *
 * Authority split: the hub (HostStore) owns grants, approvals, idempotency, action state and receipts; this
 * gateway owns the pinned tool catalog, connected-account references, short-lived capabilities and the
 * moment of credential injection. A call becomes a hub action keyed by (bot, tool, connection id), so
 * there is no parallel grant store and connecting an account grants nothing.
 */
export class CapabilityGateway {
  readonly registry: GatewayRegistry;
  private readonly store: HostStore;
  private readonly broker: CredentialBroker;
  private readonly adapter: UpstreamAdapter;
  private readonly capabilityTtlMs: number;
  /** token hash -> scope. In memory only: a restart revokes every capability. */
  private readonly capabilities = new Map<string, CapabilityScope>();
  private readonly ownerControllers=new Set<AbortController>();
  private ownerAdmissionStopped=false;
  private nativeMcpApprovalEligibility: ((scope: Readonly<CapabilityScope>, tool: Readonly<RegisteredTool>, connection: Readonly<Connection>) => boolean) | null = null;

  constructor(options: GatewayOptions) {
    this.store = options.store;
    this.broker = options.broker;
    this.adapter = options.adapter;
    this.capabilityTtlMs = options.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS;
    const store = this.store;
    this.registry = new GatewayRegistry(dirname(store.databasePath), store.hostId, store.ownerId, () => store.now(),
      (operation) => store.withWriterLease(operation));
  }

  close(): void {
    this.stopAdmission();
    this.capabilities.clear();
    this.registry.close();
  }
  stopAdmission():void {
    this.ownerAdmissionStopped=true;
    this.store.stopApprovedExecutions();
    for(const controller of this.ownerControllers)controller.abort();
  }

  /** One-time trusted native inventory wiring. Matching names/prefixes alone never establish selection. */
  setNativeMcpApprovalEligibility(resolve: (scope: Readonly<CapabilityScope>, tool: Readonly<RegisteredTool>, connection: Readonly<Connection>) => boolean): void {
    if (this.nativeMcpApprovalEligibility || this.ownerAdmissionStopped || typeof resolve !== "function") throw new GatewayError("conflict", "native MCP eligibility already bound or unavailable");
    this.nativeMcpApprovalEligibility = resolve;
  }
  private approvalEligibility(scope: CapabilityScope, tool: RegisteredTool, connection: Connection): "native_mcp" | "native_mcp_read" | undefined {
    try { return this.nativeMcpApprovalEligibility?.(scope, tool, connection) === true ? (tool.manifest.effect==="read" ? "native_mcp_read" : "native_mcp") : undefined; }
    catch { return undefined; }
  }

  // ---- catalog and connections (owner/admin surface, never exposed to engines) ---------------

  /**
   * Registers or re-pins a manifest. Pending actions pinned to another revision are blocked (permission_changed), including
   * after retire then re-register of the same manifest; an identical re-pin of an active tool is a no-op.
   * After a crash before the block, dispatch still refuses them because their pinned revision is stale.
   */
  registerTool(manifest: unknown): RegisteredTool {
    const tool = this.registry.registerTool(manifest);
    this.blockPending((action, pin) => action.request.tool === tool.manifest.name && (pin.toolRevision !== tool.revision || pin.manifestHash !== tool.manifestHash));
    return tool;
  }
  retireTool(name: string): RegisteredTool {
    const tool = this.registry.retireTool(name);
    this.blockPending((action) => action.request.tool === name);
    return tool;
  }
  /** Records a connected account of a profile. Grants nothing: each bot still needs a hub grant per tool. */
  connectAccount(input: ConnectInput): Connection {
    if (!this.store.listBots().some((bot) => bot.profileId === input.profileId)) throw new GatewayError("not_found", "profile not found");
    return this.registry.connect(input);
  }
  /**
   * Irreversible. Committed in the registry first, then pending actions on the connection are blocked;
   * after a crash between the two, dispatch still refuses them because their pinned revision is stale.
   */
  revokeConnection(id: string): Connection {
    const connection = this.registry.revokeConnection(id);
    this.blockPending((action) => action.request.destination === id);
    return connection;
  }

  // ---- capabilities ---------------------------------------------------------------------------

  /** Issues a bearer capability for one running turn. Identity is read from the hub, not from the caller. */
  issueCapability(input: { turnId: string; ttlMs?: number }): { token: string; scope: CapabilityScope } {
    const turn = this.hub(() => this.store.getTurn(input.turnId), "unauthorized");
    if (turn.state !== "running") throw new GatewayError("unauthorized", "turn is not running");
    const bot = this.store.getBot(turn.botId);
    const ttl = Math.min(input.ttlMs ?? this.capabilityTtlMs, this.capabilityTtlMs);
    if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new GatewayError("invalid_input", "ttlMs: invalid");
    const scope: CapabilityScope = Object.freeze({
      installationId: this.store.hostId, ownerId: this.store.ownerId, profileId: bot.profileId,
      botId: bot.id, threadId: turn.threadId, turnId: turn.id, expiresAt: this.store.now() + ttl,
    });
    const token = randomBytes(32).toString("base64url");
    this.capabilities.set(sha256(token), scope);
    return { token, scope };
  }
  revokeCapability(token: string): void {
    if (typeof token === "string") this.capabilities.delete(sha256(token));
  }
  revokeTurnCapabilities(turnId: string): void {
    for (const [hash, scope] of this.capabilities) if (scope.turnId === turnId) this.capabilities.delete(hash);
  }

  // ---- engine surface (via the local bridge) --------------------------------------------------

  /** Tools this capability may call right now: active manifest, active connection of the profile, effective grant. */
  listTools(token: string): ToolView[] {
    const scope = this.resolve(token);
    const now = this.store.now();
    const connections = this.registry.listConnections(scope.profileId).filter((c) => c.status === "active");
    const views: ToolView[] = [];
    for (const tool of this.registry.listTools()) {
      if (tool.status !== "active") continue;
      for (const connection of connections) {
        if (!this.usable(scope, connection, tool.manifest)) continue;
        const grant = this.store.getGrant(scope.botId, tool.manifest.name, connection.id);
        if (!grant || grant.policy === "deny" || (grant.expiresAt !== null && now >= grant.expiresAt)) continue;
        views.push({
          name: tool.manifest.name, description: tool.manifest.description, effect: tool.manifest.effect,
          inputSchema: structuredClone(tool.manifest.inputSchema), connectionId: connection.id, connectionLabel: connection.label,
          requiresApproval: this.store.actionRequiresApproval(scope.botId, tool.manifest.name, connection.id, this.approvalEligibility(scope, tool, connection),scope.threadId),
        });
      }
    }
    return views;
  }

  /**
   * Plans and, when allowed, dispatches one call. Replays (same turn and callId) return the stored outcome
   * and never re-execute; a replay of an approved action dispatches it once. Everything from the final
   * revalidation to the adapter call runs in one synchronous stretch, so no revocation can interleave.
   */
  async call(token: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<GatewayCallResult> {
    const scope = this.resolve(token);
    const request = parseCallInput(input);
    // Credential material never enters the hub (action, approval hash, receipts, SQLite) nor goes upstream
    // as arguments. Checked before anything is looked up or persisted; the message never names the value.
    if (containsSecret(request.arguments, this.needles())) throw new GatewayError("invalid_input", "call.arguments: credential material refused");
    const continued=this.store.replayedContinuationAction(scope.turnId,request.tool,request.connectionId,request.arguments as JsonValue);
    if(continued)return project(continued);
    const idempotencyKey = `gw_${sha256(`${scope.turnId}\u0000${request.callId}`).slice(0, 48)}`;
    const existing = this.findAction(scope.botId, idempotencyKey);
    if (existing) {
      if (existing.request.tool !== request.tool || existing.request.destination !== request.connectionId
        || !sameJson(readInput(existing), request.arguments)) {
        throw new GatewayError("conflict", "callId reused with a different request");
      }
      this.store.bindToolAction(existing.id,scope.turnId,request.callId);
      return existing.state === "ready" ? this.dispatch(scope, existing, options.signal) : project(existing);
    }
    const { tool, connection } = this.target(scope, request.tool, request.connectionId);
    const args = validateCall(tool.manifest, request.arguments);
    const pin: Pin = { connectionRevision: connection.revision, manifestHash: tool.manifestHash, toolRevision: tool.revision, turnId: scope.turnId };
    const action = this.hub(() => this.store.requestAction({
      botId: scope.botId, threadId: scope.threadId, tool: tool.manifest.name, destination: connection.id,
      arguments: { input: args, pin: pin as unknown as JsonValue }, idempotencyKey,
    } satisfies ToolRequest, this.approvalEligibility(scope, tool, connection)), "forbidden");
    this.store.bindToolAction(action.id,scope.turnId,request.callId);
    return action.state === "ready" ? this.dispatch(scope, action, options.signal) : project(action);
  }

  /** Host-only exact owner authorization, independent of an expired engine bearer capability. */
  async continueOwnerAction(action: Action, signal?: AbortSignal): Promise<Action> {
    if (action.state!=="ready") return this.store.getAction(action.id);
    if(this.ownerAdmissionStopped)throw new GatewayError("unauthorized","Owner execution admission stopped.");
    const controller=new AbortController(),abort=():void=>controller.abort();
    signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
    this.ownerControllers.add(controller);
    try{
      const scope=this.store.ownerToolScope(action.id);
      const outcome=await this.dispatch(scope,this.store.getAction(action.id),controller.signal);
      this.store.recordToolOutcome(action.id,outcome.result);
      return this.store.getAction(action.id);
    }finally{signal?.removeEventListener("abort",abort);this.ownerControllers.delete(controller);}
  }

  // ---- internals ------------------------------------------------------------------------------

  private async dispatch(scope: CapabilityScope, action: Action, signal?: AbortSignal): Promise<GatewayCallResult> {
    const pin = readPin(action);
    const tool = this.registry.getTool(action.request.tool);
    const connection = this.registry.getConnection(action.request.destination);
    let args: Record<string, JsonValue> | null = null;
    const needles = this.needles();
    if (pin && tool && tool.status === "active" && tool.manifestHash === pin.manifestHash && tool.revision === pin.toolRevision
      && connection && connection.revision === pin.connectionRevision && pin.turnId === scope.turnId && this.usable(scope, connection, tool.manifest)
      && (!["owner_policy","thread_policy","owner_type"].includes(action.authorization?.source ?? "") || this.approvalEligibility(scope, tool, connection) !== undefined)) {
      try { args = validateCall(tool.manifest, readInput(action)); } catch { args = null; }
      // A credential added to the broker after planning may now match: never send it upstream.
      if (args && containsSecret(args, needles)) args = null;
    }
    if (!args || !tool || !connection) {
      // Pinned manifest/connection no longer current: never dispatch; authority changed, so it is blocked.
      return project(this.store.blockAction(action.id));
    }
    const manifest = tool.manifest;
    const auth = this.broker.acquire(connection.credentialRef, manifest.upstreamHost);
    if (!auth) throw new GatewayError("unavailable", "credential unavailable for this connection; action stays ready");
    const call: AdapterCall = Object.freeze({
      toolkit: manifest.toolkit, upstreamSlug: manifest.upstreamSlug, version: manifest.version, host: manifest.upstreamHost,
      upstreamUserId: `dx:${scope.installationId}:${scope.ownerId}:${scope.profileId}`,
      upstreamAccountRef: connection.upstreamAccountRef, arguments: Object.freeze(args),
      idempotencyKey: action.request.idempotencyKey, connectionId: connection.id,
      scope: Object.freeze({
        installationId: scope.installationId, ownerId: scope.ownerId, profileId: scope.profileId,
        botId: scope.botId, threadId: scope.threadId, turnId: scope.turnId,
      }),
    });
    const executor: ToolExecutor = async (_request, context) => {
      const controller=new AbortController(),abort=():void=>controller.abort();
      const current=():boolean=>{
        const registered=this.registry.getTool(action.request.tool),connected=this.registry.getConnection(connection.id);
        return Boolean(registered?.status==="active" && registered.revision===pin!.toolRevision && registered.manifestHash===pin!.manifestHash
          && connected?.revision===pin!.connectionRevision && this.usable(scope,connected,manifest)
          && (!["owner_policy","thread_policy","owner_type"].includes(action.authorization?.source ?? "") || this.approvalEligibility(scope, registered, connected) !== undefined));
      };
      context.signal.addEventListener("abort",abort,{once:true});if(context.signal.aborted)abort();
      const guard=setInterval(()=>{try{if(!current())abort();}catch{abort();}},100);
      try{
        const raw=await this.adapter.execute(call,auth,{signal:controller.signal});
        if(!current())throw new GatewayError("forbidden","Execution authority changed.");
        return scrub(raw,secretNeedles([...this.broker.secretValues(),...Object.values(auth.headers)]));
      }finally{clearInterval(guard);context.signal.removeEventListener("abort",abort);}
    };
    try {
      const receipt=await dispatchAction(this.store, action.id, executor, signal);
      this.store.recordToolOutcome(action.id,receipt.result);
      return project(receipt);
    } catch (error) {
      // Claim refused (grant changed, approval expired): the hub already persisted the terminal state.
      // A lost lease or closed host is not an outcome: surface it, the action stays as the authority left it.
      if (error instanceof HostError && error.code !== "host_locked") return project(this.store.getAction(action.id));
      throw error;
    }
  }

  /** Resolves a bearer capability and re-checks it against the hub: turn still running, same bot/thread/profile. */
  private resolve(token: string): CapabilityScope {
    if (typeof token !== "string" || !TOKEN.test(token)) throw new GatewayError("unauthorized", "invalid capability");
    const hash = sha256(token);
    const scope = this.capabilities.get(hash);
    if (!scope) throw new GatewayError("unauthorized", "invalid capability");
    const reject = (): never => { this.capabilities.delete(hash); throw new GatewayError("unauthorized", "capability expired or revoked"); };
    if (this.store.now() >= scope.expiresAt) reject();
    if (scope.installationId !== this.store.hostId || scope.ownerId !== this.store.ownerId) reject();
    let ok = false;
    try {
      const turn = this.store.getTurn(scope.turnId);
      const bot = this.store.getBot(scope.botId);
      ok = turn.state === "running" && turn.botId === scope.botId && turn.threadId === scope.threadId && bot.profileId === scope.profileId;
    } catch { ok = false; }
    if (!ok) reject();
    return scope;
  }
  private target(scope: CapabilityScope, name: string, connectionId: string): { tool: RegisteredTool; connection: Connection } {
    const tool = this.registry.getTool(name);
    const connection = this.registry.getConnection(connectionId);
    // One answer for "missing" and "not yours", so a capability cannot probe other profiles' connections.
    if (!tool || tool.status !== "active" || !connection || !this.usable(scope, connection, tool.manifest)) {
      throw new GatewayError("forbidden", "tool or connection not available to this capability");
    }
    return { tool, connection };
  }
  private usable(scope: CapabilityScope, connection: Connection, manifest: ToolManifest): boolean {
    return connection.status === "active" && connection.installationId === scope.installationId
      && connection.ownerId === scope.ownerId && connection.profileId === scope.profileId
      && connection.toolkit === manifest.toolkit && connection.allowedHosts.includes(manifest.upstreamHost);
  }
  private needles(): string[] {
    return secretNeedles(this.broker.secretValues());
  }
  private findAction(botId: string, idempotencyKey: string): Action | null {
    return this.store.findAction(botId, idempotencyKey);
  }
  private blockPending(match: (action: Action, pin: Pin) => boolean): void {
    for (const action of [...this.store.listActions("awaiting_approval"), ...this.store.listActions("ready")]) {
      const pin = readPin(action);
      if (pin && match(action, pin)) this.store.blockAction(action.id);
    }
  }
  /** Maps hub errors to gateway errors without carrying hub messages that might echo input. */
  private hub<T>(fn: () => T, fallback: "forbidden" | "unauthorized"): T {
    try { return fn(); } catch (error) {
      // A lost lease or closed host is not a permission answer: surface it unchanged.
      if (!(error instanceof HostError) || error.code === "host_locked") throw error;
      if (error.code === "conflict") throw new GatewayError("conflict", "request conflicts with a stored action");
      if (error.code === "invalid_input") throw new GatewayError("invalid_input", "request refused by the host");
      if (fallback === "unauthorized") throw new GatewayError("unauthorized", "capability scope not found");
      throw new GatewayError("forbidden", "no effective grant for this bot, tool and connection");
    }
  }
}

function parseCallInput(input: unknown): GatewayCallInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new GatewayError("invalid_input", "call: expected object");
  const raw = input as Record<string, unknown>;
  // Principal, account, toolkit and auth are never call fields; any extra key is refused, not ignored.
  if (Object.keys(raw).some((key) => !CALL_KEYS.includes(key))) throw new GatewayError("invalid_input", "call: unexpected field");
  if (typeof raw.tool !== "string" || typeof raw.connectionId !== "string") throw new GatewayError("invalid_input", "call: tool and connectionId required");
  if (typeof raw.callId !== "string" || !CALL_ID.test(raw.callId)) throw new GatewayError("invalid_input", "call.callId: invalid");
  if (typeof raw.arguments !== "object" || raw.arguments === null || Array.isArray(raw.arguments)) throw new GatewayError("invalid_input", "call.arguments: expected object");
  return { tool: raw.tool, connectionId: raw.connectionId, callId: raw.callId, arguments: raw.arguments as Record<string, unknown> };
}
function readPin(action: Action): Pin | null {
  const args = action.request.arguments as Record<string, unknown>;
  const pin = args.pin as Record<string, unknown> | undefined;
  if (!pin || typeof pin !== "object" || typeof pin.manifestHash !== "string" || typeof pin.turnId !== "string"
    || typeof pin.connectionRevision !== "number" || typeof pin.toolRevision !== "number" || !("input" in args)) return null;
  return { manifestHash: pin.manifestHash, turnId: pin.turnId, connectionRevision: pin.connectionRevision, toolRevision: pin.toolRevision };
}
function readInput(action: Action): unknown {
  return (action.request.arguments as Record<string, unknown>).input;
}
function sameJson(a: unknown, b: unknown): boolean {
  try { return canonicalJson(a as JsonValue) === canonicalJson(b as JsonValue); } catch { return false; }
}
function project(action: Action): GatewayCallResult {
  return {
    actionId: action.id, status: action.state, requestHash: action.requestHash, reason: action.reason,
    result: action.state === "succeeded" ? action.result : null,
  };
}
