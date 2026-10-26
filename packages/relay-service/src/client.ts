import { Agent, request } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { checkServerIdentity, connect, type PeerCertificate, type TLSSocket } from "node:tls";
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { inspect } from "node:util";
import type { AckRequest, Delivery, Envelope, PollRequest, QueueReceipt } from "@dexter/relay";
import { LIMITS, PATHS, WIRE_STATUS, closedParse, closedSerialize, isWireErrorCode, type WireErrorCode } from "./wire.js";

/**
 * Contract for the relay consumer. Every call is one manual request on a fresh pinned TLS 1.3 connection.
 * No implicit retry, background poll, timer, presence or session reuse. Callers repeat explicitly:
 * the exact same signed envelope (same receipt), the exact same signed ACK inside its window or a fresh
 * ACK nonce for the same pairs, and always a fresh signed poll nonce.
 */
export interface RelayTransport {
  enqueue(envelope: Envelope): Promise<QueueReceipt>;
  poll(request: PollRequest): Promise<{ deliveries: Delivery[]; cursor: number }>;
  ack(request: AckRequest): Promise<{ receiptId: string }>;
  close(): Promise<void>;
}
/**
 * - `rejected`: the service answered with a fixed pre-commit code; the store rolled the operation back.
 *   Wire `internal` is NEVER rejected: the store may have committed before serialization failed.
 * - `not_sent`: the full request never left after a verified TLS 1.3 handshake; no effect is possible.
 * - `unknown`: the request was handed off, but no valid answer arrived. Enqueue/ACK may have committed;
 *   only an explicit exact replay classifies it. A poll nonce may have been consumed.
 */
export type TransportOutcome = "rejected" | "not_sent" | "unknown";
export type TransportErrorCode = WireErrorCode | "tls_identity" | "connect_failed" | "timeout" | "connection_lost" | "response_invalid" | "closed";
export class RelayTransportError extends Error {
  constructor(readonly code: TransportErrorCode, readonly outcome: TransportOutcome) { super(`relay transport ${code} (${outcome})`); this.name = "RelayTransportError"; }
}
export interface PinnedTransportOptions {
  /** TCP address to connect to. */
  host: string;
  port: number;
  /** DNS name that must appear in the leaf SAN. */
  servername: string;
  /** Trust anchor PEM for chain/validity checks; system roots are not used. */
  ca: string | Buffer;
  /** Base64 SHA-256 of the exact leaf certificate DER. */
  leafSha256: string;
  /** Absolute deadline for one whole request, from before the TCP connect through the last response byte. */
  timeoutMs?: number;
}

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const TLS_FAILURE = /CERT|SSL|TLS|VERIFY|ISSUER|SIGNATURE|ALTNAME|PURPOSE|SELF_SIGNED|CHAIN|DEPTH|^EPROTO$/;
const OPTION_KEYS = ["host", "port", "servername", "ca", "leafSha256", "timeoutMs"];
const ENVELOPE_KEYS = ["version", "installationId", "ownerId", "messageId", "senderId", "senderGeneration", "senderKeyId", "recipientId", "recipientGeneration", "recipientKeyId", "type", "sequence", "createdAt", "expiresAt", "ephemeralPublicKey", "nonce", "ciphertext", "tag", "signature"];
function exact(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const own = Object.keys(v);
  return own.length === keys.length && keys.every(k => Object.hasOwn(v, k));
}
const int = (v: unknown, min: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const id = (v: unknown): v is string => typeof v === "string" && ID.test(v);

interface SendState { identity: boolean; secured: boolean; socket: TLSSocket | null }

/** Per-request agent whose createConnection eagerly captures the TLS stream before any 'socket' event. */
class PinnedAgent extends Agent {
  constructor(readonly open: () => TLSSocket) { super({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0 }); }
  override createConnection(): TLSSocket { return this.open(); }
}

export class PinnedRelayTransport implements RelayTransport {
  readonly #host: string;
  readonly #port: number;
  readonly #servername: string;
  readonly #ca: string | Buffer;
  readonly #pin: Buffer;
  readonly #timeoutMs: number;
  readonly #sockets = new Set<TLSSocket>();
  #closed = false;
  #closing: Promise<void> | null = null;

  constructor(options: PinnedTransportOptions) {
    if (options === null || typeof options !== "object" || Object.keys(options).some(k => !OPTION_KEYS.includes(k))) throw new RelayTransportError("invalid_input", "not_sent");
    const { host, port, servername, ca, leafSha256, timeoutMs = 10_000 } = options;
    const pin = typeof leafSha256 === "string" && /^[A-Za-z0-9+/]{43}=$/.test(leafSha256) ? Buffer.from(leafSha256, "base64") : null;
    if (typeof host !== "string" || host.length < 1 || host.length > 253 || !int(port, 1) || port > 65_535
      || typeof servername !== "string" || !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(servername) || isIP(servername) !== 0
      || !(typeof ca === "string" || Buffer.isBuffer(ca)) || ca.length < 1 || ca.length > 65_536 || !pin || pin.length !== 32
      || !int(timeoutMs, 100) || timeoutMs > 60_000) throw new RelayTransportError("invalid_input", "not_sent");
    this.#host = host; this.#port = port; this.#servername = servername; this.#ca = ca; this.#pin = pin; this.#timeoutMs = timeoutMs;
  }
  toJSON(): object { return { host: this.#host, port: this.#port, servername: this.#servername, closed: this.#closed }; }
  [inspect.custom](): object { return this.toJSON(); }

  async enqueue(envelope: Envelope): Promise<QueueReceipt> {
    const r = await this.#send(PATHS.enqueue, envelope, LIMITS.smallResponseBytes);
    if (!exact(r, ["receiptId", "cursor"]) || !id(r.receiptId) || !int(r.cursor, 1)) throw new RelayTransportError("response_invalid", "unknown");
    return { receiptId: r.receiptId, cursor: r.cursor };
  }
  async poll(pollRequest: PollRequest): Promise<{ deliveries: Delivery[]; cursor: number }> {
    // Serialize after the permanent admission check, then read only the trusted snapshot.
    // This rejects accessors and Proxies without invoking caller code and sends these same bytes.
    const body = this.#serialize(pollRequest);
    const snapshot = JSON.parse(body.toString("utf8")) as unknown;
    const limitDescriptor = snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? Object.getOwnPropertyDescriptor(snapshot, "limit") : undefined;
    const limit = limitDescriptor && "value" in limitDescriptor ? limitDescriptor.value : undefined;
    if (typeof limit === "number" && limit > LIMITS.pollLimit) throw new RelayTransportError("poll_limit", "not_sent");
    if (body.length > LIMITS.requestBytes) throw new RelayTransportError("payload_too_large", "not_sent");
    const r = await this.#sendBody(PATHS.poll, body, LIMITS.pollResponseBytes);
    if (!exact(r, ["deliveries", "cursor"]) || !Array.isArray(r.deliveries) || r.deliveries.length > (typeof limit === "number" ? limit : 0) || !int(r.cursor, 0)
      || !r.deliveries.every(d => exact(d, ["cursor", "receiptId", "envelope"]) && int(d.cursor, 1) && id(d.receiptId) && exact(d.envelope, ENVELOPE_KEYS))) throw new RelayTransportError("response_invalid", "unknown");
    return { deliveries: r.deliveries as Delivery[], cursor: r.cursor };
  }
  async ack(ackRequest: AckRequest): Promise<{ receiptId: string }> {
    const r = await this.#send(PATHS.ack, ackRequest, LIMITS.smallResponseBytes);
    if (!exact(r, ["receiptId"]) || !id(r.receiptId)) throw new RelayTransportError("response_invalid", "unknown");
    return { receiptId: r.receiptId };
  }
  /** Permanent; destroys captured TLS streams and resolves after each one's actual 'close' event. */
  close(): Promise<void> {
    this.#closed = true;
    this.#closing ??= (async () => {
      const sockets = [...this.#sockets];
      for (const s of sockets) s.destroy();
      await Promise.all(sockets.map(s => s.closed ? undefined : new Promise<void>(resolve => s.once("close", () => resolve()))));
    })();
    return this.#closing;
  }

  #open(state: SendState): TLSSocket {
    const socket = connect({
      host: this.#host, port: this.#port, servername: this.#servername, ca: this.#ca, rejectUnauthorized: true,
      minVersion: "TLSv1.3", maxVersion: "TLSv1.3", ALPNProtocols: ["http/1.1"],
      checkServerIdentity: (_name: string, cert: PeerCertificate) => {
        const fail = (): Error => { state.identity = true; return new Error("relay tls identity"); };
        if (checkServerIdentity(this.#servername, cert) !== undefined) return fail();
        const leaf = createHash("sha256").update(cert.raw).digest();
        if (!timingSafeEqual(leaf, this.#pin)) return fail();
        const now = Date.now();
        if (!(cert.ext_key_usage ?? []).includes(SERVER_AUTH) || now < Date.parse(cert.valid_from) || now >= Date.parse(cert.valid_to)) return fail();
        return undefined;
      },
    });
    this.#sockets.add(socket);
    state.socket = socket;
    socket.once("close", () => this.#sockets.delete(socket));
    // Chain/validity/protocol failures abort the handshake before any application data can exist.
    socket.on("error", (error: NodeJS.ErrnoException) => { if (!state.secured && typeof error.code === "string" && TLS_FAILURE.test(error.code)) state.identity = true; });
    socket.once("secureConnect", () => {
      if (socket.getProtocol() !== "TLSv1.3" || socket.isSessionReused() || socket.alpnProtocol !== "http/1.1") { state.identity = true; socket.destroy(); return; }
      state.secured = true;
    });
    return socket;
  }

  async #send(path: string, payload: unknown, responseCap: number): Promise<unknown> {
    const body = this.#serialize(payload);
    if (body.length > LIMITS.requestBytes) throw new RelayTransportError("payload_too_large", "not_sent");
    return await this.#sendBody(path, body, responseCap);
  }

  #serialize(payload: unknown): Buffer {
    if (this.#closed) throw new RelayTransportError("closed", "not_sent");
    let body: Buffer;
    try { body = Buffer.from(closedSerialize(payload)); } catch { throw new RelayTransportError("invalid_input", "not_sent"); }
    if (this.#closed) throw new RelayTransportError("closed", "not_sent");
    return body;
  }

  async #sendBody(path: string, body: Buffer, responseCap: number): Promise<unknown> {
    // Admission recheck after serialization: nothing user-supplied may run in between, but close() may have.
    if (this.#closed) throw new RelayTransportError("closed", "not_sent");
    const state: SendState = { identity: false, secured: false, socket: null };
    let finished = false, timedOut = false;
    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const handedOff = (): TransportOutcome => state.secured && finished ? "unknown" : "not_sent";
      // One absolute timer for the whole request, started before the socket exists; no byte can extend it.
      let deadline: NodeJS.Timeout | null = setTimeout(() => {
        timedOut = true;
        settle(() => reject(new RelayTransportError("timeout", handedOff())));
      }, this.#timeoutMs);
      // Exact cleanup: the timer is cleared, then the captured stream is destroyed and its actual 'close' awaited,
      // so no socket outlives the settled call.
      const settle = (f: () => void): void => {
        if (settled) return;
        settled = true;
        if (deadline) { clearTimeout(deadline); deadline = null; }
        const socket = state.socket;
        if (!socket || socket.closed) { f(); return; }
        socket.once("close", f);
        socket.destroy();
      };
      let req: ClientRequest;
      try {
        req = request({
          host: this.#host, port: this.#port, method: "POST", path, agent: new PinnedAgent(() => this.#open(state)),
          headers: { "content-type": "application/json", "content-length": body.length, connection: "close" },
        });
      } catch { settle(() => reject(new RelayTransportError("invalid_input", "not_sent"))); return; }
      req.once("finish", () => { finished = true; });
      req.on("error", () => settle(() => {
        const outcome = state.identity ? "not_sent" : handedOff();
        reject(new RelayTransportError(state.identity ? "tls_identity" : this.#closed ? "closed" : timedOut ? "timeout"
          : outcome === "unknown" ? "connection_lost" : "connect_failed", outcome));
      }));
      req.once("response", (res: IncomingMessage) => {
        const invalid = (): void => settle(() => { reject(new RelayTransportError("response_invalid", handedOff() === "unknown" ? "unknown" : "not_sent")); res.destroy(); req.destroy(); });
        const h = res.headers, length = h["content-length"];
        if (h["transfer-encoding"] !== undefined || h["content-encoding"] !== undefined || h["content-type"] !== "application/json"
          || typeof length !== "string" || !/^(0|[1-9][0-9]{0,6})$/.test(length) || Number(length) > responseCap) return invalid();
        const expected = Number(length), chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > expected) invalid(); else chunks.push(chunk); });
        res.once("error", () => undefined);
        res.once("close", () => { if (!res.complete) settle(() => reject(new RelayTransportError(this.#closed ? "closed" : timedOut ? "timeout" : "connection_lost", "unknown"))); });
        res.once("end", () => {
          if (size !== expected) return invalid();
          let value: Record<string, unknown>;
          try { value = closedParse(Buffer.concat(chunks, size)); } catch { return invalid(); }
          if (res.statusCode === 200) return settle(() => resolve(value));
          const code = value.error;
          if (exact(value, ["error"]) && isWireErrorCode(code) && WIRE_STATUS[code] === res.statusCode) {
            // `internal` can follow a committed store call (serialization/size failure): ambiguous, never rejected.
            const outcome: TransportOutcome = code === "internal" ? "unknown" : "rejected";
            return settle(() => reject(new RelayTransportError(code, outcome)));
          }
          invalid();
        });
      });
      req.end(body);
    });
  }
}
