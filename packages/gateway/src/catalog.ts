import { createHash } from "node:crypto";
import type { ToolView } from "./gateway.js";

/** Operational ceiling of host-scoped eligible bindings, including first-party definitions; never a grant. */
export const MCP_AUTHORIZED_INVENTORY_LIMIT = 2_048;

/** Reserved first-party directory operations. They never select principal/account or bypass dispatch. */
export const MCP_DIRECTORY_ALIASES = Object.freeze(["dx_catalog_search", "dx_catalog_describe", "dx_catalog_call"] as const);
export const gatewayToolAlias = (view: Pick<ToolView, "name" | "connectionId">): string =>
  `dx_${createHash("sha256").update(`${view.name}\u0000${view.connectionId}`).digest("hex").slice(0, 24)}`;
export const gatewayConnectionTag = (id: string): string => createHash("sha256").update(id).digest("hex").slice(0, 12);
/** Conservative UTF-8 estimate, not a claim about a particular provider's tokenizer. */
export const estimateCatalogTokens = (value: unknown): number => Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 3);

export interface CatalogExposureOptions { tokenBudget?: number; maxTools?: number; pinnedAliases?: readonly string[]; pinnedToolNames?: readonly string[] }
export interface CatalogExposure { direct: ToolView[]; deferred: ToolView[]; directory: boolean; estimatedTokens: number }
/** Deterministic projection of CURRENT grants only. This function never caches authority. */
export function planCatalogExposure(views: readonly ToolView[], options: CatalogExposureOptions = {}): CatalogExposure {
  if (views.length > MCP_AUTHORIZED_INVENTORY_LIMIT) throw new Error("Authorized tool inventory limit exceeded");
  const budget = options.tokenBudget ?? 24_000, max = options.maxTools ?? 256;
  if (!Number.isSafeInteger(budget) || budget < 256 || budget > 1_000_000 || !Number.isSafeInteger(max) || max < 3 || max > 1024)
    throw new Error("Invalid catalog exposure limits");
  if (estimateCatalogTokens(directoryToolDefinitions()) > budget) throw new Error("Catalog directory exceeds token budget");
  const pinned = new Set(options.pinnedAliases ?? []), pinnedNames = new Set(options.pinnedToolNames ?? []);
  // Hash once per current view, rather than twice per sort comparison. This caches no authority.
  const entries = views.map(view => ({ view, alias: gatewayToolAlias(view), pinned: pinnedNames.has(view.name) }));
  const compare = (a: { alias: string }, b: { alias: string }): number => a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0;
  entries.sort(compare);
  if (new Set(entries.map(entry => entry.alias)).size !== entries.length) throw new Error("Catalog alias collision");
  for (const entry of entries) entry.pinned ||= pinned.has(entry.alias);
  const directEntries: typeof entries = [], deferred: ToolView[] = [];
  // Three fixed wrappers are budgeted before direct tools. At least the directory always remains usable.
  let usedBytes = Buffer.byteLength(JSON.stringify(directoryToolDefinitions()));
  for (const entry of [...entries].sort((a, b) => Number(b.pinned) - Number(a.pinned) || compare(a, b))) {
    if (directEntries.length >= Math.max(0, max - 3)) { deferred.push(entry.view); continue; }
    // Every projected definition contains this fixed envelope. No later (even empty) schema can fit
    // below that lower bound, so avoid projecting the remaining inventory for an exhausted budget.
    if (budget * 3 - usedBytes < MINIMUM_PROJECTED_TOOL_BYTES + 1) { deferred.push(entry.view); continue; }
    const costBytes = Buffer.byteLength(JSON.stringify(projectCatalogTool(entry.view))) + 1;
    if (Math.ceil((usedBytes + costBytes) / 3) <= budget) { directEntries.push(entry); usedBytes += costBytes; }
    else deferred.push(entry.view);
  }
  return { direct: directEntries.sort(compare).map(entry => entry.view), deferred, directory: true, estimatedTokens: Math.ceil(usedBytes / 3) };
}
const callIdSchema = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", maxLength: 128 };
const MINIMUM_PROJECTED_TOOL_BYTES = Buffer.byteLength(JSON.stringify({
  inputSchema: { type: "object", additionalProperties: false, required: ["callId", "input"], properties: { callId: callIdSchema } },
  annotations: { readOnlyHint: true, destructiveHint: true, idempotentHint: true, openWorldHint: true },
}));
export function projectCatalogTool(view: ToolView): Record<string, unknown> {
  const original = view.inputSchema as Record<string, unknown>;
  const hasLocalRef = (value: unknown, depth = 0): boolean => {
    if (depth > 32 || !value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(item => hasLocalRef(item, depth + 1));
    const row = value as Record<string, unknown>;
    return (typeof row.$ref === "string" && row.$ref.startsWith("#")) || Object.values(row).some(item => hasLocalRef(item, depth + 1));
  };
  // Embedding changes where a fragment $ref resolves. A local document ID restores the original
  // root without editing references/constraints. The exact original remains separate below.
  const scoped = hasLocalRef(original) && original.$id === undefined;
  const inputSchema = scoped ? { $id: `urn:dexter:mcp:input:${createHash("sha256").update(JSON.stringify(original)).digest("hex")}`, ...original } : original;
  return { name: gatewayToolAlias(view), title: `${view.title ?? view.name} (${view.connectionLabel})`,
    description: `Account: ${view.connectionLabel}. Connection: ${gatewayConnectionTag(view.connectionId)}. ${view.description}`,
    inputSchema: { type: "object", additionalProperties: false, required: ["callId", "input"], properties: { callId: callIdSchema, input: inputSchema } },
    // The output of this wrapper is a canonical Dexter receipt, not the raw upstream structuredContent.
    // Keep the pinned upstream output schema as data instead of falsely declaring it for the envelope.
    ...(view.outputSchema || scoped ? { _meta: { ...(scoped ? { "com.dexter.mcp/originalInputSchema": original } : {}), ...(view.outputSchema ? { "com.dexter.mcp/originalOutputSchema": view.outputSchema } : {}) } } : {}),
    annotations: { readOnlyHint: view.effect === "read", destructiveHint: view.effect === "write", idempotentHint: true, openWorldHint: true } };
}
export function directoryToolDefinitions(): Record<string, unknown>[] {
  return [
    { name: MCP_DIRECTORY_ALIASES[0], title: "Find available tools", description: "Search the current bot's granted accounts and tools. Search grants no access. Use the returned opaque alias with describe/call.",
      inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", maxLength: 256 }, limit: { type: "integer", minimum: 1, maximum: 20 } } }, annotations: { readOnlyHint: true, openWorldHint: false } },
    { name: MCP_DIRECTORY_ALIASES[1], title: "Describe an available tool", description: "Read the exact pinned input schema of a currently granted opaque alias. This does not execute or authorize the tool.",
      inputSchema: { type: "object", additionalProperties: false, required: ["alias"], properties: { alias: { type: "string", pattern: "^dx_[0-9a-f]{24}$" } } }, annotations: { readOnlyHint: true, openWorldHint: false } },
    { name: MCP_DIRECTORY_ALIASES[2], title: "Call an available tool", description: "Execute one opaque alias with its original callId and exact arguments through the same host grants, pins, approval and receipt as a direct tool. Never retry an unknown effect with another callId.",
      inputSchema: { type: "object", additionalProperties: false, required: ["alias", "callId", "input"], properties: { alias: { type: "string", pattern: "^dx_[0-9a-f]{24}$" }, callId: callIdSchema, input: { type: "object" } } }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
  ];
}
export function searchCatalog(views: readonly ToolView[], query: string, limit = 10): Record<string, unknown>[] {
  if (typeof query !== "string" || query.length > 256 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Invalid catalog query");
  const terms = query.toLocaleLowerCase("en-US").split(/\s+/u).filter(Boolean);
  return views.map(view => {
    const name = view.name.toLocaleLowerCase("en-US"), text = `${view.title ?? ""} ${view.description} ${view.connectionLabel}`.toLocaleLowerCase("en-US");
    return { view, alias: gatewayToolAlias(view), score: terms.reduce((score, term) => score + (name.includes(term) ? 4 : 0) + (text.includes(term) ? 1 : 0), 0) };
  }).filter(({ score }) => !terms.length || score > 0)
    .sort((a, b) => b.score - a.score || (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0)).slice(0, limit)
    .map(({ view, alias }) => ({ alias, title: view.title ?? view.name, account: view.connectionLabel, connection: gatewayConnectionTag(view.connectionId), effect: view.effect, requiresApproval: view.requiresApproval }));
}
/** Skill dependencies are guidance only. Missing dependencies never hide first-party operational manuals. */
export function skillConnectionEligibility(requiredTools: readonly string[], views: readonly ToolView[]): { eligible: boolean; missingTools: string[]; guidanceAvailable: true } {
  const available = new Set(views.map(view => view.name));
  const missingTools = [...new Set(requiredTools)].filter(name => !available.has(name)).sort();
  return { eligible: missingTools.length === 0, missingTools, guidanceAvailable: true };
}
