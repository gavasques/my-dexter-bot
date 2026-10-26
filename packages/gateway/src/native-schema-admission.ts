import { GatewayError } from "./errors.js";
const unsupported = (): never => { throw new GatewayError("invalid_input", "native schema: resource admission unsupported"); };
/** Finite JSON identity is required BEFORE hashing: JSON numbers such as 1e400 must not alias null. */
function assertFiniteSchemaJson(root: unknown): void {
  let nodes = 0, units = 0;
  const active = new Set<object>();
  const walk = (value: unknown, depth: number): void => {
    if (++nodes > 20_000 || depth > 24) return unsupported();
    if (typeof value === "number") { if (!Number.isFinite(value)) return unsupported(); return; }
    if (typeof value === "string") { units += value.length; if (units > 262144) return unsupported(); return; }
    if (value === null || typeof value === "boolean" || value === undefined) return;
    if (typeof value !== "object" || active.has(value)) return unsupported();
    active.add(value);
    if (Array.isArray(value)) for (const child of value) walk(child, depth + 1);
    else { if (Object.getPrototypeOf(value) !== Object.prototype) return unsupported(); for (const [key, child] of Object.entries(value)) { units += key.length; if (units > 262144) return unsupported(); walk(child, depth + 1); } }
    active.delete(value);
  };
  walk(root, 0);
}
/** Closed admission runs BEFORE AJV's own meta-validation/compilation. Bounds apply to unused definitions too. */
export const NATIVE_MCP_SCHEMA_RESOURCE_LIMITS = Object.freeze({ schemaPositions: 2048, branches: 64, enumValues: 256, enumLiteralUnits: 32768, expandedWeight: 4096, referenceDepth: 32, valueNodes: 262144, valueDepth: 64 });
const MAP_SCHEMAS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const SINGLE_SCHEMAS = ["additionalProperties", "unevaluatedProperties", "propertyNames", "contains", "not", "if", "then", "else", "additionalItems", "unevaluatedItems", "contentSchema"];
const ARRAY_SCHEMAS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const ANNOTATIONS = new Set(["title", "description", "default", "examples", "$comment", "deprecated", "readOnly", "writeOnly", "enumNames", "x-mcp-header", "contentEncoding", "contentMediaType", "$schema", "$id", "$defs", "definitions"]);
const KEYWORDS = new Set([...ANNOTATIONS, ...MAP_SCHEMAS, ...SINGLE_SCHEMAS, ...ARRAY_SCHEMAS, "$ref", "type", "nullable", "const", "enum", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "format", "required", "minProperties", "maxProperties", "dependencies", "dependentRequired", "items", "minItems", "maxItems", "minContains", "maxContains", "uniqueItems", "discriminator"]);
type SchemaNode = boolean | Record<string, unknown>;
function schemaObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function literalUnits(value: unknown): number {
  if (typeof value === "string") return value.length + 1;
  if (value === null || typeof value === "number" || typeof value === "boolean") return 1;
  if (Array.isArray(value)) return 1 + value.reduce<number>((total, item) => total + literalUnits(item), 0);
  if (schemaObject(value)) return 1 + Object.entries(value).reduce((total, [key, item]) => total + key.length + literalUnits(item), 0);
  return unsupported();
}
/** Equality visits JSON positions. String characters belong to the separate input-text coefficient.
 * Counting literal characters as positions would reject the approved 64-option private forms.
 */
function literalNodes(value: unknown): number {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return 1;
  if (Array.isArray(value)) return 1 + value.reduce<number>((total, item) => total + literalNodes(item), 0);
  if (schemaObject(value)) return 1 + Object.values(value).reduce<number>((total, item) => total + 1 + literalNodes(item), 0);
  return unsupported();
}
export interface NativeMcpSchemaResourceWeight {
  nodes: number; text: number;
  /** Direct root properties execute only on their own values; keep sibling free text independent. */
  properties?: { name: string; nodes: number; text: number }[];
}
export function nativeMcpSchemaResourceWeight(root: Record<string, unknown>, checkPattern?: (pattern: string) => unknown): NativeMcpSchemaResourceWeight {
  assertFiniteSchemaJson(root);
  const nodes = new Set<SchemaNode>(), children = new Map<SchemaNode, SchemaNode[]>();
  let positions = 0;
  const visit = (value: unknown, top = false): void => {
    if (++positions > NATIVE_MCP_SCHEMA_RESOURCE_LIMITS.schemaPositions) return unsupported();
    if (typeof value !== "boolean" && !schemaObject(value)) return unsupported();
    const node = value as SchemaNode;
    if (nodes.has(node)) return;
    nodes.add(node); const runtime: SchemaNode[] = []; children.set(node, runtime);
    if (typeof node === "boolean") return;
    for (const key of Object.keys(node)) if (!KEYWORDS.has(key)) return unsupported();
    if (!top && (Object.hasOwn(node, "$id") || Object.hasOwn(node, "$schema"))) return unsupported();
    if (node.$ref !== undefined && (typeof node.$ref !== "string" || !node.$ref.startsWith("#/") || node.$ref.includes("%"))) return unsupported();
    if (node.pattern !== undefined) { if (typeof node.pattern !== "string") return unsupported(); try { checkPattern?.(node.pattern); } catch { return unsupported(); } }
    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.length || types.length > 7 || new Set(types).size !== types.length || types.some(type => !["string", "number", "integer", "boolean", "null", "object", "array"].includes(String(type)))) return unsupported();
    }
    if (node.enum !== undefined) {
      if (!Array.isArray(node.enum) || node.enum.length < 1 || node.enum.length > NATIVE_MCP_SCHEMA_RESOURCE_LIMITS.enumValues || new Set(node.enum).size !== node.enum.length || node.enum.some(item => item !== null && !["string", "boolean", "number"].includes(typeof item)) || node.enum.reduce<number>((total, item) => total + literalUnits(item), 0) > NATIVE_MCP_SCHEMA_RESOURCE_LIMITS.enumLiteralUnits) return unsupported();
    }
    const add = (child: unknown, executes = true): void => { visit(child); if (executes) runtime.push(child as SchemaNode); };
    for (const keyword of MAP_SCHEMAS) {
      const map = node[keyword]; if (map === undefined) continue;
      if (!schemaObject(map) || Object.keys(map).length > NATIVE_MCP_SCHEMA_RESOURCE_LIMITS.schemaPositions) return unsupported();
      for (const [name, child] of Object.entries(map)) {
        if (keyword === "patternProperties") { try { checkPattern?.(name); } catch { return unsupported(); } }
        add(child, keyword !== "$defs" && keyword !== "definitions");
      }
    }
    for (const keyword of SINGLE_SCHEMAS) if (node[keyword] !== undefined) add(node[keyword]);
    for (const keyword of ARRAY_SCHEMAS) if (node[keyword] !== undefined) {
      const list = node[keyword]; if (!Array.isArray(list) || list.length > NATIVE_MCP_SCHEMA_RESOURCE_LIMITS.branches) return unsupported();
      for (const child of list) add(child);
    }
    if (node.items !== undefined) {
      if (Array.isArray(node.items)) { if (node.items.length > NATIVE_MCP_SCHEMA_RESOURCE_LIMITS.branches) return unsupported(); for (const child of node.items) add(child); }
      else add(node.items);
    }
    const list = (value: unknown): void => { if (!Array.isArray(value) || value.length > NATIVE_MCP_SCHEMA_RESOURCE_LIMITS.enumValues || new Set(value).size !== value.length || value.some(item => typeof item !== "string")) return unsupported(); };
    if (node.required !== undefined) list(node.required);
    if (node.dependentRequired !== undefined) { if (!schemaObject(node.dependentRequired)) return unsupported(); for (const value of Object.values(node.dependentRequired)) list(value); }
    if (node.dependencies !== undefined) { if (!schemaObject(node.dependencies)) return unsupported(); for (const child of Object.values(node.dependencies)) { if (Array.isArray(child)) list(child); else add(child); } }
    if (node.uniqueItems === true) {
      // AJV's linear uniqueness path inspects DIRECT items.type, not the resolved $ref or branch type.
      const items = node.items, types = schemaObject(items) ? (Array.isArray(items.type) ? items.type : [items.type]) : [];
      if (!types.length || types.some(type => !["string", "number", "integer", "boolean", "null"].includes(String(type)))) return unsupported();
    }
  };
  visit(root, true);
  const resolve = (ref: string): SchemaNode => {
    let target: unknown = root;
    for (const part of ref.slice(2).split("/")) {
      if (/~(?![01])/.test(part)) return unsupported();
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if ((!schemaObject(target) && !Array.isArray(target)) || !Object.hasOwn(target, key)) return unsupported(); target = (target as Record<string, unknown>)[key];
    }
    if (!nodes.has(target as SchemaNode)) return unsupported(); return target as SchemaNode;
  };
  const costs = new Map<SchemaNode, NativeMcpSchemaResourceWeight>(), heights = new Map<SchemaNode, number>(), active = new Set<SchemaNode>();
  const weight = (node: SchemaNode, depth = 0): NativeMcpSchemaResourceWeight => {
    if (depth > NATIVE_MCP_SCHEMA_RESOURCE_LIMITS.referenceDepth || active.has(node)) return unsupported();
    const memo = costs.get(node); if (memo !== undefined) { if (depth + heights.get(node)! > NATIVE_MCP_SCHEMA_RESOURCE_LIMITS.referenceDepth) return unsupported(); return memo; }
    if (typeof node === "boolean") { const cost = { nodes: 1, text: 0 }; costs.set(node, cost); heights.set(node, 0); return cost; }
    active.add(node);
    let cost = { nodes: 1 + Object.keys(node).filter(key => !ANNOTATIONS.has(key)).length, text: 0 }, height = 0;
    const add = (n: number | NativeMcpSchemaResourceWeight): void => { if (typeof n === "number") cost.nodes += n; else { cost.nodes += n.nodes; cost.text += n.text; } if (cost.nodes + cost.text > NATIVE_MCP_SCHEMA_RESOURCE_LIMITS.expandedWeight) return unsupported(); };
    for (const key of ["minLength", "maxLength"]) if (node[key] !== undefined) cost.text++;
    if (node.uniqueItems === true) cost.text++;
    if (Array.isArray(node.required)) add(node.required.length);
    if (Array.isArray(node.enum)) add({ nodes: node.enum.length, text: node.enum.length });
    // The const keyword already pays for its root equality operation. Nested literal positions
    // add structural work; a primitive const contributes no duplicate node/character charge.
    if (Object.hasOwn(node, "const")) add({ nodes: literalNodes(node.const) - 1, text: 1 });
    for (const keyword of ["dependentRequired", "dependencies"]) if (schemaObject(node[keyword])) for (const value of Object.values(node[keyword])) if (Array.isArray(value)) add(value.length + 1);
    for (const child of children.get(node)!) { add(weight(child, depth + 1)); height = Math.max(height, heights.get(child)! + 1); }
    if (typeof node.$ref === "string") { const target = resolve(node.$ref); add(weight(target, depth + 1)); height = Math.max(height, heights.get(target)! + 1); }
    active.delete(node); costs.set(node, cost); heights.set(node, height); return cost;
  };
  // Bound every definition before meta-validation, including unreferenced definitions.
  for (const node of nodes) weight(node);
  const total = weight(root), scoped = schemaObject(root.properties)
    ? Object.entries(root.properties).map(([name, node]) => ({ name, ...weight(node as SchemaNode) })) : [];
  // Static admission still bounds the ENTIRE expanded graph above. Runtime prepayment may localize
  // direct properties: AJV evaluates each such subschema only on that named own property's subtree.
  // Applicators/refs/additional/pattern properties stay conservatively charged on the complete value.
  return { nodes: total.nodes - scoped.reduce((sum, child) => sum + child.nodes, 0),
    text: total.text - scoped.reduce((sum, child) => sum + child.text, 0), ...(scoped.length ? { properties: scoped } : {}) };
}
