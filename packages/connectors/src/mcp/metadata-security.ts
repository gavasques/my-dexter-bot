import { createHash } from "node:crypto";
import { McpConnectorError } from "./errors.js";

export interface McpMetadataVerdict { hash: string; bytes: number; safe: boolean; reason: "credential_material" | "metadata_limit" | null }
export interface McpMetadataLimits { maxBytes: number; maxNodes: number; maxDepth: number }
export const MCP_METADATA_DEFINITION_LIMITS: Readonly<McpMetadataLimits> = Object.freeze({ maxBytes: 256 * 1024, maxNodes: 20_000, maxDepth: 24 });
/** Aggregate bound for 256 native definitions or 64 managed accounts × 32 definitions. */
export const MCP_METADATA_CATALOG_LIMITS: Readonly<McpMetadataLimits> = Object.freeze({ maxBytes: 64 * 1024 * 1024, maxNodes: 5_120_000, maxDepth: 32 });
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;
const TOKEN = /\b(?:sk-(?:proj-)?|sk_live_|gh[pousr]_|github_pat_|AKIA|xox[baprs]-|AIza|glpat-)[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g;
const PLACEHOLDERS = new Set([
    "YOUR_ACCESS_TOKEN_HERE", "YOUR_API_KEY", "YOUR_API_KEY_HERE", "YOUR_TOKEN", "YOUR_TOKEN_HERE",
    "YOUR_KEY", "YOUR_KEY_HERE", "YOUR_SECRET", "YOUR_SECRET_HERE", "example", "example-token",
    "example-key", "placeholder", "placeholder-token", "placeholder-key", "dummy", "dummy-token",
    "synthetic", "synthetic-token",
  ]);
/** Exempt only visibly synthetic instructions/filled-x examples. Known custody secrets always take precedence. */
function placeholder(value: string): boolean {
  const token = value.replace(/^Bearer\s+/, "").replace(/^(?:sk-(?:proj-)?|sk_live_|gh[pousr]_|github_pat_|AKIA|xox[baprs]-|AIza|glpat-)/, "");
  // Finite, case-sensitive documentation examples only. Prefixes never exempt an arbitrary suffix.
  return /^(?:x{8,}|X{8,})$/.test(token) || PLACEHOLDERS.has(token);
}
/** Maximal base64url runs are consumed once. A failed JWT prefix cannot restart at every -eyJ boundary. */
function credentialText(s: string): boolean {
  if (PRIVATE_KEY.test(s)) return true;
  for (const token of s.matchAll(TOKEN)) if (!placeholder(token[0])) return true;
  const runs = s.matchAll(/[A-Za-z0-9_-]+/g);
  let previous: RegExpExecArray | null = null, candidate: RegExpExecArray | null = null;
  for (const run of runs) {
    if (previous && candidate && previous.index + previous[0].length + 1 === run.index && s[run.index - 1] === "." && run[0].length >= 12) {
      const jwt = `${candidate[0]}.${previous[0]}.${run[0]}`;
      if (!jwt.split(".").every(part => /^eyJ[xX]{12,}$|^[xX]{12,}$/.test(part))) return true;
    }
    candidate = previous && previous.index + previous[0].length + 1 === run.index && s[run.index - 1] === "." && run[0].length >= 12
      && /\beyJ[A-Za-z0-9_-]{12}/.test(previous[0]) ? previous : null;
    previous = run;
  }
  return false;
}

/** Entire definition is refused; schemas are never edited to replace contaminated enum/default values. */
export function inspectMcpMetadata(raw: unknown, secrets: readonly string[] = [], limits: Readonly<McpMetadataLimits> = MCP_METADATA_DEFINITION_LIMITS): McpMetadataVerdict {
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || limits.maxBytes > MCP_METADATA_CATALOG_LIMITS.maxBytes || !Number.isSafeInteger(limits.maxNodes) || limits.maxNodes < 1 || limits.maxNodes > MCP_METADATA_CATALOG_LIMITS.maxNodes || !Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 1 || limits.maxDepth > MCP_METADATA_CATALOG_LIMITS.maxDepth) throw new McpConnectorError("metadata_quarantined", "metadata_limit");
  let nodes = 0, bytes = 0, contaminated = false;
  const seen = new Set<object>();
  const unique=[...new Set(secrets)];
  const secretBudget=unique.length<=4096&&unique.every(s=>s.length>0&&s.length<=8192)&&unique.reduce((total,s)=>total+Buffer.byteLength(s,"utf8"),0)<=MCP_METADATA_DEFINITION_LIMITS.maxBytes;
  const variants = secretBudget ? unique.flatMap((s) => [s, encodeURIComponent(s), Buffer.from(s).toString("base64"), Buffer.from(s).toString("base64url")]) : [];
  const hash = createHash("sha256");
  const string = (s: string): void => {
    bytes += Buffer.byteLength(s, "utf8");
    if (bytes > limits.maxBytes) throw new Error("limit");
    if (credentialText(s) || variants.some((v) => s.length>=v.length&&s.includes(v))) contaminated = true;
    for(const match of s.matchAll(/https?:\/\/[^\s<>"']+/g)) {
      try {const url=new URL(match[0]);url.searchParams.forEach((value,key)=>{
        if (/^(?:access[_-]?token|refresh[_-]?token|api[_-]?key|token|secret|password|passwd|pwd|senha|pin|cvv|cookie|authorization|client[_-]?secret|id[_-]?token)$/i.test(key) && !placeholder(value)) contaminated=true;
        // Authorization codes are common documentation/query fields. Only credential-shaped codes are quarantined.
        if (/^code$/i.test(key) && value.length >= 24 && new Set(value).size >= 8 && !placeholder(value)) contaminated=true;
      });}catch{/* plain external text */}
    }
    hash.update(JSON.stringify(s));
  };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) throw new Error("limit");
    if (typeof value === "string") { string(value); return; }
    if (value === null || typeof value === "boolean" || typeof value === "number") { hash.update(JSON.stringify(value)); return; }
    if (typeof value !== "object") throw new Error("limit");
    if (seen.has(value)) throw new Error("limit");
    seen.add(value);
    if (Array.isArray(value)) { hash.update("["); for (const item of value) visit(item, depth + 1); hash.update("]"); }
    else { hash.update("{"); for (const [key, item] of Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)) { string(key); hash.update(":"); visit(item, depth + 1); hash.update(","); } hash.update("}"); }
    seen.delete(value);
  };
  try { visit(raw, 0); } catch { return { hash: hash.digest("hex"), bytes: Math.min(bytes, limits.maxBytes + 1), safe: false, reason: "metadata_limit" }; }
  return { hash: hash.digest("hex"), bytes, safe: secretBudget&&!contaminated, reason: !secretBudget?"metadata_limit":contaminated ? "credential_material" : null };
}
export function assertSafeMcpMetadata(raw: unknown, secrets: readonly string[] = [], limits: Readonly<McpMetadataLimits> = MCP_METADATA_DEFINITION_LIMITS): McpMetadataVerdict {
  const verdict = inspectMcpMetadata(raw, secrets, limits);
  if (!verdict.safe) throw new McpConnectorError("metadata_quarantined", verdict.reason, null, { phase: "discovery", effect: "none", metadataHash: verdict.hash });
  return verdict;
}
