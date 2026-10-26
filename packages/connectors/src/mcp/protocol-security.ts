import { McpConnectorError } from "./errors.js";
const refused = (): never => { throw new McpConnectorError("header_mismatch", null, null, { phase: "pre_dispatch", effect: "none" }); };
const RESERVED=/^(?:authorization|proxy-authorization|cookie|set-cookie|host|mcp-method|mcp-name|mcp-protocol-version|.*(?:credential|capability|token|account|principal|owner|bot|profile).*)$/i;
export function encodeMcpHeaderValue(value: string): string {
  if (Buffer.byteLength(value,"utf8") > 8192) return refused();
  return /^[\x20-\x7e\t]*$/.test(value) && value === value.trim() && !(value.startsWith("=?base64?") && value.endsWith("?="))
    ? value : `=?base64?${Buffer.from(value,"utf8").toString("base64")}?=`;
}
export interface McpHeaderDeclaration { name: string; path: string[]; type: "string" | "integer" | "boolean" }
export function mcpHeaderDeclarations(schema: unknown): McpHeaderDeclaration[] {
  const declarations: McpHeaderDeclaration[] = [], names = new Set<string>();
  const walk = (raw: unknown, path: string[], reachable: boolean): void => {
    if (!raw || typeof raw !== "object") return;
    if (Array.isArray(raw)) { for (const item of raw) walk(item,path,false); return; }
    const s = raw as Record<string,unknown>;
    if (Object.hasOwn(s,"x-mcp-header")) {
      const name = s["x-mcp-header"], type = s.type;
      if (!reachable || !path.length || typeof name !== "string" || name.length > 64 || !/^[!#$%&'*+.^_`|~a-z0-9-]+$/i.test(name)
        || RESERVED.test(name) || names.has(name.toLowerCase()) || !["string","integer","boolean"].includes(type as string)) return refused();
      names.add(name.toLowerCase()); declarations.push({ name, path, type: type as McpHeaderDeclaration["type"] });
    }
    for (const [key,value] of Object.entries(s)) {
      if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
        for (const [prop,child] of Object.entries(value)) walk(child,[...path,prop],reachable);
      } else if (key !== "x-mcp-header") walk(value,path,false);
    }
  };
  walk(schema,[],true); if (declarations.length > 32) return refused(); return declarations;
}
export function mcpParameterHeaders(schema: unknown, args: Record<string,unknown>): Record<string,string> {
  const out: Record<string,string> = {};
  for (const declaration of mcpHeaderDeclarations(schema)) {
    let value: unknown = args;
    for (const key of declaration.path) value = value && typeof value === "object" && Object.hasOwn(value,key) ? (value as Record<string,unknown>)[key] : undefined;
    if (value === undefined) continue;
    if (declaration.type === "integer" ? !Number.isSafeInteger(value) : typeof value !== declaration.type) return refused();
    out[`mcp-param-${declaration.name.toLowerCase()}`] = encodeMcpHeaderValue(String(value));
  }
  return out;
}
/** Validate SDK-generated mirrored headers against the body before attaching any credentials or dispatching. */
export function validateMcpRequestHeaders(body: BodyInit | null | undefined, headers: Headers): void {
  if (typeof body !== "string") return;
  let message: Record<string,unknown>;
  try { message = JSON.parse(body) as Record<string,unknown>; } catch { return refused(); }
  const version = headers.get("mcp-protocol-version");
  if (version !== "2026-07-28") return;
  const params = message.params as Record<string,unknown> | undefined;
  const meta = params?._meta as Record<string,unknown> | undefined;
  if (meta?.["io.modelcontextprotocol/protocolVersion"] !== version || headers.get("mcp-method") !== message.method) return refused();
  const name = params?.name ?? params?.uri;
  if (["tools/call","resources/read","prompts/get"].includes(message.method as string)
    && (typeof name !== "string" || headers.get("mcp-name") !== encodeMcpHeaderValue(name))) return refused();
}
/** SDK 2.3.1 treats HeaderMismatch/MissingCapability probe errors as legacy; Dexter must not downgrade them. */
export function validateMcpProbeEvidence(raw:unknown):void {
  const message=raw as {error?:{code?:unknown;data?:unknown};result?:Record<string,unknown>};
  const error=message?.error;
  if(error) {
    // Modern versioning defines ANY unrecognized RPC error as legacy evidence, including Python SDK
    // Missing session ID (-32600) and unknown-method parameter validation (-32602).
    if(![-32020,-32021,-32022].includes(error.code as number))return;
    if(error.code===-32022) {
      const supported=(error.data as {supported?:unknown}|undefined)?.supported;
      if(Array.isArray(supported)&&supported.includes("2026-07-28"))return; // one SDK corrective probe, no effect
    }
    throw new McpConnectorError(error.code===-32020?"header_mismatch":"protocol_unsupported",null,null,{phase:"connect",effect:"none"});
  }
  if(message?.result?.resultType==="complete"&&Array.isArray(message.result.supportedVersions)&&message.result.supportedVersions.includes("2026-07-28"))return;
  throw new McpConnectorError("protocol_unsupported",null,null,{phase:"connect",effect:"none"});
}
