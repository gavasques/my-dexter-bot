import { createHash } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { GatewayError } from "./errors.js";
import { readMcpSetupDiagnostic } from "@dexter/contracts";
import type { GatewayCallResult, ToolView } from "./gateway.js";
import type { TurnToolSurface } from "./surface.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25";
type RpcId = string | number;
type ObjectValue = Record<string, unknown>;
interface Pending { controller: AbortController; timer: ReturnType<typeof setTimeout>; responded: boolean; executing: boolean; reservation: number; method: string; acknowledge?:()=>void; outcome?:GatewayCallResult }
interface Delivery { frame: string; bytes: number; settle: (delivered:boolean) => void }
interface Target { tool: string; connectionId: string }
export interface GatewayMcpOptions {
  gateway: TurnToolSurface;
  /** Issued by the trusted host for this running turn; never passed in MCP params, argv or environment. */
  capability: string;
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
  maxCatalogTools?: number;
  /** Trusted host keeps the original RPC pending through approval and exact execution. */
  settleApproval?: (input: unknown, outcome: GatewayCallResult, signal: AbortSignal) => Promise<GatewayCallResult>;
  /** Called only after the response frame's output write acknowledges success. No inference ACK is implied. */
  acknowledgeToolResult?: (input:unknown,outcome:GatewayCallResult)=>void;
}
class RpcFault extends Error {
  constructor(readonly code: number, message: string) { super(message); }
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
 * close aborts outstanding work and revokes this bridge's capability. Host must await whenDrained before releasing
 * its writer lease: cancellation cannot undo a dispatched upstream effect or stop an uncooperative adapter.
 */
export class GatewayMcpBridge {
  readonly #gateway: TurnToolSurface;
  readonly #capability: string;
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
  private readonly settleApproval: GatewayMcpOptions["settleApproval"];
  private readonly acknowledgeToolResult:GatewayMcpOptions["acknowledgeToolResult"];
  private readonly pending = new Map<string, Pending>();
  private readonly targets = new Map<string, Target>();
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private phase: "new" | "initializing" | "ready" = "new";
  private stopped = false;
  private readonly drainWaiters: Array<() => void> = [];
  constructor(options: GatewayMcpOptions) {
    this.#gateway = options.gateway;
    this.#capability = options.capability;
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
    this.settleApproval = options.settleApproval;
    this.acknowledgeToolResult=options.acknowledgeToolResult;
    // Validate the host-issued scope immediately. No capability material is serialized by this class.
    this.#gateway.listTools(this.#capability);
    this.input.on("data", this.onData);
    this.input.on("end", this.onEnd);
    this.input.on("close", this.onClose);
    this.input.on("error", this.onClose);
    this.output.on("error", this.onClose);
    this.output.on("close", this.onClose);
  }
  get isClosed(): boolean { return this.stopped; }
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.#gateway.revokeCapability(this.#capability);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.targets.clear();
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
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { this.error(null, -32700, "Parse error"); return; }
    if (!object(raw) || raw.jsonrpc !== "2.0" || typeof raw.method !== "string"
      || !exact(raw, ["jsonrpc", "id", "method", "params"]) || (raw.params !== undefined && !object(raw.params))) {
      this.error(null, -32600, "Invalid Request"); return;
    }
    if (!Object.hasOwn(raw, "id")) { this.notification(raw.method, raw.params as ObjectValue | undefined); return; }
    if (!idOk(raw.id)) { this.error(null, -32600, "Invalid Request"); return; }
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
      if(request.outcome)void this.send({jsonrpc:"2.0",id,result:{content:[{type:"text",text:"Receipt pending. Consult the exact action; approved host work may continue and its receipt is delivered by host continuation."}],
        structuredContent:{actionId:request.outcome.actionId,requestHash:request.outcome.requestHash,status:"pending",result:null,hostContinuation:true},isError:false}});
      else this.error(id, -32002, "Request timed out; consult the recorded receipt. Approved host work may continue.");
      // Keep the slot occupied until the underlying effect settles. Never start replacement work automatically.
    }, this.timeoutMs) };
    this.pending.set(key, request);
    const finish = (response: unknown): void => {
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
        if(delivered && request.acknowledge){try{request.acknowledge();}catch{/* Receipt stays recoverable if writer/origin changed. */}}
        release();
      });
      else release();
    };
    void this.execute(raw.method, raw.params as ObjectValue | undefined, controller.signal,acknowledge=>{request.acknowledge=acknowledge;},outcome=>{request.outcome=outcome;}).then(result => {
      finish({ jsonrpc: "2.0", id, result });
    }, error => {
      const fault = error instanceof RpcFault ? { code: error.code, message: error.message } : { code: -32603, message: "Internal error" };
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
  private async execute(method: string, params: ObjectValue | undefined, signal: AbortSignal,acknowledge:(callback:()=>void)=>void,pending:(outcome:GatewayCallResult)=>void): Promise<unknown> {
    if (params && Object.hasOwn(params, "_meta") && !object(params._meta)) invalid();
    if (method === "initialize") {
      if (this.phase !== "new") throw new RpcFault(-32600, "Already initialized");
      if (!params || typeof params.protocolVersion !== "string" || !object(params.capabilities) || !object(params.clientInfo)
        || typeof params.clientInfo.name !== "string" || typeof params.clientInfo.version !== "string") invalid();
      this.phase = "initializing";
      return { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "dexter-gateway", version: "0.0.1" },
        instructions: this.settleApproval
          ? "Use a stable callId. The host waits for the owner decision and returns the exact tool receipt in this call; do not repeat a pending request. Unknown outcomes must not be repeated with a new callId."
          : "Use a stable callId and identical input to poll approval or replay an outcome. Unknown outcomes must not be repeated with a new callId." };
    }
    if (method === "ping") { if (!paramsOk(params, [])) invalid(); return {}; }
    if (this.phase !== "ready") throw new RpcFault(-32000, "Initialization required");
    if (method === "tools/list") {
      if (!paramsOk(params, [])) invalid();
      return { tools: this.catalog() };
    }
    if (method !== "tools/call") throw new RpcFault(-32601, "Method not found");
    if (!params || !paramsOk(params, ["name", "arguments"]) || typeof params.name !== "string" || !object(params.arguments)
      || !exact(params.arguments, ["callId", "input"]) || typeof params.arguments.callId !== "string" || !object(params.arguments.input)) return invalid();
    const name = params.name as string;
    if (!this.targets.has(name)) this.catalog();
    const target = this.targets.get(name);
    if (!target) throw new RpcFault(-32602, "Unknown tool");
    try {
      const input = { ...target, callId: params.arguments.callId, arguments: params.arguments.input };
      let outcome = await this.#gateway.call(this.#capability, input, { signal });
      pending(outcome);
      if (this.settleApproval) outcome = await this.settleApproval(input, outcome, signal);
      const delivered=outcome;
      if(this.acknowledgeToolResult)acknowledge(()=>this.acknowledgeToolResult!(input,delivered));
      return this.callResult(outcome);
    } catch (error) {
      // Gateway/host errors never include raw data, secret values, upstream errors or caller-selected keys.
      const code = error instanceof GatewayError ? error.code : "unavailable";
      const diagnostic = error instanceof GatewayError ? readMcpSetupDiagnostic(error.diagnostic) : null;
      return { content: [{ type: "text", text: diagnostic ? JSON.stringify({ outcome: "refused_before_admission", code, diagnostic }) : `Gateway call refused: ${code}` }],
        ...(diagnostic ? { structuredContent: { outcome: "refused_before_admission", code, diagnostic } } : {}), isError: true };
    }
  }
  private catalog(): unknown[] {
    const tools = this.#gateway.listTools(this.#capability);
    if (tools.length > this.catalogLimit) throw new RpcFault(-32001, "Tool catalog limit exceeded");
    return tools.map(view => {
      const name = alias(view);
      if (!this.targets.has(name) && this.targets.size >= this.catalogLimit) throw new RpcFault(-32001, "Tool catalog limit exceeded");
      const previous = this.targets.get(name);
      if (previous && (previous.tool !== view.name || previous.connectionId !== view.connectionId)) {
        throw new RpcFault(-32001, "Tool alias collision");
      }
      this.targets.set(name, { tool: view.name, connectionId: view.connectionId });
      return { name, title: `${view.name} (${view.connectionLabel})`, description: `Account: ${view.connectionLabel}. Connection: ${connectionTag(view.connectionId)}. ${view.description}`,
        inputSchema: { type: "object", additionalProperties: false, required: ["callId", "input"], properties: {
          callId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", maxLength: 128 }, input: view.inputSchema,
        } }, annotations: { readOnlyHint: view.effect === "read", destructiveHint: view.effect === "write", idempotentHint: true, openWorldHint: true } };
    });
  }
  private callResult(outcome: GatewayCallResult): unknown {
    const commandFailed=outcome.result!==null && typeof outcome.result==="object" && !Array.isArray(outcome.result)
      && ["interrupted","failed","not_started"].includes(String(outcome.result.commandOutcome));
    const response = (safe: GatewayCallResult) => ({ content: [{ type: "text", text: JSON.stringify(safe) }], structuredContent: safe,
      isError: commandFailed || ["denied", "blocked", "unknown"].includes(safe.status) });
    const full = response(outcome);
    // Reserve the largest accepted JSON-RPC ID. A large stored receipt remains succeeded/replayable:
    // omit only its payload from this transport projection, never revoke authority or repeat its effect.
    if (Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: "x".repeat(128), result: full })) + 1 <= this.outputLimit) return full;
    return response({ ...outcome, result: { omitted: "mcp_result_too_large" } });
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
function alias(view: ToolView): string {
  return `dx_${createHash("sha256").update(`${view.name}\u0000${view.connectionId}`).digest("hex").slice(0, 24)}`;
}

function connectionTag(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}
