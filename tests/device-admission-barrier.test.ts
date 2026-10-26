// Synthetic loopback mutual TLS, ephemeral synthetic keys, fake engine driver and private temp dirs only.
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { AgendaHostConsumer } from "@dexter/agenda";
import type { EngineId } from "@dexter/contracts";
import { HostError, HostStore, ShutdownIncompleteError } from "@dexter/hub";
import { DeviceError, DeviceHostServer, DevicePairingRegistry, FILE_APPEND, generateSyntheticIdentity, pairDevice, type HostTrust, type TlsIdentity } from "@dexter/devices";
import type { HostServices as HostServicesType } from "../packages/cli/src/host-services.js";
const { HostServices } = await import(pathToFileURL(resolve("packages/cli/dist/host-services.js")).href) as { HostServices: typeof HostServicesType };
const { DeviceServices } = await import(pathToFileURL(resolve("packages/cli/dist/device-services.js")).href) as typeof import("../packages/cli/src/device-services.js");

const until = async (check: () => boolean, ms = 10000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw Error("fixture_timeout"); await new Promise(r => setTimeout(r, 5)); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const UNAVAILABLE = { status: 503, body: "{\"error\":\"unavailable\"}" };
const deviceCode = (code: string) => (e: unknown) => e instanceof DeviceError && e.code === code;
const hostCode = (code: string) => (e: unknown) => e instanceof HostError && e.code === code;
/** The barrier as published by the fixed server. Old code has none: the call is a no-op and the asserts fail. */
const barrier = (server: DeviceHostServer) => (server as unknown as { stopAdmission?: () => void }).stopAdmission?.();

/** Every canonical row of both stores, read through separate read-only connections. */
function snapshot(dataDir: string): string {
  const out: Record<string, string[]> = {};
  for (const file of ["dexter.sqlite", "devices.sqlite"]) {
    const db = new DatabaseSync(join(dataDir, file), { readOnly: true });
    try {
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
        out[`${file}:${name}`] = (db.prepare(`SELECT * FROM "${name}"`).all() as object[]).map(row => JSON.stringify(row)).sort();
    } finally { db.close(); }
  }
  return JSON.stringify(out);
}
/** Raw mutual-TLS request pinned to the host certificate. `hold` sends all but the last body byte and returns `finish` for the rest. */
function raw(trust: HostTrust, peer: TlsIdentity, path: string, body: object | string, options: { method?: string; hold?: boolean } = {}) {
  const u = new URL(trust.hostUrl), pin = new X509Certificate(trust.hostCertPem).raw, payload = typeof body === "string" ? body : JSON.stringify(body);
  let finish = () => {}; let sent = () => {};
  const flushed = new Promise<void>(done => { sent = done; });
  const response = new Promise<{ status: number; body: string }>((resolveResponse, reject) => {
    const req = httpsRequest({ host: u.hostname, port: Number(u.port), path, method: options.method ?? "POST", agent: false,
      cert: peer.certPem, key: peer.keyPem, ca: [trust.hostCertPem], rejectUnauthorized: true, minVersion: "TLSv1.3",
      checkServerIdentity: (_host, cert) => (cert.raw && cert.raw.equals(pin) ? undefined : Error("synthetic_pin_mismatch")),
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("error", reject);
      res.on("end", () => resolveResponse({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (options.hold) { req.write(payload.slice(0, -1), () => sent()); finish = () => { req.end(payload.slice(-1)); }; } else req.end(payload, () => sent());
  });
  void response.catch(() => {});
  return { response, flushed, finish: () => finish() };
}
const pollBody = (deviceId: string, installationId: string, receipts: object[] = []) => ({ deviceId, installationId, receipts });

async function standalone(t: TestContext, options: { pollWaitMs?: number; receiptTimeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dx-device-barrier-")); chmodSync(root, 0o700);
  const identity = generateSyntheticIdentity(join(root, "host-id"), "host"), peer = generateSyntheticIdentity(join(root, "peer-id"), "peer");
  const dataDir = join(root, "host"), store = new HostStore({ dataDir });
  const services = new DeviceServices(store, { identity, pollWaitMs: options.pollWaitMs ?? 50, receiptTimeoutMs: options.receiptTimeoutMs ?? 3000 });
  t.after(async () => { await services.close().catch(() => {}); try { store.close(); } catch { /* already closed */ } rmSync(root, { recursive: true, force: true }); });
  const url = await services.start(), trust: HostTrust = { hostUrl: url, hostFingerprint: identity.fingerprint, hostCertPem: identity.certPem };
  const offer = services.admin.pairingBundle({ kind: "pair" });
  const pending = pairDevice({ dataDir: join(root, "peer"), identity: peer, trust, offerId: offer.offerId, code: offer.code, name: "Mac", capabilities: [FILE_APPEND], pollIntervalMs: 10 });
  await until(() => services.admin.pendingClaims().length === 1);
  services.admin.approveClaim(services.admin.pendingClaims()[0]!.claimId);
  const id = (await pending).deviceId;
  const poll = () => raw(trust, peer, "/v1/device/poll", pollBody(id, store.hostId));
  return { root, dataDir, identity, peer, store, services, url, trust, id, poll,
    action(key = "one") {
      const bot = store.createBot({ name: "Device", profileId: "personal", engine: "claude" }), thread = store.createThread(bot.id);
      services.admin.grant({ botId: bot.id, tool: FILE_APPEND, destination: id, policy: "allow" });
      return store.requestAction({ botId: bot.id, threadId: thread.id, tool: FILE_APPEND, destination: id, arguments: { name: "notes.txt", line: "once" }, idempotencyKey: key });
    } };
}

test("BARRIER-1 F4: with Agenda.close held past grace, the paired TLS channel refuses NEW poll and pair/claim and the canonical stores stay unchanged while the writer is held", async t => {
  const root = mkdtempSync(join(tmpdir(), "dx-device-barrier-host-")); chmodSync(root, 0o700);
  const identity = generateSyntheticIdentity(join(root, "host-id"), "host"), peer = generateSyntheticIdentity(join(root, "peer-id"), "peer"), peer2 = generateSyntheticIdentity(join(root, "peer2-id"), "peer2");
  const dataDir = join(root, "host");
  const services = new HostServices({ dataDir, enableEngines: true, enableAgenda: true, devices: { identity, pollWaitMs: 50, receiptTimeoutMs: 3000 },
    makeDriver: (engine: EngineId) => ({ id: engine, capabilities: { resume: true, interrupt: true, fork: false, steer: false },
      async status() { return { engine, installed: true, version: "synthetic", authentication: "authenticated" as const, billing: "subscription" as const }; },
      async open(threadId: string, nativeCursor?: string) { return { threadId, nativeCursor: nativeCursor ?? "synthetic-cursor" }; },
      async *turn() { /* never started here */ }, async respondToTool() {}, async interrupt() {}, async close() {} }) });
  let release = () => {}; const held = new Promise<void>(done => { release = done; });
  const original = AgendaHostConsumer.prototype.close;
  t.after(async () => { AgendaHostConsumer.prototype.close = original; release(); await services.shutdown({ graceMs: 3000 }).catch(() => {}); rmSync(root, { recursive: true, force: true }); });
  const url = await services.startDevices(), trust: HostTrust = { hostUrl: url, hostFingerprint: identity.fingerprint, hostCertPem: identity.certPem };
  const offer = services.devicesAdmin.pairingBundle({ kind: "pair" });
  const pending = pairDevice({ dataDir: join(root, "peer"), identity: peer, trust, offerId: offer.offerId, code: offer.code, name: "Mac", capabilities: [FILE_APPEND], pollIntervalMs: 10 });
  await until(() => services.devicesAdmin.pendingClaims().length === 1);
  services.devicesAdmin.approveClaim(services.devicesAdmin.pendingClaims()[0]!.claimId);
  const id = (await pending).deviceId;
  const offer2 = services.devicesAdmin.pairingBundle({ kind: "pair" }); // issued BEFORE shutdown
  assert.equal((await raw(trust, peer, "/v1/device/poll", pollBody(id, services.store.hostId)).response).status, 200, "paired poll is served before the barrier");
  AgendaHostConsumer.prototype.close = async function (this: AgendaHostConsumer) { await held; return original.call(this); };
  await assert.rejects(services.shutdown({ graceMs: 100 }), (e: unknown) => e instanceof ShutdownIncompleteError);
  assert.throws(() => new HostStore({ dataDir }), hostCode("host_locked"), "writer retained while Agenda.close is pending");
  const before = snapshot(dataDir); await sleep(15);
  assert.deepEqual(await raw(trust, peer, "/v1/device/poll", pollBody(id, services.store.hostId)).response, UNAVAILABLE, "NEW authenticated poll is refused (no heartbeat)");
  assert.deepEqual(await raw(trust, peer2, "/v1/pair/claim", { offerId: offer2.offerId, code: offer2.code, name: "Mac2", platform: "macos", capabilities: [FILE_APPEND] }).response, UNAVAILABLE, "pair/claim with a pre-shutdown offer is refused");
  assert.equal(snapshot(dataDir), before, "devices, last_seen, events, actions, grants, claims and offers are unchanged");
  assert.throws(() => new HostStore({ dataDir }), hostCode("host_locked"));
  release();
  await services.shutdown({ graceMs: 3000 });
  const after = new DatabaseSync(join(dataDir, "devices.sqlite"), { readOnly: true });
  try { assert.equal((after.prepare("SELECT COUNT(*) AS n FROM claims").get() as { n: number }).n, 1, "only the approved pre-shutdown claim exists"); } finally { after.close(); }
  new HostStore({ dataDir }).close();
});

test("BARRIER-2 a body that started before the barrier and finished after it is refused before any route touches the store", async t => {
  const l = await standalone(t);
  assert.equal((await l.poll().response).status, 200);
  const offer = l.services.admin.pairingBundle({ kind: "pair" }), peer2 = generateSyntheticIdentity(join(l.root, "peer2-id"), "peer2");
  const heldPoll = raw(l.trust, l.peer, "/v1/device/poll", pollBody(l.id, l.store.hostId), { hold: true });
  const heldClaim = raw(l.trust, peer2, "/v1/pair/claim", { offerId: offer.offerId, code: offer.code, name: "Mac2", platform: "macos", capabilities: [FILE_APPEND] }, { hold: true });
  await Promise.all([heldPoll.flushed, heldClaim.flushed]); await sleep(150);
  const before = snapshot(l.dataDir); await sleep(15);
  l.services.stopAdmission();
  heldPoll.finish(); heldClaim.finish();
  assert.deepEqual(await heldPoll.response, UNAVAILABLE);
  assert.deepEqual(await heldClaim.response, UNAVAILABLE);
  assert.equal(snapshot(l.dataDir), before, "no heartbeat and no claim after the barrier");
});

test("BARRIER-3 a long-poll waiting before the barrier wakes and is refused; a job queued before it settles unknown and is never delivered", async t => {
  const l = await standalone(t, { pollWaitMs: 5000, receiptTimeoutMs: 20000 });
  const first = l.poll();
  const seen = l.store.getDevice(l.id).lastSeenAt; await until(() => l.services.tools.authenticatedPresence(l.id) === "online");
  assert.ok(l.store.getDevice(l.id).lastSeenAt >= seen);
  const before = snapshot(l.dataDir), started = Date.now();
  l.services.stopAdmission();
  assert.deepEqual(await first.response, UNAVAILABLE, "the waiting poll is refused, not served with jobs");
  assert.ok(Date.now() - started < 2000, "the barrier wakes the long-poll");
  assert.equal(snapshot(l.dataDir), before);
  assert.throws(() => l.services.tools.authenticatedPresence(l.id), hostCode("conflict"), "the borrowed port refuses after the barrier");

  const m = await standalone(t, { pollWaitMs: 50, receiptTimeoutMs: 20000 });
  assert.equal((await m.poll().response).status, 200);
  const action = m.action(), second = m.action("two");
  const flight = m.services.tools.dispatchBound(action.id, { signal: new AbortController().signal, guard: () => true });
  await until(() => m.store.getAction(action.id).state === "running"); await sleep(30);
  m.services.stopAdmission();
  const settled = await Promise.race([flight, sleep(2000).then(() => null)]);
  assert.ok(settled, "the queued job settles at the barrier, without waiting for the receipt timeout");
  assert.equal(settled!.state, "unknown", "already admitted work finalizes truthfully as unknown");
  const after = m.poll();
  assert.deepEqual(await after.response, UNAVAILABLE, "no job is delivered after the barrier");
  await assert.rejects(m.services.tools.dispatchBound(second.id, { signal: new AbortController().signal, guard: () => true }));
  assert.equal(m.store.getAction(second.id).state, "ready", "a dispatch after the barrier is refused before the claim");
});

test("BARRIER-4 after the barrier every finite route, method and unknown path answers the fixed unavailable and nothing is written", async t => {
  const l = await standalone(t);
  assert.equal((await l.poll().response).status, 200);
  const action = l.action(), offer = l.services.admin.pairingBundle({ kind: "pair" }), stranger = generateSyntheticIdentity(join(l.root, "x-id"), "stranger");
  const receipt = { actionId: action.id, nonce: "0".repeat(32), requestHash: action.requestHash, status: "failed", result: null, code: "synthetic_refused" };
  const before = snapshot(l.dataDir); await sleep(15);
  l.services.stopAdmission();
  const cases: Array<[TlsIdentity, string, object | string, string?]> = [
    [l.peer, "/v1/device/poll", pollBody(l.id, l.store.hostId)],
    [l.peer, "/v1/device/poll", pollBody(l.id, l.store.hostId, [receipt])],
    [l.peer, "/v1/device/receipt", { deviceId: l.id, installationId: l.store.hostId, receipt }],
    [stranger, "/v1/pair/claim", { offerId: offer.offerId, code: offer.code, name: "X", platform: "macos", capabilities: [FILE_APPEND] }],
    [stranger, "/v1/pair/status", { claimId: "clm_missing" }],
    [l.peer, "/v1/admin/anything", {}],
    [l.peer, "/v1/device/poll", "", "GET"],
    [stranger, "/v1/device/poll", pollBody(l.id, l.store.hostId)],
  ];
  for (const [peer, path, body, method] of cases)
    assert.deepEqual(await raw(l.trust, peer, path, body, method ? { method } : {}).response, UNAVAILABLE, `${method ?? "POST"} ${path}`);
  assert.equal(snapshot(l.dataDir), before, "no heartbeat, receipt, late receipt or claim");
  assert.equal(l.store.getAction(action.id).state, "ready");
});

test("BARRIER-5 retained facades and a retained server cannot admit, pair, dispatch or listen again after the barrier", async t => {
  const l = await standalone(t);
  assert.equal((await l.poll().response).status, 200);
  const action = l.action(), admin = l.services.admin, tools = l.services.tools, http = l.services.http;
  l.services.stopAdmission(); l.services.stopAdmission();
  assert.throws(() => admin.pairingBundle({ kind: "pair" }), hostCode("conflict"));
  await assert.rejects(l.services.start(), hostCode("conflict"));
  await assert.rejects(http.dispatch(action.id), hostCode("conflict"));
  await assert.rejects(tools.dispatchBound(action.id, { signal: new AbortController().signal, guard: () => true }));
  assert.equal(l.store.getAction(action.id).state, "ready");

  const root = mkdtempSync(join(tmpdir(), "dx-device-barrier-raw-")); chmodSync(root, 0o700);
  const identity = generateSyntheticIdentity(join(root, "host-id"), "host"), peer = generateSyntheticIdentity(join(root, "peer-id"), "peer");
  const store = new HostStore({ dataDir: join(root, "host") }), registry = new DevicePairingRegistry(store);
  const server = new DeviceHostServer({ store, registry, identity, pollWaitMs: 50, receiptTimeoutMs: 3000 });
  t.after(async () => { await server.close(); registry.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const url = await server.start(), trust: HostTrust = { hostUrl: url, hostFingerprint: identity.fingerprint, hostCertPem: identity.certPem };
  const offer = server.pairingBundle({ kind: "pair" });
  const pending = pairDevice({ dataDir: join(root, "peer"), identity: peer, trust, offerId: offer.offerId, code: offer.code, name: "Mac", capabilities: [FILE_APPEND], pollIntervalMs: 10 });
  await until(() => registry.listPendingClaims().length === 1); registry.approveClaim(registry.listPendingClaims()[0]!.claimId);
  const id = (await pending).deviceId;
  assert.equal((await raw(trust, peer, "/v1/device/poll", pollBody(id, store.hostId)).response).status, 200);
  const bot = store.createBot({ name: "Device", profileId: "personal", engine: "claude" }), thread = store.createThread(bot.id);
  store.setGrant({ botId: bot.id, tool: FILE_APPEND, destination: id, policy: "allow" });
  const ready = store.requestAction({ botId: bot.id, threadId: thread.id, tool: FILE_APPEND, destination: id, arguments: { name: "notes.txt", line: "once" }, idempotencyKey: "raw" });
  assert.equal(server.authenticatedPresence(id), "online");
  barrier(server);
  assert.equal(server.authenticatedPresence(id), "stale");
  assert.throws(() => server.pairingBundle({ kind: "pair" }), deviceCode("unavailable"));
  await assert.rejects(server.dispatch(ready.id), deviceCode("unavailable"));
  assert.equal(store.getAction(ready.id).state, "ready", "refused before the claim: no effect");
  await assert.rejects(server.start(), deviceCode("unavailable"), "a retained listener cannot listen again");
  assert.deepEqual(await raw(trust, peer, "/v1/device/poll", pollBody(id, store.hostId)).response, UNAVAILABLE);
  const closing = server.close(); assert.equal(server.close(), closing, "close is cached");
  await closing;
  await assert.rejects(server.start(), deviceCode("unavailable"));
  assert.equal(server.status().listening, false);
});

test("BARRIER-6 a flow completed before the barrier stays completed, and close drains a body still arriving, closes sockets and is cached", async t => {
  const l = await standalone(t, { pollWaitMs: 50, receiptTimeoutMs: 5000 });
  assert.equal((await l.poll().response).status, 200);
  const action = l.action();
  const flight = l.services.tools.dispatchBound(action.id, { signal: new AbortController().signal, guard: () => true });
  await until(() => l.store.getAction(action.id).state === "running");
  let job: { actionId: string; nonce: string; requestHash: string } | undefined;
  for (let i = 0; i < 40 && !job; i++) {
    const out = await l.poll().response; assert.equal(out.status, 200);
    job = (JSON.parse(out.body) as { jobs: Array<{ actionId: string; nonce: string; requestHash: string }> }).jobs[0];
  }
  assert.ok(job);
  const receipt = { actionId: job.actionId, nonce: job.nonce, requestHash: job.requestHash, status: "completed", result: { appended: true }, code: null };
  assert.equal((await raw(l.trust, l.peer, "/v1/device/receipt", { deviceId: l.id, installationId: l.store.hostId, receipt }).response).status, 200);
  assert.equal((await flight).state, "succeeded");
  const held = raw(l.trust, l.peer, "/v1/device/poll", pollBody(l.id, l.store.hostId), { hold: true });
  await held.flushed; await sleep(100);
  const before = snapshot(l.dataDir);
  const closing = l.services.close(); assert.equal(l.services.close(), closing, "close is cached");
  held.finish();
  await closing;
  await held.response.then(r => assert.deepEqual(r, UNAVAILABLE), () => { /* socket destroyed by close: no response */ });
  assert.equal(l.store.getAction(action.id).state, "succeeded");
  assert.equal(l.services.status().listening, false);
  await assert.rejects(l.poll().response, "listener and sockets are closed");
  assert.equal(snapshot(l.dataDir), before);
  await assert.rejects(l.services.start(), hostCode("conflict"));
});

test("BARRIER-7 malformed JSON keeps invalid_input before the barrier and uses fixed unavailable when the body completes after it", async t => {
  const l = await standalone(t);
  assert.equal((await l.poll().response).status, 200);
  const before = snapshot(l.dataDir);
  const beforeResponse = await raw(l.trust, l.peer, "/v1/device/poll", "{invalid}").response;
  assert.equal(snapshot(l.dataDir), before, "malformed input before the barrier does not mutate canonical state");
  assert.deepEqual(beforeResponse,
    { status: 400, body: "{\"error\":\"invalid_input\"}" }, "ordinary validation errors keep their existing response");

  const held = raw(l.trust, l.peer, "/v1/device/poll", "{invalid}", { hold: true });
  await held.flushed; await sleep(100);
  const beforeBarrier = snapshot(l.dataDir);
  l.services.stopAdmission(); held.finish();
  const afterResponse = await held.response;
  assert.equal(snapshot(l.dataDir), beforeBarrier, "rejected late malformed input does not mutate canonical state");
  assert.deepEqual(afterResponse, UNAVAILABLE, "admission closure takes precedence over a late parse error");
});
