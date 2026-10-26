import { createHash, X509Certificate } from "node:crypto";
import { IdSchema, JsonSchema, ToolRequestSchema, type JsonValue, type ToolRequest } from "@dexter/contracts";
import { DeviceError } from "./errors.js";

/** Version of the host <-> paired device protocol carried in every path. */
export const DEVICE_PROTOCOL = "v1";
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_RESULT_BYTES = 16 * 1024;
export const MAX_JOBS_PER_POLL = 4;
export const MAX_RECEIPTS_PER_POLL = 16;

export const FINGERPRINT = /^[0-9a-f]{64}$/;
const WIRE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CODE = /^[a-z][a-z_]{0,47}$/;
const NONCE = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{64}$/;

/** SHA-256 of the DER certificate, lowercase hex. This is the pin; it is public metadata, never a secret. */
export function fingerprintDer(raw: Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}
export function certificateFingerprint(pem: string | Buffer): string {
  try {
    return fingerprintDer(new X509Certificate(pem).raw);
  } catch {
    throw new DeviceError("invalid_input", "certificate unreadable");
  }
}

type Plain = Record<string, unknown>;
/** Accepts only a plain object with exactly the required keys plus any of the optional ones. */
export function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Plain {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DeviceError("invalid_input", "object expected");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new DeviceError("invalid_input", "plain object expected");
  const keys = Object.keys(value);
  for (const key of keys) if (!required.includes(key) && !optional.includes(key)) throw new DeviceError("invalid_input", "unknown field");
  for (const key of required) if (!Object.hasOwn(value, key)) throw new DeviceError("invalid_input", "missing field");
  return value as Plain;
}
export function wireId(value: unknown): string {
  if (typeof value !== "string" || !WIRE_ID.test(value) || !IdSchema.safeParse(value).success) throw new DeviceError("invalid_input", "invalid id");
  return value;
}
export function ownerIdOf(value: unknown): string {
  if (typeof value !== "string" || !IdSchema.safeParse(value).success) throw new DeviceError("invalid_input", "invalid owner");
  return value;
}
export function codeOf(value: unknown): string {
  if (typeof value !== "string" || !CODE.test(value)) throw new DeviceError("invalid_input", "invalid code");
  return value;
}
export function nonceOf(value: unknown): string {
  if (typeof value !== "string" || !NONCE.test(value)) throw new DeviceError("invalid_input", "invalid nonce");
  return value;
}
export function hashOf(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new DeviceError("invalid_input", "invalid hash");
  return value;
}
export function jsonOf(value: unknown): JsonValue {
  const parsed = JsonSchema.safeParse(value);
  if (!parsed.success) throw new DeviceError("invalid_input", "invalid json");
  return parsed.data;
}
export function toolRequestOf(value: unknown): ToolRequest {
  const parsed = ToolRequestSchema.safeParse(value);
  if (!parsed.success) throw new DeviceError("invalid_input", "invalid request");
  return parsed.data;
}
export function boundedJson(value: JsonValue, limit = MAX_RESULT_BYTES): JsonValue {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw new DeviceError("invalid_input", "result not json"); }
  if (Buffer.byteLength(encoded) > limit) throw new DeviceError("invalid_input", "result too large");
  return value;
}

/** A job the host hands to the paired device. Identity fields are checked by the daemon against its pins. */
export interface DeviceJob {
  actionId: string;
  nonce: string;
  hostId: string;
  ownerId: string;
  deviceId: string;
  requestHash: string;
  request: ToolRequest;
  deadlineAt: number;
}
export type ReceiptStatus = "completed" | "failed" | "unknown";
/**
 * `completed`: the effect ran and `result` is its bounded output. `failed`: the daemon refused before any
 * effect (fixed `code`). `unknown`: the effect may or may not have happened; never retried.
 */
export interface DeviceReceipt {
  actionId: string;
  nonce: string;
  requestHash: string;
  status: ReceiptStatus;
  result: JsonValue | null;
  code: string | null;
}

export function parseJob(value: unknown): DeviceJob {
  const v = exact(value, ["actionId", "nonce", "hostId", "ownerId", "deviceId", "requestHash", "request", "deadlineAt"]);
  if (typeof v.deadlineAt !== "number" || !Number.isSafeInteger(v.deadlineAt) || v.deadlineAt < 0) throw new DeviceError("invalid_input", "invalid deadline");
  return {
    actionId: wireId(v.actionId), nonce: nonceOf(v.nonce), hostId: wireId(v.hostId), ownerId: ownerIdOf(v.ownerId),
    deviceId: wireId(v.deviceId), requestHash: hashOf(v.requestHash), request: toolRequestOf(v.request), deadlineAt: v.deadlineAt,
  };
}
export function parseReceipt(value: unknown): DeviceReceipt {
  const v = exact(value, ["actionId", "nonce", "requestHash", "status", "result", "code"]);
  if (v.status !== "completed" && v.status !== "failed" && v.status !== "unknown") throw new DeviceError("invalid_input", "invalid status");
  const result = v.result === null ? null : boundedJson(jsonOf(v.result));
  const code = v.code === null ? null : codeOf(v.code);
  if (v.status === "completed" ? (result === null || code !== null) : (result !== null || code === null)) {
    throw new DeviceError("invalid_input", "inconsistent receipt");
  }
  return { actionId: wireId(v.actionId), nonce: nonceOf(v.nonce), requestHash: hashOf(v.requestHash), status: v.status, result, code };
}
