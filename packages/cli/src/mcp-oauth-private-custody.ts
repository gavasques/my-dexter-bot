import { fstatSync } from "node:fs";
import type { McpOAuthCustodyChannel, McpOAuthCustodyRequest } from "@dexter/connectors";

/**
 * App-owned private channel for durable native MCP OAuth custody (UX-P1-10). Request lines go to the launcher's own
 * stdout pipe; result frames come back on the inherited private stdin pipe (`bindBrowserUsePrivateInput`). Never HTTP,
 * a TTY, a file, argv or env. Fixed failures only; token values are never logged or echoed.
 *
 * The app opens the channel (`open` frame) only after it has parsed the ready object, so no request line can ever share
 * a read with ready; without that frame (an app without custody) nothing is written and durability stays unverified.
 */
export const MCP_OAUTH_CUSTODY_REQUEST_SCHEMA = "dexter.mcp-oauth-custody-request/1";
export const MCP_OAUTH_CUSTODY_RESULT_SCHEMA = "dexter.mcp-oauth-custody-result/1";
export const MCP_OAUTH_CUSTODY_OPEN_SCHEMA = "dexter.mcp-oauth-custody-open/1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_LINE = 16_000;
const MAX_PENDING = 8;

/** stdout must be a pipe/socket owned by this user (the app's own launcher), never a terminal or a file. */
export function privateOutputIsOwnedPipe(fd = 1): boolean {
  try {
    const stat = fstatSync(fd);
    return Boolean(process.getuid) && stat.uid === process.getuid!() && (stat.isFIFO() || stat.isSocket());
  } catch { return false; }
}

export class AppPrivateMcpOAuthCustodyChannel implements McpOAuthCustodyChannel {
  #attached: { hostID: string; write: (line: string) => void; onOpen: () => void } | null = null;
  #open = false;
  #closed = false;
  readonly #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  /**
   * Binds the exact host identity, the launcher's line writer and the open callback once, after ready was written.
   * Nothing is written until the app's `open` frame for this host arrives.
   */
  arm(input: { hostID: string; write: (line: string) => void; onOpen: () => void }): void {
    if (this.#closed || this.#attached || typeof input.hostID !== "string" || input.hostID.length < 1 || input.hostID.length > 128
      || typeof input.write !== "function" || typeof input.onOpen !== "function") throw new Error("mcp oauth custody channel: refused");
    this.#attached = Object.freeze({ hostID: input.hostID, write: input.write, onOpen: input.onOpen });
  }
  get open(): boolean { return this.#attached !== null && this.#open && !this.#closed; }

  exchange(request: McpOAuthCustodyRequest, signal: AbortSignal): Promise<unknown> {
    const attached = this.#attached;
    if (!attached || !this.#open || this.#closed || !UUID.test(request.requestId) || this.#pending.has(request.requestId) || this.#pending.size >= MAX_PENDING || signal.aborted)
      return Promise.reject(new Error("mcp oauth custody channel: unavailable"));
    let line: string;
    try { line = JSON.stringify({ schema: MCP_OAUTH_CUSTODY_REQUEST_SCHEMA, hostID: attached.hostID, ...request }); }
    catch { return Promise.reject(new Error("mcp oauth custody channel: refused")); }
    if (Buffer.byteLength(line, "utf8") > MAX_LINE) return Promise.reject(new Error("mcp oauth custody channel: refused"));
    return new Promise<unknown>((resolve, reject) => {
      const abort = (): void => { if (this.#pending.delete(request.requestId)) reject(new Error("mcp oauth custody channel: timeout")); };
      signal.addEventListener("abort", abort, { once: true });
      this.#pending.set(request.requestId, {
        resolve: value => { signal.removeEventListener("abort", abort); resolve(value); },
        reject: error => { signal.removeEventListener("abort", abort); reject(error); },
      });
      try { attached.write(line); }
      catch { this.#pending.delete(request.requestId); signal.removeEventListener("abort", abort); reject(new Error("mcp oauth custody channel: unavailable")); }
    });
  }

  /**
   * One frame from the private stdin reader (already bounded and parsed): the app's single `open` for this host, or a
   * result for a pending request id. Anything else is ignored without echoing it.
   */
  frame(value: Record<string, unknown>): boolean {
    const attached = this.#attached;
    if (!attached || this.#closed || value.hostID !== attached.hostID) return false;
    if (value.schema === MCP_OAUTH_CUSTODY_OPEN_SCHEMA) {
      if (this.#open || Object.keys(value).sort().join() !== "hostID,schema") return false;
      this.#open = true;
      try { attached.onOpen(); } catch { /* the embedding reports durability itself */ }
      return true;
    }
    if (!this.#open || value.schema !== MCP_OAUTH_CUSTODY_RESULT_SCHEMA || typeof value.requestId !== "string" || !UUID.test(value.requestId)) return false;
    const pending = this.#pending.get(value.requestId);
    if (!pending) return false;
    this.#pending.delete(value.requestId);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (key !== "schema" && key !== "hostID") result[key] = item;
    pending.resolve(result);
    return true;
  }

  close(): void {
    this.#closed = true;
    for (const [id, pending] of this.#pending) { this.#pending.delete(id); pending.reject(new Error("mcp oauth custody channel: closed")); }
  }
}
