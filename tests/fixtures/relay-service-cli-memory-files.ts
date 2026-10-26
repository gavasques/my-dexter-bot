import { writeSync } from "node:fs";
import { readRelayMemoryRecord, type RelayMemoryRecord } from "./relay-memory-ipc.js";

const CONFIG_PATH = "relay-memory://config";
const KEY_PATH = "relay-memory://tls-key";
const CERT_PATH = "relay-memory://tls-cert";
let record: RelayMemoryRecord | undefined;
let key: Buffer | undefined;
let cert: Buffer | undefined;
let configBytes: Buffer | undefined;
let issuedKey: Buffer | undefined;

function takeRecord(): void {
  if (record) return;
  record = readRelayMemoryRecord(3);
  configBytes = record.config;
  key = record.key;
  cert = record.cert;
}

/** Replaces only the CLI's private file-reader import in this explicitly launched test child. */
export function readPrivateFile(path: string, maximumBytes: number): Buffer {
  takeRecord();
  if (typeof path !== "string" || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error("untrusted_file");
  if (path === CONFIG_PATH && configBytes) {
    const bytes = configBytes; configBytes = undefined;
    if (bytes.length > maximumBytes) { bytes.fill(0); throw new Error("untrusted_file"); }
    return bytes;
  }
  if (path === KEY_PATH && key) {
    const bytes = key; key = undefined;
    if (bytes.length > maximumBytes) { bytes.fill(0); throw new Error("untrusted_file"); }
    issuedKey = bytes;
    return bytes;
  }
  if (path === CERT_PATH && cert) {
    const bytes = cert; cert = undefined;
    if (bytes.length > maximumBytes) { bytes.fill(0); throw new Error("untrusted_file"); }
    return bytes;
  }
  throw new Error("untrusted_file");
}

process.on("exit", () => {
  // Observe the exact Buffer handed to the real CLI before this fixture cleans up any aliases.
  const issuedKeyWipedBeforeCleanup = issuedKey !== undefined && issuedKey.length > 0 && issuedKey.every(byte => byte === 0);
  const unreadKey = issuedKey === undefined ? (key ?? record?.key) : undefined;
  const unreadKeyPresent = unreadKey !== undefined && unreadKey.length > 0;

  // Always clean every record-owned Buffer, including startup refusal and undelivered material.
  key?.fill(0); issuedKey?.fill(0); cert?.fill(0); record?.key.fill(0); record?.cert.fill(0); record?.config.fill(0);
  const unreadKeyWipedByCleanup = unreadKeyPresent && unreadKey!.every(byte => byte === 0);
  const receipt = issuedKey !== undefined
    ? (issuedKeyWipedBeforeCleanup ? "WIPE_OK" : "WIPE_MISSING")
    : (unreadKeyWipedByCleanup ? "WIPE_RECORD_OK" : "WIPE_MISSING");
  const result = Buffer.from(receipt);
  try { writeSync(4, result); } catch { /* test-only receipt pipe may already be closed */ }
  result.fill(0);
});
