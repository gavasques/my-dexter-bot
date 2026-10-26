// G8 relay recovery composition lab: real HostServices / owner UDS / app-client mTLS listener / relay-service process /
// RelayStore. Synthetic identities only. Every private key (TLS, relay custody, operations custody) stays in process
// memory or crosses a process boundary once over an inherited IPC channel; no key, auth or credential file is written.
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import type { TestContext } from "node:test";
import type { TlsIdentity } from "@dexter/devices";
import type { EngineDriver } from "@dexter/engines";
import type { EngineId } from "@dexter/contracts";
import { RelayEndpoint, type DevicePin, type Envelope } from "@dexter/relay";
import { PinnedRelayTransport } from "@dexter/relay-service";
import { ownerControlRequest } from "../../packages/cli/src/owner-control-client.js";
import { memoryCustody } from "./relay-host-lab.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;
export const code = (name: string) => (e: unknown) => !!e && typeof e === "object" && "code" in e && (e as { code: unknown }).code === name;
const stacks = new WeakMap<TestContext, Array<() => unknown>>();
/** One LIFO cleanup stack per test (node runs `t.after` hooks in registration order): handles close before removal. */
export function defer(t: TestContext, fn: () => unknown): void {
  let stack = stacks.get(t);
  if (!stack) { const created: Array<() => unknown> = []; stack = created; stacks.set(t, created); t.after(async () => { while (created.length) await created.pop()!(); }); }
  stack.push(fn);
}
/** Short private 0700 lab under TMPDIR (owner sockets stay far below the 100-byte bound). */
export function lab(t: TestContext, prefix = "rc-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); chmodSync(dir, 0o700);
  defer(t, () => rmSync(dir, { recursive: true, force: true })); return dir;
}
/** Synthetic official-protocol engine fixture: counts native opens/turns, never infers. */
export function countingEngine(): { makeDriver(engine: EngineId): EngineDriver; opens: number; turns: number; turnReceipts: { threadId: string; turnId: string }[] } {
  const state = { opens: 0, turns: 0, turnReceipts: [] as { threadId: string; turnId: string }[], makeDriver(engine: EngineId): EngineDriver {
    return { id: engine, capabilities: { resume: true, interrupt: true, fork: false, steer: false },
      async status() { return { engine, installed: true, version: "synthetic", authentication: "authenticated", billing: "subscription" }; },
      async open(threadId, cursor) { state.opens++; return { threadId, nativeCursor: cursor ?? "synthetic-cursor" }; },
      async *turn(session, turnId) { state.turns++; state.turnReceipts.push({ threadId: session.threadId, turnId }); yield { type: "turn.completed", threadId: session.threadId, turnId, usage: {} }; },
      async respondToTool() {}, async interrupt() {}, async close() {} };
  } };
  return state;
}
export const relayCustody = (store: { hostId: string; ownerId: string }, generation: number) =>
  memoryCustody({ installationId: store.hostId, ownerId: store.ownerId, deviceId: "relay_host", generation, keyId: `host_key_${generation}` });
export const sender = (store: { hostId: string; ownerId: string }, deviceId: string, generation: number) =>
  new RelayEndpoint({ installationId: store.hostId, ownerId: store.ownerId, deviceId, generation, keyId: `${deviceId}_k${generation}` });
export function turnEnvelope(from: RelayEndpoint, recipient: DevicePin, sequence: number, operationId: string, threadId: string): Envelope {
  const now = Date.now();
  return from.seal(recipient, { messageId: `msg_${operationId}`, sequence, type: "command", createdAt: now, expiresAt: now + 600_000 },
    Buffer.from(JSON.stringify({ version: 1, operation: "turn.submit", operationId, threadId, content: `synthetic ${operationId}` })));
}
/** Public pin JSON file (0600, this user). Public data only. */
export function pinFile(dir: string, name: string, pin: DevicePin): string {
  const path = join(dir, name); writeFileSync(path, JSON.stringify(pin), { mode: 0o600, flag: "wx" }); return path;
}

// ---- in-memory mutual TLS AppClient (like the native client: exact pin, SAN, TLS 1.3) ----------------------------
export interface Trust { url: string; certPem: string; fingerprint: string }
const fingerprintDer = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
export function mtls(trust: Trust, identity: TlsIdentity, path: string, body: unknown): Promise<{ status: number; json: Json }> {
  const url = new URL(trust.url), payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, method: "POST", path, agent: false,
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) },
      cert: identity.certPem, key: identity.keyPem, ca: [trust.certPem], minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
      checkServerIdentity: (host: string, cert: PeerCertificate) => checkServerIdentity(host, cert) ?? (fingerprintDer(cert.raw) === trust.fingerprint ? undefined : new Error("pin mismatch")),
    }, res => { const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => { try { const text = Buffer.concat(chunks).toString("utf8"); resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} }); } catch (e) { reject(e); } }); res.on("error", reject); });
    req.on("error", reject); req.end(payload);
  });
}
async function owner(socket: string, op: string, args: Json): Promise<Json> {
  const out = await ownerControlRequest(socket, { op, args } as never);
  assert.equal(out.kind, "response"); const response = (out as { response: Json }).response; assert.equal(response.ok, true, JSON.stringify(response)); return response.result;
}
/** ACTUAL owner flow over the UDS: fresh offer -> mTLS claim by a memory-only client identity -> owner approval bound to
 * the shown public pin -> mTLS status. Returns the new device id and binding revision. */
export async function pairOverOwner(socket: string, client: TlsIdentity, scopes: readonly string[] = ["chat.write"]): Promise<{ deviceId: string; bindingRevision: number }> {
  const bundle = await owner(socket, "offer.create", { kind: "pair", role: "client-ios", scopes: [...scopes].sort() });
  const der = Buffer.from(String(bundle.hostCertificateDER), "base64");
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  assert.equal(fingerprintDer(new X509Certificate(certPem).raw), bundle.hostFingerprint);
  const trust = { url: String(bundle.hostUrl), certPem, fingerprint: String(bundle.hostFingerprint) };
  const claimed = await mtls(trust, client, "/app-client/v1/pair/claim", { offerId: bundle.offerId, code: bundle.code, name: "Synthetic relay app" });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.json));
  const claims = await owner(socket, "claims.list", {});
  assert.ok(claims.items.some((c: Json) => c.claimId === claimed.json.claimId && c.clientFingerprint === client.fingerprint));
  const approved = await owner(socket, "claim.approve", { claimId: claimed.json.claimId, clientFingerprint: client.fingerprint });
  assert.equal(approved.grantsCreated, 0);
  const status = await mtls(trust, client, "/app-client/v1/pair/status", { claimId: claimed.json.claimId });
  assert.equal(status.json.status, "approved"); assert.equal(status.json.deviceId, approved.deviceId);
  return { deviceId: String(approved.deviceId), bindingRevision: Number(status.json.bindingRevision) };
}

// ---- separate relay-service process (real CLI parser/lifecycle, memory TLS over IPC) ------------------------------
export interface ServiceProcess { port: number; transport(timeoutMs?: number): PinnedRelayTransport; stop(): Promise<{ code: number | null; events: string[] }> }
/** `revokedDevices` (optional, public device IDs) is passed through verbatim to the service config; nothing is derived or added. */
export async function relayService(t: TestContext, dir: string, name: string, tls: TlsIdentity, config: { dataDir: string; ownerId: string; installationId: string; pins: DevicePin[]; revokedDevices?: string[] }): Promise<ServiceProcess> {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify({ version: 1, dataDir: config.dataDir, ownerId: config.ownerId, installationId: config.installationId, host: "127.0.0.1", port: 0, pins: config.pins,
    ...(config.revokedDevices === undefined ? {} : { revokedDevices: config.revokedDevices }) }), { mode: 0o600, flag: "wx" });
  const child = fork(new URL("./relay-service-memory-cli.js", import.meta.url), ["--config", path], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "", exited = false; const events: string[] = [];
  child.stdout!.on("data", b => { stdout += String(b); }); child.stderr!.resume();
  const exit = new Promise<number | null>(resolve => child.once("exit", c => { exited = true; resolve(c); }));
  defer(t, async () => { if (!exited) { child.kill("SIGTERM"); await exit; } });
  child.send({ key: tls.keyPem, cert: tls.certPem });
  const until = Date.now() + 10_000;
  while (!stdout.includes("\n")) { if (exited || Date.now() > until) throw new Error("relay service did not listen"); await new Promise(r => setTimeout(r, 10)); }
  const ready = JSON.parse(stdout.split("\n")[0]!); assert.equal(ready.event, "listening");
  const pin = createHash("sha256").update(new X509Certificate(tls.certPem).raw).digest("base64");
  return { port: ready.port,
    transport: (timeoutMs = 3000) => new PinnedRelayTransport({ host: "127.0.0.1", port: ready.port, servername: "localhost", ca: tls.certPem, leafSha256: pin, timeoutMs }),
    stop: async () => { child.kill("SIGTERM"); const c = await exit; for (const line of stdout.split("\n").filter(Boolean)) events.push(JSON.parse(line).event); return { code: c, events }; } };
}

/** Real `dexter` CLI as a separate process; stderr is private (only parsed, never published). */
export function dexter(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [new URL("../../../packages/cli/dist/index.js", import.meta.url).pathname, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  let stdout = "", stderr = ""; child.stdout.on("data", b => { stdout += String(b); }); child.stderr.on("data", b => { stderr += String(b); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
  return new Promise(resolve => child.once("exit", c => { clearTimeout(timer); resolve({ code: c, stdout, stderr }); }));
}
export const parse = (text: string): Json => JSON.parse(text);
