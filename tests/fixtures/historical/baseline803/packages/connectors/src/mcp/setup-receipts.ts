import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  McpRegistrationReceiptSchema, type McpRegistrationAuthority, type McpRegistrationReceipt,
} from "@dexter/contracts";
import { McpConnectorError } from "./errors.js";

export const NATIVE_MCP_RECEIPT_LIMIT = 4096;
export const NATIVE_MCP_SCHEMA_VERSION = "2";
export const NATIVE_MCP_RECEIPTS_SQL = `CREATE TABLE setup_receipts(
  request_key_hash TEXT PRIMARY KEY, origin_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
  receipt TEXT NOT NULL, receipt_hash TEXT NOT NULL) STRICT;`;

const conflict = (): never => { throw new McpConnectorError("store_conflict"); };
const invalid = (): never => { throw new McpConnectorError("invalid_request"); };
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/;
/** Code-unit sorting matches the definition pin; reject broken UTF-16 rather than hash replacement bytes. */
export function mcpSetupCanonicalJSON(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (typeof item === "string") { if (Buffer.from(item, "utf8").toString("utf8") !== item) invalid(); return item; }
    if (item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, entry]) => { if (Buffer.from(key, "utf8").toString("utf8") !== key) invalid(); return [key, canonical(entry)]; }));
    }
    return invalid();
  };
  return JSON.stringify(canonical(value));
}
export const mcpSetupHash = (value: unknown): string => createHash("sha256").update(mcpSetupCanonicalJSON(value), "utf8").digest("hex");
export const mcpSetupInstancePin = (definitionHash: string, generation: string | null): string =>
  createHash("sha256").update(JSON.stringify({ definitionHash, generation }), "utf8").digest("hex");

/** Validate trusted arguments separately; no caller-supplied identity/provenance is admitted in the request. */
export function mcpSetupOriginHash(authority: McpRegistrationAuthority, host: { hostId: string; ownerId: string }): string {
  if (!authority || typeof authority !== "object" || Array.isArray(authority)
    || Object.keys(authority).sort().join(",") !== "installationId,origin,ownerId"
    || authority.installationId !== host.hostId || authority.ownerId !== host.ownerId) {
    throw new McpConnectorError("scope_mismatch");
  }
  const origin = authority.origin;
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) invalid();
  if (origin.kind === "owner_local") {
    if (Object.keys(origin).join(",") !== "kind") invalid();
  } else if (origin.kind === "harness_action") {
    if (Object.keys(origin).sort().join(",") !== "actionId,botId,callId,kind,threadId,turnId"
      || [origin.botId, origin.threadId, origin.turnId, origin.actionId, origin.callId].some(id => typeof id !== "string" || !ID.test(id))) invalid();
  } else invalid();
  return mcpSetupHash({ version: 1, installationId: host.hostId, ownerId: host.ownerId, origin });
}
export const mcpSetupRequestKeyHash = (originHash: string, requestId: string): string =>
  mcpSetupHash({ operation: "mcp.register", originHash, requestIdHash: mcpSetupHash({ requestId }) });
export const mcpSetupRequestHash = (definitionPin: string, inputHash: string): string =>
  mcpSetupHash({ version: 1, operation: "mcp.register", expectedInstancePin: null, definitionPin, inputHash });

export function createMcpSetupReceipt(input: {
  requestKeyHash: string; requestIdHash: string; requestHash: string; inputHash: string; originHash: string; instanceId: string; generation: string; definitionPin: string;
}): McpRegistrationReceipt {
  return Object.freeze(McpRegistrationReceiptSchema.parse({
    version: 1, operation: "mcp.register", receiptId: randomUUID(), ...input,
    instancePin: mcpSetupInstancePin(input.definitionPin, input.generation), registeredAt: Date.now(),
  }));
}

type Row = Record<string, unknown>;
export function readMcpSetupReceiptRow(row: Row): McpRegistrationReceipt {
  try {
    if (typeof row.receipt !== "string" || Buffer.byteLength(row.receipt, "utf8") > 2048) conflict();
    const parsed = McpRegistrationReceiptSchema.safeParse(JSON.parse(row.receipt as string));
    if (!parsed.success) return conflict();
    const receipt = parsed.data;
    if (mcpSetupCanonicalJSON(receipt) !== row.receipt || mcpSetupHash(receipt) !== row.receipt_hash
      || row.request_key_hash !== receipt.requestKeyHash || row.origin_hash !== receipt.originHash || row.request_hash !== receipt.requestHash
      || mcpSetupInstancePin(receipt.definitionPin, receipt.generation) !== receipt.instancePin
      || mcpSetupRequestHash(receipt.definitionPin, receipt.inputHash) !== receipt.requestHash
      || mcpSetupHash({ operation: "mcp.register", originHash: receipt.originHash, requestIdHash: receipt.requestIdHash }) !== receipt.requestKeyHash) conflict();
    return Object.freeze(receipt);
  } catch { return conflict(); }
}

export function findMcpSetupReceipt(db: DatabaseSync, requestKeyHash: string, originHash: string): McpRegistrationReceipt | null {
  const row = db.prepare("SELECT * FROM setup_receipts WHERE request_key_hash=?").get(requestKeyHash) as Row | undefined;
  if (!row) return null;
  const receipt = readMcpSetupReceiptRow(row);
  if (receipt.originHash !== originHash) throw new McpConnectorError("scope_mismatch");
  return receipt;
}
export function insertMcpSetupReceipt(db: DatabaseSync, receipt: McpRegistrationReceipt): void {
  const count = db.prepare("SELECT COUNT(*) AS n FROM setup_receipts").get() as Row;
  if (Number(count.n) >= NATIVE_MCP_RECEIPT_LIMIT) throw new McpConnectorError("server_limit", "setup_receipt_limit");
  db.prepare("INSERT INTO setup_receipts VALUES (?,?,?,?,?)")
    .run(receipt.requestKeyHash, receipt.originHash, receipt.requestHash, mcpSetupCanonicalJSON(receipt), mcpSetupHash(receipt));
}

const BASE_SQL: Readonly<Record<string, string>> = Object.freeze({
  meta: "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
  servers: "CREATE TABLE servers(id TEXT PRIMARY KEY, definition TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('configured','ready','failed','needs_auth','deleting'))) STRICT",
  catalogs: "CREATE TABLE catalogs(server_id TEXT PRIMARY KEY, tools TEXT NOT NULL) STRICT",
  connections: "CREATE TABLE connections(server_id TEXT NOT NULL, profile_id TEXT NOT NULL, connection_id TEXT NOT NULL, PRIMARY KEY(server_id, profile_id)) STRICT",
  selections: "CREATE TABLE selections(server_id TEXT NOT NULL, bot_id TEXT NOT NULL, tools TEXT NOT NULL, PRIMARY KEY(server_id, bot_id)) STRICT",
});
/** Normalize SQL spelling outside string literals: literal CHECK values remain case-sensitive. */
const sqlPin = (sql: string): string => {
  const text = sql.replace(/^(\s*CREATE\s+TABLE\s+)IF\s+NOT\s+EXISTS\s+/i, "$1");
  let out = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "'") {
      out += char;
      if (quoted && text[index + 1] === "'") { out += "'"; index++; }
      else quoted = !quoted;
    } else if (quoted) out += char;
    else if (!/[\s;]/.test(char)) out += char.toLowerCase();
  }
  return out;
};
/** Validate before migration; an altered table/trigger/index cannot be silently repaired by CREATE IF NOT EXISTS. */
export function validateMcpSetupSchema(db: DatabaseSync, version: "1" | "2"): void {
  const expected = version === "1" ? BASE_SQL : { ...BASE_SQL, setup_receipts: NATIVE_MCP_RECEIPTS_SQL };
  const rows = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as Row[];
  if (rows.length !== Object.keys(expected).length || rows.some(row => row.type !== "table" || typeof row.name !== "string"
    || !Object.hasOwn(expected, row.name) || typeof row.sql !== "string" || sqlPin(row.sql) !== sqlPin(expected[row.name]!))) conflict();
  if ((db.prepare("PRAGMA user_version").get() as Row).user_version !== 0) conflict();
}
/** Full bounded journal validation on reopen and before writes; query validates its selected row too. */
export function validateMcpSetupReceipts(db: DatabaseSync): void {
  const count = db.prepare("SELECT COUNT(*) AS n FROM setup_receipts").get() as Row;
  if (!Number.isSafeInteger(count.n) || Number(count.n) > NATIVE_MCP_RECEIPT_LIMIT) conflict();
  const receiptIds = new Set<string>(), generations = new Set<string>();
  for (const row of db.prepare("SELECT * FROM setup_receipts").all() as Row[]) {
    if ([row.request_key_hash, row.origin_hash, row.request_hash, row.receipt_hash].some(hash => typeof hash !== "string" || !HASH.test(hash))) conflict();
    const receipt = readMcpSetupReceiptRow(row);
    if (receiptIds.has(receipt.receiptId) || generations.has(receipt.generation)) conflict();
    receiptIds.add(receipt.receiptId); generations.add(receipt.generation);
  }
}
