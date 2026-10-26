import { closeSync, constants, fstatSync, fchmodSync, fsyncSync, lstatSync, openSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, isAbsolute, normalize } from "node:path";
import { parseArgs } from "node:util";
import {
  OWNER_CONTROL_ERRORS, OWNER_CONTROL_MUTATIONS, OWNER_CONTROL_PROTOCOL, currentUid, decodeCanonical, encodeFrame, ownerPublicPin, ownerScopes,
  privateControlDirectory, readFrame, validateOwnerControlPath, type OwnerControlRequest, type OwnerControlResponse,
} from "./owner-control.js";
import { readSync } from "node:fs";
import type { DevicePin } from "@dexter/relay";

/**
 * Owner CLI side of the local control socket. It never opens the HostStore: every command is one framed
 * request to the running host. A mutation whose answer is lost is reported as `unknown` and never retried.
 */
export type OwnerControlOutcome =
  | { kind: "response"; response: OwnerControlResponse }
  /** Nothing reached the host (path refused, connect failed). */
  | { kind: "not_sent" }
  /** The request may have been processed; for a read this only means no answer. */
  | { kind: "unknown" };

/** The socket must be this user's, inside a private canonical directory; checked before connecting. */
export function checkOwnerControlSocket(path: string): void {
  validateOwnerControlPath(path);
  const uid = currentUid();
  privateControlDirectory(dirname(path), uid, false);
  const st = lstatSync(path);
  if (!st.isSocket() || st.uid !== uid || (st.mode & 0o077) !== 0) throw new Error("unsafe socket");
}

export function parseOwnerControlResponse(value: unknown): OwnerControlResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("object expected");
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).sort().join(",");
  if (raw.protocol !== OWNER_CONTROL_PROTOCOL) throw new SyntaxError("protocol");
  if (raw.ok === true && keys === "ok,protocol,result" && raw.result !== null && typeof raw.result === "object" && !Array.isArray(raw.result))
    return { ok: true, protocol: OWNER_CONTROL_PROTOCOL, result: raw.result as Record<string, unknown> };
  if (raw.ok === false && keys === "error,ok,protocol") {
    const error = raw.error as Record<string, unknown> | null;
    if (error && typeof error === "object" && Object.keys(error).sort().join(",") === "code,effect"
      && (OWNER_CONTROL_ERRORS as readonly unknown[]).includes(error.code) && (error.effect === "none" || error.effect === "unknown"))
      return { ok: false, protocol: OWNER_CONTROL_PROTOCOL, error: error as { code: typeof OWNER_CONTROL_ERRORS[number]; effect: "none" | "unknown" } };
  }
  throw new SyntaxError("invalid response");
}

/** One request, one response, absolute deadline, no retry. */
export function ownerControlRequest(socketPath: string, request: OwnerControlRequest, options: { timeoutMs?: number } = {}): Promise<OwnerControlOutcome> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error("timeout");
    checkOwnerControlSocket(socketPath);
  } catch { return Promise.resolve({ kind: "not_sent" }); }
  const frame = encodeFrame({ protocol: OWNER_CONTROL_PROTOCOL, ...request });
  return new Promise(resolve => {
    let sent = false, settled = false;
    const socket = createConnection({ path: socketPath, allowHalfOpen: false });
    const settle = (outcome: OwnerControlOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const lost = (): void => settle(sent ? { kind: "unknown" } : { kind: "not_sent" });
    const timer = setTimeout(lost, timeoutMs);
    socket.on("error", lost);
    socket.once("connect", () => {
      sent = true;
      socket.write(frame);
      readFrame(socket).then(payload => {
        try { settle({ kind: "response", response: parseOwnerControlResponse(decodeCanonical(payload)) }); }
        catch { settle({ kind: "unknown" }); }
      }, lost);
    });
  });
}

// ---- private output file -------------------------------------------------------------------------

/** Exclusive create 0600 in a canonical directory of this user that others cannot write; never follows links. */
export function openPrivateOutput(path: string): { fd: number; dev: number; ino: number } {
  if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path || path.endsWith("/")) throw new Error("output path must be absolute and normalized");
  const uid = currentUid();
  const dir = dirname(path);
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o022) !== 0 || realpathSync(dir) !== dir) throw new Error("output directory must be a canonical directory of this user");
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    const file = fstatSync(fd);
    if (!file.isFile() || file.uid !== uid) throw new Error("output file is not private");
    return { fd, dev: file.dev, ino: file.ino };
  } catch (error) { closeSync(fd); throw error; }
}
function discardOutput(path: string, out: { fd: number; dev: number; ino: number }): void {
  try { closeSync(out.fd); } catch { /* already closed */ }
  try {
    const st = lstatSync(path);
    if (st.isFile() && st.dev === out.dev && st.ino === out.ino) unlinkSync(path);
  } catch { /* nothing to remove */ }
}

// ---- dexter app-client ---------------------------------------------------------------------------

export interface OwnerCliIo { stdout(text: string): void; stderr(text: string): void; env?: Record<string, string | undefined> }
export const OWNER_CLI_USAGE = [
  "dexter app-client status --owner-control-socket PATH",
  "dexter app-client offer --owner-control-socket PATH --role client-ios|client-mac (--scope SCOPE ... | --no-scopes) (--out FILE | --stdout)",
  "dexter app-client offer --owner-control-socket PATH --rotate DEVICE_ID (--out FILE | --stdout)",
  "dexter app-client claims --owner-control-socket PATH",
  "dexter app-client approve CLAIM_ID --fingerprint SHA256 --owner-control-socket PATH",
  "dexter app-client reject CLAIM_ID --owner-control-socket PATH",
  "dexter app-client cancel OFFER_ID --owner-control-socket PATH",
].join("\n") + "\n";
const ALLOWED: Record<string, readonly string[]> = {
  status: [], claims: [], offer: ["role", "scope", "no-scopes", "rotate", "out", "stdout"],
  approve: ["fingerprint"], reject: [], cancel: [],
};
const POSITIONALS: Record<string, number> = { status: 0, claims: 0, offer: 0, approve: 1, reject: 1, cancel: 1 };

class UsageError extends Error {}
const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

/**
 * Exit codes: 0 done, 1 refused (no effect), 2 usage, 3 outcome unknown (do not retry; list/reconcile).
 * The pairing code is written only to the explicit `--out` file or `--stdout`; it is never in argv or stderr.
 */
export async function runOwnerControlCli(argv: readonly string[], io: OwnerCliIo): Promise<number> {
  let request: OwnerControlRequest, socketPath: string, timeoutMs: number, out: string | null = null, toStdout = false;
  try {
    const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: {
      "owner-control-socket": { type: "string" }, "timeout-ms": { type: "string" },
      role: { type: "string" }, scope: { type: "string", multiple: true }, "no-scopes": { type: "boolean" },
      rotate: { type: "string" }, out: { type: "string" }, stdout: { type: "boolean" }, fingerprint: { type: "string" },
    } });
    const command = positionals[0] ?? "";
    if (!(command in ALLOWED)) throw new UsageError("unknown command");
    const used = Object.keys(values).filter(key => key !== "owner-control-socket" && key !== "timeout-ms");
    if (used.some(key => !ALLOWED[command]!.includes(key)) || positionals.length !== 1 + POSITIONALS[command]!) throw new UsageError("unexpected arguments");
    socketPath = values["owner-control-socket"] ?? io.env?.["DEXTER_OWNER_CONTROL_SOCKET"] ?? "";
    if (!socketPath) throw new UsageError("--owner-control-socket is required");
    validateOwnerControlPath(socketPath);
    timeoutMs = values["timeout-ms"] === undefined ? 10_000 : Number(values["timeout-ms"]);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new UsageError("invalid --timeout-ms");
    const target = positionals[1] ?? "";
    switch (command) {
      case "status": request = { op: "status", args: {} }; break;
      case "claims": request = { op: "claims.list", args: {} }; break;
      case "reject": request = { op: "claim.reject", args: { claimId: target } }; break;
      case "cancel": request = { op: "offer.cancel", args: { offerId: target } }; break;
      case "approve":
        if (!values.fingerprint) throw new UsageError("--fingerprint of the claim shown by `claims` is required");
        request = { op: "claim.approve", args: { claimId: target, clientFingerprint: values.fingerprint } }; break;
      default: {
        if ((values.out === undefined) === (values.stdout !== true)) throw new UsageError("choose exactly one of --out FILE or --stdout");
        if (values.rotate !== undefined) {
          if (values.role !== undefined || values.scope !== undefined || values["no-scopes"]) throw new UsageError("--rotate keeps the existing role and scopes");
          request = { op: "offer.create", args: { kind: "rotate", deviceId: values.rotate } };
        } else {
          if (values.role !== "client-ios" && values.role !== "client-mac") throw new UsageError("--role client-ios|client-mac is required");
          if ((values.scope === undefined) === (values["no-scopes"] !== true)) throw new UsageError("choose explicit --scope values or --no-scopes");
          let scopes;
          try { scopes = ownerScopes([...(values.scope ?? [])].sort()); } catch { throw new UsageError("unknown or repeated scope"); }
          request = { op: "offer.create", args: { kind: "pair", role: values.role, scopes } };
        }
        out = values.out ?? null; toStdout = values.stdout === true;
      }
    }
  } catch (error) {
    io.stderr((error instanceof UsageError ? `usage: ${error.message}\n` : "usage: invalid arguments\n") + OWNER_CLI_USAGE);
    return 2;
  }
  let output: { fd: number; dev: number; ino: number } | null = null;
  if (out !== null) {
    // Reserved before the offer exists, so a refused file never strands a code in memory.
    try { output = openPrivateOutput(out); } catch { io.stderr(json({ error: "output_refused", effect: "none" })); return 1; }
  }
  const outcome = await ownerControlRequest(socketPath, request, { timeoutMs });
  const mutation = OWNER_CONTROL_MUTATIONS.has(request.op);
  if (outcome.kind !== "response" || !outcome.response.ok) {
    if (output && out) discardOutput(out, output);
    if (outcome.kind === "not_sent") { io.stderr(json({ error: "host_unreachable", effect: "none" })); return 1; }
    if (outcome.kind === "unknown") {
      io.stderr(json({ error: "no_answer", effect: mutation ? "unknown" : "none" }));
      return mutation ? 3 : 1;
    }
    const { code, effect } = (outcome.response as Extract<OwnerControlResponse, { ok: false }>).error;
    io.stderr(json({ error: code, effect }));
    return effect === "unknown" ? 3 : 1;
  }
  const result = outcome.response.result;
  if (request.op !== "offer.create") { io.stdout(json(result)); return 0; }
  const bundle = JSON.stringify(result) + "\n";
  if (toStdout) { io.stdout(bundle); return 0; }
  try {
    const bytes = Buffer.from(bundle, "utf8");
    if (writeSync(output!.fd, bytes) !== bytes.length) throw new Error("short write");
    fsyncSync(output!.fd);
    closeSync(output!.fd);
  } catch {
    discardOutput(out!, output!);
    // The offer exists on the host but its code is gone; cancel it explicitly. Never re-issued automatically.
    io.stderr(json({ error: "output_failed", effect: "unknown", offerId: result.offerId }));
    return 3;
  }
  io.stdout(json({ offerId: result.offerId, kind: result.kind, role: result.role, scopes: result.scopes, expiresAt: result.expiresAt, file: out }));
  return 0;
}

// ---- dexter relay ---------------------------------------------------------------------------------

export const RELAY_OWNER_CLI_USAGE = [
  "dexter relay acks --owner-control-socket PATH [--limit 1..64] [--after MESSAGE_ID]",
  "dexter relay ack-reconcile --owner-control-socket PATH --device ID --operation ID --message ID --receipt ID --issuer-hash SHA256",
  "dexter relay recovery status --owner-control-socket PATH",
  "dexter relay recovery peer DEVICE_ID --owner-control-socket PATH",
  "dexter relay recovery acks --owner-control-socket PATH [--limit 1..64] [--after MESSAGE_ID]",
  "dexter relay recovery rotate --owner-control-socket PATH --pin-file FILE --expected-host-revision N",
  "dexter relay enroll DEVICE_ID --owner-control-socket PATH --sender-pin-file FILE --expected-revision N|none --expected-host-revision N --binding-revision N",
  "dexter relay recovery enroll DEVICE_ID --owner-control-socket PATH --sender-pin-file FILE --expected-revision N|none --expected-host-revision N --binding-revision N",
].join("\n") + "\n";
/** A PUBLIC pin JSON file of this user (no symlink, not writable by others, <=4 KiB). Never a key, code or token. */
export function readPublicPinFile(path: string): DevicePin {
  if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path) throw new Error("pin path");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== currentUid() || (st.mode & 0o022) !== 0 || st.size < 2 || st.size > 4096) throw new Error("pin file");
    const bytes = Buffer.alloc(st.size); let read = 0;
    while (read < st.size) { const n = readSync(fd, bytes, read, st.size - read, read); if (n === 0) break; read += n; }
    if (read !== st.size) throw new Error("pin file");
    return ownerPublicPin(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } finally { closeSync(fd); }
}
const integer = (value: string | undefined, min: number, max: number): number => {
  if (value === undefined || !/^[0-9]{1,15}$/.test(value)) throw new UsageError("expected an integer");
  const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw new UsageError("integer out of range"); return n;
};
/**
 * Exit codes: 0 done, 1 refused/not reconcilable (no effect), 2 usage, 3 outcome unknown (never retried: list again).
 * Every command is one framed request to the running host; no store, custody, provider, binding or key is read here.
 */
export async function runRelayOwnerCli(argv: readonly string[], io: OwnerCliIo): Promise<number> {
  let request: OwnerControlRequest, socketPath: string;
  try {
    const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: {
      "owner-control-socket": { type: "string" }, limit: { type: "string" }, after: { type: "string" },
      device: { type: "string" }, operation: { type: "string" }, message: { type: "string" }, receipt: { type: "string" }, "issuer-hash": { type: "string" },
      "pin-file": { type: "string" }, "sender-pin-file": { type: "string" }, "expected-host-revision": { type: "string" },
      "expected-revision": { type: "string" }, "binding-revision": { type: "string" },
    } });
    const recovery = positionals[0] === "recovery", command = recovery ? `recovery ${positionals[1] ?? ""}` : positionals[0] ?? "";
    const allowed: Record<string, [string[], number]> = {
      acks: [["limit", "after"], 1], "ack-reconcile": [["device", "operation", "message", "receipt", "issuer-hash"], 1],
      "recovery status": [[], 2], "recovery peer": [[], 3], "recovery acks": [["limit", "after"], 2],
      "recovery rotate": [["pin-file", "expected-host-revision"], 2],
      enroll: [["sender-pin-file", "expected-revision", "expected-host-revision", "binding-revision"], 2],
      "recovery enroll": [["sender-pin-file", "expected-revision", "expected-host-revision", "binding-revision"], 3],
    };
    const rule = allowed[command];
    if (!rule) throw new UsageError("unknown command");
    const used = Object.keys(values).filter(key => key !== "owner-control-socket");
    if (used.some(key => !rule[0].includes(key)) || positionals.length !== rule[1]) throw new UsageError("unexpected arguments");
    socketPath = values["owner-control-socket"] ?? io.env?.["DEXTER_OWNER_CONTROL_SOCKET"] ?? "";
    if (!socketPath) throw new UsageError("--owner-control-socket is required");
    validateOwnerControlPath(socketPath);
    const pageArgs = () => ({ limit: values.limit === undefined ? 32 : integer(values.limit, 1, 64), ...(values.after !== undefined ? { after: values.after } : {}) });
    const pinFrom = (path: string | undefined): DevicePin => { if (!path) throw new UsageError("a public pin file is required"); try { return readPublicPinFile(path); } catch { throw new UsageError("pin file is not a private public-pin JSON file"); } };
    switch (command) {
      case "acks": request = { op: "relay.acks", args: pageArgs() }; break;
      case "recovery acks": request = { op: "relay.recovery.acks", args: pageArgs() }; break;
      case "recovery status": request = { op: "relay.recovery.status", args: {} }; break;
      case "recovery peer": request = { op: "relay.recovery.peer", args: { deviceId: positionals[2]! } }; break;
      case "ack-reconcile": {
        for (const key of ["device", "operation", "message", "receipt", "issuer-hash"] as const) if (!values[key]) throw new UsageError(`--${key} is required`);
        request = { op: "relay.ack-reconcile", args: { deviceId: values.device!, operationId: values.operation!, messageId: values.message!, receiptId: values.receipt!, issuerHash: values["issuer-hash"]! } };
        break;
      }
      case "recovery rotate": request = { op: "relay.recovery.rotate", args: { pin: pinFrom(values["pin-file"]), expectedHostRevision: integer(values["expected-host-revision"], 1, Number.MAX_SAFE_INTEGER) } }; break;
      default: {
        const expected = values["expected-revision"];
        if (expected === undefined) throw new UsageError("--expected-revision N|none is required");
        request = { op: recovery ? "relay.recovery.enroll" : "relay.enroll", args: { deviceId: positionals[recovery ? 2 : 1]!, expectedRevision: expected === "none" ? null : integer(expected, 1, Number.MAX_SAFE_INTEGER),
          expectedHostRevision: integer(values["expected-host-revision"], 1, Number.MAX_SAFE_INTEGER), bindingRevision: integer(values["binding-revision"], 1, Number.MAX_SAFE_INTEGER),
          senderPin: pinFrom(values["sender-pin-file"]) } };
      }
    }
  } catch (error) {
    io.stderr((error instanceof UsageError ? `usage: ${error.message}\n` : "usage: invalid arguments\n") + RELAY_OWNER_CLI_USAGE);
    return 2;
  }
  const outcome = await ownerControlRequest(socketPath, request, { timeoutMs: 15_000 });
  const mutation = OWNER_CONTROL_MUTATIONS.has(request.op);
  if (outcome.kind === "not_sent") { io.stderr(json({ error: "host_unreachable", effect: "none" })); return 1; }
  if (outcome.kind === "unknown") { io.stderr(json({ error: "no_answer", effect: mutation ? "unknown" : "none" })); return mutation ? 3 : 1; }
  if (!outcome.response.ok) { const { code, effect } = outcome.response.error; io.stderr(json({ error: code, effect })); return effect === "unknown" ? 3 : 1; }
  const result = outcome.response.result;
  io.stdout(json(result));
  if (request.op === "relay.ack-reconcile") return result.status === "acked" ? 0 : result.status === "unknown" ? 3 : 1;
  return 0;
}
