import type { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { GatewayError } from "./errors.js";
import { readMcpSetupDiagnostic, type JsonValue } from "@dexter/contracts";
import { canonicalJson } from "@dexter/hub";
import type { CapabilityScope, GatewayCallResult, ToolView } from "./gateway.js";
import type { TurnToolSurface } from "./surface.js";
import { directoryToolDefinitions, gatewayToolAlias, planCatalogExposure, projectCatalogTool, searchCatalog, MCP_DIRECTORY_ALIASES, MCP_AUTHORIZED_INVENTORY_LIMIT } from "./catalog.js";
import { MCP_MODERN_VERSION, MCP_SUPPORTED_VERSIONS, modernMetadata, McpProtocolError } from "./protocol.js";
import { projectMcpOutcome, type McpArtifactSink } from "./output.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25";
type RpcId = string | number;
type ObjectValue = Record<string, unknown>;
interface Pending { controller: AbortController; timer: ReturnType<typeof setTimeout>; responded: boolean; executing: boolean; reservation: number; method: string; acknowledge?:()=>void; outcome?:GatewayCallResult }
interface Delivery { frame: string; bytes: number; settle: (delivered:boolean) => void }
interface Target { tool: string; connectionId: string }
interface ReplayReceipt { actionId: string; requestHash: string; status: "succeeded" | "unknown" }
// Lease-local digest/identity evidence only; saturation refuses fallback without changing live/direct dispatch.
const REPLAY_RECEIPT_LIMIT = 4096;
export interface GatewayMcpOptions {
  gateway: TurnToolSurface;
  /** Issued by the trusted host for this running turn; never passed in MCP params, argv or environment. */
  capability: string;
  /** Only a trusted McpTurnLease may own revocation across one bounded disposable discovery sibling. */
  capabilityOwner?: "bridge" | "host_lease";
  input: Readable;
  output: Writable;
  maxLineBytes?: number;
  /** Limit of one encoded response frame. */
  maxOutputBytes?: number;
  /** Entire response queue, including the active write. Default (maxInFlight + 1) * maxOutputBytes, at most 64 MiB (one frame reserved for control errors). */
  maxQueuedOutputBytes?: number;
  /** Maximum time without a completed output write. Slow consumers continue; stalled consumers close. */
  outputStallTimeoutMs?: number;
  maxInFlight?: number;
  requestTimeoutMs?: number;
  /** Directly exposed definitions only; eligible bindings have a separate MCP_AUTHORIZED_INVENTORY_LIMIT. */
  maxCatalogTools?: number;
  /** Conservative UTF-8/3 estimate; direct schemas beyond this budget remain available via scoped directory. */
  catalogTokenBudget?: number;
  pinnedAliases?: readonly string[];
  /** Trusted host priority by canonical name; only already-scoped views can be pinned. */
  pinnedToolNames?: readonly string[];
  maxOutputTokens?: number;
  maxContentBlocks?: number;
  /** Explicitly false for a driver unable to consume image/audio/resource content blocks. */
  multimodalResults?: boolean;
  artifactSink?: McpArtifactSink;
  /** Trusted original issued scope for value-free read receipts without a Hub action row. Never wire metadata. */
  artifactScope?: Readonly<CapabilityScope>;
  /** Trusted host keeps the original RPC pending through approval and exact execution. */
  settleApproval?: (input: unknown, outcome: GatewayCallResult, signal: AbortSignal) => Promise<GatewayCallResult>;
  /** Called only after the response frame's output write acknowledges success. No inference ACK is implied. */
  acknowledgeToolResult?: (input:unknown,outcome:GatewayCallResult)=>void;
}
class RpcFault extends Error {
  constructor(readonly code: number, message: string, readonly data?: Record<string, unknown>) { super(message); }
}
const object = (value: unknown): value is ObjectValue => typeof value === "object" && value !== null && !Array.isArray(value);
const idOk = (id: unknown): id is RpcId => (typeof id === "number" && Number.isSafeInteger(id))
  || (typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id));
const exact = (value: ObjectValue, keys: readonly string[]): boolean => Object.keys(value).every(key => keys.includes(key));
const paramsOk = (value: ObjectValue | undefined, keys: readonly string[]): boolean => value === undefined
  || (exact(value, [...keys, "_meta"]) && (!Object.hasOwn(value, "_meta") || object(value._meta)));
const keyOf = (id: RpcId): string => `${typeof id}:${id}`;
const invalid = (): never => { throw new RpcFault(-32602, "Invalid params"); };

/**
 * Host-owned MCP stdio framing over injected streams. No logger, config file, network listener or credential
 * broker exists here. Each alias pins a gateway tool/connection; model arguments cannot change identity or target.
 * close aborts outstanding work and revokes this bridge's capability by default. A trusted turn lease may instead
 * own revocation for its bounded disposable probe; no MCP input controls that ownership. Host must await whenDrained before releasing
 * its writer lease: cancellation cannot undo a dispatched upstream effect or stop an uncooperative adapter.
 */
export class GatewayMcpBridge {
  readonly #gateway: TurnToolSurface;
  readonly #capability: string;
  private readonly ownsCapability: boolean;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly lineLimit: number;
  private readonly outputLimit: number;
  private readonly inFlightLimit: number;
  private readonly queueLimit: number;
  private readonly stallMs: number;
  private readonly deliveries: Delivery[] = [];
  private delivery: Delivery | null = null;
  private queuedBytes = 0;
  private reservedBytes = 0;
  private stallTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly timeoutMs: number;
  private readonly catalogLimit: number;
  private readonly catalogTokenBudget: number;
  private readonly pinnedAliases: readonly string[];
  private readonly pinnedToolNames: readonly string[];
  private readonly outputTokens: number;
  private readonly contentBlocks: number;
  private readonly multimodal: boolean;
  private readonly artifactSink: McpArtifactSink | undefined;
  private readonly settleApproval: GatewayMcpOptions["settleApproval"];
  private readonly acknowledgeToolResult:GatewayMcpOptions["acknowledgeToolResult"];
  private readonly pending = new Map<string, Pending>();
  private readonly targets = new Map<string, Target>();
  private readonly replayReceipts = new Map<string, Readonly<ReplayReceipt>>();
  /** Notifications share one bounded metadata poll; every RPC/call still revalidates live authority. */
  private notificationFingerprint = "";
  private notificationPolledAt = 0;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private phase: "new" | "initializing" | "ready" = "new";
  private framesReceived = 0;
  private discoveryProbeCandidate = false;
  private discoveryProbeDelivered = false;
  private stopped = false;
  private readonly drainWaiters: Array<() => void> = [];
  constructor(options: GatewayMcpOptions) {
    this.#gateway = options.gateway;
    this.#capability = options.capability;
    if (options.capabilityOwner !== undefined && !["bridge", "host_lease"].includes(options.capabilityOwner)) throw new Error("Invalid MCP capability owner");
    this.ownsCapability = options.capabilityOwner !== "host_lease";
    this.input = options.input;
    this.output = options.output;
    const bound = (value: number | undefined, fallback: number, max: number): number => {
      const n = value ?? fallback;
      if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error("Invalid MCP limit");
      return n;
    };
    this.lineLimit = bound(options.maxLineBytes, 256 * 1024, 4 * 1024 * 1024);
    this.outputLimit = bound(options.maxOutputBytes, 1024 * 1024, 8 * 1024 * 1024);
    if (this.outputLimit < 1024) throw new Error("Invalid MCP limit");
    this.inFlightLimit = bound(options.maxInFlight, 8, 64);
    this.queueLimit = bound(options.maxQueuedOutputBytes, (this.inFlightLimit + 1) * this.outputLimit, 64 * 1024 * 1024);
    if (this.queueLimit < (this.inFlightLimit + 1) * this.outputLimit) throw new Error("Invalid MCP limit");
    this.stallMs = bound(options.outputStallTimeoutMs, 30_000, 300_000);
    this.timeoutMs = bound(options.requestTimeoutMs, 30_000, 300_000);
    this.catalogLimit = bound(options.maxCatalogTools, 256, 1024);
    this.catalogTokenBudget = bound(options.catalogTokenBudget, 24_000, 1_000_000);
    if (this.catalogTokenBudget < 256) throw new Error("Invalid MCP limit");
    planCatalogExposure([], { tokenBudget: this.catalogTokenBudget, maxTools: this.catalogLimit });
    this.pinnedAliases = Object.freeze([...(options.pinnedAliases ?? [])]);
    if (this.pinnedAliases.length > 1024 || this.pinnedAliases.some(name => !/^dx_[a-f0-9]{24}$/.test(name))) throw new Error("Invalid catalog pins");
    this.pinnedToolNames = Object.freeze([...(options.pinnedToolNames ?? [])]);
    if (this.pinnedToolNames.length > 32 || this.pinnedToolNames.some(name => !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name))) throw new Error("Invalid canonical catalog pins");
    this.outputTokens = bound(options.maxOutputTokens, 1_000_000, 1_000_000);
    this.contentBlocks = bound(options.maxContentBlocks, 32, 128);
    this.multimodal = options.multimodalResults !== false;
    const scope = options.artifactScope;
    const textScopeKeys = ["installationId", "ownerId", "profileId", "botId", "threadId", "turnId"] as const;
    const scopeKeys = [...textScopeKeys, "expiresAt"];
    if (scope !== undefined && (!object(scope) || Object.keys(scope).length !== scopeKeys.length || !exact(scope, scopeKeys)
      || textScopeKeys.some(key => typeof scope[key] !== "string" || scope[key].length < 1 || scope[key].length > 128)
      || !Number.isSafeInteger(scope.expiresAt) || scope.expiresAt < 1)) throw new Error("Invalid MCP artifact scope");
    const originScope = scope === undefined ? undefined : Object.freeze({ ...scope });
    const sink = options.artifactSink;
    this.artifactSink = sink === undefined ? undefined : input => sink({
      actionId: input.actionId, requestHash: input.requestHash, content: input.content, mimeType: input.mimeType,
      ...(originScope === undefined ? {} : { originScope }),
    });
    this.settleApproval = options.settleApproval;
    this.acknowledgeToolResult=options.acknowledgeToolResult;
    // Validate the host-issued scope immediately. No capability material is serialized by this class.
    if (this.#gateway.listTools(this.#capability).length > MCP_AUTHORIZED_INVENTORY_LIMIT) throw new RpcFault(-32001, "Tool catalog limit exceeded");
    this.input.on("data", this.onData);
    this.input.on("end", this.onEnd);
    this.input.on("close", this.onClose);
    this.input.on("error", this.onClose);
    this.output.on("error", this.onClose);
    this.output.on("close", this.onClose);
  }
  get isClosed(): boolean { return this.stopped; }
  /** A disposable SDK sibling may do exactly one delivered, value-free discovery and nothing else. */
  get isDisposableDiscoveryProbe(): boolean {
    return this.framesReceived === 1 && this.discoveryProbeCandidate && this.discoveryProbeDelivered && this.pending.size === 0;
  }
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.ownsCapability) this.#gateway.revokeCapability(this.#capability);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.targets.clear();
    this.replayReceipts.clear();
    this.input.off("data", this.onData);
    this.input.off("end", this.onEnd);
    this.input.off("close", this.onClose);
    // Keep error handlers attached to swallow transport failures after shutdown; no raw error is logged.
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.responded = true;
      request.controller.abort();
    }
    clearTimeout(this.stallTimer);
    const delivery = this.delivery;
    this.delivery = null;
    delivery?.settle(false);
    for (const queued of this.deliveries.splice(0)) queued.settle(false);
    this.queuedBytes = 0;
    if (!this.output.destroyed && !this.output.writableEnded) this.output.end();
    this.notifyDrained();
  }
  /** May remain pending for an adapter that ignores abort. It is evidence of effects settling, not a timeout. */
  whenDrained(): Promise<void> {
    if (this.pending.size === 0 && this.queuedBytes === 0) return Promise.resolve();
    return new Promise(resolve => this.drainWaiters.push(resolve));
  }
  private notifyDrained(): void {
    if (this.pending.size === 0 && this.queuedBytes === 0) for (const resolve of this.drainWaiters.splice(0)) resolve();
  }
  private readonly onClose = (): void => { this.close(); };
  private readonly onEnd = (): void => {
    if (this.fragmentBytes > 0) this.error(null, -32700, "Parse error");
    this.close();
  };
  private readonly onData = (value: Buffer | string): void => {
    if (this.stopped) return;
    const chunk = typeof value === "string" ? Buffer.from(value) : value;
    let start = 0;
    while (start < chunk.length && !this.stopped) {
      // Even an incomplete second frame consumes the session. Never permit an effect/invalid frame to be
      // followed by a successful discover and then interpreted as a harmless disposable probe at EOF.
      if (this.framesReceived > 0) this.discoveryProbeCandidate = false;
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const length = end - start;
      if (this.fragmentBytes + length > this.lineLimit) {
        this.error(null, -32700, "Message too large");
        this.close();
        return;
      }
      if (length > 0) this.fragments.push(Buffer.from(chunk.subarray(start, end)));
      this.fragmentBytes += length;
      if (newline < 0) return;
      const frame = Buffer.concat(this.fragments, this.fragmentBytes);
      this.fragments = [];
      this.fragmentBytes = 0;
      this.frame(frame);
      start = newline + 1;
    }
  };
  private frame(bytes: Buffer): void {
    this.framesReceived++;
    this.discoveryProbeCandidate = false;
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { this.error(null, -32700, "Parse error"); return; }
    if (!object(raw) || raw.jsonrpc !== "2.0" || typeof raw.method !== "string"
      || !exact(raw, ["jsonrpc", "id", "method", "params"]) || (raw.params !== undefined && !object(raw.params))) {
      this.error(null, -32600, "Invalid Request"); return;
    }
    if (!Object.hasOwn(raw, "id")) { this.notification(raw.method, raw.params as ObjectValue | undefined); return; }
    if (!idOk(raw.id)) { this.error(null, -32600, "Invalid Request"); return; }
    const meta = object(raw.params) && object(raw.params._meta) ? raw.params._meta : null;
    this.discoveryProbeCandidate = this.framesReceived === 1 && bytes.length <= 4096 && raw.method === "server/discover"
      && object(raw.params) && exact(raw.params, ["_meta"]) && meta !== null
      && exact(meta, ["io.modelcontextprotocol/protocolVersion", "io.modelcontextprotocol/clientInfo", "io.modelcontextprotocol/clientCapabilities"])
      && meta["io.modelcontextprotocol/protocolVersion"] === MCP_MODERN_VERSION;
    const id = raw.id;
    const key = keyOf(id);
    if (this.pending.has(key)) { this.error(null, -32600, "Duplicate request id"); return; }
    if ([...this.pending.values()].filter(request => request.executing).length >= this.inFlightLimit) { this.error(id, -32001, "Too many requests"); return; }
    // Reserve a full response frame BEFORE any upstream effect. A second burst cannot execute against
    // capacity already occupied by the first burst's undelivered receipts. One frame remains for control errors.
    if (this.queuedBytes + this.readableOutputBytes() + this.reservedBytes + this.outputLimit > this.queueLimit - this.outputLimit + Math.min(4096, Math.floor(this.outputLimit / 2))) {
      this.error(id, -32001, "Response capacity unavailable"); return;
    }
    const controller = new AbortController();
    this.reservedBytes += this.outputLimit;
    const request: Pending = { controller, responded: false, executing: true, reservation: this.outputLimit, method: raw.method, timer: setTimeout(() => {
      if (request.responded || this.stopped) return;
      request.responded = true;
      controller.abort();
      if (request.method === "subscriptions/listen") {
        void this.send({ jsonrpc: "2.0", id, result: { resultType: "complete", _meta: { "io.modelcontextprotocol/subscriptionId": id } } });
        return;
      }
      if(request.outcome)void this.send({jsonrpc:"2.0",id,result:{content:[{type:"text",text:"Receipt pending. Consult the exact action; approved host work may continue and its receipt is delivered by host continuation."}],
        structuredContent:{actionId:request.outcome.actionId,requestHash:request.outcome.requestHash,status:"pending",result:null,hostContinuation:true},isError:false}});
      else this.error(id, -32002, "Request timed out; consult the recorded receipt. Approved host work may continue.");
      // Keep the slot occupied until the underlying effect settles. Never start replacement work automatically.
    }, raw.method === "subscriptions/listen" ? 300_000 : this.timeoutMs) };
    this.pending.set(key, request);
    const finish = (response: unknown, succeeded = false): void => {
      const respond = !request.responded && !this.stopped;
      request.executing = false;
      this.reservedBytes -= request.reservation;
      request.reservation = 0;
      request.responded = true;
      clearTimeout(request.timer);
      const release = (): void => {
        this.pending.delete(key);
        this.notifyDrained();
      };
      if (respond) void this.send(response, delivered=>{
        if (delivered && succeeded && this.discoveryProbeCandidate) this.discoveryProbeDelivered = true;
        if(delivered && request.acknowledge){try{request.acknowledge();}catch{/* Receipt stays recoverable if writer/origin changed. */}}
        release();
      });
      else release();
    };
    void this.execute(raw.method, raw.params as ObjectValue | undefined, controller.signal,acknowledge=>{request.acknowledge=acknowledge;},outcome=>{request.outcome=outcome;},id).then(result => {
      finish({ jsonrpc: "2.0", id, result }, true);
    }, error => {
      const fault = error instanceof RpcFault || error instanceof McpProtocolError ? { code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) } : { code: -32603, message: "Internal error" };
      finish({ jsonrpc: "2.0", id, error: fault });
    });
  }
  private notification(method: string, params: ObjectValue | undefined): void {
    if (method === "notifications/initialized" && this.phase === "initializing" && paramsOk(params, [])) {
      this.phase = "ready";
    } else if (method === "notifications/cancelled" && params && paramsOk(params, ["requestId", "reason"]) && idOk(params.requestId)) {
      const request = this.pending.get(keyOf(params.requestId));
      // Initialize cannot be cancelled (MCP lifecycle). Untrusted cancellation reason is ignored.
      if (request && request.method !== "initialize") {
        request.responded = true;
        clearTimeout(request.timer);
        request.controller.abort();
      }
    }
    // Unknown notifications have no response; no arbitrary payload is retained or logged.
  }
  private async execute(method: string, params: ObjectValue | undefined, signal: AbortSignal,acknowledge:(callback:()=>void)=>void,pending:(outcome:GatewayCallResult)=>void, rpcId: RpcId): Promise<unknown> {
    if (params && Object.hasOwn(params, "_meta") && !object(params._meta)) invalid();
    const metadata = modernMetadata(params);
    const complete = (value: Record<string, unknown>): Record<string, unknown> => metadata.modern ? { resultType: "complete", ...value } : value;
    if (method === "server/discover") {
      if (!metadata.modern || !paramsOk(params, [])) invalid();
      this.#gateway.listTools(this.#capability); // Validate authority even for a metadata-only discovery.
      return { resultType: "complete", supportedVersions: [...MCP_SUPPORTED_VERSIONS], _meta: { "io.modelcontextprotocol/serverInfo": { name: "dexter-gateway", version: "0.0.2" } }, capabilities: { tools: { listChanged: true } }, ttlMs: 0, cacheScope: "private" };
    }
    if (method === "initialize") {
      if (metadata.modern) throw new RpcFault(-32601, "Method not found");
      if (this.phase !== "new") throw new RpcFault(-32600, "Already initialized");
      if (!params || typeof params.protocolVersion !== "string" || !object(params.capabilities) || !object(params.clientInfo)
        || typeof params.clientInfo.name !== "string" || typeof params.clientInfo.version !== "string") invalid();
      this.phase = "initializing";
      return { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "dexter-gateway", version: "0.0.2" },
        instructions: this.settleApproval
          ? "Use a stable callId. The host waits for the owner decision and returns the exact tool receipt in this call; do not repeat a pending request. Unknown outcomes must not be repeated with a new callId."
          : "Use a stable callId and identical input to poll approval or replay an outcome. Unknown outcomes must not be repeated with a new callId." };
    }
    if (method === "ping") { if (!paramsOk(params, [])) invalid(); this.#gateway.listTools(this.#capability); return complete({}); }
    if (!metadata.modern && this.phase !== "ready") throw new RpcFault(-32000, "Initialization required");
    if (method === "subscriptions/listen") {
      if (!metadata.modern || !params || !paramsOk(params, ["notifications"]) || !object(params.notifications)) invalid();
      const filter = params!.notifications as ObjectValue;
      if (!exact(filter, ["toolsListChanged", "promptsListChanged", "resourcesListChanged", "resourceSubscriptions"])) invalid();
      for (const name of ["toolsListChanged", "promptsListChanged", "resourcesListChanged"]) if (filter[name] !== undefined && typeof filter[name] !== "boolean") invalid();
      if (filter.resourceSubscriptions !== undefined && (!Array.isArray(filter.resourceSubscriptions) || filter.resourceSubscriptions.length > 32 || !filter.resourceSubscriptions.every(value => typeof value === "string" && value.length <= 2048))) invalid();
      let fingerprint = this.subscriptionFingerprint();
      const subscriptionMeta = { "io.modelcontextprotocol/subscriptionId": rpcId };
      await this.send({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { _meta: subscriptionMeta, notifications: filter.toolsListChanged === true ? { toolsListChanged: true } : {} } });
      while (!signal.aborted && !this.stopped) {
        await new Promise<void>(resolve => { const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }; const timer = setTimeout(done, 250); signal.addEventListener("abort", done, { once: true }); if (signal.aborted) done(); });
        if (signal.aborted || this.stopped) break;
        const next = this.subscriptionFingerprint();
        if (next !== fingerprint) { fingerprint = next; if (filter.toolsListChanged === true) await this.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { _meta: subscriptionMeta } }); }
      }
      return complete({ _meta: subscriptionMeta });
    }
    if (method === "tools/list") {
      if (!paramsOk(params, [])) invalid();
      return complete({ tools: this.catalog(), ...(metadata.modern ? { ttlMs: 0, cacheScope: "private" } : {}) });
    }
    if (method !== "tools/call") throw new RpcFault(-32601, "Method not found");
    let currentCatalogChecked = false;
    let retainedReplay: Readonly<ReplayReceipt> | undefined;
    if (params && typeof params.name === "string" && MCP_DIRECTORY_ALIASES.includes(params.name as typeof MCP_DIRECTORY_ALIASES[number])) {
      if (!paramsOk(params, ["name", "arguments"]) || !object(params.arguments)) invalid();
      const args = params.arguments as ObjectValue;
      const views = this.currentViews();
      currentCatalogChecked = true;
      if (params.name === MCP_DIRECTORY_ALIASES[0]) {
        if (!exact(args, ["query", "limit"]) || typeof args.query !== "string" || (args.limit !== undefined && (typeof args.limit !== "number" || !Number.isSafeInteger(args.limit)))) invalid();
        let entries: Record<string, unknown>[]; try { entries = searchCatalog(views, args.query as string, args.limit as number | undefined); } catch { return invalid(); }
        return complete({ content: [{ type: "text", text: JSON.stringify({ tools: entries }) }], structuredContent: { tools: entries }, isError: false });
      }
      if (typeof args.alias !== "string" || !/^dx_[a-f0-9]{24}$/.test(args.alias)) invalid();
      const view = views.find(item => gatewayToolAlias(item) === args.alias);
      if (params.name === MCP_DIRECTORY_ALIASES[1]) {
        if (!view) throw new RpcFault(-32602, "Unknown tool");
        if (!exact(args, ["alias"])) invalid();
        const tool = { ...projectCatalogTool(view), ...(view.outputSchema ? { upstreamOutputSchema: view.outputSchema } : {}) };
        return complete({ content: [{ type: "text", text: JSON.stringify(tool) }], structuredContent: tool, isError: false });
      }
      if (!exact(args, ["alias", "callId", "input"]) || typeof args.callId !== "string" || !object(args.input)) invalid();
      if (!view) {
        // Metadata remains current-only. A removed alias can reach only a terminal request observed
        // on this bridge, with the same callId and canonical input. This evidence grants no new work.
        retainedReplay = this.replayReceipts.get(this.replayKey(args.alias as string, args.callId as string, args.input as ObjectValue));
        if (!this.targets.has(args.alias as string) || !retainedReplay) throw new RpcFault(-32602, "Unknown tool");
      }
      params = { ...params, name: args.alias, arguments: { callId: args.callId, input: args.input } };
    }
    if (!params || !paramsOk(params, ["name", "arguments"]) || typeof params.name !== "string" || !object(params.arguments)
      || !exact(params.arguments, ["callId", "input"]) || typeof params.arguments.callId !== "string" || !object(params.arguments.input)) return invalid();
    const name = params.name as string;
    // Directory dispatch already checked the same synchronous current inventory above. The eventual
    // surface.call still performs its own live scope/grant/pin checks immediately before admission.
    if (!currentCatalogChecked) this.currentViews();
    const target = this.targets.get(name);
    if (!target) throw new RpcFault(-32602, "Unknown tool");
    let admitted: GatewayCallResult | undefined;
    try {
      const input = { ...target, callId: params.arguments.callId, arguments: params.arguments.input };
      let outcome = await this.#gateway.call(this.#capability, input, { signal });
      if (retainedReplay) {
        // The live surface still validates the original capability and owns canonical receipt lookup.
        // Never return a cached body or run approval/continuation work for a terminal fallback.
        if (outcome.actionId !== retainedReplay.actionId || outcome.requestHash !== retainedReplay.requestHash || outcome.status !== retainedReplay.status)
          throw new GatewayError("conflict", "Retained receipt changed.");
        outcome = { ...outcome, result: null };
      }
      admitted = outcome;
      pending(outcome);
      if (!retainedReplay) {
        this.rememberReplay(name, params.arguments.callId as string, params.arguments.input as ObjectValue, outcome);
        if (this.settleApproval) outcome = await this.settleApproval(input, outcome, signal);
        this.rememberReplay(name, params.arguments.callId as string, params.arguments.input as ObjectValue, outcome);
      }
      const delivered=outcome;
      // A retained terminal reply is a disclosure-limited projection of a delivery that already
      // happened. A second ACK would persist that projection (result:null) over the original body.
      if(!retainedReplay && this.acknowledgeToolResult)acknowledge(()=>this.acknowledgeToolResult!(input,delivered));
      const result = await this.callResult(outcome);
      return metadata.modern ? { resultType: "complete", ...result } : result;
    } catch (error) {
      // Gateway/host errors never include raw data, secret values, upstream errors or caller-selected keys.
      const code = error instanceof GatewayError ? error.code : "unavailable";
      const diagnostic = error instanceof GatewayError ? readMcpSetupDiagnostic(error.diagnostic) : null;
      const failure = admitted ? { outcome: "unknown_after_admission", code, actionId: admitted.actionId, requestHash: admitted.requestHash, status: admitted.status, consultReceipt: true }
        : { outcome: error instanceof GatewayError && error.code !== "unavailable" ? "refused_before_admission" : "admission_not_confirmed", code, ...(diagnostic ? { diagnostic } : {}) };
      return complete({ content: [{ type: "text", text: JSON.stringify(failure) }], structuredContent: failure, isError: true });
    }
  }
  private replayKey(alias: string, callId: string, input: ObjectValue): string {
    return createHash("sha256").update(canonicalJson({ alias, callId, input } as JsonValue)).digest("hex");
  }
  private rememberReplay(alias: string, callId: string, input: ObjectValue, outcome: GatewayCallResult): void {
    if (this.stopped || !["succeeded", "unknown"].includes(outcome.status)) return;
    const key = this.replayKey(alias, callId, input);
    if (this.replayReceipts.has(key) || this.replayReceipts.size >= REPLAY_RECEIPT_LIMIT) return;
    this.replayReceipts.set(key, Object.freeze({ actionId: outcome.actionId, requestHash: outcome.requestHash, status: outcome.status as ReplayReceipt["status"] }));
  }
  private catalog(): unknown[] {
    const tools = this.currentViews();
    const plan = planCatalogExposure(tools, { tokenBudget: this.catalogTokenBudget, maxTools: this.catalogLimit, pinnedAliases: this.pinnedAliases, pinnedToolNames: this.pinnedToolNames });
    return [...plan.direct.map(projectCatalogTool), ...directoryToolDefinitions()];
  }
  private subscriptionFingerprint(): string {
    const now = Date.now();
    // A hint can lag one second; cached metadata never authorizes a tool or returns a schema.
    if (!this.notificationPolledAt || now - this.notificationPolledAt >= 1000) {
      // Fingerprint all eligible metadata, including deferred bindings, without rerunning the direct
      // schema planner. Keep only a digest; neither this hint nor its one-second cache authorizes calls.
      const digest = createHash("sha256");
      for (const view of this.currentViews()) digest.update(JSON.stringify(view)).update("\n");
      this.notificationFingerprint = digest.digest("hex");
      this.notificationPolledAt = now;
    }
    return this.notificationFingerprint;
  }
  private currentViews(): ToolView[] {
    const tools = this.#gateway.listTools(this.#capability);
    // Full permitted inventory is bounded separately from token-based direct exposure.
    if (tools.length > MCP_AUTHORIZED_INVENTORY_LIMIT) throw new RpcFault(-32001, "Tool catalog limit exceeded");
    const current = new Map<string, Target>();
    for (const view of tools) {
      const name = gatewayToolAlias(view);
      const previous = this.targets.get(name);
      if (previous && (previous.tool !== view.name || previous.connectionId !== view.connectionId)) {
        throw new RpcFault(-32001, "Tool alias collision");
      }
      if (current.has(name)) throw new RpcFault(-32001, "Tool alias collision");
      current.set(name, { tool: view.name, connectionId: view.connectionId });
    }
    // Retain immutable old bindings solely so the host may reconcile the original receipt after revocation.
    // Every call still traverses the gateway, which refuses new actions without a current effective grant.
    if (new Set([...this.targets.keys(), ...current.keys()]).size > MCP_AUTHORIZED_INVENTORY_LIMIT) throw new RpcFault(-32001, "Tool catalog limit exceeded");
    for (const [name, target] of current) this.targets.set(name, target);
    return tools;
  }
  private callResult(outcome: GatewayCallResult) {
    // Reserve the largest ID, frame metadata and newline before evaluating the output budget.
    return projectMcpOutcome(outcome, { maxBytes: this.outputLimit - 512, maxTokens: this.outputTokens, maxBlocks: this.contentBlocks, multimodal: this.multimodal }, this.artifactSink);
  }
  private error(id: RpcId | null, code: number, message: string): void { void this.send({ jsonrpc: "2.0", id, error: { code, message } }); }
  private send(value: unknown, onDelivered: (delivered:boolean) => void = () => {}): Promise<void> {
    if (this.stopped) { onDelivered(false); return Promise.resolve(); }
    let frame: string;
    try { frame = `${JSON.stringify(value)}\n`; } catch { this.close(); onDelivered(false); return Promise.resolve(); }
    if (Buffer.byteLength(frame) > this.outputLimit) {
      // Oversized projection is not queue pressure or a capability failure. Keep the channel alive.
      const id = object(value) && (idOk(value.id) || value.id === null) ? value.id : null;
      frame = `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32003, message: "Response too large" } })}\n`;
    }
    const bytes = Buffer.byteLength(frame);
    if (this.queuedBytes + this.readableOutputBytes() + this.reservedBytes + bytes > this.queueLimit || this.deliveries.length >= this.inFlightLimit * 2 + 128) {
      this.close(); onDelivered(false); return Promise.resolve();
    }
    return new Promise(resolve => {
      let settled = false;
      const settle = (delivered:boolean): void => { if (!settled) { settled = true; onDelivered(delivered); resolve(); } };
      this.deliveries.push({ frame, bytes, settle });
      this.queuedBytes += bytes;
      this.deliverNext();
    });
  }
  private readableOutputBytes(): number {
    return "readableLength" in this.output && typeof this.output.readableLength === "number" ? this.output.readableLength : 0;
  }
  private deliverNext(): void {
    if (this.stopped || this.delivery) return;
    const delivery = this.deliveries.shift();
    if (!delivery) { this.notifyDrained(); return; }
    this.delivery = delivery;
    this.stallTimer = setTimeout(() => {
      // A stream whose write callback never completes cannot retain the host indefinitely for delivery.
      this.close();
      this.output.destroy();
    }, this.stallMs);
    try {
      this.output.write(delivery.frame, error => {
        if (this.delivery !== delivery) return; // close already settled/discarded this delivery
        clearTimeout(this.stallTimer);
        this.delivery = null;
        this.queuedBytes -= delivery.bytes;
        if (error) this.close();
        delivery.settle(!error && !this.stopped); // release the request slot before client follow-up can run
        this.deliverNext();
        this.notifyDrained();
      });
    } catch {
      this.close();
    }
  }
}
