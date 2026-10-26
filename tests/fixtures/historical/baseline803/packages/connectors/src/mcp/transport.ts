import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { deserializeMessage, serializeMessage, type FetchLike as SdkFetchLike, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client";
import { McpConnectorError } from "./errors.js";

export interface StdioLaunch {
  command: string;
  args: readonly string[];
  cwd: string;
  /** The child's complete environment. Nothing of this process's environment is added. */
  env: Readonly<Record<string, string>>;
  /** Bound of one newline-delimited JSON-RPC message. */
  maxMessageBytes: number;
}

const KILL_GRACE_MS = 1_000;
const EXIT_WAIT_MS = 2_000;

/**
 * Stdio transport for one local MCP server, used instead of the SDK's stdio transport so that the child gets
 * exactly the environment the definition names (the SDK always adds HOME, PATH, USER and others from this
 * process) and so that close() ends the whole process group (npx/uvx launchers leave grandchildren otherwise).
 *
 * The child is a process-group leader: close() sends SIGTERM to the group, then SIGKILL after a grace period.
 * stderr is drained and discarded unread; it is never logged or returned. A line over `maxMessageBytes`
 * closes the transport. A line that is not JSON-RPC is reported through onerror (fixed error) and skipped.
 */
export class BoundedStdioTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: (<T extends JSONRPCMessage>(message: T) => void) | undefined;

  private child: ChildProcessWithoutNullStreams | null = null;
  private chunks: Buffer[] = [];
  private pending = 0;
  private exited: Promise<void> | null = null;
  private closing = false;
  private closedNotified = false;

  constructor(private readonly launch: StdioLaunch) {}

  /** Process id of the group leader while running (tests use it to prove cleanup). */
  get pid(): number | null { return this.child?.pid ?? null; }

  start(): Promise<void> {
    if (this.child) throw new McpConnectorError("transport_failed", "already_started");
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.launch.command, [...this.launch.args], {
          cwd: this.launch.cwd, env: { ...this.launch.env }, stdio: ["pipe", "pipe", "pipe"], detached: true, shell: false, windowsHide: true,
        });
      } catch {
        reject(new McpConnectorError("spawn_failed"));
        return;
      }
      this.child = child;
      this.exited = new Promise((done) => child.once("close", () => done()));
      child.once("error", () => {
        // The error names the command path; it is replaced by a fixed one.
        if (child.pid === undefined) reject(new McpConnectorError("spawn_failed"));
        else this.onerror?.(new McpConnectorError("transport_failed"));
      });
      child.once("spawn", () => resolve());
      child.once("exit", () => this.notifyClosed());
      child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
      child.stderr.on("data", () => { /* drained and discarded */ });
      child.stdin.on("error", () => { /* EPIPE after exit: the close path reports it */ });
    });
  }

  private read(chunk: Buffer): void {
    let start = 0;
    for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, start)) {
      this.push(chunk.subarray(start, i));
      if (this.closing) return;
      const line = Buffer.concat(this.chunks).toString("utf8").replace(/\r$/, "");
      this.chunks = [];
      this.pending = 0;
      start = i + 1;
      if (line.trim() === "") continue;
      let message: JSONRPCMessage;
      try { message = deserializeMessage(line); } catch {
        this.onerror?.(new McpConnectorError("response_invalid"));
        continue;
      }
      this.onmessage?.(message);
    }
    if (start < chunk.length) this.push(chunk.subarray(start));
  }
  private push(part: Buffer): void {
    this.pending += part.length;
    if (this.pending > this.launch.maxMessageBytes) {
      this.chunks = [];
      this.pending = 0;
      this.onerror?.(new McpConnectorError("response_too_large"));
      void this.close();
      return;
    }
    this.chunks.push(Buffer.from(part));
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    if (!child || this.closing || child.exitCode !== null || child.signalCode !== null) throw new McpConnectorError("closed");
    const data = serializeMessage(message);
    await new Promise<void>((resolve, reject) => {
      const ok = child.stdin.write(data, (error) => { if (error) reject(new McpConnectorError("transport_failed")); });
      if (ok) resolve(); else child.stdin.once("drain", () => resolve());
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child || this.closing) { await this.exited; return; }
    this.closing = true;
    try { child.stdin.end(); } catch { /* already closed */ }
    const running = (): boolean => child.exitCode === null && child.signalCode === null;
    const group = (signal: NodeJS.Signals): void => {
      try { if (child.pid !== undefined) process.kill(-child.pid, signal); } catch { /* group already gone */ }
    };
    // The whole group, also after the leader exits: a launcher can leave its server child behind.
    group("SIGTERM");
    await Promise.race([this.exited, delay(KILL_GRACE_MS)]);
    group("SIGKILL");
    if (running()) await Promise.race([this.exited, delay(EXIT_WAIT_MS)]);
    this.chunks = [];
    this.notifyClosed();
  }

  private notifyClosed(): void {
    if (this.closedNotified) return;
    this.closedNotified = true;
    this.onclose?.();
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref());

export interface PinnedFetchOptions {
  /** Pinned endpoint. Every request must be on its origin. */
  endpoint: URL;
  /** Resolved headers (may carry credentials). Attached only to requests on the pinned origin. */
  headers: Readonly<Record<string, string>>;
  maxResponseBytes: number;
  fetch: typeof globalThis.fetch;
  /** Called when the server asks for authorization (401, or 403 with a Bearer challenge). */
  onAuthRequired: () => void;
}

/**
 * Fetch handed to the SDK's Streamable HTTP transport. It refuses any request off the pinned origin (OAuth
 * discovery included), never follows a redirect (so credentials can never be forwarded elsewhere), attaches
 * credential headers itself, and bounds every response body. Bodies of refused responses are discarded unread.
 */
export function pinnedFetch(options: PinnedFetchOptions): SdkFetchLike {
  const origin = options.endpoint.origin;
  return async (input, init) => {
    let url: URL;
    try { url = new URL(input instanceof URL ? input.href : String(input)); } catch { throw new McpConnectorError("origin_refused"); }
    if (url.origin !== origin || url.username || url.password) throw new McpConnectorError("origin_refused");
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(options.headers)) headers.set(name, value);
    let response: Response;
    try {
      response = await options.fetch(url.href, { ...init, headers, redirect: "manual", cache: "no-store", credentials: "omit" });
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      // The cause may echo the request; it is dropped.
      throw new McpConnectorError("transport_failed");
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await discard(response);
      throw new McpConnectorError("upstream_redirect", null, response.status || null);
    }
    if (response.url && new URL(response.url).origin !== origin) {
      await discard(response);
      throw new McpConnectorError("upstream_redirect");
    }
    if (response.status === 401 || (response.status === 403 && /bearer/i.test(response.headers.get("www-authenticate") ?? ""))) {
      options.onAuthRequired();
      await discard(response);
      throw new McpConnectorError("needs_auth", null, response.status);
    }
    const declared = Number(response.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > options.maxResponseBytes) {
      await discard(response);
      throw new McpConnectorError("response_too_large", null, response.status);
    }
    if (!response.body) return response;
    let total = 0;
    const max = options.maxResponseBytes;
    const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > max) controller.error(new McpConnectorError("response_too_large"));
        else controller.enqueue(chunk);
      },
    }));
    return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

async function discard(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* nothing to report */ }
}
