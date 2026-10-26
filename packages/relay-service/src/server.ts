import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { X509Certificate, constants, createPrivateKey } from "node:crypto";
import { inspect } from "node:util";
import { RelayError, RelayStore, type RelayOptions } from "@dexter/relay";
import { LIMITS, PATHS, WIRE_STATUS, WireFormatError, closedParse, closedSerialize, errorBody, type RelayRoute, type WireErrorCode } from "./wire.js";

/** Exactly one: the service opens/closes its own store, or a trusted caller lends a store it alone closes. */
export type RelayStoreBinding = { readonly own: RelayOptions } | { readonly borrow: RelayStore };
export interface RelayServiceOptions {
  store: RelayStoreBinding;
  /** Server TLS transport credential from a trusted operator (memory/private file). Never an E2E relay key. */
  tls: { key: string | Buffer; cert: string | Buffer };
  host: "127.0.0.1" | "::1";
  port: number;
  timeouts?: { handshakeMs?: number; headersMs?: number; requestMs?: number; drainMs?: number };
  maxConnections?: number;
}
export type RelayServiceErrorCode = "invalid_config" | "tls_config" | "store_unavailable" | "listen_failed" | "store_close_failed";
export class RelayServiceError extends Error {
  constructor(readonly code: RelayServiceErrorCode) { super(`relay service ${code}`); this.name = "RelayServiceError"; }
}
export type RelayServiceState = "serving" | "closing" | "closed" | "quarantined";
export interface RelayServiceStatus {
  state: RelayServiceState; openConnections: number; activeRequests: number;
  acceptedConnections: number; refusedResumptions: number;
  /** Store-local pending ciphertext count; never presence/online/offline. Null when the store is unavailable. */
  pending: number | null;
}

const ROUTES = new Map<string, RelayRoute>(Object.entries(PATHS).map(([route, path]) => [path, route as RelayRoute]));
const ALLOWED_HEADERS = new Set(["host", "content-type", "content-length", "connection"]);
const SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const MAX_PEM = 65_536;

function integer(v: unknown, min: number, max: number): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max; }
function exactKeys(v: unknown, required: readonly string[], optional: readonly string[] = []): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return required.every(k => Object.hasOwn(v, k)) && keys.every(k => required.includes(k) || optional.includes(k));
}
function pem(v: unknown): v is string | Buffer { return (typeof v === "string" || Buffer.isBuffer(v)) && v.length > 0 && v.length <= MAX_PEM; }
function checkTls(key: string | Buffer, cert: string | Buffer, now: number): void {
  try {
    const x509 = new X509Certificate(cert);
    if (!x509.checkPrivateKey(createPrivateKey(key)) || x509.ca || now < x509.validFromDate.getTime() || now >= x509.validToDate.getTime()
      || !(x509.keyUsage ?? []).includes(SERVER_AUTH)) throw new Error();
  } catch { throw new RelayServiceError("tls_config"); }
}

/**
 * Separate-process HTTPS relay transport. Only three POST routes reach RelayStore enqueue/poll/ack; no admin
 * register/revoke/rotate/cleanup route, no Hub/AppClient authority, no presence, timers, WebSocket or push.
 */
export class RelayService {
  readonly #server: Server;
  readonly #store: RelayStore;
  readonly #owned: boolean;
  readonly #drainMs: number;
  readonly #raw = new Set<Socket>();
  readonly #secure = new Set<TLSSocket>();
  readonly #active = new Set<TLSSocket>();
  #admitting = true;
  #state: RelayServiceState = "serving";
  #closing: Promise<void> | null = null;
  #accepted = 0;
  #refusedResumptions = 0;
  #address: { host: string; port: number } = { host: "", port: 0 };

  private constructor(server: Server, store: RelayStore, owned: boolean, drainMs: number) {
    this.#server = server; this.#store = store; this.#owned = owned; this.#drainMs = drainMs;
  }

  static async start(options: RelayServiceOptions): Promise<RelayService> {
    // Validate every trusted option before any state (store, files, sockets) exists.
    if (!exactKeys(options, ["store", "tls", "host", "port"], ["timeouts", "maxConnections"])) throw new RelayServiceError("invalid_config");
    const binding = options.store as Record<string, unknown>;
    const owns = exactKeys(binding, ["own"]), borrows = exactKeys(binding, ["borrow"]);
    if (owns === borrows || (borrows && !(binding.borrow instanceof RelayStore)) || (owns && (binding.own === null || typeof binding.own !== "object"))) throw new RelayServiceError("invalid_config");
    if ((options.host !== "127.0.0.1" && options.host !== "::1") || !integer(options.port, 0, 65_535)) throw new RelayServiceError("invalid_config");
    const t = options.timeouts ?? {};
    if (!exactKeys(t, [], ["handshakeMs", "headersMs", "requestMs", "drainMs"])) throw new RelayServiceError("invalid_config");
    const handshakeMs = t.handshakeMs ?? 5_000, headersMs = t.headersMs ?? 5_000, requestMs = t.requestMs ?? 10_000, drainMs = t.drainMs ?? 5_000;
    const maxConnections = options.maxConnections ?? 32;
    if (![handshakeMs, headersMs, requestMs, drainMs].every(v => integer(v, 100, 60_000)) || headersMs > requestMs || !integer(maxConnections, 1, 256)) throw new RelayServiceError("invalid_config");
    if (!exactKeys(options.tls, ["key", "cert"]) || !pem(options.tls.key) || !pem(options.tls.cert)) throw new RelayServiceError("invalid_config");
    const { key, cert } = options.tls;
    checkTls(key, cert, Date.now());
    // A borrowed store must still be open and fenced: the frozen read-only status() throws host_locked once the
    // store was closed or lost its lease. Refused here, before any socket or state exists.
    if (borrows) try { (binding.borrow as RelayStore).status(); } catch { throw new RelayServiceError("store_unavailable"); }

    let store: RelayStore;
    if (owns) {
      try { store = new RelayStore(binding.own as RelayOptions); } catch { throw new RelayServiceError("store_unavailable"); }
    } else store = (options.store as { borrow: RelayStore }).borrow;

    let server: Server;
    try {
      server = createServer({
        key, cert, minVersion: "TLSv1.3", maxVersion: "TLSv1.3", ALPNProtocols: ["http/1.1"], requestCert: false,
        // No tickets and no session cache: every connection is a fresh full handshake. Node has no 0-RTT API.
        secureOptions: constants.SSL_OP_NO_TICKET, sessionTimeout: 1, handshakeTimeout: handshakeMs,
        maxHeaderSize: LIMITS.headerBytes, headersTimeout: headersMs, requestTimeout: requestMs, keepAliveTimeout: 1,
        insecureHTTPParser: false, joinDuplicateHeaders: false, requireHostHeader: true, noDelay: true,
      });
    } catch {
      if (owns) try { store.close(); } catch { /* startup rollback: frozen close releases its writer in finally */ }
      throw new RelayServiceError("tls_config");
    }
    server.maxRequestsPerSocket = 1;
    server.maxConnections = maxConnections;
    server.timeout = requestMs;
    const service = new RelayService(server, store, owns, drainMs);
    service.#wire();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: options.host, port: options.port, exclusive: true }, () => { server.off("error", reject); resolve(); });
      });
    } catch {
      service.#admitting = false;
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (owns) try { store.close(); } catch { /* startup rollback, see above */ }
      service.#state = "closed";
      throw new RelayServiceError("listen_failed");
    }
    const address = server.address();
    if (address && typeof address === "object") service.#address = { host: address.address, port: address.port };
    return service;
  }

  get address(): { host: string; port: number } { return { ...this.#address }; }
  status(): RelayServiceStatus {
    let pending: number | null = null;
    if (this.#state === "serving") try { pending = this.#store.status().pending; } catch { pending = null; }
    return { state: this.#state, openConnections: this.#raw.size, activeRequests: this.#active.size,
      acceptedConnections: this.#accepted, refusedResumptions: this.#refusedResumptions, pending };
  }
  toJSON(): object { return { state: this.#state, address: this.#address }; }
  [inspect.custom](): object { return this.toJSON(); }

  /** Permanent admission stop, then drain every actual TLS socket before an owned store closes. Same promise on repeat. */
  close(): Promise<void> {
    this.#admitting = false;
    this.#closing ??= this.#shutdown();
    return this.#closing;
  }

  async #shutdown(): Promise<void> {
    this.#state = "closing";
    const listening = new Promise<void>(resolve => this.#server.close(() => resolve()));
    // Secure connections without an admitted request (idle, slow headers) cannot gain admission any more.
    for (const s of this.#secure) if (!this.#active.has(s)) s.destroy();
    const deadline = setTimeout(() => { for (const s of [...this.#raw, ...this.#secure]) s.destroy(); }, this.#drainMs);
    try {
      // Proof of drain is each socket's own 'close' event, never a timer or destroy() call alone.
      await Promise.all([...this.#raw, ...this.#secure].map(s => s.closed ? undefined : new Promise<void>(resolve => s.once("close", () => resolve()))));
      await listening;
    } finally { clearTimeout(deadline); }
    if (this.#owned) {
      try { this.#store.close(); }
      catch { this.#state = "quarantined"; throw new RelayServiceError("store_close_failed"); }
    }
    this.#state = "closed";
  }

  #wire(): void {
    const server = this.#server;
    server.on("connection", (socket: Socket) => {
      if (!this.#admitting) { socket.destroy(); return; }
      this.#raw.add(socket); socket.once("close", () => this.#raw.delete(socket));
    });
    server.on("secureConnection", (socket: TLSSocket) => {
      this.#accepted++;
      if (!this.#admitting || socket.isSessionReused() || socket.getProtocol() !== "TLSv1.3") {
        if (socket.isSessionReused()) this.#refusedResumptions++;
        socket.destroy(); return;
      }
      this.#secure.add(socket); socket.once("close", () => { this.#secure.delete(socket); this.#active.delete(socket); });
    });
    // No upgrade/CONNECT/100-continue path exists; drop such sockets without reading anything.
    server.on("upgrade", (_req: IncomingMessage, socket: Socket) => socket.destroy());
    server.on("connect", (_req: IncomingMessage, socket: Socket) => socket.destroy());
    server.on("checkContinue", (_req: IncomingMessage, res: ServerResponse) => this.#reply(res, "bad_request"));
    server.on("checkExpectation", (_req: IncomingMessage, res: ServerResponse) => this.#reply(res, "bad_request"));
    server.on("request", (req: IncomingMessage, res: ServerResponse) => { void this.#handle(req, res); });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const socket = req.socket as TLSSocket;
    res.shouldKeepAlive = false;
    if (!this.#admitting || !this.#secure.has(socket)) return this.#reply(res, "shutting_down");
    this.#active.add(socket);
    const route = ROUTES.get(req.url ?? "");
    if (req.httpVersion !== "1.1") return this.#reply(res, "version_not_supported");
    if (!route) return this.#reply(res, "not_found");
    if (req.method !== "POST") return this.#reply(res, "method_not_allowed");
    const length = this.#headers(req.rawHeaders);
    if (typeof length === "string") return this.#reply(res, length);
    let body: Buffer;
    try { body = await this.#body(req, length); } catch { socket.destroy(); return; }
    // Admission is rechecked after the asynchronous body read and before any store call.
    if (!this.#admitting) return this.#reply(res, "shutting_down");
    let value: Record<string, unknown>;
    try { value = closedParse(body); } catch { return this.#reply(res, "bad_request"); }
    if (route === "poll" && typeof value.limit === "number" && value.limit > LIMITS.pollLimit) return this.#reply(res, "poll_limit");
    let result: unknown;
    try {
      result = route === "enqueue" ? this.#store.enqueue(value) : route === "poll" ? this.#store.poll(value) : this.#store.ack(value);
    } catch (e) {
      return this.#reply(res, e instanceof RelayError && Object.hasOwn(WIRE_STATUS, e.code) ? e.code : "internal");
    }
    let out: Buffer;
    try { out = Buffer.from(closedSerialize(result)); } catch { return this.#reply(res, "internal"); }
    if (out.length > (route === "poll" ? LIMITS.pollResponseBytes : LIMITS.smallResponseBytes)) return this.#reply(res, "internal");
    this.#send(res, 200, out);
  }

  #headers(raw: string[]): number | WireErrorCode {
    const seen = new Map<string, string>();
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const name = raw[i]!.toLowerCase();
      if (!ALLOWED_HEADERS.has(name) || seen.has(name)) return "bad_request";
      seen.set(name, raw[i + 1]!);
    }
    const length = seen.get("content-length"), connection = seen.get("connection");
    if (!seen.get("host") || length === undefined || !/^[1-9][0-9]{0,6}$/.test(length)) return "bad_request";
    if (connection !== undefined && connection.toLowerCase() !== "close") return "bad_request";
    if (seen.get("content-type") !== "application/json") return "unsupported_media_type";
    const n = Number(length);
    return n > LIMITS.requestBytes ? "payload_too_large" : n;
  }

  #body(req: IncomingMessage, length: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []; let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > length) { req.destroy(); reject(new WireFormatError()); return; }
        chunks.push(chunk);
      });
      req.once("end", () => size === length ? resolve(Buffer.concat(chunks, size)) : reject(new WireFormatError()));
      req.once("error", () => reject(new WireFormatError()));
      req.once("close", () => { if (!req.complete) reject(new WireFormatError()); });
    });
  }

  #reply(res: ServerResponse, code: WireErrorCode): void { this.#send(res, WIRE_STATUS[code], errorBody(code)); }
  #send(res: ServerResponse, status: number, body: Buffer): void {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { "content-type": "application/json", "content-length": body.length, "cache-control": "no-store", connection: "close" });
    res.end(body);
  }
}
