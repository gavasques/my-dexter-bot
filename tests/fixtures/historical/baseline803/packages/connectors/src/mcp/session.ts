import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client, SdkError, SdkErrorCode, StreamableHTTPClientTransport, type Transport } from "@modelcontextprotocol/client";
import type { JsonValue } from "@dexter/contracts";
import type { McpServerDefinition, McpValue } from "./definition.js";
import { McpConnectorError } from "./errors.js";
import { MCP_OAUTH_ACCESS_KEY } from "./oauth.js";
import { BoundedStdioTransport, pinnedFetch } from "./transport.js";

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
}

/** Credential material released by the gateway broker for one connection: secret key -> value. */
export type McpCredential = Readonly<Record<string, string>>;

export interface McpDiscoveredTool {
  name: string;
  description: string;
  inputSchema: unknown;
  /** Upstream hints, shown for review only. They never relax policy or approval. */
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean } | null;
  /** Pin of the exact published definition (name, title, description, schemas, annotations). */
  definitionHash: string;
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
  if (authRequired) return new McpConnectorError("needs_auth");
  if (error instanceof McpConnectorError) return error;
  if (signal?.aborted) return new McpConnectorError("aborted");
  if (error instanceof SdkError) {
    if (error.code === SdkErrorCode.RequestTimeout) return new McpConnectorError("timeout");
    if (error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.NotConnected) return new McpConnectorError("transport_failed");
    return new McpConnectorError("upstream_error");
  }
  // A JSON-RPC error answer (unknown tool, invalid params...). Its message is upstream text: dropped.
  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "number") return new McpConnectorError("upstream_error");
  return new McpConnectorError("transport_failed");
}

/**
 * One live connection to one upstream MCP server, opened for one gateway connection's credential.
 * Lifecycle: open (spawn or HTTP initialize, bounded by connectTimeoutMs) -> listTools/callTool -> close.
 * The client advertises no capabilities, so the server cannot ask for sampling, roots or elicitation.
 */
export class McpUpstreamSession {
  private closed = false;
  private constructor(
    readonly definition: McpServerDefinition,
    private readonly client: Client,
    private readonly transport: Transport,
    private readonly auth: { required: boolean },
  ) {}

  get isOpen(): boolean { return !this.closed; }
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
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const session = new McpUpstreamSession(definition, client, transport, auth);
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
      return new BoundedStdioTransport({ command: t.command, args: t.args, cwd: t.cwd ?? home, env, maxMessageBytes: definition.limits.maxMessageBytes });
    }
    const headers = resolveValues(t.headers, credential);
    // The bearer goes only to the pinned endpoint (pinnedFetch refuses every other origin and never follows redirects).
    if (definition.auth === "oauth") headers.authorization = `Bearer ${credential[MCP_OAUTH_ACCESS_KEY]!}`;
    const endpoint = new URL(t.url);
    return new StreamableHTTPClientTransport(endpoint, {
      fetch: pinnedFetch({
        endpoint, headers, maxResponseBytes: definition.limits.maxMessageBytes, fetch: host.fetch ?? globalThis.fetch,
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
      const result = await this.client.listTools(undefined, {
        cacheMode: "refresh", timeout: this.definition.limits.callTimeoutMs, ...(signal ? { signal } : {}),
      });
      tools = result.tools as unknown as Record<string, unknown>[];
    } catch (error) {
      throw mapError(error, signal, this.auth.required);
    }
    if (!Array.isArray(tools)) throw new McpConnectorError("response_invalid");
    return tools.slice(0, MAX_TOOLS).map((tool) => {
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
      };
    });
  }

  /**
   * Calls one tool once (never retried) under callTimeoutMs and the caller's signal (cancellation is sent
   * upstream). Returns `{ isError, content, structuredContent? }`; a result over maxResultBytes is refused.
   */
  async callTool(name: string, args: Record<string, JsonValue>, signal?: AbortSignal): Promise<JsonValue> {
    if (this.closed) throw new McpConnectorError("closed");
    let result: Record<string, unknown>;
    try {
      const timeout = this.definition.limits.callTimeoutMs;
      result = await this.client.callTool({ name, arguments: args }, { timeout, maxTotalTimeout: timeout, ...(signal ? { signal } : {}) }) as Record<string, unknown>;
    } catch (error) {
      throw mapError(error, signal, this.auth.required);
    }
    const out: Record<string, JsonValue> = {
      isError: result.isError === true,
      content: Array.isArray(result.content) ? result.content as JsonValue : [],
    };
    if (result.structuredContent !== undefined) out.structuredContent = result.structuredContent as JsonValue;
    let size: number;
    try { size = Buffer.byteLength(JSON.stringify(out), "utf8"); } catch { throw new McpConnectorError("response_invalid"); }
    if (size > this.definition.limits.maxResultBytes) throw new McpConnectorError("response_too_large");
    return out;
  }

  /** Ends the session; for stdio, terminates the server's whole process group. Idempotent. */
  async close(): Promise<void> {
    this.closed = true;
    try { await this.client.close(); } catch { /* transport already gone */ }
    try { await this.transport.close(); } catch { /* idempotent */ }
  }
}

function chain(first: (() => void) | undefined, second: () => void): () => void {
  return () => { first?.(); second(); };
}
