import { chmodSync, lstatSync, mkdtempSync, renameSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import type { HostStore } from "@dexter/hub";
import type { JsonValue } from "@dexter/contracts";
import { GatewayError } from "./errors.js";
import type { CapabilityScope, GatewayCallResult } from "./gateway.js";
import type { TurnToolSurface } from "./surface.js";
import { GatewayMcpBridge, type GatewayMcpOptions } from "./mcp.js";
import { gatewayToolAlias, MCP_DIRECTORY_ALIASES, planCatalogExposure } from "./catalog.js";

export const MCP_SERVER_NAME = "dexter_gateway";
export interface McpTurnOptions {
  store: HostStore;
  gateway: TurnToolSurface;
  /** Already claimed running by the host. All identity is read from the canonical store. */
  turnId: string;
  /** Absolute compiled wrapper file. The child receives only this path and the Unix socket path. */
  wrapperPath: string;
  signal?: AbortSignal;
  bridgeLimits?: Pick<GatewayMcpOptions, "maxLineBytes" | "maxOutputBytes" | "maxInFlight" | "requestTimeoutMs" | "maxCatalogTools" | "maxQueuedOutputBytes" | "outputStallTimeoutMs" | "catalogTokenBudget" | "pinnedAliases" | "pinnedToolNames" | "maxOutputTokens" | "maxContentBlocks" | "multimodalResults">;
  artifactSink?: GatewayMcpOptions["artifactSink"];
}
export interface NativeMcpServer {
  readonly command: string;
  readonly args: readonly string[];
}
interface OwnedPath { path: string; inode: number; device: number; kind: "file" | "socket" | "directory" }
const own = (path: string, kind: OwnedPath["kind"]): OwnedPath => {
  const stat = lstatSync(path);
  const expectedType = kind === "directory" ? stat.isDirectory() : kind === "socket" ? stat.isSocket() : stat.isFile();
  if (!expectedType || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw new GatewayError("unavailable", "private MCP resource unavailable");
  return { path, inode: stat.ino, device: stat.dev, kind };
};
const same = (stat: Stats, item: OwnedPath): boolean => stat.ino === item.inode && stat.dev === item.device && !stat.isSymbolicLink()
  && (item.kind === "directory" ? stat.isDirectory() : item.kind === "socket" ? stat.isSocket() : stat.isFile());

/**
 * One host-owned, one-turn MCP endpoint. Capability stays in process memory; the wrapper/config contain no
 * bearer token or upstream credential. Unix permissions bind the endpoint to the owner's OS account, not
 * a sandbox between trusted processes of that owner. The first admitted session consumes the endpoint forever.
 * SDK 2.3.1 may first open a disposable sibling for one value-free server/discover. Its completed EOF permits
 * exactly one replacement within five seconds; no other request, partial frame or effect permits reconnection.
 */
export class McpTurnLease {
  readonly scope: Readonly<CapabilityScope>;
  readonly configPath: string;
  readonly socketPath: string;
  readonly serverName = MCP_SERVER_NAME;
  readonly nativeServer: NativeMcpServer;
  readonly allowedMcpTools: readonly string[];
  private readonly server: Server;
  private readonly owned: OwnedPath[];
  readonly #gateway: TurnToolSurface;
  readonly #token: string;
  readonly #store: HostStore;
  private readonly bridgeLimits: McpTurnOptions["bridgeLimits"];
  private readonly artifactSink: GatewayMcpOptions["artifactSink"];
  #bridge: GatewayMcpBridge | null = null;
  private connection: Socket | null = null;
  private connected = false;
  private probeReplacementUsed = false;
  private probeReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private closeNetwork: Promise<void> = Promise.resolve();
  private draining: Promise<void> | null = null;
  private readonly signal: AbortSignal | undefined;
  private readonly abort = (): void => { this.stop(); };
  private constructor(options: McpTurnOptions, scope: CapabilityScope, token: string, paths: OwnedPath[], server: Server,
    socketPath: string, configPath: string, aliases: readonly string[]) {
    this.#gateway = options.gateway;
    this.#token = token;
    this.#store = options.store;
    this.scope = Object.freeze({ ...scope });
    this.owned = paths;
    this.server = server;
    this.socketPath = socketPath;
    this.configPath = configPath;
    this.nativeServer = Object.freeze({ command: process.execPath, args: Object.freeze([options.wrapperPath, socketPath]) });
    this.allowedMcpTools = Object.freeze(aliases.map(alias => `mcp__${MCP_SERVER_NAME}__${alias}`));
    this.bridgeLimits = { maxCatalogTools: 128, ...options.bridgeLimits };
    this.artifactSink = options.artifactSink;
    this.signal = options.signal;
  }
  static async prepare(options: McpTurnOptions): Promise<McpTurnLease> {
    if (process.platform === "win32" || !process.getuid) throw new GatewayError("unavailable", "local MCP requires POSIX Unix sockets");
    if (!isAbsolute(options.wrapperPath)) throw new GatewayError("invalid_input", "absolute MCP wrapper required");
    const paths: OwnedPath[] = [];
    let token: string | undefined;
    let lease: McpTurnLease | undefined;
    const server = createServer();
    try {
      const setup = options.store.withWriterLease(() => {
        if (options.signal?.aborted) throw new GatewayError("unauthorized", "turn aborted");
        const wrapper = lstatSync(options.wrapperPath);
        if (!wrapper.isFile() || wrapper.isSymbolicLink() || wrapper.uid !== process.getuid!() || (wrapper.mode & 0o022) !== 0) throw new GatewayError("invalid_input", "compiled MCP wrapper unavailable");
        const turn = options.store.getTurn(options.turnId);
        const bot = options.store.getBot(turn.botId);
        const thread = options.store.getThread(turn.threadId);
        if (turn.state !== "running" || thread.botId !== bot.id) throw new GatewayError("unauthorized", "running turn required");
        const issued = options.gateway.issueCapability({ turnId: turn.id });
        token = issued.token;
        const scope = issued.scope;
        if (scope.installationId !== options.store.hostId || scope.ownerId !== options.store.ownerId || scope.botId !== bot.id
          || scope.profileId !== bot.profileId || scope.threadId !== thread.id || scope.turnId !== turn.id) {
          throw new GatewayError("unauthorized", "gateway host scope mismatch");
        }
        const exposure = planCatalogExposure(options.gateway.listTools(issued.token), { maxTools: options.bridgeLimits?.maxCatalogTools ?? 128,
          ...(options.bridgeLimits?.catalogTokenBudget === undefined ? {} : { tokenBudget: options.bridgeLimits.catalogTokenBudget }),
          ...(options.bridgeLimits?.pinnedAliases === undefined ? {} : { pinnedAliases: options.bridgeLimits.pinnedAliases }),
          ...(options.bridgeLimits?.pinnedToolNames === undefined ? {} : { pinnedToolNames: options.bridgeLimits.pinnedToolNames }) });
        const aliases = [...MCP_DIRECTORY_ALIASES, ...exposure.direct.map(gatewayToolAlias)];
        if (new Set(aliases).size !== aliases.length) throw new GatewayError("conflict", "MCP alias collision");
        // Short path works within Darwin/Linux Unix socket path limits. No caller-selected parent directory.
        const dir = mkdtempSync("/tmp/dx-mcp-");
        chmodSync(dir, 0o700); paths.push(own(dir, "directory"));
        const socketPath = join(dir, "m.sock"); const configPath = join(dir, "mcp.json");
        writeFileSync(configPath, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: "stdio", command: process.execPath, args: [options.wrapperPath, socketPath] } } }), { flag: "wx", mode: 0o600 });
        paths.push(own(configPath, "file"));
        return { scope, socketPath, bindPath: join(dir, "b.sock"), configPath, aliases };
      });
      lease = new McpTurnLease(options, setup.scope, token!, paths, server, setup.socketPath, setup.configPath, setup.aliases);
      server.on("connection", socket => lease!.accept(socket));
      await new Promise<void>((resolve, reject) => {
        const failed = (): void => { server.off("listening", listening); reject(new GatewayError("unavailable", "local MCP endpoint unavailable")); };
        const listening = (): void => { server.off("error", failed); resolve(); };
        server.once("error", failed); server.once("listening", listening);
        server.listen(setup.bindPath);
      });
      options.store.withWriterLease(() => {
        if (options.signal?.aborted || options.store.getTurn(options.turnId).state !== "running") throw new GatewayError("unauthorized", "running turn required");
        chmodSync(setup.bindPath, 0o600); paths.push(own(setup.bindPath, "socket"));
        // libuv closes/unlinks the original bind name, never the published endpoint.
        renameSync(setup.bindPath, setup.socketPath);
        paths[paths.length - 1] = { ...paths[paths.length - 1]!, path: setup.socketPath };
        // Revalidate the original capability after the asynchronous listen, before handing configuration to a driver.
        options.gateway.listTools(token!);
      });
      server.on("error", lease.abort);
      options.signal?.addEventListener("abort", lease.abort, { once: true });
      if (options.signal?.aborted) lease.stop();
      return lease;
    } catch (error) {
      if (lease) { lease.stop(); await lease.whenDrained(); }
      else {
        if (token) options.gateway.revokeCapability(token);
        cleanup(paths);
      }
      if (error instanceof GatewayError || (error instanceof Error && "code" in error && error.code === "host_locked")) throw error;
      throw new GatewayError("unavailable", "local MCP setup failed");
    }
  }
  /** Safe host diagnostic/config projection. Never serialize private capability or gateway objects. */
  toJSON(): object {
    return { configPath: this.configPath, socketPath: this.socketPath, serverName: this.serverName,
      nativeServer: this.nativeServer, allowedMcpTools: this.allowedMcpTools, isStopped: this.stopped };
  }
  get isStopped(): boolean { return this.stopped; }
  private accept(socket: Socket): void {
    socket.on("error", () => {});
    if (this.stopped || this.connected) { socket.destroy(); return; }
    this.connected = true;
    this.connection = socket;
    clearTimeout(this.probeReconnectTimer);
    this.probeReconnectTimer = undefined;
    try {
      // The lease owns the ORIGINAL bearer/expiry/target snapshot throughout this bounded negotiation.
      // Reissuing would extend wall-clock expiry or refresh facade targets. Revalidate the same authority;
      // any ordinary session close synchronously stops/revokes it, without permitting effect retries.
      this.#store.withWriterLease(() => {
        this.#gateway.listTools(this.#token);
      });
      const bridge = new GatewayMcpBridge({ gateway: this.#gateway, capability: this.#token, capabilityOwner: "host_lease", input: socket, output: socket,
        requestTimeoutMs:290_000, ...this.bridgeLimits, ...(this.artifactSink ? { artifactSink: this.artifactSink, artifactScope: this.scope } : {}), settleApproval:this.settleApproval,acknowledgeToolResult:this.acknowledgeToolResult });
      this.#bridge = bridge;
      let retired = false;
      const retire = (): void => {
        if (retired) return;
        retired = true;
        if (!this.stopped && !this.probeReplacementUsed && bridge.isDisposableDiscoveryProbe) {
          this.probeReplacementUsed = true;
          this.connected = false;
          this.connection = null;
          socket.destroy();
          this.probeReconnectTimer = setTimeout(this.abort, 5_000);
        } else this.stop();
      };
      // The bridge's end handler was registered first. At EOF its work is aborted/closed already; revoke
      // ordinary sessions synchronously instead of waiting for a stalled output peer's final close.
      socket.once("end", retire);
      socket.once("close", retire);
    } catch {
      socket.destroy(); this.stop();
    }
  }
  private readonly settleApproval = async (input: unknown, outcome: GatewayCallResult, signal: AbortSignal): Promise<GatewayCallResult> => {
    const call=input as {callId:string;tool:string;connectionId:string;arguments:JsonValue};
    // Read-only facade results have no action row. They never enter the approval lifecycle.
    try { this.#store.getAction(outcome.actionId); }
    catch (error) { if (error instanceof Error && "code" in error && error.code==="not_found") return outcome; throw error; }
    const origin=this.#store.toolActionOrigin(outcome.actionId);
    const ancestral=this.#store.replayedContinuationAction(this.scope.turnId,call.tool,call.connectionId,call.arguments);
    const receiptReplay=origin?.continuationTurnId===this.scope.turnId || ancestral?.id===outcome.actionId;
    if(!receiptReplay)this.#store.bindToolAction(outcome.actionId,this.scope.turnId,call.callId);
    for (;;) {
      if (signal.aborted || this.stopped || this.#store.getTurn(this.scope.turnId).state!=="running")
        throw new GatewayError("unauthorized","Tool continuation stopped; consult the recorded receipt.");
      // The runtime schedules expiry by deadline. A bridge can also exist without a runtime;
      // expireApprovals is read-only when no approval is due.
      this.#store.expireApprovals();
      const action=this.#store.getAction(outcome.actionId);
      if (action.state==="ready") {
        outcome=await this.#gateway.call(this.#token,input,{signal});
      } else if (!["awaiting_approval","running"].includes(action.state)) {
        // Preserve the surface's disclosure policy. Reading the row directly must never reveal a withheld device body.
        if(action.state==="succeeded" && outcome.status!=="succeeded")outcome=await this.#gateway.call(this.#token,input,{signal});
        else outcome={...outcome,status:action.state,reason:action.reason,result:outcome.status===action.state?outcome.result:null};
        this.#store.recordToolEvent(this.scope.turnId,"tool.resolved",{actionId:action.id,state:action.state,code:action.reason});
        if(!receiptReplay)this.#store.recordToolOutcome(action.id,outcome.result);
        return outcome;
      }
      await new Promise<void>(resolve => {
        const done=():void=>{clearTimeout(timer);signal.removeEventListener("abort",done);resolve();};
        const timer=setTimeout(done,100);signal.addEventListener("abort",done,{once:true});
        if(signal.aborted)done();
      });
    }
  };
  private readonly acknowledgeToolResult=(_input:unknown,outcome:GatewayCallResult):void=>{
    const progress=this.#store.toolActionProgress(outcome.actionId);
    if(progress?.originTurnId===this.scope.turnId)this.#store.markToolResultDelivered(outcome.actionId,this.scope.turnId,outcome.result);
  };
  /** Synchronous revocation/stop accepting. Effects already dispatched may outlive the network. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.probeReconnectTimer);
    this.probeReconnectTimer = undefined;
    this.signal?.removeEventListener("abort", this.abort);
    this.#gateway.revokeCapability(this.#token);
    this.#bridge?.close();
    this.connection?.destroy();
    this.closeNetwork = new Promise(resolve => {
      try { this.server.close(() => resolve()); } catch { resolve(); }
    });
  }
  /** Stops if needed, waits for effects + delivery + listener closure, then removes only resources created by this lease. */
  whenDrained(): Promise<void> {
    this.stop();
    this.draining ??= Promise.all([this.closeNetwork, this.#bridge?.whenDrained() ?? Promise.resolve()]).then(() => { cleanup(this.owned); });
    return this.draining;
  }
}
function cleanup(paths: readonly OwnedPath[]): void {
  for (const item of [...paths].reverse()) {
    let stat: Stats;
    try { stat = lstatSync(item.path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw new GatewayError("unavailable", "MCP cleanup incomplete"); }
    if (!same(stat, item) || stat.uid !== process.getuid!()) throw new GatewayError("unavailable", "MCP cleanup resource changed");
    try { if (item.kind === "directory") rmdirSync(item.path); else unlinkSync(item.path); }
    catch { throw new GatewayError("unavailable", "MCP cleanup incomplete"); }
  }
}
export const prepareMcpTurn = (options: McpTurnOptions): Promise<McpTurnLease> => McpTurnLease.prepare(options);
