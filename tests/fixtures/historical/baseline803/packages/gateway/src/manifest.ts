import { createHash } from "node:crypto";
import type { JsonValue } from "@dexter/contracts";
import { canonicalJson } from "@dexter/hub";
import { GatewayError } from "./errors.js";

/**
 * Pinned tool metadata. A manifest names exactly one upstream tool of one toolkit at one version, with a
 * closed, flat argument schema. There is no field through which a call can choose another account,
 * toolkit, tool, URL or code: those are fixed by the manifest and the connection, never by arguments.
 */
export interface ToolManifest {
  /** Dexter tool name; the hub grant is keyed by (bot, name, connectionId). */
  name: string;
  toolkit: string;
  upstreamSlug: string;
  version: string;
  description: string;
  /** The only host the trusted adapter may contact for this tool; credentials are released for it alone. */
  upstreamHost: string;
  effect: "read" | "write";
  inputSchema: InputSchema;
  /**
   * Argument naming the external target (channel, recipient, webhook...). Must be a required string (or array
   * of strings) restricted by enum or anchored pattern. Patterns are always applied as one whole-value match.
   */
  destinationArgument: string | null;
  /**
   * HTTPS origins a URL destination may point at. Required when the destination is a URL (network-named
   * argument, or enum/pattern mentioning a scheme); then every value must parse as a canonical https URL,
   * without credentials or port, whose origin is listed here. The regex is never the judge of a URL.
   */
  destinationOrigins: string[] | null;
}
export type ScalarSchema =
  | { type: "string"; maxLength: number; minLength?: number; enum?: string[]; pattern?: string }
  | { type: "integer" | "number"; minimum?: number; maximum?: number }
  | { type: "boolean" };
export type ArgumentSchema = ScalarSchema | { type: "array"; items: ScalarSchema; maxItems: number };
export interface InputSchema {
  type: "object";
  properties: Record<string, ArgumentSchema>;
  required: string[];
  additionalProperties: false;
}

const TOOL_NAME = /^[a-z][a-z0-9_.-]{1,127}$/;
const SLUG = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const TOOLKIT = /^[a-z][a-z0-9_-]{0,63}$/;
const VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PROPERTY = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_PROPERTIES = 32;
const MAX_STRING = 65_536;
const MAX_ITEMS = 100;
const MAX_ORIGINS = 16;

/** Upstream meta-tools able to search, pick, execute or proxy other tools, accounts, code or URLs. */
const META_SLUG = /^COMPOSIO_|(?:^|_)(?:MULTI_EXECUTE|EXECUTE_TOOL|REMOTE_WORKBENCH|REMOTE_BASH|WORKBENCH|PROXY|PROXY_EXECUTE|RUN_CODE|EXEC|EVAL|SHELL|BASH|MANAGE_CONNECTIONS|SEARCH_TOOLS|GET_TOOL_SCHEMAS|USE_SKILL)(?:_|$)/i;
/** Argument names that would let a caller select the principal, account, tool or authentication. */
const PRINCIPAL_KEYS = new Set([
  "user", "user_id", "userid", "entity", "entity_id", "owner", "owner_id", "profile", "profile_id", "bot", "bot_id",
  "account", "account_id", "connected_account", "connected_account_id", "connection", "connection_id", "auth_config_id",
  "tool", "tools", "tool_slug", "tool_name", "toolkit", "toolkit_slug", "action", "actions", "slug", "app", "integration_id",
  "headers", "header", "auth", "authorization", "session", "session_id", "api_key", "token", "credential", "credentials",
]);
/** Argument names that carry executable payloads. Never allowed. */
const CODE_KEYS = new Set(["code", "script", "command", "cmd", "shell", "eval", "exec", "program", "query_code", "bash"]);
/** Argument names that address arbitrary network targets. Allowed only as a restricted destination argument. */
const NETWORK_KEYS = new Set(["url", "uri", "endpoint", "base_url", "host", "hostname", "domain", "webhook", "webhook_url", "path"]);

function fail(message: string): never { throw new GatewayError("invalid_input", message); }
function refuseMeta(message: string): never { throw new GatewayError("meta_tool_refused", message); }

function checkScalar(name: string, schema: unknown, destination: boolean): ScalarSchema {
  if (typeof schema !== "object" || schema === null) fail(`inputSchema.${name}: invalid`);
  const s = schema as Record<string, unknown>;
  const allowed = new Set(["type", "maxLength", "minLength", "enum", "pattern", "minimum", "maximum"]);
  for (const key of Object.keys(s)) if (!allowed.has(key)) fail(`inputSchema.${name}: unsupported keyword`);
  if (destination && s.type !== "string") fail(`inputSchema.${name}: destination argument must be a string`);
  if (s.type === "boolean") {
    if (Object.keys(s).length !== 1) fail(`inputSchema.${name}: unsupported keyword`);
    return { type: "boolean" };
  }
  if (s.type === "integer" || s.type === "number") {
    for (const key of ["minimum", "maximum"] as const) {
      if (s[key] !== undefined && !Number.isFinite(s[key])) fail(`inputSchema.${name}.${key}: invalid`);
    }
    if (s.maxLength !== undefined || s.minLength !== undefined || s.enum !== undefined || s.pattern !== undefined) fail(`inputSchema.${name}: unsupported keyword`);
    const out: ScalarSchema = { type: s.type };
    if (s.minimum !== undefined) out.minimum = s.minimum as number;
    if (s.maximum !== undefined) out.maximum = s.maximum as number;
    return out;
  }
  if (s.type !== "string") fail(`inputSchema.${name}.type: unsupported`);
  if (!Number.isSafeInteger(s.maxLength) || (s.maxLength as number) < 1 || (s.maxLength as number) > MAX_STRING) fail(`inputSchema.${name}.maxLength: required`);
  if (s.minimum !== undefined || s.maximum !== undefined) fail(`inputSchema.${name}: unsupported keyword`);
  const out: Extract<ScalarSchema, { type: "string" }> = { type: "string", maxLength: s.maxLength as number };
  if (s.minLength !== undefined) {
    if (!Number.isSafeInteger(s.minLength) || (s.minLength as number) < 0) fail(`inputSchema.${name}.minLength: invalid`);
    out.minLength = s.minLength as number;
  }
  if (s.enum !== undefined) {
    if (!Array.isArray(s.enum) || s.enum.length === 0 || s.enum.length > 256 || !s.enum.every((v) => typeof v === "string")) fail(`inputSchema.${name}.enum: invalid`);
    out.enum = [...(s.enum as string[])];
  }
  if (s.pattern !== undefined) {
    if (typeof s.pattern !== "string" || s.pattern.length > 512 || !compilePattern(s.pattern)) fail(`inputSchema.${name}.pattern: must be a valid pattern anchored with ^ and $`);
    out.pattern = s.pattern;
  }
  if (destination && out.enum === undefined && out.pattern === undefined) fail(`inputSchema.${name}: destination argument must be restricted by enum or pattern`);
  return out;
}

/** Validates and normalizes a manifest. Refuses meta-tools and any schema that could choose principal, tool, code or URL. */
export function checkManifest(input: unknown): ToolManifest {
  if (typeof input !== "object" || input === null) fail("manifest: invalid");
  const m = input as Record<string, unknown>;
  const str = (key: string, pattern: RegExp): string => {
    const value = m[key];
    if (typeof value !== "string" || !pattern.test(value)) fail(`manifest.${key}: invalid`);
    return value;
  };
  const name = str("name", TOOL_NAME);
  const toolkit = str("toolkit", TOOLKIT);
  const upstreamSlug = str("upstreamSlug", SLUG);
  if (META_SLUG.test(upstreamSlug) || META_SLUG.test(name.replace(/[.-]/g, "_"))) refuseMeta("opaque meta-tools cannot be registered");
  const version = str("version", VERSION);
  const upstreamHost = str("upstreamHost", HOST);
  if (typeof m.description !== "string" || m.description.length > 1024) fail("manifest.description: invalid");
  if (m.effect !== "read" && m.effect !== "write") fail("manifest.effect: invalid");
  const destinationArgument = m.destinationArgument ?? null;
  if (destinationArgument !== null && (typeof destinationArgument !== "string" || !PROPERTY.test(destinationArgument))) fail("manifest.destinationArgument: invalid");

  const schema = m.inputSchema as Record<string, unknown> | undefined;
  if (typeof schema !== "object" || schema === null || schema.type !== "object" || schema.additionalProperties !== false) {
    fail("manifest.inputSchema: must be a closed object (additionalProperties: false)");
  }
  for (const key of Object.keys(schema)) if (!["type", "properties", "required", "additionalProperties"].includes(key)) fail("manifest.inputSchema: unsupported keyword");
  const rawProps = schema.properties;
  if (typeof rawProps !== "object" || rawProps === null || Array.isArray(rawProps)) fail("manifest.inputSchema.properties: invalid");
  const entries = Object.entries(rawProps as Record<string, unknown>);
  if (entries.length > MAX_PROPERTIES) fail("manifest.inputSchema.properties: too many");
  const properties: Record<string, ArgumentSchema> = {};
  for (const [prop, raw] of entries) {
    if (!PROPERTY.test(prop)) fail("manifest.inputSchema.properties: invalid property name");
    const lower = prop.toLowerCase();
    if (PRINCIPAL_KEYS.has(lower)) refuseMeta(`inputSchema.${prop}: arguments cannot select principal, account, tool or auth`);
    if (CODE_KEYS.has(lower)) refuseMeta(`inputSchema.${prop}: arguments cannot carry code`);
    const isDestination = prop === destinationArgument;
    if (NETWORK_KEYS.has(lower) && !isDestination) refuseMeta(`inputSchema.${prop}: network targets must be the restricted destination argument`);
    const r = raw as Record<string, unknown>;
    if (typeof r === "object" && r !== null && r.type === "array") {
      for (const key of Object.keys(r)) if (!["type", "items", "maxItems"].includes(key)) fail(`inputSchema.${prop}: unsupported keyword`);
      if (!Number.isSafeInteger(r.maxItems) || (r.maxItems as number) < 1 || (r.maxItems as number) > MAX_ITEMS) fail(`inputSchema.${prop}.maxItems: required`);
      properties[prop] = { type: "array", items: checkScalar(`${prop}.items`, r.items, isDestination), maxItems: r.maxItems as number };
    } else {
      properties[prop] = checkScalar(prop, raw, isDestination);
    }
  }
  if (!Array.isArray(schema.required) || !schema.required.every((k) => typeof k === "string" && k in properties)) fail("manifest.inputSchema.required: invalid");
  const required = [...new Set(schema.required as string[])];
  if (destinationArgument !== null && !(destinationArgument in properties)) fail("manifest.destinationArgument: not a declared property");
  if (destinationArgument !== null && !required.includes(destinationArgument)) fail("manifest.destinationArgument: must be required");
  const destinationOrigins = checkOrigins(m.destinationOrigins);
  if (destinationOrigins !== null && destinationArgument === null) fail("manifest.destinationOrigins: requires a destinationArgument");
  if (destinationArgument !== null) {
    const prop = properties[destinationArgument]!;
    const scalar = prop.type === "array" ? prop.items : prop;
    if (scalar.type !== "string") fail("manifest.destinationArgument: must be a string");
    const urlLike = NETWORK_KEYS.has(destinationArgument.toLowerCase()) || (scalar.pattern !== undefined && looksLikeUrl(scalar.pattern))
      || (scalar.enum ?? []).some(looksLikeUrl);
    if (urlLike && destinationOrigins === null) fail("manifest.destinationOrigins: a URL destination needs explicit https origins");
    if (destinationOrigins !== null && !(scalar.enum ?? []).every((value) => urlAllowed(value, destinationOrigins))) {
      fail(`inputSchema.${destinationArgument}.enum: every URL must be canonical https on an allowed origin`);
    }
  }
  return {
    name, toolkit, upstreamSlug, version, description: m.description, upstreamHost, effect: m.effect, destinationArgument,
    destinationOrigins, inputSchema: { type: "object", properties, required, additionalProperties: false },
  };
}

/**
 * Compiles a schema pattern as one whole-value match. The pattern must start with ^ and end with $, and its
 * body must compile on its own (so parentheses balance and no trailing escape eats the anchor); it is then
 * applied as ^(?:body)$, so top-level alternation such as `^https://ok\.test/|/ok$` cannot escape the anchors.
 */
function compilePattern(pattern: string): RegExp | null {
  if (!pattern.startsWith("^") || !pattern.endsWith("$") || pattern.length < 2) return null;
  const body = pattern.slice(1, -1);
  try {
    new RegExp(body, "u");
    return new RegExp(`^(?:${body})$`, "u");
  } catch { return null; }
}
/** Registration-time hint only; at call time a label destination refuses any URL-shaped value anyway. */
function looksLikeUrl(text: string): boolean {
  return text.includes("://") || text.includes("\\/\\/") || text.startsWith("//") || /^\^?https?:/i.test(text);
}
function checkOrigins(input: unknown): string[] | null {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_ORIGINS) fail("manifest.destinationOrigins: invalid");
  const origins = input.map((origin) => {
    let url: URL | null = null;
    try { url = typeof origin === "string" ? new URL(origin) : null; } catch { url = null; }
    if (!url || url.protocol !== "https:" || url.origin !== origin || url.port !== "" || !HOST.test(url.hostname)) {
      fail("manifest.destinationOrigins: each entry must be an https origin such as https://hooks.example.com");
    }
    return origin;
  });
  return [...new Set(origins)].sort();
}
/** A URL destination is accepted only in canonical form, https, without userinfo or port, on a listed origin. */
function urlAllowed(value: string, origins: readonly string[]): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === ""
    && url.href === value && origins.includes(url.origin);
}

export function manifestHash(manifest: ToolManifest): string {
  return createHash("sha256").update(canonicalJson(manifest as unknown as JsonValue)).digest("hex");
}

function checkScalarValue(name: string, schema: ScalarSchema, value: JsonValue): void {
  switch (schema.type) {
    case "boolean":
      if (typeof value !== "boolean") fail(`arguments.${name}: expected boolean`);
      return;
    case "integer":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isSafeInteger(value))) fail(`arguments.${name}: expected ${schema.type}`);
      if (schema.minimum !== undefined && value < schema.minimum) fail(`arguments.${name}: below minimum`);
      if (schema.maximum !== undefined && value > schema.maximum) fail(`arguments.${name}: above maximum`);
      return;
    case "string":
      if (typeof value !== "string") fail(`arguments.${name}: expected string`);
      if (value.length > schema.maxLength) fail(`arguments.${name}: too long`);
      if (schema.minLength !== undefined && value.length < schema.minLength) fail(`arguments.${name}: too short`);
      if (schema.enum !== undefined && !schema.enum.includes(value)) fail(`arguments.${name}: not an allowed value`);
      if (schema.pattern !== undefined && !compilePattern(schema.pattern)?.test(value)) fail(`arguments.${name}: not an allowed value`);
      return;
  }
}

/**
 * Validates model-supplied arguments against the pinned schema. Unknown keys are refused (named only as
 * "unexpected property", since the key itself is untrusted); messages never include values.
 */
export function validateArguments(schema: InputSchema, input: unknown): Record<string, JsonValue> {
  if (typeof input !== "object" || input === null || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) fail("arguments: expected object");
  const args = input as Record<string, JsonValue>;
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(schema.properties, key)) fail("arguments: unexpected property");
  }
  for (const key of schema.required) if (!Object.hasOwn(args, key)) fail(`arguments.${key}: required`);
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties[key]!;
    if (prop.type === "array") {
      if (!Array.isArray(value)) fail(`arguments.${key}: expected array`);
      if (value.length > prop.maxItems) fail(`arguments.${key}: too many items`);
      value.forEach((item) => checkScalarValue(key, prop.items, item));
      out[key] = [...value];
    } else {
      checkScalarValue(key, prop, value);
      out[key] = value;
    }
  }
  return out;
}

/** Validates arguments against a manifest: the schema, then the destination rules (URL origin or plain label). */
export function validateCall(manifest: ToolManifest, input: unknown): Record<string, JsonValue> {
  const args = validateArguments(manifest.inputSchema, input);
  const name = manifest.destinationArgument;
  if (name === null) return args;
  const value = args[name];
  for (const target of Array.isArray(value) ? value : [value]) {
    if (typeof target !== "string") fail(`arguments.${name}: expected string`);
    const ok = manifest.destinationOrigins !== null
      ? urlAllowed(target, manifest.destinationOrigins)
      // A label destination (channel, recipient) never smuggles a URL or authority.
      : !target.includes("://") && !target.startsWith("//") && !target.includes("\\");
    if (!ok) fail(`arguments.${name}: not an allowed destination`);
  }
  return args;
}
