import { createPrivateKey, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { createSecureContext } from "node:tls";
import { inspect } from "node:util";
import type { Grant } from "@dexter/contracts";
import { HostError, type ClientDeviceRole, type ClientDeviceScope, type ConversationRuntime, type HostStore } from "@dexter/hub";
import { createAuthorizedHostRouter, type HostDevicePort, type HostGrantPort, type HostOutputFilesPort, type HostConnectionsPort, type HostMcpPort, type HostConnectionWorkflowsPort } from "@dexter/hub/http";
import {
  ClientPairingRegistry, DEVICE_OPERATIONS, DeviceError, TlsIdentity, certificateFingerprint,
  type ClientOfferInput, type ClientPendingClaim, type ClientBinding, type ClientClaimRecord,
} from "@dexter/devices";
import { AppClientServer, APP_CLIENT_PROTOCOL } from "./app-client-server.js";
import { HostPeerProjection } from "./host-peer-projection.js";

export interface AppClientServicesOptions {
  /** Host TLS identity: P-256 named curve, currently valid, SAN covering the advertised host. Never generated here. */
  identity: TlsIdentity;
  /** IP literal to bind. Defaults to loopback; a wildcard address is refused. */
  listenHost?: string;
  port?: number;
  /** Exact `https://host[:port]` origin clients dial. Defaults to the actual listen address. */
  advertisedOrigin?: string;
  offerTtlMs?: number;
  maxConnections?: number;
  maxInFlight?: number;
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
}
type ValidOptions = Readonly<Required<Omit<AppClientServicesOptions, "advertisedOrigin">> & { advertisedOrigin: string | null }>;

/** Out-of-band material for the owner's private transfer (QR/file). Contains the one-time code: never log it. */
export interface AppClientPairingBundle {
  protocol: typeof APP_CLIENT_PROTOCOL;
  installationId: string;
  hostUrl: string;
  /** Public host certificate (DER, base64) and its SHA-256 pin. */
  hostCertificateDER: string;
  hostFingerprint: string;
  offerId: string;
  kind: "pair" | "rotate";
  role: ClientDeviceRole;
  scopes: ClientDeviceScope[];
  deviceId: string | null;
  expiresAt: number;
  code: string;
}
export interface AppClientAdmin {
  /** `ttlMs` may only shorten the configured offer lifetime. */
  pairingBundle(input: ClientOfferInput, ttlMs?: number): AppClientPairingBundle;
  /** Read-only registry state of one offer issued by this channel; null when unknown here. */
  offerState(offerId: string): { status: "open" | "claimed" | "cancelled" | "exhausted" | "expired"; expiresAt: number } | null;
  /** Owner review: pending claims with their offer/pin (bounded) and one claim in any state. Read-only. */
  pendingClaimRecords(limit?: number): ClientClaimRecord[];
  claimRecord(claimId: string): ClientClaimRecord | null;
  pendingClaims(): ClientPendingClaim[];
  approveClaim(claimId: string): { deviceId: string; fingerprint: string };
  rejectClaim(claimId: string): void;
  cancelOffer(offerId: string): void;
}
/** Live public facts of the channel offers are issued for (owner pairing status). No key material. */
export interface AppClientPairingChannel {
  listening: boolean;
  installationId: string;
  /** Exact origin placed in invitations; null until the listener started. */
  hostUrl: string | null;
  hostFingerprint: string;
  /** Host certificate validity (ms since epoch), read from the operator-supplied identity. */
  certificateNotBefore: number;
  certificateNotAfter: number;
  offerTtlMs: number;
}
/** Trusted agent-mac ports borrowed from DeviceServices; never constructed from a request. */
export interface AppClientDeviceSource {
  http: Readonly<HostDevicePort>;
  admin: Readonly<{ grant(input: unknown): Grant }>;
  tools: Readonly<{ snapshot(deviceId: string): { status: "active" | "revoked" } | null }>;
}

function invalid(): never { throw new HostError("invalid_input", "Invalid app client configuration."); }
function bound(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return invalid();
  return value;
}
function coversHost(cert: X509Certificate, host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return isIP(bare) !== 0 ? cert.checkIP(bare) !== undefined : cert.checkHost(bare, { wildcards: false, subject: "never" }) !== undefined;
}
/**
 * Pure validation/snapshot before opening any canonical state: no socket, file, database or request. The
 * identity is copied into a fresh TlsIdentity and checked for P-256 named curve, validity, key match, TLS 1.3
 * context and a SAN covering the exact advertised host (hostname verification is never relaxed by the pin).
 */
export function validateAppClientServicesOptions(input: AppClientServicesOptions): Readonly<AppClientServicesOptions> {
  const { advertisedOrigin, ...rest } = normalizeOptions(input);
  return Object.freeze({ ...rest, ...(advertisedOrigin !== null ? { advertisedOrigin } : {}) });
}
function normalizeOptions(input: AppClientServicesOptions): ValidOptions {
  try {
    const config = { ...input };
    if (Object.keys(config).some(key => !["identity", "listenHost", "port", "advertisedOrigin", "offerTtlMs", "maxConnections",
      "maxInFlight", "headersTimeoutMs", "requestTimeoutMs"].includes(key))) return invalid();
    const raw = config.identity;
    const certPem = raw.certPem, keyPem = raw.keyPem, fingerprint = raw.fingerprint;
    if (typeof certPem !== "string" || typeof keyPem !== "string" || typeof fingerprint !== "string" || certPem.length > 65536 || keyPem.length > 65536) return invalid();
    const cert = new X509Certificate(certPem);
    if (!cert.checkPrivateKey(createPrivateKey(keyPem)) || certificateFingerprint(certPem) !== fingerprint) return invalid();
    const details = cert.publicKey.asymmetricKeyDetails;
    if (cert.publicKey.asymmetricKeyType !== "ec" || details?.namedCurve !== "prime256v1") return invalid();
    const now = Date.now();
    if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now) return invalid();
    createSecureContext({ cert: certPem, key: keyPem, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" });
    const listenHost = config.listenHost ?? "127.0.0.1";
    if (typeof listenHost !== "string" || isIP(listenHost) === 0 || ["0.0.0.0", "::", "::0"].includes(listenHost)) return invalid();
    let advertisedOrigin: string | null = null;
    if (config.advertisedOrigin !== undefined) {
      if (typeof config.advertisedOrigin !== "string" || config.advertisedOrigin.length > 512) return invalid();
      const url = new URL(config.advertisedOrigin);
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
        || url.origin !== config.advertisedOrigin || !coversHost(cert, url.hostname)) return invalid();
      advertisedOrigin = url.origin;
    } else if (!coversHost(cert, listenHost.includes(":") ? `[${listenHost}]` : listenHost)) return invalid();
    const requestTimeoutMs = bound(config.requestTimeoutMs, 15_000, 1_000, 120_000);
    const headersTimeoutMs = bound(config.headersTimeoutMs, 10_000, 500, 60_000);
    if (headersTimeoutMs > requestTimeoutMs) return invalid();
    return Object.freeze({ identity: new TlsIdentity(certPem, keyPem, fingerprint), listenHost, advertisedOrigin,
      port: bound(config.port, 0, 0, 65535), offerTtlMs: bound(config.offerTtlMs, 10 * 60_000, 1_000, 60 * 60_000),
      maxConnections: bound(config.maxConnections, 64, 1, 1024), maxInFlight: bound(config.maxInFlight, 32, 1, 512),
      headersTimeoutMs, requestTimeoutMs });
  } catch { return invalid(); }
}

function safeError(error: unknown): never {
  if (error instanceof HostError) throw error;
  if (error instanceof DeviceError) {
    const code = error.code === "not_found" ? "not_found" : error.code === "forbidden" ? "forbidden"
      : error.code === "invalid_input" ? "invalid_input" : error.code === "unavailable" ? "device_unavailable" : "conflict";
    throw new HostError(code, "App client operation could not be completed.");
  }
  throw new HostError("conflict", "App client operation could not be completed.");
}
const GRANT_KEYS = ["botId", "tool", "destination", "policy", "expiresAt", "expectedRevision"];

/**
 * Owns the paired app-client channel of one HostServices lifetime: its private registry, the unified device
 * projection and the mutual-TLS listener over the existing HostStore/runtime (never a second writer). Disabled
 * unless explicitly configured; nothing listens until `start()`.
 */
export class AppClientServices {
  readonly admin: Readonly<AppClientAdmin>;
  /** Borrowed frozen read-only canonical binding port; no offers, grants or mutable registry. */
  readonly bindings: Readonly<{ binding(deviceId:string):Readonly<ClientBinding>|null }>;
  readonly projection: HostPeerProjection;
  /** Local loopback device seam over the projection, refused once admission stops (like DeviceServices.http). */
  readonly peersHttp: Readonly<HostDevicePort>;
  readonly grants: Readonly<HostGrantPort>;
  readonly #store: HostStore;
  readonly #registry: ClientPairingRegistry;
  readonly #server: AppClientServer;
  readonly #certificateDer: string;
  readonly #certificateValidity: { notBefore: number; notAfter: number };
  #admissionStopped = false;
  #start: Promise<string> | null = null;
  #close: Promise<void> | null = null;
  #disposed = false;

  constructor(store: HostStore, options: AppClientServicesOptions, deps: { runtime?: ConversationRuntime; devices?: AppClientDeviceSource;
    /** This base's output folders, reachable only with the exact outputs.read / outputs.manage scopes. */
    outputFiles?: Readonly<HostOutputFilesPort>; connections?:Readonly<HostConnectionsPort>;mcp?:Readonly<HostMcpPort>;connectionWorkflows?:Readonly<HostConnectionWorkflowsPort> } = {}) {
    const config = normalizeOptions(options);
    this.#store = store;
    const certificate = new X509Certificate(config.identity.certPem);
    this.#certificateDer = certificate.raw.toString("base64");
    this.#certificateValidity = { notBefore: Date.parse(certificate.validFrom), notAfter: Date.parse(certificate.validTo) };
    this.#registry = new ClientPairingRegistry(store, { offerTtlMs: config.offerTtlMs, reservedFingerprints: [config.identity.fingerprint] });
    try {
      const devices = deps.devices;
      let server: AppClientServer | null = null;
      this.projection = new HostPeerProjection(store, {
        clients: {
          registry: this.#registry,
          authenticatedPresence: (id) => server!.authenticatedPresence(id),
          dropFingerprints: (fps) => { server!.dropFingerprints(fps); },
        },
        ...(devices ? { agent: devices.http } : {}),
      });
      this.grants = Object.freeze({
        list: (botId: string) => this.#call(() => this.#listGrants(botId, devices)),
        put: (input: unknown) => this.#call(() => this.#putGrant(input, devices)),
      });
      const router = createAuthorizedHostRouter(store, {
        ...(deps.runtime ? { runtime: deps.runtime } : {}), peers: this.projection, grants: this.grants,
        ...(deps.outputFiles ? { outputFiles: deps.outputFiles } : {}),
        ...(deps.connections?{connections:deps.connections}:{}),...(deps.mcp?{mcp:deps.mcp}:{}),...(deps.connectionWorkflows?{connectionWorkflows:deps.connectionWorkflows}:{}),
      });
      server = new AppClientServer({ store, registry: this.#registry, router, identity: config.identity,
        listenHost: config.listenHost, port: config.port, advertisedOrigin: config.advertisedOrigin,
        maxConnections: config.maxConnections, maxInFlight: config.maxInFlight,
        headersTimeoutMs: config.headersTimeoutMs, requestTimeoutMs: config.requestTimeoutMs });
      this.#server = server;
    } catch (error) {
      this.#registry.close();
      throw error;
    }
    this.bindings = Object.freeze({binding:(deviceId:string)=>this.#call(()=>store.withWriterLease(()=>this.#registry.binding(deviceId)))});
    const http = this.projection.http;
    this.peersHttp = Object.freeze({
      list: () => this.#call(() => http.list()), get: (id: string) => this.#call(() => http.get(id)),
      rename: (id: string, input: unknown) => this.#call(() => http.rename(id, input)),
      revoke: (id: string) => this.#call(() => http.revoke(id)),
      dispatch: (id: string) => this.#call(() => http.dispatch(id)),
      status: () => this.#call(() => http.status()),
    });
    this.admin = Object.freeze({
      pairingBundle: (input: ClientOfferInput, ttlMs?: number) => this.#call(() => this.#bundle(input, ttlMs)),
      offerState: (id: string) => this.#call(() => this.#registry.offerState(id)),
      pendingClaimRecords: (limit?: number) => this.#call(() => this.#registry.pendingClaimRecords(limit)),
      claimRecord: (id: string) => this.#call(() => this.#registry.claimRecord(id)),
      pendingClaims: () => this.#call(() => this.#registry.listPendingClaims()),
      approveClaim: (id: string) => this.#call(() => this.#registry.approveClaim(id)),
      rejectClaim: (id: string) => this.#call(() => this.#registry.rejectClaim(id)),
      cancelOffer: (id: string) => this.#call(() => this.#registry.cancelOffer(id)),
    });
  }

  start(): Promise<string> {
    if (this.#admissionStopped) return Promise.reject(new HostError("conflict", "App client channel is closing."));
    return this.#start ??= this.#server.start().catch(error => safeError(error));
  }
  status(): { listening: boolean; connections: number; inFlight: number } {
    const { listening, connections, inFlight } = this.#server.status();
    return { listening: !this.#disposed && listening, connections, inFlight };
  }
  /** Public channel facts for the owner pairing status; refused once admission stopped (like every admin call). */
  pairingChannel(): AppClientPairingChannel {
    return this.#call(() => {
      const { listening } = this.#server.status();
      let hostUrl: string | null = null;
      if (listening) { try { hostUrl = this.#server.url; } catch { hostUrl = null; } }
      return { listening: listening && hostUrl !== null, installationId: this.#store.hostId, hostUrl, hostFingerprint: this.#server.hostFingerprint,
        certificateNotBefore: this.#certificateValidity.notBefore, certificateNotAfter: this.#certificateValidity.notAfter, offerTtlMs: this.#registry.offerTtlMs };
    });
  }
  toJSON(): object { return this.status(); }
  [inspect.custom](): object { return this.status(); }
  /** Synchronous and permanent; retained admin/projection references are refused afterwards. */
  stopAdmission(): void {
    this.#admissionStopped = true;
    this.projection.stopAdmission();
    this.#server.stopAdmission();
  }
  /** Constructor failure of the owner only: never started, nothing asynchronous admitted. */
  disposeUnstarted(): void {
    if (this.#start) throw new HostError("conflict", "App client channel requires asynchronous drain.");
    this.stopAdmission();
    if (!this.#disposed) { this.#registry.close(); this.#disposed = true; }
  }
  /** Drains every admitted request/response (including revocation ACKs) before closing the registry. */
  close(): Promise<void> {
    this.stopAdmission();
    return this.#close ??= this.#drain();
  }
  async #drain(): Promise<void> {
    if (this.#disposed) return;
    if (this.#start) await Promise.allSettled([this.#start]);
    await this.#server.close();
    this.#registry.close();
    this.#disposed = true;
  }
  #call<T>(fn: () => T): T {
    if (this.#admissionStopped || this.#disposed) throw new HostError("conflict", "App client channel is closing.");
    try { return fn(); } catch (error) { return safeError(error); }
  }
  #bundle(input: ClientOfferInput, ttlMs?: number): AppClientPairingBundle {
    const hostUrl = this.#server.url;
    const offer = this.#registry.createOffer(input, ttlMs);
    return {
      protocol: APP_CLIENT_PROTOCOL, installationId: this.#store.hostId, hostUrl, hostCertificateDER: this.#certificateDer,
      hostFingerprint: this.#server.hostFingerprint, offerId: offer.offerId, kind: offer.kind, role: offer.role, scopes: [...offer.scopes],
      deviceId: offer.deviceId, expiresAt: offer.expiresAt, code: offer.code,
    };
  }
  /** Agent-mac destinations of one owner bot: every pinned, unrevoked agent device × declared operation. */
  #agentDestinations(devices: AppClientDeviceSource): { deviceId: string; tool: string }[] {
    const out: { deviceId: string; tool: string }[] = [];
    for (const device of this.#store.listDevices()) {
      if (device.revokedAt !== null || this.#registry.isClientDevice(device.id)) continue;
      if (devices.tools.snapshot(device.id)?.status !== "active") continue;
      for (const tool of device.capabilities) if (DEVICE_OPERATIONS.has(tool)) out.push({ deviceId: device.id, tool });
    }
    return out;
  }
  #listGrants(botId: string, devices: AppClientDeviceSource | undefined): object {
    if (!devices) throw new HostError("device_unavailable", "Device grants are not configured.");
    this.#store.getBot(botId);
    return { botId, items: this.#agentDestinations(devices).map(({ deviceId, tool }) => ({
      botId, tool, destination: deviceId, grant: this.#store.getGrant(botId, tool, deviceId),
    })) };
  }
  /**
   * Strict compare-and-set. The check and the canonical write run synchronously with no await in between, and
   * the HostStore is the only writer, so a stale UI revision cannot overwrite a newer decision. Client devices
   * are never destinations; the agent-mac check (pin, capability, declared operation) is DeviceServices'.
   */
  #putGrant(input: unknown, devices: AppClientDeviceSource | undefined): Grant {
    if (!devices) throw new HostError("device_unavailable", "Device grants are not configured.");
    if (input === null || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new HostError("invalid_input", "Invalid grant.");
    const raw = input as Record<string, unknown>;
    const keys = Object.keys(raw);
    if (keys.length !== GRANT_KEYS.length || keys.some(key => !GRANT_KEYS.includes(key))) throw new HostError("invalid_input", "Invalid grant fields.");
    const expected = raw.expectedRevision;
    if (expected !== null && (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 1)) throw new HostError("invalid_input", "Invalid expected revision.");
    if (typeof raw.botId !== "string" || typeof raw.tool !== "string" || typeof raw.destination !== "string") throw new HostError("invalid_input", "Invalid grant.");
    if (this.#registry.isClientDevice(raw.destination)) throw new HostError("forbidden", "App clients are not tool destinations.");
    this.#store.getBot(raw.botId);
    const current = this.#store.getGrant(raw.botId, raw.tool, raw.destination);
    if ((current?.revision ?? null) !== expected) throw new HostError("conflict", "Grant revision changed.");
    return devices.admin.grant({ botId: raw.botId, tool: raw.tool, destination: raw.destination, policy: raw.policy, expiresAt: raw.expiresAt });
  }
}
