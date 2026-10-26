import { createHash } from "node:crypto";
import { checkManifest, GatewayError, type ArgumentSchema, type InputSchema, type ScalarSchema, type ToolManifest } from "@dexter/gateway";
import { mcpLogicalHost, mcpToolkit, type McpServerDefinition } from "./definition.js";
import { McpConnectorError } from "./errors.js";
import type { McpDiscoveredTool } from "./session.js";
import { assertSupportedMcpSchema } from "./schema.js";
import { assertSafeMcpMetadata } from "./metadata-security.js";

/**
 * What discovery proposes for one upstream tool. Only `publishable` tools carry a manifest; the owner decides
 * which to register in the gateway, and each bot still needs a hub grant per tool and connection.
 */
export interface McpToolPlan {
  mcpName: string;
  status: "publishable" | "unsupported_schema" | "refused_by_policy" | "filtered";
  /** Fixed reason or the gateway's validation message (names schema fields, never values). */
  reason: string | null;
  manifest: ToolManifest | null;
  /** Dexter argument name -> upstream argument name. */
  argumentNames: Record<string, string> | null;
  /** Upstream annotations as published. Informational only: they never change effect or approval. */
  upstreamHints: McpDiscoveredTool["annotations"];
}

const SIMPLE_NAME = /^[a-z][a-z0-9_]{0,80}$/;
const PROPERTY = /^[a-z][a-z0-9_]{0,63}$/;
const DEFAULT_MAX_LENGTH = 8192;
const MAX_STRING = 65_536;
const MAX_ITEMS = 100;
/** Pure annotations: dropping them does not widen what upstream accepts. */
const IGNORED = new Set(["title", "description", "default", "examples", "$comment", "deprecated", "readOnly", "writeOnly", "format"]);
/** Constraints upstream still enforces itself; Dexter's schema is wider only where upstream validates. */
const UPSTREAM_ENFORCED = new Set(["minItems", "uniqueItems"]);

const hash8 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 8);

/** Stable token from an upstream tool name: the name itself when already simple, else sanitized plus a hash. */
export function mcpToolToken(mcpName: string): string {
  if (SIMPLE_NAME.test(mcpName)) return mcpName;
  let base = mcpName.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  if (!/^[a-z]/.test(base)) base = `t_${base}`.replace(/_+$/, "");
  return `${base}_${hash8(mcpName)}`;
}
export const mcpToolName = (serverId: string, mcpName: string): string => `mcp.${serverId}.${mcpToolToken(mcpName)}`;

/** camelCase / kebab-case upstream names map to the gateway's snake_case argument names. */
function argumentName(upstream: string): string | null {
  const snake = upstream.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
  return PROPERTY.test(snake) ? snake : null;
}

class Unsupported extends Error {}
const unsupported = (why: string): never => { throw new Unsupported(why); };

function pattern(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 400) return unsupported("pattern");
  // JSON Schema patterns search anywhere; the gateway applies whole-value matches.
  return raw.startsWith("^") && raw.endsWith("$") ? raw : `^[\\s\\S]*(?:${raw})[\\s\\S]*$`;
}
function scalar(raw: Record<string, unknown>, field: string): ScalarSchema {
  for (const key of Object.keys(raw)) {
    if (!IGNORED.has(key) && !["type", "maxLength", "minLength", "enum", "pattern", "minimum", "maximum"].includes(key)) unsupported(`${field}.${key}`);
  }
  if (raw.type === "boolean") return { type: "boolean" };
  if (raw.type === "integer" || raw.type === "number") {
    if (raw.enum !== undefined || raw.pattern !== undefined || raw.maxLength !== undefined || raw.minLength !== undefined) unsupported(field);
    const out: ScalarSchema = { type: raw.type };
    if (raw.minimum !== undefined) out.minimum = raw.minimum as number;
    if (raw.maximum !== undefined) out.maximum = raw.maximum as number;
    return out;
  }
  if (raw.type !== "string") return unsupported(`${field}.type`);
  const max = raw.maxLength === undefined ? DEFAULT_MAX_LENGTH : raw.maxLength;
  if (!Number.isSafeInteger(max) || (max as number) < 1) unsupported(`${field}.maxLength`);
  const out: Extract<ScalarSchema, { type: "string" }> = { type: "string", maxLength: Math.min(max as number, MAX_STRING) };
  if (raw.minLength !== undefined) out.minLength = raw.minLength as number;
  if (raw.enum !== undefined) out.enum = raw.enum as string[];
  if (raw.pattern !== undefined) out.pattern = pattern(raw.pattern);
  return out;
}

/** Converts a published JSON Schema to the gateway's closed, flat schema, or explains why it cannot. */
export function toGatewaySchema(raw: unknown): { schema: InputSchema; argumentNames: Record<string, string> } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return unsupported("inputSchema");
  const s = raw as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (!["type", "properties", "required", "additionalProperties", "$schema"].includes(key) && !IGNORED.has(key)) unsupported(`inputSchema.${key}`);
  }
  if (s.type !== "object") unsupported("inputSchema.type");
  const props = s.properties ?? {};
  if (typeof props !== "object" || props === null || Array.isArray(props)) return unsupported("inputSchema.properties");
  const properties: Record<string, ArgumentSchema> = {};
  const argumentNames: Record<string, string> = {};
  for (const [upstream, value] of Object.entries(props as Record<string, unknown>)) {
    const name = argumentName(upstream);
    if (name === null || Object.hasOwn(properties, name)) unsupported("inputSchema.property_name");
    if (typeof value !== "object" || value === null || Array.isArray(value)) unsupported(`inputSchema.${name}`);
    const v = value as Record<string, unknown>;
    if (v.type === "array") {
      for (const key of Object.keys(v)) {
        if (!IGNORED.has(key) && !UPSTREAM_ENFORCED.has(key) && !["type", "items", "maxItems"].includes(key)) unsupported(`${name}.${key}`);
      }
      if (typeof v.items !== "object" || v.items === null || Array.isArray(v.items)) unsupported(`${name}.items`);
      const maxItems = v.maxItems === undefined ? MAX_ITEMS : v.maxItems;
      if (!Number.isSafeInteger(maxItems) || (maxItems as number) < 1) unsupported(`${name}.maxItems`);
      properties[name!] = { type: "array", items: scalar(v.items as Record<string, unknown>, `${name}.items`), maxItems: Math.min(maxItems as number, MAX_ITEMS) };
    } else {
      properties[name!] = scalar(v, name!);
    }
    argumentNames[name!] = upstream;
  }
  const required = s.required ?? [];
  if (!Array.isArray(required) || !required.every((r) => typeof r === "string" && Object.values(argumentNames).includes(r))) unsupported("inputSchema.required");
  const byUpstream = new Map(Object.entries(argumentNames).map(([d, u]) => [u, d]));
  return {
    schema: { type: "object", properties, required: (required as string[]).map((r) => byUpstream.get(r)!), additionalProperties: false },
    argumentNames,
  };
}

function selected(definition: McpServerDefinition, name: string): boolean {
  if (definition.disabledTools.includes(name)) return false;
  return definition.enabledTools === null || definition.enabledTools.includes(name);
}

/**
 * Plans gateway manifests for discovered tools. Every manifest is checked by the gateway's own validator, so
 * its policy (no meta-tools, no principal/code/network arguments, closed flat schemas) applies unchanged.
 * `effect` is `write` unless the owner listed the tool in `readOnlyTools`; upstream annotations are ignored.
 * The manifest `version` is the hash of the exact published definition, so any upstream change to the tool
 * (description, schema, annotations) is a different version and is refused until re-reviewed.
 */
export function planMcpTools(definition: McpServerDefinition, tools: readonly McpDiscoveredTool[]): McpToolPlan[] {
  const seen = new Set<string>();
  return tools.map((tool): McpToolPlan => {
    const base = { mcpName: tool.name, upstreamHints: tool.annotations, manifest: null, argumentNames: null };
    if (tool.schemaUnsupported) return { ...base, status: "unsupported_schema", reason: "schema_unsupported" };
    if (tool.quarantine) return { ...base, status: "unsupported_schema", reason: "metadata_quarantined" };
    if (!selected(definition, tool.name)) return { ...base, status: "filtered", reason: "not_selected_in_definition" };
    let argumentNames: Record<string,string>;
    try {
      assertSafeMcpMetadata(tool);
      assertSupportedMcpSchema(tool.inputSchema);
      if(tool.outputSchema)assertSupportedMcpSchema(tool.outputSchema);
      const properties=tool.inputSchema.properties as Record<string,unknown>|undefined;
      argumentNames=Object.fromEntries(Object.keys(properties??{}).map(name=>[name,name]));
    } catch (error) {
      if (error instanceof McpConnectorError) return { ...base, status: "unsupported_schema", reason: error.code };
      throw error;
    }
    const name = mcpToolName(definition.id, tool.name);
    if (seen.has(name)) return { ...base, status: "unsupported_schema", reason: "name_collision" };
    seen.add(name);
    let manifest: ToolManifest;
    try {
      manifest = checkManifest({
        name, toolkit: mcpToolkit(definition.id), upstreamSlug: mcpToolToken(tool.name), version: tool.definitionHash,
        description: tool.description.slice(0, 1024), upstreamHost: mcpLogicalHost(definition.id),
        effect: definition.readOnlyTools.includes(tool.name) ? "read" : "write",
        inputSchema: { type:"object",properties:{},required:[],additionalProperties:false },
        nativeInputSchema: tool.inputSchema,
        ...(tool.outputSchema?{nativeOutputSchema:tool.outputSchema}:{}),destinationArgument: null, destinationOrigins: null,
      });
    } catch (error) {
      if (!(error instanceof GatewayError)) throw error;
      return { ...base, status: error.code === "meta_tool_refused" ? "refused_by_policy" : "unsupported_schema", reason: error.message };
    }
    return { ...base, status: "publishable", reason: null, manifest, argumentNames };
  });
}

export interface McpCatalogEntry {
  serverId: string;
  /** Gateway manifest name, upstream slug and pinned version (definition hash). */
  toolName: string;
  upstreamSlug: string;
  version: string;
  mcpName: string;
  argumentNames: Readonly<Record<string, string>>;
  /** Exact native JSON schema authorizes dynamic keys only through the trusted gateway/native validators. */
  nativeSchema: Record<string,unknown> | null;
}
export interface McpCatalogSource {
  find(serverId: string, upstreamSlug: string): McpCatalogEntry | null;
}

/**
 * Immutable, owner-approved mapping from gateway manifests back to upstream MCP tools. It must be built from
 * the same plans whose manifests were registered; the adapter calls nothing outside it.
 */
export class McpToolCatalog implements McpCatalogSource {
  private readonly entries: ReadonlyMap<string, McpCatalogEntry>;
  constructor(serverId: string, plans: readonly McpToolPlan[]) {
    const entries = new Map<string, McpCatalogEntry>();
    for (const plan of plans) {
      if (plan.status !== "publishable" || !plan.manifest || !plan.argumentNames) continue;
      const m = plan.manifest;
      if (m.toolkit !== mcpToolkit(serverId) || m.upstreamHost !== mcpLogicalHost(serverId) || entries.has(m.upstreamSlug)) {
        throw new McpConnectorError("invalid_definition", "catalog");
      }
      entries.set(m.upstreamSlug, Object.freeze({
        serverId, toolName: m.name, upstreamSlug: m.upstreamSlug, version: m.version, mcpName: plan.mcpName,
        argumentNames: Object.freeze({ ...plan.argumentNames }),
        nativeSchema: m.nativeInputSchema ?? null,
      }));
    }
    this.entries = entries;
    this.serverId = serverId;
    Object.freeze(this);
  }
  private readonly serverId: string;
  find(serverId: string, upstreamSlug: string): McpCatalogEntry | null {
    return serverId === this.serverId ? this.entries.get(upstreamSlug) ?? null : null;
  }
  list(): McpCatalogEntry[] { return [...this.entries.values()]; }
}

/** Several servers' catalogs behind one lookup. */
export class McpCatalogSet implements McpCatalogSource {
  constructor(private readonly catalogs: readonly McpCatalogSource[]) { Object.freeze(this); }
  find(serverId: string, upstreamSlug: string): McpCatalogEntry | null {
    for (const c of this.catalogs) { const hit = c.find(serverId, upstreamSlug); if (hit) return hit; }
    return null;
  }
}
