import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { McpConnectorError } from "./errors.js";

export interface McpEgressPolicy {
  placement: "owner_mac" | "cloud";
  /** Explicit owner-reviewed exact origins. Cloud cannot use loopback, link-local or metadata destinations. */
  privateOrigins?: readonly string[];
}
export interface McpResolvedAddress { address: string; family: 4 | 6 }
export interface McpEgressNetwork {
  lookup(host: string): Promise<readonly McpResolvedAddress[]>;
  /** MUST connect to pinned address, retain URL hostname for TLS verification, and never resolve/redirect again. */
  request(url: URL, address: McpResolvedAddress, init?: RequestInit): Promise<Response>;
}
const refused = (): never => { throw new McpConnectorError("egress_refused", null, null, { phase: "pre_dispatch", effect: "none" }); };
/** Closed startup configuration: only literal owner-reviewed origins, never advertised OAuth metadata. */
export function checkMcpEgressPolicy(raw: unknown, expectedPlacement?: McpEgressPolicy["placement"]): Readonly<McpEgressPolicy> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return refused();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !["placement", "privateOrigins"].includes(key)) || !["owner_mac", "cloud"].includes(value.placement as string) || expectedPlacement !== undefined && value.placement !== expectedPlacement) return refused();
  const origins = value.privateOrigins ?? [];
  if (!Array.isArray(origins) || origins.length > 64 || value.placement === "cloud" && origins.length !== 0) return refused();
  const normalized: string[] = [];
  for (const entry of origins) {
    if (typeof entry !== "string" || entry.length < 1 || entry.length > 512 || entry !== entry.trim()) return refused();
    let url: URL; try { url = new URL(entry); } catch { return refused(); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin === "null") return refused();
    const address = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(address) && mcpAddressScope(address) === "forbidden") return refused();
    if (normalized.includes(url.origin)) return refused();
    normalized.push(url.origin);
  }
  return Object.freeze({ placement: value.placement as McpEgressPolicy["placement"], privateOrigins: Object.freeze(normalized) });
}
const ipv4 = (ip: string): number[] => ip.split(".").map(Number);
export function mcpAddressScope(raw: string): "public" | "private" | "forbidden" {
  const ip = raw.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(ip);
  if (family === 4) {
    const [a,b,c] = ipv4(ip);
    if (a === 0 || a === 169 && b === 254 || a! >= 224 || a === 255) return "forbidden";
    if (a === 10 || a === 127 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168 || a === 100 && b! >= 64 && b! <= 127
      || a === 192 && b === 0 || a === 198 && (b === 18 || b === 19) || a === 192 && b === 0 && c === 2 || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113) return "private";
    return "public";
  }
  if (family === 6) {
    // Expand to groups to recognize IPv4-mapped spellings, including hexadecimal notation.
    const dotted = ip.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    let expanded = dotted ? ip.slice(0,-dotted.length) + ipv4(dotted).reduce((s,n,i,a) => i % 2 === 0 ? s + `${((n << 8) | a[i+1]!).toString(16)}${i === 0 ? ":" : ""}` : s, "") : ip;
    const halves = expanded.split("::");
    const left = halves[0] ? halves[0].split(":") : [], right = halves[1] ? halves[1].split(":") : [];
    const groups = halves.length === 2 ? [...left,...Array(8-left.length-right.length).fill("0"),...right] : left;
    const nums = groups.map((s) => parseInt(s,16));
    if (nums.length !== 8) return "forbidden";
    if (nums.slice(0,5).every((n) => n === 0) && nums[5] === 0xffff) return mcpAddressScope(`${nums[6]! >> 8}.${nums[6]! & 255}.${nums[7]! >> 8}.${nums[7]! & 255}`);
    if (nums.every((n) => n === 0) || nums[0]! >= 0xff00 || (nums[0]! & 0xffc0) === 0xfe80) return "forbidden";
    if (nums.slice(0,7).every((n) => n === 0) && nums[7] === 1 || (nums[0]! & 0xfe00) === 0xfc00 || (nums[0]! & 0xffc0) === 0xfec0 || nums[0] === 0x2001 && nums[1] === 0xdb8) return "private";
    // IPv4-compatible, NAT64, 6to4 and Teredo can hide restricted destinations.
    if (nums[0] === 0 || nums[0] === 0x64 || nums[0] === 0x2002 || nums[0] === 0x2001 && nums[1] === 0) return "forbidden";
    if((nums[0]! & 0xe000)!==0x2000)return "forbidden";
    return "public";
  }
  return "forbidden";
}
export async function resolveMcpDestination(url: URL, policy: McpEgressPolicy, network: McpEgressNetwork = NODE_MCP_EGRESS): Promise<McpResolvedAddress> {
  if (url.username || url.password || url.hash || !["https:","http:"].includes(url.protocol)) return refused();
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const privateAllowed = policy.privateOrigins?.includes(url.origin) === true;
  if (url.protocol === "http:" && !(privateAllowed && policy.placement === "owner_mac")) return refused();
  let addresses: readonly McpResolvedAddress[];
  try { addresses = isIP(host) ? [{ address: host, family: isIP(host) as 4 | 6 }] : await network.lookup(host); } catch { return refused(); }
  if (!addresses.length || addresses.length > 32) return refused();
  for (const item of addresses) {
    if(isIP(item.address)!==item.family)return refused();
    const scope = mcpAddressScope(item.address);
    if (scope === "forbidden" || scope === "private" && !privateAllowed || policy.placement === "cloud" && scope !== "public") return refused();
  }
  return addresses[0]!;
}
/** The owner reviewed the literal local resource origin in the definition; this never trusts an advertised issuer. */
export function reviewedMcpEgressPolicy(resource: URL, base: McpEgressPolicy): McpEgressPolicy {
  const loopback=["localhost","127.0.0.1","[::1]"].includes(resource.hostname);
  return {...base,...(base.placement==="owner_mac"&&loopback?{privateOrigins:[...new Set([...(base.privateOrigins??[]),resource.origin])]}:{})};
}
export const NODE_MCP_EGRESS: McpEgressNetwork = {
  lookup: async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family as 4 | 6 })),
  request: (url, address, init = {}) => new Promise<Response>((resolve, reject) => {
    const headers: Record<string,string> = {}; new Headers(init.headers).forEach((value,key) => { headers[key] = value; });
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, { method: init.method ?? "GET", headers, agent: false, family: address.family,
      lookup: (_host, _options, callback) => callback(null, address.address, address.family),
      ...(init.signal ? { signal: init.signal } : {}) }, (res) => {
        const responseHeaders = new Headers();
        for (const [key,value] of Object.entries(res.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
        const status = res.statusCode ?? 502;
        resolve(new Response([204,205,304].includes(status) ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }));
      });
    req.on("error", () => reject(new McpConnectorError("transport_failed", null, null, { phase: "dispatch", effect: "possible" })));
    if (init.body === undefined || init.body === null) req.end();
    else if(init.body instanceof URLSearchParams)req.end(init.body.toString());
    else if (typeof init.body === "string" || init.body instanceof Uint8Array) req.end(init.body);
    else { req.destroy(); reject(new McpConnectorError("arguments_refused")); }
  }),
};
/** Security applies to the actual socket lookup; validation is never followed by an unpinned fetch. */
export function createMcpEgressFetch(policy: McpEgressPolicy, network: McpEgressNetwork = NODE_MCP_EGRESS): typeof globalThis.fetch {
  const checked = checkMcpEgressPolicy(policy);
  return async (input, init) => {
    if(init?.signal?.aborted)throw new McpConnectorError("aborted",null,null,{phase:"pre_dispatch",effect:"none"});
    let url: URL;
    try { url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input); } catch { return refused(); }
    if (input instanceof Request) return refused(); // no hidden streams/headers
    const address = await resolveMcpDestination(url, checked, network);
    if(init?.signal?.aborted)throw new McpConnectorError("aborted",null,null,{phase:"pre_dispatch",effect:"none"});
    const response = await network.request(url, address, { ...init, redirect: "manual", credentials: "omit" });
    if (response.type === "opaqueredirect" || response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new McpConnectorError("upstream_redirect"); }
    return response;
  };
}
