import { createHash } from "node:crypto";
import { nativeMcpSchemaResourceWeight, NATIVE_MCP_SCHEMA_RESOURCE_LIMITS, type NativeMcpSchemaResourceWeight } from "@dexter/gateway";
import Ajv2020 from "ajv/dist/2020.js";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { ValidateFunction, FormatDefinition } from "ajv";
import { assertSafeMcpMetadata } from "./metadata-security.js";
import { McpConnectorError } from "./errors.js";

const CACHE_LIMIT = 128;
type CompiledSchema = { validate: ValidateFunction; weight: NativeMcpSchemaResourceWeight };
const validators = new Map<string, CompiledSchema>();
const DRAFT07_HTTP_META = "http://json-schema.org/draft-07/schema";
const DRAFT07_HTTPS_META = "https://json-schema.org/draft-07/schema";
import { checkedMcpPattern, linearMcpRegExp, withMcpPatternBudget, consumeMcpValidationWork, McpPatternWorkLimit } from "./linear-regexp.js";
const options = { validateSchema: false, allErrors: false, strict: false, strictSchema: true, validateFormats: true, discriminator: true, coerceTypes: false, useDefaults: false, removeAdditional: false, addUsedSchema: false, inlineRefs: false, ownProperties: true, loopRequired: 64, loopEnum: 64, code: { regExp: linearMcpRegExp } };
// Meta-schemas are trusted first-party patterns, not upstream runtime patterns. Validate the schema's shape
// independently so AJV never sends its own meta-schema expressions through Dexter's restricted matcher.
const legacyMeta=new Ajv.Ajv({strict:false}),modernMeta=new Ajv2020.Ajv2020({strict:false});
// AJV uses string ref aliases for canonical meta IDs and normalizes a trailing #. This registers
// the declared HTTPS dialect without copying/rewriting either the trusted meta-schema or upstream schema.
legacyMeta.refs[DRAFT07_HTTPS_META] = DRAFT07_HTTP_META;
addFormats.default(legacyMeta);addFormats.default(modernMeta);
// Compile trusted meta-schemas during host module startup, before any model-controlled validation work.
legacyMeta.validateSchema({type:"object"});modernMeta.validateSchema({type:"object"});
const unsupported = (): never => { throw new McpConnectorError("schema_unsupported", null, null, { phase: "discovery", effect: "none" }); };
export function assertSupportedMcpSchema(schema: unknown): asserts schema is Record<string, unknown> {
  assertSafeMcpMetadata(schema);
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return unsupported();
  const s = schema as Record<string,unknown>;
  if (s.$schema !== undefined && !["http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft-07/schema#", "https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2020-12/schema#"].includes(s.$schema as string)) return unsupported();
  try { compiled(s); } catch { unsupported(); }
}
export const MCP_NATIVE_SCHEMA_LIMITS = NATIVE_MCP_SCHEMA_RESOURCE_LIMITS;
/** JSON tree weight bounds every admitted AJV operation: applicators keep the value or descend to children.
 * The reference-expanded schema coefficient counts every possible branch/comparison, including ref siblings.
 * Prepay Cnodes(schema)*nodes(value) + Ctext(schema)*textUnits(value), BEFORE AJV.
 * Length/equality/hash scans carry text weight; constant min/maxItems bookkeeping does not multiply chars.
 * Actual NFA/format work is charged against the SAME remaining budget.
 */
function chargeStructuralValidation(weight: NativeMcpSchemaResourceWeight, value: unknown): void {
  const charge = (coefficient: NativeMcpSchemaResourceWeight, root: unknown): void => {
  let nodes = 0; const active = new Set<object>();
  const walk = (item: unknown, depth: number): number => {
    if (++nodes > MCP_NATIVE_SCHEMA_LIMITS.valueNodes || depth > MCP_NATIVE_SCHEMA_LIMITS.valueDepth) throw new McpPatternWorkLimit();
    let units = 1;
    if (typeof item === "string") units += item.length;
    else if (item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) { /* primitive */ }
    else if (typeof item === "object" && item !== null && (Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
      if (active.has(item)) throw new Error("non-JSON validation input"); active.add(item);
      consumeMcpValidationWork(coefficient.nodes);
      if (Array.isArray(item)) { for (const child of item) units += walk(child, depth + 1); }
      else for (const [key, child] of Object.entries(item)) { consumeMcpValidationWork(coefficient.text * key.length); units += key.length + walk(child, depth + 1); }
      active.delete(item); return units;
    } else throw new Error("non-JSON validation input");
    consumeMcpValidationWork(coefficient.nodes + coefficient.text * (units - 1)); return units;
  };
  walk(root, 0);
  };
  charge(weight, value);
  if (value && typeof value === "object" && !Array.isArray(value)) for (const property of weight.properties ?? [])
    if (Object.hasOwn(value, property.name)) charge(property, (value as Record<string, unknown>)[property.name]);
}

/** Linear equivalent of ajv-formats' legacy http/https/ftp URL grammar. No ambiguous userinfo regex.
 * Retains its public-IPv4/DNS contract, 2..5 digit ports, and slash-prefixed path (including query/fragment).
 */
function linearUrl(value: string): boolean {
  if (/\s/u.test(value)) return false;
  const scheme = /^(?:https?|ftp):\/\//i.exec(value); if (!scheme) return false;
  const host = (authority: string): boolean => {
    const colon = authority.lastIndexOf(":");
    if (colon >= 0) { if (!/^\d{2,5}$/.test(authority.slice(colon + 1))) return false; authority = authority.slice(0, colon); }
    const labels = authority.split(".");
    if (labels.length === 4 && labels.every(label => /^\d{1,3}$/.test(label))) {
      const [a, b, c, d] = labels.map(Number) as [number, number, number, number];
      return !labels[0]!.startsWith("0") && !labels[3]!.startsWith("0") && a >= 1 && a <= 223 && b <= 255 && c <= 255 && (labels[1]!.length < 3 || !labels[1]!.startsWith("0")) && (labels[2]!.length < 3 || !labels[2]!.startsWith("0")) && d >= 1 && d <= 254
        && a !== 10 && a !== 127 && !(a === 169 && b === 254) && !(a === 192 && b === 168) && !(a === 172 && b >= 16 && b <= 31);
    }
    if (labels.length < 2 || !/^[a-z\u00a1-\uffff]{2,}$/iu.test(labels[labels.length - 1]!)) return false;
    return labels.every(label => label.length > 0 && !label.startsWith("-") && !label.endsWith("-") && !label.includes("--") && /^[a-z0-9\u00a1-\uffff-]+$/iu.test(label));
  };
  // The legacy grammar permits '/' in userinfo. Inspect each slash-delimited segment once; the final
  // '@' in that segment is the only possible authority boundary. Never retry every suffix/prefix.
  for (let start = scheme[0].length; start <= value.length;) {
    const slash = value.indexOf("/", start), end = slash < 0 ? value.length : slash;
    const segment = value.slice(start, end);
    if (start === scheme[0].length && host(segment)) return true;
    const at = segment.lastIndexOf("@");
    if (at >= 0 && start + at > scheme[0].length && host(segment.slice(at + 1))) return true;
    if (slash < 0) break;
    start = slash + 1;
  }
  return false;
}

/** JSON equality never invokes an upstream literal's valueOf/toString/constructor properties. */
function equalJson(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;
  if (!expected || !actual || typeof expected !== "object" || typeof actual !== "object") return false;
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((item, index) => equalJson(item, actual[index]));
  if (Array.isArray(actual)) return false;
  const keys = Object.keys(expected);
  return keys.length === Object.keys(actual).length && keys.every(key => Object.hasOwn(actual, key)
    && equalJson((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key]));
}

function compiled(schema: Record<string,unknown>): CompiledSchema {
  const weight = nativeMcpSchemaResourceWeight(schema, checkedMcpPattern);
  const key = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
  const cached = validators.get(key); if (cached) return cached;
  // Each entry owns an AJV instance. Eviction releases its schema cache AND generated regexp scope,
  // rather than only dropping our outer Map while a global AJV still retains every compiled schema.
  const isLegacy=String(schema.$schema).includes("draft-07");
  if (!(isLegacy?legacyMeta:modernMeta).validateSchema(schema)) return unsupported();
  const engine = isLegacy ? new Ajv.Ajv(options) : new Ajv2020.Ajv2020(options);
  if (isLegacy) engine.refs[DRAFT07_HTTPS_META] = DRAFT07_HTTP_META;
  addFormats.default(engine);
  engine.addFormat("url", { type: "string", validate: linearUrl });
  // Direct primitive items are an admission requirement. Set avoids AJV's inherited __proto__ index bug
  // and gives exact JSON primitive equality (including 0/-0) in bounded linear work, without schema edits.
  engine.removeKeyword("uniqueItems");
  engine.addKeyword({ keyword: "uniqueItems", type: "array", schemaType: "boolean", validate: (enabled: boolean, data: unknown[]): boolean => {
    if (!enabled) return true; const seen = new Set<unknown>();
    for (const item of data) { consumeMcpValidationWork(1); if (seen.has(item)) return false; seen.add(item); }
    return true;
  } });
  engine.removeKeyword("const");
  engine.addKeyword({ keyword: "const", validate: equalJson });
  // Charge complete string scans across all branches/items, including early-success formats/patterns.
  for (const [name, format] of Object.entries(engine.formats)) {
    if (!format || typeof format === "boolean") continue;
    if (typeof format === "object" && !(format instanceof RegExp) && format.type === "number") continue;
    const definition = (format instanceof RegExp || typeof format === "function" ? { type: "string", validate: format } : format) as FormatDefinition<string>;
    const validate = typeof definition.validate === "string" ? new RegExp(definition.validate) : definition.validate;
    engine.addFormat(name, { ...definition, type: "string", validate: (value: string): boolean => {
      consumeMcpValidationWork(value.length);
      return validate instanceof RegExp ? validate.test(value) : validate(value) as boolean;
    } });
  }
  // Labels are bounded annotations only. They never change validation, coercion, defaults, or schema bytes.
  engine.addKeyword({ keyword: "enumNames", schemaType: "array", metaSchema: { type: "array", maxItems: 256, items: { type: "string", maxLength: 2048 } }, valid: true });
  engine.addKeyword({ keyword: "x-mcp-header", schemaType: "string", valid: true });
  // JSON Schema's unknown formats are annotations, not constraints. Known ajv-formats remain validated.
  const formats = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const child of value) formats(child); return; }
    const node = value as Record<string, unknown>;
    if (typeof node.format === "string" && !engine.formats[node.format]) engine.addFormat(node.format, true);
    for (const keyword of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) if (node[keyword] && typeof node[keyword] === "object") for (const child of Object.values(node[keyword])) formats(child);
    for (const keyword of ["additionalProperties", "unevaluatedProperties", "propertyNames", "contains", "not", "if", "then", "else", "additionalItems", "unevaluatedItems", "contentSchema", "items", "allOf", "anyOf", "oneOf", "prefixItems"]) formats(node[keyword]);
    if (node.dependencies && typeof node.dependencies === "object") for (const child of Object.values(node.dependencies)) if (!Array.isArray(child)) formats(child);
  };
  formats(schema);
  const validator = engine.compile(schema);
  if (validators.size >= CACHE_LIMIT) validators.delete(validators.keys().next().value!);
  const entry = { validate: validator, weight }; validators.set(key, entry); return entry;
}
/** Host hook for gateway and native adapter. Fields and scalar values remain upstream originals. */
export function validateNativeMcpArguments(schema: Record<string, unknown>, input: unknown): void {
  assertSupportedMcpSchema(schema);
  assertSafeMcpMetadata(input); // bounded input; secret-like values use private flow, never the model toolcall
  let valid:boolean;try{valid=withMcpPatternBudget(() => { const entry = compiled(schema); chargeStructuralValidation(entry.weight, input); return entry.validate(input) as boolean; });}catch(error){ if(error instanceof McpPatternWorkLimit) throw new McpConnectorError("validation_resource_limit", null, null, { phase: "pre_dispatch", effect: "none" }); valid=false;}
  if (!valid) throw new McpConnectorError("input_schema_invalid", null, null, { phase: "pre_dispatch", effect: "none" });
}
export function validateNativeMcpOutput(schema: Record<string,unknown>, output: unknown): void {
  // Direct callers get the maximum native result bound too. Sessions apply their exact FULL envelope
  // bound before this hook, including content, _meta, request state and unrecognized upstream fields.
  try {
    if (Buffer.byteLength(JSON.stringify(output) ?? "null", "utf8") > 16 * 1024 * 1024) throw new Error("limit");
    assertSupportedMcpSchema(schema);
    if (withMcpPatternBudget(() => { const entry = compiled(schema); chargeStructuralValidation(entry.weight, output); return entry.validate(output) as boolean; })) return;
  } catch(error) { if(error instanceof McpPatternWorkLimit) throw new McpConnectorError("validation_resource_limit", null, null, { phase: "validation", effect: "possible" }); /* A post-dispatch local validation/compile failure never claims before_dispatch. */ }
  throw new McpConnectorError("output_schema_invalid", null, null, { phase: "validation", effect: "possible" });
}
