import { createCipheriv, createDecipheriv, randomBytes, type KeyObject } from "node:crypto";
import { OperationsError, fail } from "./errors.js";

/**
 * Authenticated envelope for one inspection snapshot, built only from Node's AES-256-GCM.
 *
 *   magic(8) | headerLength(u16 BE) | header JSON | nonce(12) | ciphertext | tag(16)
 *
 * Everything before the ciphertext (magic, header with format/version/purpose/key id/length, nonce) is
 * bound as additional authenticated data. Plaintext is returned only after `final()` verified the tag.
 */
export const ENVELOPE_MAGIC = Buffer.from([0x44, 0x58, 0x47, 0x38, 0x53, 0x4e, 0x50, 0x01]); // "DXG8SNP\x01"
export const ENVELOPE_VERSION = 1;
export const ENVELOPE_PURPOSE = "dexter.g8.inspection-snapshot";
export const ENVELOPE_ALGORITHM = "AES-256-GCM";
/** Purpose of the authority checkpoint artifact. An inspection envelope can never be opened as one, or vice versa. */
export const AUTHORITY_ENVELOPE_PURPOSE = "dexter.g8.authority-checkpoint";
export type EnvelopePurpose = typeof ENVELOPE_PURPOSE | typeof AUTHORITY_ENVELOPE_PURPOSE;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 1024;
const PREFIX_BYTES = ENVELOPE_MAGIC.length + 2;
const KEY_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Owner-controlled key capability. The 32-byte secret key is lent synchronously for one operation and is never
 * stored, logged, hashed into the artifact or returned. `keyId` is a non-secret label bound into the header.
 * Storage, rotation and recovery UX of the key are a separate future integration.
 */
export interface SnapshotKey {
  readonly keyId: string;
  use<T>(operation: (key: KeyObject) => T): T;
}

interface EnvelopeHeader { v: number; alg: string; purpose: string; keyId: string; ciphertextBytes: number }

function checkedKey(key: KeyObject): KeyObject {
  if (key.type !== "secret" || key.symmetricKeySize !== 32) fail("invalid_input", "snapshot key must be a 32-byte secret key");
  return key;
}

function lend<T>(capability: SnapshotKey, operation: (key: KeyObject) => T): T {
  if (!capability || typeof capability.keyId !== "string" || !KEY_ID.test(capability.keyId) || typeof capability.use !== "function") {
    fail("invalid_input", "snapshot key capability is invalid");
  }
  let called = false;
  const result = capability.use((key) => { called = true; return operation(checkedKey(key)); });
  if (!called) fail("invalid_input", "snapshot key capability did not lend a key");
  return result;
}

function headerFor(keyId: string, ciphertextBytes: number, purpose: EnvelopePurpose = ENVELOPE_PURPOSE): Buffer {
  const header = Buffer.from(JSON.stringify({
    v: ENVELOPE_VERSION, alg: ENVELOPE_ALGORITHM, purpose, keyId, ciphertextBytes,
  } satisfies EnvelopeHeader), "utf8");
  if (header.length > MAX_HEADER_BYTES) fail("invalid_input", "envelope header is too large");
  return header;
}

/** Exact sealed size of a plaintext of `plaintextBytes`, so quotas can be enforced before anything is assembled. */
export function sealedLength(plaintextBytes: number, keyId: string, purpose: EnvelopePurpose = ENVELOPE_PURPOSE): number {
  return PREFIX_BYTES + headerFor(keyId, plaintextBytes, purpose).length + NONCE_BYTES + plaintextBytes + TAG_BYTES;
}

export function sealEnvelope(plaintext: Buffer, capability: SnapshotKey, purpose: EnvelopePurpose = ENVELOPE_PURPOSE): Buffer {
  return lend(capability, (key) => {
    const header = headerFor(capability.keyId, plaintext.length, purpose);
    const length = Buffer.alloc(2); length.writeUInt16BE(header.length);
    const nonce = randomBytes(NONCE_BYTES);
    const aad = Buffer.concat([ENVELOPE_MAGIC, length, header, nonce]);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([aad, ciphertext, cipher.getAuthTag()]);
  });
}

function parseHeader(bytes: Buffer): EnvelopeHeader {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return fail("corrupt", "envelope header is not valid"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("corrupt", "envelope header is not valid");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "alg,ciphertextBytes,keyId,purpose,v") return fail("corrupt", "envelope header is not valid");
  const { v, alg, purpose, keyId, ciphertextBytes } = record;
  if (typeof v !== "number" || typeof alg !== "string" || typeof purpose !== "string" || typeof keyId !== "string"
    || typeof ciphertextBytes !== "number" || !Number.isSafeInteger(ciphertextBytes) || ciphertextBytes < 0) {
    return fail("corrupt", "envelope header is not valid");
  }
  return { v, alg, purpose, keyId, ciphertextBytes };
}

/** Bounded decode, header/context checks, then authenticated decryption. Any mismatch fails closed. */
export function openEnvelope(envelope: Buffer, capability: SnapshotKey, maxBytes: number, purpose: EnvelopePurpose = ENVELOPE_PURPOSE): Buffer {
  if (envelope.length > maxBytes) fail("quota_exceeded", "snapshot artifact exceeds the size limit");
  if (envelope.length < PREFIX_BYTES + NONCE_BYTES + TAG_BYTES || !envelope.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) {
    fail("corrupt", "not a Dexter inspection snapshot");
  }
  const headerLength = envelope.readUInt16BE(ENVELOPE_MAGIC.length);
  if (headerLength < 2 || headerLength > MAX_HEADER_BYTES || envelope.length < PREFIX_BYTES + headerLength + NONCE_BYTES + TAG_BYTES) {
    fail("corrupt", "envelope header length is invalid");
  }
  const header = parseHeader(envelope.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength));
  if (header.v !== ENVELOPE_VERSION || header.alg !== ENVELOPE_ALGORITHM || header.purpose !== purpose) {
    fail("corrupt", "envelope format, version or purpose is unsupported");
  }
  const aadLength = PREFIX_BYTES + headerLength + NONCE_BYTES;
  if (header.ciphertextBytes !== envelope.length - aadLength - TAG_BYTES) fail("corrupt", "envelope length does not match its header");
  return lend(capability, (key) => {
    if (header.keyId !== capability.keyId) fail("authentication_failed", "snapshot was sealed for another key id");
    const aad = envelope.subarray(0, aadLength);
    const nonce = envelope.subarray(PREFIX_BYTES + headerLength, aadLength);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(envelope.subarray(envelope.length - TAG_BYTES));
    const unverified = decipher.update(envelope.subarray(aadLength, envelope.length - TAG_BYTES));
    try {
      decipher.final();
    } catch (cause) {
      unverified.fill(0);
      throw new OperationsError("authentication_failed", "snapshot authentication failed", { cause });
    }
    return unverified;
  });
}

/**
 * Unauthenticated classification of an envelope header for read-only tooling (no key, no plaintext): which purpose
 * it claims and whether that purpose could ever be activated. Nothing here is trusted until `openEnvelope` verifies.
 */
export function classifyEnvelopeHeader(prefix: Buffer): { purpose: string; keyId: string; activatable: boolean } | null {
  if (prefix.length < PREFIX_BYTES || !prefix.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) return null;
  const headerLength = prefix.readUInt16BE(ENVELOPE_MAGIC.length);
  if (headerLength < 2 || headerLength > MAX_HEADER_BYTES || prefix.length < PREFIX_BYTES + headerLength) return null;
  try {
    const header = parseHeader(prefix.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength));
    return { purpose: header.purpose, keyId: header.keyId, activatable: header.purpose === AUTHORITY_ENVELOPE_PURPOSE };
  } catch { return null; }
}
