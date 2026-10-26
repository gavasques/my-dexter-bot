import { createHash } from "node:crypto";
import type { JsonValue } from "@dexter/contracts";
import type { CapabilityScope, GatewayCallResult } from "./gateway.js";

export interface McpOutputBudget { maxBytes: number; maxTokens: number; maxBlocks: number; multimodal?: boolean }
export interface McpArtifactSinkInput {
  actionId: string; requestHash: string; content: JsonValue; mimeType: "application/json";
  /** Added only by the trusted bridge/lease, never from provider data or model arguments. */
  readonly originScope?: Readonly<CapabilityScope>;
}
/** Injected by the trusted host. It derives ACL bot/thread from the receipt, never model arguments. */
export type McpArtifactSink = (input: McpArtifactSinkInput) => Promise<JsonValue | null>;
export const mcpSemanticError = (outcome: GatewayCallResult): boolean => {
  const result = outcome.result;
  return ["denied", "blocked", "unknown"].includes(outcome.status) || (result !== null && typeof result === "object" && !Array.isArray(result)
    && (result.isError === true || ["interrupted", "failed", "not_started"].includes(String(result.commandOutcome)) || result.resultType === "input_required"));
};
const object = (value: JsonValue | undefined): value is Record<string, JsonValue> => Boolean(value && typeof value === "object" && !Array.isArray(value));
interface Media { block: JsonValue; reference: Record<string, JsonValue> }
/** Binary data occurs only in a supported rich block, never in either JSON receipt representation. */
function prepare(outcome: GatewayCallResult, multimodal: boolean, maxBlocks: number): { safe: GatewayCallResult; media: Media[]; omitted: boolean } {
  const media: Media[] = []; const seen = new Map<string, Record<string, JsonValue>>(); let omitted = false;
  const walk = (value: JsonValue, depth: number): JsonValue => {
    if (depth > 64) { omitted = true; return { omitted: "result_depth_limit" }; }
    if (Array.isArray(value)) return value.map(item => walk(item, depth + 1));
    if (!object(value)) return value;
    const type = String(value.type), binary = ["image", "audio"].includes(type) && typeof value.data === "string"
      || type === "resource" && object(value.resource) && typeof value.resource.blob === "string";
    // Embedded textual resources and links are useful to every driver. They stay in the
    // bounded JSON/text projection; neither a URI nor text is a request to fetch media.
    const textualResource = type === "resource" && object(value.resource) && typeof value.resource.text === "string";
    const rich = binary || multimodal && textualResource;
    if (rich) {
      const key = createHash("sha256").update(JSON.stringify(value)).digest("hex"); const existing = seen.get(key);
      if (existing) return existing;
      const reference: Record<string, JsonValue> = binary
        ? { type, ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}), sha256: key }
        : Object.fromEntries(Object.entries(value).filter(([name]) => name !== "resource"));
      if (type === "resource" && object(value.resource)) reference.resource = { ...Object.fromEntries(Object.entries(value.resource).filter(([name]) => !["blob", "text"].includes(name))) };
      if (multimodal && media.length < maxBlocks - 1) {
        reference.contentBlock = media.length + 1;
        media.push({ block: structuredClone(value), reference });
      } else { omitted = true; reference.omitted = multimodal ? "content_block_budget" : "driver_not_multimodal"; }
      seen.set(key, reference); return reference;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, depth + 1)]));
  };
  return { safe: { ...outcome, result: outcome.result === null ? null : walk(outcome.result, 0) }, media, omitted };
}
/** Return data only, no fetch or image transformation. Text/structured JSON remain compatible for legacy clients. */
export function mcpResultContent(outcome: GatewayCallResult, multimodal = true): JsonValue[] {
  const prepared = prepare(outcome, multimodal, 128);
  return [{ type: "text", text: JSON.stringify(prepared.safe) }, ...prepared.media.map(item => item.block)];
}
function withoutBinary(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(withoutBinary);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !(["image", "audio"].includes(String(value.type)) && key === "data") && key !== "blob")
    .map(([key, item]) => [key, withoutBinary(item)]));
}
function measure(content: JsonValue[], outcome: GatewayCallResult): { bytes: number; tokens: number } {
  // Wire bytes include both compatibility representations. The model consumes one textual representation;
  // never charge the identical structured receipt a second time, or base64 as text tokens. Rich binary has
  // separate byte/block bounds; this is a text estimate, not a provider-specific image/audio tokenizer.
  // false is one byte longer than true, so reserve the complete semantic-error field.
  const bytes = Buffer.byteLength(JSON.stringify({ content, structuredContent: outcome, isError: false }));
  const tokens = Math.ceil(content.reduce<number>((sum, block) => sum + Buffer.byteLength(object(block) && block.type === "text" && typeof block.text === "string"
    ? block.text : JSON.stringify(withoutBinary(block))), 0) / 3);
  return { bytes, tokens };
}
/** Identity/status remain canonical; projected data never changes the stored receipt or executes/retries an effect. */
export async function projectMcpOutcome(outcome: GatewayCallResult, budget: McpOutputBudget, artifactSink?: McpArtifactSink): Promise<{ content: JsonValue[]; structuredContent: GatewayCallResult; isError: boolean }> {
  if (!Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 512 || !Number.isSafeInteger(budget.maxTokens) || budget.maxTokens < 128
    || !Number.isSafeInteger(budget.maxBlocks) || budget.maxBlocks < 1 || budget.maxBlocks > 128) throw new Error("Invalid output budget");
  const isError = mcpSemanticError(outcome), prepared = prepare(outcome, budget.multimodal !== false, budget.maxBlocks);
  const response = (safe: GatewayCallResult) => [{ type: "text", text: JSON.stringify(safe) }, ...prepared.media.map(item => item.block)] as JsonValue[];
  const fits = (safe: GatewayCallResult, content = response(safe)): boolean => { const size = measure(content, safe); return size.bytes <= budget.maxBytes && size.tokens <= budget.maxTokens && content.length <= budget.maxBlocks; };
  if (!prepared.omitted && fits(prepared.safe)) return { content: response(prepared.safe), structuredContent: prepared.safe, isError };
  // Only the sanitized original host result enters the sink, with receipt-derived ACL. No paid remote work or retry.
  let artifact: JsonValue | null = null;
  if (artifactSink && outcome.result !== null) try {
    artifact = await artifactSink({ actionId: outcome.actionId, requestHash: outcome.requestHash, content: outcome.result, mimeType: "application/json" });
    if (artifact !== null && Buffer.byteLength(JSON.stringify(artifact)) > 4096) artifact = null;
  } catch { artifact = null; }
  // Remove rich blocks that cannot fit even without a textual preview. Update their references truthfully.
  const raw = JSON.stringify(outcome.result);
  const details: Record<string, JsonValue> = { truncated: "mcp_result_budget", originalBytes: Buffer.byteLength(raw), sha256: createHash("sha256").update(raw).digest("hex"), consultReceipt: true,
    ...(artifact === null ? {} : { artifact }), ...(prepared.omitted ? { contentOmitted: true } : {}) };
  let safe: GatewayCallResult = { ...outcome, result: { ...details, preview: "" } };
  const dropped: JsonValue[] = [];
  while (prepared.media.length && !fits(safe)) { const removed = prepared.media.pop()!; dropped.push(withoutBinary(removed.block)); delete removed.reference.contentBlock; removed.reference.omitted = "output_budget"; details.contentOmitted = true; }
  if (!fits(safe) && artifact !== null) { delete details.artifact; details.artifactAvailable = true; safe = { ...outcome, result: { ...details, preview: "" } }; }
  const source = JSON.stringify(dropped.length ? { result: prepared.safe.result, omittedContent: dropped } : prepared.safe.result);
  let low = 0, high = source.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2); let preview = source.slice(0, mid);
    if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
    const candidate = { ...outcome, result: { ...details, preview } };
    if (fits(candidate)) low = mid; else high = mid - 1;
  }
  let preview = source.slice(0, low); if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
  safe = { ...outcome, result: { ...details, preview } };
  if (!fits(safe)) {
    // Minimum bounded fallback still carries the canonical identity in structuredContent. No payload/binary leak.
    safe = { ...outcome, result: { truncated: "mcp_result_budget", consultReceipt: true } };
    const content: JsonValue[] = [{ type: "text", text: `Receipt ${outcome.actionId}; requestHash ${outcome.requestHash}; status ${outcome.status}. Result truncated; consult the original receipt.` }];
    return { content, structuredContent: safe, isError };
  }
  return { content: response(safe), structuredContent: safe, isError };
}
