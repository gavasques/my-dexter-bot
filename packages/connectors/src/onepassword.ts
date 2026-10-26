import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { CredentialBroker, InjectedAuth } from "@dexter/gateway";
import { ConnectorError, type ConnectorErrorCode } from "./errors.js";

/** Reads one pinned 1Password secret reference. Only trusted broker code calls it, never with a model-supplied ref. */
export interface SecretReader {
  read(ref: string, signal: AbortSignal): Promise<string>;
}

const SEGMENT = /^[A-Za-z0-9_.-](?:[A-Za-z0-9 _.-]{0,126}[A-Za-z0-9_.-])?$/;
const MAX_REF = 512;

/**
 * Accepts `op://<vault>/<item>/[<section>/]<field>` with the documented character set (alphanumerics, `-`, `_`,
 * `.`, inner spaces). Query parameters (`?attribute=`, `?ssh-format=`), `$VARIABLES`, `..` and empty segments
 * are refused: a binding names exactly one field value, fixed by the host.
 */
export function checkOpRef(ref: unknown): string {
  if (typeof ref !== "string" || ref.length > MAX_REF || !ref.startsWith("op://")) throw new ConnectorError("invalid_config");
  const segments = ref.slice("op://".length).split("/");
  if (segments.length < 3 || segments.length > 4) throw new ConnectorError("invalid_config");
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment === "." || segment === "..") throw new ConnectorError("invalid_config");
  }
  return ref;
}

export interface OpCliReaderOptions {
  /** Absolute path of the official `op` binary. No PATH lookup, no shell. */
  command: string;
  /**
   * Complete environment of the child, from trusted configuration only (e.g. a future service-account token
   * or desktop-integration variables). The host process environment is never inherited.
   */
  env?: Readonly<Record<string, string>>;
  /** Optional `--account` (shorthand, sign-in address or id), trusted configuration. */
  account?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  killGraceMs?: number;
}

/**
 * Runs `op read --no-newline <ref>` as a direct child in its own process group. Output is bounded, stderr is
 * counted and discarded (it may echo the reference or the value), and every failure is a fixed code. On timeout,
 * abort, overflow or exit the whole process group is killed, so descendants cannot outlive the read.
 */
export class OpCliSecretReader implements SecretReader {
  private readonly command: string;
  private readonly env: Readonly<Record<string, string>>;
  private readonly prefix: readonly string[];
  private readonly timeoutMs: number;
  private readonly maxStdout: number;
  private readonly maxStderr: number;
  private readonly killGraceMs: number;

  constructor(options: OpCliReaderOptions) {
    if (typeof options.command !== "string" || !isAbsolute(options.command) || options.command.includes("\0")) throw new ConnectorError("invalid_config");
    const env = options.env ?? {};
    for (const [name, value] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || typeof value !== "string" || value.includes("\0")) throw new ConnectorError("invalid_config");
    }
    if (options.account !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,254}$/.test(options.account)) throw new ConnectorError("invalid_config");
    const int = (value: number | undefined, fallback: number, max: number): number => {
      const v = value ?? fallback;
      if (!Number.isSafeInteger(v) || v < 1 || v > max) throw new ConnectorError("invalid_config");
      return v;
    };
    this.command = options.command;
    this.env = Object.freeze({ ...env });
    this.prefix = Object.freeze(options.account === undefined ? [] : ["--account", options.account]);
    this.timeoutMs = int(options.timeoutMs, 15_000, 120_000);
    this.maxStdout = int(options.maxStdoutBytes, 16 * 1024, 1024 * 1024);
    this.maxStderr = int(options.maxStderrBytes, 16 * 1024, 1024 * 1024);
    this.killGraceMs = int(options.killGraceMs, 500, 10_000);
  }

  read(ref: string, signal: AbortSignal): Promise<string> {
    try { checkOpRef(ref); } catch (error) { return Promise.reject(error); }
    if (signal.aborted) return Promise.reject(new ConnectorError("op_aborted"));
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.command, [...this.prefix, "read", "--no-newline", ref], {
          shell: false, env: { ...this.env }, stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true,
        });
      } catch {
        reject(new ConnectorError("op_spawn_failed"));
        return;
      }
      const chunks: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let reason: ConnectorErrorCode | null = null;
      let settled = false;
      const group = (sig: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        try { process.kill(-child.pid, sig); } catch { /* group already gone */ }
      };
      const wipe = (): void => { for (const c of chunks) c.fill(0); chunks.length = 0; };
      const stop = (code: ConnectorErrorCode): void => {
        reason ??= code;
        wipe();
        group("SIGTERM");
        setTimeout(() => group("SIGKILL"), this.killGraceMs).unref();
      };
      const timer = setTimeout(() => stop("op_timeout"), this.timeoutMs);
      const onAbort = (): void => stop("op_aborted");
      signal.addEventListener("abort", onAbort, { once: true });
      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        group("SIGKILL");
        if (reason !== null) { wipe(); reject(new ConnectorError(reason)); return; }
        if (exitCode !== 0) { wipe(); reject(new ConnectorError("op_failed")); return; }
        const bytes = Buffer.concat(chunks);
        wipe();
        let value: string;
        try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { bytes.fill(0); reject(new ConnectorError("op_value_refused")); return; }
        bytes.fill(0);
        resolve(value);
      };
      child.stdout!.on("data", (chunk: Buffer) => {
        if (reason !== null) { chunk.fill(0); return; }
        outBytes += chunk.length;
        if (outBytes > this.maxStdout) { chunk.fill(0); stop("op_output_too_large"); return; }
        chunks.push(chunk);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        errBytes += chunk.length;
        chunk.fill(0);
        if (errBytes > this.maxStderr) stop("op_output_too_large");
      });
      // Once `op` exits, kill whatever it left behind so a descendant holding the pipes cannot stall the read.
      child.on("exit", () => group("SIGKILL"));
      child.on("error", () => { reason ??= "op_spawn_failed"; finish(null); });
      child.on("close", (code) => finish(code));
    });
  }
}

export interface OnePasswordBinding {
  /** Broker key referenced by gateway connections (Connection.credentialRef). */
  credentialRef: string;
  /** Pinned 1Password secret reference. Never shown to engines; never chosen by a call. */
  opRef: string;
  /** Header the value is injected into, e.g. `x-api-key`. */
  header: string;
  /** Optional auth scheme prefix (`Bearer <value>`). */
  scheme?: "Bearer" | "Basic" | "Token";
  /** Hosts this credential may be released for. */
  allowedHosts: readonly string[];
}
export interface OnePasswordBrokerOptions {
  reader: SecretReader;
  bindings: readonly OnePasswordBinding[];
  /** In-memory lifetime of a warmed value. Default 10 minutes, max 1 hour. */
  ttlMs?: number;
  now?: () => number;
}
export interface WarmResult { credentialRef: string; ok: boolean; code: ConnectorErrorCode | null }
export interface CredentialStatus { credentialRef: string; state: "cold" | "warm" | "expired" | "revoked"; expiresAt: number | null }

const HEADER = /^[a-z0-9-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set(["host", "content-type", "content-length", "accept", "connection", "transfer-encoding", "cookie", "origin", "referer"]);
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const REF_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_VALUE = 8192;
/** Printable ASCII only: a value must fit a single HTTP header line. */
const VALUE = /^[!-~](?:[ -~]*[!-~])?$/;

interface Binding { credentialRef: string; opRef: string; header: string; scheme: string | null; allowedHosts: ReadonlySet<string> }
interface Cached { value: string; expiresAt: number }

/**
 * Host-only 1Password credential broker. Values are read asynchronously during an admin/preload phase
 * (`warm`), kept only in process memory with a TTL, de-duplicated per reference while in flight, and never
 * written to disk. `acquire` stays synchronous and fails closed (null) when a value is cold, expired or
 * revoked, so a grant check and the dispatch that follows it never straddle an asynchronous read.
 *
 * Engines never see this class: they receive only the authorized operation's result. There is no API that
 * reads an arbitrary reference; bindings are fixed at construction.
 */
export class OnePasswordBroker implements CredentialBroker {
  private readonly reader: SecretReader;
  private readonly bindings: ReadonlyMap<string, Binding>;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<WarmResult>>();
  private readonly generation = new Map<string, number>();
  private readonly revoked = new Set<string>();

  constructor(options: OnePasswordBrokerOptions) {
    if (typeof options.reader?.read !== "function") throw new ConnectorError("invalid_config");
    const ttl = options.ttlMs ?? 10 * 60_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 60 * 60_000) throw new ConnectorError("invalid_config");
    const bindings = new Map<string, Binding>();
    for (const b of options.bindings) {
      if (typeof b.credentialRef !== "string" || !REF_KEY.test(b.credentialRef) || bindings.has(b.credentialRef)) throw new ConnectorError("invalid_config");
      if (typeof b.header !== "string" || !HEADER.test(b.header) || FORBIDDEN_HEADERS.has(b.header)) throw new ConnectorError("invalid_config");
      if (b.scheme !== undefined && !["Bearer", "Basic", "Token"].includes(b.scheme)) throw new ConnectorError("invalid_config");
      if (!Array.isArray(b.allowedHosts) || b.allowedHosts.length === 0 || !b.allowedHosts.every((h) => typeof h === "string" && HOST.test(h))) throw new ConnectorError("invalid_config");
      bindings.set(b.credentialRef, Object.freeze({
        credentialRef: b.credentialRef, opRef: checkOpRef(b.opRef), header: b.header, scheme: b.scheme ?? null,
        allowedHosts: new Set(b.allowedHosts),
      }));
    }
    this.reader = options.reader;
    this.bindings = bindings;
    this.ttlMs = ttl;
    this.now = options.now ?? Date.now;
  }

  /**
   * Admin/preload phase: reads the given bindings (default: all) and caches them for the TTL. Concurrent warms
   * of one reference share a single read. Failures never throw and never carry detail beyond a fixed code; a
   * failed refresh drops the previous value (fail closed).
   */
  async warm(credentialRefs?: readonly string[], options: { signal?: AbortSignal } = {}): Promise<WarmResult[]> {
    const refs = credentialRefs ?? [...this.bindings.keys()];
    return Promise.all(refs.map((ref) => this.warmOne(ref, options.signal)));
  }

  acquire(ref: string, host: string): InjectedAuth | null {
    const binding = typeof ref === "string" ? this.bindings.get(ref) : undefined;
    if (!binding || this.revoked.has(ref) || typeof host !== "string" || !binding.allowedHosts.has(host)) return null;
    const cached = this.cache.get(ref);
    if (!cached || this.now() >= cached.expiresAt) return null;
    const value = binding.scheme ? `${binding.scheme} ${cached.value}` : cached.value;
    return Object.freeze({ headers: Object.freeze({ [binding.header]: value }) });
  }

  /** Irreversible for this broker instance: drops the value and refuses later warms, including in-flight ones. */
  revoke(ref: string): void {
    if (!this.bindings.has(ref)) return;
    this.revoked.add(ref);
    this.bump(ref);
    this.cache.delete(ref);
  }
  /** Drops every cached value (e.g. on lock or shutdown). In-flight reads are discarded on arrival. */
  clear(): void {
    for (const ref of this.bindings.keys()) this.bump(ref);
    this.cache.clear();
  }

  /** Every cached value (and its header form), so the gateway can refuse it in arguments and scrub it from results. */
  secretValues(): readonly string[] {
    const out: string[] = [];
    for (const [ref, cached] of this.cache) {
      out.push(cached.value);
      const scheme = this.bindings.get(ref)?.scheme;
      if (scheme) out.push(`${scheme} ${cached.value}`);
    }
    return out;
  }

  /** Value-free status for the owner UI. */
  status(): CredentialStatus[] {
    const now = this.now();
    return [...this.bindings.keys()].map((credentialRef) => {
      if (this.revoked.has(credentialRef)) return { credentialRef, state: "revoked", expiresAt: null };
      const cached = this.cache.get(credentialRef);
      if (!cached) return { credentialRef, state: "cold", expiresAt: null };
      return { credentialRef, state: now >= cached.expiresAt ? "expired" : "warm", expiresAt: cached.expiresAt };
    });
  }

  private bump(ref: string): void {
    this.generation.set(ref, (this.generation.get(ref) ?? 0) + 1);
    this.inflight.delete(ref);
  }

  private warmOne(ref: string, signal: AbortSignal | undefined): Promise<WarmResult> {
    const binding = this.bindings.get(ref);
    if (!binding) return Promise.resolve({ credentialRef: String(ref), ok: false, code: "config_missing" });
    if (this.revoked.has(ref)) return Promise.resolve({ credentialRef: ref, ok: false, code: "credential_revoked" });
    const running = this.inflight.get(ref);
    if (running) return running;
    const generation = this.generation.get(ref) ?? 0;
    // Registered before the reader runs: the read starts on a later microtask, so even a reader that throws
    // synchronously settles after `task` is in the map and its cleanup (by identity) always finds it.
    const task: Promise<WarmResult> = Promise.resolve().then(async (): Promise<WarmResult> => {
      let code: ConnectorErrorCode | null = null;
      let value: string | null = null;
      try {
        value = await this.reader.read(binding.opRef, signal ?? new AbortController().signal);
        if (typeof value !== "string" || value.length === 0 || value.length > MAX_VALUE || !VALUE.test(value)) { value = null; code = "op_value_refused"; }
      } catch (error) {
        code = error instanceof ConnectorError ? error.code : "op_failed";
      } finally {
        if (this.inflight.get(ref) === task) this.inflight.delete(ref);
      }
      // Revoked or cleared while reading: the value is discarded, never cached.
      if ((this.generation.get(ref) ?? 0) !== generation || this.revoked.has(ref)) {
        return { credentialRef: ref, ok: false, code: this.revoked.has(ref) ? "credential_revoked" : "aborted" };
      }
      if (value === null) {
        this.cache.delete(ref);
        return { credentialRef: ref, ok: false, code: code ?? "op_failed" };
      }
      this.cache.set(ref, { value, expiresAt: this.now() + this.ttlMs });
      return { credentialRef: ref, ok: true, code: null };
    });
    this.inflight.set(ref, task);
    return task;
  }
}
