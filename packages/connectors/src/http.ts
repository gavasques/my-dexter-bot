import type { JsonValue } from "@dexter/contracts";
import { ConnectorError } from "./errors.js";

/** Injectable transport. Production passes `globalThis.fetch`; tests pass a synthetic one. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpLimits {
  timeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
}
export const DEFAULT_LIMITS: HttpLimits = Object.freeze({ timeoutMs: 30_000, maxRequestBytes: 256 * 1024, maxResponseBytes: 1024 * 1024 });
const MAX_LIMITS: HttpLimits = Object.freeze({ timeoutMs: 120_000, maxRequestBytes: 4 * 1024 * 1024, maxResponseBytes: 16 * 1024 * 1024 });

export interface JsonRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  headers: Readonly<Record<string, string>>;
  body?: JsonValue;
  signal?: AbortSignal;
}
export interface JsonResponse { status: number; body: unknown }

const HEADER_NAME = /^[a-z0-9-]{1,64}$/;
const HEADER_VALUE = /^[ -~]{1,8192}$/;
/** Headers the transport itself controls; a credential can never set them. */
const RESERVED_HEADERS = new Set(["host", "content-type", "content-length", "accept", "connection", "transfer-encoding", "cookie", "origin", "referer"]);

export function checkLimits(input: Partial<HttpLimits> | undefined): HttpLimits {
  const out = { ...DEFAULT_LIMITS, ...input };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof HttpLimits)[]) {
    if (!Number.isSafeInteger(out[key]) || out[key] < 1 || out[key] > MAX_LIMITS[key]) throw new ConnectorError("invalid_config");
  }
  return Object.freeze(out);
}

/** Accepts only a bare `https://host` origin (no path, credentials, port, query or fragment). */
export function checkOrigin(origin: string): string {
  let url: URL;
  try { url = new URL(origin); } catch { throw new ConnectorError("invalid_config"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "") || url.origin !== origin) throw new ConnectorError("invalid_config");
  return url.origin;
}

/** Validates credential headers: lowercase token names, printable single-line values, no transport-reserved names. */
export function checkAuthHeaders(headers: Readonly<Record<string, string>>, allowed: ReadonlySet<string>): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = Object.entries(headers);
  if (entries.length === 0) throw new ConnectorError("auth_refused");
  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name) || !allowed.has(name)) throw new ConnectorError("auth_refused");
    if (typeof value !== "string" || !HEADER_VALUE.test(value)) throw new ConnectorError("auth_refused");
    out[name] = value;
  }
  return out;
}

/**
 * One JSON request to a fixed https origin, never retried. Redirects are refused (manual mode), the request
 * and response bodies are bounded, and one deadline covers connect, headers and body. Failures map to fixed
 * codes; upstream bodies of non-2xx responses are discarded unread, never logged or returned.
 */
export async function requestJson(fetchImpl: FetchLike, origin: string, limits: HttpLimits, request: JsonRequest): Promise<JsonResponse> {
  const url = new URL(request.path, origin);
  if (url.origin !== origin || url.username || url.password) throw new ConnectorError("origin_refused");
  const payload = request.body === undefined ? undefined : JSON.stringify(request.body);
  if (payload !== undefined && Buffer.byteLength(payload, "utf8") > limits.maxRequestBytes) throw new ConnectorError("request_too_large");
  if (request.signal?.aborted) throw new ConnectorError("aborted");

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), limits.timeoutMs);
  const signal = request.signal ? AbortSignal.any([deadline.signal, request.signal]) : deadline.signal;
  const failure = (): ConnectorError => deadline.signal.aborted ? new ConnectorError("timeout")
    : request.signal?.aborted ? new ConnectorError("aborted") : new ConnectorError("transport_failed");
  try {
    let response: Response;
    const headers: Record<string, string> = { ...request.headers, accept: "application/json" };
    if (payload !== undefined) headers["content-type"] = "application/json";
    try {
      response = await fetchImpl(url.href, {
        method: request.method, headers, redirect: "manual", signal, cache: "no-store",
        ...(payload === undefined ? {} : { body: payload }),
      });
    } catch {
      // The cause may echo request details; it is dropped on purpose.
      throw failure();
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await discard(response);
      throw new ConnectorError("upstream_redirect", response.status || null);
    }
    if (response.url && new URL(response.url).origin !== origin) {
      await discard(response);
      throw new ConnectorError("upstream_redirect");
    }
    if (response.status < 200 || response.status > 299) {
      await discard(response);
      throw new ConnectorError("upstream_status", response.status);
    }
    const type = response.headers.get("content-type") ?? "";
    if (!/^application\/json(?:\s*;|$)/i.test(type)) {
      await discard(response);
      throw new ConnectorError("response_invalid", response.status);
    }
    const declared = Number(response.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > limits.maxResponseBytes) {
      await discard(response);
      throw new ConnectorError("response_too_large", response.status);
    }
    const bytes = await readBounded(response, limits.maxResponseBytes, signal, failure);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new ConnectorError("response_invalid", response.status); }
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new ConnectorError("response_invalid", response.status); }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function discard(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* nothing to report */ }
}

async function readBounded(response: Response, max: number, signal: AbortSignal, failure: () => ConnectorError): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(failure());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new ConnectorError("response_too_large", response.status);
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* ignore */ }
    if (error instanceof Error && error.name === "ConnectorError") throw error;
    throw failure();
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}
