// Published argument schemas of the declared device operations: each schema is closed, deeply frozen, pinned
// by schemaHash and never stricter than the host's validate(), which stays the final judge. No network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@dexter/contracts";
import {
  BROWSER_CLOSE, BROWSER_NAVIGATE, BROWSER_READ, CUA_CONTROL, CUA_OBSERVE, CUA_STATUS, DEVICE_OPERATIONS, DEVICE_OPERATION_VERSION, DeviceError, FILE_APPEND,
  FILE_READ, MAX_BROWSER_READ_CHARS, MAX_CUA_NODES, MAX_URL_LENGTH, PROCESS_PROBE, checkCapabilities, checkOperationArgs, deviceOperationSchemaHash,
  operationFor, type DeviceOperation,
} from "@dexter/devices";

const TOOLS = [FILE_READ, FILE_APPEND, PROCESS_PROBE, BROWSER_NAVIGATE, BROWSER_READ, BROWSER_CLOSE, CUA_STATUS, CUA_OBSERVE, CUA_CONTROL];
/** Changing any of these is a deliberate protocol change: bump DEVICE_OPERATION_VERSION and re-pin. */
const PINNED: Record<string, string> = {
  [FILE_READ]: "c76e3db5214ab1fc769bf073bf782850682ba272670e8967804e6a1b56c80d5e",
  [FILE_APPEND]: "c09b53e9ba587ac48be29b668ff854150c526ee81c91f567cf38d78c09e83997",
  [PROCESS_PROBE]: "5761bfefa465be88d6d80eeb18515f47a17eaa109aee5e90d1f868b18ea9c563",
  [BROWSER_NAVIGATE]: "089d7f5fbb7f40714689c74b65083191e4a9071e915ac9ad166c3747bc767241",
  [BROWSER_READ]: "528d2d0c92d06c100b7f3e4b9db1cfa8e12e3d524c17d2e1a43962276179414d",
  [BROWSER_CLOSE]: "7c9cf1a2b651099256779d3e517c47e6fda464ea412f197bde8a75c8eaeefa78",
  [CUA_STATUS]: "a7fbe97d9154e0c1a7a85bc422dd7238250bcbc2f55b1cea9066e5ab97ccfa0a",
  [CUA_OBSERVE]: "2c756a11e01a7b1ba7f5e585d0380557c3c35b3fd201726f513b62dc35cf5744",
  [CUA_CONTROL]: "648c597890af1bbe363badaab26f1c803860b21d25c6e1c1ad30071b57e55e20",
};

// Independent of @dexter/hub: recursive sorted-key JSON.
const canon = (v: unknown): string => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
const independentHash = (op: Pick<DeviceOperation, "version" | "tool" | "effect" | "description" | "inputSchema">) =>
  createHash("sha256").update(canon({ version: op.version, tool: op.tool, effect: op.effect, description: op.description, inputSchema: op.inputSchema })).digest("hex");

/** Minimal JSON Schema evaluator for exactly the keywords the operations use; any other keyword fails the test. */
type S = Record<string, unknown>;
const KNOWN = new Set(["type", "properties", "required", "additionalProperties", "minLength", "maxLength", "pattern", "minimum", "maximum", "enum", "const", "if", "then", "else", "not", "description"]);
function conforms(schema: S, value: unknown): boolean {
  for (const key of Object.keys(schema)) assert.ok(KNOWN.has(key), `unsupported keyword ${key}`);
  if (schema.type === "object" && (value === null || typeof value !== "object" || Array.isArray(value))) return false;
  if (schema.type === "string" && typeof value !== "string") return false;
  if (schema.type === "integer" && !(typeof value === "number" && Number.isInteger(value))) return false;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, S>;
    for (const key of (schema.required ?? []) as string[]) if (!Object.hasOwn(obj, key)) return false;
    for (const key of Object.keys(obj)) {
      if (Object.hasOwn(props, key)) { if (!conforms(props[key]!, obj[key])) return false; }
      else if (schema.additionalProperties === false) return false;
    }
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && length > schema.maxLength) return false;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) return false;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if ("const" in schema && schema.const !== value) return false;
  if (schema.not && conforms(schema.not as S, value)) return false;
  if (schema.if) {
    const branch = conforms(schema.if as S, value) ? schema.then : schema.else;
    if (branch && !conforms(branch as S, value)) return false;
  }
  return true;
}
const runtimeAccepts = (tool: string, args: unknown): boolean => {
  try { checkOperationArgs(tool, args as Record<string, JsonValue>); return true; } catch (e) {
    assert.ok(e instanceof DeviceError && e.code === "invalid_input");
    return false;
  }
};

const SURFACE = `srf_${"a".repeat(32)}`;
const CONTROL_CHARS = ["\u0000", "\u0009", "\n", "\r", "\u001b", "\u001f", "\u007f"];
const ASTRAL = "\u{1F600}"; // one code point, two UTF-16 units
/** [tool, args, runtime and schema agree?]: `false` marks a check only the host can make (documented). */
const CASES: Array<[string, unknown, boolean]> = [
  ...["a", "a.txt", "A-b_c.d", "a".repeat(64)].map((name): [string, unknown, boolean] => [FILE_READ, { name }, true]),
  ...["", ".hidden", "-a", "a..b", "../a", "a/b", "a\\b", "a".repeat(65), "é", "a b", 1, null].map((name): [string, unknown, boolean] => [FILE_READ, { name }, true]),
  [FILE_READ, {}, true], [FILE_READ, { name: "a", deviceId: "dev_x" }, true], [FILE_READ, [], true], [FILE_READ, null, true],
  [FILE_APPEND, { name: "a", line: "x" }, true], [FILE_APPEND, { name: "a", line: "x".repeat(512) }, true], [FILE_APPEND, { name: "a", line: "ação ✓" }, true],
  [FILE_APPEND, { name: "a", line: "" }, true], [FILE_APPEND, { name: "a", line: "x".repeat(513) }, true], [FILE_APPEND, { name: "a" }, true],
  ...CONTROL_CHARS.map((c): [string, unknown, boolean] => [FILE_APPEND, { name: "a", line: `x${c}y` }, true]),
  [FILE_APPEND, { name: "a", line: ASTRAL.repeat(256) }, true],
  [FILE_APPEND, { name: "a", line: ASTRAL.repeat(257) }, false], // 514 UTF-16 units, 257 code points
  [PROCESS_PROBE, {}, true], [PROCESS_PROBE, { command: "rm" }, true], [PROCESS_PROBE, { executable: "/bin/sh" }, true],
  ...["https://example.com", "http://127.0.0.1:8080/a?b=c#frag", "HTTPS://Example.COM/x", "http://[::1]/", `https://e.com/${"a".repeat(MAX_URL_LENGTH - 15)}`]
    .map((url): [string, unknown, boolean] => [BROWSER_NAVIGATE, { url }, true]),
  ...["", "ftp://e.com", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "about:blank", "//e.com", "e.com", " https://e.com", `https://e.com/${"a".repeat(MAX_URL_LENGTH)}`, 7]
    .map((url): [string, unknown, boolean] => [BROWSER_NAVIGATE, { url }, true]),
  ...CONTROL_CHARS.concat([" "]).map((c): [string, unknown, boolean] => [BROWSER_NAVIGATE, { url: `https://e.com/a${c}b` }, true]),
  // Syntactic URL checks the schema cannot express: WHATWG parsing, credentials, empty host, normalized length.
  [BROWSER_NAVIGATE, { url: "https://user:pw@e.com/" }, false], [BROWSER_NAVIGATE, { url: "http://" }, false],
  [BROWSER_NAVIGATE, { url: "https://e.com:99999/" }, false], [BROWSER_NAVIGATE, { url: `https://e.com/${"\"".repeat(700)}` }, false],
  [BROWSER_NAVIGATE, { url: "https://e.com", botId: "bot_x" }, true], [BROWSER_NAVIGATE, {}, true],
  ...[1, 4000, MAX_BROWSER_READ_CHARS].map((maxChars): [string, unknown, boolean] => [BROWSER_READ, { maxChars }, true]),
  ...[0, -1, MAX_BROWSER_READ_CHARS + 1, 1.5, "10", null, Number.MAX_SAFE_INTEGER + 2].map((maxChars): [string, unknown, boolean] => [BROWSER_READ, { maxChars }, true]),
  [BROWSER_READ, {}, true], [BROWSER_CLOSE, {}, true], [BROWSER_CLOSE, { profile: "x" }, true],
  // Status takes nothing: the bot, session and surface come from the trusted job and the operator, never arguments.
  [CUA_STATUS, {}, true], [CUA_STATUS, { surfaceId: SURFACE }, true], [CUA_STATUS, { sessionId: "cus_x" }, true], [CUA_STATUS, { botId: "bot_b" }, true],
  [CUA_STATUS, null, true], [CUA_STATUS, [], true],
  [CUA_OBSERVE, { surfaceId: SURFACE, maxNodes: 1 }, true], [CUA_OBSERVE, { surfaceId: SURFACE, maxNodes: MAX_CUA_NODES }, true],
  [CUA_OBSERVE, { surfaceId: SURFACE, maxNodes: MAX_CUA_NODES + 1 }, true], [CUA_OBSERVE, { surfaceId: SURFACE, maxNodes: 0 }, true],
  [CUA_OBSERVE, { surfaceId: `srf_${"A".repeat(32)}`, maxNodes: 1 }, true], [CUA_OBSERVE, { surfaceId: `srf_${"a".repeat(31)}`, maxNodes: 1 }, true],
  [CUA_OBSERVE, { surfaceId: SURFACE }, true], [CUA_OBSERVE, { surfaceId: SURFACE, maxNodes: 1, pid: 1 }, true],
  ...["press", "focus"].map((action): [string, unknown, boolean] => [CUA_CONTROL, { surfaceId: SURFACE, elementId: "el_1", action }, true]),
  [CUA_CONTROL, { surfaceId: SURFACE, elementId: "el_999999", action: "set_value", value: "ok" }, true],
  [CUA_CONTROL, { surfaceId: SURFACE, elementId: "el_1", action: "set_value" }, true],
  [CUA_CONTROL, { surfaceId: SURFACE, elementId: "el_1", action: "press", value: "x" }, true],
  [CUA_CONTROL, { surfaceId: SURFACE, elementId: "el_1", action: "set_value", value: "" }, true],
  ...CONTROL_CHARS.map((c): [string, unknown, boolean] => [CUA_CONTROL, { surfaceId: SURFACE, elementId: "el_1", action: "set_value", value: `a${c}` }, true]),
  [CUA_CONTROL, { surfaceId: SURFACE, elementId: "el_1", action: "set_value", value: ASTRAL.repeat(300) }, false],
  ...["click", "type", "PRESS", "", null].map((action): [string, unknown, boolean] => [CUA_CONTROL, { surfaceId: SURFACE, elementId: "el_1", action }, true]),
  ...["el_", "el_1234567", "el_a", "1"].map((elementId): [string, unknown, boolean] => [CUA_CONTROL, { surfaceId: SURFACE, elementId, action: "press" }, true]),
  [CUA_CONTROL, { surfaceId: SURFACE, elementId: "el_1", action: "press", x: 10 }, true],
];

test("operationFor exposes the agreed frozen interface for all nine operations", () => {
  assert.deepEqual([...DEVICE_OPERATIONS.keys()].sort(), [...TOOLS].sort());
  assert.equal(DEVICE_OPERATIONS.size, 9);
  assert.equal(DEVICE_OPERATION_VERSION, "1.1.0");
  for (const tool of TOOLS) {
    const op = operationFor(tool);
    assert.deepEqual(Object.keys(op).sort(), ["description", "effect", "inputSchema", "schemaHash", "tool", "validate", "version"]);
    assert.equal(op, DEVICE_OPERATIONS.get(tool));
    assert.equal(op.tool, tool);
    assert.equal(op.version, DEVICE_OPERATION_VERSION);
    assert.match(op.schemaHash, /^[0-9a-f]{64}$/);
    assert.equal(op.schemaHash, independentHash(op));
    assert.equal(op.schemaHash, deviceOperationSchemaHash(op));
    assert.equal(op.schemaHash, PINNED[tool], `${tool} schema or semantics changed`);
    const schema = op.inputSchema as unknown as S;
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    const props = Object.keys(schema.properties as S);
    for (const key of schema.required as string[]) assert.ok(props.includes(key));
    // Arguments never choose bot, device, principal, host, path, program, token or operation.
    // Every string is length-bounded and every integer ranged, as flat scalar-schema validators require.
    for (const prop of Object.values(schema.properties as Record<string, S>)) {
      if (prop.type === "string") assert.ok(typeof prop.maxLength === "number" && typeof prop.minLength === "number");
      else { assert.equal(prop.type, "integer"); assert.ok(typeof prop.minimum === "number" && typeof prop.maximum === "number"); }
    }
    for (const key of props) assert.doesNotMatch(key, /bot|device|principal|owner|host|path|exec|command|token|secret|operation|tool|profile|pid/i);
    assert.equal(JSON.stringify(schema).includes("\"default\""), false, "no defaults: absent arguments are refused, not filled");
  }
  assert.equal(new Set(TOOLS.map((t) => operationFor(t).schemaHash)).size, TOOLS.length);
  assert.equal(operationFor(BROWSER_NAVIGATE).effect, "write");
  assert.equal(operationFor(CUA_CONTROL).effect, "write");
  assert.equal(operationFor(CUA_STATUS).effect, "read");
  assert.deepEqual(operationFor(CUA_STATUS).inputSchema, { type: "object", properties: {}, required: [], additionalProperties: false });
  assert.throws(() => operationFor("mac.browser.evaluate"), (e) => e instanceof DeviceError && e.code === "unsupported");
  assert.throws(() => operationFor("mac.shell.run"), (e) => e instanceof DeviceError && e.code === "invalid_input");
});

test("schemaHash binds version, tool, effect, description and every nested schema keyword, not key order", () => {
  for (const tool of TOOLS) {
    const op = operationFor(tool);
    const base = { version: op.version, tool: op.tool, effect: op.effect, description: op.description, inputSchema: structuredClone(op.inputSchema) };
    const mutants = [
      { ...base, version: "1.0.1" }, { ...base, tool: `${tool}x` }, { ...base, effect: op.effect === "read" ? "write" as const : "read" as const },
      { ...base, description: `${op.description} ` }, { ...base, inputSchema: { ...base.inputSchema, required: [...base.inputSchema.required, "extra"] } },
    ];
    for (const prop of Object.keys(base.inputSchema.properties)) {
      for (const key of Object.keys(base.inputSchema.properties[prop]!)) {
        const clone = structuredClone(op.inputSchema) as unknown as { properties: Record<string, Record<string, unknown>> };
        const v = clone.properties[prop]![key];
        clone.properties[prop]![key] = typeof v === "number" ? v + 1 : typeof v === "string" ? `${v}.` : [...(v as unknown[]), "x"];
        mutants.push({ ...base, inputSchema: clone as unknown as typeof base.inputSchema });
      }
    }
    for (const m of mutants) assert.notEqual(deviceOperationSchemaHash(m), op.schemaHash, `${tool}: ${JSON.stringify(m).slice(0, 80)}`);
    const reordered = Object.fromEntries(Object.entries(structuredClone(op.inputSchema)).reverse()) as unknown as typeof base.inputSchema;
    assert.equal(deviceOperationSchemaHash({ inputSchema: reordered, description: op.description, effect: op.effect, tool: op.tool, version: op.version }), op.schemaHash);
  }
  const control = structuredClone(operationFor(CUA_CONTROL).inputSchema) as unknown as S;
  delete control.else;
  assert.notEqual(independentHash({ ...operationFor(CUA_CONTROL), inputSchema: control as never }), operationFor(CUA_CONTROL).schemaHash);
});

test("consumers cannot change the canonical operations through the schema, the map or the returned objects", () => {
  const before = TOOLS.map((t) => [operationFor(t).schemaHash, canon(operationFor(t).inputSchema)]);
  const op = operationFor(FILE_READ) as unknown as Record<string, unknown>;
  const schema = op.inputSchema as { properties: Record<string, Record<string, unknown>>; required: string[] };
  assert.throws(() => { schema.properties.name!.pattern = ".*"; }, TypeError);
  assert.throws(() => { schema.properties.path = { type: "string" }; }, TypeError);
  assert.throws(() => { schema.required.push("x"); }, TypeError);
  assert.throws(() => { (schema as unknown as S).additionalProperties = true; }, TypeError);
  assert.throws(() => { op.validate = () => ({}); }, TypeError);
  assert.throws(() => { op.effect = "read"; }, TypeError);
  assert.throws(() => { op.schemaHash = "0".repeat(64); }, TypeError);
  assert.throws(() => { (operationFor(CUA_CONTROL).inputSchema.properties.action!.enum as string[]).push("type"); }, TypeError);

  const map = DEVICE_OPERATIONS as unknown as Record<string, unknown>;
  assert.equal(DEVICE_OPERATIONS instanceof Map, false);
  assert.equal(map.set, undefined);
  assert.equal(map.delete, undefined);
  assert.equal(map.clear, undefined);
  const evil = { ...operationFor(FILE_READ), validate: (a: unknown) => a };
  assert.throws(() => Map.prototype.set.call(DEVICE_OPERATIONS, FILE_READ, evil), TypeError);
  assert.throws(() => Map.prototype.clear.call(DEVICE_OPERATIONS), TypeError);
  assert.throws(() => { map.get = () => evil; }, TypeError);
  assert.throws(() => { Object.getPrototypeOf(DEVICE_OPERATIONS).get = () => evil; }, TypeError);
  assert.throws(() => Object.defineProperty(DEVICE_OPERATIONS, "size", { value: 0 }), TypeError);
  for (const [, value] of DEVICE_OPERATIONS) assert.ok(Object.isFrozen(value) && Object.isFrozen(value.inputSchema));

  assert.deepEqual(TOOLS.map((t) => [operationFor(t).schemaHash, canon(operationFor(t).inputSchema)]), before);
  assert.equal(DEVICE_OPERATIONS.get(FILE_READ), operationFor(FILE_READ));
  assert.throws(() => checkOperationArgs(FILE_READ, { name: "../x" }), DeviceError);
  assert.deepEqual(checkCapabilities([...TOOLS]), [...TOOLS].sort());
  assert.throws(() => checkCapabilities([...TOOLS, FILE_READ]), DeviceError);
});

test("schemas reflect validate(): never stricter, equal wherever expressible, host checks documented", () => {
  let hostOnly = 0;
  for (const [tool, args, agrees] of CASES) {
    const schema = operationFor(tool).inputSchema as unknown as S;
    const runtime = runtimeAccepts(tool, args);
    const declared = conforms(schema, args);
    const label = `${tool} ${JSON.stringify(args)?.slice(0, 120)}`;
    if (agrees) assert.equal(declared, runtime, label);
    else { assert.equal(declared, true, label); assert.equal(runtime, false, label); hostOnly++; }
  }
  assert.equal(hostOnly, 6);
  // Normalization is unchanged by the schema export.
  assert.deepEqual(checkOperationArgs(BROWSER_NAVIGATE, { url: "HTTPS://Example.COM/x?y=1#frag" }), { url: "https://example.com/x?y=1" });
  assert.deepEqual(checkOperationArgs(CUA_CONTROL, { surfaceId: SURFACE, elementId: "el_1", action: "set_value", value: "v" }),
    { surfaceId: SURFACE, elementId: "el_1", action: "set_value", value: "v" });
  assert.deepEqual(checkOperationArgs(BROWSER_READ, { maxChars: 5 }), { maxChars: 5 });
});

test("the schema export adds no gateway/runtime import and no package cycle", () => {
  const dist = dirname(fileURLToPath(import.meta.resolve("@dexter/devices")));
  const imports = (file: string) => [...readFileSync(join(dist, file), "utf8").matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports("operations.js").sort(), ["./errors.js", "./wire.js", "@dexter/hub", "node:crypto"]);
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".js") ? [join(dir, e.name)] : []);
  for (const file of walk(dist)) assert.doesNotMatch(readFileSync(file, "utf8"), /@dexter\/(?:gateway|runtime|cli|context)/, file);
  const devices = JSON.parse(readFileSync(join(dist, "..", "package.json"), "utf8")) as { dependencies: Record<string, string> };
  assert.deepEqual(Object.keys(devices.dependencies).sort(), ["@dexter/contracts", "@dexter/hub"]);
  const hub = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.resolve("@dexter/hub"))), "..", "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  assert.equal(Object.hasOwn(hub.dependencies ?? {}, "@dexter/devices"), false);
});
