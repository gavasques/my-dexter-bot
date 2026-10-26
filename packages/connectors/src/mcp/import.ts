import { isAbsolute } from "node:path";
import { checkMcpDefinition, MCP_DEFAULT_LIMITS, MCP_RESERVED_ENV, MCP_RESERVED_HEADERS, type McpLimits, type McpServerDefinition, type McpValue } from "./definition.js";
import { McpConnectorError } from "./errors.js";
import { parseToml, type TomlTable } from "./toml.js";

/**
 * Import preview of MCP server configuration content the owner hands in explicitly (pasted or picked file
 * content). Nothing is read from disk, executed, expanded or resolved here: no command runs, no `${VAR}` is
 * looked up in this process's environment, no OAuth state is inherited, no helper runs.
 *
 * Secret safety: the preview never contains an environment value, header value, URL query/userinfo or an
 * argument that looks like a credential. Every env and header value becomes a broker secret slot, whatever
 * its source (a `${VAR}` reference, a template or a literal), because a literal in a personal config is often
 * the token itself. The owner then stores the values in the broker; the draft names only slot keys.
 */
export type McpImportFormat = "claude_json" | "codex_toml";
export type McpImportStatus = "ready_for_review" | "needs_credentials" | "needs_auth" | "needs_review" | "unsupported" | "invalid";
export interface McpCredentialSlot {
  /** Broker key the draft refers to. */
  key: string;
  target: "env" | "header";
  /** Env variable or header name (names are configuration, not secrets). */
  name: string;
  /** How the source supplied it. The value itself is never part of the preview. */
  from: "env_reference" | "template" | "literal_value" | "bearer_env_var" | "forwarded_env" | "env_header";
}
export interface McpImportedServer {
  sourceName: string;
  proposedId: string | null;
  transport: "stdio" | "streamable_http" | "sse" | "unknown";
  status: McpImportStatus;
  enabled: boolean;
  /** Program as written (no expansion). Null for HTTP. */
  command: string | null;
  argCount: number;
  /** Positions of arguments withheld because they look like credentials. */
  redactedArgs: number[];
  /** Scheme, host, port and path only. */
  endpoint: string | null;
  credentialSlots: McpCredentialSlot[];
  auth: "none_declared" | "static_credentials" | "oauth_declared";
  /** Fixed-vocabulary notes, never input content. */
  notes: string[];
  /** Validated definition the owner may adopt after review; null when it cannot be built safely. */
  draft: McpServerDefinition | null;
}
export interface McpImportPreview {
  format: McpImportFormat;
  servers: McpImportedServer[];
  notes: string[];
}

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_SERVERS = 128;
const SOURCE_NAME = /^[^\u0000-\u001f\u007f]{1,120}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}$/;
const SCHEME_PREFIX = /^([A-Za-z]{1,20} )\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const SECRETISH_NAME = /token|secret|passw|pwd|api[-_]?key|apikey|access[-_]?key|auth|bearer|credential|private[-_]?key|session|cookie/i;
const TOKEN_SHAPES = /^(?:gh[pousr]_|github_pat_|sk-|sk_live_|sk_test_|rk_live_|xox[abprs]-|AKIA|ASIA|AIza|glpat-|ya29\.|eyJ[A-Za-z0-9_-]{8,}\.)/;
const HIGH_ENTROPY = /^[A-Za-z0-9_+=-]{32,}$/;

const has = (o: Record<string, unknown>, k: string): boolean => Object.hasOwn(o, k);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readClaude(text: string): Record<string, unknown> {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) throw new McpConnectorError("import_invalid", "claude_json:size");
  let doc: unknown;
  // The parser's own message can quote the input (and so a token): it is dropped on purpose.
  try { doc = JSON.parse(text); } catch { throw new McpConnectorError("import_invalid", "claude_json:syntax"); }
  if (!isObject(doc)) throw new McpConnectorError("import_invalid", "claude_json:not_object");
  // Only `mcpServers` is read. Any other top-level content (account, projects, history) is ignored unread.
  if (!has(doc, "mcpServers")) throw new McpConnectorError("import_unsupported", "claude_json:no_mcpServers");
  if (!isObject(doc.mcpServers)) throw new McpConnectorError("import_invalid", "claude_json:mcpServers");
  return doc.mcpServers;
}

/** Preview of Claude Code `.mcp.json` / user-scope `mcpServers` (also the Claude Desktop shape). */
export function previewClaudeMcpJson(text: string): McpImportPreview {
  const servers = readClaude(text);
  return build("claude_json", Object.entries(servers), claudeEntry);
}

/** Preview of the `[mcp_servers.*]` tables of Codex `config.toml` content. */
export function previewCodexToml(text: string): McpImportPreview {
  const doc = parseToml(text);
  if (!has(doc, "mcp_servers")) throw new McpConnectorError("import_unsupported", "codex_toml:no_mcp_servers");
  if (!isObject(doc.mcp_servers)) throw new McpConnectorError("import_invalid", "codex_toml:mcp_servers");
  return build("codex_toml", Object.entries(doc.mcp_servers as TomlTable), codexEntry);
}

interface Draft {
  transport: McpImportedServer["transport"];
  enabled: boolean;
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  env: Record<string, McpValue>;
  headers: Record<string, McpValue>;
  slots: McpCredentialSlot[];
  auth: McpImportedServer["auth"];
  enabledTools: string[] | null;
  disabledTools: string[];
  limits: Partial<McpLimits>;
  notes: Set<string>;
  blocked: boolean;
  hidden: number[];
  status: McpImportStatus | null;
}
type EntryReader = (raw: Record<string, unknown>, d: Draft) => void;

function build(format: McpImportFormat, entries: [string, unknown][], read: EntryReader): McpImportPreview {
  const notes: string[] = [];
  if (entries.length > MAX_SERVERS) { notes.push("too_many_servers_truncated"); entries = entries.slice(0, MAX_SERVERS); }
  const ids = new Set<string>();
  const servers = entries.map(([name, raw]): McpImportedServer => {
    const d: Draft = {
      transport: "unknown", enabled: true, command: null, args: [], cwd: null, url: null, env: {}, headers: {}, slots: [],
      auth: "none_declared", enabledTools: null, disabledTools: [], limits: {}, notes: new Set(), blocked: false, hidden: [], status: null,
    };
    const sourceName = SOURCE_NAME.test(name) ? name : "(unnamed)";
    if (!SOURCE_NAME.test(name)) return finish(format, sourceName, null, d, "invalid", "server_name_invalid");
    if (!isObject(raw)) return finish(format, sourceName, null, d, "invalid", "server_entry_not_object");
    read(raw, d);
    const id = proposeId(name, ids);
    return finish(format, sourceName, id, d, d.status, null);
  });
  return { format, servers, notes };
}

function finish(format: McpImportFormat, sourceName: string, id: string | null, d: Draft, forced: McpImportStatus | null, note: string | null): McpImportedServer {
  if (note) d.notes.add(note);
  let status: McpImportStatus = forced
    ?? (d.blocked ? "needs_review" : d.auth === "oauth_declared" ? "needs_auth" : d.slots.length > 0 ? "needs_credentials" : "ready_for_review");
  let draft: McpServerDefinition | null = null;
  if (id !== null && (status === "ready_for_review" || status === "needs_credentials" || status === "needs_auth")) {
    try {
      draft = checkMcpDefinition({
        id, name: sourceName,
        transport: d.transport === "stdio"
          ? { type: "stdio", command: d.command, args: d.args, cwd: d.cwd, env: d.env }
          : { type: "streamable_http", url: d.url, headers: d.headers },
        // A local server stays on the machine it was imported from; HTTP is reachable from either host.
        runsOn: d.transport === "stdio" ? "owner_mac" : "any",
        auth: d.auth === "oauth_declared" ? "oauth" : d.slots.length > 0 ? "broker" : "none",
        enabledTools: d.enabledTools, disabledTools: d.disabledTools,
        limits: { ...MCP_DEFAULT_LIMITS, ...d.limits },
        source: { format, name: sourceName },
      });
    } catch (error) {
      if (!(error instanceof McpConnectorError)) throw error;
      d.notes.add(`draft_refused:${error.detail ?? "definition"}`);
      status = "needs_review";
    }
  }
  return {
    sourceName, proposedId: id, transport: d.transport, status, enabled: d.enabled,
    command: d.transport === "stdio" ? d.command : null, argCount: d.args.length, redactedArgs: d.hidden,
    endpoint: d.url === null ? null : endpointOf(d.url), credentialSlots: d.slots, auth: d.auth,
    notes: [...d.notes].sort(), draft,
  };
}

function proposeId(name: string, taken: Set<string>): string {
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 34).replace(/-+$/, "");
  if (!/^[a-z]/.test(base)) base = `s-${base}`.replace(/-+$/, "");
  if (base === "s") base = "server";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}
function endpointOf(url: string): string {
  try { const u = new URL(url); return `${u.protocol}//${u.host}${u.pathname}`; } catch { return "(invalid)"; }
}

// ---- shared field readers ------------------------------------------------------------------------

function readCommand(raw: unknown, d: Draft): void {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024) { d.notes.add("command_invalid"); d.status = "invalid"; return; }
  if (raw.includes("${")) { d.notes.add("command_uses_variable_not_expanded"); d.blocked = true; }
  // Absolute executable paths can contain spaces (for example inside a macOS .app). The transport
  // passes command and args separately to spawn without a shell; whitespace is ambiguous only for
  // bare command strings. Shell syntax and variable expansion still require explicit review.
  if ((!isAbsolute(raw) && /\s/.test(raw.trim())) || /[;&|`$<>]/.test(raw.replace(/\$\{[^}]*\}/g, ""))) { d.notes.add("command_looks_like_shell_line"); d.blocked = true; }
  if (!isAbsolute(raw)) d.notes.add("bare_command_resolves_only_in_searchPath");
  d.command = raw;
}
/** Heuristic for arguments that look like credentials (withheld by import, refused when an owner stores a definition). */
export function looksSecret(arg: string, previous: string | undefined): boolean {
  const eq = /^--?([A-Za-z0-9_.-]+)=(.+)$/.exec(arg);
  if (eq && SECRETISH_NAME.test(eq[1]!)) return true;
  if (previous !== undefined && /^--?[A-Za-z0-9_.-]+$/.test(previous) && SECRETISH_NAME.test(previous) && !arg.startsWith("-")) return true;
  if (TOKEN_SHAPES.test(arg) || /:\/\/[^/@\s]+:[^/@\s]+@/.test(arg)) return true;
  return HIGH_ENTROPY.test(arg) && /[0-9]/.test(arg) && /[A-Za-z]/.test(arg);
}
function readArgs(raw: unknown, d: Draft): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw) || !raw.every((a) => typeof a === "string")) { d.notes.add("args_invalid"); d.status = "invalid"; return; }
  const hidden: number[] = [];
  raw.forEach((arg, i) => { if (looksSecret(arg, raw[i - 1] as string | undefined)) hidden.push(i); });
  if (hidden.length > 0) {
    // The draft would have to carry the value: it is not built. The owner moves it into a secret env/header.
    d.notes.add("argument_looks_like_credential_withheld");
    d.blocked = true;
    d.hidden = hidden;
  }
  if (raw.some((a) => (a as string).includes("${"))) { d.notes.add("args_use_variable_not_expanded"); d.blocked = true; }
  d.args = hidden.length > 0 ? raw.map((a, i) => (hidden.includes(i) ? "" : a as string)) : [...raw as string[]];
}
function readUrl(raw: unknown, d: Draft): void {
  if (typeof raw !== "string" || raw.length > 2048) { d.notes.add("url_invalid"); d.status = "invalid"; return; }
  if (raw.includes("${")) { d.notes.add("url_uses_variable_not_expanded"); d.blocked = true; d.url = raw.replace(/\$\{[^}]*\}/g, "var"); return; }
  let u: URL;
  try { u = new URL(raw); } catch { d.notes.add("url_invalid"); d.status = "invalid"; return; }
  if (u.username || u.password) { d.notes.add("url_userinfo_withheld"); d.blocked = true; }
  if (u.search) { d.notes.add("url_query_withheld"); d.blocked = true; }
  if (u.hash) d.notes.add("url_fragment_dropped");
  d.url = `${u.protocol}//${u.host}${u.pathname}`;
}
const slotKey = (target: "env" | "header", name: string): string => `${target}.${name.toLowerCase().replace(/[^a-z0-9_.-]/g, "_")}`.slice(0, 64);

/** Turns one env or header value into a secret slot, recording only how it was supplied. */
function slotFor(target: "env" | "header", name: string, value: unknown, d: Draft): McpValue | null {
  if (typeof value !== "string") { d.notes.add(`${target}_value_invalid`); d.blocked = true; return null; }
  const key = slotKey(target, name);
  const ref = REFERENCE.exec(value);
  const scheme = target === "header" ? SCHEME_PREFIX.exec(value) : null;
  const from: McpCredentialSlot["from"] = ref ? "env_reference" : scheme ? "env_reference" : value.includes("${") ? "template" : "literal_value";
  d.slots.push({ key, target, name, from });
  if (from === "template") d.notes.add(`${target}_template_needs_full_value_in_broker`);
  return scheme ? { kind: "secret", key, prefix: scheme[1]! } : { kind: "secret", key };
}
function readEnv(raw: unknown, d: Draft): void {
  if (raw === undefined) return;
  if (!isObject(raw)) { d.notes.add("env_invalid"); d.blocked = true; return; }
  for (const [name, value] of Object.entries(raw)) {
    if (!ENV_NAME.test(name) || MCP_RESERVED_ENV.has(name)) { d.notes.add("env_name_refused"); d.blocked = true; continue; }
    const slot = slotFor("env", name, value, d);
    if (slot) d.env[name] = slot;
  }
}
function readHeaders(raw: unknown, d: Draft): void {
  if (raw === undefined) return;
  if (!isObject(raw)) { d.notes.add("headers_invalid"); d.blocked = true; return; }
  for (const [name, value] of Object.entries(raw)) {
    if (!HEADER_NAME.test(name) || MCP_RESERVED_HEADERS.has(name.toLowerCase())) { d.notes.add("header_name_refused"); d.blocked = true; continue; }
    const slot = slotFor("header", name.toLowerCase(), value, d);
    if (slot) d.headers[name.toLowerCase()] = slot;
  }
}
function readToolList(raw: unknown, d: Draft, field: "enabledTools" | "disabledTools"): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw) || !raw.every((n) => typeof n === "string" && n.length > 0 && n.length <= 128)) { d.notes.add(`${field}_invalid`); d.blocked = true; return; }
  if (field === "enabledTools") d.enabledTools = [...raw as string[]]; else d.disabledTools = [...raw as string[]];
}
function noteUnknown(raw: Record<string, unknown>, known: readonly string[], d: Draft): void {
  if (Object.keys(raw).some((k) => !known.includes(k))) d.notes.add("unknown_fields_ignored");
}

// ---- Claude Code / Claude Desktop ----------------------------------------------------------------

const CLAUDE_KEYS = ["type", "command", "args", "env", "url", "headers", "oauth", "headersHelper", "cwd", "timeout", "disabled"];
const claudeEntry: EntryReader = (raw, d) => {
  noteUnknown(raw, CLAUDE_KEYS, d);
  const type = raw.type ?? (has(raw, "command") ? "stdio" : has(raw, "url") ? "http" : undefined);
  if (raw.disabled === true) { d.enabled = false; d.notes.add("disabled_in_source"); }
  if (type === "stdio") {
    d.transport = "stdio";
    readCommand(raw.command, d);
    readArgs(raw.args, d);
    readEnv(raw.env, d);
    if (raw.cwd !== undefined) {
      if (typeof raw.cwd === "string" && isAbsolute(raw.cwd) && !raw.cwd.includes("${")) d.cwd = raw.cwd;
      else { d.notes.add("cwd_not_absolute"); d.blocked = true; }
    }
  } else if (type === "http" || type === "streamable-http" || type === "streamable_http") {
    d.transport = "streamable_http";
    readUrl(raw.url, d);
    readHeaders(raw.headers, d);
  } else if (type === "sse") {
    d.transport = "sse";
    d.status = "unsupported";
    d.notes.add("sse_transport_deprecated_unsupported");
    return;
  } else {
    d.status = type === undefined ? "invalid" : "unsupported";
    d.notes.add(type === undefined ? "transport_missing" : "transport_unsupported");
    return;
  }
  if (raw.headersHelper !== undefined) { d.notes.add("headers_helper_is_a_command_not_executed"); d.blocked = true; }
  if (raw.oauth !== undefined) { d.auth = "oauth_declared"; d.notes.add("oauth_config_not_imported"); }
  if (d.auth !== "oauth_declared" && d.slots.length > 0) d.auth = "static_credentials";
  if (typeof raw.timeout === "number" && Number.isSafeInteger(raw.timeout) && raw.timeout > 0 && raw.timeout <= 600_000) d.limits.callTimeoutMs = raw.timeout;
};

// ---- Codex --------------------------------------------------------------------------------------

const CODEX_KEYS = [
  "command", "args", "env", "env_vars", "cwd", "url", "bearer_token_env_var", "http_headers", "env_http_headers", "enabled", "required",
  "startup_timeout_sec", "startup_timeout_ms", "tool_timeout_sec", "enabled_tools", "disabled_tools", "scopes", "oauth_resource",
];
const seconds = (v: unknown, max: number): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && v * 1000 <= max ? Math.round(v * 1000) : null;
const codexEntry: EntryReader = (raw, d) => {
  noteUnknown(raw, CODEX_KEYS, d);
  if (raw.enabled === false) { d.enabled = false; d.notes.add("disabled_in_source"); }
  if (has(raw, "command") && has(raw, "url")) { d.status = "invalid"; d.notes.add("both_command_and_url"); return; }
  if (has(raw, "command")) {
    d.transport = "stdio";
    readCommand(raw.command, d);
    readArgs(raw.args, d);
    readEnv(raw.env, d);
    if (raw.env_vars !== undefined) {
      if (!Array.isArray(raw.env_vars) || !raw.env_vars.every((n) => typeof n === "string" && ENV_NAME.test(n) && !MCP_RESERVED_ENV.has(n))) { d.notes.add("env_vars_invalid"); d.blocked = true; }
      else for (const name of raw.env_vars as string[]) {
        // Forwarding the importing user's variable is never done; the value becomes a broker secret.
        if (Object.hasOwn(d.env, name)) continue;
        const key = slotKey("env", name);
        d.slots.push({ key, target: "env", name, from: "forwarded_env" });
        d.env[name] = { kind: "secret", key };
      }
    }
    if (raw.cwd !== undefined) {
      if (typeof raw.cwd === "string" && isAbsolute(raw.cwd)) d.cwd = raw.cwd;
      else { d.notes.add("cwd_not_absolute"); d.blocked = true; }
    }
  } else if (has(raw, "url")) {
    d.transport = "streamable_http";
    readUrl(raw.url, d);
    readHeaders(raw.http_headers, d);
    if (raw.env_http_headers !== undefined) {
      if (!isObject(raw.env_http_headers)) { d.notes.add("env_http_headers_invalid"); d.blocked = true; }
      else for (const [name, variable] of Object.entries(raw.env_http_headers)) {
        const header = name.toLowerCase();
        if (!HEADER_NAME.test(name) || MCP_RESERVED_HEADERS.has(header) || typeof variable !== "string") { d.notes.add("header_name_refused"); d.blocked = true; continue; }
        const key = slotKey("header", header);
        d.slots.push({ key, target: "header", name: header, from: "env_header" });
        d.headers[header] = { kind: "secret", key };
      }
    }
    if (raw.bearer_token_env_var !== undefined) {
      if (typeof raw.bearer_token_env_var !== "string" || !ENV_NAME.test(raw.bearer_token_env_var) || Object.hasOwn(d.headers, "authorization")) {
        d.notes.add("bearer_token_env_var_invalid"); d.blocked = true;
      } else {
        const key = slotKey("header", "authorization");
        d.slots.push({ key, target: "header", name: "authorization", from: "bearer_env_var" });
        d.headers.authorization = { kind: "secret", key, prefix: "Bearer " };
      }
    }
    // Codex keeps OAuth tokens from `codex mcp login` in its own store; none of it is read or inherited.
    if (raw.scopes !== undefined || raw.oauth_resource !== undefined) { d.auth = "oauth_declared"; d.notes.add("oauth_config_not_imported"); }
  } else {
    d.status = "invalid";
    d.notes.add("transport_missing");
    return;
  }
  if (d.auth !== "oauth_declared" && d.slots.length > 0) d.auth = "static_credentials";
  readToolList(raw.enabled_tools, d, "enabledTools");
  readToolList(raw.disabled_tools, d, "disabledTools");
  const startup = seconds(raw.startup_timeout_sec, 120_000) ?? (typeof raw.startup_timeout_ms === "number" && raw.startup_timeout_ms > 0 && raw.startup_timeout_ms <= 120_000 ? Math.round(raw.startup_timeout_ms) : null);
  if (startup !== null) d.limits.connectTimeoutMs = startup;
  const tool = seconds(raw.tool_timeout_sec, 600_000);
  if (tool !== null) d.limits.callTimeoutMs = tool;
};
