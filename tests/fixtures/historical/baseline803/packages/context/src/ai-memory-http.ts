import { createHash, randomInt } from "node:crypto";
import { inspect } from "node:util";
import type { AiMemorySearchCall, AiMemoryTransport } from "./adapters.js";
import type { ServiceHit, ServiceScope } from "./types.js";

/**
 * Host-only HTTP client for a pinned ai-memory v2.5.2 service. Reads use `/api/v1` (search + exact page GET); the only
 * write is the MCP `memory_write_page` tool with explicit workspace/project/path/body. No global search/write, cwd,
 * hooks, sessions, redirects, retries or dynamic URLs. Credentials come from a trusted closure and live only in
 * private fields; errors never carry upstream bodies, URLs or headers.
 *
 * Writes additionally require a trusted `isolation` attestation: v2.5.2 forces the reserved projects `_global` and
 * `scratch` Open to every authenticated user, may create ordinary projects Open, and an `aim_` key alone cannot restrict
 * them. Without that host-config attestation `writePage` fails before any network effect.
 */
export type AiMemoryHttpErrorCode = "config" | "closed" | "timeout" | "network" | "http_status" | "protocol" | "too_large" | "isolation";
export class AiMemoryHttpError extends Error {
  constructor(readonly code: AiMemoryHttpErrorCode, readonly status: number | null = null) {
    super(status === null ? `ai-memory ${code}` : `ai-memory ${code} ${status}`); this.name = "AiMemoryHttpError";
  }
}
export type AiMemoryFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface AiMemoryHttpOptions {
  /** `https://host[:port]` only; no path, query, fragment or userinfo. */
  origin: string;
  /** Trusted closure returning a native user-level `aim_` key. Never the root token, never engine/UI supplied. */
  credential?: () => string;
  /** FOR THE LOCAL SYNTHETIC LAB ONLY: plain HTTP to a literal loopback IP with upstream auth disabled. */
  labLoopbackWithoutAuth?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Trusted test seam; defaults to global fetch. */
  fetch?: AiMemoryFetch;
  /**
   * Trusted HOST CONFIG statement (never engine/UI supplied) that this exact origin is one ai-memory deployment used
   * exclusively by this Dexter owner: a dedicated single-owner host/VPS, or the synthetic loopback lab. It is not remote
   * ACL verification, and an `aim_` credential is never evidence of it. Shared/Teams servers are unsupported. Required
   * for `writePage`; `AiMemorySync` also binds it to the HostStore installation and owner.
   */
  isolation?: { mode: "owner_exclusive_deployment"; origin: string; installationId: string; ownerId: string };
}
export interface AiMemoryPageRef extends ServiceScope { path: string }
export type AiMemoryPageRead = { kind: "found"; markdown: string; sha256: string } | { kind: "missing" };
export interface AiMemoryCallOptions { signal?: AbortSignal }

export const AI_MEMORY_VERSION = "2.5.2";
export const AI_MEMORY_MCP_PROTOCOL = "2024-11-05";
const SCOPE_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const PAGE_PATH = /^notes\/[A-Za-z0-9_-]{1,160}\.md$/;
const USER_KEY = /^aim_[A-Za-z0-9_-]{43}$/;
const MAX_BODY_BYTES = 262_144;
/** v2.5.2 `initial_access_mode` forces these project names Open regardless of workspace or `new_projects_restricted`. */
export const AI_MEMORY_RESERVED_OPEN_PROJECTS: readonly string[] = Object.freeze(["_global", "scratch"]);
const ATTESTATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

const fail = (code: AiMemoryHttpErrorCode, status: number | null = null): never => { throw new AiMemoryHttpError(code, status); };
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail("protocol"));
function scopeOf(value: unknown): ServiceScope {
  const row = record(value);
  if (typeof row.workspace !== "string" || typeof row.project !== "string" || !SCOPE_NAME.test(row.workspace) || !SCOPE_NAME.test(row.project)) fail("config");
  return { workspace: row.workspace as string, project: row.project as string };
}
function pageRef(value: AiMemoryPageRef): AiMemoryPageRef {
  const scope = scopeOf(value);
  if (typeof value.path !== "string" || !PAGE_PATH.test(value.path)) fail("config");
  return { ...scope, path: value.path };
}
function parseOrigin(raw: unknown, lab: boolean): string {
  if (typeof raw !== "string" || raw.length > 512 || /[?#@\\\s]/.test(raw)) return fail("config");
  let url: URL;
  try { url = new URL(raw); } catch { return fail("config"); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || raw.replace(/\/$/, "") !== url.origin) fail("config");
  if (lab) { if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") || url.port === "") fail("config"); }
  else if (url.protocol !== "https:") fail("config");
  return url.origin;
}
const bounded = (value: unknown, fallback: number, min: number, max: number): number => {
  const result = value ?? fallback;
  return typeof result === "number" && Number.isInteger(result) && result >= min && result <= max ? result : fail("config");
};

export class AiMemoryHttpClient {
  readonly origin: string;
  readonly auth: "aim_user_key" | "lab_loopback_none";
  readonly isolation: Readonly<NonNullable<AiMemoryHttpOptions["isolation"]>> | null;
  readonly #credential: (() => string) | null;
  readonly #fetch: AiMemoryFetch;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #inflight = new Set<{ controller: AbortController; settled: Promise<unknown> }>();
  #closed = false;
  constructor(options: AiMemoryHttpOptions) {
    const lab = options.labLoopbackWithoutAuth === true;
    if (options.labLoopbackWithoutAuth !== undefined && typeof options.labLoopbackWithoutAuth !== "boolean") fail("config");
    if (lab === (options.credential !== undefined) || (options.credential !== undefined && typeof options.credential !== "function")) fail("config");
    this.origin = parseOrigin(options.origin, lab);
    this.auth = lab ? "lab_loopback_none" : "aim_user_key";
    this.isolation = options.isolation === undefined ? null : AiMemoryHttpClient.#attestation(options.isolation, this.origin);
    this.#credential = options.credential ?? null;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = bounded(options.timeoutMs, 10_000, 1, 120_000);
    this.#maxBytes = bounded(options.maxResponseBytes, 1_048_576, 1_024, 8_388_608);
  }
  static #attestation(raw: unknown, origin: string): Readonly<NonNullable<AiMemoryHttpOptions["isolation"]>> {
    const row = record(raw);
    if (Object.keys(row).sort().join() !== "installationId,mode,origin,ownerId" || row.mode !== "owner_exclusive_deployment") fail("config");
    if (row.origin !== origin) fail("config"); // bound to this exact origin, never a neighbour
    for (const key of ["installationId", "ownerId"]) if (typeof row[key] !== "string" || !ATTESTATION_ID.test(row[key] as string)) fail("config");
    return Object.freeze({ mode: "owner_exclusive_deployment", origin, installationId: row.installationId as string, ownerId: row.ownerId as string });
  }
  toJSON(): { origin: string; auth: AiMemoryHttpClient["auth"]; isolation: "owner_exclusive_deployment" | "unattested" } {
    return { origin: this.origin, auth: this.auth, isolation: this.isolation ? this.isolation.mode : "unattested" };
  }
  [inspect.custom](): string { return `AiMemoryHttpClient(${this.origin}, ${this.auth}, ${this.isolation ? this.isolation.mode : "unattested"})`; }

  /** Aborts every request this client owns and resolves once each one has settled locally. A server-side late effect remains possible. */
  async close(): Promise<void> {
    this.#closed = true;
    const owned = [...this.#inflight];
    for (const request of owned) request.controller.abort();
    await Promise.allSettled(owned.map(request => request.settled));
  }

  async #request(method: "GET" | "POST", path: string, payload: unknown, accept: string, options: AiMemoryCallOptions):
    Promise<{ status: number; contentType: string; text: string; sessionId: boolean }> {
    if (this.#closed || options.signal?.aborted) fail("closed");
    const headers: Record<string, string> = { Accept: accept };
    if (this.#credential) {
      let key: unknown;
      try { key = this.#credential(); } catch { return fail("config"); }
      if (typeof key !== "string" || !USER_KEY.test(key)) fail("config");
      headers.Authorization = `Bearer ${key as string}`;
    }
    let body: string | undefined;
    if (payload !== undefined) {
      body = JSON.stringify(payload); headers["Content-Type"] = "application/json";
      if (Buffer.byteLength(body) > MAX_BODY_BYTES * 2) fail("too_large");
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    const relay = () => controller.abort();
    options.signal?.addEventListener("abort", relay, { once: true });
    const run = (async () => {
      let response: Response;
      try {
        response = await this.#fetch(`${this.origin}${path}`, { method, headers, ...(body === undefined ? {} : { body }), redirect: "manual", signal: controller.signal, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
      } catch { return fail(timedOut ? "timeout" : controller.signal.aborted ? "closed" : "network"); }
      try {
        if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) fail("http_status", response.status);
        const declared = Number(response.headers.get("content-length") ?? "0");
        if (!Number.isFinite(declared) || declared > this.#maxBytes) fail("too_large");
        const chunks: Uint8Array[] = []; let size = 0;
        if (response.body) {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > this.#maxBytes) { await reader.cancel().catch(() => undefined); fail("too_large"); }
            chunks.push(value);
          }
        }
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); } catch { return fail("protocol"); }
        return { status: response.status, contentType: (response.headers.get("content-type") ?? "").toLowerCase(), text, sessionId: response.headers.has("mcp-session-id") };
      } catch (error) {
        try { await response.body?.cancel(); } catch { /* already consumed */ }
        if (error instanceof AiMemoryHttpError) throw error;
        return fail(timedOut ? "timeout" : controller.signal.aborted ? "closed" : "network");
      }
    })();
    const entry = { controller, settled: run.catch(() => undefined) };
    this.#inflight.add(entry);
    try { return await run; }
    finally { clearTimeout(timer); options.signal?.removeEventListener("abort", relay); this.#inflight.delete(entry); }
  }
  async #json(method: "GET" | "POST", path: string, payload: unknown, options: AiMemoryCallOptions, accept = "application/json") {
    const response = await this.#request(method, path, payload, accept, options);
    let json: unknown = null;
    if (response.text.length > 0) {
      if (!response.contentType.startsWith("application/json")) fail("protocol", response.status);
      try { json = JSON.parse(response.text); } catch { fail("protocol", response.status); }
    }
    return { ...response, json };
  }
  /** A 404 counts as "missing" only when it is the route's own JSON `{error}` body, never a router/proxy fallback. */
  static #missing(response: { status: number; json: unknown }): boolean {
    return response.status === 404 && !!response.json && typeof response.json === "object" && typeof (response.json as Record<string, unknown>).error === "string";
  }

  /** Transport for `AiMemoryReadAdapter`. Each explicit scope is searched separately because upstream rejects the whole
   * multi-scope request when any scope is not yet provisioned; hits are merged by upstream rank like its own scoped merge. */
  get transport(): AiMemoryTransport { return call => this.search(call); }
  async search(call: AiMemorySearchCall, options: AiMemoryCallOptions = {}): Promise<ServiceHit[]> {
    const request = record(call); const body = record(request.body);
    if (request.method !== "POST" || request.path !== "/api/v1/search" || Object.keys(request).length !== 3 || Object.keys(body).some(key => !["q", "scopes", "limit"].includes(key))) fail("config");
    const q = body.q; const limit = body.limit;
    if (typeof q !== "string" || q.trim().length === 0 || q.length > 2_000 || !q.isWellFormed()) fail("config");
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) fail("config");
    if (!Array.isArray(body.scopes) || body.scopes.length === 0 || body.scopes.length > 25) fail("config");
    const scopes = [...new Map((body.scopes as unknown[]).map(scopeOf).map(s => [`${s.workspace}\u0000${s.project}`, s])).values()];
    const hits = new Map<string, ServiceHit & { rank: number; order: number }>();
    for (const scope of scopes) {
      const response = await this.#json("POST", "/api/v1/search", { q, scopes: [scope], limit }, options);
      if (AiMemoryHttpClient.#missing(response)) continue;
      if (response.status !== 200) fail("http_status", response.status);
      if (!Array.isArray(response.json) || response.json.length > 100) fail("protocol");
      for (const raw of response.json as unknown[]) {
        const row = record(raw);
        if (["workspace", "project", "path"].some(key => typeof row[key] !== "string" || (row[key] as string).length > 512)) fail("protocol");
        if (row.workspace !== scope.workspace || row.project !== scope.project) fail("protocol"); // never accept a foreign-scope hit
        if (typeof row.rank !== "number" || !Number.isFinite(row.rank)) fail("protocol");
        const key = `${scope.workspace}\u0000${scope.project}\u0000${row.path as string}`;
        const existing = hits.get(key);
        if (!existing || (row.rank as number) < existing.rank) hits.set(key, { ...scope, path: row.path as string, rank: row.rank as number, order: existing?.order ?? hits.size });
      }
    }
    return [...hits.values()].sort((a, b) => a.rank - b.rank || a.order - b.order).slice(0, limit as number)
      .map(({ workspace, project, path }) => ({ workspace, project, path })); // titles/snippets never leave this client
  }

  /** Exact page GET. Verifies the echoed scope/path and returns the SHA-256 of the full UTF-8 Markdown body. */
  async getPage(ref: AiMemoryPageRef, options: AiMemoryCallOptions = {}): Promise<AiMemoryPageRead> {
    const target = pageRef(ref);
    const response = await this.#json("GET", `/api/v1/workspaces/${target.workspace}/projects/${target.project}/pages/${target.path}`, undefined, options);
    if (AiMemoryHttpClient.#missing(response)) return { kind: "missing" };
    if (response.status !== 200) fail("http_status", response.status);
    const page = record(response.json);
    if (page.workspace !== target.workspace || page.project !== target.project || page.path !== target.path) fail("protocol");
    if (typeof page.body_markdown !== "string" || !page.body_markdown.isWellFormed()) fail("protocol");
    const markdown = page.body_markdown as string;
    return { kind: "found", markdown, sha256: createHash("sha256").update(markdown, "utf8").digest("hex") };
  }

  async #rpc(method: string, params: unknown, options: AiMemoryCallOptions): Promise<Record<string, unknown>> {
    const rpcId = randomInt(1, 2 ** 31);
    const response = await this.#json("POST", "/mcp", { jsonrpc: "2.0", id: rpcId, method, params }, options, "application/json, text/event-stream");
    if (response.sessionId) fail("protocol"); // stateless JSON transport only
    if (response.status !== 200) fail("http_status", response.status);
    const envelope = record(response.json);
    if (envelope.jsonrpc !== "2.0" || envelope.id !== rpcId || envelope.error !== undefined) fail("protocol");
    return record(envelope.result);
  }
  /** Verifies stateless MCP `initialize` reports ai-memory 2.5.2 / protocol 2024-11-05, then sends `notifications/initialized` (202). */
  async initialize(options: AiMemoryCallOptions = {}): Promise<{ name: "ai-memory"; version: typeof AI_MEMORY_VERSION; protocolVersion: typeof AI_MEMORY_MCP_PROTOCOL }> {
    const result = await this.#rpc("initialize", { protocolVersion: AI_MEMORY_MCP_PROTOCOL, capabilities: {}, clientInfo: { name: "dexter-host", version: "0.0.1" } }, options);
    const server = record(result.serverInfo);
    if (result.protocolVersion !== AI_MEMORY_MCP_PROTOCOL || server.name !== "ai-memory" || server.version !== AI_MEMORY_VERSION) fail("protocol");
    const notified = await this.#request("POST", "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, "application/json, text/event-stream", options);
    if (notified.status !== 202 || notified.sessionId) fail("protocol", notified.status);
    return { name: "ai-memory", version: AI_MEMORY_VERSION, protocolVersion: AI_MEMORY_MCP_PROTOCOL };
  }
  /**
   * One `memory_write_page` call with explicit workspace/project/path/body (never `scope:"global"`, cwd or session).
   * The acknowledgement is NOT a content confirmation and the tool has no idempotency key: callers must verify by exact GET.
   * Refused before any request without an owner-exclusive attestation or when targeting a reserved always-Open project.
   */
  async writePage(ref: AiMemoryPageRef, markdown: string, options: AiMemoryCallOptions = {}): Promise<{ pageId: string }> {
    const target = pageRef(ref);
    if (this.isolation === null || AI_MEMORY_RESERVED_OPEN_PROJECTS.includes(target.project)) fail("isolation");
    if (typeof markdown !== "string" || markdown.length === 0 || !markdown.isWellFormed() || Buffer.byteLength(markdown) > MAX_BODY_BYTES) fail("config");
    const result = await this.#rpc("tools/call", { name: "memory_write_page", arguments: { workspace: target.workspace, project: target.project, path: target.path, body: markdown } }, options);
    if (result.isError === true || !Array.isArray(result.content)) fail("protocol");
    const first = record((result.content as unknown[])[0]);
    if (first.type !== "text" || typeof first.text !== "string") fail("protocol");
    let payload: Record<string, unknown>;
    try { payload = record(JSON.parse(first.text as string)); } catch { return fail("protocol"); }
    if (typeof payload.page_id !== "string" || payload.page_id.length > 128 || payload.path !== target.path) fail("protocol");
    if (payload.checkpoint !== undefined && payload.checkpoint !== null && typeof payload.checkpoint !== "string") fail("protocol");
    return { pageId: payload.page_id as string };
  }
}
