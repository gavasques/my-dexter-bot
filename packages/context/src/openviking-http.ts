import { Buffer } from "node:buffer";
import { inspect } from "node:util";

export type OpenVikingErrorCode = "configuration" | "identity" | "input" | "closed" | "timeout" | "cancelled" |
  "network" | "http" | "protocol" | "too_large" | "scope" | "journal";
/** Errors intentionally exclude response bodies, URLs with credentials, and exception causes. */
export class OpenVikingError extends Error {
  constructor(readonly code: OpenVikingErrorCode, readonly status: number | null = null) {
    super(`OpenViking ${code}${status === null ? "" : ` ${status}`}`);
    this.name = "OpenVikingError";
  }
}
export interface OpenVikingCallOptions { signal?: AbortSignal }
export interface OpenVikingHttpOptions {
  /** HTTPS origin, or authenticated HTTP to literal loopback. No URL credentials/path/query. */
  origin: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}
export function openVikingRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OpenVikingError("protocol");
  return value as Record<string, unknown>;
}
export function openVikingBounded(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new OpenVikingError("configuration");
  return result;
}
export function openVikingOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new OpenVikingError("configuration"); }
  if (typeof raw !== "string" || raw.length > 512 || /[?#@\\\s]/u.test(raw) || raw.replace(/\/$/, "") !== url.origin ||
    url.pathname !== "/" || url.username || url.password || (url.protocol !== "https:" &&
      !(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]") && url.port))) throw new OpenVikingError("configuration");
  return url.origin;
}
export interface OpenVikingHttpResult { status: number; body: unknown }

/** Private host transport. Credential values are only passed to fetch, never returned by status/receipts. */
export class OpenVikingHttpTransport {
  readonly origin: string;
  readonly #fetch: NonNullable<OpenVikingHttpOptions["fetch"]>;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #owned = new Set<AbortController>();
  #closed = false;
  constructor(options: OpenVikingHttpOptions) {
    this.origin = openVikingOrigin(options.origin);
    if (options.fetch !== undefined && typeof options.fetch !== "function") throw new OpenVikingError("configuration");
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = openVikingBounded(options.timeoutMs, 10_000, 1, 120_000);
    this.#maxBytes = openVikingBounded(options.maxResponseBytes, 1_048_576, 256, 8_388_608);
  }
  toJSON(): { origin: string; closed: boolean } { return { origin: this.origin, closed: this.#closed }; }
  [inspect.custom](): string { return `OpenVikingHttpTransport(${this.origin}, closed=${this.#closed})`; }
  close(): void { this.#closed = true; for (const controller of this.#owned) controller.abort(); }

  async request(method: "GET" | "POST" | "DELETE", path: string, key: string, payload: unknown, options: OpenVikingCallOptions = {}): Promise<OpenVikingHttpResult> {
    if (this.#closed) throw new OpenVikingError("closed");
    if (options.signal?.aborted) throw new OpenVikingError("cancelled");
    if (!path.startsWith("/") || path.startsWith("//") || /[\r\n\\#]/u.test(path) || typeof key !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(key)) throw new OpenVikingError("configuration");
    const controller = new AbortController();
    this.#owned.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new OpenVikingError(timedOut ? "timeout" : this.#closed ? "closed" : "cancelled"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const run = async (): Promise<OpenVikingHttpResult> => {
      const headers: Record<string, string> = { Accept: "application/json", "X-API-Key": key };
      const init: RequestInit = { method, headers, signal: controller.signal, redirect: "error", credentials: "omit" };
      if (payload !== undefined) {
        init.body = JSON.stringify(payload);
        if (Buffer.byteLength(init.body, "utf8") > 262_144) throw new OpenVikingError("input");
        headers["Content-Type"] = "application/json";
      }
      let response: Response;
      try { response = await this.#fetch(`${this.origin}${path}`, init); } catch { throw new OpenVikingError("network"); }
      if (controller.signal.aborted) throw new OpenVikingError("cancelled");
      if (!/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) throw new OpenVikingError("protocol");
      const advertised = response.headers.get("content-length");
      if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > this.#maxBytes)) {
        await response.body?.cancel().catch(() => {}); throw new OpenVikingError("too_large");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new OpenVikingError("protocol");
      const chunks: Uint8Array[] = [];
      let count = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (controller.signal.aborted) throw new OpenVikingError("cancelled");
          if (chunk.done) break;
          count += chunk.value.byteLength;
          if (count > this.#maxBytes) { await reader.cancel().catch(() => {}); throw new OpenVikingError("too_large"); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      try { return { status: response.status, body: JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown }; }
      catch { throw new OpenVikingError("protocol"); }
    };
    try { return await Promise.race([run(), interrupted]); }
    catch (error) { if (error instanceof OpenVikingError) throw error; throw new OpenVikingError("network"); }
    finally {
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      this.#owned.delete(controller);
    }
  }
}

export function openVikingResult(response: OpenVikingHttpResult): unknown {
  const envelope = openVikingRecord(response.body);
  if (response.status < 200 || response.status >= 300) throw new OpenVikingError("http", response.status);
  if (envelope.status !== "ok" || !("result" in envelope)) throw new OpenVikingError("protocol");
  return envelope.result;
}
