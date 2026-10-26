import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { types } from "node:util";
import { operationFor, type DeviceOperation } from "@dexter/devices";
import type { Action, JsonValue, ToolRequest } from "@dexter/contracts";
import { DeviceRoutePatchSchema, type DeviceConversationRoute, type DeviceRoutePatch, type DeviceRouteReceipt } from "@dexter/contracts";
import { canonicalJson, hashRequest, HostError, type HostStore } from "@dexter/hub";
import { GatewayError, validateArguments, type CapabilityScope, type GatewayCallResult, type InputSchema, type ToolView, type TurnToolSurface } from "@dexter/gateway";

/** Owner-bound snapshot from the pairing registry, not a heartbeat or caller-supplied device identity. */
export interface DevicePinSnapshot {
  readonly installationId: string; readonly ownerId: string; readonly deviceId: string;
  readonly fingerprint: string; readonly generation: number; readonly revision: number;
  readonly status: "active" | "revoked";
}
export interface DeviceToolOperation extends DeviceOperation {}
/**
 * Trusted composition port. Implementations must use real persisted pin generations/revisions and the
 * canonical operation provider. dispatchBound owns claim/receipt and full asynchronous finalization;
 * it must consult guard synchronously before admission/delivery and after asynchronous boundaries.
 * A settled promise must not conceal unconfirmed local cleanup. No engine may construct this port.
 */
/** Trusted port-only refusal: no job/flight admitted and canonical action still pre-claim. */
export class DeviceDispatchPreflightError extends GatewayError {
  readonly #preflight = true;
  constructor(code: "unavailable" | "unauthorized" | "forbidden" | "conflict") {
    super(["unavailable","unauthorized","forbidden","conflict"].includes(code) ? code : "unavailable","device dispatch refused before claim");
  }
  static is(value: unknown): value is DeviceDispatchPreflightError { return typeof value === "object" && value !== null && #preflight in value && value.#preflight; }
}
export interface DeviceToolsPort {
  readonly installationId: string; readonly ownerId: string;
  snapshot(deviceId: string): DevicePinSnapshot | null;
  authenticatedPresence(deviceId: string): "online" | "stale" | "revoked";
  operation(tool: string): DeviceToolOperation;
  dispatchBound(actionId: string, context: { signal: AbortSignal; guard: (action: Action, peer: DevicePinSnapshot) => boolean }): Promise<Action>;
}
export type DeviceRoute = DeviceConversationRoute;
export interface DeviceRouteAdmin {
  bindRoute(input: { botId: string; deviceId: string; tool: string }): DeviceRoute;
  suspendRoute(routeId: string): DeviceRoute;
  revokeRoute(routeId: string): DeviceRoute;
  listRoutes(botId?: string): DeviceRoute[];
  patchRoute(input: unknown): DeviceRouteReceipt;
  routeReceipt(clientRequestId: string): DeviceRouteReceipt | null;
}
export interface DeviceTurnSurfaceOptions { capabilityTtlMs?: number; maxCapabilities?: number; maxRoutes?: number }
interface Capability { scope: Readonly<CapabilityScope>; abort: AbortController; ownerActionId?: string }
interface Binding {
  turnId: string; callId: string; routeId: string; routeRevision: number; botId: string; threadId: string;
  deviceId: string; tool: string; fingerprint: string; generation: number; pinRevision: number;
  schemaHash: string; operationVersion: string; argsHash: string; arguments: Record<string, JsonValue>;
  grantRevision: number; idempotencyKey: string; actionId: string | null;
}
type Row = Record<string, unknown>;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HEX = /^[0-9a-f]{64}$/;
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
function fail(code: "invalid_input" | "unauthorized" | "forbidden" | "conflict" | "unavailable"): never { throw new GatewayError(code, `device tools: ${code}`); }
const safeInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const project = (a: Action): GatewayCallResult => ({ actionId: a.id, status: a.state, requestHash: a.requestHash, reason: a.reason, result: a.state === "succeeded" ? a.result : null });
const terminal = (a: Action): boolean => ["succeeded", "denied", "blocked", "unknown"].includes(a.state);
const approvalEligibility = (operation: DeviceToolOperation): "device" | undefined => {
  // Status can ask for a new CUA session: consent remains in the operator's private native flow.
  if (operation.tool === "mac.cua.status") return undefined;
  try { const canonical = operationFor(operation.tool); return canonical.version === operation.version && canonical.schemaHash === operation.schemaHash ? "device" : undefined; }
  catch { return undefined; }
};
const COMPOSITE_SCHEMA = `CREATE TABLE composite_call_bindings (turn_id TEXT NOT NULL,call_id TEXT NOT NULL,bot_id TEXT NOT NULL,thread_id TEXT NOT NULL,
surface TEXT NOT NULL CHECK(surface IN ('gateway','device')),connection_id TEXT NOT NULL,tool TEXT NOT NULL,args_hash TEXT NOT NULL,
PRIMARY KEY(turn_id,call_id)) STRICT;`;
const RECEIPT_SCHEMA = `CREATE TABLE device_route_receipts (client_request_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,
request_json TEXT NOT NULL,receipt_json TEXT NOT NULL,committed_at INTEGER NOT NULL) STRICT;
CREATE TRIGGER device_route_receipts_immutable_update BEFORE UPDATE ON device_route_receipts BEGIN SELECT RAISE(ABORT,'immutable route receipt'); END;
CREATE TRIGGER device_route_receipts_immutable_delete BEFORE DELETE ON device_route_receipts BEGIN SELECT RAISE(ABORT,'immutable route receipt'); END;`;
const SCHEMA = `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE device_routes (id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,device_id TEXT NOT NULL,tool TEXT NOT NULL,
fingerprint TEXT NOT NULL,generation INTEGER NOT NULL,pin_revision INTEGER NOT NULL,schema_hash TEXT NOT NULL,operation_version TEXT NOT NULL,
revision INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','suspended','revoked')),minimum_grant_revision INTEGER NOT NULL,
UNIQUE(bot_id,device_id,tool)) STRICT;
CREATE TABLE device_calls (turn_id TEXT NOT NULL,call_id TEXT NOT NULL,route_id TEXT NOT NULL,route_revision INTEGER NOT NULL,
bot_id TEXT NOT NULL,thread_id TEXT NOT NULL,device_id TEXT NOT NULL,tool TEXT NOT NULL,fingerprint TEXT NOT NULL,
generation INTEGER NOT NULL,pin_revision INTEGER NOT NULL,schema_hash TEXT NOT NULL,operation_version TEXT NOT NULL,
args_hash TEXT NOT NULL,arguments TEXT NOT NULL,grant_revision INTEGER NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,
action_id TEXT UNIQUE,PRIMARY KEY(turn_id,call_id)) STRICT;
CREATE INDEX device_calls_route ON device_calls(route_id);
${COMPOSITE_SCHEMA}
`;

/** Standalone one-action device surface; no real DeviceServices or HostServices wiring is implied. */
export class DeviceTurnSurface implements TurnToolSurface {
  readonly databasePath: string;
  readonly admin: Readonly<DeviceRouteAdmin>;
  readonly #store: HostStore; readonly #port: DeviceToolsPort; readonly #db: DatabaseSync;
  readonly #caps = new Map<string, Capability>(); readonly #flights = new Map<string, Promise<GatewayCallResult>>();
  readonly #calls = new Set<Promise<GatewayCallResult>>();
  readonly #admissions = new Map<string,{ capabilityHash: string; signal: AbortSignal }>();
  readonly #files = new Map<string, { inode: number; device: number }>(); readonly #directory: Stats;
  readonly #ttl: number; readonly #maxCaps: number; readonly #maxRoutes: number;
  #stopped = false; #closed = false; #unconfirmed = false; #everIssued = false; #closing: Promise<void> | null = null;
  constructor(store: HostStore, port: DeviceToolsPort, options: DeviceTurnSurfaceOptions = {}) {
    this.#store = store; this.#port = port;
    if (port.installationId !== store.hostId || port.ownerId !== store.ownerId) fail("forbidden");
    const bounded = (n: number | undefined, fallback: number, maximum: number): number => { const v = n ?? fallback; if (!safeInt(v) || v > maximum) fail("invalid_input"); return v; };
    this.#ttl = bounded(options.capabilityTtlMs, 15 * 60_000, 15 * 60_000);
    this.#maxCaps = bounded(options.maxCapabilities, 128, 1024); this.#maxRoutes = bounded(options.maxRoutes, 256, 1024);
    this.databasePath = join(dirname(store.databasePath), "device-tools.sqlite");
    this.#directory = this.stat(dirname(this.databasePath), true)!;
    this.#db = store.withWriterLease(() => {
      for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) this.remember(path);
      if (this.stat(`${this.databasePath}-journal`)) fail("unavailable");
      if (!this.#files.has(this.databasePath)) { const fd = openSync(this.databasePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); closeSync(fd); this.remember(this.databasePath); }
      const db = new DatabaseSync(this.databasePath, { timeout: 5000 });
      try { db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;"); for (const path of [`${this.databasePath}-wal`, `${this.databasePath}-shm`]) this.remember(path); this.storage(); return db; }
      catch { db.close(); fail("unavailable"); }
    });
    try {
      this.tx(() => {
        const meta = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();
        if (!meta) {
          const tables = this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(); if (tables.length) fail("conflict");
          this.#db.exec(SCHEMA);
          for (const [key,value] of [["schema","2"],["installation",store.hostId],["owner",store.ownerId]]) this.#db.prepare("INSERT INTO meta VALUES (?,?)").run(key!,value!);
        }
        for (const [key,value] of [["installation",store.hostId],["owner",store.ownerId]]) {
          if ((this.#db.prepare("SELECT value FROM meta WHERE key=?").get(key!) as Row | undefined)?.value !== value) fail("conflict");
        }
        const version = (this.#db.prepare("SELECT value FROM meta WHERE key='schema'").get() as Row | undefined)?.value;
        if (version === "1") this.#db.exec(COMPOSITE_SCHEMA);
        if (version === "1" || version === "2") { this.#db.exec(RECEIPT_SCHEMA); this.#db.prepare("UPDATE meta SET value='3' WHERE key='schema'").run(); }
        else if (version !== "3") fail("conflict");
      });
    } catch (error) { this.#db.close(); throw error; }
    store.withWriterLease(() => { for (const path of [`${this.databasePath}-wal`,`${this.databasePath}-shm`]) this.remember(path); this.storage(); });
    const admin: DeviceRouteAdmin = { bindRoute: input => this.bind(input), suspendRoute: id => this.changeStatus(id,"suspended"), revokeRoute: id => this.changeStatus(id,"revoked"), listRoutes: botId => this.listRoutes(botId), patchRoute: input => this.patchRoute(input), routeReceipt: id => this.routeReceipt(id) };
    this.admin = Object.freeze(admin);
  }
  /** Safe host counters; no bearer tokens, pins, arguments or component graph. */
  toJSON(): object { return this.status(); }
  status(): { accepting: boolean; capabilities: number; flights: number; calls: number; closed: boolean; unconfirmed: boolean } { return { accepting: !this.#stopped, capabilities:this.#caps.size, flights:this.#flights.size, calls:this.#calls.size, closed:this.#closed, unconfirmed:this.#unconfirmed }; }
  ownsRoute(id: string): boolean { return typeof id === "string" && id.startsWith("dvr_"); }
  private principal(turnId: string): Omit<CapabilityScope,"expiresAt"> {
    this.#store.summary();
    let t: ReturnType<HostStore["getTurn"]>, b: ReturnType<HostStore["getBot"]>, thread: ReturnType<HostStore["getThread"]>;
    try { t = this.#store.getTurn(turnId); b = this.#store.getBot(t.botId); thread = this.#store.getThread(t.threadId); } catch (e) { if (e instanceof HostError && e.code === "host_locked") throw e; fail("unauthorized"); }
    if (t.state !== "running" || thread.botId !== b.id || b.ownerId !== this.#store.ownerId) fail("unauthorized");
    return { installationId:this.#store.hostId,ownerId:this.#store.ownerId,profileId:b.profileId,botId:b.id,threadId:thread.id,turnId:t.id };
  }
  issueCapability(input: { turnId: string; ttlMs?: number }): { token: string; scope: CapabilityScope } {
    if (this.#stopped) fail("unavailable");
    const principal = this.principal(input.turnId), ttl = Math.min(input.ttlMs ?? this.#ttl,this.#ttl);
    if (!safeInt(ttl)) fail("invalid_input");
    for (const [key,cap] of this.#caps) {
      let dead = this.#store.now() >= cap.scope.expiresAt;
      // Host-owned execution outlives the proposing engine turn. Its own deadline,
      // live authority guard, explicit Stop and finally cleanup still revoke it.
      if (!cap.ownerActionId) {
        try { dead ||= this.#store.getTurn(cap.scope.turnId).state !== "running"; } catch { dead = true; }
      }
      if (dead) { this.#caps.delete(key); cap.abort.abort(); }
    }
    if (this.#caps.size >= this.#maxCaps || [...this.#caps.values()].some(c => c.scope.turnId === input.turnId)) fail("conflict");
    const scope = Object.freeze({ ...principal,expiresAt:this.#store.now()+ttl }), token = randomBytes(32).toString("base64url");
    this.#caps.set(sha(token), { scope,abort:new AbortController() }); this.#everIssued = true; return { token,scope };
  }
  revokeCapability(token: string): void {
    if (typeof token !== "string") return;
    const key = sha(token), cap = this.#caps.get(key); this.#caps.delete(key); cap?.abort.abort();
  }
  private resolve(token: string): Capability {
    if (this.#stopped || typeof token !== "string" || !TOKEN.test(token)) fail("unauthorized");
    const cap = this.#caps.get(sha(token)); if (!cap) fail("unauthorized");
    const p = cap.ownerActionId ? this.#store.ownerToolScope(cap.ownerActionId) : this.principal(cap.scope.turnId);
    if (this.#store.now() >= cap.scope.expiresAt || Object.entries(p).some(([key,value]) => cap.scope[key as keyof CapabilityScope] !== value)) { this.revokeCapability(token); fail("unauthorized"); }
    return cap;
  }
  private snapshot(id: string): DevicePinSnapshot | null {
    const raw = this.#port.snapshot(id);
    if (!raw) return null;
    const p = Object.freeze({ ...raw });
    if (p.installationId !== this.#store.hostId || p.ownerId !== this.#store.ownerId || p.deviceId !== id || !HEX.test(p.fingerprint) || !safeInt(p.generation) || !safeInt(p.revision) || !["active","revoked"].includes(p.status)) fail("forbidden");
    return p;
  }
  private operation(tool: string): DeviceToolOperation {
    const op = this.#port.operation(tool);
    const schema = structuredClone(op.inputSchema);
    if (op.tool !== tool || !/^mac\.[a-z][a-z0-9_.]{1,100}$/.test(tool) || !/^[A-Za-z0-9._-]{1,64}$/.test(op.version)
      || !["read","write"].includes(op.effect) || typeof op.description !== "string" || op.description.length > 1000
      || schema.type !== "object" || schema.additionalProperties !== false || Object.keys(schema.properties).length > 32 || !HEX.test(op.schemaHash)) fail("invalid_input");
    if (sha(canonicalJson({ version:op.version,tool:op.tool,effect:op.effect,description:op.description,inputSchema:schema } as unknown as JsonValue)) !== op.schemaHash) fail("conflict");
    return { ...op,inputSchema:schema,validate:args => op.validate(args) };
  }
  private current(route: DeviceRoute): boolean {
    const p = this.snapshot(route.deviceId), d = this.#store.getDevice(route.deviceId), op = this.operation(route.tool);
    return route.status === "active" && d.revokedAt === null && d.ownerId === this.#store.ownerId && d.capabilities.includes(route.tool)
      && p?.status === "active" && p.fingerprint === route.fingerprint && p.generation === route.generation && p.revision === route.pinRevision
      && op.schemaHash === route.schemaHash && op.version === route.operationVersion;
  }
  private effectiveGrant(route: DeviceRoute): ReturnType<HostStore["getGrant"]> {
    const g = this.#store.getGrant(route.botId,route.tool,route.deviceId);
    return g && g.policy !== "deny" && g.revision >= route.minimumGrantRevision && (g.expiresAt === null || this.#store.now() < g.expiresAt) ? g : null;
  }
  listTools(token: string): ToolView[] {
    const { scope } = this.resolve(token), out: ToolView[] = [];
    for (const route of this.listRoutes(scope.botId)) {
      if (!this.current(route)) continue; const g = this.effectiveGrant(route); if (!g) continue;
      const op = this.operation(route.tool);
      out.push({ name:route.tool,description:op.description,effect:op.effect,inputSchema:op.inputSchema as unknown as InputSchema,connectionId:route.id,
        connectionLabel:"Paired Mac (owner label is untrusted data)",requiresApproval:this.#store.actionRequiresApproval(scope.botId, route.tool, route.deviceId, approvalEligibility(op),scope.threadId) });
    }
    return out;
  }
  /** Trusted composite-only reservation. Principal comes from its device child capability, never input. */
  reserveCompositeCall(token: string,input: unknown,context: { surface: "gateway" | "device"; listed: boolean }): void {
    const cap = this.resolve(token), raw = snapshotCall(input), argsHash = sha(canonicalJson(raw.arguments as Record<string,JsonValue>));
    if (!["gateway","device"].includes(context.surface) || (context.surface === "device") !== this.ownsRoute(raw.connectionId)) fail("invalid_input");
    this.tx(() => {
      const current = this.resolve(token);
      if (Object.entries(cap.scope).some(([key,value]) => current.scope[key as keyof CapabilityScope] !== value)) fail("unauthorized");
      const previous = this.#db.prepare("SELECT * FROM composite_call_bindings WHERE turn_id=? AND call_id=?").get(cap.scope.turnId,raw.callId) as Row | undefined;
      if (previous) {
        if (previous.bot_id !== cap.scope.botId || previous.thread_id !== cap.scope.threadId || previous.surface !== context.surface || previous.connection_id !== raw.connectionId || previous.tool !== raw.tool || previous.args_hash !== argsHash) fail("conflict");
        return;
      }
      if (!context.listed) fail("forbidden");
      this.#db.prepare("INSERT INTO composite_call_bindings VALUES (?,?,?,?,?,?,?,?)").run(cap.scope.turnId,raw.callId,cap.scope.botId,cap.scope.threadId,context.surface,raw.connectionId,raw.tool,argsHash);
    });
  }
  call(token: string,input: unknown,options: { signal?: AbortSignal } = {}): Promise<GatewayCallResult> {
    // The synchronous prefix commits intent and enters dispatch before any async gap.
    let promise: Promise<GatewayCallResult>;
    try { promise = this.plan(token,input,options.signal); } catch (error) { return Promise.reject(this.safe(error)); }
    this.#calls.add(promise); void promise.then(() => this.#calls.delete(promise),() => this.#calls.delete(promise)); return promise;
  }
  private plan(token: string,input: unknown,signal?: AbortSignal): Promise<GatewayCallResult> {
    const cap = this.resolve(token); if (signal?.aborted) fail("unauthorized");
    const raw = snapshotCall(input);
    const previous = this.binding(cap.scope.turnId,raw.callId);
    if (previous && (previous.routeId !== raw.connectionId || previous.tool !== raw.tool)) fail("conflict");
    const route = this.route(raw.connectionId);
    if (!route || route.botId !== cap.scope.botId || route.tool !== raw.tool) fail("forbidden");
    let args: Record<string, JsonValue>;
    // An exact replay of an admitted canonical body stays bound to its own pinned operation; it is never
    // re-validated (or re-authorized) under a later schema. Any other body is validated natively now.
    if (previous && sha(canonicalJson(raw.arguments as Record<string,JsonValue>)) === previous.argsHash) args = previous.arguments;
    else {
      const operation = this.operation(route.tool);
      try { const bounded = validateArguments(operation.inputSchema as unknown as InputSchema,raw.arguments); args = operation.validate(bounded); validateArguments(operation.inputSchema as unknown as InputSchema,args); }
      catch { fail("invalid_input"); }
    }
    const continued=this.#store.replayedContinuationAction(cap.scope.turnId,raw.tool,route.deviceId,args);
    if(continued)return Promise.resolve({...project(continued),result:null});
    const argsHash = sha(canonicalJson(args));
    let binding = previous;
    if (binding && (binding.routeId !== route.id || binding.tool !== route.tool || binding.argsHash !== argsHash || binding.botId !== cap.scope.botId || binding.threadId !== cap.scope.threadId)) fail("conflict");
    if (!binding) {
      if (!this.current(route) || !this.effectiveGrant(route)) fail("forbidden");
      if (this.#port.authenticatedPresence(route.deviceId) !== "online") fail("unavailable");
      const grant = this.effectiveGrant(route)!;
      const base = { turnId:cap.scope.turnId,callId:raw.callId,routeId:route.id,routeRevision:route.revision,botId:cap.scope.botId,threadId:cap.scope.threadId,
        deviceId:route.deviceId,tool:route.tool,fingerprint:route.fingerprint,generation:route.generation,pinRevision:route.pinRevision,
        schemaHash:route.schemaHash,operationVersion:route.operationVersion,argsHash,arguments:args,grantRevision:grant.revision };
      binding = { ...base,idempotencyKey:`dvt_${sha(canonicalJson(base as unknown as JsonValue)).slice(0,48)}`,actionId:null };
      const saved = binding;
      this.tx(() => { this.resolve(token); if (signal?.aborted || !this.bindingCurrent(saved)) fail("forbidden"); this.insertBinding(saved); });
    }
    let action: Action;
    if (binding.actionId) action = this.#store.getAction(binding.actionId);
    else {
      // Two fenced databases, not a distributed transaction. Durable intent fixes the replay key, so an action
      // committed before attachment is recovered by its exact key; only a missing one may be created, under current authority.
      const existing = this.#store.findAction(binding.botId,binding.idempotencyKey);
      if (!existing && !this.bindingCurrent(binding)) fail("forbidden");
      action = existing ?? this.#store.requestAction(this.request(binding), approvalEligibility(this.operation(binding.tool)));
      if (!this.matches(binding,action)) fail("conflict");
      const id = action.id, saved = binding;
      this.tx(() => { this.#db.prepare("UPDATE device_calls SET action_id=? WHERE turn_id=? AND call_id=? AND action_id IS NULL").run(id,saved.turnId,saved.callId); });
      binding = { ...binding,actionId:id };
    }
    if (!this.matches(binding,action)) fail("conflict");
    this.#store.bindToolAction(action.id,cap.scope.turnId,raw.callId);
    if (terminal(action)) return Promise.resolve(this.disclose(binding,action,token));
    if (!this.bindingCurrent(binding)) {
      if (["ready","awaiting_approval"].includes(action.state)) action = this.#store.blockAction(action.id);
      return Promise.resolve(project(action));
    }
    const active = this.#flights.get(action.id); if (active) return active;
    if (action.state !== "ready") return Promise.resolve(project(action));
    if (this.#port.authenticatedPresence(binding.deviceId) !== "online") fail("unavailable");
    this.resolve(token); if (signal?.aborted) fail("unauthorized");
    if(!cap.ownerActionId && action.decidedBy===this.#store.ownerId){
      const completed=this.continueOwnerAction(action).then(receipt=>this.disclose(binding!,receipt,token));
      return completed;
    }
    const joined = new AbortController(), abort = (): void => joined.abort();
    cap.abort.signal.addEventListener("abort",abort,{ once:true }); signal?.addEventListener("abort",abort,{ once:true });
    if (cap.abort.signal.aborted || signal?.aborted) joined.abort();
    const saved = binding;
    const guard = (actual: Action,peer: DevicePinSnapshot): boolean => {
      try { this.resolve(token); const canonical = this.#store.getAction(actual.id); return !joined.signal.aborted && this.matches(saved,actual) && actual.state === "running" && this.matches(saved,canonical) && canonical.state === "running"
        && peer.installationId === cap.scope.installationId && peer.ownerId === cap.scope.ownerId && peer.deviceId === saved.deviceId
        && peer.status === "active" && peer.fingerprint === saved.fingerprint && peer.generation === saved.generation && peer.revision === saved.pinRevision
        && this.#port.authenticatedPresence(saved.deviceId)==="online"
        && this.bindingCurrent(saved) && this.grantCurrent(saved,actual,!cap.ownerActionId); } catch { return false; }
    };
    this.#admissions.set(action.id,{ capabilityHash:sha(token),signal:joined.signal });
    let dispatched: Promise<Action>;
    try { dispatched = this.#port.dispatchBound(action.id,{ signal:joined.signal,guard }); }
    catch (error) { dispatched = Promise.reject(error); }
    const flight = (async (): Promise<GatewayCallResult> => {
      let rejected = false, failure: unknown;
      try { await dispatched; }
      catch (error) {
        // Only the trusted port may prove a pre-claim refusal. Peer/network errors cannot make this claim.
        if (DeviceDispatchPreflightError.is(error)) {
          let current: Action;
          try { current = this.#store.getAction(action.id); } catch { return this.unconfirmed(action); }
          if (this.matches(saved,current) && ["ready","awaiting_approval","blocked","denied"].includes(current.state)) {
            let valid = false; try { valid = this.bindingCurrent(saved); } catch { /* Refuse stale authority. */ }
            if (!valid && ["ready","awaiting_approval"].includes(current.state)) this.#store.blockAction(current.id);
            throw error;
          }
        }
        // A generic rejected lifecycle (or claimed action) cannot prove executor/receipt cleanup.
        this.#unconfirmed = true; this.stopAdmission(); rejected = true; failure = error;
      }
      // Admitted work reports the canonical outcome; lost authority only withholds a body (see disclose).
      let actual: Action;
      try { actual = this.#store.getAction(action.id); } catch { return this.unconfirmed(action); }
      if (!this.matches(saved,actual)) { this.#unconfirmed = true; this.stopAdmission(); fail("conflict"); }
      if (rejected && actual.state === "running") {
        try { actual = this.#store.markUnknown(action.id,"executor_error"); } catch { return this.unconfirmed(action); }
      }
      if (actual.state === "running") return this.unconfirmed(action); // A settled port cannot conceal running work.
      if (!terminal(actual)) { if (failure instanceof HostError && failure.code === "host_locked") throw failure; fail("unavailable"); }
      return this.disclose(saved,actual,token,joined.signal);
    })().catch(error => { throw this.safe(error); }).finally(() => {
      cap.abort.signal.removeEventListener("abort",abort); signal?.removeEventListener("abort",abort); this.#flights.delete(action.id); this.#admissions.delete(action.id);
    });
    this.#flights.set(action.id,flight); return flight;
  }
  /** Authoritative lookup, including crash between hub action creation and binding attachment. */
  isTurnBound(actionId: string): boolean {
    this.check(); const action = this.#store.getAction(actionId);
    return !!this.one("SELECT 1 FROM device_calls WHERE action_id=? OR idempotency_key=?",actionId,action.request.idempotencyKey);
  }
  /** Host-only replay; the original model bearer capability remains revoked. */
  async continueOwnerAction(action: Action): Promise<Action> {
    if(action.state!=="ready")return this.#store.getAction(action.id);
    this.check();
    const origin=this.#store.toolActionOrigin(action.id);
    if(!origin)fail("forbidden");
    const binding=this.binding(origin.turnId,origin.callId);
    if(!binding || !this.matches(binding,action))fail("forbidden");
    const token=randomBytes(32).toString("base64url"), scope=this.#store.ownerToolScope(action.id);
    this.#caps.set(sha(token),{scope,abort:new AbortController(),ownerActionId:action.id});
    const execution=this.#store.approvedExecution(action.id);
    try {
      const outcome=await this.call(token,{connectionId:binding.routeId,tool:binding.tool,callId:binding.callId,arguments:binding.arguments},{signal:execution.signal});
      this.#store.recordToolOutcome(action.id,outcome.result);
      return this.#store.getAction(action.id);
    } catch(error) {
      const current=this.#store.getAction(action.id);
      // Authenticated offline presence is a pre-dispatch refusal, not an uncertain device effect.
      // Close the exact proposal explicitly; reconnecting cannot silently replay it.
      if(current.state==="ready" && error instanceof GatewayError && error.code==="unavailable"){
        const receipt=this.#store.blockAction(action.id,"destination_unavailable");
        this.#store.recordToolOutcome(action.id,receipt.result);return receipt;
      }
      throw error;
    } finally {execution.dispose();this.revokeCapability(token);}
  }
  /** Future server guard: synchronous and safe inside the existing outer HostStore writer fence. */
  deliveryGuard(action: Action,peer: DevicePinSnapshot): boolean {
    try {
      this.check(); const row = this.one("SELECT * FROM device_calls WHERE action_id=? OR idempotency_key=?",action.id,action.request.idempotencyKey);
      if (!row) return !action.request.idempotencyKey.startsWith("dvt_"); // Conservative reserved-namespace refusal, never authority by prefix.
      const b = fromBinding(row), canonical = this.#store.getAction(action.id), admission = this.#admissions.get(action.id), cap = admission && this.#caps.get(admission.capabilityHash);
      if (!admission || admission.signal.aborted || !cap || this.#store.now() >= cap.scope.expiresAt || cap.scope.turnId !== b.turnId || cap.scope.botId !== b.botId || cap.scope.threadId !== b.threadId) return false;
      return !this.#stopped && this.matches(b,action) && action.state === "running" && this.matches(b,canonical) && canonical.state === "running"
        && this.#port.authenticatedPresence(b.deviceId)==="online" && this.bindingCurrent(b) && this.grantCurrent(b,action,!cap.ownerActionId)
        && peer.installationId === this.#store.hostId && peer.ownerId === this.#store.ownerId && peer.deviceId === b.deviceId
        && peer.status === "active" && peer.fingerprint === b.fingerprint && peer.generation === b.generation && peer.revision === b.pinRevision;
    } catch { return false; }
  }
  stopAdmission(): void { if (this.#stopped) return; this.#stopped = true; for (const c of this.#caps.values()) c.abort.abort(); this.#caps.clear(); }
  /** Constructor-failure cleanup only; never a recovery API for admitted or quarantined work. */
  disposeUnstarted(): void {
    if (this.#closed) return;
    if (this.#everIssued || this.#closing || this.#unconfirmed || this.#caps.size || this.#calls.size || this.#flights.size || this.#admissions.size) fail("conflict");
    this.#store.withWriterLease(() => {
      this.storage();
      for (const row of this.all("SELECT action_id FROM device_calls WHERE action_id IS NOT NULL")) if (this.#store.getAction(String(row.action_id)).state === "running") fail("unavailable");
      this.#db.close(); this.#closed = true; this.#stopped = true;
    });
  }
  close(): Promise<void> {
    this.stopAdmission();
    if (this.#closed) return this.#closing ??= Promise.resolve();
    this.#closing ??= (async () => {
      await Promise.allSettled([...this.#calls]);
      if (this.#unconfirmed || this.#flights.size || this.#calls.size) fail("unavailable");
      for (const row of this.all("SELECT action_id FROM device_calls WHERE action_id IS NOT NULL")) if (this.#store.getAction(String(row.action_id)).state === "running") fail("unavailable");
      this.storage(); this.#db.close(); this.#closed = true;
    })();
    return this.#closing;
  }
  private bindingCurrent(b: Binding): boolean {
    if(this.#store.getTurn(b.turnId).state==="running")this.principal(b.turnId);
    else if(!b.actionId || this.#store.ownerToolScope(b.actionId).turnId!==b.turnId)return false;
    const r = this.route(b.routeId);
    return !!r && r.botId === b.botId && r.deviceId === b.deviceId && r.tool === b.tool && r.revision === b.routeRevision
      && r.fingerprint === b.fingerprint && r.generation === b.generation && r.pinRevision === b.pinRevision && r.schemaHash === b.schemaHash
      && r.operationVersion === b.operationVersion && this.current(r) && this.effectiveGrant(r)?.revision === b.grantRevision;
  }
  private grantCurrent(b: Binding,a: Action,approval = true): boolean {
    const g = this.#store.getGrant(b.botId,b.tool,b.deviceId);
    return !!g && g.policy !== "deny" && g.revision === b.grantRevision && a.grantRevision === b.grantRevision
      && (g.expiresAt === null || this.#store.now() < g.expiresAt)
      && (!approval || a.approvalExpiresAt === null || this.#store.now() < a.approvalExpiresAt);
  }
  /**
   * The single result policy for flights and replay. Status, action ID, request hash and reason are always the
   * canonical action's; a succeeded body is disclosed only while the capability, signal, turn, route, pin,
   * operation and grant revision are all still current. Approval expiry gates execution, not disclosure.
   */
  private disclose(b: Binding,a: Action,token: string,signal?: AbortSignal): GatewayCallResult {
    const out = project(a);
    if (a.state !== "succeeded") return out;
    let current = false;
    try {
      const cap = this.resolve(token);
      current = !signal?.aborted && !cap.abort.signal.aborted && cap.scope.turnId === b.turnId && cap.scope.botId === b.botId
        && cap.scope.threadId === b.threadId && this.bindingCurrent(b) && this.grantCurrent(b,a,false);
    } catch { /* Lost authority withholds the body; it never rewrites a committed outcome. */ }
    return current ? out : { ...out,result:null };
  }
  /** The store cannot confirm the admitted action's outcome: quarantine and report honest uncertainty. */
  private unconfirmed(a: Action): GatewayCallResult {
    this.#unconfirmed = true; this.stopAdmission();
    return { actionId:a.id,status:"unknown",requestHash:a.requestHash,reason:null,result:null };
  }
  private request(b: Binding): ToolRequest { return { botId:b.botId,threadId:b.threadId,tool:b.tool,destination:b.deviceId,arguments:b.arguments,idempotencyKey:b.idempotencyKey }; }
  private matches(b: Binding,a: Action): boolean { return (!b.actionId || b.actionId === a.id) && a.requestHash === hashRequest(this.request(b)) && canonicalJson(a.request as unknown as JsonValue) === canonicalJson(this.request(b) as unknown as JsonValue); }
  private bind(input: { botId: string; deviceId: string; tool: string }): DeviceRoute {
    const route = this.tx(() => this.bindCore(input));
    this.blockPending(route.id); return route;
  }
  /** Runs in the same SQLite transaction as the owner request receipt. */
  private bindCore(input: { botId: string; deviceId: string; tool: string }): DeviceRoute {
    if (this.#stopped || !input || ![input.botId,input.deviceId,input.tool].every(v => typeof v === "string" && ID.test(v))) fail("invalid_input");
    this.#store.getBot(input.botId); const d = this.#store.getDevice(input.deviceId), p = this.snapshot(input.deviceId), op = this.operation(input.tool);
    if (d.revokedAt !== null || !d.capabilities.includes(op.tool) || p?.status !== "active") fail("forbidden");
    const previous = this.one("SELECT * FROM device_routes WHERE bot_id=? AND device_id=? AND tool=?",input.botId,input.deviceId,input.tool);
    if (previous?.status === "revoked") fail("forbidden");
    // Any pin or operation identity change (schema hash covers version/effect/description/schema) invalidates
    // prior consent, including downgrade or A-B-A: the minimum is fixed above every grant revision seen so far.
    const changed = previous && (previous.fingerprint !== p.fingerprint || previous.generation !== p.generation || previous.pin_revision !== p.revision
      || previous.schema_hash !== op.schemaHash || previous.operation_version !== op.version);
    const grant = this.#store.getGrant(input.botId,input.tool,input.deviceId);
    const minimum = changed ? Math.max(Number(previous.minimum_grant_revision), (grant?.revision ?? 0)+1) : Number(previous?.minimum_grant_revision ?? 1);
    const id = String(previous?.id ?? `dvr_${randomUUID()}`), revision = Number(previous?.revision ?? 0)+1;
      if (!previous && this.all("SELECT id FROM device_routes LIMIT ?",this.#maxRoutes).length >= this.#maxRoutes) fail("unavailable");
      if (!safeInt(revision) || !safeInt(minimum)) fail("conflict");
      this.#db.prepare(`INSERT INTO device_routes VALUES (?,?,?,?,?,?,?,?,?,?,'active',?) ON CONFLICT(id) DO UPDATE SET
      fingerprint=excluded.fingerprint,generation=excluded.generation,pin_revision=excluded.pin_revision,schema_hash=excluded.schema_hash,
      operation_version=excluded.operation_version,revision=excluded.revision,status='active',minimum_grant_revision=excluded.minimum_grant_revision`)
        .run(id,input.botId,input.deviceId,input.tool,p.fingerprint,p.generation,p.revision,op.schemaHash,op.version,revision,minimum);
    return this.route(id)!;
  }
  private patchRoute(input: unknown): DeviceRouteReceipt {
    if (this.#stopped) fail("unavailable");
    // No accessor/proxy execution or implicit conversion at this owner boundary.
    if (!input || typeof input !== "object" || Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) fail("invalid_input");
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).some(k => typeof k !== "string" || !("value" in descriptors[k]!))) fail("invalid_input");
    const parsed = DeviceRoutePatchSchema.safeParse(Object.fromEntries(Object.entries(descriptors).map(([k,d]) => [k,d.value])));
    if (!parsed.success) fail("invalid_input");
    const request: DeviceRoutePatch = parsed.data;
    if (request.expectedHostId !== this.#store.hostId) fail("conflict");
    const json = canonicalJson(request as unknown as JsonValue), hash = sha(json);
    let changed = false;
    const receipt = this.tx(() => {
      const previousReceipt = this.one("SELECT * FROM device_route_receipts WHERE client_request_id=?",request.clientRequestId);
      if (previousReceipt) {
        if (previousReceipt.request_hash !== hash || previousReceipt.request_json !== json) fail("conflict");
        return JSON.parse(String(previousReceipt.receipt_json)) as DeviceRouteReceipt;
      }
      this.#store.getBot(request.botId);
      const previous = this.one("SELECT * FROM device_routes WHERE bot_id=? AND device_id=? AND tool=?",request.botId,request.deviceId,request.tool);
      if ((previous ? Number(previous.revision) : null) !== request.expectedRevision) fail("conflict");
      if (Number(this.one("SELECT COUNT(*) AS n FROM device_route_receipts")!.n) >= 10_000) fail("unavailable");
      let route: DeviceRoute;
      if (request.status === "active") route = this.bindCore(request);
      else {
        if (!previous || previous.status === "revoked" && request.status !== "revoked") fail("forbidden");
        const revision = Number(previous.revision)+1; if (!safeInt(revision)) fail("conflict");
        this.#db.prepare("UPDATE device_routes SET status=?,revision=? WHERE id=?").run(request.status,revision,String(previous.id));
        route = this.route(String(previous.id))!;
      }
      const result: DeviceRouteReceipt = { schema:"dexter.device-route-receipt/1",hostId:this.#store.hostId,ownerId:this.#store.ownerId,
        clientRequestId:request.clientRequestId,requestHash:hash,request,route,committedAt:this.#store.now() };
      this.#db.prepare("INSERT INTO device_route_receipts VALUES (?,?,?,?,?)").run(request.clientRequestId,hash,json,canonicalJson(result as unknown as JsonValue),result.committedAt);
      changed = true;
      return result;
    });
    // Route + receipt are already durable. Pending-action cleanup is a separate host DB boundary;
    // if it fails, GET retrieves the original receipt and no mutation is repeated.
    if (changed) this.blockPending(receipt.route.id); return receipt;
  }
  private routeReceipt(id: string): DeviceRouteReceipt | null {
    if (this.#stopped) fail("unavailable"); if (typeof id !== "string" || !ID.test(id)) fail("invalid_input");
    const row = this.one("SELECT receipt_json FROM device_route_receipts WHERE client_request_id=?",id);
    return row ? JSON.parse(String(row.receipt_json)) as DeviceRouteReceipt : null;
  }
  private changeStatus(id: string,status: "suspended" | "revoked"): DeviceRoute {
    if (this.#stopped) fail("unavailable"); const r = this.route(id); if (!r) fail("forbidden");
    if (r.status !== "revoked") this.tx(() => { this.#db.prepare("UPDATE device_routes SET status=?,revision=revision+1 WHERE id=?").run(status,id); });
    this.blockPending(id); return this.route(id)!;
  }
  private blockPending(routeId: string): void {
    for (const row of this.all("SELECT * FROM device_calls WHERE route_id=?",routeId)) {
      const b = fromBinding(row), a = b.actionId ? this.#store.getAction(b.actionId) : this.#store.findAction(b.botId,b.idempotencyKey);
      if (a && ["ready","awaiting_approval"].includes(a.state)) this.#store.blockAction(a.id);
    }
  }
  private listRoutes(botId?: string): DeviceRoute[] {
    this.check(); return (botId === undefined ? this.all("SELECT * FROM device_routes ORDER BY id LIMIT ?",this.#maxRoutes) : this.all("SELECT * FROM device_routes WHERE bot_id=? ORDER BY id LIMIT ?",botId,this.#maxRoutes)).map(r => this.toRoute(r));
  }
  private route(id: string): DeviceRoute | null { const r = this.one("SELECT * FROM device_routes WHERE id=?",id); return r ? this.toRoute(r) : null; }
  private toRoute(r: Row): DeviceRoute {
    const grant = this.#store.getGrant(String(r.bot_id),String(r.tool),String(r.device_id));
    return { id:String(r.id),botId:String(r.bot_id),deviceId:String(r.device_id),tool:String(r.tool),fingerprint:String(r.fingerprint),generation:Number(r.generation),pinRevision:Number(r.pin_revision),schemaHash:String(r.schema_hash),operationVersion:String(r.operation_version),revision:Number(r.revision),status:r.status as DeviceRoute["status"],minimumGrantRevision:Number(r.minimum_grant_revision),needsFreshGrant:(grant?.revision ?? 0)<Number(r.minimum_grant_revision) };
  }
  private binding(turnId: string,callId: string): Binding | null { const r = this.one("SELECT * FROM device_calls WHERE turn_id=? AND call_id=?",turnId,callId); return r ? fromBinding(r) : null; }
  private insertBinding(b: Binding): void {
    this.#db.prepare("INSERT INTO device_calls VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(b.turnId,b.callId,b.routeId,b.routeRevision,b.botId,b.threadId,b.deviceId,b.tool,b.fingerprint,b.generation,b.pinRevision,b.schemaHash,b.operationVersion,b.argsHash,canonicalJson(b.arguments),b.grantRevision,b.idempotencyKey,b.actionId);
  }
  private stat(path: string,directory = false): Stats | null {
    let s: Stats; try { s = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; fail("unavailable"); }
    if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0) fail("unavailable"); return s;
  }
  private remember(path: string): void { const s = this.stat(path); if (s) this.#files.set(path,{ inode:s.ino,device:s.dev }); }
  private storage(): void {
    const d = this.stat(dirname(this.databasePath),true); if (!d || d.ino !== this.#directory.ino || d.dev !== this.#directory.dev) fail("unavailable");
    for (const [path,id] of this.#files) { const s = this.stat(path); if (!s || s.ino !== id.inode || s.dev !== id.device) fail("unavailable"); }
    for (const path of [`${this.databasePath}-wal`,`${this.databasePath}-shm`]) if (this.stat(path) && !this.#files.has(path)) fail("unavailable");
    if (this.stat(`${this.databasePath}-journal`)) fail("unavailable");
  }
  private check(): void { if (this.#closed) fail("unavailable"); this.#store.summary(); this.storage(); }
  private one(sql: string,...params: SQLInputValue[]): Row | undefined { this.check(); return this.#db.prepare(sql).get(...params) as Row | undefined; }
  private all(sql: string,...params: SQLInputValue[]): Row[] { this.check(); return this.#db.prepare(sql).all(...params) as Row[]; }
  private tx<T>(fn: () => T): T { if (this.#closed) fail("unavailable"); return this.#store.withWriterLease(() => { this.storage(); this.#db.exec("BEGIN IMMEDIATE"); try { const result = fn(); this.#db.exec("COMMIT"); return result; } catch (e) { if (this.#db.isTransaction) this.#db.exec("ROLLBACK"); throw e; } }); }
  private safe(error: unknown): unknown { return error instanceof GatewayError || error instanceof HostError && error.code === "host_locked" ? error : new GatewayError("unavailable","device tools unavailable"); }
}
function fromBinding(r: Row): Binding {
  return { turnId:String(r.turn_id),callId:String(r.call_id),routeId:String(r.route_id),routeRevision:Number(r.route_revision),botId:String(r.bot_id),threadId:String(r.thread_id),deviceId:String(r.device_id),tool:String(r.tool),fingerprint:String(r.fingerprint),generation:Number(r.generation),pinRevision:Number(r.pin_revision),schemaHash:String(r.schema_hash),operationVersion:String(r.operation_version),argsHash:String(r.args_hash),arguments:JSON.parse(String(r.arguments)) as Record<string,JsonValue>,grantRevision:Number(r.grant_revision),idempotencyKey:String(r.idempotency_key),actionId:r.action_id === null ? null : String(r.action_id) };
}
function snapshotCall(value: unknown): { tool: string; connectionId: string; callId: string; arguments: Record<string,unknown> } {
  try {
    const clone = structuredClone(value) as Record<string,unknown>;
    if (!clone || Array.isArray(clone) || Object.getPrototypeOf(clone) !== Object.prototype || Object.keys(clone).sort().join(",") !== "arguments,callId,connectionId,tool"
      || typeof clone.tool !== "string" || typeof clone.connectionId !== "string" || typeof clone.callId !== "string" || !ID.test(clone.callId)
      || !clone.arguments || typeof clone.arguments !== "object" || Array.isArray(clone.arguments)) fail("invalid_input");
    if (Buffer.byteLength(canonicalJson(clone as unknown as JsonValue)) > 65_536) fail("invalid_input");
    return { tool:clone.tool,connectionId:clone.connectionId,callId:clone.callId,arguments:clone.arguments as Record<string,unknown> };
  } catch { fail("invalid_input"); }
}
