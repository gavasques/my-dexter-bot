import { fstatSync, readSync } from "node:fs";

const HEADER_BYTES = 12;
export const MAX_RELAY_MEMORY_IPC_BYTES = 65_536;
export interface RelayMemoryRecord {
  config: Buffer;
  key: Buffer;
  cert: Buffer;
}

/** Test-only bounded FD3 record: public config JSON, then private key bytes and public certificate bytes. */
export function encodeRelayMemoryRecord(config: unknown, key: Buffer, cert: Buffer): Buffer {
  const serialized = JSON.stringify(config);
  if (typeof serialized !== "string") throw new Error("relay_memory_record_invalid");
  const configBytes = Buffer.from(serialized);
  try { return encodeRelayMemoryRecordBytes(configBytes, key, cert); }
  finally { configBytes.fill(0); }
}

/** Preserve exact public config bytes so the real CLI parser remains the authority for strict JSON. */
export function encodeRelayMemoryRecordBytes(configBytes: Buffer, key: Buffer, cert: Buffer): Buffer {
  const total = HEADER_BYTES + configBytes.length + key.length + cert.length;
  if (configBytes.length < 1 || key.length < 1 || cert.length < 1 || total > MAX_RELAY_MEMORY_IPC_BYTES) {
    throw new Error("relay_memory_record_invalid");
  }
  const record = Buffer.alloc(total);
  record.writeUInt32BE(configBytes.length, 0);
  record.writeUInt32BE(key.length, 4);
  record.writeUInt32BE(cert.length, 8);
  let offset = HEADER_BYTES;
  configBytes.copy(record, offset); offset += configBytes.length;
  key.copy(record, offset); offset += key.length;
  cert.copy(record, offset);
  return record;
}

/** Read one closed anonymous pipe record with no environment, path, or product custody fallback. */
export function readRelayMemoryRecord(fd = 3): RelayMemoryRecord {
  try {
    const descriptor = fstatSync(fd);
    if (!descriptor.isFIFO() && !descriptor.isSocket()) throw new Error("relay_memory_descriptor_untrusted");
  } catch {
    throw new Error("relay_memory_descriptor_untrusted");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = Buffer.alloc(Math.min(8192, MAX_RELAY_MEMORY_IPC_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) { chunk.fill(0); break; }
      total += count;
      if (total > MAX_RELAY_MEMORY_IPC_BYTES) { chunk.fill(0); throw new Error("relay_memory_record_oversized"); }
      chunks.push(Buffer.from(chunk.subarray(0, count)));
      chunk.fill(0);
    }
    const bytes = Buffer.concat(chunks, total);
    try {
      if (bytes.length < HEADER_BYTES) throw new Error("relay_memory_record_invalid");
      const configLength = bytes.readUInt32BE(0), keyLength = bytes.readUInt32BE(4), certLength = bytes.readUInt32BE(8);
      if (configLength < 1 || keyLength < 1 || certLength < 1 || HEADER_BYTES + configLength + keyLength + certLength !== bytes.length) {
        throw new Error("relay_memory_record_invalid");
      }
      const configStart = HEADER_BYTES, keyStart = configStart + configLength, certStart = keyStart + keyLength;
      const config = Buffer.from(bytes.subarray(configStart, keyStart));
      return { config, key: Buffer.from(bytes.subarray(keyStart, certStart)), cert: Buffer.from(bytes.subarray(certStart)) };
    } finally { bytes.fill(0); }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}
