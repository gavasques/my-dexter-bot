import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";
import { inspect, TextDecoder, types } from "node:util";
import { checkCapabilities } from "./operations.js";
import { DeviceError, type DeviceErrorCode } from "./errors.js";
import { exact, FINGERPRINT, MAX_JOBS_PER_POLL, MAX_RECEIPTS_PER_POLL, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, parseJob, parseReceipt, wireId, ownerIdOf } from "./wire.js";

export type NativeDeviceRoute = "pair/claim" | "pair/status" | "device/poll" | "device/receipt";
export type NativeIdentityMode = "production" | "laboratory-native";
export type NativeIdentityPolicy = "secure_enclave_data_protection_keychain_device_only" | "cli_forwarding_laboratory_memory_only";
export interface NativeDeviceClientOptions {
  /** Trusted operator paths, never supplied by a job/engine/request. */
  executable: string;
  configPath: string;
  installationID: string;
  /** Explicit trusted operator choice. Laboratory requires marked helper config and literal loopback. */
  identityMode?: NativeIdentityMode;
}
export interface NativePublicIdentity { certificateDER: string; fingerprint: string; policy: NativeIdentityPolicy }
const POLICY = "secure_enclave_data_protection_keychain_device_only";
const LAB_POLICY = "cli_forwarding_laboratory_memory_only";
const ROUTES = new Set<string>(["pair/claim", "pair/status", "device/poll", "device/receipt"]);
const MAX_CONFIG = 32768, MAX_STDOUT = 360000, MAX_STDERR = 16384, MAX_ACTIVE = 16;
const wellFormed = (value: string): boolean => (value as string & { isWellFormed(): boolean }).isWellFormed();
const error = (code: DeviceErrorCode): DeviceError => new DeviceError(code, "native device helper refused");
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
interface Stamp { path: string; ino: number; dev: number; size: number; digest: string }

function canonical(value: string): string {
  try {
    if (typeof value !== "string" || value.length > 2048 || !isAbsolute(value) || normalize(value) !== value || /[\u0000-\u001f\u007f]/u.test(value) || realpathSync(value) !== value) throw error("forbidden");
    return value;
  } catch { throw error("forbidden"); }
}
function configBytes(path: string): { bytes: Buffer; stamp: Stamp } {
  let fd: number | undefined;
  try {
    canonical(path); const parent = lstatSync(dirname(path)), before = lstatSync(path);
    if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0 || !before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 || before.size < 1 || before.size > MAX_CONFIG) throw error("forbidden");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); const opened = fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw error("forbidden");
    const bytes = Buffer.alloc(before.size + 1); let n = 0;
    while (n < bytes.length) { const got = readSync(fd, bytes, n, bytes.length - n, null); if (!got) break; n += got; }
    const after = fstatSync(fd), named = lstatSync(path);
    if (n !== before.size || after.size !== before.size || named.ino !== before.ino || named.dev !== before.dev) throw error("forbidden");
    const bounded = bytes.subarray(0, n); return { bytes: bounded, stamp: { path, ino: before.ino, dev: before.dev, size: before.size, digest: sha(bounded) } };
  } catch (e) { throw e instanceof DeviceError ? e : error("forbidden"); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function executableStamp(path: string): Stamp {
  try {
    canonical(path); const s = lstatSync(path), parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0 || !s.isFile() || (s.mode & 0o100) === 0 || (s.mode & 0o077) !== 0 || s.uid !== process.getuid?.() || s.size < 1 || s.size > 64 * 1024 * 1024) throw error("forbidden");
    // Operator-installed executable is trusted. Inode/mtime/size freeze detects replacement without reading executable contents.
    return { path, ino: s.ino, dev: s.dev, size: s.size, digest: `${s.mtimeMs}:${s.ctimeMs}` };
  } catch { throw error("forbidden"); }
}
function same(a: Stamp, b: Stamp): boolean { return a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.digest === b.digest; }
function strictBase64(value: unknown, maximum: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw error("protocol_error");
  const bytes = Buffer.from(value, "base64"); if (bytes.length > maximum || bytes.toString("base64") !== value) throw error("protocol_error"); return bytes;
}
function json(bytes: Uint8Array): unknown { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { throw error("protocol_error"); } }
function helperExact(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  try { return exact(value, required, optional); } catch { throw error("protocol_error"); }
}
/** Snapshot plain JSON without invoking toJSON/getters. Size/depth/work bounds precede encoding/spawn. */
function bodyBytes(body: object): Buffer {
  let budget = MAX_REQUEST_BYTES, nodes = 0; const seen = new Set<object>();
  function snapshot(v: unknown, depth: number): unknown {
    if (++nodes > 8192 || depth > 32 || budget < 0) throw error("invalid_input");
    if (v === null || typeof v === "boolean") { budget -= 5; return v; }
    if (typeof v === "number" && Number.isFinite(v)) { budget -= 24; return v; }
    if (typeof v === "string" && v.length <= MAX_REQUEST_BYTES && wellFormed(v)) { budget -= Buffer.byteLength(v) + 2; if (budget < 0) throw error("invalid_input"); return v; }
    if (typeof v !== "object" || v === null || types.isProxy(v) || seen.has(v)) throw error("invalid_input");
    if (Array.isArray(v) && v.length > 1024) throw error("invalid_input");
    const proto = Object.getPrototypeOf(v); if (Array.isArray(v) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw error("invalid_input");
    seen.add(v); const descriptors = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(descriptors);
    if (keys.length > 1025) throw error("invalid_input");
    if (Array.isArray(v) && keys.length !== v.length + 1) throw error("invalid_input");
    const out: unknown[] | Record<string, unknown> = Array.isArray(v) ? [] : Object.create(null);
    for (const key of keys) {
      if (Array.isArray(v) && key === "length") continue;
      if (typeof key !== "string" || (key.length > MAX_REQUEST_BYTES || !wellFormed(key)) || !descriptors[key]!.enumerable || !("value" in descriptors[key]!)) throw error("invalid_input");
      if (Array.isArray(v) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= v.length)) throw error("invalid_input");
      budget -= Buffer.byteLength(key) + 4; Object.defineProperty(out, key, { value: snapshot(descriptors[key]!.value, depth + 1), enumerable: true, configurable: true, writable: true });
    }
    if (Array.isArray(v) && out.length !== v.length) throw error("invalid_input");
    seen.delete(v); return out;
  }
  try {
    const value = snapshot(body, 0); exact(value, Object.keys(value as object));
    const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > MAX_REQUEST_BYTES) throw error("invalid_input"); return bytes;
  } catch { throw error("invalid_input"); }
}
function response(route: NativeDeviceRoute, bytes: Buffer): Record<string, unknown> {
  const raw = json(bytes);
  try {
    if (route === "pair/claim") { const v = exact(raw, ["claimId", "status"]); if (v.status !== "pending") throw error("protocol_error"); wireId(v.claimId); return v; }
    if (route === "pair/status") {
      const v = exact(raw, ["status", "deviceId", "installationId", "ownerId"]);
      if (v.status === "approved") { wireId(v.deviceId); wireId(v.installationId); ownerIdOf(v.ownerId); }
      else if (!["pending", "rejected", "expired", "failed"].includes(v.status as string) || v.deviceId !== null || v.installationId !== null || v.ownerId !== null) throw error("protocol_error");
      return v;
    }
    if (route === "device/poll") { const v = exact(raw, ["jobs"]); if (!Array.isArray(v.jobs) || v.jobs.length > MAX_JOBS_PER_POLL) throw error("protocol_error"); v.jobs = v.jobs.map(parseJob); return v; }
    const v = exact(raw, ["ack"]); if (v.ack !== true) throw error("protocol_error"); return v;
  } catch { throw error("protocol_error"); }
}
function request(route: NativeDeviceRoute, bytes: Buffer, installationID: string): void {
  const raw = json(bytes);
  try {
    if (route === "pair/claim") {
      const v = exact(raw, ["offerId", "code", "name", "platform", "capabilities"]); wireId(v.offerId);
      if (typeof v.code !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(v.code) || typeof v.name !== "string" || v.name.length < 1 || v.name.length > 48 || /[\u0000-\u001f\u007f]/.test(v.name) || v.platform !== "macos" || !Array.isArray(v.capabilities) || v.capabilities.length < 1 || v.capabilities.length > 32 || checkCapabilities(v.capabilities as string[]).length !== v.capabilities.length) throw error("invalid_input");
    } else if (route === "pair/status") { wireId(exact(raw, ["claimId"]).claimId); }
    else {
      const v = exact(raw, route === "device/poll" ? ["deviceId", "installationId", "receipts"] : ["deviceId", "installationId", "receipt"]); wireId(v.deviceId);
      if (v.installationId !== installationID) throw error("forbidden");
      if (route === "device/poll") { if (!Array.isArray(v.receipts) || v.receipts.length > MAX_RECEIPTS_PER_POLL) throw error("invalid_input"); v.receipts.forEach(parseReceipt); }
      else parseReceipt(v.receipt);
    }
  } catch (e) { throw e instanceof DeviceError ? e : error("invalid_input"); }
}
interface Flight { cancel(): void; drained: Promise<void> }
/** Host-only bridge. No PEM, provision, rotation, arbitrary route/headers or automatic retries. */
export class NativeDeviceClient {
  readonly #executable: Stamp;
  readonly #config: Stamp;
  readonly #installationID: string;
  readonly #hostFingerprint: string;
  readonly #expectedPolicy: NativeIdentityPolicy;
  readonly #flights = new Set<Flight>();
  #closed = false;
  #close: Promise<void> | null = null;
  #identityFingerprint: string | null = null;
  constructor(options: NativeDeviceClientOptions) {
    try {
      const v = exact(options, ["executable", "configPath", "installationID"], ["identityMode"]); const installationID = wireId(v.installationID);
      if (v.identityMode !== undefined && v.identityMode !== "production" && v.identityMode !== "laboratory-native") throw error("invalid_input");
      const executable = executableStamp(v.executable as string), read = configBytes(v.configPath as string);
      const c = exact(json(read.bytes), ["installationID", "hostURL", "hostCertificateDER", "hostFingerprint"], ["laboratoryID"]);
      if (c.installationID !== installationID || (c.laboratoryID !== undefined && (typeof c.laboratoryID !== "string" || !/^[0-9a-f]{32}$/.test(c.laboratoryID)))) throw error("forbidden");
      const der = strictBase64(c.hostCertificateDER, 16384), cert = new X509Certificate(der);
      if (typeof c.hostFingerprint !== "string" || !FINGERPRINT.test(c.hostFingerprint) || sha(cert.raw) !== c.hostFingerprint || !cert.raw.equals(der)) throw error("tls_pin_mismatch");
      if (typeof c.hostURL !== "string" || c.hostURL.length > 2048 || /[\u0000-\u0020\u007f]/.test(c.hostURL)) throw error("invalid_input");
      const url = new URL(c.hostURL);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !url.hostname || (url.port && Number(url.port) === 0)) throw error("invalid_input");
      if (v.identityMode === "laboratory-native" && (c.laboratoryID === undefined || !/^https:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/.test(c.hostURL as string))) throw error("forbidden");
      this.#expectedPolicy = v.identityMode === "laboratory-native" ? LAB_POLICY : POLICY;
      this.#executable = executable; this.#config = read.stamp; this.#installationID = installationID; this.#hostFingerprint = c.hostFingerprint;
    } catch (e) { throw e instanceof DeviceError ? e : error("invalid_input"); }
  }
  toJSON(): object { return { installationID: this.#installationID, hostFingerprint: this.#hostFingerprint, closed: this.#closed, pending: this.#flights.size }; }
  [inspect.custom](): object { return this.toJSON(); }
  get pending(): number { return this.#flights.size; }
  /** Public pin from the trusted operator config; immutable and not selectable by a request. */
  get hostFingerprint(): string { return this.#hostFingerprint; }
  async loadOnly(timeoutMs = 30000, signal?: AbortSignal): Promise<NativePublicIdentity> {
    const out = await this.#run({ operation: "load" }, timeoutMs, signal, false);
    if (signal?.aborted || this.#closed) throw error("unavailable");
    try {
      const v = helperExact(out, ["ok", "certificateDER", "fingerprint", "policy"]), der = strictBase64(v.certificateDER, 16384), cert = new X509Certificate(der);
      if (v.ok !== true || v.policy !== this.#expectedPolicy || typeof v.fingerprint !== "string" || !FINGERPRINT.test(v.fingerprint) || sha(cert.raw) !== v.fingerprint || !cert.raw.equals(der)) throw error("protocol_error");
      if (this.#identityFingerprint !== null && this.#identityFingerprint !== v.fingerprint) throw error("conflict"); this.#identityFingerprint = v.fingerprint;
      return Object.freeze({ certificateDER: der.toString("base64"), fingerprint: v.fingerprint, policy: this.#expectedPolicy });
    } catch (e) { throw e instanceof DeviceError ? e : error("protocol_error"); }
  }
  async post(name: string, body: object, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!ROUTES.has(name)) throw error("invalid_input"); const route = name as NativeDeviceRoute, payload = bodyBytes(body); request(route, payload, this.#installationID);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw error("invalid_input");
    if (this.#identityFingerprint === null) throw error("unavailable");
    const out = await this.#run({ operation: "request", route: `/v1/${route}`, bodyBase64: payload.toString("base64"), timeoutSeconds: timeoutMs / 1000, expectedClientFingerprint: this.#identityFingerprint }, timeoutMs, signal, true);
    try { if (signal?.aborted || this.#closed) throw error("outcome_unknown"); const v = exact(out, ["ok", "responseBase64"]); if (v.ok !== true) throw error("protocol_error"); const parsed = response(route, strictBase64(v.responseBase64, MAX_RESPONSE_BYTES)); if (route === "pair/status" && parsed.status === "approved" && parsed.installationId !== this.#installationID) throw error("protocol_error"); return parsed; }
    catch { throw error("outcome_unknown"); }
  }
  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#closed = true; const flights = [...this.#flights]; for (const flight of flights) flight.cancel();
    this.#close = Promise.all(flights.map(f => f.drained)).then(() => undefined); return this.#close;
  }
  #run(command: object, timeoutMs: number, signal: AbortSignal | undefined, network: boolean): Promise<Record<string, unknown>> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) return Promise.reject(error("invalid_input"));
    if (signal?.aborted || this.#closed) return Promise.reject(error("unavailable"));
    if (this.#flights.size >= MAX_ACTIVE) return Promise.reject(error("unavailable"));
    try { if (!same(this.#config, configBytes(this.#config.path).stamp) || !same(this.#executable, executableStamp(this.#executable.path))) throw error("forbidden"); }
    catch (e) { return Promise.reject(e instanceof DeviceError ? e : error("forbidden")); }
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try { child = spawn(this.#executable.path, ["--config", this.#config.path], { shell: false, detached: true, env: {}, stdio: "pipe" }); }
      catch { reject(error("unavailable")); return; }
      let handedOff = false, failure: DeviceError | null = null, output = Buffer.alloc(0), stdoutBytes = 0, stderrBytes = 0, escalation: NodeJS.Timeout | null = null;
      let resolveDrain!: () => void; const drained = new Promise<void>(r => { resolveDrain = r; });
      const stop = (code: DeviceErrorCode): void => {
        if (!failure) failure = error(network && handedOff ? "outcome_unknown" : code);
        output = Buffer.alloc(0);
        if (escalation) return;
        const kill = (sig: NodeJS.Signals): void => { if (!child.pid || child.pid <= 1) return; try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* Exit event remains the only drain evidence. */ } } };
        kill("SIGTERM"); escalation = setTimeout(() => kill("SIGKILL"), 250);
      };
      const abort = (): void => stop("unavailable"), flight: Flight = { cancel: abort, drained }; this.#flights.add(flight);
      const deadline = setTimeout(() => stop("timeout"), timeoutMs); signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => { if (failure) return; stdoutBytes += chunk.length; if (stdoutBytes + stderrBytes > MAX_STDOUT + MAX_STDERR || stdoutBytes > MAX_STDOUT) stop("protocol_error"); else output = Buffer.concat([output, chunk]); });
      child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > MAX_STDERR || stderrBytes + stdoutBytes > MAX_STDOUT + MAX_STDERR) stop("protocol_error"); });
      child.on("error", () => stop("unavailable")); child.stdin.on("error", () => stop("unavailable"));
      child.once("close", (code, sig) => {
        clearTimeout(deadline); if (escalation) clearTimeout(escalation); signal?.removeEventListener("abort", abort); this.#flights.delete(flight); resolveDrain();
        if (failure) { reject(failure); return; }
        try {
          const out = helperExact(json(output), ["ok"], ["error", "responseBase64", "certificateDER", "fingerprint", "policy"]);
          if (out.ok === false) {
            helperExact(out, ["ok", "error"]); if (code !== 1 || sig !== null || typeof out.error !== "string") throw error("protocol_error");
            const fixed: Record<string, DeviceErrorCode> = { invalidInput: "invalid_input", missing: "not_found", conflict: "conflict", locked: "unavailable", nonExportabilityUnconfirmed: "unsupported", pinMismatch: "tls_pin_mismatch", invalid_input: "invalid_input", forbidden: "forbidden", not_found: "not_found", tls_pin_mismatch: "tls_pin_mismatch", unsupported: "unsupported", outcome_unknown: "outcome_unknown", protocolError: "protocol_error", protocol_error: "protocol_error", unavailable: "unavailable", timeout: "timeout", cancelled: "unavailable" };
            const mapped = Object.hasOwn(fixed, out.error) ? fixed[out.error] : undefined; if (!mapped) throw error("protocol_error");
            if (network && ["unavailable", "timeout", "cancelled", "protocolError", "protocol_error"].includes(out.error)) throw error("outcome_unknown");
            throw error(mapped);
          }
          if (out.ok !== true || code !== 0 || sig !== null) throw error("protocol_error"); resolve(out);
        } catch (e) { reject(e instanceof DeviceError && (!network || e.code !== "protocol_error") ? e : error(network ? "outcome_unknown" : "protocol_error")); }
      });
      if (signal?.aborted) abort();
      if (!failure) { handedOff = true; child.stdin.end(`${JSON.stringify(command)}\n`); } else child.stdin.destroy();
    });
  }
}
