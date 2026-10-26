import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { types } from "node:util";

export type RelayErrorCode = "invalid_input" | "forbidden" | "conflict" | "expired" | "quota" | "host_locked" | "unavailable" | "clock_untrusted";
export class RelayError extends Error {
  constructor(readonly code: RelayErrorCode) { super(`relay ${code}`); this.name = "RelayError"; }
}
export const MAX_CIPHERTEXT_BYTES = 32_768;
export const MAX_TTL_MS = 86_400_000;
export const MAX_BATCH = 100;
export interface DevicePin {
  installationId: string; ownerId: string; deviceId: string; generation: number; keyId: string;
  signingPublicKey: string; encryptionPublicKey: string;
}
export interface Envelope {
  version: 1; installationId: string; ownerId: string; messageId: string;
  senderId: string; senderGeneration: number; senderKeyId: string;
  recipientId: string; recipientGeneration: number; recipientKeyId: string;
  type: "command" | "event" | "receipt"; sequence: number; createdAt: number; expiresAt: number;
  ephemeralPublicKey: string; nonce: string; ciphertext: string; tag: string; signature: string;
}
export interface ControlBase {
  version: 1; installationId: string; ownerId: string; deviceId: string; generation: number; keyId: string;
  requestId: string; issuedAt: number;
}
export interface PollRequest extends ControlBase { kind: "poll"; after: number; limit: number; signature: string }
export interface AckItem { messageId: string; receiptId: string }
export interface AckRequest extends ControlBase { kind: "ack"; messages: AckItem[]; signature: string }
export type SignedControl = PollRequest | AckRequest;
export interface Delivery { cursor: number; receiptId: string; envelope: Envelope }
export interface QueueReceipt { receiptId: string; cursor: number }

export function id(v: unknown): asserts v is string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(v)) throw new RelayError("invalid_input");
}
export function integer(v: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): asserts v is number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new RelayError("invalid_input");
}
export function exact(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) throw new RelayError("invalid_input");
  const obj = v as Record<string, unknown>;
  if (Object.keys(obj).length !== keys.length || keys.some(k => !Object.hasOwn(obj, k))) throw new RelayError("invalid_input");
  for (const k of keys) { const d = Object.getOwnPropertyDescriptor(obj, k); if (!d || !("value" in d)) throw new RelayError("invalid_input"); }
  return obj;
}
function snapshot(value: unknown): unknown {
  // Reject proxies/accessors before cloning, and validate only the stable clone. No custom iterators.
  const visit = (v: unknown, depth: number): void => {
    if (depth > 4) throw new RelayError("invalid_input");
    if (v === null || typeof v !== "object") return;
    if (types.isProxy(v)) throw new RelayError("invalid_input");
    const keys = Reflect.ownKeys(v);
    if (keys.length > 101 || (Array.isArray(v) && v.length > MAX_BATCH)) throw new RelayError("invalid_input");
    for (const k of keys) {
      if (typeof k !== "string") throw new RelayError("invalid_input");
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!d || !("value" in d)) throw new RelayError("invalid_input");
      visit(d.value, depth + 1);
    }
  };
  try { visit(value, 0); return structuredClone(value); }
  catch { throw new RelayError("invalid_input"); }
}
export function bytes(v: unknown, max: number, size?: number): Buffer {
  if (typeof v !== "string" || v.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) throw new RelayError("invalid_input");
  const b = Buffer.from(v, "base64");
  if (b.toString("base64") !== v || b.length > max || (size !== undefined && b.length !== size)) throw new RelayError("invalid_input");
  return b;
}
export function publicKey(v: unknown, algorithm: "ed25519" | "x25519"): KeyObject {
  try {
    const encoded = bytes(v, 128), key = createPublicKey({ key: encoded, type: "spki", format: "der" });
    if (key.asymmetricKeyType !== algorithm || !key.export({ type: "spki", format: "der" }).equals(encoded)) throw new RelayError("invalid_input");
    return key;
  } catch { throw new RelayError("invalid_input"); }
}
export function pin(v: unknown): DevicePin {
  v = snapshot(v);
  const x = exact(v, ["installationId", "ownerId", "deviceId", "generation", "keyId", "signingPublicKey", "encryptionPublicKey"]);
  for (const k of ["installationId", "ownerId", "deviceId", "keyId"]) id(x[k]);
  integer(x.generation); publicKey(x.signingPublicKey, "ed25519"); publicKey(x.encryptionPublicKey, "x25519");
  return structuredClone(v) as DevicePin;
}
const ENVELOPE_KEYS = ["version", "installationId", "ownerId", "messageId", "senderId", "senderGeneration", "senderKeyId", "recipientId", "recipientGeneration", "recipientKeyId", "type", "sequence", "createdAt", "expiresAt", "ephemeralPublicKey", "nonce", "ciphertext", "tag", "signature"] as const;
export function envelope(v: unknown): Envelope {
  v = snapshot(v);
  const x = exact(v, ENVELOPE_KEYS);
  if (x.version !== 1 || !["command", "event", "receipt"].includes(x.type as string)) throw new RelayError("invalid_input");
  for (const k of ["installationId", "ownerId", "messageId", "senderId", "senderKeyId", "recipientId", "recipientKeyId"]) id(x[k]);
  for (const k of ["senderGeneration", "recipientGeneration", "sequence", "createdAt", "expiresAt"]) integer(x[k]);
  if ((x.expiresAt as number) <= (x.createdAt as number) || (x.expiresAt as number) - (x.createdAt as number) > MAX_TTL_MS || x.senderId === x.recipientId) throw new RelayError("invalid_input");
  publicKey(x.ephemeralPublicKey, "x25519"); bytes(x.nonce, 12, 12); bytes(x.tag, 16, 16);
  bytes(x.ciphertext, MAX_CIPHERTEXT_BYTES); bytes(x.signature, 64, 64);
  return Object.fromEntries(ENVELOPE_KEYS.map(k => [k, x[k]])) as unknown as Envelope;
}
export function header(e: Omit<Envelope, "ciphertext" | "tag" | "signature">): string {
  return JSON.stringify([e.version, e.installationId, e.ownerId, e.messageId, e.senderId, e.senderGeneration, e.senderKeyId,
    e.recipientId, e.recipientGeneration, e.recipientKeyId, e.type, e.sequence, e.createdAt, e.expiresAt, e.ephemeralPublicKey, e.nonce]);
}
export function envelopeBytes(e: Envelope): Buffer {
  return Buffer.from(`DEXTER_RELAY_ENVELOPE_V1\n${header(e)}\n${JSON.stringify([e.ciphertext, e.tag])}`, "utf8");
}
/** Call only after signature validation: signature representation is not part of authenticated body identity. */
export function digest(e: Envelope): string { return createHash("sha256").update(envelopeBytes(e)).digest("hex"); }
export function verifyEnvelope(e: Envelope, sender: DevicePin, recipient: DevicePin): void {
  if (e.ownerId !== sender.ownerId || e.ownerId !== recipient.ownerId || e.installationId !== sender.installationId || e.installationId !== recipient.installationId
    || e.senderId !== sender.deviceId || e.senderGeneration !== sender.generation || e.senderKeyId !== sender.keyId
    || e.recipientId !== recipient.deviceId || e.recipientGeneration !== recipient.generation || e.recipientKeyId !== recipient.keyId
    || !verify(null, envelopeBytes(e), publicKey(sender.signingPublicKey, "ed25519"), bytes(e.signature, 64, 64))) throw new RelayError("forbidden");
}
const BASE_KEYS = ["version", "installationId", "ownerId", "deviceId", "generation", "keyId", "requestId", "issuedAt", "kind", "signature"];
export function control(v: unknown): SignedControl {
  v = snapshot(v);
  const kind = v !== null && typeof v === "object" ? Object.getOwnPropertyDescriptor(v, "kind")?.value : undefined;
  const x = exact(v, [...BASE_KEYS, ...(kind === "poll" ? ["after", "limit"] : kind === "ack" ? ["messages"] : [])]);
  if (x.version !== 1 || (kind !== "poll" && kind !== "ack")) throw new RelayError("invalid_input");
  for (const k of ["installationId", "ownerId", "deviceId", "keyId", "requestId"]) id(x[k]);
  integer(x.generation); integer(x.issuedAt); bytes(x.signature, 64, 64);
  if (kind === "poll") { integer(x.after, 0); integer(x.limit, 1, MAX_BATCH); }
  else {
    if (!Array.isArray(x.messages) || x.messages.length < 1 || x.messages.length > MAX_BATCH) throw new RelayError("invalid_input");
    const seen = new Set<string>();
    for (const value of x.messages) {
      const item = exact(value, ["messageId", "receiptId"]); id(item.messageId); id(item.receiptId);
      if (seen.has(item.messageId)) throw new RelayError("invalid_input"); seen.add(item.messageId);
    }
  }
  return structuredClone(v) as SignedControl;
}
export function controlBytes(c: SignedControl): Buffer {
  return Buffer.from(`DEXTER_RELAY_CONTROL_V1\n${JSON.stringify([c.version, c.kind, c.installationId, c.ownerId, c.deviceId, c.generation, c.keyId, c.requestId, c.issuedAt,
    c.kind === "poll" ? [c.after, c.limit] : c.messages.map(x => [x.messageId, x.receiptId])])}`);
}
