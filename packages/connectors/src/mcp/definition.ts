import { isAbsolute } from "node:path";
import type { ConnectInput } from "@dexter/gateway";
import { McpConnectorError } from "./errors.js";

/**
 * A value placed in a child environment or an HTTP header. `literal` is set only by trusted owner code (it is
 * stored in the definition, so it must not be a secret). `secret` names a key of the credential the gateway
 * broker releases for this server at call time; the value itself never enters a definition, preview or log.
 */
export type McpValue =
  | { kind: "literal"; value: string }
  | { kind: "secret"; key: string; prefix?: string };

export interface McpStdioTransport {
  type: "stdio";
  /** Absolute path, or a bare program name resolved only against `searchPath` (never the host's PATH). */
  command: string;
  args: string[];
  /** Absolute working directory, or null for the manager's isolated working directory. */
  cwd: string | null;
  /** The child's whole environment besides HOME/TMPDIR/PATH, which the manager sets. Nothing is inherited. */
  env: Record<string, McpValue>;
  /** Absolute directories that form the child's PATH. */
  searchPath: string[];
}
export interface McpHttpTransport {
  type: "streamable_http";
  /** Pinned endpoint. https, or http only on a loopback host. No credentials, query or fragment. */
  url: string;
  headers: Record<string, McpValue>;
}
export type McpTransport = McpStdioTransport | McpHttpTransport;

export interface McpLimits {
  connectTimeoutMs: number;
  callTimeoutMs: number;
  /** Bound of one serialized tool result handed back to the gateway. */
  maxResultBytes: number;
  /** Bound of one JSON-RPC message (stdio line) or one HTTP response body. */
  maxMessageBytes: number;
}
export const MCP_DEFAULT_LIMITS: McpLimits = Object.freeze({
  connectTimeoutMs: 15_000, callTimeoutMs: 60_000, maxResultBytes: 1024 * 1024, maxMessageBytes: 4 * 1024 * 1024,
});
const MCP_MAX_LIMITS: McpLimits = Object.freeze({
  connectTimeoutMs: 120_000, callTimeoutMs: 600_000, maxResultBytes: 16 * 1024 * 1024, maxMessageBytes: 32 * 1024 * 1024,
});

/**
 * One native MCP server in the global inventory. Being in the inventory grants nothing: a bot reaches a tool
 * only through a gateway connection of its profile, a registered manifest and a hub grant for (bot, tool,
 * connection). Annotations the server publishes never change `effect` or approval: only `readOnlyTools`,
 * set by the owner, marks a tool as read.
 */
export interface McpServerDefinition {
  /** Stable id (DNS label). Derives the gateway toolkit, logical host and tool names. */
  id: string;
  name: string;
  transport: McpTransport;
  /**
   * Where the server may run. A stdio server runs on one machine (`owner_mac` or `cloud`) and is never moved
   * to another; an HTTP server is reachable from `any` host unless pinned.
   */
  runsOn: "owner_mac" | "cloud" | "any";
  /**
   * `none`: no credential. `broker`: `secret` values come from the gateway broker (trusted custody, unlocked by the
   * owner). `oauth`: Streamable HTTP only; the access token of the owner's local authorization (McpOAuthClient) is
   * attached as the bearer to the pinned endpoint; without one, connect returns needs_auth before any request.
   */
  auth: "none" | "broker" | "oauth";
  readOnlyTools: string[];
  /** Upstream tool names to publish (null: every discovered tool), minus `disabledTools`. */
  enabledTools: string[] | null;
  disabledTools: string[];
  limits: McpLimits;
  /** Provenance of an imported definition. Informational. */
  source: { format: "claude_json" | "codex_toml" | "manual"; name: string };
}

export const MCP_ID = /^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const NAME = /^[^\u0000-\u001f\u007f]{1,120}$/;
const COMMAND = /^[A-Za-z0-9._+-]{1,128}$/;
const PRINTABLE = /^[^\u0000-\u001f\u007f]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SECRET_KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const TOOL_NAME = /^[^\u0000-\u001f\u007f]{1,128}$/;
const MAX_ARGS = 64;
const MAX_ENTRIES = 64;
const MAX_TOOLS_LISTED = 256;
/** Set by the manager for every stdio child. */
export const MCP_RESERVED_ENV = new Set(["HOME", "PATH", "TMPDIR", "PWD"]);
/** Never accepted in a definition: they change how the child loads code. */
const LOADER_ENV = /^(?:DYLD_|LD_)|^(?:NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|PERL5OPT|RUBYOPT|BASH_ENV|ENV)$/;
/** Controlled by the transport; a definition or credential can never set them. */
export const MCP_RESERVED_HEADERS = new Set([
  "host", "content-type", "content-length", "accept", "connection", "transfer-encoding", "cookie", "origin", "referer",
  "mcp-session-id", "mcp-protocol-version", "last-event-id",
]);
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const bad = (detail: string): never => { throw new McpConnectorError("invalid_definition", detail); };

function checkValue(raw: unknown, field: string): McpValue {
  if (typeof raw !== "object" || raw === null) bad(field);
  const v = raw as Record<string, unknown>;
  if (v.kind === "literal") {
    if (Object.keys(v).some((k) => k !== "kind" && k !== "value")) bad(field);
    if (typeof v.value !== "string" || v.value.length > 4096 || !PRINTABLE.test(v.value)) bad(field);
    return Object.freeze({ kind: "literal", value: v.value as string });
  }
  if (v.kind === "secret") {
    if (Object.keys(v).some((k) => !["kind", "key", "prefix"].includes(k))) bad(field);
    if (typeof v.key !== "string" || !SECRET_KEY.test(v.key)) bad(field);
    if (v.prefix !== undefined && (typeof v.prefix !== "string" || v.prefix.length > 32 || !PRINTABLE.test(v.prefix))) bad(field);
    return Object.freeze({ kind: "secret", key: v.key as string, ...(v.prefix === undefined ? {} : { prefix: v.prefix as string }) });
  }
  return bad(field);
}
function checkValues(raw: unknown, field: string, name: RegExp, normalize: (k: string) => string): Record<string, McpValue> {
  if (raw === undefined) return Object.freeze({});
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) bad(field);
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_ENTRIES) bad(field);
  const out: Record<string, McpValue> = {};
  for (const [key, value] of entries) {
    const k = normalize(key);
    if (!name.test(k) || Object.hasOwn(out, k)) bad(field);
    out[k] = checkValue(value, field);
  }
  return Object.freeze(out);
}
function checkToolList(raw: unknown, field: string, nullable: boolean): string[] | null {
  if (raw === undefined) return nullable ? null : [];
  if (raw === null && nullable) return null;
  if (!Array.isArray(raw) || raw.length > MAX_TOOLS_LISTED || !raw.every((n) => typeof n === "string" && TOOL_NAME.test(n))) bad(field);
  return Object.freeze([...new Set(raw as string[])]) as string[];
}
function checkLimitsOf(raw: unknown): McpLimits {
  if (raw !== undefined && (typeof raw !== "object" || raw === null)) bad("limits");
  const out = { ...MCP_DEFAULT_LIMITS, ...(raw as Partial<McpLimits> | undefined) };
  for (const key of Object.keys(MCP_DEFAULT_LIMITS) as (keyof McpLimits)[]) {
    if (!Number.isSafeInteger(out[key]) || out[key] < 1 || out[key] > MCP_MAX_LIMITS[key]) bad(`limits.${key}`);
  }
  if (Object.keys(out).length !== Object.keys(MCP_DEFAULT_LIMITS).length) bad("limits");
  return Object.freeze(out);
}

/** Parses the pinned endpoint. https anywhere, plain http only on a loopback host. */
export function checkEndpoint(raw: unknown): URL {
  if (typeof raw !== "string" || raw.length > 2048) return bad("transport.url");
  let url: URL;
  try { url = new URL(raw); } catch { return bad("transport.url"); }
  if (url.username || url.password || url.search || url.hash) bad("transport.url");
  if (url.protocol === "http:" ? !LOOPBACK_HOSTS.has(url.hostname) : url.protocol !== "https:") bad("transport.url");
  return url;
}

function checkTransport(raw: unknown): McpTransport {
  if (typeof raw !== "object" || raw === null) return bad("transport");
  const t = raw as Record<string, unknown>;
  if (t.type === "stdio") {
    if (Object.keys(t).some((k) => !["type", "command", "args", "cwd", "env", "searchPath"].includes(k))) bad("transport");
    const command = t.command;
    if (typeof command !== "string" || !(isAbsolute(command) ? command.length <= 1024 && PRINTABLE.test(command) && !command.includes("..") : COMMAND.test(command))) bad("transport.command");
    const args = t.args ?? [];
    if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every((a) => typeof a === "string" && a.length <= 4096 && PRINTABLE.test(a))) bad("transport.args");
    const cwd = t.cwd ?? null;
    if (cwd !== null && (typeof cwd !== "string" || !isAbsolute(cwd) || !PRINTABLE.test(cwd))) bad("transport.cwd");
    const searchPath = t.searchPath ?? ["/usr/bin", "/bin"];
    if (!Array.isArray(searchPath) || searchPath.length === 0 || searchPath.length > 16
      || !searchPath.every((d) => typeof d === "string" && isAbsolute(d) && !d.includes(":") && PRINTABLE.test(d))) bad("transport.searchPath");
    const env = checkValues(t.env, "transport.env", ENV_NAME, (k) => k);
    for (const name of Object.keys(env)) if (MCP_RESERVED_ENV.has(name) || LOADER_ENV.test(name)) bad("transport.env");
    return Object.freeze({
      type: "stdio", command: command as string, args: Object.freeze([...(args as string[])]) as string[], cwd: cwd as string | null, env,
      searchPath: Object.freeze([...(searchPath as string[])]) as string[],
    });
  }
  if (t.type === "streamable_http") {
    if (Object.keys(t).some((k) => !["type", "url", "headers"].includes(k))) bad("transport");
    const url = checkEndpoint(t.url);
    const headers = checkValues(t.headers, "transport.headers", HEADER_NAME, (k) => k.toLowerCase());
    for (const name of Object.keys(headers)) if (MCP_RESERVED_HEADERS.has(name)) bad("transport.headers");
    return Object.freeze({ type: "streamable_http", url: url.href, headers });
  }
  return bad("transport.type");
}

const secretsOf = (transport: McpTransport): McpValue[] =>
  Object.values(transport.type === "stdio" ? transport.env : transport.headers).filter((v) => v.kind === "secret");

/** Validates and freezes a definition. Messages name the field only, never a value. */
export function checkMcpDefinition(input: unknown): McpServerDefinition {
  if (typeof input !== "object" || input === null) return bad("definition");
  const d = input as Record<string, unknown>;
  const allowed = ["id", "name", "transport", "runsOn", "auth", "readOnlyTools", "enabledTools", "disabledTools", "limits", "source"];
  if (Object.keys(d).some((k) => !allowed.includes(k))) bad("definition");
  if (typeof d.id !== "string" || !MCP_ID.test(d.id)) bad("id");
  if (typeof d.name !== "string" || !NAME.test(d.name)) bad("name");
  const transport = checkTransport(d.transport);
  const runsOn = d.runsOn;
  if (runsOn !== "owner_mac" && runsOn !== "cloud" && runsOn !== "any") return bad("runsOn");
  // A local process lives on exactly one machine; it is never "anywhere".
  if (transport.type === "stdio" && runsOn === "any") bad("runsOn");
  const auth = d.auth;
  if (auth !== "none" && auth !== "broker" && auth !== "oauth") return bad("auth");
  const secrets = secretsOf(transport).length;
  if (auth === "none" && secrets > 0) bad("auth");
  if (auth === "broker" && secrets === 0) bad("auth");
  if (auth === "oauth" && transport.type !== "streamable_http") bad("auth");
  const source = d.source ?? { format: "manual", name: d.id };
  const s = source as Record<string, unknown>;
  if (typeof s !== "object" || s === null || !["claude_json", "codex_toml", "manual"].includes(s.format as string)
    || typeof s.name !== "string" || !NAME.test(s.name)) bad("source");
  return Object.freeze({
    id: d.id as string, name: d.name as string, transport, runsOn, auth,
    readOnlyTools: checkToolList(d.readOnlyTools, "readOnlyTools", false)!,
    enabledTools: checkToolList(d.enabledTools, "enabledTools", true),
    disabledTools: checkToolList(d.disabledTools, "disabledTools", false)!,
    limits: checkLimitsOf(d.limits),
    source: Object.freeze({ format: s.format as McpServerDefinition["source"]["format"], name: s.name as string }),
  });
}

/** Gateway toolkit of a server: the manifest and the connection must both carry it. */
export const mcpToolkit = (id: string): string => `mcp-${id}`;
/**
 * Logical gateway host of a server. The manifest's `upstreamHost` and the broker's allowlist name this, not a
 * network host: the real endpoint (or local command) stays pinned in the trusted definition, and the adapter
 * contacts only that.
 */
export const mcpLogicalHost = (id: string): string => `${id}.mcp.dexter.internal`;
const LOGICAL_HOST = /^([a-z](?:[a-z0-9-]{0,38}[a-z0-9])?)\.mcp\.dexter\.internal$/;
export function serverIdOfHost(host: string): string | null {
  return LOGICAL_HOST.exec(host)?.[1] ?? null;
}
/** Not secret; never shown to engines. */
export const mcpAccountRef = (id: string): string => `mcp:${id}`;

/**
 * Input for `CapabilityGateway.connectAccount`: binds one profile to one inventory server through a broker
 * credential reference. Granting each tool to each bot remains a separate hub decision.
 */
export function mcpConnectInput(definition: McpServerDefinition, input: { profileId: string; label: string; credentialRef: string }): ConnectInput {
  return {
    profileId: input.profileId, toolkit: mcpToolkit(definition.id), label: input.label,
    upstreamAccountRef: mcpAccountRef(definition.id), credentialRef: input.credentialRef, allowedHosts: [mcpLogicalHost(definition.id)],
  };
}

/** Lookup of trusted definitions. The adapter resolves servers only through it. */
export interface McpServerSource {
  get(id: string): McpServerDefinition | null;
}

/**
 * Global, immutable inventory of native MCP servers available to this installation. Adding a server here
 * makes it available to configure; it grants no bot anything. A new inventory replaces an old one.
 */
export class McpServerInventory implements McpServerSource {
  private readonly servers: ReadonlyMap<string, McpServerDefinition>;
  constructor(definitions: readonly unknown[]) {
    const servers = new Map<string, McpServerDefinition>();
    for (const raw of definitions) {
      const definition = checkMcpDefinition(raw);
      if (servers.has(definition.id)) throw new McpConnectorError("invalid_definition", "id");
      servers.set(definition.id, definition);
    }
    this.servers = servers;
    Object.freeze(this);
  }
  get(id: string): McpServerDefinition | null { return this.servers.get(id) ?? null; }
  list(): McpServerDefinition[] { return [...this.servers.values()]; }
  get size(): number { return this.servers.size; }
}
