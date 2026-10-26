// Shared synthetic lab for the paired app-client listener. Private temp dirs, loopback only, synthetic keys.
// No real account, Keychain, engine inference or remote network.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkServerIdentity, type PeerCertificate, type SecureVersion } from "node:tls";
import type { TestContext } from "node:test";
import { ConversationRuntime, HostStore, type RuntimeDriver, type RuntimeEngineEvent } from "@dexter/hub";
import { fingerprintDer, createLabTlsIdentity, privateDirectory, type TlsIdentity } from "@dexter/devices";
import { AppClientServices, type AppClientDeviceSource } from "../packages/cli/src/app-client-services.js";

/** LAB ONLY. Public certificate on disk; private key stays in memory. */
export function hostIdentity(dir: string, san = "IP:127.0.0.1", days = 1): TlsIdentity {
  if (!Number.isInteger(days) || days < 0 || days > 365) throw new Error("invalid lab validity");
  const identity = createLabTlsIdentity({ profile: "host", name: "dexter-synthetic-app-host", san: san.split(","),
    notBefore: new Date(Date.now() - 60000), notAfter: new Date(Date.now() + (days ? days * 86400000 : -1000)) }).identity;
  privateDirectory(dir); writeFileSync(join(dir, "cert.pem"), identity.certPem, {mode: 0o600, flag: "wx"}); return identity;
}
export function clientIdentity(dir: string): TlsIdentity {
  const identity = createLabTlsIdentity({profile: "client", name: "dexter-synthetic-app-client"}).identity;
  privateDirectory(dir); writeFileSync(join(dir, "cert.pem"), identity.certPem, {mode: 0o600, flag: "wx"}); return identity;
}

export interface Trust { url: string; certPem: string; fingerprint: string }
export interface CallOptions { headers?: Record<string, string>; rawBody?: string; maxVersion?: SecureVersion; servername?: string; host?: string }
export interface Reply { status: number; json: Record<string, unknown> & { items?: unknown[] } }

/** Pinned mutual-TLS request like the native client: exact pin, SAN hostname and validity, TLS 1.3 only. */
export function call(trust: Trust, identity: TlsIdentity | null, method: string, path: string, body?: unknown, options: CallOptions = {}): Promise<Reply> {
  const url = new URL(trust.url);
  const payload = options.rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  const headers: Record<string, string> = { ...(payload !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}),
    ...(options.host ? { host: options.host } : {}), ...options.headers };
  return new Promise((resolve, reject) => {
    const req = request({
      host: url.hostname, port: url.port, method, path, headers, agent: false,
      ...(identity ? { cert: identity.certPem, key: identity.keyPem } : {}),
      ca: [trust.certPem], minVersion: options.maxVersion ?? "TLSv1.3", maxVersion: options.maxVersion ?? "TLSv1.3",
      ...(options.servername ? { servername: options.servername } : {}),
      checkServerIdentity: (host: string, cert: PeerCertificate) => {
        const error = checkServerIdentity(options.servername ?? (options.host ? url.hostname : host), cert);
        if (error) return error;
        return fingerprintDer(cert.raw) === trust.fingerprint ? undefined : new Error("pin mismatch");
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) as Reply["json"] : {} }); } catch (error) { reject(error); }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(payload);
  });
}

export function fakeDriver(text = ["Olá, ", "Dexter."]): RuntimeDriver & { calls: number } {
  const driver = {
    id: "codex" as const, calls: 0,
    open: async (threadId: string) => ({ threadId, nativeCursor: "native-test-session" }),
    async *turn(session: { threadId: string }, turnId: string): AsyncIterable<RuntimeEngineEvent> {
      driver.calls++;
      for (const delta of text) yield { type: "text.delta", threadId: session.threadId, turnId, text: delta };
      yield { type: "turn.completed", threadId: session.threadId, turnId, usage: {} };
    },
    respondToTool: async () => {}, interrupt: async () => {}, close: async () => {},
  };
  return driver as RuntimeDriver & { calls: number };
}

export interface AppLab {
  root: string; store: HostStore; runtime: ConversationRuntime; services: AppClientServices; trust: Trust; host: TlsIdentity;
  identity(label: string): TlsIdentity;
}
export async function appLab(t: TestContext, options: { devices?: (store: HostStore) => AppClientDeviceSource & { close?: () => Promise<void> }; keepOpen?: boolean } = {}): Promise<AppLab> {
  const root = mkdtempSync(join(tmpdir(), "dexter-app-client-"));
  chmodSync(root, 0o700);
  const host = hostIdentity(join(root, "id-host"));
  const store = new HostStore({ dataDir: join(root, "host") });
  const runtime = new ConversationRuntime({ store, drivers: [fakeDriver()] });
  const devices = options.devices?.(store);
  const services = new AppClientServices(store, { identity: host }, { runtime, ...(devices ? { devices } : {}) });
  const url = await services.start();
  t.after(async () => {
    if (!options.keepOpen) {
      await services.close();
      await devices?.close?.();
      await runtime.shutdown({ closeStore: false });
      store.close();
    }
    rmSync(root, { recursive: true, force: true });
  });
  let n = 0;
  return { root, store, runtime, services, host, trust: { url, certPem: host.certPem, fingerprint: host.fingerprint },
    identity: (label: string) => clientIdentity(join(root, `id-${label}-${++n}`)) };
}
export const ALL_SCOPES = ["approvals.decide", "approvals.read", "chat.read", "chat.write", "devices.manage", "devices.read", "grants.manage", "grants.read"] as const;
/** Owner bundle -> TLS claim -> owner approval -> TLS status. Returns the approved device id. */
export async function pairClient(l: AppLab, identity: TlsIdentity, role: "client-ios" | "client-mac" = "client-ios",
  scopes: readonly (typeof ALL_SCOPES[number])[] = ALL_SCOPES, name = "Lab iPhone"): Promise<string> {
  const bundle = l.services.admin.pairingBundle({ kind: "pair", role, scopes: [...scopes] });
  const claimed = await call(l.trust, identity, "POST", "/app-client/v1/pair/claim", { offerId: bundle.offerId, code: bundle.code, name });
  if (claimed.status !== 200) throw new Error(`claim ${claimed.status}`);
  l.services.admin.approveClaim(claimed.json.claimId as string);
  const status = await call(l.trust, identity, "POST", "/app-client/v1/pair/status", { claimId: claimed.json.claimId });
  if (status.json.status !== "approved" || status.json.installationId !== l.store.hostId) throw new Error("not approved");
  return status.json.deviceId as string;
}
export function removeDir(path: string): void { rmSync(path, { recursive: true, force: true }); }
export function tempDir(prefix: string): string { const dir = mkdtempSync(join(tmpdir(), prefix)); chmodSync(dir, 0o700); return dir; }
