import type { JsonValue } from "@dexter/contracts";

const REDACTED = "[redacted]";
const MAX_DEPTH = 64;
/** `Scheme credentials` header values (Bearer, Basic, Token...): the credentials part is a secret on its own. */
const AUTH_SCHEME = /^\s*([A-Za-z][A-Za-z0-9._~+-]*)\s+(\S(?:.*\S)?)\s*$/s;

/**
 * Expands held secret values into every form that must never cross the boundary: the raw value, its
 * trimmed form, the credentials part of an auth-scheme header (and the decoded user:password of Basic),
 * plus URL- and base64-encoded variants. Every non-empty value counts, however short.
 */
export function secretNeedles(values: readonly string[]): string[] {
  const base = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    base.add(value);
    if (value.trim()) base.add(value.trim());
    const scheme = AUTH_SCHEME.exec(value);
    if (scheme) {
      base.add(scheme[2]!);
      if (scheme[1]!.toLowerCase() === "basic") {
        const decoded = Buffer.from(scheme[2]!, "base64").toString("utf8");
        if (decoded) base.add(decoded);
        const colon = decoded.indexOf(":");
        if (colon >= 0 && colon < decoded.length - 1) base.add(decoded.slice(colon + 1));
      }
    }
  }
  const out = new Set<string>();
  for (const needle of base) {
    out.add(needle);
    out.add(encodeURIComponent(needle));
    out.add(Buffer.from(needle, "utf8").toString("base64").replace(/=+$/, ""));
    out.add(Buffer.from(needle, "utf8").toString("base64url"));
  }
  // Longest first, so scrubbing never leaves a fragment of a longer secret behind.
  return [...out].filter((n) => n.length > 0).sort((a, b) => b.length - a.length);
}

/** True when any key or string anywhere in `value` contains a needle. Cyclic or too deep input counts as true. */
export function containsSecret(value: unknown, needles: readonly string[]): boolean {
  if (needles.length === 0) return false;
  const hit = (text: string): boolean => needles.some((needle) => text.includes(needle));
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > MAX_DEPTH) return true;
    if (typeof node === "string") return hit(node);
    if (Array.isArray(node)) return node.some((item) => walk(item, depth + 1));
    if (typeof node === "object" && node !== null) {
      return Object.entries(node).some(([key, item]) => hit(key) || walk(item, depth + 1));
    }
    return false;
  };
  return walk(value, 0);
}

/** Replaces every occurrence of a needle in keys and string values. Non-JSON output is dropped. */
export function scrub(value: JsonValue, needles: readonly string[]): JsonValue {
  const clean = (text: string): string => needles.reduce((out, needle) => out.split(needle).join(REDACTED), text);
  const walk = (node: unknown, depth: number): JsonValue => {
    if (depth > MAX_DEPTH) throw new Error("too deep");
    if (node === null || typeof node === "boolean") return node;
    if (typeof node === "number") return Number.isFinite(node) ? node : null;
    if (typeof node === "string") return clean(node);
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    if (typeof node === "object" && Object.getPrototypeOf(node) === Object.prototype) {
      return Object.fromEntries(Object.entries(node).map(([key, item]) => [clean(key), walk(item, depth + 1)]));
    }
    throw new Error("not json");
  };
  try { return walk(value, 0); } catch { return { omitted: "result_not_json" }; }
}
