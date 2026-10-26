import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { constants, X509Certificate } from "node:crypto";
import type { TLSSocket } from "node:tls";
import type { Socket } from "node:net";
import { inspect } from "node:util";
import { MCP_PRIVATE_INPUT_WIRE_LIMITS } from "@dexter/contracts";
import { HostError, type HostStore } from "@dexter/hub";
import type { AuthorizedHostBindings, HostRequestAuthority } from "@dexter/hub/http";
import { DeviceError, fingerprintDer, type ClientBinding, type ClientPairingRegistry, type TlsIdentity } from "@dexter/devices";

export const APP_CLIENT_PROTOCOL = "dexter-app-client-v1";
/** Prefix of the pairing/presence routes that are not part of the canonical Hub API. */
export const APP_CLIENT_PATH = "/app-client/v1";
export const MAX_APP_CLIENT_REQUEST_BYTES = 65_536;
export const MAX_APP_CLIENT_RESPONSE_BYTES = 262_144;
const PRESENCE_WRITE_INTERVAL_MS = 30_000;
/** Ambient/browser/proxy authority is refused outright instead of being ignored. */
const REFUSED_HEADERS = [
  "origin", "cookie", "authorization", "proxy-authorization", "forwarded", "x-forwarded-for", "x-forwarded-host",
  "x-forwarded-proto", "x-real-ip", "content-encoding", "transfer-encoding", "expect", "upgrade", "sec-fetch-site", "sec-fetch-mode",
];
const ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PATH = /^\/[A-Za-z0-9_.:\/-]*(\?[A-Za-z0-9_.:=&%-]*)?$/;
const privateInputGet=(method:string,path:string)=>method==="GET"&&/^\/v1\/mcp\/input-requests\/[A-Za-z0-9_.:-]{1,128}$/.test(path);
const privateInputAnswer=(method:string,path:string)=>method==="POST"&&/^\/v1\/mcp\/input-requests\/[A-Za-z0-9_.:-]{1,128}\/respond$/.test(path);

export interface AppClientServerOptions {
  store: HostStore;
  registry: ClientPairingRegistry;
  router: AuthorizedRouter;
  identity: TlsIdentity;
  listenHost: string;
  port: number;
  /** Exact HTTPS origin the clients dial (`https://host[:port]`), or null to derive it from the listen address. */
  advertisedOrigin: string | null;
  maxConnections: number;
  maxInFlight: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
}
type Body = Record<string, unknown>;
/** Structural Hono router; the authority binding is the only principal it sees. */
export interface AuthorizedRouter { fetch(request: Request, env: AuthorizedHostBindings): Response | Promise<Response> }
interface RequestState { socket: TLSSocket; selfRevoked: boolean }

const STATUS: Record<string, number> = {
  invalid_input: 400, protocol_error: 400, unsupported: 400, forbidden: 403, tls_pin_mismatch: 403, not_found: 404,
  conflict: 409, host_locked: 503, unavailable: 503, device_unavailable: 503, timeout: 504, outcome_unknown: 502,
};
class Refuse extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }

function exactBody(value: Body, keys: readonly string[]): Body {
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some((key) => !keys.includes(key))) throw new Refuse(400, "invalid_input");
  return value;
}

/**
 * Mutual-TLS listener for paired Apple app clients (`client-ios`, `client-mac`). Separate from the Mac agent
 * listener: it never serves `/v1/device/*` poll/receipt routes, and agent-mac pins never authenticate here.
 *
 * TLS 1.3 with a client certificate proves possession; authority is then the approved binding whose active pin
 * equals the SHA-256 of the peer DER, read from the ClientPairingRegistry and the canonical HostStore device. A
 * self-signed certificate that only made a claim can reach `pair/claim` and `pair/status`, nothing else.
 * A resumed session is destroyed before routing, so every served connection performed a full handshake.
 *
 * Every request is finite: bounded JSON body read completely, the binding re-checked before dispatch, inside
 * body-carrying controllers after the await, and once more under the writer fence immediately before the
 * single buffered response (`Content-Length`, `Connection: close`, no compression/redirect/chunked). If that
 * last check fails the body is withheld; a committed effect is never reported as absent.
 */
export class AppClientServer {
  readonly store: HostStore;
  readonly registry: ClientPairingRegistry;
  readonly hostFingerprint: string;
  readonly #identity: TlsIdentity;
  readonly #server: Server;
  readonly #router: AuthorizedRouter;
  readonly #options: AppClientServerOptions;
  private readonly sockets = new Map<TLSSocket, string>();
  /** Includes sockets still handshaking; authority cannot be released before their actual close. */
  private readonly transports = new Map<Socket, Promise<void>>();
  /** Sockets currently carrying a request; revocation closes them after their (withheld) response. */
  private readonly busy = new Map<TLSSocket, RequestState>();
  private readonly doomed = new WeakSet<TLSSocket>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly presence = new Map<string, { at: number; fingerprint: string; written: number }>();
  private closing = false;
  private closed: Promise<void> | null = null;
  private origin: string | null = null;

  constructor(options: AppClientServerOptions) {
    this.#options = options;
    this.store = options.store;
    this.registry = options.registry;
    if (this.registry.installationId !== this.store.hostId || this.registry.ownerId !== this.store.ownerId) {
      throw new DeviceError("conflict", "client registry belongs to another installation");
    }
    this.#identity = options.identity;
    this.#router = options.router;
    this.hostFingerprint = options.identity.fingerprint;
    this.#server = createServer({
      key: this.#identity.keyPem, cert: this.#identity.certPem,
      minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
      // Client certificates are self-signed device keys pinned by fingerprint: CA verification is replaced by
      // the binding check, never skipped. A resumed session (which skips the client certificate) is destroyed.
      requestCert: true, rejectUnauthorized: false, secureOptions: constants.SSL_OP_NO_TICKET,
      maxHeaderSize: 8 * 1024, ALPNProtocols: ["http/1.1"],
    }, (req, res) => { this.track(req, res); });
    this.#server.headersTimeout = options.headersTimeoutMs;
    this.#server.requestTimeout = options.requestTimeoutMs;
    this.#server.keepAliveTimeout = 1_000;
    this.#server.maxHeadersCount = 32;
    this.#server.maxRequestsPerSocket = 1;
    this.#server.on("connection", (socket: Socket) => {
      const closed = new Promise<void>((resolve) => { socket.once("close", () => { this.transports.delete(socket); resolve(); }); });
      this.transports.set(socket, closed);
      if (this.closing || this.transports.size > options.maxConnections) socket.destroy();
    });
    this.#server.on("secureConnection", (socket: TLSSocket) => {
      const cert = socket.getPeerCertificate();
      if (this.closing || this.sockets.size >= options.maxConnections || socket.isSessionReused() || !cert || !cert.raw
        || !validClientCertificate(cert.raw)) {
        socket.destroy();
        return;
      }
      this.sockets.set(socket, fingerprintDer(cert.raw));
      socket.once("close", () => { this.sockets.delete(socket); });
    });
    this.#server.on("tlsClientError", () => { /* handshake failures carry peer-controlled data; nothing is logged */ });
    this.#server.on("clientError", (_error, socket) => { socket.destroy(); });
  }

  async start(): Promise<string> {
    if (this.closing) throw new DeviceError("unavailable", "app client endpoint closing");
    await new Promise<void>((resolve, reject) => {
      const failed = (): void => { reject(new DeviceError("unavailable", "app client endpoint unavailable")); };
      this.#server.once("error", failed);
      this.#server.listen(this.#options.port, this.#options.listenHost, () => { this.#server.off("error", failed); resolve(); });
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string") throw new DeviceError("unavailable", "app client endpoint not listening");
    const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
    this.origin = this.#options.advertisedOrigin ?? `https://${host}:${address.port}`;
    return this.origin;
  }
  /** Exact origin to place in pairing bundles. */
  get url(): string {
    if (this.origin === null) throw new DeviceError("unavailable", "app client endpoint not listening");
    return this.origin;
  }
  get listening(): boolean { return this.#server.listening && !this.closing; }

  /**
   * Closes every connection of the given pins. A socket that is carrying a request is closed right after its
   * response, whose last authority check then fails (body withheld), except a self-revocation ACK.
   */
  dropFingerprints(fingerprints: Iterable<string>): void {
    const set = new Set(fingerprints);
    for (const [socket, fp] of this.sockets) {
      if (!set.has(fp)) continue;
      if (this.busy.has(socket)) this.doomed.add(socket); else socket.destroy();
    }
    for (const [deviceId, seen] of this.presence) if (set.has(seen.fingerprint)) this.presence.delete(deviceId);
  }
  /** Last authenticated contact in this listener lifetime (foreground client), never job availability. */
  authenticatedPresence(deviceId: string): "online" | "stale" | "revoked" {
    const binding = this.registry.binding(deviceId);
    if (!binding || binding.status === "revoked") return "revoked";
    const seen = this.presence.get(deviceId);
    return !this.closing && seen !== undefined && seen.fingerprint === binding.fingerprint
      && this.store.now() - seen.at < this.store.deviceTtlMs ? "online" : "stale";
  }
  status(): { listening: boolean; connections: number; inFlight: number; hostFingerprint: string } {
    return { listening: this.listening, connections: this.sockets.size, inFlight: this.inflight.size, hostFingerprint: this.hostFingerprint };
  }
  toJSON(): object { return this.status(); }
  [inspect.custom](): object { return this.status(); }

  /**
   * Permanently stops admission, closes idle sockets and waits for every admitted request handler until its
   * response is written or abandoned. The cached promise never resolves before all handlers finished.
   */
  /** Synchronous and permanent: no new connection or request is admitted; idle sockets are closed. */
  stopAdmission(): void {
    this.closing = true;
    for (const socket of this.sockets.keys()) if (!this.busy.has(socket)) socket.destroy();
  }
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.stopAdmission();
    const listening = this.#server.listening;
    this.closed = (async () => {
      const stopped = listening ? new Promise<void>((resolve) => { this.#server.close(() => { resolve(); }); }) : Promise.resolve();
      while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
      this.#server.closeAllConnections();
      for (const socket of this.sockets.keys()) socket.destroy();
      const socketCloses = [...this.transports.values()];
      for (const socket of this.transports.keys()) socket.destroy();
      await Promise.all(socketCloses);
      await stopped;
    })();
    return this.closed;
  }

  // ---- HTTP ----------------------------------------------------------------------------------

  private track(req: IncomingMessage, res: ServerResponse): void {
    res.on("error", () => { /* peer went away */ });
    if (this.closing || this.inflight.size >= this.#options.maxInFlight) {
      res.once("finish", () => req.socket.destroy());
      this.send(res, 503, { error: "unavailable" });
      return;
    }
    const socket = req.socket as TLSSocket;
    const state: RequestState = { socket, selfRevoked: false };
    this.busy.set(socket, state);
    const delivered = new Promise<void>((resolve) => { res.once("finish", resolve); res.once("close", resolve); });
    const flight = this.handle(req, res, state).catch(() => { this.send(res, 500, { error: "internal_error" }); }).then(() => delivered).finally(() => {
      this.busy.delete(socket);
      this.inflight.delete(flight);
      if (this.doomed.has(socket) || this.closing) socket.destroy();
    });
    this.inflight.add(flight);
  }

  private async handle(req: IncomingMessage, res: ServerResponse, state: RequestState): Promise<void> {
    let authority: HostRequestAuthority | null = null;
    try {
      const socket = state.socket;
      const fingerprint = this.sockets.get(socket);
      if (fingerprint === undefined || socket.isSessionReused()) throw new Refuse(403, "forbidden");
      const { method, path } = this.preflight(req);
      if (path.startsWith(`${APP_CLIENT_PATH}/pair/`)) {
        const body = await this.readJson(req);
        if (this.closing || this.sockets.get(socket) !== fingerprint || !validClientCertificate(socket.getPeerCertificate().raw)) throw new Refuse(403, "forbidden");
        const out = path === `${APP_CLIENT_PATH}/pair/claim` ? this.pairClaim(fingerprint, body)
          : path === `${APP_CLIENT_PATH}/pair/status` ? this.pairStatus(fingerprint, body) : null;
        if (out === null) throw new Refuse(404, "not_found");
        this.send(res, 200, out);
        return;
      }
      // No unauthenticated byte of the body is read for API routes.
      const binding = this.fence(() => this.authenticate(fingerprint));
      authority = this.authority(binding, state);
      // Dedicated larger envelopes are selected only for an exact private route AND its current approved scope.
      const privateRead=privateInputGet(method,path),privateAnswer=privateInputAnswer(method,path);
      if((privateRead&&!binding.scopes.includes("mcp.read"))||(privateAnswer&&!binding.scopes.includes("mcp.manage")))throw new Refuse(403,"forbidden");
      this.seen(binding, false);
      if (path === `${APP_CLIENT_PATH}/presence`) {
        if (method !== "POST") throw new Refuse(404, "not_found");
        const body = exactBody(await this.readJson(req), ["state"]);
        if (body.state !== "foreground") throw new Refuse(400, "invalid_input");
        authority.assertCurrent();
        this.seen(binding, true);
        this.finish(res, authority, state, 200, Buffer.from(JSON.stringify({ deviceId: binding.deviceId, presence: "online" })));
        return;
      }
      if (path.startsWith(`${APP_CLIENT_PATH}/`) || path.startsWith("/v1/device/")) throw new Refuse(404, "not_found");
      const raw = method === "GET" ? null : await this.readBody(req,privateAnswer?MCP_PRIVATE_INPUT_WIRE_LIMITS.answerBytes:MAX_APP_CLIENT_REQUEST_BYTES);
      authority.assertCurrent();
      const headers: Record<string, string> = method === "GET" ? {} : { "content-type": "application/json" };
      // The router sees a fixed non-local origin; authority travels only as the trusted binding.
      const request = new Request(`https://app-client.invalid${path}`, { method, headers, ...(raw ? { body: new Uint8Array(raw) } : {}) });
      const response = await this.#router.fetch(request, { authority });
      const declared = Number(response.headers.get("content-length") ?? 0);
      const responseLimit=privateRead||privateAnswer?MCP_PRIVATE_INPUT_WIRE_LIMITS.responseBytes:MAX_APP_CLIENT_RESPONSE_BYTES;
      if (declared > responseLimit) throw new Refuse(500, "response_too_large");
      const payload = await this.readResponse(response,responseLimit);
      this.finish(res, authority, state, response.status, payload, method !== "GET");
    } catch (error) {
      const refusal = error instanceof Refuse ? error
        : error instanceof DeviceError || error instanceof HostError ? new Refuse(STATUS[error.code] ?? 503, error.code === "host_locked" ? "unavailable" : error.code)
        : new Refuse(500, "internal_error");
      // After authentication, even an error response is withheld once the binding is no longer current.
      if (authority !== null) {
        this.finish(res, authority, state, refusal.status, Buffer.from(JSON.stringify({ error: refusal.code, ...(refusal.code === "response_too_large" && method(req) !== "GET" ? { effect: "unknown" } : {}) })), method(req) !== "GET");
        return;
      }
      this.send(res, refusal.status, { error: refusal.code });
    }
  }
  /** Synchronous final gate and write. Nothing can interleave between the check and the bytes. */
  private finish(res: ServerResponse, authority: HostRequestAuthority, state: RequestState, status: number, payload: Buffer, mutating = false): void {
    try {
      this.fence(() => { authority.assertCurrent(); });
    } catch {
      if (state.selfRevoked && this.selfRevokeConfirmed(authority.deviceId)) {
        // One minimal ACK of an admitted self-revocation: identifiers and status only, no projection data.
        state.selfRevoked = false;
        this.send(res, 200, { deviceId: authority.deviceId, status: "revoked" });
        return;
      }
      this.send(res, 403, mutating ? { error: "authority_changed", effect: "unknown" } : { error: "forbidden" });
      return;
    }
    this.write(res, status, payload);
  }
  private selfRevokeConfirmed(deviceId: string): boolean {
    try { return this.store.withWriterLease(() => this.store.getDevice(deviceId).revokedAt !== null); } catch { return false; }
  }
  /** Writer fence: a host that lost its lease neither admits nor exposes anything. */
  private fence<T>(fn: () => T): T {
    if (this.closing) throw new Refuse(503, "unavailable");
    return this.store.withWriterLease(fn);
  }
  private authenticate(fingerprint: string): ClientBinding {
    const binding = this.registry.authenticate(fingerprint);
    if (!binding || binding.installationId !== this.store.hostId || binding.ownerId !== this.store.ownerId) throw new Refuse(403, "forbidden");
    return binding;
  }
  private authority(binding: ClientBinding, state: RequestState): HostRequestAuthority {
    const assertCurrent = (): void => {
      if (this.closing || !validClientCertificate(state.socket.getPeerCertificate().raw)) throw new HostError("forbidden", "Listener or certificate is no longer current.");
      if (this.sockets.get(state.socket) !== binding.fingerprint || state.socket.destroyed && !state.selfRevoked) {
        throw new HostError("forbidden", "Client connection is no longer current.");
      }
      const current = this.registry.authenticate(binding.fingerprint);
      if (!current || current.deviceId !== binding.deviceId || current.generation !== binding.generation
        || current.revision !== binding.revision || current.role !== binding.role
        || current.installationId !== binding.installationId || current.ownerId !== binding.ownerId
        || current.scopes.length !== binding.scopes.length || current.scopes.some((scope, index) => scope !== binding.scopes[index])) throw new HostError("forbidden", "Client binding is no longer current.");
    };
    return Object.freeze({
      principal: "paired-client" as const, installationId: binding.installationId, ownerId: binding.ownerId,
      deviceId: binding.deviceId, role: binding.role, scopes: binding.scopes,
      pinGeneration: binding.generation, bindingRevision: binding.revision, assertCurrent,
      noteSelfRevoke: (deviceId: string) => { if (deviceId === binding.deviceId) state.selfRevoked = true; },
    });
  }
  private seen(binding: ClientBinding, explicit: boolean): void {
    const now = this.store.now();
    const previous = this.presence.get(binding.deviceId);
    let written = previous?.fingerprint === binding.fingerprint ? previous.written : 0;
    // Canonical lastSeen is written only for an explicit foreground presence, rate-limited.
    if (explicit && now - written >= PRESENCE_WRITE_INTERVAL_MS) { this.store.heartbeatDevice(binding.deviceId); written = now; }
    this.presence.set(binding.deviceId, { at: now, fingerprint: binding.fingerprint, written });
  }
  private preflight(req: IncomingMessage): { method: "GET" | "POST" | "PATCH" | "PUT"; path: string } {
    if (this.closing) throw new Refuse(503, "unavailable");
    for (const name of Object.keys(req.headers)) if (REFUSED_HEADERS.includes(name) || name.startsWith("x-forwarded-") || name.startsWith("sec-fetch-")) throw new Refuse(400, "invalid_input");
    if (req.httpVersion !== "1.1") throw new Refuse(400, "invalid_input");
    const expected = new URL(this.url).host;
    const host = req.headers.host;
    if (typeof host !== "string" || host.toLowerCase() !== expected.toLowerCase()) throw new Refuse(421, "misdirected");
    const method = req.method;
    if (method !== "GET" && method !== "POST" && method !== "PATCH" && method !== "PUT") throw new Refuse(405, "invalid_input");
    const url = req.url ?? "";
    if (!PATH.test(url) || url.includes("//") || url.includes("..")) throw new Refuse(400, "invalid_input");
    const declared = req.headers["content-length"];
    if (method === "GET") {
      if (declared !== undefined && declared !== "0") throw new Refuse(400, "invalid_input");
    } else {
      const type = req.headers["content-type"];
      if (typeof type !== "string" || type.split(";")[0]!.trim().toLowerCase() !== "application/json") throw new Refuse(415, "invalid_input");
      if (typeof declared !== "string" || !/^\d{1,9}$/.test(declared)) throw new Refuse(411, "invalid_input");
      if (Number(declared) > (privateInputAnswer(method,url)?MCP_PRIVATE_INPUT_WIRE_LIMITS.answerBytes:MAX_APP_CLIENT_REQUEST_BYTES)) throw new Refuse(413, "invalid_input");
    }
    return { method, path: url };
  }
  private pairClaim(fingerprint: string, body: Body): object {
    const v = exactBody(body, ["offerId", "code", "name"]);
    const { claimId } = this.registry.claim({ offerId: v.offerId, code: v.code, name: v.name, clientFingerprint: fingerprint });
    return { claimId, status: "pending" };
  }
  private pairStatus(fingerprint: string, body: Body): object {
    const v = exactBody(body, ["claimId"]);
    if (typeof v.claimId !== "string" || !ROUTE_ID.test(v.claimId)) throw new Refuse(404, "not_found");
    const status = this.registry.claimStatus(v.claimId, fingerprint);
    const approved = status.status === "approved";
    return {
      protocol: APP_CLIENT_PROTOCOL, status: status.status, deviceId: status.deviceId,
      installationId: approved ? this.store.hostId : null, ownerId: approved ? this.store.ownerId : null,
      role: status.role, scopes: [...status.scopes], pinGeneration: status.pinGeneration, bindingRevision: status.bindingRevision,
    };
  }
  private async readResponse(response: Response,maxBytes=MAX_APP_CLIENT_RESPONSE_BYTES): Promise<Buffer> {
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return Buffer.concat(chunks, size);
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Refuse(500, "response_too_large");
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
  }
  private async readJson(req: IncomingMessage): Promise<Body> {
    const raw = await this.readBody(req);
    let value: unknown;
    try { value = JSON.parse(raw.toString("utf8")); } catch { throw new Refuse(400, "invalid_input"); }
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Refuse(400, "invalid_input");
    return value as Body;
  }
  /** Reads exactly the declared Content-Length (bounded); anything else destroys the request. */
  private readBody(req: IncomingMessage,maxBytes=MAX_APP_CLIENT_REQUEST_BYTES): Promise<Buffer> {
    const declared = Number(req.headers["content-length"] ?? "0");
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0, finished = false;
      const fail = (): void => { if (finished) return; finished = true; req.destroy(); reject(new Refuse(400, "invalid_input")); };
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > declared || size > maxBytes) { fail(); return; }
        chunks.push(chunk);
      });
      req.on("error", fail);
      req.on("aborted", fail);
      req.on("end", () => {
        if (finished) return;
        if (size !== declared) { fail(); return; }
        finished = true;
        resolve(Buffer.concat(chunks));
      });
    });
  }
  private send(res: ServerResponse, status: number, body: object): void {
    this.write(res, status, Buffer.from(JSON.stringify(body)));
  }
  private write(res: ServerResponse, status: number, payload: Buffer): void {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, {
      "content-type": "application/json", "content-length": payload.length, "cache-control": "no-store", connection: "close",
      "x-content-type-options": "nosniff",
    });
    res.end(payload);
  }
}
function method(req: IncomingMessage): string { return req.method ?? ""; }

/** Certificate profile for app-client TLS possession; binding authority remains a separate registry check. */
export function validClientCertificate(der: Uint8Array, now = Date.now()): boolean {
  try {
    const certificate = new X509Certificate(der);
    const from = Date.parse(certificate.validFrom), to = Date.parse(certificate.validTo);
    return Number.isFinite(from) && Number.isFinite(to) && from <= now && now < to
      && certificate.publicKey.asymmetricKeyType === "ec"
      && certificate.publicKey.asymmetricKeyDetails?.namedCurve === "prime256v1"
      && certificate.keyUsage?.includes("1.3.6.1.5.5.7.3.2") === true;
  } catch { return false; }
}
