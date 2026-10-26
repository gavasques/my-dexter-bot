import type { RelayHostAdmin } from "@dexter/relay-host";
import type { DevicePin } from "@dexter/relay";
import { ConsumerError, type AckReconcileInput, type AckReconcileStatus, type PendingAckPage } from "@dexter/relay-consumer";
import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, realpathSync, rmdirSync, unlinkSync, type Stats } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { inspect } from "node:util";
import { CLIENT_DEVICE_SCOPES, HostError, type ClientDeviceRole, type ClientDeviceScope } from "@dexter/hub";

/**
 * Local owner control of a running host: one Unix domain socket in a private directory, a closed set of owner
 * pairing operations, and nothing else. It lets the `dexter app-client` commands reach the SAME live
 * HostServices (its writer, registry and TLS listener) instead of opening a second HostStore. Personal mode:
 * every process of the same OS user is trusted as the owner (bots included); this is not OS isolation.
 */
export const OWNER_CONTROL_PROTOCOL = "dexter-owner-control-v1";
/** Upper bound of one frame payload (request or response), excluding the 4-byte length prefix. */
export const OWNER_CONTROL_MAX_FRAME = 65_536;
/** Below sun_path on macOS (104) and Linux (108), counting bytes. */
export const OWNER_CONTROL_MAX_PATH_BYTES = 100;
/** Length of the private bind name `.o<12 hex>` that the listener uses before the socket is linked to its path. */
const BIND_NAME_BYTES = 14;
export const OWNER_CONTROL_MAX_CLAIMS = 50;
export const OWNER_CONTROL_OPERATIONS = Object.freeze(["status", "offer.create", "claims.list", "claim.approve", "claim.reject", "offer.cancel", "relay.binding", "relay.recipient", "relay.enroll", "relay.revoke", "relay.rotate-recipient", "authority.transfer",
  "relay.acks", "relay.ack-reconcile", "relay.recovery.status", "relay.recovery.peer", "relay.recovery.rotate", "relay.recovery.enroll", "relay.recovery.acks"] as const);
export type OwnerControlOperation = typeof OWNER_CONTROL_OPERATIONS[number];
export const OWNER_CONTROL_MUTATIONS: ReadonlySet<OwnerControlOperation> = new Set(["offer.create", "claim.approve", "claim.reject", "offer.cancel", "relay.enroll", "relay.revoke", "relay.rotate-recipient",
  "relay.ack-reconcile", "relay.recovery.rotate", "relay.recovery.enroll"]);
export const OWNER_CONTROL_ERRORS = Object.freeze(["invalid_request", "closing", "host_locked", "invalid_input", "not_found", "conflict",
  "forbidden", "unavailable", "fingerprint_mismatch", "response_too_large", "internal", "authority_unavailable", "busy"] as const);
export type OwnerControlErrorCode = typeof OWNER_CONTROL_ERRORS[number];
/** `none`: refused before the backend operation was invoked. `unknown`: it was invoked; reconcile, never retry blindly. */
export type OwnerControlEffect = "none" | "unknown";

export type OwnerOfferInput =
  | { kind: "pair"; role: ClientDeviceRole; scopes: readonly ClientDeviceScope[] }
  | { kind: "rotate"; deviceId: string };
/** Structural copy of the AppClient pairing bundle. Carries the one-time code: private transfer only, never log. */
export interface OwnerPairingBundle {
  protocol: string; installationId: string; hostUrl: string; hostCertificateDER: string; hostFingerprint: string;
  offerId: string; kind: "pair" | "rotate"; role: ClientDeviceRole; scopes: readonly ClientDeviceScope[];
  deviceId: string | null; expiresAt: number; code: string;
}
export interface OwnerPendingClaim {
  claimId: string; kind: "pair" | "rotate"; role: ClientDeviceRole; scopes: readonly ClientDeviceScope[];
  deviceId: string | null; clientFingerprint: string; name: string; expiresAt: number;
}
/** Structurally the AppClientAdmin facade of AppClientServices; this module never constructs it. */
export interface OwnerAppClientAdminPort {
  pairingBundle(input: OwnerOfferInput): OwnerPairingBundle;
  pendingClaims(): readonly OwnerPendingClaim[];
  approveClaim(claimId: string): { deviceId: string; fingerprint: string };
  rejectClaim(claimId: string): void;
  cancelOffer(offerId: string): void;
}
/** Trusted in-process ports of one HostServices lifetime. Nothing here comes from a request. */
export interface OwnerTransferRequest { requestId: string; artifactPath: string; destinationPath: string }
/** Closed owner relay enrollment request: public ids/revisions and the sender's PUBLIC next pin. The canonical binding is
 * looked up server-side (fresh, live) and CAS-checked by `bindingRevision`; it is never supplied by the caller. */
export interface OwnerRecoveryEnroll { deviceId: string; expectedRevision: number | null; expectedHostRevision: number; bindingRevision: number; senderPin: DevicePin }
/** Structurally the trusted HostServices relay recovery facade (explicit recovery mode only). Public data only. */
export interface OwnerRelayRecoveryPort {
  status(): Record<string, unknown>;
  peer(deviceId: string): Record<string, unknown>;
  rotate(input: { pin: DevicePin; expectedHostRevision: number }): Record<string, unknown>;
  enroll(input: OwnerRecoveryEnroll): Record<string, unknown>;
  acks(input: { limit: number; after?: string }): PendingAckPage;
}
export interface OwnerMaintenanceReservation { result: Record<string, unknown>; afterConnection(): void; cancel(): void }
export interface OwnerControlPorts {
  /** Resolved synchronously per admitted request; the host getter refuses once its shutdown began. */
  admin(): Readonly<OwnerAppClientAdminPort>;
  /** Canonical writer-lease check on the same HostStore; throws when the lease is not held. */
  assertWriter(): void;
  installationId: string;
  /** Optional trusted SAME-host public relay admin; never keys or generic dispatch. */
  relay?():Readonly<RelayHostAdmin>;
  reserveMaintenance?(request: OwnerTransferRequest): OwnerMaintenanceReservation;
  /** Optional trusted SAME-host relay recovery facade; present only in explicit recovery mode. */
  recovery?(): Readonly<OwnerRelayRecoveryPort>;
}
export interface OwnerControlOptions {
  /** Absolute canonical path of the socket. Its parent is a private directory of this user (created 0700 if absent). */
  socketPath: string;
  /** Absolute deadline per connection, from accept to close. */
  requestTimeoutMs?: number;
  maxConnections?: number;
}
type ValidOptions = Readonly<Required<OwnerControlOptions>>;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const SOCKET_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const SCOPES: readonly string[] = CLIENT_DEVICE_SCOPES;

function invalid(): never { throw new HostError("invalid_input", "Invalid owner control configuration."); }
function bound(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return invalid();
  return value;
}
/** Pure string-level check, shared by server and client. No filesystem access. */
export function validateOwnerControlPath(path: unknown): string {
  if (typeof path !== "string" || path.includes("\0") || !isAbsolute(path) || normalize(path) !== path || path.endsWith("/")
    || Buffer.byteLength(path, "utf8") > OWNER_CONTROL_MAX_PATH_BYTES) return invalid();
  const name = basename(path);
  if (!SOCKET_NAME.test(name) || name === "." || name === ".." || dirname(path) === path) return invalid();
  if (Buffer.byteLength(dirname(path), "utf8") + 1 + BIND_NAME_BYTES > OWNER_CONTROL_MAX_PATH_BYTES) return invalid();
  return path;
}
export function validateOwnerControlOptions(input: OwnerControlOptions): ValidOptions {
  try {
    const config = { ...input };
    if (Object.keys(config).some(key => !["socketPath", "requestTimeoutMs", "maxConnections"].includes(key))) return invalid();
    return Object.freeze({ socketPath: validateOwnerControlPath(config.socketPath),
      requestTimeoutMs: bound(config.requestTimeoutMs, 5_000, 500, 30_000), maxConnections: bound(config.maxConnections, 8, 1, 64) });
  } catch { return invalid(); }
}
export function currentUid(): number {
  const uid = process.getuid?.();
  if (typeof uid !== "number") throw new HostError("conflict", "Owner control requires a Unix platform.");
  return uid;
}
function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
/** Each ancestor must be owned by root or this user and not writable by others unless sticky. */
function checkAncestors(dir: string, uid: number): void {
  for (let current = dirname(dir); ; current = dirname(current)) {
    const st = lstatSync(current);
    if (!st.isDirectory() || (st.uid !== 0 && st.uid !== uid) || ((st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0))
      throw new HostError("conflict", "Owner control directory has an unsafe ancestor.");
    if (dirname(current) === current) return;
  }
}
/** Existing private dir of this user, never a symlink, canonical; `create` makes only the last component. */
export function privateControlDirectory(dir: string, uid: number, create: boolean): { created: boolean } {
  let created = false;
  if (lstatOrNull(dir) === null) {
    if (!create) throw new HostError("not_found", "Owner control directory is absent.");
    checkAncestors(dir, uid);
    mkdirSync(dir, { mode: 0o700 });
    created = true;
  }
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0 || realpathSync(dir) !== dir)
      throw new HostError("conflict", "Owner control directory must be a private canonical directory of this user.");
    checkAncestors(dir, uid);
  } catch (error) {
    if (created) try { rmdirSync(dir); } catch { /* left for the owner; never recursive */ }
    throw error instanceof HostError ? error : new HostError("conflict", "Owner control directory is not usable.");
  }
  return { created };
}

// ---- canonical framed JSON ----------------------------------------------------------------------

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError("not JSON");
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
/** Strict UTF-8 (no BOM), canonical form only: duplicate keys, whitespace or alternative encodings are refused. */
export function decodeCanonical(payload: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload);
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new SyntaxError("non-canonical JSON");
  return value;
}
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(canonicalJson(value), "utf8");
  if (body.length > OWNER_CONTROL_MAX_FRAME) throw new RangeError("frame too large");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}
/** Reads exactly one frame. Oversized, empty, or trailing bytes in the same read fail; the socket is then paused. */
export function readFrame(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const finish = (error: Error | null, value?: Buffer): void => {
      socket.off("data", onData); socket.off("end", onEnd); socket.off("close", onEnd); socket.off("error", onEnd);
      socket.pause();
      if (error) reject(error); else resolve(value!);
    };
    const onEnd = (): void => finish(new Error("connection closed before a complete frame"));
    const onData = (chunk: Buffer): void => {
      if (buffer.length + chunk.length > 4 + OWNER_CONTROL_MAX_FRAME) return finish(new RangeError("frame too large"));
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const size = buffer.readUInt32BE(0);
      if (size < 2 || size > OWNER_CONTROL_MAX_FRAME) return finish(new RangeError("invalid frame length"));
      if (buffer.length < 4 + size) return;
      if (buffer.length !== 4 + size) return finish(new RangeError("trailing bytes"));
      finish(null, buffer.subarray(4));
    };
    socket.on("data", onData); socket.once("end", onEnd); socket.once("close", onEnd); socket.once("error", onEnd);
  });
}

// ---- closed request schema ----------------------------------------------------------------------

export type OwnerControlRequest =
  | { op: "authority.transfer"; args: OwnerTransferRequest }
  | { op: "status"; args: Record<string, never> }
  | { op: "claims.list"; args: Record<string, never> }
  | { op: "offer.create"; args: OwnerOfferInput }
  | { op: "claim.approve"; args: { claimId: string; clientFingerprint: string } }
  | { op: "claim.reject"; args: { claimId: string } }
  | { op: "offer.cancel"; args: { offerId: string } }
  | { op: "relay.binding"; args: {deviceId:string} }
  | { op: "relay.recipient"; args: Record<string,never> }
  | { op: "relay.enroll"; args: OwnerRecoveryEnroll }
  | { op: "relay.revoke"; args:{deviceId:string;expectedRevision:number} }
  | { op: "relay.rotate-recipient"; args:{pin:DevicePin;expectedRevision:number} }
  | { op: "relay.acks"; args: { limit: number; after?: string } }
  | { op: "relay.ack-reconcile"; args: AckReconcileInput }
  | { op: "relay.recovery.status"; args: Record<string, never> }
  | { op: "relay.recovery.peer"; args: { deviceId: string } }
  | { op: "relay.recovery.rotate"; args: { pin: DevicePin; expectedHostRevision: number } }
  | { op: "relay.recovery.enroll"; args: OwnerRecoveryEnroll }
  | { op: "relay.recovery.acks"; args: { limit: number; after?: string } };

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!plain(value)) throw new SyntaxError("object expected");
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw new SyntaxError("unexpected fields");
  return value;
}
function id(value: unknown, prefix: string): string {
  if (typeof value !== "string" || !ID.test(value) || !value.startsWith(prefix)) throw new SyntaxError("invalid id");
  return value;
}
function role(value: unknown): ClientDeviceRole {
  if (value !== "client-ios" && value !== "client-mac") throw new SyntaxError("invalid role");
  return value;
}
/** Explicit, closed, unique and sorted. An empty list is allowed only when sent explicitly. */
export function ownerScopes(value: unknown): ClientDeviceScope[] {
  if (!Array.isArray(value) || value.length > SCOPES.length) throw new SyntaxError("invalid scopes");
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !SCOPES.includes(item) || out.includes(item)) throw new SyntaxError("invalid scopes");
    out.push(item);
  }
  if (out.join(",") !== [...out].sort().join(",")) throw new SyntaxError("scopes must be sorted");
  return out as ClientDeviceScope[];
}
const PIN_ID = /^[A-Za-z0-9_-]{1,80}$/;
const PIN_KEY = /^[A-Za-z0-9+/]{40,120}={0,2}$/;
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new SyntaxError("invalid revision");
  return value;
}
/** Exact closed PUBLIC pin schema (the relay protocol validator re-checks key encodings and lengths downstream). */
export function ownerPublicPin(value: unknown): DevicePin {
  const p = exactKeys(value, ["deviceId", "encryptionPublicKey", "generation", "installationId", "keyId", "ownerId", "signingPublicKey"]);
  for (const key of ["deviceId", "installationId", "keyId", "ownerId"] as const) if (typeof p[key] !== "string" || !PIN_ID.test(p[key])) throw new SyntaxError("invalid pin");
  for (const key of ["signingPublicKey", "encryptionPublicKey"] as const) if (typeof p[key] !== "string" || !PIN_KEY.test(p[key])) throw new SyntaxError("invalid pin");
  if (typeof p.generation !== "number" || !Number.isSafeInteger(p.generation) || p.generation < 1 || p.generation > 2 ** 31) throw new SyntaxError("invalid pin");
  // Protocol key order: relay-host persists and compares pins by their JSON text, while canonical frames sort keys.
  return { installationId: p.installationId as string, ownerId: p.ownerId as string, deviceId: p.deviceId as string, generation: p.generation,
    keyId: p.keyId as string, signingPublicKey: p.signingPublicKey as string, encryptionPublicKey: p.encryptionPublicKey as string };
}
function page(args: unknown): { limit: number; after?: string } {
  if (!plain(args)) throw new SyntaxError("object expected");
  const x = exactKeys(args, "after" in args ? ["after", "limit"] : ["limit"]);
  if (typeof x.limit !== "number" || !Number.isSafeInteger(x.limit) || x.limit < 1 || x.limit > 64) throw new SyntaxError("invalid limit");
  return { limit: x.limit, ...(x.after !== undefined ? { after: id(x.after, "") } : {}) };
}
/** Validates a decoded request envelope against the closed schema. Callers cannot add principal or scope fields. */
export function parseOwnerControlRequest(value: unknown): OwnerControlRequest {
  const envelope = exactKeys(value, ["args", "op", "protocol"]);
  if (envelope.protocol !== OWNER_CONTROL_PROTOCOL) throw new SyntaxError("unsupported protocol");
  const args = envelope.args;
  switch (envelope.op) {
    case "authority.transfer": {
      const a=exactKeys(args,["requestId","artifactPath","destinationPath"]);
      for(const field of ["artifactPath","destinationPath"] as const) if(typeof a[field]!=="string" || !isAbsolute(a[field]) || normalize(a[field])!==a[field] || a[field].includes("\0") || Buffer.byteLength(a[field])>4096) throw new SyntaxError("invalid path");
      return {op:"authority.transfer",args:{requestId:id(a.requestId,""),artifactPath:a.artifactPath as string,destinationPath:a.destinationPath as string}};
    }
    case "status": case "claims.list": exactKeys(args, []); return { op: envelope.op, args: {} };
    case "offer.create": {
      if (!plain(args)) throw new SyntaxError("object expected");
      if (args.kind === "pair") {
        const pair = exactKeys(args, ["kind", "role", "scopes"]);
        return { op: "offer.create", args: { kind: "pair", role: role(pair.role), scopes: ownerScopes(pair.scopes) } };
      }
      if (args.kind === "rotate") return { op: "offer.create", args: { kind: "rotate", deviceId: id(exactKeys(args, ["deviceId", "kind"]).deviceId, "") } };
      throw new SyntaxError("invalid offer kind");
    }
    case "claim.approve": {
      const approve = exactKeys(args, ["claimId", "clientFingerprint"]);
      if (typeof approve.clientFingerprint !== "string" || !FINGERPRINT.test(approve.clientFingerprint)) throw new SyntaxError("invalid fingerprint");
      return { op: "claim.approve", args: { claimId: id(approve.claimId, "ccl_"), clientFingerprint: approve.clientFingerprint } };
    }
    case "claim.reject": return { op: "claim.reject", args: { claimId: id(exactKeys(args, ["claimId"]).claimId, "ccl_") } };
    case "relay.binding": return {op:envelope.op,args:{deviceId:id(exactKeys(args,["deviceId"]).deviceId,"dev_")}};
    case "relay.recipient": exactKeys(args,[]);return {op:envelope.op,args:{}};
    case "relay.revoke": case "relay.rotate-recipient": {
      const x=exactKeys(args,envelope.op==="relay.revoke"?["deviceId","expectedRevision"]:["pin","expectedRevision"]);
      if(typeof x.expectedRevision!=="number"||!Number.isSafeInteger(x.expectedRevision)||x.expectedRevision<1)throw new SyntaxError("invalid revision");
      return envelope.op==="relay.revoke"?{op:envelope.op,args:{deviceId:id(x.deviceId,"dev_"),expectedRevision:x.expectedRevision}}:{op:envelope.op,args:{pin:ownerPublicPin(x.pin),expectedRevision:x.expectedRevision}};
    }
    case "offer.cancel": return { op: "offer.cancel", args: { offerId: id(exactKeys(args, ["offerId"]).offerId, "cof_") } };
    case "relay.acks": case "relay.recovery.acks": return { op: envelope.op, args: page(args) };
    case "relay.ack-reconcile": {
      const x = exactKeys(args, ["deviceId", "issuerHash", "messageId", "operationId", "receiptId"]);
      if (typeof x.issuerHash !== "string" || !FINGERPRINT.test(x.issuerHash) || typeof x.receiptId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(x.receiptId)) throw new SyntaxError("invalid ack");
      return { op: "relay.ack-reconcile", args: { deviceId: id(x.deviceId, ""), operationId: id(x.operationId, ""), messageId: id(x.messageId, ""), receiptId: x.receiptId, issuerHash: x.issuerHash } };
    }
    case "relay.recovery.status": exactKeys(args, []); return { op: envelope.op, args: {} };
    case "relay.recovery.peer": return { op: envelope.op, args: { deviceId: id(exactKeys(args, ["deviceId"]).deviceId, "dev_") } };
    case "relay.recovery.rotate": {
      const x = exactKeys(args, ["expectedHostRevision", "pin"]);
      return { op: envelope.op, args: { pin: ownerPublicPin(x.pin), expectedHostRevision: revision(x.expectedHostRevision) } };
    }
    case "relay.enroll": case "relay.recovery.enroll": {
      const x = exactKeys(args, ["bindingRevision", "deviceId", "expectedHostRevision", "expectedRevision", "senderPin"]);
      return { op: envelope.op, args: { deviceId: id(x.deviceId, "dev_"), expectedRevision: x.expectedRevision === null ? null : revision(x.expectedRevision),
        expectedHostRevision: revision(x.expectedHostRevision), bindingRevision: revision(x.bindingRevision), senderPin: ownerPublicPin(x.senderPin) } };
    }
    default: throw new SyntaxError("unknown operation");
  }
}

export type OwnerControlResponse =
  | { ok: true; protocol: typeof OWNER_CONTROL_PROTOCOL; result: Record<string, unknown> }
  | { ok: false; protocol: typeof OWNER_CONTROL_PROTOCOL; error: { code: OwnerControlErrorCode; effect: OwnerControlEffect } };

const refusal = (code: OwnerControlErrorCode, effect: OwnerControlEffect = "none"): OwnerControlResponse =>
  ({ ok: false, protocol: OWNER_CONTROL_PROTOCOL, error: { code, effect } });
function errorCode(error: unknown): OwnerControlErrorCode {
  if(error instanceof OwnerControlRefusal) return error.code;
  if (error instanceof ConsumerError) {
    switch (error.code) { case "invalid_input": case "forbidden": case "conflict": case "host_locked": return error.code; default: return "unavailable"; }
  }
  if (!(error instanceof HostError)) return "internal";
  switch (error.code) {
    case "invalid_input": case "not_found": case "conflict": case "forbidden": case "host_locked": return error.code;
    default: return "unavailable";
  }
}
function claimView(claim: OwnerPendingClaim): Record<string, unknown> {
  return { claimId: String(claim.claimId), kind: claim.kind, role: claim.role, scopes: [...claim.scopes],
    deviceId: claim.deviceId ?? null, clientFingerprint: String(claim.clientFingerprint), name: String(claim.name), expiresAt: Number(claim.expiresAt) };
}
function bundleView(bundle: OwnerPairingBundle): Record<string, unknown> {
  // Exact known fields only; anything else on the backend object never reaches the socket.
  return { protocol: bundle.protocol, installationId: bundle.installationId, hostUrl: bundle.hostUrl,
    hostCertificateDER: bundle.hostCertificateDER, hostFingerprint: bundle.hostFingerprint, offerId: bundle.offerId,
    kind: bundle.kind, role: bundle.role, scopes: [...bundle.scopes], deviceId: bundle.deviceId ?? null,
    expiresAt: bundle.expiresAt, code: bundle.code };
}

/**
 * Owner control listener of one HostServices lifetime. Construction is pure; `start()` creates the private
 * socket; `stopAdmission()` is synchronous and permanent; `close()` (cached) waits for every admitted
 * connection and handler before resolving, so the host releases its writer only afterwards.
 */
export class OwnerControlServer {
  readonly socketPath: string;
  readonly #config: ValidOptions;
  readonly #ports: OwnerControlPorts;
  readonly #pending = new Set<Promise<void>>();
  #server: Server | null = null;
  #serverClosed: Promise<void> | null = null;
  #socketIdentity: { dev: number; ino: number } | null = null;
  #createdDirectory = false;
  #stopped = false;
  #start: Promise<string> | null = null;
  #close: Promise<void> | null = null;

  constructor(options: OwnerControlOptions, ports: OwnerControlPorts) {
    this.#config = validateOwnerControlOptions(options);
    const admin = ports?.admin, assertWriter = ports?.assertWriter, installationId = ports?.installationId;
    if (typeof admin !== "function" || typeof assertWriter !== "function" || typeof installationId !== "string" || (ports.relay !== undefined && typeof ports.relay !== "function") || (ports.reserveMaintenance !== undefined && typeof ports.reserveMaintenance !== "function") || (ports.recovery !== undefined && typeof ports.recovery !== "function"))
      throw new HostError("invalid_input", "Invalid owner control ports.");
    this.#ports = Object.freeze({ admin: admin.bind(ports), assertWriter: assertWriter.bind(ports), installationId, ...(ports.relay ? {relay:ports.relay.bind(ports)} : {}), ...(ports.reserveMaintenance ? {reserveMaintenance:ports.reserveMaintenance.bind(ports)} : {}), ...(ports.recovery ? {recovery:ports.recovery.bind(ports)} : {}) });
    this.socketPath = this.#config.socketPath;
  }

  start(): Promise<string> {
    if (this.#stopped) return Promise.reject(new HostError("conflict", "Owner control is closing."));
    return this.#start ??= this.#listen();
  }
  status(): { listening: boolean; connections: number } {
    return { listening: this.#server !== null && !this.#stopped, connections: this.#pending.size };
  }
  toJSON(): object { return this.status(); }
  [inspect.custom](): object { return this.status(); }

  /** Synchronous and permanent: no new connection or request is admitted afterwards. */
  stopAdmission(): void {
    this.#stopped = true;
    this.#closeServer();
  }
  close(): Promise<void> {
    this.stopAdmission();
    return this.#close ??= this.#drain();
  }

  async #listen(): Promise<string> {
    const path = this.socketPath, uid = currentUid();
    const dir = dirname(path);
    this.#createdDirectory = privateControlDirectory(dir, uid, true).created;
    try {
      // Fail closed on any existing entry. A stale socket is the owner's to remove; it is never unlinked here.
      if (lstatOrNull(path) !== null) throw new HostError("conflict", "Owner control socket path already exists.");
      // net.Server.close() makes libuv unlink the exact pathname it bound, whatever now lives there. So the listener binds a
      // unique private name that only this instance knows, and the advertised path is a no-clobber hard link to the same
      // socket inode. libuv's later unlink hits the (already removed) private name; the advertised path is removed only by
      // #cleanupFiles when it is still this socket.
      const bindPath = join(dir, `.o${randomBytes(6).toString("hex")}`);
      const server = createServer({ allowHalfOpen: false }, socket => this.#accept(socket));
      server.maxConnections = this.#config.maxConnections;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ path: bindPath, exclusive: true, backlog: this.#config.maxConnections }, () => { server.off("error", reject); resolve(); });
      });
      this.#server = server;
      server.on("error", () => { /* listener errors after bind only stop admission */ this.stopAdmission(); });
      const created = lstatSync(bindPath);
      if (!created.isSocket() || created.uid !== uid) throw new HostError("conflict", "Owner control socket was replaced.");
      chmodSync(bindPath, 0o600);
      const sealed = lstatSync(bindPath);
      if (sealed.ino !== created.ino || sealed.dev !== created.dev || (sealed.mode & 0o777) !== 0o600)
        throw new HostError("conflict", "Owner control socket was replaced.");
      linkSync(bindPath, path); // EEXIST if anything appeared meanwhile: nothing is overwritten
      this.#socketIdentity = { dev: sealed.dev, ino: sealed.ino };
      unlinkSync(bindPath);
      if (this.#stopped) { this.#closeServer(); throw new HostError("conflict", "Owner control is closing."); }
      return path;
    } catch (error) {
      this.#stopped = true;
      this.#closeServer();
      await (this.#serverClosed ?? Promise.resolve());
      this.#cleanupFiles();
      throw error instanceof HostError ? error : new HostError("conflict", "Owner control socket could not be created.");
    }
  }
  #closeServer(): void {
    const server = this.#server;
    if (!server || this.#serverClosed) return;
    this.#serverClosed = new Promise<void>(resolve => { try { server.close(() => resolve()); } catch { resolve(); } });
  }
  /** Removes only the literal socket this instance created and the directory it created, if empty. */
  #cleanupFiles(): void {
    const own = this.#socketIdentity;
    if (own) {
      try {
        const current = lstatOrNull(this.socketPath);
        if (current && current.isSocket() && current.dev === own.dev && current.ino === own.ino) unlinkSync(this.socketPath);
      } catch { /* left for the owner */ }
      this.#socketIdentity = null;
    }
    if (this.#createdDirectory) {
      try { rmdirSync(dirname(this.socketPath)); } catch { /* not empty or already gone: never recursive */ }
      this.#createdDirectory = false;
    }
  }
  async #drain(): Promise<void> {
    if (this.#start) await this.#start.catch(() => undefined);
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
    await (this.#serverClosed ?? Promise.resolve());
    this.#cleanupFiles();
  }

  #accept(socket: Socket): void {
    if (this.#stopped) { socket.destroy(); return; }
    socket.on("error", () => {});
    const timer = setTimeout(() => socket.destroy(), this.#config.requestTimeoutMs);
    const closed = new Promise<void>(resolve => socket.once("close", () => { clearTimeout(timer); resolve(); }));
    const handled=this.#handle(socket);
    const tracked = Promise.allSettled([closed, handled]).then(results => {
      this.#pending.delete(tracked);
      const outcome=results[1]; if(outcome?.status==="fulfilled") outcome.value?.();
    });
    this.#pending.add(tracked);
  }
  async #handle(socket: Socket): Promise<(() => void) | undefined> {
    let payload: Buffer;
    try { payload = await readFrame(socket); } catch { socket.destroy(); return; }
    // ---- From here to the write: synchronous. Admission, admin resolution and the writer fence are checked
    // after the last await and before any mutation; the backend operation itself is synchronous.
    const dispatched = this.#dispatch(payload);
    const { invoked, reservation } = dispatched;
    // An admitted asynchronous relay reconciliation is awaited HERE, inside this tracked connection, so close() drains it.
    // It never awaits a host drain itself (it only waits for its own bounded relay flight), so it cannot deadlock close().
    const response = dispatched.pending ? await dispatched.pending : dispatched.response;
    let frame: Buffer;
    try { frame = encodeFrame(response); } catch { frame = encodeFrame(refusal("response_too_large", invoked ? "unknown" : "none")); }
    if(!reservation) { socket.end(frame); return; }
    // finish confirms the ACK was flushed locally; the connection still must leave #pending before work.
    const flushed=await new Promise<boolean>(resolve=>{ socket.once("finish",()=>resolve(true)); socket.once("close",()=>resolve(false)); socket.end(frame); });
    return flushed ? reservation.afterConnection.bind(reservation) : reservation.cancel.bind(reservation);
  }
  /** `invoked` is true once a backend mutation was called, whatever its outcome. */
  #dispatch(payload: Buffer): { response: OwnerControlResponse; invoked: boolean; reservation?: OwnerMaintenanceReservation; pending?: Promise<OwnerControlResponse> } {
    let request: OwnerControlRequest;
    try { request = parseOwnerControlRequest(decodeCanonical(payload)); } catch { return { response: refusal("invalid_request"), invoked: false }; }
    if (this.#stopped) return { response: refusal("closing"), invoked: false };
    if(request.op==="authority.transfer") {
      try { this.#ports.assertWriter();
        if(!this.#ports.reserveMaintenance) return {response:refusal("authority_unavailable"),invoked:false};
        const reservation=this.#ports.reserveMaintenance(request.args);
        return {response:{ok:true,protocol:OWNER_CONTROL_PROTOCOL,result:reservation.result},invoked:true,reservation};
      } catch(error) { return {response:refusal(errorCode(error)),invoked:false}; }
    }
    if (isRecovery(request)) {
      let recovery: Readonly<OwnerRelayRecoveryPort>;
      try { this.#ports.assertWriter(); const port = this.#ports.recovery?.(); if (!port) return { response: refusal("unavailable"), invoked: false }; recovery = port; }
      catch (error) { const code = errorCode(error); return { response: refusal(code === "conflict" ? "closing" : code), invoked: false }; }
      const mutation = OWNER_CONTROL_MUTATIONS.has(request.op);
      try { return { response: { ok: true, protocol: OWNER_CONTROL_PROTOCOL, result: this.#recover(recovery, request) }, invoked: mutation }; }
      catch (error) {
        if (error instanceof OwnerControlRefusal) return { response: refusal(error.code), invoked: false };
        // relay-host recovery mutations are one synchronous SQLite transaction: a typed refusal rolled back entirely.
        if (error instanceof ConsumerError || error instanceof HostError) return { response: refusal(errorCode(error)), invoked: false };
        return { response: refusal(errorCode(error), mutation ? "unknown" : "none"), invoked: mutation };
      }
    }
    if (request.op === "relay.ack-reconcile") {
      let relay: Readonly<RelayHostAdmin>;
      try { this.#ports.assertWriter(); const port = this.#ports.relay?.(); if (!port) return { response: refusal("unavailable"), invoked: false }; relay = port; }
      catch (error) { const code = errorCode(error); return { response: refusal(code === "conflict" ? "closing" : code), invoked: false }; }
      let started: Promise<{ status: AckReconcileStatus }>;
      try { started = relay.reconcileAck(request.args); }
      catch (error) { return { response: refusal(errorCode(error)), invoked: false }; }
      const pending = started.then((out): OwnerControlResponse => ({ ok: true, protocol: OWNER_CONTROL_PROTOCOL, result: { status: out.status, messageId: request.args.messageId, receiptId: request.args.receiptId } }),
        // Only a deadline after the signed ACK was handed to the transport is ambiguous; earlier refusals sent nothing.
        (error: unknown): OwnerControlResponse => error instanceof ConsumerError && error.code === "unknown" ? refusal("unavailable", "unknown")
          : refusal(errorCode(error), error instanceof ConsumerError ? "none" : "unknown"));
      return { response: refusal("internal", "unknown"), invoked: true, pending };
    }
    let admin: Readonly<OwnerAppClientAdminPort>;
    try {
      admin = this.#ports.admin();
      this.#ports.assertWriter();
    } catch (error) {
      const code = errorCode(error);
      return { response: refusal(code === "conflict" ? "closing" : code), invoked: false };
    }
    const mutation = OWNER_CONTROL_MUTATIONS.has(request.op);
    try {
      return { response: { ok: true, protocol: OWNER_CONTROL_PROTOCOL, result: this.#run(admin, request) }, invoked: mutation };
    } catch (error) {
      if (error instanceof OwnerControlRefusal) return { response: refusal(error.code), invoked: false };
      return { response: refusal(errorCode(error), mutation ? "unknown" : "none"), invoked: mutation };
    }
  }
  #recover(recovery: Readonly<OwnerRelayRecoveryPort>, request: RecoveryRequest): Record<string, unknown> {
    switch (request.op) {
      case "relay.recovery.status": return recovery.status();
      case "relay.recovery.peer": return recovery.peer(request.args.deviceId);
      case "relay.recovery.rotate": return { ...recovery.rotate(request.args), grantsCreated: 0 };
      case "relay.recovery.enroll": return { ...recovery.enroll(request.args), grantsCreated: 0 };
      case "relay.recovery.acks": return ackPage(recovery.acks(request.args));
    }
  }
  #run(admin: Readonly<OwnerAppClientAdminPort>, request: Exclude<OwnerControlRequest,{op:"authority.transfer"}|RecoveryRequest|{op:"relay.ack-reconcile"}>): Record<string, unknown> {
    switch (request.op) {
      case "relay.acks": {
        const relay=this.#ports.relay?.();if(!relay)throw new OwnerControlRefusal("unavailable");
        return ackPage(relay.pendingAcks(request.args));
      }
      case "relay.binding": case "relay.recipient": case "relay.enroll": case "relay.revoke": case "relay.rotate-recipient": {
        const relay=this.#ports.relay?.();if(!relay)throw new OwnerControlRefusal("unavailable");
        if(request.op==="relay.binding")return {binding:relay.binding(request.args.deviceId)};
        if(request.op==="relay.recipient")return {...relay.recipient()};
        if (request.op === "relay.enroll") {
          // Canonical binding comes from this running host, never from an operator's serialized snapshot.
          const live = relay.binding(request.args.deviceId);
          if (!live || live.status !== "active") throw new OwnerControlRefusal("forbidden");
          if (live.revision !== request.args.bindingRevision) throw new OwnerControlRefusal("conflict");
          return { ...relay.enroll({ expectedRevision: request.args.expectedRevision,
            expectedHostRevision: request.args.expectedHostRevision, binding: live, senderPin: request.args.senderPin }), grantsCreated: 0 };
        }
        if(request.op==="relay.revoke"){relay.revoke(request.args.deviceId,request.args.expectedRevision);return {status:"revoked",deviceId:request.args.deviceId};}
        relay.rotateRecipient(request.args.pin,request.args.expectedRevision);return {status:"rotated"};
      }
      case "status":
        return { status: "ready", installationId: this.#ports.installationId, pendingClaims: admin.pendingClaims().length };
      case "claims.list": {
        const claims = admin.pendingClaims();
        return { items: claims.slice(0, OWNER_CONTROL_MAX_CLAIMS).map(claimView), truncated: claims.length > OWNER_CONTROL_MAX_CLAIMS };
      }
      case "offer.create": {
        const input: OwnerOfferInput = request.args.kind === "pair"
          ? { kind: "pair", role: request.args.role, scopes: [...request.args.scopes] } : { kind: "rotate", deviceId: request.args.deviceId };
        return bundleView(admin.pairingBundle(input));
      }
      case "claim.approve": {
        // Intent binding: the owner approves the exact claim id AND the public pin it was shown. Same synchronous
        // section as the approval, so the pending claim cannot change in between.
        const claim = admin.pendingClaims().find(item => item.claimId === request.args.claimId);
        if (!claim) throw new OwnerControlRefusal("not_found");
        if (claim.clientFingerprint !== request.args.clientFingerprint) throw new OwnerControlRefusal("fingerprint_mismatch");
        const approved = admin.approveClaim(claim.claimId);
        return { deviceId: approved.deviceId, clientFingerprint: approved.fingerprint, kind: claim.kind, role: claim.role,
          scopes: [...claim.scopes], grantsCreated: 0 };
      }
      case "claim.reject": admin.rejectClaim(request.args.claimId); return { claimId: request.args.claimId, status: "rejected" };
      case "offer.cancel": admin.cancelOffer(request.args.offerId); return { offerId: request.args.offerId, status: "cancelled" };
    }
  }
}
type RecoveryRequest = Extract<OwnerControlRequest, { op: `relay.recovery.${string}` }>;
const isRecovery = (request: OwnerControlRequest): request is RecoveryRequest => request.op.startsWith("relay.recovery.");
/** Exact public projection of a pending ACK page (ids, hashes, generations, disposition). Never request JSON/signatures. */
function ackPage(page: PendingAckPage): Record<string, unknown> {
  return { pending: page.pending, truncated: page.truncated, items: page.items.map(i => ({ deviceId: i.deviceId, operationId: i.operationId, messageId: i.messageId,
    receiptId: i.receiptId, issuerHash: i.issuerHash, operationState: i.operationState, threadId: i.threadId, turnId: i.turnId, logicalHash: i.logicalHash,
    requestRetained: i.requestRetained, recipientGeneration: i.recipient?.generation ?? null, recipientKeyId: i.recipient?.keyId ?? null, disposition: i.disposition })) };
}
/** Refusal decided before the backend mutation was invoked: effect `none`. */
export class OwnerControlRefusal extends Error {
  constructor(readonly code: OwnerControlErrorCode) { super(code); }
}
