import { createHash } from "node:crypto";
import type { JsonValue } from "@dexter/contracts";
import { canonicalJson } from "@dexter/hub";
import { DeviceError } from "./errors.js";
import { exact } from "./wire.js";

/**
 * Finite, host-declared operations a paired Mac may offer. The host validates arguments before a job is
 * queued and the daemon validates them again before its journal entry. Arguments never name a device,
 * host, path outside the daemon's configured root, executable or credential reference.
 */
export interface DeviceOperation {
  readonly tool: string;
  readonly effect: "read" | "write";
  readonly description: string;
  /**
   * Trusted semantic version of `validate`. Bumped whenever accepted arguments or their normalization change,
   * including checks `inputSchema` cannot express; it is part of `schemaHash`.
   */
  readonly version: string;
  /**
   * Closed JSON Schema (draft-07 / 2020-12 compatible) of the arguments, deeply frozen. Anything `validate`
   * accepts, the schema accepts; `validate` stays the final judge.
   */
  readonly inputSchema: DeviceOperationInputSchema;
  /** Lowercase hex SHA-256 of `canonicalJson({ version, tool, effect, description, inputSchema })`. */
  readonly schemaHash: string;
  validate(args: Record<string, JsonValue>): Record<string, JsonValue>;
}
export type DeviceArgumentSchema = { readonly [keyword: string]: JsonValue };
export interface DeviceOperationInputSchema {
  readonly type: "object";
  readonly properties: { readonly [name: string]: DeviceArgumentSchema };
  readonly required: readonly string[];
  readonly additionalProperties: false;
  /** Only `mac.cua.control`: `value` is present exactly when `action` is `set_value`. */
  readonly if?: DeviceArgumentSchema;
  readonly then?: DeviceArgumentSchema;
  readonly else?: DeviceArgumentSchema;
}

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const fileName = (value: unknown): string => {
  if (typeof value !== "string" || !FILE_NAME.test(value) || value.includes("..")) throw new DeviceError("invalid_input", "invalid file name");
  return value;
};
const line = (value: unknown): string => {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DeviceError("invalid_input", "invalid line");
  }
  return value;
};

export const FILE_READ = "mac.file.read";
export const FILE_APPEND = "mac.file.append";
export const PROCESS_PROBE = "mac.process.probe";
/** Per-bot browser session (G4). The URL is checked again on the Mac against the bot's local origin grant. */
export const BROWSER_NAVIGATE = "mac.browser.navigate";
export const BROWSER_READ = "mac.browser.read";
export const BROWSER_CLOSE = "mac.browser.close";
/** Short, operator-consented computer-use session on one surface the operator selected locally (G4). */
export const CUA_OBSERVE = "mac.cua.observe";
export const CUA_CONTROL = "mac.cua.control";
/** The calling bot's own current CUA session (selected surface, expiry), or a request for the operator's consent. */
export const CUA_STATUS = "mac.cua.status";

export const MAX_URL_LENGTH = 2048;
export const MAX_BROWSER_READ_CHARS = 8000;
export const MAX_CUA_NODES = 200;
export const CUA_ACTIONS: readonly string[] = Object.freeze(["press", "focus", "set_value"]);
const SURFACE_ID = /^srf_[0-9a-f]{32}$/;
const ELEMENT_ID = /^el_[0-9]{1,6}$/;

const intIn = (value: unknown, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new DeviceError("invalid_input", "invalid number");
  return value;
};
/**
 * Absolute http(s) URL without credentials, of bounded length, returned in its normalized form. Whether
 * its origin is allowed is a per-bot grant decided on the Mac, never by this syntactic check.
 */
export const browserUrl = (value: unknown): string => {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_URL_LENGTH || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new DeviceError("invalid_input", "invalid url");
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new DeviceError("invalid_input", "invalid url"); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.hostname === "") {
    throw new DeviceError("invalid_input", "invalid url");
  }
  url.hash = "";
  if (url.href.length > MAX_URL_LENGTH) throw new DeviceError("invalid_input", "invalid url");
  return url.href;
};
const surfaceId = (value: unknown): string => {
  if (typeof value !== "string" || !SURFACE_ID.test(value)) throw new DeviceError("invalid_input", "invalid surface");
  return value;
};

/**
 * Version of every operation's validator. 1.1.0 added `mac.cua.status`; the arguments and normalization of
 * the eight earlier operations are unchanged, but their pins move with the version.
 */
export const DEVICE_OPERATION_VERSION = "1.1.0";
// JSON Schema counts code points while `validate` counts UTF-16 units; the schema bounds are never stricter.
const FILE_NAME_SCHEMA: DeviceArgumentSchema = {
  type: "string", minLength: 1, maxLength: 64, pattern: "^(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
  description: "File name inside the daemon's selected root; no path separators and no '..'.",
};
const LINE_SCHEMA: DeviceArgumentSchema = {
  type: "string", minLength: 1, maxLength: 512, pattern: "^[^\\u0000-\\u001f\\u007f]+$",
  description: "One line without control characters; at most 512 UTF-16 code units, checked by the host.",
};
const URL_SCHEMA: DeviceArgumentSchema = {
  type: "string", minLength: 1, maxLength: MAX_URL_LENGTH, pattern: "^[Hh][Tt][Tt][Pp][Ss]?:[^\\u0000-\\u0020\\u007f]+$",
  description: "Absolute http(s) URL without credentials. The host parses and normalizes it (fragment dropped, at most "
    + `${MAX_URL_LENGTH} characters); the origin must be granted to the calling bot on the Mac.`,
};
const SURFACE_SCHEMA: DeviceArgumentSchema = {
  type: "string", minLength: 36, maxLength: 36, pattern: "^srf_[0-9a-f]{32}$",
  description: "Surface the operator selected locally for this bot's current session, as reported by mac.cua.status.",
};
const intSchema = (max: number): DeviceArgumentSchema => ({ type: "integer", minimum: 1, maximum: max });
const closed = (properties: Record<string, DeviceArgumentSchema>, required: string[]): DeviceOperationInputSchema =>
  ({ type: "object", properties, required, additionalProperties: false });

type OperationSource = Omit<DeviceOperation, "version" | "schemaHash">;
const operations: readonly OperationSource[] = [
  {
    tool: FILE_READ, effect: "read",
    description: "Read one small file by name inside the daemon's selected root.",
    inputSchema: closed({ name: FILE_NAME_SCHEMA }, ["name"]),
    validate: (args) => { const v = exact(args, ["name"]); return { name: fileName(v.name) }; },
  },
  {
    tool: FILE_APPEND, effect: "write",
    description: "Append one line to a file by name inside the daemon's selected root.",
    inputSchema: closed({ name: FILE_NAME_SCHEMA, line: LINE_SCHEMA }, ["name", "line"]),
    validate: (args) => { const v = exact(args, ["name", "line"]); return { name: fileName(v.name), line: line(v.line) }; },
  },
  {
    tool: PROCESS_PROBE, effect: "read",
    description: "Run the daemon's constant read-only Node probe; no caller-chosen program or arguments.",
    inputSchema: closed({}, []),
    validate: (args) => { exact(args, []); return {}; },
  },
  {
    // A GET can change remote state, so navigation is an effect.
    tool: BROWSER_NAVIGATE, effect: "write",
    description: "Navigate the calling bot's own browser profile to one http(s) URL whose origin the bot was granted on the Mac.",
    inputSchema: closed({ url: URL_SCHEMA }, ["url"]),
    validate: (args) => { const v = exact(args, ["url"]); return { url: browserUrl(v.url) }; },
  },
  {
    tool: BROWSER_READ, effect: "read",
    description: "Read the title, URL and bounded visible text of the calling bot's current page, returned as untrusted data.",
    inputSchema: closed({ maxChars: intSchema(MAX_BROWSER_READ_CHARS) }, ["maxChars"]),
    validate: (args) => { const v = exact(args, ["maxChars"]); return { maxChars: intIn(v.maxChars, 1, MAX_BROWSER_READ_CHARS) }; },
  },
  {
    tool: BROWSER_CLOSE, effect: "write",
    description: "Close the calling bot's browser session; its profile stays on the Mac.",
    inputSchema: closed({}, []),
    validate: (args) => { exact(args, []); return {}; },
  },
  {
    // Shows the operator's local consent prompt at most; it never grants a session or chooses a surface.
    tool: CUA_STATUS, effect: "read",
    description: "Report the calling bot's own consented CUA session on this Mac (selected surface id and expiry), or ask the "
      + "local operator to consent; only the operator selects the surface and approves.",
    inputSchema: closed({}, []),
    validate: (args) => { exact(args, []); return {}; },
  },
  {
    tool: CUA_OBSERVE, effect: "read",
    description: "List bounded accessibility elements of the surface the operator selected for this bot's consented session.",
    inputSchema: closed({ surfaceId: SURFACE_SCHEMA, maxNodes: intSchema(MAX_CUA_NODES) }, ["surfaceId", "maxNodes"]),
    validate: (args) => {
      const v = exact(args, ["surfaceId", "maxNodes"]);
      return { surfaceId: surfaceId(v.surfaceId), maxNodes: intIn(v.maxNodes, 1, MAX_CUA_NODES) };
    },
  },
  {
    tool: CUA_CONTROL, effect: "write",
    description: "Press, focus or set the value of one element of the selected surface during the bot's consented session.",
    inputSchema: {
      ...closed({
        surfaceId: SURFACE_SCHEMA,
        elementId: { type: "string", minLength: 4, maxLength: 9, pattern: "^el_[0-9]{1,6}$" },
        action: { type: "string", minLength: 5, maxLength: 9, enum: [...CUA_ACTIONS] },
        value: { ...LINE_SCHEMA, description: "Required exactly when action is set_value. " + String(LINE_SCHEMA.description) },
      }, ["surfaceId", "elementId", "action"]),
      if: { properties: { action: { const: "set_value" } }, required: ["action"] },
      then: { required: ["value"] },
      else: { not: { required: ["value"] } },
    },
    validate: (args) => {
      const v = exact(args, ["surfaceId", "elementId", "action"], ["value"]);
      if (typeof v.action !== "string" || !CUA_ACTIONS.includes(v.action)) throw new DeviceError("invalid_input", "invalid action");
      if (typeof v.elementId !== "string" || !ELEMENT_ID.test(v.elementId)) throw new DeviceError("invalid_input", "invalid element");
      if ((v.action === "set_value") !== Object.hasOwn(v, "value")) throw new DeviceError("invalid_input", "invalid value");
      const out: Record<string, JsonValue> = { surfaceId: surfaceId(v.surfaceId), elementId: v.elementId, action: v.action };
      if (v.action === "set_value") out.value = line(v.value);
      return out;
    },
  },
];

/** Pins one operation's schema and semantics; recomputable by any party from the published fields alone. */
export function deviceOperationSchemaHash(op: Pick<DeviceOperation, "version" | "tool" | "effect" | "description" | "inputSchema">): string {
  const pinned = { version: op.version, tool: op.tool, effect: op.effect, description: op.description, inputSchema: op.inputSchema };
  return createHash("sha256").update(canonicalJson(pinned as unknown as JsonValue)).digest("hex");
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
const canonical = new Map<string, DeviceOperation>(operations.map((source) => {
  const inputSchema = deepFreeze(structuredClone(source.inputSchema) as DeviceOperationInputSchema);
  const op = { tool: source.tool, effect: source.effect, description: source.description, version: DEVICE_OPERATION_VERSION, inputSchema };
  return [source.tool, Object.freeze({ ...op, schemaHash: deviceOperationSchemaHash(op), validate: Object.freeze(source.validate) })];
}));

/**
 * Read-only view of the declared operations. It is not a `Map` (no `set`/`delete`/`clear`, and
 * `Map.prototype.set.call` refuses it), its entries are deeply frozen, and `operationFor` reads a private
 * table, so no importer can add, replace or reshape an operation.
 */
class DeclaredOperations implements ReadonlyMap<string, DeviceOperation> {
  get size(): number { return canonical.size; }
  get(tool: string): DeviceOperation | undefined { return canonical.get(tool); }
  has(tool: string): boolean { return canonical.has(tool); }
  keys(): MapIterator<string> { return canonical.keys(); }
  values(): MapIterator<DeviceOperation> { return canonical.values(); }
  entries(): MapIterator<[string, DeviceOperation]> { return canonical.entries(); }
  forEach(fn: (op: DeviceOperation, tool: string, map: ReadonlyMap<string, DeviceOperation>) => void, thisArg?: unknown): void {
    for (const [tool, op] of canonical) fn.call(thisArg, op, tool, this);
  }
  [Symbol.iterator](): MapIterator<[string, DeviceOperation]> { return canonical.entries(); }
}
Object.freeze(DeclaredOperations.prototype);
export const DEVICE_OPERATIONS: ReadonlyMap<string, DeviceOperation> = Object.freeze(new DeclaredOperations());

/**
 * Capabilities that stay refused at pairing: raw CDP (arbitrary protocol/JS) and Keychain secrets. No
 * device can advertise them and no handler exists for them.
 */
export const UNSUPPORTED_DEVICE_CAPABILITIES: readonly string[] = Object.freeze([
  "mac.browser.cdp", "mac.browser.evaluate", "mac.keychain.read",
]);

/** The canonical, deeply frozen declaration of `tool`; throws for undeclared or refused tools. */
export function operationFor(tool: string): DeviceOperation {
  const op = canonical.get(tool);
  if (!op) throw new DeviceError(UNSUPPORTED_DEVICE_CAPABILITIES.includes(tool) ? "unsupported" : "invalid_input", "operation not declared");
  return op;
}
export function checkOperationArgs(tool: string, args: Record<string, JsonValue>): Record<string, JsonValue> {
  return operationFor(tool).validate(args);
}
/** Unique, declared, at most the number of declared operations. */
export function checkCapabilities(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > canonical.size) throw new DeviceError("invalid_input", "invalid capabilities");
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") throw new DeviceError("invalid_input", "invalid capabilities");
    operationFor(item);
    if (seen.has(item)) throw new DeviceError("invalid_input", "duplicate capability");
    seen.add(item);
  }
  return [...seen].sort();
}
