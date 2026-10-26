import { createPrivateKey, X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";
import { inspect } from "node:util";
import { RenameDeviceSchema, GrantInputSchema, type Action, type DeviceView, type Grant } from "@dexter/contracts";
import { hashRequest, HostError, type HostStore } from "@dexter/hub";
import type { HostDevicePort } from "@dexter/hub/http";
import type { InputSchema } from "@dexter/gateway";
import { DeviceHostServer, DevicePairingRegistry, DeviceError, TlsIdentity, certificateFingerprint, checkOperationArgs,
  deviceOperationSchemaHash, operationFor, DEVICE_OPERATIONS, type PairingBundle, type PendingClaim } from "@dexter/devices";
import { DeviceDispatchPreflightError, type DevicePinSnapshot, type DeviceToolOperation, type DeviceToolsPort } from "./device-turn-surface.js";

export interface DeviceServicesOptions {
  identity: TlsIdentity;
  /** This composition is local only. Remote listeners require a separate explicit product transport gate. */
  listenHost?: "127.0.0.1" | "::1";
  port?: number;
  pollWaitMs?: number;
  receiptTimeoutMs?: number;
  maxConnections?: number;
  maxDispatches?: number;
}
export interface DeviceAdmin {
  /** Public trust only; no offer/code, key, claim or grant is created by this read. */
  connectionDescription(): ReturnType<DeviceHostServer["connectionDescription"]>;
  pairingBundle(input: { kind: "pair" } | { kind: "rotate"; deviceId: string }): PairingBundle;
  pendingClaims(): PendingClaim[];
  approveClaim(claimId: string): { deviceId: string; fingerprint: string };
  rejectClaim(claimId: string): void;
  cancelOffer(offerId: string): void;
  grant(input: unknown): Grant;
}
function invalid(): never { throw new HostError("invalid_input", "Invalid device channel configuration."); }
function bound(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return invalid();
  return value;
}
/** Pure validation/snapshot before opening the HostStore. It creates no socket, file or request. */
export function validateDeviceServicesOptions(input: DeviceServicesOptions): Readonly<DeviceServicesOptions> {
  try {
    const config = { ...input };
    if (Object.keys(config).some(key => !["identity", "listenHost", "port", "pollWaitMs", "receiptTimeoutMs", "maxConnections", "maxDispatches"].includes(key))) return invalid();
    const raw = config.identity;
    const certPem = raw.certPem, keyPem = raw.keyPem, fingerprint = raw.fingerprint;
    if (typeof certPem !== "string" || typeof keyPem !== "string" || typeof fingerprint !== "string" || certPem.length > 65536 || keyPem.length > 65536) return invalid();
    const cert = new X509Certificate(certPem);
    if (!cert.checkPrivateKey(createPrivateKey(keyPem)) || certificateFingerprint(certPem) !== fingerprint) return invalid();
    const now = Date.now();
    if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now) return invalid();
    createSecureContext({ cert: certPem, key: keyPem, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" });
    if (config.listenHost !== undefined && !["127.0.0.1", "::1"].includes(config.listenHost)) return invalid();
    return Object.freeze({ identity: new TlsIdentity(certPem, keyPem, fingerprint), listenHost: config.listenHost ?? "127.0.0.1",
      port: bound(config.port, 0, 0, 65535), pollWaitMs: bound(config.pollWaitMs, 20000, 50, 30000),
      receiptTimeoutMs: bound(config.receiptTimeoutMs, 30000, 50, 600000), maxConnections: bound(config.maxConnections, 64, 1, 1024),
      maxDispatches: bound(config.maxDispatches, 64, 1, 1024) });
  } catch { return invalid(); }
}
function safeError(error: unknown): never {
  if (error instanceof HostError) throw error;
  if (DeviceDispatchPreflightError.is(error)) {
    throw new HostError(error.code === "unavailable" ? "device_unavailable" : error.code === "conflict" ? "conflict" : "forbidden", "Device operation could not be completed.");
  }
  if (error instanceof Error && error.name === "ZodError") throw new HostError("invalid_input", "Device request does not match the contract.");
  if (error instanceof DeviceError) {
    const code = error.code === "not_found" ? "not_found" : error.code === "forbidden" ? "forbidden"
      : ["invalid_input", "unsupported", "protocol_error"].includes(error.code) ? "invalid_input"
      : ["unavailable", "timeout"].includes(error.code) ? "device_unavailable" : "conflict";
    throw new HostError(code, "Device operation could not be completed.");
  }
  throw new HostError("conflict", "Device operation could not be completed.");
}
type Guard = (action: Action, peer: DevicePinSnapshot) => boolean;
const TERMINAL = ["succeeded", "unknown", "blocked", "denied"];
/** Refusal proven before any claim: the canonical action is not running and no job or flight was admitted. */
const preflight = (code: "unavailable" | "forbidden" | "conflict"): DeviceDispatchPreflightError => new DeviceDispatchPreflightError(code);
/**
 * Canonical operation as the trusted port publishes it: the deeply frozen declaration from `operationFor`,
 * its hash recomputed from the published fields, and the device validator as the final semantic judge.
 */
function toolOperation(tool: string): DeviceToolOperation {
  const op = operationFor(tool);
  if (deviceOperationSchemaHash(op) !== op.schemaHash) throw new DeviceError("conflict", "operation schema hash mismatch");
  return Object.freeze({
    tool: op.tool, version: op.version, effect: op.effect, description: op.description,
    inputSchema: op.inputSchema as unknown as InputSchema, schemaHash: op.schemaHash,
    validate: (args: Parameters<DeviceToolOperation["validate"]>[0]) => checkOperationArgs(op.tool, args),
  });
}
/** Owns the listener/registry and the entire host action finalization, not just its TLS requests. */
export class DeviceServices {
  readonly http: Readonly<HostDevicePort>;
  readonly admin: Readonly<DeviceAdmin>;
  /**
   * Trusted composition port for the turn tool surface (same identity for this instance's lifetime). Never
   * handed to an engine; an engine cannot construct it. It reads persisted pin bindings and the canonical
   * operations, and `dispatchBound` owns claim, delivery, receipt and finalization of one canonical action.
   */
  readonly tools: Readonly<DeviceToolsPort>;
  readonly #store: HostStore;
  readonly #registry: DevicePairingRegistry;
  readonly #server: DeviceHostServer;
  readonly #maxDispatches: number;
  readonly #dispatches = new Map<string, Promise<Action>>();
  #admissionStopped = false;
  #start: Promise<string> | null = null;
  #close: Promise<void> | null = null;
  #disposed = false;
  #unconfirmedAction = false;
  #turnOwnership: ((actionId: string) => boolean) | null = null;
  constructor(store: HostStore, options: Readonly<DeviceServicesOptions>) {
    const config = validateDeviceServicesOptions(options);
    if ((config.pollWaitMs ?? 20000) * 2 >= store.deviceTtlMs) invalid();
    this.#store = store;
    this.#maxDispatches = config.maxDispatches ?? 64;
    this.#registry = new DevicePairingRegistry(store);
    try { this.#server = new DeviceHostServer({ store, registry: this.#registry, ...config }); }
    catch (error) { this.#registry.close(); throw error; }
    this.http = Object.freeze({ list: () => this.#call(() => store.listDevices().map(device => this.#view(device.id))),
      get: (id: string) => this.#call(() => this.#view(id)),
      rename: (id: string, input: unknown) => this.#call(() => { store.renameDevice(id, RenameDeviceSchema.parse(input)); return this.#view(id); }),
      revoke: (id: string) => this.#call(() => { this.#server.revokeDevice(id); return this.#view(id); }),
      dispatch: (id: string) => this.#dispatch(id), status: () => this.status() });
    this.tools = Object.freeze({
      installationId: store.hostId, ownerId: store.ownerId,
      snapshot: (id: string) => this.#borrow(() => this.#registry.pinBinding(id)),
      authenticatedPresence: (id: string) => this.#borrow(() => this.#server.authenticatedPresence(id)),
      operation: (tool: string) => this.#borrow(() => toolOperation(tool)),
      dispatchBound: (id: string, context: { signal: AbortSignal; guard: Guard }) => this.#dispatchBound(id, context),
    });
    this.admin = Object.freeze({
      connectionDescription: () => this.#borrow(() => this.#server.connectionDescription()),
      pairingBundle: (input: Parameters<DeviceAdmin["pairingBundle"]>[0]) => this.#call(() => this.#server.pairingBundle(input)),
      pendingClaims: () => this.#call(() => this.#registry.listPendingClaims()),
      approveClaim: (id: string) => this.#call(() => this.#registry.approveClaim(id)),
      rejectClaim: (id: string) => this.#call(() => this.#registry.rejectClaim(id)),
      cancelOffer: (id: string) => this.#call(() => this.#registry.cancelOffer(id)),
      grant: (input: unknown) => this.#call(() => {
        const grant = GrantInputSchema.parse(input), device = store.getDevice(grant.destination);
        if (!this.#registry.activeFingerprint(device.id) || device.revokedAt !== null || !DEVICE_OPERATIONS.has(grant.tool) || !device.capabilities.includes(grant.tool))
          throw new HostError("forbidden", "Grant requires a paired device and a declared operation.");
        return store.setGrant(grant);
      }),
    });
  }
  #call<T>(fn: () => T): T {
    if (this.#admissionStopped) throw new HostError("conflict", "Device channel is closing.");
    try { return fn(); } catch (error) { return safeError(error); }
  }
  /** Borrowed port reads refuse once admission stopped, after disposal, or when the writer lease is lost. */
  #borrow<T>(fn: () => T): T {
    if (this.#disposed) throw new HostError("conflict", "Device channel is closing.");
    return this.#call(() => { this.#store.summary(); return fn(); });
  }
  /**
   * Trusted composition seam (root wiring only): legacy HTTP dispatch refuses every action this predicate
   * claims (e.g. a turn-bound device action), and refuses everything if it throws. Set once, before the
   * owner of those actions (the turn surface) admits its first call.
   */
  attachTurnOwnership(owns: (actionId: string) => boolean): void {
    if (typeof owns !== "function" || this.#turnOwnership || this.#admissionStopped) throw new HostError("conflict", "Turn ownership is already fixed.");
    this.#turnOwnership = owns;
  }
  #view(id: string): DeviceView {
    const device = this.#store.getDevice(id), paired = device.revokedAt === null && this.#registry.activeFingerprint(id) !== null;
    return { ...device, paired, presence: device.revokedAt !== null ? "revoked" : paired ? this.#server.authenticatedPresence(id) : "stale" };
  }
  start(): Promise<string> {
    if (this.#admissionStopped) return Promise.reject(new HostError("conflict", "Device channel is closing."));
    return this.#start ??= this.#server.start().catch(error => safeError(error));
  }
  #dispatch(id: string): Promise<Action> {
    try {
      return this.#call(() => {
        const owns = this.#turnOwnership;
        if (owns) { let bound = true; try { bound = owns(id) !== false; } catch { /* fail closed */ } if (bound) throw new HostError("forbidden", "Action is owned by a turn tool surface."); }
        const active = this.#dispatches.get(id); if (active) return active.catch(error => safeError(error));
        const action = this.#store.getAction(id);
        if (!DEVICE_OPERATIONS.has(action.request.tool)) throw new HostError("invalid_input", "Action is not a declared device operation.");
        this.#store.getDevice(action.request.destination);
        // Returning a terminal receipt is read-only replay; unknown never dispatches again.
        if (TERMINAL.includes(action.state)) return Promise.resolve(action);
        // A revoked destination skips the presence gate: the canonical claim blocks it (permission_changed, 403).
        const presence = this.#server.authenticatedPresence(action.request.destination);
        if (action.state === "ready" && presence === "stale")
          throw new HostError("device_unavailable", "Device has no current authenticated presence.");
        if ((presence !== "revoked" && !this.#server.status().listening) || this.#dispatches.size >= this.#maxDispatches)
          throw new HostError("device_unavailable", "Device channel is unavailable.");
        const flight = this.#server.dispatch(id).catch(error => {
          // A rejected finalization can leave a live running action. It cannot count as confirmed cleanup.
          try { if (this.#store.getAction(id).state === "running") this.#unconfirmedAction = true; }
          catch { this.#unconfirmedAction = true; }
          return safeError(error);
        }).finally(() => { if (this.#dispatches.get(id) === flight) this.#dispatches.delete(id); });
        this.#dispatches.set(id, flight); return flight;
      });
    } catch (error) { return Promise.reject(error); }
  }
  /**
   * Trusted guarded dispatch of one canonical action. A typed `DeviceDispatchPreflightError` means nothing was
   * claimed or queued. Authority withdrawn before the claim (revoked device, changed grant, withdrawn
   * capability, expired approval) goes through the canonical claim and resolves blocked/denied without effect.
   * After the claim, every outcome resolves with the canonical terminal action (an execution error resolves
   * `unknown`); a rejection that is not the preflight marker means finalization is unconfirmed, and this
   * instance then permanently refuses to report a confirmed drain.
   */
  #dispatchBound(id: string, context: { signal: AbortSignal; guard: Guard }): Promise<Action> {
    // Read the caller context exactly once; later mutations of the object cannot swap signal or guard.
    let signal: unknown, guard: unknown;
    try { ({ signal, guard } = context); } catch { return Promise.reject(preflight("conflict")); }
    if (!(signal instanceof AbortSignal) || typeof guard !== "function" || typeof id !== "string") return Promise.reject(preflight("conflict"));
    const callback = guard as Guard;
    const bound = (action: Action, peer: DevicePinSnapshot): boolean => { try { return callback(action, peer) === true; } catch { return false; } };
    try {
      if (this.#admissionStopped || this.#disposed) throw preflight("unavailable");
      this.#store.summary();
      // Already claimed or in flight here: a second caller cannot coalesce into it with another guard/signal.
      if (this.#dispatches.has(id) || this.#server.dispatching(id)) throw new HostError("conflict", "Action is already dispatching.");
      const action = this.#store.getAction(id);
      if (TERMINAL.includes(action.state)) return Promise.resolve(action);
      if (action.state === "running") throw new HostError("conflict", "Action is already running.");
      if (action.state !== "ready") throw preflight("conflict");
      const request = action.request;
      if (!DEVICE_OPERATIONS.has(request.tool) || action.requestHash !== hashRequest(request)) throw preflight("forbidden");
      try { checkOperationArgs(request.tool, request.arguments); } catch { throw preflight("forbidden"); }
      let device; try { device = this.#store.getDevice(request.destination); } catch { throw preflight("forbidden"); }
      const now = this.#store.now(), grant = this.#store.getGrant(request.botId, request.tool, request.destination);
      const withdrawn = device.revokedAt !== null || !device.capabilities.includes(request.tool)
        || !grant || grant.policy === "deny" || grant.revision !== action.grantRevision || (grant.expiresAt !== null && now >= grant.expiresAt)
        || (action.approvalExpiresAt !== null && now >= action.approvalExpiresAt);
      if (!withdrawn) {
        if (this.#registry.pinBinding(request.destination)?.status !== "active") throw preflight("unavailable");
        if (this.#server.authenticatedPresence(request.destination) !== "online") throw preflight("unavailable");
        if (signal.aborted) throw preflight("unavailable");
        if (!this.#server.status().listening) throw preflight("unavailable");
      }
      if (this.#dispatches.size >= this.#maxDispatches) throw preflight("unavailable");
      const flight = this.#server.dispatch(id, signal, bound).catch((error: unknown) => {
        let current: Action | null = null;
        try { current = this.#store.getAction(id); } catch { /* unreadable: unconfirmed */ }
        // The canonical claim refused (offline HostStore presence) or the server refused before it.
        if (current?.state === "ready" || current?.state === "awaiting_approval") throw preflight("unavailable");
        // Claim-time block/denial or any terminal state is a confirmed, finalized outcome.
        if (current && TERMINAL.includes(current.state)) return current;
        // A rejected finalization can leave a live running action. It cannot count as confirmed cleanup.
        this.#unconfirmedAction = true;
        return safeError(error instanceof DeviceDispatchPreflightError ? new HostError("conflict", "Device action cleanup is not confirmed.") : error);
      }).finally(() => { if (this.#dispatches.get(id) === flight) this.#dispatches.delete(id); });
      this.#dispatches.set(id, flight);
      return flight;
    } catch (error) {
      if (DeviceDispatchPreflightError.is(error)) return Promise.reject(error);
      try { safeError(error); } catch (mapped) { return Promise.reject(mapped); }
      return Promise.reject(new HostError("conflict", "Device operation could not be completed."));
    }
  }
  /**
   * Permanent, synchronous admission barrier for every facade and the TLS device channel: admin, HTTP, tools
   * and pairing refuse, and the listener stops reaching the canonical store (see `DeviceHostServer.stopAdmission`).
   * Already admitted dispatches still finalize; `close()` drains them and the listener.
   */
  stopAdmission(): void {
    this.#admissionStopped = true;
    this.#server.stopAdmission();
  }
  status(): { listening: boolean; pendingDispatches: number } {
    return { listening: !this.#disposed && this.#server.status().listening, pendingDispatches: this.#dispatches.size };
  }
  toJSON(): object { return this.status(); }
  [inspect.custom](): object { return this.status(); }
  /** Constructor failure only: never started, no async work admitted, no network cleanup to await. */
  disposeUnstarted(): void {
    if (this.#start || this.#dispatches.size) throw new HostError("conflict", "Device channel requires asynchronous drain.");
    this.stopAdmission();
    if (!this.#disposed) { this.#registry.close(); this.#disposed = true; }
  }
  close(): Promise<void> {
    this.stopAdmission();
    return this.#close ??= this.#drain();
  }
  async #drain(): Promise<void> {
    if (this.#disposed) return;
    // Wait for a pending listen before close; otherwise a late listen could outlive the canonical writer.
    if (this.#start) await Promise.allSettled([this.#start]);
    await this.#server.close();
    await Promise.allSettled([...this.#dispatches.values()]);
    if (this.#unconfirmedAction) throw new HostError("conflict", "Device action cleanup is not confirmed.");
    this.#registry.close(); this.#disposed = true;
  }
}
