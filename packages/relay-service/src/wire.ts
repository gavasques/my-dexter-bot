import { types } from "node:util";

/** Transport-only bounds. The frozen RelayStore keeps its own 32 KiB ciphertext, 100-item and quota limits. */
export const LIMITS = Object.freeze({
  requestBytes: 65_536,
  headerBytes: 16_384,
  pollLimit: 10,
  pollResponseBytes: 524_288,
  smallResponseBytes: 4_096,
  jsonDepth: 6,
});
export const PATHS = Object.freeze({ enqueue: "/v1/envelopes", poll: "/v1/poll", ack: "/v1/ack" });
export type RelayRoute = keyof typeof PATHS;

/** Fixed wire error codes. Bodies never echo input, ciphertext, keys or internal messages. */
export const WIRE_STATUS = Object.freeze({
  invalid_input: 400, forbidden: 403, conflict: 409, expired: 410, quota: 429,
  host_locked: 503, unavailable: 503, clock_untrusted: 503,
  bad_request: 400, poll_limit: 400, not_found: 404, method_not_allowed: 405,
  payload_too_large: 413, unsupported_media_type: 415, version_not_supported: 505,
  shutting_down: 503, internal: 500,
});
export type WireErrorCode = keyof typeof WIRE_STATUS;
export function isWireErrorCode(v: unknown): v is WireErrorCode { return typeof v === "string" && Object.hasOwn(WIRE_STATUS, v); }

export class WireFormatError extends Error {
  constructor() { super("relay wire format"); this.name = "WireFormatError"; }
}

/**
 * Serializes caller data only when it is closed, plain, own-data JSON: no Proxy, accessor, toJSON, symbol key,
 * sparse/extra array property, non-plain prototype, non-integer number, boolean or null. Nothing is invoked.
 */
export function closedSerialize(value: unknown): string {
  const write = (v: unknown, depth: number): string => {
    if (depth > LIMITS.jsonDepth) throw new WireFormatError();
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number") { if (!Number.isSafeInteger(v)) throw new WireFormatError(); return String(v); }
    if (v === null || typeof v !== "object" || types.isProxy(v)) throw new WireFormatError();
    const keys = Reflect.ownKeys(v);
    if (keys.length > 128) throw new WireFormatError();
    const item = (k: string): unknown => {
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!d || !("value" in d) || !d.enumerable) throw new WireFormatError();
      return d.value;
    };
    if (Array.isArray(v)) {
      const length = Object.getOwnPropertyDescriptor(v, "length")?.value;
      if (Object.getPrototypeOf(v) !== Array.prototype || typeof length !== "number" || keys.length !== length + 1) throw new WireFormatError();
      const parts: string[] = [];
      for (let i = 0; i < length; i++) parts.push(write(item(String(i)), depth + 1));
      return `[${parts.join(",")}]`;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new WireFormatError();
    const parts: string[] = [];
    for (const k of keys) {
      if (typeof k !== "string" || k === "toJSON") throw new WireFormatError();
      parts.push(`${JSON.stringify(k)}:${write(item(k), depth + 1)}`);
    }
    return `{${parts.join(",")}}`;
  };
  return write(value, 0);
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** Strict UTF-8 JSON: no BOM, duplicate keys, nesting above the bound or trailing data. Top level must be an object. */
export function closedParse(raw: Uint8Array): Record<string, unknown> {
  let text: string;
  try { text = utf8.decode(raw); } catch { throw new WireFormatError(); }
  const stack: (Set<string> | null)[] = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\"") {
      let j = i + 1;
      while (j < text.length && text[j] !== "\"") j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) throw new WireFormatError();
      const top = stack.at(-1);
      if (top instanceof Set && expectKey) {
        let key: unknown;
        try { key = JSON.parse(text.slice(i, j + 1)); } catch { throw new WireFormatError(); }
        if (typeof key !== "string" || top.has(key)) throw new WireFormatError();
        top.add(key); expectKey = false;
      }
      i = j;
    } else if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? new Set() : null); expectKey = ch === "{";
      if (stack.length > LIMITS.jsonDepth) throw new WireFormatError();
    } else if (ch === "}" || ch === "]") { stack.pop(); expectKey = false; }
    else if (ch === ",") expectKey = stack.at(-1) instanceof Set;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new WireFormatError(); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new WireFormatError();
  return parsed as Record<string, unknown>;
}

export function errorBody(code: WireErrorCode): Buffer { return Buffer.from(`{"error":${JSON.stringify(code)}}`); }
