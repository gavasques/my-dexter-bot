import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const MCP_LEGACY_VERSION = "2025-11-25";
export const MCP_MODERN_VERSION = "2026-07-28";
export const MCP_SUPPORTED_VERSIONS = Object.freeze([MCP_MODERN_VERSION, MCP_LEGACY_VERSION]);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
export class McpProtocolError extends Error {
  constructor(readonly code: number, message: string, readonly data?: Record<string, unknown>) { super(message); }
}
export function modernMetadata(params: unknown): { modern: boolean; capabilities: Record<string, unknown> } {
  if (!object(params) || !object(params._meta) || !Object.hasOwn(params._meta, "io.modelcontextprotocol/protocolVersion")) return { modern: false, capabilities: {} };
  const meta = params._meta, version = meta["io.modelcontextprotocol/protocolVersion"];
  if (version !== MCP_MODERN_VERSION) throw new McpProtocolError(-32022, "Unsupported protocol version", { supported: [...MCP_SUPPORTED_VERSIONS], requested: typeof version === "string" && version.length <= 64 ? version : "invalid" });
  const info = meta["io.modelcontextprotocol/clientInfo"], caps = meta["io.modelcontextprotocol/clientCapabilities"];
  if (!object(info) || typeof info.name !== "string" || info.name.length < 1 || info.name.length > 128 || typeof info.version !== "string" || info.version.length > 128 || !object(caps)
    || Buffer.byteLength(JSON.stringify(caps)) > 16_384) throw new McpProtocolError(-32602, "Invalid request metadata");
  return { modern: true, capabilities: caps };
}
/** Only a harmless discover probe can establish fallback. A modern error or toolcall never downgrades. */
export function classifyMcpEraProbe(method: string, response: unknown): "modern" | "legacy" | "refuse" {
  if (method !== "server/discover") return "refuse";
  if (object(response) && object(response.result) && response.result.resultType === "complete" && Array.isArray(response.result.supportedVersions)) return "modern";
  if (object(response) && object(response.error) && [-32020, -32021, -32022].includes(Number(response.error.code))) return "modern";
  return "legacy";
}

const SENTINEL = /^=\?base64\?(.*)\?=$/s;
export function encodeMcpHeaderValue(value: string | number | boolean): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new McpProtocolError(-32020, "HeaderMismatch");
  const raw = String(value);
  if (Buffer.byteLength(raw) > 4096) throw new McpProtocolError(-32020, "HeaderMismatch");
  return /^[\x09\x20-\x7e]*$/.test(raw) && raw.trim() === raw && !SENTINEL.test(raw) ? raw : `=?base64?${Buffer.from(raw, "utf8").toString("base64")}?=`;
}
export function decodeMcpHeaderValue(value: string): string {
  if (typeof value !== "string" || value.length > 5500 || !/^[\x09\x20-\x7e]*$/.test(value) || value.trim() !== value) throw new McpProtocolError(-32020, "HeaderMismatch");
  const encoded = SENTINEL.exec(value);
  if (!encoded) return value;
  const body = encoded[1]!;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)) throw new McpProtocolError(-32020, "HeaderMismatch");
  try {
    const bytes = Buffer.from(body, "base64"), decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (bytes.toString("base64") !== body || bytes.length > 4096) throw new Error();
    return decoded;
  } catch { throw new McpProtocolError(-32020, "HeaderMismatch"); }
}
interface HeaderAnnotation { name: string; path: string[]; type: "string" | "integer" | "boolean" }
const FIELD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED = /^(?:authorization|proxy-authorization|cookie|set-cookie|host|mcp-method|mcp-name|mcp-protocol-version|.*(?:credential|capability|token|account|principal|owner|bot|profile).*)$/i;
export function mcpHeaderAnnotations(schema: unknown): HeaderAnnotation[] {
  const annotations: HeaderAnnotation[] = [], seen = new Set<string>(); let count = 0;
  const walk = (node: unknown, path: string[], reachable: boolean, depth: number): void => {
    if (++count > 4096 || depth > 32) throw new McpProtocolError(-32602, "Invalid header annotation");
    if (Array.isArray(node)) { node.forEach(item => walk(item, path, false, depth + 1)); return; }
    if (!object(node)) return;
    if (Object.hasOwn(node, "x-mcp-header")) {
      const name = node["x-mcp-header"];
      if (!reachable || !path.length || typeof name !== "string" || name.length > 64 || !FIELD.test(name) || RESERVED.test(name)
        || seen.has(name.toLowerCase()) || !["string", "integer", "boolean"].includes(String(node.type))) throw new McpProtocolError(-32602, "Invalid header annotation");
      seen.add(name.toLowerCase()); annotations.push({ name, path, type: node.type as HeaderAnnotation["type"] });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" && object(value)) for (const [prop, child] of Object.entries(value)) walk(child, [...path, prop], reachable, depth + 1);
      else if (key !== "x-mcp-header") walk(value, path, false, depth + 1);
    }
  };
  walk(schema, [], true, 0); return annotations;
}
export function buildModernMcpHeaders(request: unknown, schema?: unknown): Record<string, string> {
  if (!object(request) || typeof request.method !== "string" || !/^[A-Za-z0-9_.\/-]{1,128}$/.test(request.method)) throw new McpProtocolError(-32020, "HeaderMismatch");
  const params = object(request.params) ? request.params : {}, metadata = modernMetadata(params);
  if (!metadata.modern) throw new McpProtocolError(-32020, "HeaderMismatch");
  const headers: Record<string, string> = { "MCP-Protocol-Version": MCP_MODERN_VERSION, "Mcp-Method": request.method };
  if (["tools/call", "prompts/get", "resources/read"].includes(request.method)) {
    const name = request.method === "resources/read" ? params.uri : params.name;
    if (typeof name !== "string" || !name.length) throw new McpProtocolError(-32020, "HeaderMismatch");
    headers["Mcp-Name"] = encodeMcpHeaderValue(name);
  }
  if (request.method === "tools/call" && schema !== undefined) for (const annotation of mcpHeaderAnnotations(schema)) {
    let value: unknown = params.arguments;
    for (const key of annotation.path) value = object(value) && Object.hasOwn(value, key) ? value[key] : undefined;
    if (value === undefined || value === null) continue;
    if ((annotation.type === "integer" && !Number.isSafeInteger(value)) || (annotation.type !== "integer" && typeof value !== annotation.type)) throw new McpProtocolError(-32020, "HeaderMismatch");
    headers[`Mcp-Param-${annotation.name}`] = encodeMcpHeaderValue(value as string | number | boolean);
  }
  return headers;
}
/** Pure pre-dispatch adapter. Never accepts a header as an alternate routing/account authority. */
export function validateModernMcpHeaders(request: unknown, incoming: Record<string, string | string[] | undefined>, schema?: unknown): void {
  const expected = buildModernMcpHeaders(request, schema), values = new Map<string, string>();
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (values.has(lower) || Array.isArray(value)) throw new McpProtocolError(-32020, "HeaderMismatch");
    if (value !== undefined) values.set(lower, value);
  }
  for (const [name, value] of Object.entries(expected)) {
    const received = values.get(name.toLowerCase());
    const encodedField = name === "Mcp-Name" || name.startsWith("Mcp-Param-");
    if (received === undefined || (encodedField ? decodeMcpHeaderValue(received) !== decodeMcpHeaderValue(value) : received !== value)) throw new McpProtocolError(-32020, "HeaderMismatch");
  }
  const annotations = schema === undefined ? [] : mcpHeaderAnnotations(schema);
  for (const annotation of annotations) if (!Object.keys(expected).some(name => name.toLowerCase() === `mcp-param-${annotation.name.toLowerCase()}`) && values.has(`mcp-param-${annotation.name.toLowerCase()}`)) throw new McpProtocolError(-32020, "HeaderMismatch");
}

export interface MrtrBinding { principal: string; connectionId: string; logicalCallId: string; method: "tools/call" | "resources/read" | "prompts/get"; requestHash: string; pin: string }
interface Round { binding: string; expires: number; opaque: string; previousRpcId: string | number; rounds: number; consumed: boolean }
/** Host-private opaque MRTR state. The handle contains no upstream state, identity, OAuth or form contents. */
export class McpMrtrVault {
  readonly #key = randomBytes(32); readonly #rounds = new Map<string, Round>();
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = 300_000, private readonly maxRounds = 3) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000 || !Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 8) throw new Error("Invalid MRTR limits");
  }
  issue(binding: MrtrBinding, opaque: string, rpcId: string | number, rounds = 0): string {
    this.prune();
    if (!binding || !["tools/call", "resources/read", "prompts/get"].includes(binding.method) || !/^[a-f0-9]{64}$/.test(binding.requestHash)
      || Object.keys(binding).some(key => !["principal", "connectionId", "logicalCallId", "method", "requestHash", "pin"].includes(key))
      || [binding.principal, binding.connectionId, binding.logicalCallId, binding.pin].some(value => typeof value !== "string" || !value.length || Buffer.byteLength(value) > 2048)) throw new McpProtocolError(-32602, "MRTR binding refused");
    if (this.#rounds.size >= 128 || typeof opaque !== "string" || Buffer.byteLength(opaque) > 16_384 || !Number.isSafeInteger(rounds) || rounds < 0 || rounds >= this.maxRounds) throw new McpProtocolError(-32602, "MRTR limit exceeded");
    const id = randomBytes(24).toString("base64url"), tag = createHmac("sha256", this.#key).update(id).digest("base64url");
    this.#rounds.set(id, { binding: JSON.stringify(binding), expires: this.now() + this.ttlMs, opaque, previousRpcId: rpcId, rounds: rounds + 1, consumed: false });
    return `${id}.${tag}`;
  }
  consume(handle: string, binding: MrtrBinding, rpcId: string | number, authorized: () => boolean): { requestState: string; rounds: number } {
    this.prune();
    if (typeof handle !== "string" || !/^[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{43}$/.test(handle)) throw new McpProtocolError(-32602, "MRTR continuation refused");
    const [id, tag] = handle.split("."), expected = createHmac("sha256", this.#key).update(id!).digest(), actual = Buffer.from(tag!, "base64url");
    const round = this.#rounds.get(id!);
    if (actual.toString("base64url") !== tag || actual.length !== expected.length || !timingSafeEqual(actual, expected) || !round || round.consumed || round.binding !== JSON.stringify(binding)
      || round.previousRpcId === rpcId || this.now() >= round.expires || !authorized()) throw new McpProtocolError(-32602, "MRTR continuation refused");
    round.consumed = true; const result = { requestState: round.opaque, rounds: round.rounds }; round.opaque = ""; return result;
  }
  revoke(): void { this.#rounds.clear(); }
  private prune(): void { for (const [id, round] of this.#rounds) if (this.now() >= round.expires) this.#rounds.delete(id); }
}
