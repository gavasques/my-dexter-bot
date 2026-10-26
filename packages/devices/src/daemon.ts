import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Agent, request, type RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { join } from "node:path";
import type { PeerCertificate } from "node:tls";
import { inspect } from "node:util";
import { hashRequest } from "@dexter/hub";
import { DeviceError, type DeviceErrorCode } from "./errors.js";
import { privateDirectory, privateFile, type TlsIdentity } from "./files.js";
import { HandlerRefusal, type OperationHandler, type TrustedJobContext } from "./handlers.js";
import { DaemonJournal } from "./journal.js";
import { checkCapabilities, DEVICE_OPERATIONS } from "./operations.js";
import {
  DEVICE_PROTOCOL, FINGERPRINT, MAX_JOBS_PER_POLL, MAX_RECEIPTS_PER_POLL, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_RESULT_BYTES,
  boundedJson, certificateFingerprint, exact, fingerprintDer, ownerIdOf, parseJob, wireId, type DeviceJob, type DeviceReceipt,
} from "./wire.js";

/** Host pin obtained out of band (pairing bundle). The certificate is public; the pin must match it. */
export interface HostTrust { hostUrl: string; hostCertPem: string; hostFingerprint: string }
export interface DeviceBinding { installationId: string; ownerId: string; deviceId: string; hostFingerprint: string }

/** Trusted host code only. close must block admissions and confirm all local transport drain. */
export interface DeviceClientPort {
  post(name: string, body: object, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
export type TrustedClientSelection =
  | { identity: TlsIdentity; client?: never }
  | { client: DeviceClientPort; identity?: never };
function clientSelection(options: { identity?: TlsIdentity; client?: DeviceClientPort }): void {
  if ((options.identity !== undefined) === (options.client !== undefined)
    || (options.client !== undefined && (options.client === null || typeof options.client.post !== "function" || typeof options.client.close !== "function"))
    || (options.identity !== undefined && (options.identity === null || typeof options.identity.certPem !== "string" || typeof options.identity.keyPem !== "string"))) {
    throw new DeviceError("invalid_input", "select exactly one trusted client or identity");
  }
}
interface ClientFlight { cancel(): void; drained: Promise<void> }
/** One request, no connection/session cache. Capture allocation before Node's deferred req.socket. */
class RequestAgent extends Agent {
  constructor(private readonly capture: (socket: Duplex) => void) { super({ keepAlive: false, maxCachedSessions: 0 }); }
  override createConnection(options: RequestOptions, callback?: (err: Error | null, stream: Duplex) => void): Duplex | null | undefined {
    const socket = super.createConnection(options, callback);
    if (socket) this.capture(socket);
    return socket;
  }
}

export const BINDING_FILE = "binding.json";
const ERROR_CODES: ReadonlySet<string> = new Set<DeviceErrorCode>([
  "invalid_input", "forbidden", "not_found", "conflict", "unavailable", "timeout", "protocol_error", "unsupported", "outcome_unknown",
]);
const NETWORK_UNAVAILABLE = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EPIPE", "ETIMEDOUT", "EAI_AGAIN"]);
const delay = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(done, ms);
  function done(): void { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
  signal?.addEventListener("abort", done, { once: true });
});

/**
 * HTTPS client of the paired Mac: TLS 1.3 only, the device certificate as client credential, the host
 * certificate as the only CA and its SHA-256 pin checked in `checkServerIdentity`. No connection reuse
 * (a private one-request agent, session cache disabled), no redirects, one deadline for connect + headers + body, bounded
 * request and response, and fixed error codes that never carry peer text.
 */
export class DeviceClient implements DeviceClientPort {
  readonly #flights = new Set<ClientFlight>();
  #closed = false;
  #close: Promise<void> | null = null;
  readonly #identity: TlsIdentity;
  private readonly hostname: string;
  private readonly port: number;

  constructor(identity: TlsIdentity, readonly trust: HostTrust) {
    this.#identity = identity;
    if (!FINGERPRINT.test(trust.hostFingerprint) || certificateFingerprint(trust.hostCertPem) !== trust.hostFingerprint) {
      throw new DeviceError("tls_pin_mismatch", "host pin does not match the host certificate");
    }
    let url: URL;
    try { url = new URL(trust.hostUrl); } catch { throw new DeviceError("invalid_input", "invalid host url"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
      throw new DeviceError("invalid_input", "invalid host url");
    }
    this.hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    this.port = url.port === "" ? 443 : Number(url.port);
  }
  toJSON(): object { return { hostUrl: this.trust.hostUrl, hostFingerprint: this.trust.hostFingerprint }; }
  [inspect.custom](): object { return this.toJSON(); }

  post(name: string, body: object, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.#closed || signal?.aborted) return Promise.reject(new DeviceError("unavailable"));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return Promise.reject(new DeviceError("invalid_input"));
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    if (payload.length > MAX_REQUEST_BYTES) return Promise.reject(new DeviceError("invalid_input", "request too large"));
    // Legacy serialization may invoke trusted callbacks; recheck admission before allocating transport.
    if (this.#closed || signal?.aborted) return Promise.reject(new DeviceError("unavailable"));
    const pin = this.trust.hostFingerprint;
    const pinError = new Error("host pin mismatch");
    return new Promise((resolve, reject) => {
      let settled = false, requestClosed = false, socket: Duplex | null = null, socketClosed = false;
      let response: IncomingMessage | null = null, responseClosed = false;
      let resolveDrain!: () => void;
      const drained = new Promise<void>((r) => { resolveDrain = r; });
      const checkDrain = (): void => {
        if (!requestClosed || (socket !== null && !socketClosed) || (response !== null && !responseClosed)) return;
        agent.destroy(); this.#flights.delete(flight); resolveDrain();
      };
      const captureSocket = (value: Duplex): void => {
        if (socket === value) return;
        socket = value;
        // Cancellation can precede Node's socket handoff; errors stay observed during that interval.
        value.on("error", () => undefined);
        value.once("close", () => { socketClosed = true; checkDrain(); });
      };
      const agent = new RequestAgent(captureSocket);
      const finish = (error: DeviceError | null, value?: Record<string, unknown>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", onAbort);
        if (error) { req.destroy(); agent.destroy(); socket?.destroy(); reject(error); } else resolve(value!);
      };
      const req = request({
        protocol: "https:", hostname: this.hostname, port: this.port, method: "POST", path: `/${DEVICE_PROTOCOL}/${name}`,
        agent, ca: [this.trust.hostCertPem], cert: this.#identity.certPem, key: this.#identity.keyPem,
        minVersion: "TLSv1.3", maxVersion: "TLSv1.3", rejectUnauthorized: true,
        checkServerIdentity: (_host: string, cert: PeerCertificate) => (cert.raw && fingerprintDer(cert.raw) === pin ? undefined : pinError),
        headers: { "content-type": "application/json", "content-length": payload.length, accept: "application/json" },
      }, (res) => {
        const status = res.statusCode ?? 0;
        const type = res.headers["content-type"];
        if (typeof type !== "string" || type.split(";")[0]!.trim() !== "application/json") { finish(new DeviceError("protocol_error")); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) { finish(new DeviceError("protocol_error")); return; }
          chunks.push(chunk);
        });
        res.on("error", () => { finish(new DeviceError("unavailable")); });
        res.on("end", () => {
          let value: unknown;
          try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { finish(new DeviceError("protocol_error")); return; }
          if (value === null || typeof value !== "object" || Array.isArray(value)) { finish(new DeviceError("protocol_error")); return; }
          if (status === 200) { finish(null, value as Record<string, unknown>); return; }
          // Redirects and unknown statuses are never followed or interpreted.
          const code = (value as { error?: unknown }).error;
          finish(new DeviceError(status >= 400 && typeof code === "string" && ERROR_CODES.has(code) ? (code as DeviceErrorCode) : "protocol_error"));
        });
      });
      const onAbort = (): void => { finish(new DeviceError("unavailable")); };
      const flight: ClientFlight = { cancel: onAbort, drained };
      this.#flights.add(flight);
      req.once("close", () => { requestClosed = true; checkDrain(); });
      req.once("socket", (value: Socket) => {
        captureSocket(value);
      });
      req.once("response", (value: IncomingMessage) => {
        response = value;
        value.once("close", () => { responseClosed = true; checkDrain(); });
      });
      const deadline = setTimeout(() => { finish(new DeviceError("timeout")); }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      req.on("error", (error: NodeJS.ErrnoException) => {
        if (error === pinError || (typeof error.code === "string" && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(error.code))) {
          finish(new DeviceError("tls_pin_mismatch"));
        } else {
          finish(new DeviceError(typeof error.code === "string" && NETWORK_UNAVAILABLE.has(error.code) ? "unavailable" : "protocol_error"));
        }
      });
      if (!settled) req.end(payload);
    });
  }
  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#closed = true;
    const flights = [...this.#flights];
    for (const flight of flights) flight.cancel();
    this.#close = Promise.all(flights.map((flight) => flight.drained)).then(() => undefined);
    return this.#close;
  }
}

export function readBinding(dataDir: string): DeviceBinding | null {
  const path = join(dataDir, BINDING_FILE);
  try { lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new DeviceError("unavailable", "binding unavailable");
  }
  // Present (including a dangling symlink): it must be a private regular file.
  privateFile(path);
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new DeviceError("invalid_input", "binding unreadable"); }
  const v = exact(value, ["installationId", "ownerId", "deviceId", "hostFingerprint"]);
  if (typeof v.hostFingerprint !== "string" || !FINGERPRINT.test(v.hostFingerprint)) throw new DeviceError("invalid_input", "binding unreadable");
  return { installationId: wireId(v.installationId), ownerId: ownerIdOf(v.ownerId), deviceId: wireId(v.deviceId), hostFingerprint: v.hostFingerprint };
}
function writeBinding(dataDir: string, binding: DeviceBinding): void {
  const path = join(dataDir, BINDING_FILE);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(binding), { flag: "wx", mode: 0o600 });
  renameSync(temp, path);
  privateFile(path);
}

export type PairOptions = TrustedClientSelection & {
  dataDir: string;
  trust: HostTrust;
  offerId: string;
  /** One-time code transferred out of band. Sent only inside the pinned mutual-TLS channel. */
  code: string;
  name: string;
  capabilities: readonly string[];
  pollIntervalMs?: number;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
};
/**
 * Claims a pairing offer with this device's certificate and waits for the owner's approval. The first
 * pairing writes the binding; a rotation (new identity, same data dir) must come back with the same
 * installation, owner and device id or it is refused.
 */
export async function pairDevice(options: PairOptions): Promise<DeviceBinding> {
  clientSelection(options);
  privateDirectory(options.dataDir);
  const existing = readBinding(options.dataDir);
  if (existing && existing.hostFingerprint !== options.trust.hostFingerprint) throw new DeviceError("tls_pin_mismatch", "binding belongs to another host pin");
  const capabilities = checkCapabilities([...options.capabilities]);
  const owned = options.client === undefined;
  const client: DeviceClientPort = options.client ?? new DeviceClient(options.identity!, options.trust);
  try {
    const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    const claimed = await client.post("pair/claim", {
      offerId: options.offerId, code: options.code, name: options.name, platform: "macos", capabilities,
    }, requestTimeoutMs, options.signal);
    const claimId = wireId(exact(claimed, ["claimId", "status"]).claimId);
    const end = Date.now() + (options.timeoutMs ?? 5 * 60_000);
    while (Date.now() < end) {
      if (options.signal?.aborted) throw new DeviceError("unavailable", "pairing aborted");
      const out = exact(await client.post("pair/status", { claimId }, requestTimeoutMs, options.signal), ["status", "deviceId", "installationId", "ownerId"]);
      if (out.status === "approved") {
        const binding: DeviceBinding = {
          installationId: wireId(out.installationId), ownerId: ownerIdOf(out.ownerId), deviceId: wireId(out.deviceId),
          hostFingerprint: options.trust.hostFingerprint,
        };
        if (existing) {
          if (existing.installationId !== binding.installationId || existing.ownerId !== binding.ownerId || existing.deviceId !== binding.deviceId) {
            throw new DeviceError("conflict", "rotation returned another device");
          }
          return existing;
        }
        writeBinding(options.dataDir, binding);
        return binding;
      }
      if (out.status !== "pending") throw new DeviceError("forbidden", "pairing not approved");
      await delay(options.pollIntervalMs ?? 500, options.signal);
    }
    throw new DeviceError("timeout", "pairing approval timed out");
  } finally { if (owned) await client.close(); }
}

export type DaemonOptions = TrustedClientSelection & {
  dataDir: string;
  trust: HostTrust;
  /** Explicitly selected handlers; only declared operations are accepted. */
  handlers: ReadonlyMap<string, OperationHandler>;
  /** Client deadline for one long-poll; must exceed the host's poll window. */
  pollTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** How long `stop()` waits for an in-flight run (effect and journal write) before it fails closed. */
  stopTimeoutMs?: number;
  /** Closed by `stop()` after in-flight work settled and before the journal closes (e.g. local capabilities). */
  resources?: ReadonlyArray<{ close(): Promise<void> }>;
  clock?: () => number;
};

/**
 * The paired Mac agent. It dials the host, long-polls jobs, journals each start before the effect and
 * posts receipts; unacknowledged receipts are re-sent with the next poll. It never stores conversation,
 * memory, engine state or credentials, and it never decides grants: the host already did.
 */
export class MacDeviceDaemon {
  readonly binding: DeviceBinding;
  readonly journal: DaemonJournal;
  private readonly client: DeviceClientPort;
  private clientClose: Promise<"closed" | "failed"> | null = null;
  private readonly handlers: ReadonlyMap<string, OperationHandler>;
  private readonly pollTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly clock: () => number;
  private readonly inflight = new Set<string>();
  private readonly stopController = new AbortController();
  private loop: Promise<void> | null = null;
  /** The single run in progress, whether from `start()` or a direct `runOnce()`. */
  private active: Promise<unknown> | null = null;
  private readonly stopTimeoutMs: number;
  private readonly resources: ReadonlyArray<{ close(): Promise<void> }>;
  /** One closure attempt shared by concurrent stop/retry; rejected cleanup remains unconfirmed. */
  private resourcesClose: Promise<readonly PromiseSettledResult<void>[]> | null = null;
  private stopped = false;
  private closed = false;

  constructor(options: DaemonOptions) {
    clientSelection(options);
    privateDirectory(options.dataDir, false);
    const binding = readBinding(options.dataDir);
    if (!binding) throw new DeviceError("not_found", "device is not paired");
    if (binding.hostFingerprint !== options.trust.hostFingerprint) throw new DeviceError("tls_pin_mismatch", "binding belongs to another host pin");
    for (const tool of options.handlers.keys()) if (!DEVICE_OPERATIONS.has(tool)) throw new DeviceError("unsupported", "handler not declared");
    this.binding = binding;
    this.client = options.client ?? new DeviceClient(options.identity!, options.trust);
    this.handlers = options.handlers;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 35_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.stopTimeoutMs) || this.stopTimeoutMs < 1 || this.stopTimeoutMs > 10 * 60_000) {
      throw new DeviceError("invalid_input", "option out of range");
    }
    this.resources = options.resources ?? [];
    this.clock = options.clock ?? Date.now;
    this.journal = new DaemonJournal(options.dataDir, binding, this.clock);
  }

  toJSON(): object { return { deviceId: this.binding.deviceId, installationId: this.binding.installationId, stopped: this.stopped, inflight: this.inflight.size, running: this.active !== null }; }
  [inspect.custom](): object { return this.toJSON(); }

  /**
   * One poll (with pending receipts) and execution of the returned jobs. At most one run at a time, from
   * the loop or a direct call; `stop()` waits for it before the journal and its lease are released.
   */
  runOnce(): Promise<{ jobs: number }> {
    if (this.stopped) return Promise.reject(new DeviceError("unavailable", "daemon stopped"));
    if (this.active) return Promise.reject(new DeviceError("conflict", "a run is already in progress"));
    const run = this.poll();
    this.active = run;
    const clear = (): void => { if (this.active === run) this.active = null; };
    run.then(clear, clear);
    return run;
  }
  private async poll(): Promise<{ jobs: number }> {
    const receipts = this.journal.unacked(MAX_RECEIPTS_PER_POLL);
    const out = exact(await this.client.post("device/poll", {
      deviceId: this.binding.deviceId, installationId: this.binding.installationId, receipts,
    }, this.pollTimeoutMs, this.stopController.signal), ["jobs"]);
    this.journal.ack(receipts.map((r) => r.actionId));
    if (!Array.isArray(out.jobs) || out.jobs.length > MAX_JOBS_PER_POLL) throw new DeviceError("protocol_error");
    const jobs = out.jobs.map(parseJob);
    for (const job of jobs) {
      // Once stop is requested no new effect starts; undelivered work is re-sent or times out on the host.
      if (this.stopped) break;
      const receipt = await this.execute(job);
      if (!receipt) continue;
      try {
        await this.client.post("device/receipt", { deviceId: this.binding.deviceId, installationId: this.binding.installationId, receipt },
          this.requestTimeoutMs, this.stopController.signal);
        this.journal.ack([receipt.actionId]);
      } catch {
        // Stays unacknowledged in the journal and is re-sent with the next poll.
      }
    }
    return { jobs: jobs.length };
  }

  /** Background loop with bounded backoff. Revocation (forbidden) or a pin mismatch stops it. */
  start(onStop?: (code: DeviceErrorCode | null) => void): void {
    if (this.loop) return;
    this.loop = (async () => {
      let backoff = 250;
      let reason: DeviceErrorCode | null = null;
      while (!this.stopped) {
        try {
          await this.runOnce();
          backoff = 250;
        } catch (error) {
          const code = error instanceof DeviceError ? error.code : "unavailable";
          if (this.stopped) break;
          if (code === "forbidden" || code === "tls_pin_mismatch") { reason = code; break; }
          await delay(backoff, this.stopController.signal);
          backoff = Math.min(backoff * 2, 10_000);
        }
      }
      onStop?.(reason);
    })();
  }
  /**
   * Stops polling, aborts in-flight work and waits (bounded) for the loop and any direct `runOnce()` to
   * settle, so every effect has its journal outcome written before the journal closes and its lease is
   * released. If a handler does not settle in time, stop rejects with `timeout` and keeps the journal and
   * lease held (a second daemon still fails closed); calling stop again waits on the same client drain.
   * Transport close starts synchronously; capability resources close only after effects settle. Failed
   * transport cleanup is permanently quarantined, and neither a deadline nor cancellation proves a
   * remote effect stopped.
   */
  async stop(): Promise<void> {
    if (this.closed) return;
    this.stopped = true;
    this.stopController.abort();
    // Invoke synchronously to block retained transport facades immediately; observe rejection now.
    if (!this.clientClose) {
      try { this.clientClose = this.client.close().then(() => "closed" as const, () => "failed" as const); }
      catch { this.clientClose = Promise.resolve("failed" as const); }
    }
    const settled = Promise.all([this.loop, this.active].map((p) => p?.then(() => undefined, () => undefined)));
    let timer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      settled.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(false); }, this.stopTimeoutMs); }),
    ]);
    clearTimeout(timer);
    if (!drained || this.active) throw new DeviceError("timeout", "in-flight work did not settle");
    this.loop = null;
    if (this.closed) return;
    // Bounded like the drain: a resource that does not close keeps the journal and its lease held.
    let resourceTimer: NodeJS.Timeout | undefined;
    this.resourcesClose ??= Promise.allSettled(this.resources.map((r) => Promise.resolve().then(() => r.close())));
    const resourcesClosed = await Promise.race([
      this.resourcesClose.then((outcomes) => outcomes.every((outcome) => outcome.status === "fulfilled") ? "closed" : "failed"),
      new Promise<"timeout">((resolve) => { resourceTimer = setTimeout(() => { resolve("timeout"); }, this.stopTimeoutMs); }),
    ]);
    clearTimeout(resourceTimer);
    if (resourcesClosed !== "closed") throw new DeviceError(resourcesClosed === "timeout" ? "timeout" : "unavailable", "local resource cleanup is not confirmed");
    if (this.closed) return;
    // Cached once: a rejected close permanently quarantines this writer; a timeout awaits it again.
    let clientTimer: NodeJS.Timeout | undefined;
    const clientClosed = await Promise.race([
      this.clientClose,
      new Promise<"timeout">((resolve) => { clientTimer = setTimeout(() => resolve("timeout"), this.stopTimeoutMs); }),
    ]);
    clearTimeout(clientTimer);
    if (clientClosed !== "closed") throw new DeviceError(clientClosed === "timeout" ? "timeout" : "unavailable", "client drain is not confirmed");
    if (this.closed) return;
    this.closed = true;
    this.journal.close();
  }

  /** Validates, journals before the effect, runs the handler and finishes the journal entry. */
  private async execute(job: DeviceJob): Promise<DeviceReceipt | null> {
    const refuse = (code: string): DeviceReceipt => ({ actionId: job.actionId, nonce: job.nonce, requestHash: job.requestHash, status: "failed", result: null, code });
    // Cross-host/owner/device: a job for anyone else is refused without effect, whatever the channel said.
    if (job.hostId !== this.binding.installationId || job.ownerId !== this.binding.ownerId
      || job.deviceId !== this.binding.deviceId || job.request.destination !== this.binding.deviceId) return refuse("foreign_job");
    if (hashRequest(job.request) !== job.requestHash) return refuse("hash_mismatch");
    const op = DEVICE_OPERATIONS.get(job.request.tool);
    const handler = this.handlers.get(job.request.tool);
    if (!op || !handler) return refuse("unsupported");
    let args;
    try { args = op.validate(job.request.arguments); } catch { return refuse("invalid_arguments"); }
    if (this.inflight.has(job.actionId) || this.stopped) return null;
    const begin = this.journal.begin({ hostId: job.hostId, actionId: job.actionId, requestHash: job.requestHash, nonce: job.nonce, tool: job.request.tool });
    if (begin.kind === "conflict") return refuse("conflict");
    if (begin.kind === "existing") return begin.receipt;
    if (this.clock() > job.deadlineAt) {
      return this.journal.finish(job.hostId, job.actionId, { status: "failed", code: "expired" });
    }
    this.inflight.add(job.actionId);
    try {
      let result;
      try {
        const context: TrustedJobContext = Object.freeze({
          hostId: job.hostId, ownerId: job.ownerId, deviceId: job.deviceId, botId: job.request.botId, threadId: job.request.threadId,
          actionId: job.actionId, requestHash: job.requestHash, tool: job.request.tool, deadlineAt: job.deadlineAt,
        });
        result = await handler(args, { signal: this.stopController.signal, job: context });
      } catch (error) {
        return this.journal.finish(job.hostId, job.actionId, error instanceof HandlerRefusal
          ? { status: "failed", code: /^[a-z][a-z_]{0,47}$/.test(error.code) ? error.code : "refused" }
          : { status: "unknown", code: "handler_error" });
      }
      let bounded;
      try { bounded = boundedJson(result, MAX_RESULT_BYTES); } catch { bounded = { omitted: "result_too_large" }; }
      return this.journal.finish(job.hostId, job.actionId, { status: "completed", result: bounded });
    } finally {
      this.inflight.delete(job.actionId);
    }
  }
}
