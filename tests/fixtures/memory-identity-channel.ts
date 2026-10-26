// TEST ONLY closed, bounded inherited IPC. No argv/env/file transport or production fallback.
import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { TlsIdentity } from "@dexter/devices";
type Identity = Pick<TlsIdentity, "certPem" | "keyPem" | "fingerprint">;
const failure = (kind: string) => Error(`memory IPC ${kind}`);
function exact(v: unknown, keys: string[]): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
}
function message(v: unknown, kind: string, keys: string[] = []): v is Record<string, unknown> {
  return exact(v, ["kind", "version", ...keys]) && v.kind === kind && v.version === 1;
}
/** Parent listeners installed synchronously, before waiting for child readiness. */
export function sendMemoryIdentity(child: ChildProcess, identity: Identity, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    let phase: "ready" | "ack" = "ready", settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      child.off("message", onMessage); child.off("close", onClose); child.off("error", onError);
      error ? reject(error) : resolve();
    };
    const onClose = () => finish(failure("child_closed")), onError = () => finish(failure("child_error"));
    const onMessage = (v: unknown) => {
      if (phase === "ready" && message(v, "memory-ready")) {
        phase = "ack";
        const wire = {kind:"memory-identity",version:1,cert:identity.certPem,key:identity.keyPem,fingerprint:identity.fingerprint};
        if (wire.cert.length + wire.key.length > 16384 || Buffer.byteLength(JSON.stringify(wire)) > 16384) return finish(failure("bound"));
        try { child.send(wire, error => { if (error) finish(failure("send_failed")); }); } catch { finish(failure("send_failed")); }
      } else if (phase === "ack" && message(v, "memory-ack", ["fingerprint"]) && v.fingerprint === identity.fingerprint) finish();
      else finish(failure("protocol"));
    };
    const timer = setTimeout(() => finish(failure("timeout")), timeoutMs);
    child.on("message", onMessage); child.once("close", onClose); child.once("error", onError);
    if (!child.connected) finish(failure("disconnected"));
  });
}
/** Registers the identity listener BEFORE sending readiness. ACK precedes child continuation. */
export function receiveMemoryIdentity(options: {keepOpen?: boolean; timeoutMs?: number} = {}): Promise<TlsIdentity> {
  if (!process.connected || !process.send) return Promise.reject(failure("required"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, identity?: TlsIdentity) => {
      if (settled) return; settled = true; clearTimeout(timer);
      process.off("message", onMessage); process.off("disconnect", onDisconnect);
      if (!options.keepOpen && process.connected) process.disconnect();
      error ? reject(error) : resolve(identity!);
    };
    const onDisconnect = () => finish(failure("disconnected"));
    const onMessage = (v: unknown) => {
      try {
        if (!message(v, "memory-identity", ["cert", "key", "fingerprint"]) || typeof v.cert !== "string" || typeof v.key !== "string" || v.cert.length + v.key.length > 16384 || typeof v.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(v.fingerprint) || Buffer.byteLength(JSON.stringify(v)) > 16384) throw failure("invalid");
        const cert = new X509Certificate(v.cert);
        if (!cert.checkPrivateKey(createPrivateKey(v.key)) || createHash("sha256").update(cert.raw).digest("hex") !== v.fingerprint) throw failure("invalid");
        const identity = new TlsIdentity(v.cert, v.key, v.fingerprint);
        process.send!({kind:"memory-ack",version:1,fingerprint:identity.fingerprint}, error => finish(error ? failure("ack_failed") : undefined, identity));
      } catch { finish(failure("invalid")); }
    };
    const timer = setTimeout(() => finish(failure("timeout")), options.timeoutMs ?? 5000);
    process.once("message", onMessage); process.once("disconnect", onDisconnect);
    process.send!({kind:"memory-ready",version:1}, error => { if (error) finish(failure("ready_failed")); });
  });
}
