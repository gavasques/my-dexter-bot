import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client, SdkError, SdkErrorCode, StreamableHTTPClientTransport, type Transport } from "@modelcontextprotocol/client";
import type { JsonValue } from "@dexter/contracts";
import { McpMrtrVault, type AdapterCall, type MrtrBinding as McpMrtrBinding } from "@dexter/gateway";
import type { McpServerDefinition, McpValue } from "./definition.js";
import { McpConnectorError, trustedMcpConnectorError } from "./errors.js";
import { MCP_OAUTH_ACCESS_KEY } from "./oauth.js";
import { BoundedStdioTransport, pinnedFetch } from "./transport.js";
import { inspectMcpMetadata } from "./metadata-security.js";
import { assertSupportedMcpSchema, validateNativeMcpArguments, validateNativeMcpOutput } from "./schema.js";
import { createMcpEgressFetch, reviewedMcpEgressPolicy, type McpEgressNetwork, type McpEgressPolicy } from "./egress.js";
import { mcpHeaderDeclarations } from "./protocol-security.js";
import { verifyMcpStdioCommand, type McpStdioCommandPin } from "./command-pin.js";
import { validateMcpPrivateInputRequests, validateMcpPrivateInputResponses, type McpPrivateInputHandler } from "./private-input.js";
import { mcpParameterHeaders } from "./protocol-security.js";

/** Where this runtime runs. A definition pinned elsewhere is never started here. */
export interface McpRuntimeHost {
  runsOn: "owner_mac" | "cloud";
  /**
   * Directory owned by Dexter under which each stdio server gets its own HOME, TMPDIR and default working
   * directory. Never the owner's home: personal configs and OAuth stores are not visible to the child.
   */
  stdioRoot: string;
  /** Network fetch for HTTP servers. Default: globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  egressPolicy?: McpEgressPolicy;
  egressNetwork?: McpEgressNetwork;
  /** Opt-in dual era; absent stays byte-compatible legacy. No tool-call downgrade/retry. */
  protocolMode?: "legacy" | "auto" | "modern";
  /** Credential values supplied by trusted custody; used only in bounded in-memory metadata rejection. */
  secretValues?: () => readonly string[];
  /** Notice only: runtime must revoke stale pins before any new execution. */
  onToolsChanged?: (serverId: string) => void;
  stdioCommandPins?: (serverId: string) => McpStdioCommandPin | null;
  inputRequired?: McpPrivateInputHandler;
  now?: () => number;
}

/** Credential material released by the gateway broker for one connection: secret key -> value. */
export type McpCredential = Readonly<Record<string, string>>;

export interface McpDiscoveredTool {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: Record<string, unknown>;
  title?: string;
  /** Upstream hints, shown for review only. They never relax policy or approval. */
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean } | null;
  /** Pin of the exact published definition (name, title, description, schemas, annotations). */
  definitionHash: string;
  /** Hash-only diagnostic. Contaminated upstream strings/values are never returned to storage or context. */
  schemaUnsupported?: boolean;
  quarantine?: { reason: "credential_material" | "metadata_limit"; metadataHash: string };
}

const MAX_TOOLS = 256;
const CLIENT_INFO = { name: "dexter", version: "0.0.1" };
const VALUE = /^[^\u0000-\u001f\u007f]{1,8192}$/;

/** Canonical JSON (sorted keys) for hashing published tool definitions. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
export function toolDefinitionHash(tool: Record<string, unknown>): string {
  const pinned = {
    name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema, annotations: tool.annotations,
  };
  return createHash("sha256").update(canonical(pinned)).digest("hex").slice(0, 32);
}

/** Resolves definition values with the released credential. A missing secret refuses; nothing falls back. */
export function resolveValues(values: Readonly<Record<string, McpValue>>, credential: McpCredential): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value.kind === "literal") { out[name] = value.value; continue; }
    const secret = Object.hasOwn(credential, value.key) ? credential[value.key] : undefined;
    if (typeof secret !== "string" || secret.length === 0) throw new McpConnectorError("credential_missing", value.key);
    const resolved = `${value.prefix ?? ""}${secret}`;
    if (!VALUE.test(resolved)) throw new McpConnectorError("credential_missing", value.key);
    out[name] = resolved;
  }
  return out;
}

/** Whether a definition may start on this host. Local processes never move between machines. */
export function placementAllowed(definition: McpServerDefinition, host: McpRuntimeHost): boolean {
  return definition.runsOn === "any" || definition.runsOn === host.runsOn;
}

function mapError(error: unknown, signal: AbortSignal | undefined, authRequired: boolean): McpConnectorError {
  const trusted=trustedMcpConnectorError(error);if(trusted)return trusted;
  if (authRequired) return new McpConnectorError("needs_auth");
  if (error instanceof McpConnectorError) return error;
  if (signal?.aborted) return new McpConnectorError("aborted");
  if (error instanceof SdkError) {
    if (error.code === SdkErrorCode.EraNegotiationFailed) return new McpConnectorError("protocol_unsupported");
    if (error.code === SdkErrorCode.UnsupportedResultType) return new McpConnectorError("input_required", null, null, { phase: "dispatch", effect: "possible" });
    if (error.code === SdkErrorCode.RequestTimeout) return new McpConnectorError("timeout");
    if (error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.NotConnected) return new McpConnectorError("transport_failed");
    return new McpConnectorError("upstream_error");
  }
  // A JSON-RPC error answer (unknown tool, invalid params...). Its message is upstream text: dropped.
  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "number") {
    const code=(error as {code:number}).code;
    return new McpConnectorError(code===-32020?"header_mismatch":code===-32022?"protocol_unsupported":"upstream_error");
  }
  return new McpConnectorError("transport_failed");
}

/**
 * One live connection to one upstream MCP server, opened for one gateway connection's credential.
 * Lifecycle: open (spawn or HTTP initialize, bounded by connectTimeoutMs) -> listTools/callTool -> close.
 * The common handshake and legacy requests advertise no reverse-RPC capabilities. A negotiated modern
 * tools/call advertises only the primitive form MRTR handler actually supplied by this host.
 */
export class McpUpstreamSession {
  private closed = false;
  private readonly toolSchemas = new Map<string, McpDiscoveredTool>();
  private readonly mrtr = new McpMrtrVault();
  private readonly shutdown = new AbortController();
  private toolQueue: Promise<void> = Promise.resolve();
  private rpcId: string | number | null = null;
  private resume: { handle:string; binding:McpMrtrBinding; authorized:()=>boolean; state:string } | null = null;
  private constructor(
    readonly definition: McpServerDefinition,
    private readonly client: Client,
    private readonly transport: Transport,
    private readonly auth: { required: boolean },
    private readonly knownSecrets: () => readonly string[],
    private readonly privateInputs: McpPrivateInputHandler | undefined,
  ) {
    const send=transport.send.bind(transport);
    transport.send=async(message,...rest)=>{
      if("method" in message && message.method==="tools/call" && "id" in message) {
        this.rpcId=message.id;
        if(this.resume) {
          const continuation=this.mrtr.consume(this.resume.handle,this.resume.binding,String(message.id),this.resume.authorized);
          if(continuation.requestState!==this.resume.state)throw new McpConnectorError("scope_mismatch");
          this.resume=null;
        }
      }
      await send(message,...rest);
    };
  }

  get isOpen(): boolean { return !this.closed; }
  get protocolVersion(): string | null { return this.client.getNegotiatedProtocolVersion() ?? null; }
  /** Child process id for stdio servers (tests and diagnostics); null for HTTP. */
  get pid(): number | null { return this.transport instanceof BoundedStdioTransport ? this.transport.pid : null; }

  static async open(definition: McpServerDefinition, credential: McpCredential, host: McpRuntimeHost, signal?: AbortSignal): Promise<McpUpstreamSession> {
    if (!placementAllowed(definition, host)) throw new McpConnectorError("placement_unavailable");
    // OAuth: only an access token already obtained by the owner's authorization (McpOAuthClient) is used. Without one
    // nothing is sent; there is no interactive step, discovery or fallback here.
    if (definition.auth === "oauth") {
      const token = Object.hasOwn(credential, MCP_OAUTH_ACCESS_KEY) ? credential[MCP_OAUTH_ACCESS_KEY] : undefined;
      if (typeof token !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(token)) throw new McpConnectorError("needs_auth");
      if (definition.transport.type !== "streamable_http" || Object.hasOwn(definition.transport.headers, "authorization")) throw new McpConnectorError("invalid_definition", "auth");
    }
    if (signal?.aborted) throw new McpConnectorError("aborted");
    const auth = { required: false };
    const transport = McpUpstreamSession.transportFor(definition, credential, host, auth);
    const client = new Client(CLIENT_INFO, { capabilities: {}, inputRequired: { autoFulfill: false, maxRounds: 3 },
      versionNegotiation: { mode: host.protocolMode === "modern" ? { pin: "2026-07-28" } : host.protocolMode ?? "legacy", probe: { maxRetries: 0, timeoutMs: Math.min(3000, definition.limits.connectTimeoutMs) } },
      supportedProtocolVersions: host.protocolMode === "legacy" || host.protocolMode === undefined ? ["2025-11-25", "2025-06-18", "2025-03-26"] : ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"],
      listChanged: { tools: { autoRefresh: false, onChanged: () => host.onToolsChanged?.(definition.id) } },
    });
    const session = new McpUpstreamSession(definition, client, transport, auth, () => [...Object.values(credential), ...(host.secretValues?.() ?? [])],host.inputRequired);
    try {
      await client.connect(transport, { timeout: definition.limits.connectTimeoutMs, maxTotalTimeout: definition.limits.connectTimeoutMs, ...(signal ? { signal } : {}) });
    } catch (error) {
      await session.close();
      const mapped = mapError(error, signal, auth.required);
      throw mapped.code === "upstream_error" || mapped.code === "transport_failed" ? new McpConnectorError("connect_failed") : mapped;
    }
    // Chained after connect: the SDK installs its own handler there. A dead child marks the session closed.
    transport.onclose = chain(transport.onclose, () => { session.closed = true; });
    return session;
  }

  private static transportFor(definition: McpServerDefinition, credential: McpCredential, host: McpRuntimeHost, auth: { required: boolean }): Transport {
    const t = definition.transport;
    if (t.type === "stdio") {
      const home = join(host.stdioRoot, definition.id);
      const tmp = join(home, "tmp");
      mkdirSync(tmp, { recursive: true, mode: 0o700 });
      const env = { ...resolveValues(t.env, credential), HOME: home, TMPDIR: `${tmp}/`, PATH: t.searchPath.join(":") };
      const pin = host.stdioCommandPins?.(definition.id);
      if ((host.runsOn === "cloud" || host.stdioCommandPins) && !pin) throw new McpConnectorError("command_changed", "pin_required", null, { phase: "pre_dispatch", effect: "none" });
      const command = pin ? verifyMcpStdioCommand(t,pin) : t.command;
      return new BoundedStdioTransport({ command, args: t.args, cwd: t.cwd ?? home, env, maxMessageBytes: definition.limits.maxMessageBytes });
    }
    const headers = resolveValues(t.headers, credential);
    // The bearer goes only to the pinned endpoint (pinnedFetch refuses every other origin and never follows redirects).
    if (definition.auth === "oauth") headers.authorization = `Bearer ${credential[MCP_OAUTH_ACCESS_KEY]!}`;
    const endpoint = new URL(t.url);
    return new StreamableHTTPClientTransport(endpoint, {
      fetch: pinnedFetch({
        endpoint, headers, maxResponseBytes: definition.limits.maxMessageBytes,
        fetch: host.fetch ?? createMcpEgressFetch(reviewedMcpEgressPolicy(endpoint,host.egressPolicy ?? { placement: host.runsOn }), host.egressNetwork),
        onAuthRequired: () => { auth.required = true; },
      }),
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1_000, maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1 },
    });
  }

  /** Current published tools (always fetched, never served from a cache), capped at 256. */
  async listTools(signal?: AbortSignal): Promise<McpDiscoveredTool[]> {
    if (this.closed) throw new McpConnectorError("closed");
    let tools: Record<string, unknown>[];
    try {
      // Explicit pages avoid the SDK's warning path that can print contaminated tool names before our quarantine.
      tools = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 16; page++) {
        const result = await this.client.request({ method: "tools/list", ...(cursor ? { params: { cursor } } : {}) }, {
          timeout: this.definition.limits.callTimeoutMs, ...(signal ? { signal } : {}),
        });
        if (!Array.isArray(result.tools)) throw new McpConnectorError("response_invalid");
        const batch = result.tools as unknown as Record<string,unknown>[];
        tools.push(...batch);
        if (tools.length > MAX_TOOLS) throw new McpConnectorError("response_too_large");
        if (!result.nextCursor) break;
        if (seen.has(result.nextCursor) || page === 15) throw new McpConnectorError("response_too_large");
        seen.add(result.nextCursor); cursor = result.nextCursor;
      }
    } catch (error) {
      const mapped=mapError(error,signal,this.auth.required);
      throw new McpConnectorError(mapped.code,mapped.detail,mapped.status,{phase:"discovery",effect:"none",...(mapped.metadataHash?{metadataHash:mapped.metadataHash}:{})});
    }
    if (!Array.isArray(tools)) throw new McpConnectorError("response_invalid");
    if (tools.length > MAX_TOOLS) throw new McpConnectorError("response_too_large");
    // Quarantine each definition before projecting any upstream strings. One bad definition cannot disable peers.
    tools = tools.map(tool => {
      const verdict = inspectMcpMetadata(tool, this.knownSecrets());
      if (verdict.safe) return tool;
      const safeName=typeof tool.name === "string" && /^[^\u0000-\u001f\u007f]{1,128}$/.test(tool.name) && inspectMcpMetadata(tool.name,this.knownSecrets()).safe
        ? tool.name : `quarantined_${verdict.hash.slice(0, 24)}`;
      return { name: safeName, description: "Definition quarantined by Dexter", inputSchema: {},
        dexterQuarantine: { reason: verdict.reason!, metadataHash: verdict.hash } };
    });
    const discovered = tools.map((tool) => {
      let unsupportedHeader=false;
      if (!tool.dexterQuarantine && this.client.getProtocolEra() === "modern" && this.definition.transport.type === "streamable_http") {
        try { mcpHeaderDeclarations(tool.inputSchema); } catch { unsupportedHeader=true; }
      }
      if (typeof tool.name !== "string") throw new McpConnectorError("response_invalid");
      const a = tool.annotations as Record<string, unknown> | undefined;
      const hint = (k: string): boolean | undefined => (typeof a?.[k] === "boolean" ? a[k] as boolean : undefined);
      const annotations = a && typeof a === "object" ? {
        ...(hint("readOnlyHint") === undefined ? {} : { readOnlyHint: hint("readOnlyHint")! }),
        ...(hint("destructiveHint") === undefined ? {} : { destructiveHint: hint("destructiveHint")! }),
        ...(hint("idempotentHint") === undefined ? {} : { idempotentHint: hint("idempotentHint")! }),
        ...(hint("openWorldHint") === undefined ? {} : { openWorldHint: hint("openWorldHint")! }),
      } : null;
      return {
        name: tool.name, description: typeof tool.description === "string" ? tool.description : "",
        inputSchema: tool.inputSchema, annotations, definitionHash: toolDefinitionHash(tool),
        ...(tool.outputSchema && typeof tool.outputSchema === "object" ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}),
        ...(typeof tool.title === "string" ? { title: tool.title } : {}),
        ...(unsupportedHeader || Object.hasOwn(tool,"outputSchema") && tool.outputSchema !== undefined && (!tool.outputSchema || typeof tool.outputSchema !== "object" || Array.isArray(tool.outputSchema)) ? {schemaUnsupported:true}:{}),
        ...(tool.dexterQuarantine ? { quarantine: tool.dexterQuarantine as NonNullable<McpDiscoveredTool["quarantine"]> } : {}),
      };
    });
    this.toolSchemas.clear(); for (const tool of discovered) if (!tool.quarantine&&!tool.schemaUnsupported) this.toolSchemas.set(tool.name, tool);
    return discovered;
  }

  /**
   * Calls one tool once (never retried) under callTimeoutMs and the caller's signal (cancellation is sent
   * upstream). Returns `{ isError, content, structuredContent? }`; a result over maxResultBytes is refused.
   */
  validateInput(name:string,args:Record<string,JsonValue>):void {
    const published=this.toolSchemas.get(name);if(!published)throw new McpConnectorError("tool_not_allowed");
    assertSupportedMcpSchema(published.inputSchema);validateNativeMcpArguments(published.inputSchema,args);
    if(published.outputSchema)assertSupportedMcpSchema(published.outputSchema);
  }
  async callTool(name: string, args: Record<string, JsonValue>, signal?: AbortSignal, call?:AdapterCall): Promise<JsonValue> {
    // One logical effect at a time per connection. A waiting call is cancellable and is never dispatched twice.
    const previous=this.toolQueue;let release!:()=>void;this.toolQueue=new Promise<void>(resolve=>{release=resolve;});
    const effective=AbortSignal.any([AbortSignal.timeout(this.definition.limits.callTimeoutMs),this.shutdown.signal,...(signal?[signal]:[])]);
    const deadline = performance.now() + this.definition.limits.callTimeoutMs;
    let entered=false;
    try {await awaitMcpAbort(previous,effective);entered=true;if(effective.aborted)throw new McpConnectorError("aborted", null, null, { phase: "pre_dispatch", effect: "none" });return await this.callToolRound(name,args,effective,call,deadline);}
    finally{if(entered){this.resume=null;this.mrtr.revoke();release();}else void previous.then(release,release);}
  }
  private async callToolRound(name: string,args:Record<string,JsonValue>,signal?:AbortSignal,call?:AdapterCall,deadline = Infinity):Promise<JsonValue> {
    if (this.closed) throw new McpConnectorError("closed");
    const published = this.toolSchemas.get(name);
    if (!published) throw new McpConnectorError("tool_not_allowed");
    this.validateInput(name,args);
    // Let a due Stop/timeout run after synchronous validation, then recheck before the FIRST effect.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (signal?.aborted || performance.now() >= deadline) throw new McpConnectorError(signal?.aborted ? "aborted" : "timeout", null, null, { phase: "pre_dispatch", effect: "none" });
    let result: Record<string, unknown>;
    try {
      const timeout = this.definition.limits.callTimeoutMs;
      // Explicit request + exact pinned parameter mirrors avoids SDK HeaderMismatch auto-retry for ANY effect.
      // SDK 2.3.1 gives explicit per-request _meta precedence over its automatic modern envelope.
      // Never promise legacy elicitation/create: only this modern MRTR path has a bound private handler.
      const privateFormAvailable=()=>this.client.getProtocolEra()==="modern"&&this.privateInputs&&call?.actionId&&call.requestHash&&call.manifestHash
        &&call.toolRevision!==undefined&&call.connectionRevision!==undefined&&this.privateInputs.authorized(call);
      const request=(extra:Record<string,unknown>={})=>this.client.request({method:"tools/call",params:{name,arguments:args,...extra,
        ...(privateFormAvailable()?{_meta:{"io.modelcontextprotocol/clientCapabilities":{elicitation:{form:{}}}}}:{})}},{timeout,maxTotalTimeout:timeout,
        allowInputRequired:true,headers:this.client.getProtocolEra()==="modern"?mcpParameterHeaders(published.inputSchema,args):{},...(signal?{signal}:{})});
      result=await request() as Record<string,unknown>;
      assertResultSize(result, this.definition.limits.maxResultBytes);
      let rounds=0;
      while(result.resultType==="input_required") {
        const input=this.privateInputs;
        if(!input||!call?.actionId||!call.requestHash||!call.manifestHash||call.toolRevision===undefined||call.connectionRevision===undefined||this.client.getProtocolEra()!=="modern"
          ||typeof result.requestState!=="string"||this.rpcId===null||rounds>=3||!input.authorized(call))throw new McpConnectorError("input_required",null,null,{phase:"dispatch",effect:"possible"});
        const requests=validateMcpPrivateInputRequests(result.inputRequests,this.knownSecrets());
        const binding:McpMrtrBinding={principal:canonical(call.scope),connectionId:call.connectionId,logicalCallId:`${call.actionId}:${call.idempotencyKey}`,method:"tools/call",requestHash:call.requestHash,
          pin:`${call.manifestHash}:${call.toolRevision}:${call.connectionRevision}:${call.version}`};
        const state=result.requestState,handle=this.mrtr.issue(binding,state,String(this.rpcId),rounds);
        const privateSignal=signal??new AbortController().signal;
        const responses=validateMcpPrivateInputResponses(requests,await awaitMcpAbort(input.request(call,requests,privateSignal,
          candidate=>{validateMcpPrivateInputResponses(requests,candidate,this.knownSecrets());}),privateSignal),this.knownSecrets());
        if(signal?.aborted||!input.authorized(call))throw new McpConnectorError("aborted",null,null,{phase:"dispatch",effect:"possible"});
        this.resume={handle,binding,authorized:()=>input.authorized(call),state};
        result=await request({requestState:state,inputResponses:responses}) as Record<string,unknown>;
        assertResultSize(result, this.definition.limits.maxResultBytes);
        rounds++;
      }
    } catch (error) {
      const mapped=mapError(error,signal,this.auth.required);
      throw new McpConnectorError(mapped.code,mapped.detail,mapped.status,{phase:"dispatch",effect:"possible"});
    }
    const out: Record<string, JsonValue> = {
      isError: result.isError === true,
      content: Array.isArray(result.content) ? result.content as JsonValue : [],
    };
    if (result.structuredContent !== undefined) out.structuredContent = result.structuredContent as JsonValue;
    assertResultSize(out, this.definition.limits.maxResultBytes);
    if (published.outputSchema && !out.isError) validateNativeMcpOutput(published.outputSchema, result.structuredContent);
    return out;
  }

  /** Ends the session; for stdio, terminates the server's whole process group. Idempotent. */
  async close(): Promise<void> {
    this.closed = true;
    this.shutdown.abort();
    this.mrtr.revoke();
    try { await this.client.close(); } catch { /* transport already gone */ }
    try { await this.transport.close(); } catch { /* idempotent */ }
  }
}

/** Bound the actual upstream result before ANY result validator, then the normalized gateway envelope. */
function assertResultSize(value: unknown, maxBytes: number): void {
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(value), "utf8"); }
  catch { throw new McpConnectorError("response_invalid", null, null, { phase: "validation", effect: "possible" }); }
  if (size > maxBytes) throw new McpConnectorError("response_too_large", null, null, { phase: "validation", effect: "possible" });
}

function awaitMcpAbort<T>(promise:Promise<T>,signal:AbortSignal):Promise<T> {
  if(signal.aborted)return Promise.reject(new McpConnectorError("aborted"));
  return new Promise((resolve,reject)=>{
    const abort=():void=>{reject(new McpConnectorError("aborted"));};
    signal.addEventListener("abort",abort,{once:true});
    void promise.then(value=>{signal.removeEventListener("abort",abort);resolve(value);},error=>{signal.removeEventListener("abort",abort);reject(error);});
  });
}

function chain(first: (() => void) | undefined, second: () => void): () => void {
  return () => { first?.(); second(); };
}
