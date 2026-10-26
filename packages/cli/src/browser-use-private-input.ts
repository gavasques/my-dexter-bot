import { fstatSync, readSync } from "node:fs";
import type { Readable } from "node:stream";
import { HostError } from "@dexter/hub";
import { CONNECTIONS_CAPABILITY_ACK_SCHEMA, CONNECTIONS_CAPABILITY_FRAME_SCHEMA } from "@dexter/contracts";
import type { ConnectionsCapabilityPrivateInput } from "./connections-private-custody.js";

const LIMIT = 16_384;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const refuse = (): never => { throw new HostError("invalid_input", "Private input is unavailable."); };

/** A pipe inherited from the app-owned parent only. Never accepts a file, TTY, URL or environment secret. */
export function assertBrowserUsePrivatePipe(fd = 0): void {
  const stat = fstatSync(fd);
  if (fd !== 0 || !process.getuid || stat.uid !== process.getuid() || !stat.isFIFO()) refuse();
}

/** Read exactly one bounded frame, without consuming the following key frames or requiring EOF.
 * The launcher writes this frame before spawning the child. Existing EOF-password mode is unchanged. */
export function readBrowserUseUnlockFrame(fd = 0): Buffer {
  assertBrowserUsePrivatePipe(fd);
  const bytes = Buffer.alloc(2048), unit = Buffer.alloc(1);
  try {
    let size = 0;
    while (size < bytes.length) {
      if (readSync(fd, unit, 0, 1, null) !== 1) refuse();
      if (unit[0] === 10) {
        let value: Record<string, unknown>;
        try { value = JSON.parse(bytes.subarray(0, size).toString("utf8")) as Record<string, unknown>; } catch { return refuse(); }
        if (!value || Object.keys(value).sort().join(",") !== "kind,passwordBase64,schema"
          || value.schema !== "dexter.private-input/1" || value.kind !== "unlock" || typeof value.passwordBase64 !== "string"
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.passwordBase64)) refuse();
        const password = Buffer.from(value.passwordBase64 as string, "base64");
        if (password.length < 16 || password.length > 1024 || password.toString("base64") !== value.passwordBase64) {
          password.fill(0); refuse();
        }
        return password;
      }
      bytes[size++] = unit[0]!;
    }
    return refuse();
  } finally { bytes.fill(0); unit.fill(0); }
}

export interface BrowserUsePrivateVault {
  set(key: string): void;
  lock(): Promise<void>;
}
export interface MemoryBackendPrivateInput {
  frame(value: unknown): Promise<'ready' | 'locked' | 'refused'>;
  close(): Promise<void>;
}
/** Durable native MCP OAuth custody (UX-P1-10): the app's open frame and its results. Never acknowledges with data. */
export interface McpOAuthCustodyPrivateInput {
  /** True only for the first open and for answers to pending host requests; those do not consume the frame budget. */
  frame(value: Record<string, unknown>): boolean;
}

/** The credential never crosses HTTP, argv, environment or disk. Only fixed public acknowledgements leave
 * this bridge. Host identity pins the command to the exact child; the app never adopts another listener. */
export function bindBrowserUsePrivateInput(input: Readable, hostID: string, vault: BrowserUsePrivateVault,
  write: (line: string) => void, memory?: MemoryBackendPrivateInput, oauthCustody?: McpOAuthCustodyPrivateInput,
  connections?: ConnectionsCapabilityPrivateInput): { close(): Promise<void> } {
  let pending = Buffer.alloc(0), closed = false, count = 0;
  let chain = Promise.resolve();
  const ack = (requestId: string, status: "ready" | "locked" | "refused"): void => {
    write(JSON.stringify({ schema: "dexter.browser-use-key-ack/1", requestId, hostID, status,
      ...(status === "refused" ? { code: "private_input_refused" } : {}) }));
  };
  const cut = (): void => { closed = true; input.off("data", data); input.pause(); pending.fill(0); pending = Buffer.alloc(0); };
  const disable = (): void => { cut(); void chain.then(async () => { await memory?.close(); await vault.lock(); }).catch(() => {}); };
  const frame = (bytes: Buffer): void => {
    let value: Record<string, unknown>;
    try { value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; } catch { bytes.fill(0); disable(); return; }
    bytes.fill(0);
    if (value && typeof value === 'object' && !Array.isArray(value)
      && (value.schema === 'dexter.mcp-oauth-custody-result/1' || value.schema === 'dexter.mcp-oauth-custody-open/1')) {
      // App open (after it parsed ready) or the answer to a host request: exact host and request id shape; token fields
      // are dropped from this object after use.
      if (value.hostID !== hostID || (value.schema === 'dexter.mcp-oauth-custody-result/1' && (typeof value.requestId !== 'string' || !ID.test(value.requestId)))) { disable(); return; }
      try { if (oauthCustody?.frame(value)) count--; } catch { /* fixed: the pending request times out as unavailable */ }
      finally { delete value.tokens; }
      return;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && value.schema === CONNECTIONS_CAPABILITY_FRAME_SCHEMA) {
      // Connections service capability (owner gesture or app custody restore): exact host and request id, fixed acknowledgement
      // only; the capability field is dropped from this object right after the vault decided.
      if (typeof value.requestId !== 'string' || !ID.test(value.requestId) || value.hostID !== hostID) { delete value.capability; disable(); return; }
      const requestId = value.requestId;
      chain = chain.then(() => {
        if (closed) return;
        let status: 'ready' | 'locked' | 'refused' = 'refused';
        try { if (connections) status = connections.frame(value); } catch { /* fixed acknowledgement only */ }
        finally { delete value.capability; }
        write(JSON.stringify({ schema: CONNECTIONS_CAPABILITY_ACK_SCHEMA, requestId, hostID, status,
          ...(status === 'refused' ? { code: 'private_input_refused' } : {}) }));
      });
      return;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && value.schema === 'dexter.memory-backend-key/1') {
      if (typeof value.requestId !== 'string' || !ID.test(value.requestId) || value.hostID !== hostID) { disable(); return; }
      const requestId = value.requestId;
      chain = chain.then(async () => {
        if (closed) return;
        let status: 'ready' | 'locked' | 'refused' = 'refused';
        try { if (memory) status = await memory.frame(value); } catch { /* fixed acknowledgement only */ }
        finally { delete value.administrativeKey; delete value.wrappingKeyBase64; }
        write(JSON.stringify({ schema: 'dexter.memory-backend-key-ack/1', requestId, hostID, status,
          ...(status === 'refused' ? { code: 'private_input_refused' } : {}) }));
      });
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schema !== "dexter.browser-use-key/1" || typeof value.requestId !== "string" || !ID.test(value.requestId)) { disable(); return; }
    const requestId = value.requestId, operation = value.operation;
    const keys = operation === "set" ? "hostID,key,operation,requestId,schema" : "hostID,operation,requestId,schema";
    if (Object.keys(value).sort().join(",") !== keys || value.hostID !== hostID || !["set", "lock"].includes(operation as string)
      || operation === "set" && (typeof value.key !== "string" || value.key.length < 16 || value.key.length > 4096 || /[\s\p{Cc}]/u.test(value.key))) {
      ack(requestId, "refused"); return;
    }
    chain = chain.then(async () => {
      if (closed) return;
      try {
        // An explicit human replacement first drains the previous credential generation.
        await vault.lock();
        if (closed) return;
        if (operation === "set") vault.set(value.key as string);
        ack(requestId, operation === "set" ? "ready" : "locked");
      } catch { ack(requestId, "refused"); }
      finally { delete value.key; }
    });
  };
  const data = (chunk: Buffer): void => {
    if (closed) return;
    if (!Buffer.isBuffer(chunk) || chunk.length > LIMIT || pending.length + chunk.length > LIMIT) { disable(); return; }
    const next = Buffer.concat([pending, chunk]); pending.fill(0); pending = next;
    let index: number;
    while ((index = pending.indexOf(10)) !== -1 && !closed) {
      if (++count > 128) { disable(); return; }
      const line = Buffer.from(pending.subarray(0, index));
      const rest = Buffer.from(pending.subarray(index + 1)); pending.fill(0); pending = rest; frame(line);
    }
  };
  input.on("data", data);
  const ended = disable;
  input.once("end", ended); input.once("error", ended);
  return { async close() { cut(); input.off("end", ended); input.off("error", ended); await chain; await memory?.close(); await vault.lock(); } };
}
