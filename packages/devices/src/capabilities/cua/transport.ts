import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { JsonValue } from "@dexter/contracts";
import { DeviceError } from "../../errors.js";

/**
 * Version of the daemon <-> CUA helper line protocol. 2 added `check`, `cancel_consent`, the consent prompt
 * deadline (`promptSeconds` / `promptExpiresAt`, `consent_expired`) and the `lock_state_unknown` refusal.
 */
export const CUA_PROTOCOL_VERSION = 2;
export const MAX_HELPER_LINE_BYTES = 64 * 1024;

export class CuaTransportError extends Error {
  constructor(readonly code: "closed" | "aborted" | "protocol") {
    super(code);
    this.name = "CuaTransportError";
  }
}

/**
 * Request/response plus events with the local CUA helper. The helper owns the operator-facing parts
 * (consent, indicator, stop/takeover, lock and permission checks) and refuses on its own; the daemon side
 * never bypasses it. Messages are JSON objects, one per line, each tagged with the protocol version.
 */
export interface CuaTransport {
  readonly alive: boolean;
  request(message: Record<string, JsonValue>, signal: AbortSignal): Promise<Record<string, unknown>>;
  onEvent(listener: (event: Record<string, unknown>) => void): () => void;
  onExit(listener: () => void): void;
  close(timeoutMs: number): Promise<void>;
  kill(): void;
}

export interface CuaHelperOptions {
  /** Absolute path of the built `dexter-cua-helper` chosen by the operator (trusted configuration). */
  executable: string;
  /** `fixture` runs the helper's deterministic fixture backend: no Accessibility, screen or input APIs. */
  mode: "native" | "fixture";
}

/** Spawns the native helper with no shell, an empty environment and stderr discarded. */
export class CuaHelperProcess implements CuaTransport {
  readonly #child: ChildProcess;
  #alive = true;
  #nextId = 0;
  #buffer = "";
  readonly #pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: CuaTransportError) => void }>();
  readonly #listeners = new Set<(event: Record<string, unknown>) => void>();
  readonly #exitListeners = new Set<() => void>();
  readonly exited: Promise<void>;

  constructor(options: CuaHelperOptions) {
    checkExecutable(options.executable);
    this.#child = spawn(options.executable, options.mode === "fixture" ? ["--fixture"] : [], {
      env: {}, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    });
    this.exited = new Promise<void>((resolve) => {
      const done = (): void => { this.shutdown(); resolve(); };
      this.#child.once("exit", done);
      this.#child.once("error", done);
    });
    this.#child.stdout!.setEncoding("utf8");
    this.#child.stdout!.on("data", (chunk: string) => { this.onData(chunk); });
    this.#child.stdin!.on("error", () => { this.kill(); });
  }

  get alive(): boolean { return this.#alive; }

  request(message: Record<string, JsonValue>, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.#alive) return Promise.reject(new CuaTransportError("closed"));
    if (signal.aborted) return Promise.reject(new CuaTransportError("aborted"));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => { this.#pending.delete(id); reject(new CuaTransportError("aborted")); };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
        reject: (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
      });
      this.#child.stdin!.write(`${JSON.stringify({ ...message, v: CUA_PROTOCOL_VERSION, id })}\n`);
    });
  }
  onEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  onExit(listener: () => void): void {
    if (!this.#alive) { listener(); return; }
    this.#exitListeners.add(listener);
  }
  /** Closing stdin asks the helper to end every session and exit; it is killed after `timeoutMs`. */
  async close(timeoutMs: number): Promise<void> {
    if (!this.#alive) return;
    this.#child.stdin!.end();
    let timer: NodeJS.Timeout | undefined;
    const exited = await Promise.race([this.exited.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => { r(false); }, timeoutMs); })]);
    clearTimeout(timer);
    if (!exited) { this.kill(); await this.exited; }
  }
  kill(): void {
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      try { this.#child.kill("SIGKILL"); } catch { /* gone */ }
    }
    this.shutdown();
  }

  private shutdown(): void {
    if (!this.#alive) return;
    this.#alive = false;
    for (const pending of this.#pending.values()) pending.reject(new CuaTransportError("closed"));
    this.#pending.clear();
    for (const listener of [...this.#exitListeners]) listener();
    this.#exitListeners.clear();
  }
  private onData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const end = this.#buffer.indexOf("\n");
      if (end < 0) break;
      const line = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_HELPER_LINE_BYTES) { this.kill(); return; }
      let message: unknown;
      try { message = JSON.parse(line); } catch { this.kill(); return; }
      if (message === null || typeof message !== "object" || Array.isArray(message)) { this.kill(); return; }
      const m = message as Record<string, unknown>;
      if (m.v !== CUA_PROTOCOL_VERSION) { this.kill(); return; }
      if (typeof m.id === "number") {
        const pending = this.#pending.get(m.id);
        if (pending) { this.#pending.delete(m.id); pending.resolve(m); }
      } else if (typeof m.event === "string") {
        for (const listener of [...this.#listeners]) listener(m);
      }
    }
    if (Buffer.byteLength(this.#buffer) > MAX_HELPER_LINE_BYTES) this.kill();
  }
}

export function checkExecutable(path: string): void {
  if (!isAbsolute(path)) throw new DeviceError("invalid_input", "helper executable must be absolute");
  let stat;
  try { stat = lstatSync(path); } catch { throw new DeviceError("not_found", "helper executable not found"); }
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) {
    throw new DeviceError("forbidden", "helper executable refused");
  }
}
