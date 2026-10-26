// Real TLS 1.3 mutual-auth channel on loopback between the host endpoint and the daemon, in one process.
// Synthetic identities in private temp dirs only; no remote host, no engine, no user data.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { inspect } from "node:util";
import { HostError, HostStore } from "@dexter/hub";
import {
  DeviceClient, DeviceError, DeviceHostServer, DevicePairingRegistry, FILE_APPEND, FILE_READ, MacDeviceDaemon, PROCESS_PROBE,
  createFixtureHandlers, generateSyntheticIdentity, pairDevice, type HostTrust, type TlsIdentity,
} from "@dexter/devices";

const ALL = [FILE_APPEND, FILE_READ, PROCESS_PROBE];
const code = (c: string) => (e: unknown) => e instanceof DeviceError && e.code === c;
const hostCode = (c: string) => (e: unknown) => e instanceof HostError && e.code === c;
const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("until timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

interface Lab {
  root: string; store: HostStore; registry: DevicePairingRegistry; server: DeviceHostServer; trust: HostTrust;
  ids: { host: TlsIdentity; dev: TlsIdentity; evil: TlsIdentity; other: TlsIdentity };
  fixtures: string; offset: { ms: number };
}
async function lab(t: TestContext, receiptTimeoutMs = 3_000): Promise<Lab> {
  const root = mkdtempSync(join(tmpdir(), "dexter-devices-"));
  chmodSync(root, 0o700);
  const ids = {
    host: generateSyntheticIdentity(join(root, "id-host"), "host"), dev: generateSyntheticIdentity(join(root, "id-dev"), "dev"),
    evil: generateSyntheticIdentity(join(root, "id-evil"), "evil"), other: generateSyntheticIdentity(join(root, "id-other"), "other-host"),
  };
  const offset = { ms: 0 };
  const store = new HostStore({ dataDir: join(root, "host"), clock: () => Date.now() + offset.ms });
  const registry = new DevicePairingRegistry(store);
  const server = new DeviceHostServer({ store, registry, identity: ids.host, pollWaitMs: 100, receiptTimeoutMs });
  const url = await server.start();
  const fixtures = join(root, "fixtures");
  const l: Lab = { root, store, registry, server, ids, fixtures, offset, trust: { hostUrl: url, hostCertPem: ids.host.certPem, hostFingerprint: ids.host.fingerprint } };
  mkdirSync(fixtures, { mode: 0o700 });
  t.after(async () => {
    await server.close();
    registry.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return l;
}
async function pair(l: Lab, identity: TlsIdentity, dataDir: string, capabilities = ALL): Promise<string> {
  const bundle = l.server.pairingBundle({ kind: "pair" });
  const pairing = pairDevice({ dataDir, identity, trust: l.trust, offerId: bundle.offerId, code: bundle.code, name: "Lab Mac", capabilities, pollIntervalMs: 20 });
  await until(() => l.registry.listPendingClaims().length === 1);
  const [claim] = l.registry.listPendingClaims();
  assert.equal(claim!.clientFingerprint, identity.fingerprint);
  l.registry.approveClaim(claim!.claimId);
  return (await pairing).deviceId;
}
function daemon(l: Lab, identity: TlsIdentity, dataDir: string, beforeEffect?: (tool: string) => Promise<void>): MacDeviceDaemon {
  return new MacDeviceDaemon({
    dataDir, identity, trust: l.trust, pollTimeoutMs: 3_000,
    handlers: createFixtureHandlers({ root: l.fixtures, enable: ALL, ...(beforeEffect ? { beforeEffect } : {}) }),
  });
}
function botWithGrant(l: Lab, deviceId: string, tool: string, policy: "allow" | "ask" | "deny" = "allow") {
  const bot = l.store.createBot({ name: "Synthetic", profileId: "lab", engine: "claude" });
  const thread = l.store.createThread(bot.id);
  l.store.setGrant({ botId: bot.id, tool, destination: deviceId, policy });
  let n = 0;
  return {
    bot, thread,
    request: (args: Record<string, unknown>, t = tool) => l.store.requestAction({ botId: bot.id, threadId: thread.id, tool: t, destination: deviceId, arguments: args, idempotencyKey: `k${++n}` }),
  };
}
async function dispatchWith(l: Lab, d: MacDeviceDaemon, actionId: string) {
  const [action] = await Promise.all([l.server.dispatch(actionId), d.runOnce()]);
  return action;
}
function raw(l: Lab, identity: TlsIdentity | null, opts: { method?: string; path: string; body?: string | Buffer; type?: string }): Promise<{ status: number; body: string } | { error: string }> {
  const url = new URL(l.trust.hostUrl);
  return new Promise((resolve) => {
    const req = request({
      hostname: url.hostname, port: Number(url.port), method: opts.method ?? "POST", path: opts.path, agent: false, ca: [l.ids.host.certPem],
      ...(identity ? { cert: identity.certPem, key: identity.keyPem } : {}), checkServerIdentity: () => undefined, minVersion: "TLSv1.3",
      headers: { "content-type": opts.type ?? "application/json" },
    }, (res) => { let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => { resolve({ status: res.statusCode ?? 0, body: b }); }); res.on("error", () => resolve({ error: "reset" })); });
    req.on("error", () => { resolve({ error: "reset" }); });
    req.end(opts.body ?? "{}");
  });
}

test("pairs over pinned mutual TLS and runs granted file and probe operations end to end", async (t) => {
  const l = await lab(t);
  const deviceDir = join(l.root, "mac");
  const deviceId = await pair(l, l.ids.dev, deviceDir);
  const device = l.store.getDevice(deviceId);
  assert.equal(device.platform, "macos");
  assert.deepEqual(device.capabilities, [...ALL].sort());
  assert.equal(l.registry.activeFingerprint(deviceId), l.ids.dev.fingerprint);
  const d = daemon(l, l.ids.dev, deviceDir);
  t.after(() => d.stop());
  const g = botWithGrant(l, deviceId, FILE_APPEND);
  l.store.setGrant({ botId: g.bot.id, tool: FILE_READ, destination: deviceId, policy: "allow" });
  l.store.setGrant({ botId: g.bot.id, tool: PROCESS_PROBE, destination: deviceId, policy: "allow" });

  const append = await dispatchWith(l, d, g.request({ name: "notes.txt", line: "hello" }).id);
  assert.equal(append.state, "succeeded");
  assert.deepEqual(append.result, { ok: true, result: { name: "notes.txt", appendedBytes: 6 } });
  assert.equal(readFileSync(join(l.fixtures, "notes.txt"), "utf8"), "hello\n");
  const read = await dispatchWith(l, d, g.request({ name: "notes.txt" }, FILE_READ).id);
  assert.equal((read.result as { result: { text: string } }).result.text, "hello\n");
  const missing = await dispatchWith(l, d, g.request({ name: "absent.txt" }, FILE_READ).id);
  assert.deepEqual(missing.result, { ok: false, code: "not_found" });
  const probe = await dispatchWith(l, d, g.request({}, PROCESS_PROBE).id);
  assert.deepEqual(probe.result, { ok: true, result: { probe: "dexter-synthetic", platform: process.platform, arch: process.arch, node: process.versions.node } });
  assert.deepEqual(d.journal.entry(append.id), { status: "completed", acked: true, code: null });
  // Arguments outside the declared shape never become an action that reaches the device.
  const bad = g.request({ name: "../escape", line: "x" });
  await assert.rejects(l.server.dispatch(bad.id), code("invalid_input"));
  assert.equal(l.store.getAction(bad.id).state, "ready");
  for (const view of [JSON.stringify(l.server), JSON.stringify(l.ids.dev), inspect(l.ids.dev), inspect(l.server, { depth: 6 }), inspect(d, { depth: 6 })]) {
    assert.equal(view.includes("PRIVATE KEY"), false);
  }
});

test("wrong server pin and wrong client certificate are refused with fixed codes", async (t) => {
  const l = await lab(t);
  const deviceDir = join(l.root, "mac");
  const deviceId = await pair(l, l.ids.dev, deviceDir);
  // Host presents a certificate other than the pinned one.
  const wrongPin = new DeviceClient(l.ids.dev, { hostUrl: l.trust.hostUrl, hostCertPem: l.ids.other.certPem, hostFingerprint: l.ids.other.fingerprint });
  await assert.rejects(wrongPin.post("device/poll", { deviceId, installationId: l.store.hostId, receipts: [] }, 2_000), code("tls_pin_mismatch"));
  assert.throws(() => new DeviceClient(l.ids.dev, { ...l.trust, hostFingerprint: l.ids.other.fingerprint }), code("tls_pin_mismatch"));
  // A valid TLS client whose certificate is not the device's pin cannot act as the device, whatever id it names.
  const impostor = new DeviceClient(l.ids.evil, l.trust);
  await assert.rejects(impostor.post("device/poll", { deviceId, installationId: l.store.hostId, receipts: [] }, 2_000), code("forbidden"));
  // No client certificate: the connection is dropped before any route runs.
  const anonymous = await raw(l, null, { path: "/v1/device/poll", body: JSON.stringify({ deviceId, installationId: l.store.hostId, receipts: [] }) });
  assert.ok("error" in anonymous);
  // The real device but naming another installation is refused.
  const real = new DeviceClient(l.ids.dev, l.trust);
  await assert.rejects(real.post("device/poll", { deviceId, installationId: "host_other", receipts: [] }, 2_000), code("forbidden"));
});

test("foreign device id with a valid pin, wrong pairing codes and reused certificates are refused", async (t) => {
  const l = await lab(t);
  const devA = await pair(l, l.ids.dev, join(l.root, "mac-a"));
  const devB = await pair(l, l.ids.evil, join(l.root, "mac-b"));
  const asA = new DeviceClient(l.ids.dev, l.trust);
  await assert.rejects(asA.post("device/poll", { deviceId: devB, installationId: l.store.hostId, receipts: [] }, 2_000), code("forbidden"));
  assert.deepEqual(await asA.post("device/poll", { deviceId: devA, installationId: l.store.hostId, receipts: [] }, 2_000), { jobs: [] });
  // Pairing code guessing exhausts the offer; the right code afterwards is refused too.
  const bundle = l.server.pairingBundle({ kind: "pair" });
  const fresh = generateSyntheticIdentity(join(l.root, "id-fresh"), "fresh");
  const client = new DeviceClient(fresh, l.trust);
  const body = (c: string) => ({ offerId: bundle.offerId, code: c, name: "x", platform: "macos", capabilities: [FILE_READ] });
  for (let i = 0; i < 5; i += 1) await assert.rejects(client.post("pair/claim", body("A".repeat(43)), 2_000), code("forbidden"));
  await assert.rejects(client.post("pair/claim", body(bundle.code), 2_000), code("forbidden"));
  // A certificate already pinned to a device cannot claim another identity.
  const again = l.server.pairingBundle({ kind: "pair" });
  await assert.rejects(asA.post("pair/claim", { offerId: again.offerId, code: again.code, name: "x", platform: "macos", capabilities: [FILE_READ] }, 2_000), code("forbidden"));
  // Unsupported capabilities (browser/CDP, CUA, Keychain) cannot be advertised.
  await assert.rejects(client.post("pair/claim", { offerId: again.offerId, code: again.code, name: "x", platform: "macos", capabilities: ["mac.browser.cdp"] }, 2_000), code("unsupported"));
  // Claim status is visible only to the certificate that claimed.
  const claimed = await client.post("pair/claim", { offerId: again.offerId, code: again.code, name: "x", platform: "macos", capabilities: [FILE_READ] }, 2_000);
  await assert.rejects(asA.post("pair/status", { claimId: claimed.claimId }, 2_000), code("not_found"));
  l.registry.rejectClaim(claimed.claimId as string);
  assert.equal((await client.post("pair/status", { claimId: claimed.claimId }, 2_000)).status, "rejected");
});

test("grants: deny and other bots are refused, ask binds approval to the request hash", async (t) => {
  const l = await lab(t);
  const deviceDir = join(l.root, "mac");
  const deviceId = await pair(l, l.ids.dev, deviceDir);
  const d = daemon(l, l.ids.dev, deviceDir);
  t.after(() => d.stop());
  const denied = botWithGrant(l, deviceId, FILE_APPEND, "deny");
  assert.throws(() => denied.request({ name: "a.txt", line: "x" }), hostCode("forbidden"));
  const other = l.store.createBot({ name: "Other", profileId: "lab", engine: "codex" });
  const otherThread = l.store.createThread(other.id);
  assert.throws(() => l.store.requestAction({ botId: other.id, threadId: otherThread.id, tool: FILE_APPEND, destination: deviceId, arguments: { name: "a.txt", line: "x" }, idempotencyKey: "o1" }), hostCode("forbidden"));
  const ask = botWithGrant(l, deviceId, FILE_APPEND, "ask");
  const pending = ask.request({ name: "a.txt", line: "approved" });
  assert.equal(pending.state, "awaiting_approval");
  await assert.rejects(l.server.dispatch(pending.id), hostCode("conflict"));
  assert.throws(() => l.store.decideAction(pending.id, { decision: "allow", requestHash: "0".repeat(64) }), hostCode("conflict"));
  l.store.decideAction(pending.id, { decision: "allow", requestHash: pending.requestHash });
  assert.equal((await dispatchWith(l, d, pending.id)).state, "succeeded");
  assert.equal(readFileSync(join(l.fixtures, "a.txt"), "utf8"), "approved\n");
});

test("offline device leaves the action ready; after a heartbeat it dispatches", async (t) => {
  const l = await lab(t);
  const deviceDir = join(l.root, "mac");
  const deviceId = await pair(l, l.ids.dev, deviceDir);
  const d = daemon(l, l.ids.dev, deviceDir);
  t.after(() => d.stop());
  const g = botWithGrant(l, deviceId, FILE_APPEND);
  const action = g.request({ name: "off.txt", line: "later" });
  l.offset.ms = l.store.deviceTtlMs + 1_000;
  assert.equal(l.store.devicePresence(deviceId), "stale");
  await assert.rejects(l.server.dispatch(action.id), hostCode("device_unavailable"));
  assert.equal(l.store.getAction(action.id).state, "ready");
  assert.deepEqual(await d.runOnce(), { jobs: 0 });
  assert.equal(l.store.devicePresence(deviceId), "online");
  assert.equal((await dispatchWith(l, d, action.id)).state, "succeeded");
});

test("revocation blocks pending actions, refuses the device and never restores it", async (t) => {
  const l = await lab(t);
  const deviceDir = join(l.root, "mac");
  const deviceId = await pair(l, l.ids.dev, deviceDir);
  const d = daemon(l, l.ids.dev, deviceDir);
  t.after(() => d.stop());
  const g = botWithGrant(l, deviceId, FILE_APPEND);
  const ready = g.request({ name: "r.txt", line: "never" });
  let stopReason: string | null | undefined;
  d.start((reason) => { stopReason = reason; });
  await until(() => l.server.status().connections > 0);
  l.server.revokeDevice(deviceId);
  assert.equal(l.store.getAction(ready.id).state, "blocked");
  assert.equal(l.store.getAction(ready.id).reason, "permission_changed");
  await until(() => stopReason !== undefined);
  assert.equal(stopReason, "forbidden");
  assert.deepEqual(l.registry.listCertificates(deviceId).map((c) => c.state), ["revoked"]);
  // The pre-revoke action remains durably blocked; fresh refusal adds no action or event.
  assert.equal(l.store.getAction(ready.id).result, null);
  await assert.rejects(l.server.dispatch(ready.id), hostCode("conflict"));
  const counts = l.store.summary().counts;
  assert.throws(() => g.request({ name: "r.txt", line: "again" }), hostCode("forbidden"));
  assert.deepEqual(l.store.summary().counts, counts);
  await assert.rejects(l.server.dispatch(ready.id), hostCode("conflict"));
  assert.deepEqual(l.store.summary().counts, counts);
  assert.throws(() => readFileSync(join(l.fixtures, "r.txt")));
  // The revoked certificate cannot pair again, so no new identity inherits anything.
  const bundle = l.server.pairingBundle({ kind: "pair" });
  await assert.rejects(new DeviceClient(l.ids.dev, l.trust).post("pair/claim", { offerId: bundle.offerId, code: bundle.code, name: "x", platform: "macos", capabilities: [FILE_READ] }, 2_000), code("forbidden"));
  assert.throws(() => l.registry.createOffer({ kind: "rotate", deviceId }), code("conflict"));
});

test("rotation keeps the device id and grants; the retired certificate is refused", async (t) => {
  const l = await lab(t);
  const deviceDir = join(l.root, "mac");
  const deviceId = await pair(l, l.ids.dev, deviceDir);
  const g = botWithGrant(l, deviceId, FILE_APPEND);
  const next = generateSyntheticIdentity(join(l.root, "id-next"), "next");
  const bundle = l.server.pairingBundle({ kind: "rotate", deviceId });
  const rotating = pairDevice({ dataDir: deviceDir, identity: next, trust: l.trust, offerId: bundle.offerId, code: bundle.code, name: "Lab Mac", capabilities: ALL, pollIntervalMs: 20 });
  await until(() => l.registry.listPendingClaims().length === 1);
  l.registry.approveClaim(l.registry.listPendingClaims()[0]!.claimId);
  assert.equal((await rotating).deviceId, deviceId);
  await assert.rejects(new DeviceClient(l.ids.dev, l.trust).post("device/poll", { deviceId, installationId: l.store.hostId, receipts: [] }, 2_000), code("forbidden"));
  const d = daemon(l, next, deviceDir);
  t.after(() => d.stop());
  assert.equal((await dispatchWith(l, d, g.request({ name: "rot.txt", line: "ok" }).id)).state, "succeeded");
});

test("late effect after the receipt timeout is unknown, recorded late and never repeated", async (t) => {
  const l = await lab(t, 300);
  const deviceDir = join(l.root, "mac");
  const deviceId = await pair(l, l.ids.dev, deviceDir);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const d = daemon(l, l.ids.dev, deviceDir, async () => { await gate; });
  const g = botWithGrant(l, deviceId, FILE_APPEND);
  const action = g.request({ name: "late.txt", line: "once" });
  const run = d.runOnce();
  const settled = await l.server.dispatch(action.id);
  assert.equal(settled.state, "unknown");
  assert.equal(settled.reason, "executor_error");
  release();
  await run;
  assert.equal(readFileSync(join(l.fixtures, "late.txt"), "utf8"), "once\n");
  assert.equal(l.registry.lateReceipt(action.id)?.status, "completed");
  assert.equal(l.store.getAction(action.id).state, "unknown");
  // Same idempotency key replays the stored unknown action; it cannot be dispatched again.
  assert.equal(l.store.requestAction({ botId: g.bot.id, threadId: g.thread.id, tool: FILE_APPEND, destination: deviceId, arguments: { name: "late.txt", line: "once" }, idempotencyKey: "k1" }).id, action.id);
  await assert.rejects(l.server.dispatch(action.id), hostCode("conflict"));
  // Daemon restart: the journal still knows the action, so a replayed job yields the stored receipt.
  await d.stop();
  const restarted = daemon(l, l.ids.dev, deviceDir);
  t.after(() => restarted.stop());
  const replay = restarted.journal.begin({ hostId: l.store.hostId, actionId: action.id, requestHash: action.requestHash, nonce: "f".repeat(32), tool: FILE_APPEND });
  assert.equal(replay.kind, "existing");
  assert.equal(readFileSync(join(l.fixtures, "late.txt"), "utf8"), "once\n");
});

test("daemon crash during an effect becomes unknown on restart and is reported, not re-run", async (t) => {
  const l = await lab(t);
  const deviceDir = join(l.root, "mac");
  const deviceId = await pair(l, l.ids.dev, deviceDir);
  const first = daemon(l, l.ids.dev, deviceDir);
  const g = botWithGrant(l, deviceId, FILE_APPEND);
  const action = g.request({ name: "crash.txt", line: "x" });
  // Simulate the journal start committed just before the process died.
  first.journal.begin({ hostId: l.store.hostId, actionId: action.id, requestHash: action.requestHash, nonce: "a".repeat(32), tool: FILE_APPEND });
  await first.stop();
  const second = daemon(l, l.ids.dev, deviceDir);
  t.after(() => second.stop());
  assert.deepEqual(second.journal.entry(action.id), { status: "unknown", acked: false, code: "daemon_interrupted" });
  await second.runOnce();
  assert.equal(second.journal.entry(action.id)?.acked, true);
  assert.equal(l.registry.lateReceipt(action.id)?.status, "unknown");
  assert.equal(l.store.getAction(action.id).state, "ready");
  assert.throws(() => readFileSync(join(l.fixtures, "crash.txt")));
  // A second daemon on the same journal fails closed.
  assert.throws(() => daemon(l, l.ids.dev, deviceDir), code("conflict"));
});

test("fenced writer: a second host is refused and a lost lease stops pairing and dispatch", async (t) => {
  const l = await lab(t);
  const deviceDir = join(l.root, "mac");
  const deviceId = await pair(l, l.ids.dev, deviceDir);
  assert.throws(() => new HostStore({ dataDir: join(l.root, "host") }), hostCode("host_locked"));
  const g = botWithGrant(l, deviceId, FILE_APPEND);
  const action = g.request({ name: "fence.txt", line: "x" });
  const offersBefore = new DatabaseSync(l.registry.databasePath, { readOnly: true });
  const count = () => Number((offersBefore.prepare("SELECT COUNT(*) AS n FROM offers").get() as { n: number }).n);
  const before = count();
  const rawDb = new DatabaseSync(l.store.databasePath);
  rawDb.exec("UPDATE host_lease SET token = 'stolen-by-test'");
  rawDb.close();
  assert.throws(() => l.server.pairingBundle({ kind: "pair" }), hostCode("host_locked"));
  assert.equal(count(), before);
  offersBefore.close();
  await assert.rejects(l.server.dispatch(action.id), hostCode("host_locked"));
  const client = new DeviceClient(l.ids.dev, l.trust);
  await assert.rejects(client.post("device/poll", { deviceId, installationId: l.store.hostId, receipts: [] }, 2_000), code("unavailable"));
});

test("bounded bodies, strict routes and shutdown drain", async (t) => {
  const l = await lab(t, 5_000);
  const deviceDir = join(l.root, "mac");
  const deviceId = await pair(l, l.ids.dev, deviceDir);
  const big = await raw(l, l.ids.dev, { path: "/v1/device/poll", body: Buffer.alloc(80 * 1024, 0x20) });
  assert.ok("error" in big || big.status === 400);
  const unknown = await raw(l, l.ids.dev, { path: "/v1/anything" });
  assert.deepEqual(unknown, { status: 404, body: JSON.stringify({ error: "not_found" }) });
  const get = await raw(l, l.ids.dev, { method: "GET", path: "/v1/device/poll" });
  assert.equal("status" in get && get.status, 400);
  const text = await raw(l, l.ids.dev, { path: "/v1/device/poll", type: "text/plain" });
  assert.equal("status" in text && text.status, 400);
  const extra = await raw(l, l.ids.dev, { path: "/v1/device/poll", body: JSON.stringify({ deviceId, installationId: l.store.hostId, receipts: [], more: 1 }) });
  assert.deepEqual(extra, { status: 400, body: JSON.stringify({ error: "invalid_input" }) });
  // A job waiting for its device is failed as unknown when the endpoint shuts down.
  const g = botWithGrant(l, deviceId, FILE_APPEND);
  const action = g.request({ name: "drain.txt", line: "x" });
  const dispatched = l.server.dispatch(action.id);
  await until(() => l.server.status().pendingJobs === 1);
  await l.server.close();
  assert.equal((await dispatched).state, "unknown");
  assert.equal(l.server.status().listening, false);
});

// Regressions adapted from the independent review probes: the long-poll continuation after a queued wake
// must revalidate under the writer lease, and a direct runOnce must be drained by stop.
const waiters = (l: Lab) => (l.server as unknown as { waiters: Map<string, () => void> }).waiters;
async function parkedPoll(l: Lab, deviceId: string) {
  const client = new DeviceClient(l.ids.dev, l.trust);
  const poll = client.post("device/poll", { deviceId, installationId: l.store.hostId, receipts: [] }, 2_000);
  await until(() => waiters(l).size === 1);
  return { client, poll };
}

test("long-poll woken by a job delivers nothing once the writer lease is lost before the continuation", async (t) => {
  const l = await lab(t);
  const deviceId = await pair(l, l.ids.dev, join(l.root, "mac"));
  const g = botWithGrant(l, deviceId, FILE_APPEND);
  const action = g.request({ name: "fenced.txt", line: "x" });
  const { client, poll } = await parkedPoll(l, deviceId);
  // Queue + wake happen synchronously inside dispatch; the poll continuation runs on a later tick.
  // The fenced host cannot record the outcome either; restart recovery resolves the running action.
  const dispatched = assert.rejects(l.server.dispatch(action.id), hostCode("host_locked"));
  const rawDb = new DatabaseSync(l.store.databasePath);
  const token = (rawDb.prepare("SELECT token FROM host_lease WHERE id = 1").get() as { token: string }).token;
  rawDb.prepare("UPDATE host_lease SET token = 'fenced-by-test' WHERE id = 1").run();
  await assert.rejects(poll, code("unavailable"));
  await dispatched;
  assert.equal(l.store.getAction(action.id).state, "running");
  rawDb.prepare("UPDATE host_lease SET token = ? WHERE id = 1").run(token);
  rawDb.close();
  // The queued job was failed, not parked: it is never delivered later.
  assert.equal(l.server.status().pendingJobs, 0);
  const later = await client.post("device/poll", { deviceId, installationId: l.store.hostId, receipts: [] }, 2_000);
  assert.deepEqual(later.jobs, []);
  assert.throws(() => readFileSync(join(l.fixtures, "fenced.txt")));
});

test("long-poll woken by a job revalidates the current grant revision before handing it over", async (t) => {
  const l = await lab(t);
  const deviceId = await pair(l, l.ids.dev, join(l.root, "mac"));
  const g = botWithGrant(l, deviceId, FILE_APPEND);
  const cases: Array<[string, () => void]> = [
    ["deny", () => { l.store.setGrant({ botId: g.bot.id, tool: FILE_APPEND, destination: deviceId, policy: "deny" }); }],
    // allow -> deny -> allow restores the policy but not the revision the action was requested under.
    ["aba", () => {
      l.store.setGrant({ botId: g.bot.id, tool: FILE_APPEND, destination: deviceId, policy: "deny" });
      l.store.setGrant({ botId: g.bot.id, tool: FILE_APPEND, destination: deviceId, policy: "allow" });
    }],
    ["expired", () => { l.store.setGrant({ botId: g.bot.id, tool: FILE_APPEND, destination: deviceId, policy: "allow", expiresAt: l.store.now() + 1 }); }],
  ];
  for (const [name, change] of cases) {
    l.store.setGrant({ botId: g.bot.id, tool: FILE_APPEND, destination: deviceId, policy: "allow" });
    const action = g.request({ name: `${name}.txt`, line: "x" });
    const { client, poll } = await parkedPoll(l, deviceId);
    const dispatched = l.server.dispatch(action.id);
    change();
    if (name === "expired") l.offset.ms += 5;
    assert.deepEqual((await poll).jobs, [], name);
    const settled = await dispatched;
    assert.equal(settled.state, "unknown", name);
    assert.equal(settled.reason, "executor_error", name);
    assert.deepEqual((await client.post("device/poll", { deviceId, installationId: l.store.hostId, receipts: [] }, 2_000)).jobs, [], name);
    assert.throws(() => readFileSync(join(l.fixtures, `${name}.txt`)), name);
    l.offset.ms = 0;
  }
});

test("a delivered job is not re-sent after its grant changes; it settles unknown", async (t) => {
  const l = await lab(t);
  const deviceId = await pair(l, l.ids.dev, join(l.root, "mac"));
  const g = botWithGrant(l, deviceId, FILE_APPEND);
  const action = g.request({ name: "redeliver.txt", line: "x" });
  const { client, poll } = await parkedPoll(l, deviceId);
  const dispatched = l.server.dispatch(action.id);
  const first = await poll;
  assert.equal((first.jobs as unknown[]).length, 1);
  l.store.setGrant({ botId: g.bot.id, tool: FILE_APPEND, destination: deviceId, policy: "deny" });
  assert.deepEqual((await client.post("device/poll", { deviceId, installationId: l.store.hostId, receipts: [] }, 2_000)).jobs, []);
  assert.equal((await dispatched).state, "unknown");
});

test("stop drains a direct runOnce: no journal close or lease release while an effect is in flight", async (t) => {
  const l = await lab(t, 1_000);
  const deviceDir = join(l.root, "mac");
  const deviceId = await pair(l, l.ids.dev, deviceDir);
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  t.after(() => { release(); });
  const d = new MacDeviceDaemon({
    dataDir: deviceDir, identity: l.ids.dev, trust: l.trust, pollTimeoutMs: 3_000, stopTimeoutMs: 100,
    handlers: createFixtureHandlers({ root: l.fixtures, enable: ALL, beforeEffect: async () => { entered = true; await gate; } }),
  });
  const g = botWithGrant(l, deviceId, FILE_APPEND);
  const action = g.request({ name: "drain.txt", line: "once" });
  const run = d.runOnce();
  const dispatched = l.server.dispatch(action.id);
  await until(() => entered);
  // One run at a time, manual or looped.
  await assert.rejects(d.runOnce(), code("conflict"));
  // The handler ignores the abort: stop fails closed, keeping the journal open and its lease held.
  await assert.rejects(d.stop(), code("timeout"));
  assert.deepEqual(d.toJSON(), { deviceId, installationId: l.store.hostId, stopped: true, inflight: 1, running: true });
  assert.equal(d.journal.entry(action.id)?.status, "started");
  assert.throws(() => daemon(l, l.ids.dev, deviceDir), code("conflict"));
  await assert.rejects(d.runOnce(), code("unavailable"));
  release();
  assert.deepEqual(await run, { jobs: 1 });
  await d.stop();
  assert.deepEqual(d.toJSON(), { deviceId, installationId: l.store.hostId, stopped: true, inflight: 0, running: false });
  // The effect's outcome was journaled before the close; the next daemon reports it, never re-runs it.
  assert.equal((await dispatched).state, "unknown");
  const next = daemon(l, l.ids.dev, deviceDir);
  t.after(() => next.stop());
  assert.deepEqual(next.journal.entry(action.id), { status: "completed", acked: false, code: null });
  await next.runOnce();
  assert.equal(l.registry.lateReceipt(action.id)?.status, "completed");
  assert.equal(readFileSync(join(l.fixtures, "drain.txt"), "utf8"), "once\n");
});
