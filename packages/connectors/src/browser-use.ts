import { BrowserUseBotPolicySchema, type BrowserUseBotPolicy } from "@dexter/contracts";
import type { FetchLike } from "./http.js";

export const BROWSER_USE_API = "https://api.browser-use.com/api/v2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET = /(?:\b(?:sk-|sk_live_|sk_test_|github_pat_|gh[pousr]_|xox[abprs]-|glpat-|AIza|AKIA|ASIA|ya29\.)[A-Za-z0-9_+=./-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|passphrase)\s*[:=]\s*["']?(?:Bearer\s+)?[A-Za-z0-9_+=./-]{12,})/i;

export class BrowserUseError extends Error {
  constructor(readonly code: "locked" | "busy" | "invalid_input" | "transport_unknown" | "provider_refused" | "invalid_response" | "cancelled") {
    super(`Browser Use unavailable: ${code}.`); this.name = "BrowserUseError";
  }
}
export const browserUseContainsSecret = (value: string): boolean => SECRET.test(value);

/** A trusted executor-only lease. Never put this object in a status, receipt or log. */
export interface BrowserUseKeyLease { readonly key: string; readonly generation: number; assertCurrent(): void }

/** Process-only, expiring custody. It never reads configuration, accounts, environment variables or files. */
export class BrowserUseKeyVault {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #hooks = new Set<() => Promise<void>>();
  #key: string | null = null;
  #expiresAt: number | null = null;
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #locking: Promise<void> | null = null;
  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? 3_600_000; this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1 || this.#ttlMs > 43_200_000) throw new BrowserUseError("invalid_input");
  }
  #expire(): void { if (this.#expiresAt !== null && this.#now() >= this.#expiresAt) void this.lock(); }
  status(): { unlocked: boolean; expiresAt: number | null } {
    this.#expire(); return { unlocked: this.#key !== null && this.#locking === null, expiresAt: this.#locking ? null : this.#expiresAt };
  }
  generation(): number { this.#expire(); return this.#generation; }
  /** Trusted pre-persistence guard; never returns the secret or unlocks custody. */
  contains(value: string): boolean { return this.#key !== null && value.includes(this.#key); }
  set(key: string): void {
    if (typeof key !== "string" || !/^[!-~]{16,2048}$/.test(key)) throw new BrowserUseError("invalid_input");
    if (this.#locking || this.#key !== null) throw new BrowserUseError("busy");
    this.#key = key; this.#expiresAt = this.#now() + this.#ttlMs; this.#generation++;
    this.#timer = setTimeout(() => { void this.lock(); }, this.#ttlMs); this.#timer.unref();
  }
  use(): BrowserUseKeyLease {
    if (!this.status().unlocked || this.#key === null) throw new BrowserUseError("locked");
    const generation = this.#generation, key = this.#key;
    return { key, generation, assertCurrent: () => {
      if (!this.status().unlocked || this.#generation !== generation) throw new BrowserUseError("locked");
    } };
  }
  onLock(hook: () => Promise<void>): () => void { this.#hooks.add(hook); return () => { this.#hooks.delete(hook); }; }
  lock(): Promise<void> {
    if (this.#locking) return this.#locking;
    this.#generation++; this.#expiresAt = null;
    if (this.#timer) clearTimeout(this.#timer); this.#timer = null;
    // Keep the old value only in already borrowed executor leases until their bounded cleanup has drained.
    this.#key = null;
    const operation = Promise.allSettled([...this.#hooks].map(hook => Promise.resolve().then(hook))).then(() => undefined);
    this.#locking = operation;
    void operation.finally(() => { if (this.#locking === operation) this.#locking = null; });
    return operation;
  }
}

interface RemoteTask { id: string; sessionId: string }
export interface BrowserUseTaskInput { task: string; startUrl: string; policy: BrowserUseBotPolicy; operationId: string; requestHash: string }
export interface BrowserUseTaskResult {
  outcome: "finished" | "failed" | "stopped";
  output: string | null;
  outputOmitted: boolean;
  providerReportedSuccess: boolean | null;
  independentlyVerified: false;
  sessionClosed: true;
}
export interface BrowserUseRunOptions {
  lease: BrowserUseKeyLease;
  signal: AbortSignal;
  assertCurrent(): void;
  /** False means cleanup could not be proved; no remote IDs or messages are supplied. */
  cleanup(confirmed: boolean): void;
}
export interface BrowserUseClientOptions { fetch?: FetchLike; pollIntervalMs?: number; httpTimeoutMs?: number }

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new BrowserUseError("invalid_response");
  return value as Record<string, unknown>;
}
function output(value: unknown, key: string): { text: string | null; omitted: boolean } {
  if (value === null || value === undefined) return { text: null, omitted: false };
  if (typeof value !== "string" || value.length > 16_384 || SECRET.test(value) || value.includes(key)
    || /(?:data:image\/|-----BEGIN|\b(?:cdpUrl|liveUrl|debuggerUrl|webSocketDebuggerUrl)\s*[:=])/i.test(value)) return { text: null, omitted: true };
  // Provider control URLs, signed downloads and cookie-bearing URL text never enter a model receipt.
  return { text: value.replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, "[URL omitted]"), omitted: false };
}
export function browserUseStartUrlAllowed(value: string, domains: readonly string[]): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash
      && url.href === value && domains.includes(url.hostname.toLowerCase()) && !SECRET.test(value)
      && ![...url.searchParams.keys()].some(key => /(?:token|secret|password|credential|authorization|api.?key|signature)/i.test(key));
  } catch { return false; }
}

/** Fixed V2 service, no redirects or retries, no global task/account listing and no foreign session input. */
export class BrowserUseClient {
  readonly #fetch: FetchLike;
  readonly #pollMs: number;
  readonly #timeoutMs: number;
  constructor(options: BrowserUseClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch; this.#pollMs = options.pollIntervalMs ?? 1_000; this.#timeoutMs = options.httpTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#pollMs) || this.#pollMs < 1 || this.#pollMs > 5_000 || !Number.isSafeInteger(this.#timeoutMs)
      || this.#timeoutMs < 1 || this.#timeoutMs > 30_000) throw new BrowserUseError("invalid_input");
  }
  async #request(method: "GET" | "POST" | "PATCH", path: string, key: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), this.#timeoutMs);
    const combined = AbortSignal.any([signal, deadline.signal]);
    let response: Response | undefined;
    try {
      if (combined.aborted) throw new BrowserUseError("cancelled");
      response = await this.#fetch(BROWSER_USE_API + path, { method, redirect: "manual", cache: "no-store", signal: combined,
        headers: { "X-Browser-Use-API-Key": key, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (combined.aborted && method !== "POST") throw new BrowserUseError("cancelled");
      if (response.status < 200 || response.status > 299 || response.type === "opaqueredirect" || response.redirected
        || response.url && new URL(response.url).origin !== "https://api.browser-use.com") throw new BrowserUseError("provider_refused");
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > 65_536)) throw new BrowserUseError("invalid_response");
      if (!response.body) throw new BrowserUseError("invalid_response");
      const reader = response.body.getReader(); let total = 0; const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const part = await reader.read(); if (combined.aborted && method !== "POST") throw new BrowserUseError("cancelled");
          if (part.done) break;
          total += part.value.byteLength; if (total > 65_536) throw new BrowserUseError("invalid_response"); chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { throw new BrowserUseError("invalid_response"); }
    } catch (error) {
      if (error instanceof BrowserUseError) throw error;
      throw new BrowserUseError("transport_unknown");
    } finally { clearTimeout(timer); if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined); }
  }
  async #wait(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new BrowserUseError("cancelled");
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => { clearTimeout(timer); reject(new BrowserUseError("cancelled")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, this.#pollMs);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  async #cleanup(remote: RemoteTask, key: string): Promise<boolean> {
    const signal = AbortSignal.timeout(Math.min(15_000, this.#timeoutMs * 2));
    try { await this.#request("PATCH", `/tasks/${remote.id}`, key, signal, { action: "stop_task_and_session" }); } catch { /* Verify the known session even if the task stop response was lost. */ }
    try {
      const session = record(await this.#request("GET", `/sessions/${remote.sessionId}`, key, signal));
      return session.id === remote.sessionId && session.status === "stopped";
    } catch { return false; }
  }
  async run(input: BrowserUseTaskInput, options: BrowserUseRunOptions): Promise<BrowserUseTaskResult> {
    if (!BrowserUseBotPolicySchema.safeParse(input.policy).success || !input.policy.enabled) throw new BrowserUseError("invalid_input");
    if (!input.task.trim() || input.task.length > 8_192 || SECRET.test(input.task) || input.task.includes(options.lease.key)
      || !browserUseStartUrlAllowed(input.startUrl, input.policy.allowedDomains)) throw new BrowserUseError("invalid_input");
    let remote: RemoteTask | null = null, submitted = false, cleaned = false, cleanupAttempted = false;
    const deadline = AbortSignal.timeout(input.policy.timeoutSeconds * 1_000), signal = AbortSignal.any([options.signal, deadline]);
    const check = (): void => { if (signal.aborted) throw new BrowserUseError("cancelled"); options.lease.assertCurrent(); options.assertCurrent(); };
    try {
      check(); submitted = true;
      const created = record(await this.#request("POST", "/tasks", options.lease.key, signal, {
        task: input.task, llm: "browser-use-2.0", startUrl: input.startUrl, maxSteps: input.policy.maxSteps,
        allowedDomains: [...input.policy.allowedDomains], sessionSettings: { enableRecording: false, ...(input.policy.profileId === null ? {} : { profileId: input.policy.profileId }) },
        metadata: { operationId: input.operationId, requestHash: input.requestHash },
      }));
      // Keep known IDs before checking cancellation, so a late create response can still be stopped.
      if (typeof created.id !== "string" || !UUID.test(created.id) || typeof created.sessionId !== "string" || !UUID.test(created.sessionId)) throw new BrowserUseError("invalid_response");
      remote = { id: created.id, sessionId: created.sessionId }; check();
      while (true) {
        check(); const status = record(await this.#request("GET", `/tasks/${remote.id}/status`, options.lease.key, signal)); check();
        if (status.id !== remote.id || !["created", "started", "finished", "failed", "stopped"].includes(status.status as string)) throw new BrowserUseError("invalid_response");
        if (status.status === "finished" || status.status === "failed" || status.status === "stopped") {
          cleanupAttempted = true; cleaned = await this.#cleanup(remote, options.lease.key); options.cleanup(cleaned); check();
          if (!cleaned) throw new BrowserUseError("transport_unknown");
          const projected = status.status === "finished" ? output(status.output, options.lease.key) : { text: null, omitted: true };
          return { outcome: status.status, output: projected.text, outputOmitted: projected.omitted,
            providerReportedSuccess: typeof status.isSuccess === "boolean" ? status.isSuccess : null, independentlyVerified: false, sessionClosed: true };
        }
        await this.#wait(signal); check();
      }
    } catch (error) {
      if (remote && !cleanupAttempted) { cleanupAttempted = true; cleaned = await this.#cleanup(remote, options.lease.key); options.cleanup(cleaned); }
      else if (submitted && !remote) options.cleanup(false);
      if (error instanceof BrowserUseError) throw error;
      throw new BrowserUseError("transport_unknown");
    }
  }
}
