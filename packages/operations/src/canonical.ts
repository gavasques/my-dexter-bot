import { createHash } from "node:crypto";

/**
 * Independent copy of `@dexter/hub` `canonicalJson`: object keys sorted recursively, arrays in order. Operations
 * has no package dependency on the Hub; the tests pin this against the Hub export so request hashes, Surface
 * idempotency keys and enrollment digests are recomputed exactly as the writers computed them.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as Json)}`).join(",")}}`;
}
export const sha256Text = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Parses stored JSON; `undefined` for anything that is not valid JSON. */
export function parseJson(text: unknown): Json | undefined {
  if (typeof text !== "string") return undefined;
  try { return JSON.parse(text) as Json; } catch { return undefined; }
}
