import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { TLSSocket } from "node:tls";
import { inspect } from "node:util";
import type { Action, JsonValue, ToolRequest } from "@dexter/contracts";
import { dispatchAction, hashRequest, HostError, type HostStore, type ToolExecutor } from "@dexter/hub";
import { DeviceError, type DeviceErrorCode } from "./errors.js";
import type { TlsIdentity } from "./files.js";
import { checkOperationArgs } from "./operations.js";
import type { DevicePairingRegistry, DevicePinBinding, PairingOffer } from "./registry.js";
import {
  DEVICE_PROTOCOL, MAX_JOBS_PER_POLL, MAX_RECEIPTS_PER_POLL, MAX_REQUEST_BYTES, exact, fingerprintDer, parseReceipt, wireId,
  type DeviceJob, type DeviceReceipt,
} from "./wire.js";

export interface DeviceHostOptions {
  store: HostStore;
  registry: DevicePairingRegistry;
  /** Host TLS identity; its SHA-256 pin is handed to the device out of band inside the pairing bundle. */
  identity: TlsIdentity;
  /** Listen address. Defaults to loopback; any other address is an explicit operator decision. */
  listenHost?: string;
  port?: number;
  /** Long-poll window. Must stay well below the HostStore device TTL so polling keeps the device online. */
  pollWaitMs?: number;
  /** How long a dispatched action waits for its receipt before the hub records `unknown`. */
  receiptTimeoutMs?: number;
  maxConnections?: number;
}
/** Out-of-band pairing material for the owner to move to the Mac. Contains the one-time code: do not log it. */
export interface PairingBundle {
  hostUrl: string;
  hostFingerprint: string;
  hostCertPem: string;
  offerId: string;
  code: string;
  expiresAt: number;
}

/**
 * Trusted, synchronous delivery guard bound by the host to exactly one canonical action. It receives a frozen
 * copy of the current canonical action and the persisted pin binding, never wire data, raw arguments of a
 * peer or caller-supplied principals. It must only read (it runs inside the HostStore writer lease) and must
 * not await. Anything but `true`, including a throw, refuses.
 */
export type DeliveryGuard = (action: Action, peer: DevicePinBinding) => boolean;
type Outcome = { kind: "receipt"; receipt: DeviceReceipt } | { kind: "error"; code: DeviceErrorCode };
interface PendingJob { job: DeviceJob; delivered: boolean; settle(outcome: Outcome): void }
type Body = Record<string, unknown>;

const STATUS: Record<DeviceErrorCode, number> = {
  invalid_input: 400, protocol_error: 400, unsupported: 400, forbidden: 403, not_found: 404, conflict: 409,
  unavailable: 503, timeout: 504, tls_pin_mismatch: 403, outcome_unknown: 502,
};
const path = (name: string): string => `/${DEVICE_PROTOCOL}/${name}`;

/**
 * Host endpoint for paired Mac agents: HTTPS over TLS 1.3 with a client certificate. The TLS layer proves
 * possession of the presented key; this server then authorises by the SHA-256 pin of that certificate
 * against the pairing registry and the canonical HostStore device. Session resumption is refused so every
 * connection performs a full handshake with the peer certificate (Node docs, `tlsSocket.authorized`).
 *
 * The Mac dials the host (it is usually behind NAT): it long-polls for jobs, which also heartbeats the
 * HostStore device, and posts receipts. The host stays the only writer of conversation and action state.
 */
export class DeviceHostServer {
  readonly store: HostStore;
  readonly registry: DevicePairingRegistry;
  readonly hostFingerprint: string;
  readonly pollWaitMs: number;
  readonly receiptTimeoutMs: number;
  readonly #identity: TlsIdentity;
  readonly #server: Server;
  private readonly listenHost: string;
  private readonly requestedPort: number;
  private readonly maxConnections: number;
  private readonly sockets = new Map<TLSSocket, string>();
  private readonly authenticatedPolls = new Map<string, { at: number; fingerprint: string }>();
  private readonly jobs = new Map<string, PendingJob>();
  private readonly waiters = new Map<string, () => void>();
  /** Every dispatch from before its claim until full finalization; the guard of an action cannot be swapped. */
  private readonly flights = new Map<string, DeliveryGuard | null>();
  /** Every request handler from its first byte until its response; `close()` waits for all of them. */
  private readonly handlers = new Set<Promise<void>>();
  private admissionStopped = false;
  private closing = false;
  private closed: Promise<void> | null = null;

  constructor(options: DeviceHostOptions) {
    this.store = options.store;
    this.registry = options.registry;
    if (this.registry.installationId !== this.store.hostId || this.registry.ownerId !== this.store.ownerId) {
      throw new DeviceError("conflict", "registry belongs to another installation");
    }
    this.#identity = options.identity;
    this.hostFingerprint = options.identity.fingerprint;
    this.listenHost = options.listenHost ?? "127.0.0.1";
    this.requestedPort = options.port ?? 0;
    this.pollWaitMs = bounded(options.pollWaitMs ?? 20_000, 50, 60_000);
    this.receiptTimeoutMs = bounded(options.receiptTimeoutMs ?? 30_000, 50, 10 * 60_000);
    this.maxConnections = bounded(options.maxConnections ?? 64, 1, 1_024);
    if (this.pollWaitMs * 2 >= this.store.deviceTtlMs) throw new DeviceError("invalid_input", "poll window must be under half the device ttl");
    this.#server = createServer({
      key: this.#identity.keyPem, cert: this.#identity.certPem,
      minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
      // Client certificates are self-signed device keys pinned by fingerprint, so CA verification is
      // replaced (not skipped) by the pin check below. A peer without a certificate is dropped.
      requestCert: true, rejectUnauthorized: false,
      maxHeaderSize: 8 * 1024,
    }, (req, res) => {
      const handler = this.handle(req, res);
      this.handlers.add(handler);
      void handler.finally(() => { this.handlers.delete(handler); });
    });
    this.#server.headersTimeout = 10_000;
    this.#server.requestTimeout = this.pollWaitMs + 15_000;
    this.#server.keepAliveTimeout = 1_000;
    this.#server.maxHeadersCount = 32;
    this.#server.on("secureConnection", (socket: TLSSocket) => {
      const cert = socket.getPeerCertificate();
      if (this.closing || this.sockets.size >= this.maxConnections || socket.isSessionReused() || !cert || !cert.raw) {
        socket.destroy();
        return;
      }
      this.sockets.set(socket, fingerprintDer(cert.raw));
      socket.once("close", () => { this.sockets.delete(socket); });
    });
    this.#server.on("tlsClientError", () => { /* handshake failures carry peer-controlled data; nothing is logged */ });
  }

  /** Starts listening; returns the HTTPS URL to place in pairing bundles. */
  async start(): Promise<string> {
    // A retired listener never listens (again): a retained reference cannot reopen admission.
    if (this.admissionStopped) throw new DeviceError("unavailable", "device endpoint unavailable");
    await new Promise<void>((resolve, reject) => {
      const failed = (): void => { reject(new DeviceError("unavailable", "device endpoint unavailable")); };
      this.#server.once("error", failed);
      this.#server.listen(this.requestedPort, this.listenHost, () => { this.#server.off("error", failed); resolve(); });
    });
    return this.url;
  }
  get url(): string {
    const address = this.#server.address();
    if (address === null || typeof address === "string") throw new DeviceError("unavailable", "device endpoint not listening");
    const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
    return `https://${host}:${address.port}`;
  }

  /** Owner/admin: a pairing offer plus the host pin, for out-of-band transfer to the Mac. */
  pairingBundle(input: { kind: "pair" } | { kind: "rotate"; deviceId: string }): PairingBundle {
    if (this.admissionStopped) throw new DeviceError("unavailable", "device endpoint unavailable");
    const offer: PairingOffer = this.registry.createOffer(input);
    return {
      hostUrl: this.url, hostFingerprint: this.hostFingerprint, hostCertPem: this.#identity.certPem,
      offerId: offer.offerId, code: offer.code, expiresAt: offer.expiresAt,
    };
  }

  /**
   * Revokes the device (HostStore first, then its pins), drops its live connections and fails every job
   * for it as unknown: a job already delivered may have run, and an undelivered one can no longer be sent.
   */
  revokeDevice(deviceId: string): void {
    const fingerprints = new Set(this.registry.listCertificates(deviceId).map((c) => c.fingerprint));
    this.registry.revokeDevice(deviceId);
    this.authenticatedPolls.delete(deviceId);
    for (const pending of [...this.jobs.values()]) if (pending.job.deviceId === deviceId) pending.settle({ kind: "error", code: "outcome_unknown" });
    this.waiters.get(deviceId)?.();
    for (const [socket, fp] of this.sockets) if (fingerprints.has(fp)) socket.destroy();
  }

  /**
   * Dispatches a ready device action through the hub. A destination without an active pin, or a device
   * whose heartbeat is stale, is refused before the claim, so the action stays `ready` (no effect).
   */
  async dispatch(actionId: string, signal?: AbortSignal, guard?: DeliveryGuard): Promise<Action> {
    if (guard !== undefined && typeof guard !== "function") throw new DeviceError("invalid_input", "invalid guard");
    // One dispatch per action id until it is fully finalized: a duplicate or parallel raw dispatch can neither
    // replace the guard of a pending job nor settle it early.
    if (typeof actionId !== "string" || this.flights.has(actionId)) throw new DeviceError("conflict", "action already dispatching");
    // Refused before the claim: the action stays `ready`, with no effect.
    if (this.admissionStopped) throw new DeviceError("unavailable", "device endpoint unavailable");
    const action = this.store.getAction(actionId);
    if (action.state === "ready") {
      // A revoked device falls through: the hub claim blocks the action (permission_changed).
      let revoked = false;
      try { revoked = this.store.getDevice(action.request.destination).revokedAt !== null; } catch { /* not a device: the claim decides */ }
      if (!revoked && this.registry.activeFingerprint(action.request.destination) === null) throw new DeviceError("unavailable", "destination device is not paired");
      checkOperationArgs(action.request.tool, action.request.arguments);
    }
    this.flights.set(actionId, guard ?? null);
    try {
      return await dispatchAction(this.store, actionId, this.executor, signal);
    } finally {
      this.flights.delete(actionId);
    }
  }
  /** Whether a dispatch of `actionId` is admitted and not yet finalized (claim, queue, receipt or finalization). */
  dispatching(actionId: string): boolean { return this.flights.has(actionId); }

  /** Hub executor. Rejection means the hub records `unknown` and never retries. */
  readonly executor: ToolExecutor = (request, { signal }) => this.execute(request, signal);

  /**
   * Permanent, synchronous admission barrier. From this call on no TLS route reaches the canonical store
   * (no heartbeat, pair claim, claim status, receipt or late receipt), no dispatch is admitted, no pairing
   * offer is created, no job is delivered and the listener cannot start. Every request, including one whose
   * body arrived before the barrier, gets the fixed `unavailable` answer. Jobs still waiting settle unknown
   * (a delivered one may have run; its receipt can no longer be accepted) and long-polls wake. The listener
   * and the already admitted handlers are drained by `close()`.
   */
  stopAdmission(): void {
    if (this.admissionStopped) return;
    this.admissionStopped = true;
    for (const pending of [...this.jobs.values()]) pending.settle({ kind: "error", code: "outcome_unknown" });
    for (const wake of [...this.waiters.values()]) wake();
  }
  /**
   * Stops admission, closes the listener and every socket, then waits until each admitted request handler
   * has finished. Idempotent: every call returns the same promise.
   */
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.stopAdmission();
    this.closing = true;
    this.closed = new Promise<void>((resolve) => {
      this.#server.close(() => { resolve(); });
      for (const socket of this.sockets.keys()) socket.destroy();
      this.#server.closeAllConnections();
    }).then(() => this.drainHandlers());
    return this.closed;
  }
  private async drainHandlers(): Promise<void> {
    while (this.handlers.size > 0) await Promise.allSettled([...this.handlers]);
  }
  /** Live presence is observed only by authenticated polls in this listener lifetime, never claim approval. */
  authenticatedPresence(deviceId: string): "online" | "stale" | "revoked" {
    if (this.store.getDevice(deviceId).revokedAt !== null) return "revoked";
    const seen = this.authenticatedPolls.get(deviceId);
    return !this.admissionStopped && seen !== undefined && this.registry.activeFingerprint(deviceId) === seen.fingerprint
      && this.store.now() - seen.at < this.store.deviceTtlMs ? "online" : "stale";
  }
  /** Diagnostics without arguments, results or key material. */
  status(): { listening: boolean; connections: number; pendingJobs: number; hostFingerprint: string } {
    return { listening: this.#server.listening, connections: this.sockets.size, pendingJobs: this.jobs.size, hostFingerprint: this.hostFingerprint };
  }
  /**
   * Calls the guard bound to this action, if any. Must run inside the writer lease, synchronously. The guard
   * sees a frozen copy of the canonical action and the persisted pin binding; `fp`, when given, must be that
   * binding's active pin (the TLS peer of a poll).
   */
  private guardAllows(actionId: string, fp: string | null): boolean {
    // No entry: the legacy executor was driven directly through the hub dispatcher (unguarded contract).
    const guard = this.flights.get(actionId);
    if (guard === undefined || guard === null) return true;
    try {
      const action = deepFreeze(structuredClone(this.store.getAction(actionId)));
      const peer = this.registry.pinBinding(action.request.destination);
      if (!peer || peer.status !== "active" || (fp !== null && peer.fingerprint !== fp)) return false;
      return guard(action, peer) === true;
    } catch {
      return false;
    }
  }
  toJSON(): object { return this.status(); }
  /** Sockets reference the TLS server, which holds its key; inspection shows status only. */
  [inspect.custom](): object { return this.status(); }

  // ---- executor ------------------------------------------------------------------------------

  private async execute(request: ToolRequest, signal: AbortSignal): Promise<JsonValue> {
    const action = this.store.findAction(request.botId, request.idempotencyKey);
    if (!action || action.state !== "running" || action.requestHash !== hashRequest(request)) throw new DeviceError("conflict", "action is not running");
    checkOperationArgs(request.tool, request.arguments);
    const deviceId = request.destination;
    const job: DeviceJob = {
      actionId: action.id, nonce: randomBytes(16).toString("hex"), hostId: this.store.hostId, ownerId: this.store.ownerId,
      deviceId, requestHash: action.requestHash, request: structuredClone(action.request), deadlineAt: this.store.now() + this.receiptTimeoutMs,
    };
    // Fenced revalidation with no await between it and queueing: a host that lost its writer lease, a
    // changed grant, a revoked device, a missing pin or a withdrawn capability never reaches the wire.
    this.store.withWriterLease(() => {
      this.assertDeliverable(job, null);
      if (!this.guardAllows(action.id, null)) throw new DeviceError("forbidden", "job is no longer deliverable");
    });
    if (this.admissionStopped) throw new DeviceError("unavailable", "device endpoint closing");
    if (signal.aborted) throw new DeviceError("unavailable", "dispatch aborted");
    if (this.jobs.has(action.id)) throw new DeviceError("conflict", "action already queued");
    const outcome = await new Promise<Outcome>((resolve) => {
      let done = false;
      const settle = (value: Outcome): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (this.jobs.get(action.id) === pending) this.jobs.delete(action.id);
        resolve(value);
      };
      const onAbort = (): void => { settle({ kind: "error", code: "outcome_unknown" }); };
      const timer = setTimeout(() => { settle({ kind: "error", code: "timeout" }); }, this.receiptTimeoutMs);
      const pending: PendingJob = { job, delivered: false, settle };
      signal.addEventListener("abort", onAbort, { once: true });
      this.jobs.set(action.id, pending);
      this.waiters.get(deviceId)?.();
    });
    if (outcome.kind === "error") throw new DeviceError(outcome.code, "device outcome not confirmed");
    const receipt = outcome.receipt;
    // A guarded action publishes a receipt only if its binding still holds after the asynchronous wait;
    // otherwise the outcome is unknown (the effect may have happened) and nothing is re-executed.
    if (this.flights.get(action.id) && !this.store.withWriterLease(() => this.guardAllows(action.id, null))) throw new DeviceError("outcome_unknown", "device binding changed");
    if (receipt.status === "completed") return { ok: true, result: receipt.result };
    // The daemon refused before its journal recorded a start: a definitive result with no effect.
    if (receipt.status === "failed") return { ok: false, code: receipt.code };
    throw new DeviceError("outcome_unknown", "device reported an unknown outcome");
  }

  // ---- HTTP ----------------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.on("error", () => { /* peer went away */ });
    try {
      const socket = req.socket as TLSSocket;
      const fingerprint = this.sockets.get(socket);
      if (this.admissionStopped) throw new DeviceError("unavailable");
      if (fingerprint === undefined || socket.isSessionReused()) throw new DeviceError("forbidden");
      if (req.method !== "POST") throw new DeviceError("invalid_input");
      const contentType = req.headers["content-type"];
      if (typeof contentType !== "string" || contentType.split(";")[0]!.trim().toLowerCase() !== "application/json") throw new DeviceError("invalid_input");
      // A route that already wrote its response returns null.
      let route: ((fp: string, body: Body, req: IncomingMessage, res: ServerResponse) => Promise<object | null> | object) | undefined;
      switch (req.url) {
        case path("pair/claim"): route = (fp, body) => this.pairClaim(fp, body); break;
        case path("pair/status"): route = (fp, body) => this.pairStatus(fp, body); break;
        case path("device/poll"): route = (fp, body, rq, rs) => this.poll(fp, body, rq, rs); break;
        case path("device/receipt"): route = (fp, body) => this.receipt(fp, body); break;
        default: throw new DeviceError("not_found");
      }
      const body = await readJson(req);
      // The barrier may have fallen while the body was arriving; the route runs synchronously from here
      // until its first await, so nothing below can reach the store after the barrier.
      if (this.admissionStopped) throw new DeviceError("unavailable");
      const out = await route(fingerprint, body, req, res);
      if (out !== null) send(res, 200, out);
    } catch (error) {
      const code: DeviceErrorCode = this.admissionStopped ? "unavailable"
        : error instanceof DeviceError ? error.code
        : error instanceof HostError && error.code === "host_locked" ? "unavailable"
        : error instanceof HostError && error.code === "forbidden" ? "forbidden"
        : "unavailable";
      send(res, STATUS[code], { error: code });
    }
  }
  private pairClaim(fp: string, body: Body): object {
    const v = exact(body, ["offerId", "code", "name", "platform", "capabilities"]);
    if (v.platform !== "macos") throw new DeviceError("invalid_input");
    const { claimId } = this.registry.claim({ offerId: v.offerId, code: v.code, clientFingerprint: fp, name: v.name, capabilities: v.capabilities });
    return { claimId, status: "pending" };
  }
  private pairStatus(fp: string, body: Body): object {
    const v = exact(body, ["claimId"]);
    const status = this.registry.claimStatus(v.claimId, fp);
    const approved = status.status === "approved";
    return {
      status: status.status, deviceId: status.deviceId,
      installationId: approved ? this.store.hostId : null, ownerId: approved ? this.store.ownerId : null,
    };
  }
  /** The device whose active pin is the TLS peer, which must also be the one named in the body. */
  private device(fp: string, body: Body): string {
    const deviceId = wireId(body.deviceId);
    const installationId = wireId(body.installationId);
    const device = this.registry.authenticate(fp);
    if (!device || device.id !== deviceId || installationId !== this.store.hostId) throw new DeviceError("forbidden");
    return deviceId;
  }
  private async poll(fp: string, body: Body, _req: IncomingMessage, res: ServerResponse): Promise<null> {
    exact(body, ["deviceId", "installationId", "receipts"]);
    const deviceId = this.device(fp, body);
    if (!Array.isArray(body.receipts) || body.receipts.length > MAX_RECEIPTS_PER_POLL) throw new DeviceError("invalid_input");
    const receipts = body.receipts.map(parseReceipt);
    this.store.heartbeatDevice(deviceId);
    this.authenticatedPolls.set(deviceId, { at: this.store.now(), fingerprint: fp });
    for (const receipt of receipts) this.accept(deviceId, receipt);
    if (this.pendingFor(deviceId).length === 0) await this.waitForJob(deviceId, res);
    // Everything from here to the bytes on the wire is synchronous: the final check, marking delivery
    // and writing the response cannot interleave with a revocation, a grant change, a lost lease or the
    // admission barrier (which also woke this wait).
    if (this.admissionStopped) throw new DeviceError("unavailable");
    if (this.device(fp, body) !== deviceId) throw new DeviceError("forbidden");
    send(res, 200, { jobs: this.deliver(deviceId, fp) });
    return null;
  }
  /**
   * Picks the jobs this poll may carry, revalidated under the writer lease after the long-poll wait. A job
   * that is no longer deliverable is settled unknown (it may have gone out on an earlier poll) and is
   * never sent again. A host that lost its writer lease delivers nothing and fails every queued job.
   */
  private deliver(deviceId: string, fp: string): DeviceJob[] {
    const candidates = this.pendingFor(deviceId);
    const ready: PendingJob[] = [];
    const stale: PendingJob[] = [];
    try {
      this.store.withWriterLease(() => {
        for (const item of candidates) {
          if (ready.length === MAX_JOBS_PER_POLL) break;
          try {
            this.assertDeliverable(item.job, fp);
            if (!this.guardAllows(item.job.actionId, fp)) throw new DeviceError("forbidden", "job is no longer deliverable");
            ready.push(item);
          } catch { stale.push(item); }
        }
      });
    } catch (error) {
      for (const item of candidates) item.settle({ kind: "error", code: "outcome_unknown" });
      throw error instanceof DeviceError ? error : new DeviceError("unavailable");
    }
    for (const item of stale) item.settle({ kind: "error", code: "outcome_unknown" });
    for (const item of ready) item.delivered = true;
    return ready.map((item) => item.job);
  }
  /**
   * Throws unless the job may reach the device now: the action is still the running one this job was
   * built from (full request hash), its grant is effective at the same revision it was requested under
   * (allow -> deny -> allow is a new revision and fails), an approval has not expired, and the device is
   * unrevoked, still has the capability and is still pinned (to `fp`, when called for a TLS peer).
   * Read-only and synchronous: call it inside the writer lease.
   */
  private assertDeliverable(job: DeviceJob, fp: string | null): void {
    const refuse = (): never => { throw new DeviceError("forbidden", "job is no longer deliverable"); };
    const action = this.store.getAction(job.actionId);
    const request = action.request;
    if (action.state !== "running" || action.requestHash !== job.requestHash || hashRequest(request) !== job.requestHash
      || hashRequest(job.request) !== job.requestHash || request.destination !== job.deviceId) refuse();
    const now = this.store.now();
    if (action.approvalExpiresAt !== null && now >= action.approvalExpiresAt) refuse();
    const grant = this.store.getGrant(request.botId, request.tool, request.destination);
    if (!grant || grant.policy === "deny" || grant.revision !== action.grantRevision || (grant.expiresAt !== null && now >= grant.expiresAt)) refuse();
    const device = this.store.getDevice(job.deviceId);
    if (device.revokedAt !== null || !device.capabilities.includes(request.tool)) refuse();
    const active = this.registry.activeFingerprint(job.deviceId);
    if (active === null || (fp !== null && active !== fp)) refuse();
  }
  private receipt(fp: string, body: Body): object {
    exact(body, ["deviceId", "installationId", "receipt"]);
    const deviceId = this.device(fp, body);
    this.accept(deviceId, parseReceipt(body.receipt));
    return { ack: true };
  }
  /**
   * A receipt settles its waiting job only when device, nonce and request hash all match. Otherwise it is
   * a late receipt (the host timed out, was restarted or the job was revoked): it is recorded as auxiliary
   * metadata if it matches the action's device and hash, and never changes the action's state.
   */
  private accept(deviceId: string, receipt: DeviceReceipt): void {
    const pending = this.jobs.get(receipt.actionId);
    if (pending) {
      if (pending.job.deviceId !== deviceId || pending.job.nonce !== receipt.nonce || pending.job.requestHash !== receipt.requestHash) {
        throw new DeviceError("forbidden");
      }
      pending.settle({ kind: "receipt", receipt });
      return;
    }
    let action: Action;
    try { action = this.store.getAction(receipt.actionId); } catch { throw new DeviceError("forbidden"); }
    if (action.request.destination !== deviceId || action.requestHash !== receipt.requestHash) throw new DeviceError("forbidden");
    this.registry.recordLateReceipt({ actionId: action.id, deviceId, requestHash: receipt.requestHash, status: receipt.status, code: receipt.code });
  }
  private pendingFor(deviceId: string): PendingJob[] {
    return [...this.jobs.values()].filter((item) => item.job.deviceId === deviceId);
  }
  private waitForJob(deviceId: string, res: ServerResponse): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.get(deviceId)?.();
      const done = (): void => {
        clearTimeout(timer);
        res.off("close", done);
        if (this.waiters.get(deviceId) === done) this.waiters.delete(deviceId);
        resolve();
      };
      const timer = setTimeout(done, this.pollWaitMs);
      res.once("close", done);
      this.waiters.set(deviceId, done);
    });
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
function bounded(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new DeviceError("invalid_input", "option out of range");
  return value;
}
function send(res: ServerResponse, status: number, body: object): void {
  if (res.headersSent || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json", "content-length": Buffer.byteLength(payload), "cache-control": "no-store", connection: "close",
  });
  res.end(payload);
}
/** Reads at most MAX_REQUEST_BYTES; larger bodies destroy the request. Only a JSON object is accepted. */
function readJson(req: IncomingMessage): Promise<Body> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && (!/^\d{1,9}$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) {
    req.destroy();
    return Promise.reject(new DeviceError("invalid_input"));
  }
  return new Promise<Body>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const fail = (): void => { if (finished) return; finished = true; reject(new DeviceError("invalid_input")); };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) { fail(); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("error", fail);
    req.on("aborted", fail);
    // A socket destroyed mid-body must settle the read, or the handler drain could never finish.
    req.on("close", fail);
    req.on("end", () => {
      if (finished) return;
      finished = true;
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (value === null || typeof value !== "object" || Array.isArray(value)) { reject(new DeviceError("invalid_input")); return; }
        resolve(value as Body);
      } catch {
        reject(new DeviceError("invalid_input"));
      }
    });
  });
}
