import type { Readable, Writable } from "node:stream";

/** Upper bound of one protocol message from the browser; larger frames close the connection. */
export const MAX_CDP_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_PENDING = 256;

export class CdpError extends Error {
  constructor(readonly code: "closed" | "timeout" | "aborted" | "protocol" | "remote") {
    super(code);
    this.name = "CdpError";
  }
}
export interface CdpEvent { method: string; params: Record<string, unknown>; sessionId: string | null }

/**
 * Chrome DevTools protocol over the browser's `--remote-debugging-pipe` file descriptors (3: to browser,
 * 4: from browser), NUL-framed JSON. There is no TCP endpoint: only the process that spawned the browser
 * holds the pipe. Callers of this module are the driver's own fixed methods; it is never exposed to a
 * job. Remote error text is dropped; only a fixed code is surfaced.
 */
export class CdpPipe {
  #nextId = 0;
  #buffer: Buffer = Buffer.alloc(0);
  #closed = false;
  readonly #pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: CdpError) => void }>();
  readonly #listeners = new Set<(event: CdpEvent) => void>();
  readonly #closeListeners = new Set<() => void>();

  constructor(private readonly toBrowser: Writable, fromBrowser: Readable) {
    fromBrowser.on("data", (chunk: Buffer) => { this.onData(chunk); });
    fromBrowser.on("end", () => { this.close(); });
    fromBrowser.on("error", () => { this.close(); });
    toBrowser.on("error", () => { this.close(); });
  }

  get closed(): boolean { return this.#closed; }

  send(method: string, params: Record<string, unknown> = {}, sessionId: string | null = null, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.#closed) return Promise.reject(new CdpError("closed"));
    if (signal?.aborted) return Promise.reject(new CdpError("aborted"));
    if (this.#pending.size >= MAX_PENDING) return Promise.reject(new CdpError("protocol"));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => { this.#pending.delete(id); reject(new CdpError("aborted")); };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (value) => { signal?.removeEventListener("abort", onAbort); resolve(value); },
        reject: (error) => { signal?.removeEventListener("abort", onAbort); reject(error); },
      });
      const frame = JSON.stringify(sessionId === null ? { id, method, params } : { id, method, params, sessionId });
      this.toBrowser.write(`${frame}\0`);
    });
  }
  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  onClose(listener: () => void): void {
    if (this.#closed) { listener(); return; }
    this.#closeListeners.add(listener);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(new CdpError("closed"));
    this.#pending.clear();
    this.#buffer = Buffer.alloc(0);
    try { this.toBrowser.end(); } catch { /* already closed */ }
    for (const listener of [...this.#closeListeners]) listener();
    this.#closeListeners.clear();
    this.#listeners.clear();
  }

  private onData(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const end = this.#buffer.indexOf(0);
      if (end < 0) break;
      const frame = this.#buffer.subarray(0, end);
      this.#buffer = this.#buffer.subarray(end + 1);
      this.dispatch(frame);
      if (this.#closed) return;
    }
    if (this.#buffer.length > MAX_CDP_MESSAGE_BYTES) this.close();
  }
  private dispatch(frame: Buffer): void {
    if (frame.length > MAX_CDP_MESSAGE_BYTES) { this.close(); return; }
    let message: unknown;
    try { message = JSON.parse(frame.toString("utf8")); } catch { this.close(); return; }
    if (message === null || typeof message !== "object" || Array.isArray(message)) { this.close(); return; }
    const m = message as Record<string, unknown>;
    if (typeof m.id === "number") {
      const pending = this.#pending.get(m.id);
      if (!pending) return;
      this.#pending.delete(m.id);
      if (m.error !== undefined) pending.reject(new CdpError("remote"));
      else pending.resolve(m.result !== null && typeof m.result === "object" && !Array.isArray(m.result) ? m.result as Record<string, unknown> : {});
      return;
    }
    if (typeof m.method !== "string") return;
    const params = m.params !== null && typeof m.params === "object" && !Array.isArray(m.params) ? m.params as Record<string, unknown> : {};
    const event: CdpEvent = { method: m.method, params, sessionId: typeof m.sessionId === "string" ? m.sessionId : null };
    for (const listener of [...this.#listeners]) listener(event);
  }
}
