import { createHash } from "node:crypto";
import type { JsonValue } from "@dexter/contracts";
import type { AdapterCall, InjectedAuth, UpstreamAdapter } from "@dexter/gateway";
import { planMcpTools, type McpCatalogSource, type McpToolPlan } from "./catalog.js";
import { mcpAccountRef, mcpToolkit, serverIdOfHost, type McpServerDefinition, type McpServerSource } from "./definition.js";
import { McpConnectorError, type McpErrorCode } from "./errors.js";
import { McpUpstreamSession, placementAllowed, type McpCredential, type McpDiscoveredTool, type McpRuntimeHost } from "./session.js";

export interface McpAdapterOptions {
  servers: McpServerSource;
  catalog: McpCatalogSource;
  host: McpRuntimeHost;
}

interface Pooled { session: McpUpstreamSession; credentialHash: string }

const credentialHash = (credential: McpCredential): string =>
  createHash("sha256").update(JSON.stringify(Object.entries(credential).sort(([a], [b]) => (a < b ? -1 : 1)))).digest("hex");

/**
 * G3 UpstreamAdapter for native MCP servers. The gateway stays the only way in: it resolves the capability,
 * checks the manifest, connection and hub grant/approval, records the action, and releases the broker
 * credential for the connection's logical MCP host. This adapter then:
 *   - maps the logical host to the trusted inventory definition (the real command or URL is never in a call);
 *   - checks toolkit and account ref, and the catalog entry for the pinned slug and version;
 *   - renames arguments to upstream names (no other argument passes);
 *   - re-lists upstream tools and refuses if the tool's published definition no longer matches the pin;
 *   - calls the tool once, bounded and cancellable.
 * Sessions are pooled per gateway connection and restarted when the released credential changes. Any failure
 * after the request may have reached upstream throws, and the gateway records the action as unknown.
 */
export class McpToolAdapter implements UpstreamAdapter {
  private readonly servers: McpServerSource;
  private readonly catalog: McpCatalogSource;
  private readonly host: McpRuntimeHost;
  private readonly pool = new Map<string, Pooled>();
  private readonly opening = new Map<string, Promise<Pooled>>();
  private readonly circuits = new Map<string,{failures:number;until:number}>();
  private closed = false;

  constructor(options: McpAdapterOptions) {
    if (typeof options.servers?.get !== "function" || typeof options.catalog?.find !== "function") throw new McpConnectorError("invalid_definition", "adapter");
    if (options.host?.runsOn !== "owner_mac" && options.host?.runsOn !== "cloud") throw new McpConnectorError("invalid_definition", "host");
    this.servers = options.servers;
    this.catalog = options.catalog;
    this.host = options.host;
  }

  async execute(call: AdapterCall, auth: InjectedAuth, context: { signal: AbortSignal }): Promise<JsonValue> {
    // Everything up to the session is a refusal before anything starts or leaves the process.
    if (this.closed) throw new McpConnectorError("closed");
    const serverId = serverIdOfHost(call.host);
    const definition = serverId === null ? null : this.servers.get(serverId);
    if (!definition || serverId === null) throw new McpConnectorError("server_unknown");
    if (call.toolkit !== mcpToolkit(serverId) || call.upstreamAccountRef !== mcpAccountRef(serverId)) throw new McpConnectorError("scope_mismatch");
    if (!placementAllowed(definition, this.host)) throw new McpConnectorError("placement_unavailable");
    const entry = this.catalog.find(serverId, call.upstreamSlug);
    if (!entry || entry.version !== call.version || definition.disabledTools.includes(entry.mcpName)
      || (definition.enabledTools !== null && !definition.enabledTools.includes(entry.mcpName))) throw new McpConnectorError("tool_not_allowed");
    const circuitKey=`${call.connectionId}:${credentialHash(auth.headers)}`;
    const circuit=this.circuits.get(circuitKey);
    const now=this.host.now?.()??Date.now();
    if(circuit&&circuit.until>now)throw new McpConnectorError("circuit_open",null,null,{phase:"pre_dispatch",effect:"none"});
    if(circuit?.until) circuit.until=now+3000; // only one half-open metadata probe, never a speculative write probe
    const args: Record<string, JsonValue> = {};
    for (const [name, value] of Object.entries(call.arguments)) {
      const upstream = Object.hasOwn(entry.argumentNames, name) ? entry.argumentNames[name] : undefined;
      if (upstream === undefined && !entry.nativeSchema) throw new McpConnectorError("arguments_refused");
      args[upstream ?? name] = value;
    }

    let dispatched=false;
    let pooled:Pooled|undefined;
    try {
      pooled = await this.session(call.connectionId, definition, auth.headers, context.signal);
      const current = (await pooled.session.listTools(context.signal)).find((tool) => tool.name === entry.mcpName);
      // The tool changed (or vanished) since the owner reviewed it: never call the new definition.
      if (!current || current.definitionHash !== entry.version) throw new McpConnectorError("tool_changed");
      // tools/list is the guaranteed no-effect half-open probe. Only a confirmed pinned result reopens dispatch.
      if(circuit?.until)this.circuits.delete(circuitKey);
      // Input validation is proven before dispatch; upstream annotations never authorize a retry.
      pooled.session.validateInput(entry.mcpName,args);
      dispatched=true;
      const result=await pooled.session.callTool(entry.mcpName, args, context.signal,call);
      this.circuits.delete(circuitKey);return result;
    } catch (error) {
      if (pooled&&(!pooled.session.isOpen || isTransportFailure(error))) await this.drop(call.connectionId, pooled);
      if(error instanceof McpConnectorError&&["connect_failed","transport_failed","timeout","upstream_status"].includes(error.code)) {
        const failures=(this.circuits.get(circuitKey)?.failures??0)+1;
        if(this.circuits.size>=1024&&!this.circuits.has(circuitKey))this.circuits.delete(this.circuits.keys().next().value!);
        const jitter=1000+(createHash("sha256").update(circuitKey).digest().readUInt16BE(0)%4000);
        this.circuits.set(circuitKey,{failures,until:failures>=3?(this.host.now?.()??Date.now())+30_000+jitter:0});
      }
      if(error instanceof McpConnectorError&&dispatched&&error.effect!=="possible"&&error.phase!=="pre_dispatch"&&!["input_schema_invalid","schema_unsupported"].includes(error.code))
        throw new McpConnectorError(error.code,error.detail,error.status,{phase:"dispatch",effect:"possible"});
      throw error;
    }
  }

  private async session(connectionId: string, definition: McpServerDefinition, credential: McpCredential, signal: AbortSignal): Promise<Pooled> {
    const hash = credentialHash(credential);
    const existing = this.pool.get(connectionId);
    if (existing && existing.session.isOpen && existing.credentialHash === hash && existing.session.definition === definition) return existing;
    if (existing) await this.drop(connectionId, existing);
    const inflight = this.opening.get(connectionId);
    if (inflight) {
      const opened = await inflight;
      if (opened.credentialHash === hash && opened.session.definition === definition) return opened;
    }
    const opening = McpUpstreamSession.open(definition, credential, this.host, signal).then((session) => ({ session, credentialHash: hash }));
    this.opening.set(connectionId, opening);
    try {
      const opened = await opening;
      if (this.closed) { await opened.session.close(); throw new McpConnectorError("closed"); }
      this.pool.set(connectionId, opened);
      return opened;
    } finally {
      if (this.opening.get(connectionId) === opening) this.opening.delete(connectionId);
    }
  }

  private async drop(connectionId: string, pooled: Pooled): Promise<void> {
    if (this.pool.get(connectionId) === pooled) this.pool.delete(connectionId);
    await pooled.session.close();
  }

  /** Ends one connection's session (revocation, credential rotation). */
  async closeConnection(connectionId: string): Promise<void> {
    const pooled = this.pool.get(connectionId);
    if (pooled) await this.drop(connectionId, pooled);
  }

  /** Ends every session and terminates every stdio server started by this adapter. */
  async close(): Promise<void> {
    this.closed = true;
    const opening = [...this.opening.values()];
    await Promise.allSettled(opening.map((p) => p.then((o) => o.session.close())));
    const pooled = [...this.pool.values()];
    this.pool.clear();
    await Promise.allSettled(pooled.map((p) => p.session.close()));
  }

  /** Live sessions (diagnostics/tests). */
  get openSessions(): number { return [...this.pool.values()].filter((p) => p.session.isOpen).length; }
  circuitStatus(): { connectionId: string; state: "closed" | "open" | "probe_due"; failures:number; retryAt:number|null }[] {
    const now=this.host.now?.()??Date.now();
    return [...this.circuits].map(([key,value])=>({connectionId:key.slice(0,key.lastIndexOf(":")),state:value.until>now?"open":value.until?"probe_due":"closed",failures:value.failures,retryAt:value.until||null}));
  }
}

/**
 * Failures after which the session is not reused. A timeout or an oversized result is not one: the request
 * was cancelled upstream (notifications/cancelled) and the connection itself is still sound.
 */
const TRANSPORT_CODES = new Set<McpErrorCode>(["transport_failed", "closed", "response_invalid", "needs_auth", "upstream_redirect"]);
function isTransportFailure(error: unknown): boolean {
  return error instanceof McpConnectorError && TRANSPORT_CODES.has(error.code);
}

export type McpProbeResult =
  | { state: "ready"; tools: McpToolPlan[]; discovered: McpDiscoveredTool[] }
  | { state: "needs_auth" }
  | { state: "unavailable_here" }
  | { state: "failed"; code: McpErrorCode; metadataHash?: string };

/**
 * Owner-side discovery: connect with the given credential, list and plan tools, close. Calls no tool. The
 * result names states and codes only. `needs_auth` means the server refused the given credential (or an `oauth`
 * definition came without an access token); nothing falls back to another credential or starts an interactive step.
 */
export async function probeMcpServer(definition: McpServerDefinition, credential: McpCredential, host: McpRuntimeHost, signal?: AbortSignal): Promise<McpProbeResult> {
  if (!placementAllowed(definition, host)) return { state: "unavailable_here" };
  let session: McpUpstreamSession | null = null;
  try {
    session = await McpUpstreamSession.open(definition, credential, host, signal);
    const tools = await session.listTools(signal);
    return { state: "ready", tools: planMcpTools(definition, tools), discovered: tools };
  } catch (error) {
    if (!(error instanceof McpConnectorError)) return { state: "failed", code: "transport_failed" };
    if (error.code === "needs_auth") return { state: "needs_auth" };
    if (error.code === "placement_unavailable") return { state: "unavailable_here" };
    return { state: "failed", code: error.code, ...(error.metadataHash?{metadataHash:error.metadataHash}:{}) };
  } finally {
    await session?.close();
  }
}
