// Trusted client ports and legacy TLS lifecycle. All subprocess/TLS peers are owned synthetic fixtures.
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import tls from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DeviceClient, MacDeviceDaemon, pairDevice, readBinding, type DeviceClientPort, type HostTrust, type PairOptions, type DaemonOptions } from "../packages/devices/src/daemon.js";
import { DeviceError } from "../packages/devices/src/errors.js";
import { DaemonJournal } from "../packages/devices/src/journal.js";
import { generateSyntheticIdentity } from "../packages/devices/src/lab.js";
import { NativeDeviceClient } from "../packages/devices/src/native-client.js";
const code = (value: string) => (e: unknown) => e instanceof DeviceError && e.code === value;
function deferred() { let resolve!: () => void, reject!: (e: Error) => void; const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
async function until(check: () => boolean, timeout = 8000): Promise<void> { const end = Date.now() + timeout; while (!check()) { if (Date.now() >= end) throw Error("owned fixture deadline"); await new Promise(r => setTimeout(r, 5)); } }
function lab(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dexter-client-port-"))); chmodSync(root, 0o700);
  const host = generateSyntheticIdentity(join(root, "host"), "host"), peer = generateSyntheticIdentity(join(root, "peer"), "peer");
  const dataDir = join(root, "daemon"), trust: HostTrust = { hostUrl: "https://127.0.0.1:1", hostCertPem: host.certPem, hostFingerprint: host.fingerprint };
  const binding = { installationId: "host_fixture", ownerId: "owner_fixture", deviceId: "dev_fixture", hostFingerprint: host.fingerprint };
  const paired = () => { mkdirSync(dataDir, { mode: 0o700 }); writeFileSync(join(dataDir, "binding.json"), JSON.stringify(binding), { mode: 0o600 }); };
  const cleanups: Array<() => void | Promise<void>> = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); rmSync(root, { recursive: true, force: true }); });
  const cleanup = (fn: () => void | Promise<void>) => cleanups.push(fn);
  return { root, host, peer, dataDir, trust, binding, paired, cleanup };
}
function captureTLS(f: ReturnType<typeof lab>) {
  const original = tls.connect, sockets: Array<{ socket: tls.TLSSocket; closed: boolean }> = [];
  (tls as { connect: typeof tls.connect }).connect = function (this: unknown, ...args: Parameters<typeof tls.connect>) {
    const socket = (original as (...values: unknown[]) => tls.TLSSocket).apply(this, args), record = { socket, closed: false };
    sockets.push(record); socket.once("close", () => { record.closed = true; }); return socket;
  } as typeof tls.connect;
  f.cleanup(() => { (tls as { connect: typeof tls.connect }).connect = original; });
  return sockets;
}
async function serve(f: ReturnType<typeof lab>, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer({ cert: f.host.certPem, key: f.host.keyPem, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }, handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address !== "string");
  f.cleanup(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { server, trust: { ...f.trust, hostUrl: `https://127.0.0.1:${address.port}` } };
}
function stub(closeGate: Promise<void> = Promise.resolve()) {
  let closed = false, closes = 0, posts = 0, closePromise: Promise<void> | null = null;
  const port: DeviceClientPort = {
    async post(route) { if (closed) throw new DeviceError("unavailable"); posts++; if (route === "pair/claim") return { claimId: "claim_fixture", status: "pending" }; if (route === "pair/status") return { status: "approved", deviceId: "dev_fixture", installationId: "host_fixture", ownerId: "owner_fixture" }; return { jobs: [] }; },
    close() { closes++; if (closePromise) return closePromise; closed = true; closePromise = closeGate; return closePromise; },
  };
  return { port, counts: () => ({ closed, closes, posts }) };
}
function held(dataDir: string, binding: ReturnType<typeof lab>["binding"]): void { assert.throws(() => { const unexpected = new DaemonJournal(dataDir, binding); unexpected.close(); }, code("conflict")); }
function released(dataDir: string, binding: ReturnType<typeof lab>["binding"]): void { const journal = new DaemonJournal(dataDir, binding); journal.close(); }

test("ambiguous or missing trusted selection refuses before directory, claim or journal creation", async t => {
  const f = lab(t), fake = stub();
  const pair = { dataDir: f.dataDir, trust: f.trust, offerId: "offer_fixture", code: "synthetic", name: "Lab", capabilities: ["mac.file.append"] };
  const daemon = { dataDir: f.dataDir, trust: f.trust, handlers: new Map() };
  for (const choice of [{}, { identity: f.peer, client: fake.port }, { client: null }, { identity: null }, { client: { post() { return Promise.resolve({}); } } }]) {
    await assert.rejects(pairDevice({ ...pair, ...choice } as unknown as PairOptions), code("invalid_input"));
    assert.throws(() => new MacDeviceDaemon({ ...daemon, ...choice } as unknown as DaemonOptions), code("invalid_input"));
    assert.equal(existsSync(f.dataDir), false);
  }
  assert.deepEqual(fake.counts(), { closed: false, closes: 0, posts: 0 });
});

test("pairing borrows injected client, preserves stable binding and refuses new host without claiming", async t => {
  const f = lab(t), fake = stub();
  const options = { dataDir: f.dataDir, client: fake.port, trust: f.trust, offerId: "offer_fixture", code: "synthetic", name: "Lab", capabilities: ["mac.file.append"] };
  assert.deepEqual(await pairDevice(options), f.binding); assert.equal(fake.counts().closes, 0);
  assert.deepEqual(await pairDevice(options), f.binding); assert.deepEqual(readBinding(f.dataDir), f.binding);
  const posts = fake.counts().posts;
  await assert.rejects(pairDevice({ ...options, trust: { ...f.trust, hostFingerprint: "a".repeat(64) } }), code("tls_pin_mismatch"));
  assert.equal(fake.counts().posts, posts); assert.equal(fake.counts().closes, 0);
  const failed: DeviceClientPort = { post: async () => { throw new DeviceError("unavailable"); }, close: () => { throw Error("borrowed client must not close"); } };
  await assert.rejects(pairDevice({ ...options, client: failed }), code("unavailable"));
  await fake.port.close(); assert.equal(fake.counts().closes, 1);
});

test("daemon constructor failure leaves injected client with startup caller", async t => {
  const f = lab(t), fake = stub(); f.paired();
  assert.throws(() => new MacDeviceDaemon({ dataDir: f.dataDir, client: fake.port, trust: f.trust, handlers: new Map([["undeclared.tool", async () => null]]) }), code("unsupported"));
  assert.equal(fake.counts().closes, 0); assert.equal(existsSync(join(f.dataDir, "journal.sqlite")), false);
  await fake.port.close(); assert.equal(fake.counts().closes, 1);
});

test("stop blocks retained port admission synchronously, holds lease on pending close, retry joins it", async t => {
  const f = lab(t), gate = deferred(), fake = stub(gate.promise); f.paired();
  const daemon = new MacDeviceDaemon({ dataDir: f.dataDir, client: fake.port, trust: f.trust, handlers: new Map(), stopTimeoutMs: 30 });
  f.cleanup(() => { gate.resolve(); daemon.journal.close(); });
  const first = daemon.stop(); assert.equal(fake.counts().closes, 1);
  await assert.rejects(fake.port.post("device/poll", {}, 1000), code("unavailable")); await assert.rejects(daemon.runOnce(), code("unavailable"));
  await assert.rejects(first, code("timeout")); held(f.dataDir, f.binding);
  const second = daemon.stop(), third = daemon.stop(); gate.resolve(); await Promise.all([second, third]);
  assert.equal(fake.counts().closes, 1); released(f.dataDir, f.binding);
});

test("late rejecting client close permanently quarantines writer and never calls close twice", async t => {
  const f = lab(t), gate = deferred(), fake = stub(gate.promise); f.paired();
  const daemon = new MacDeviceDaemon({ dataDir: f.dataDir, client: fake.port, trust: f.trust, handlers: new Map(), stopTimeoutMs: 30 });
  f.cleanup(() => daemon.journal.close());
  await assert.rejects(daemon.stop(), code("timeout")); held(f.dataDir, f.binding);
  gate.reject(Error("synthetic unconfirmed transport")); await assert.rejects(daemon.stop(), code("unavailable")); held(f.dataDir, f.binding);
  await assert.rejects(daemon.stop(), code("unavailable")); await assert.rejects(daemon.runOnce(), code("unavailable"));
  assert.equal(fake.counts().closes, 1);
});

test("client close starts before pending effects but resources and journal wait for effect completion", async t => {
  const f = lab(t), effect = deferred(), fake = stub(); f.paired(); let resourceCalls = 0;
  const daemon = new MacDeviceDaemon({ dataDir: f.dataDir, client: fake.port, trust: f.trust, handlers: new Map(), stopTimeoutMs: 30, resources: [{ close: async () => { resourceCalls++; } }] });
  // A direct run's port poll is an owned barrier; no real job/effect is synthesized here.
  let entered = false; fake.port.post = async () => { if (fake.counts().closed) throw new DeviceError("unavailable"); entered = true; await effect.promise; return { jobs: [] }; };
  f.cleanup(() => { effect.resolve(); daemon.journal.close(); });
  const running = daemon.runOnce(); await until(() => entered);
  const stopping = daemon.stop(); assert.equal(fake.counts().closes, 1); assert.equal(resourceCalls, 0);
  await assert.rejects(stopping, code("timeout")); held(f.dataDir, f.binding); effect.resolve(); await running;
  await daemon.stop(); assert.equal(resourceCalls, 1); released(f.dataDir, f.binding);
});

test("legacy TLS close is cached, drains an actual request/socket and blocks future admissions", async t => {
  const f = lab(t); let received = 0, peerClosed = false, protocol: string | null = null, fingerprint: string | undefined, heldResponse: ServerResponse | null = null;
  const server = createServer({ cert: f.host.certPem, key: f.host.keyPem, requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }, (req, res) => { received++; req.resume(); heldResponse = res; res.writeHead(200, { "content-type": "application/json" }); res.write('{"jobs":'); });
  server.on("secureConnection", socket => { protocol = socket.getProtocol(); fingerprint = socket.getPeerCertificate().fingerprint256; socket.once("close", () => { peerClosed = true; }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address !== "string");
  const sockets = captureTLS(f), c = new DeviceClient(f.peer, { ...f.trust, hostUrl: `https://127.0.0.1:${address.port}` });
  f.cleanup(async () => { await c.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const request = c.post("device/poll", {}, 20000); const outcome = request.catch(e => e); await until(() => received === 1);
  const closing = c.close(); assert.equal(c.close(), closing); await assert.rejects(c.post("device/poll", {}, 5000), code("unavailable"));
  // Explicit valid completion is the counterfactual: without cancel the original post resolves jobs[].
  assert.ok(heldResponse); (heldResponse as ServerResponse).end('[]}');
  const result = await outcome; assert.ok(result instanceof DeviceError && result.code === "unavailable", "close must cancel, not wait for a successful held response or request deadline");
  await closing; assert.deepEqual(sockets.map(item => item.closed), [true]); await until(() => peerClosed); assert.equal(sockets.length, 1);
  assert.equal(received, 1); assert.equal(protocol, "TLSv1.3"); assert.equal(fingerprint?.replaceAll(":", "").toLowerCase(), f.peer.fingerprint);
});

test("legacy pre-abort makes no TLS request and owned pairing closes on synthetic TLS success/failure", async t => {
  const f = lab(t); let requests = 0, open = 0, refuse = false, ownedCloses = 0;
  const originalClose = DeviceClient.prototype.close;
  DeviceClient.prototype.close = function () { ownedCloses++; return originalClose.call(this); };
  f.cleanup(() => { DeviceClient.prototype.close = originalClose; });
  const server = createServer({ cert: f.host.certPem, key: f.host.keyPem, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }, (req, res) => {
    requests++; req.resume();
    if (refuse) { const body = Buffer.from(JSON.stringify({ error: "forbidden" })); res.writeHead(403, { "content-type": "application/json", "content-length": body.length }); res.end(body); return; }
    const result = req.url === "/v1/pair/claim" ? { claimId: "claim_fixture", status: "pending" } : { status: "approved", deviceId: "dev_fixture", installationId: "host_fixture", ownerId: "owner_fixture" };
    const body = Buffer.from(JSON.stringify(result)); res.writeHead(200, { "content-type": "application/json", "content-length": body.length }); res.end(body);
  });
  server.on("secureConnection", socket => { open++; socket.once("close", () => open--); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address !== "string");
  const trust = { ...f.trust, hostUrl: `https://127.0.0.1:${address.port}` }, c = new DeviceClient(f.peer, trust), controller = new AbortController(); controller.abort();
  f.cleanup(async () => { await c.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await assert.rejects(c.post("device/poll", {}, 5000, controller.signal), code("unavailable")); assert.equal(requests, 0);
  const reentrant = new DeviceClient(f.peer, trust);
  await assert.rejects(reentrant.post("device/poll", { toJSON() { void reentrant.close(); return {}; } }, 5000), code("unavailable"));
  await reentrant.close(); assert.equal(requests, 0);
  ownedCloses = 0;
  assert.deepEqual(await pairDevice({ dataDir: f.dataDir, identity: f.peer, trust, offerId: "offer_fixture", code: "synthetic", name: "Lab", capabilities: ["mac.file.append"] }), f.binding);
  assert.equal(ownedCloses, 1);
  refuse = true;
  await assert.rejects(pairDevice({ dataDir: join(f.root, "failed-pair"), identity: f.peer, trust, offerId: "offer_fixture", code: "synthetic", name: "Lab", capabilities: ["mac.file.append"] }), code("forbidden"));
  assert.equal(ownedCloses, 2);
  await until(() => open === 0); assert.equal(requests, 3);
});

test("native synthetic helper is a borrowed pairing port and daemon stop drains its actual exit", async t => {
  const f = lab(t), executable = join(f.root, "helper.mjs"), configPath = join(f.root, "native.json"), calls = join(f.root, "calls.log");
  writeFileSync(configPath, JSON.stringify({ installationID: "host_fixture", hostURL: f.trust.hostUrl, hostCertificateDER: new X509Certificate(f.host.certPem).raw.toString("base64"), hostFingerprint: f.host.fingerprint }), { mode: 0o600 });
  writeFileSync(executable, `#!${process.execPath}\nimport fs from 'node:fs';let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{const c=JSON.parse(input);if(c.operation==='load'){const conf=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));console.log(JSON.stringify({ok:true,certificateDER:conf.hostCertificateDER,fingerprint:conf.hostFingerprint,policy:'secure_enclave_data_protection_keychain_device_only'}));return;}fs.appendFileSync(${JSON.stringify(calls)},c.route+' '+process.pid+'\\n');if(c.route==='/v1/device/poll'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);return;}const v=c.route==='/v1/pair/claim'?{claimId:'claim_fixture',status:'pending'}:{status:'approved',deviceId:'dev_fixture',installationId:'host_fixture',ownerId:'owner_fixture'};console.log(JSON.stringify({ok:true,responseBase64:Buffer.from(JSON.stringify(v)).toString('base64')}));});\n`, { mode: 0o700 });
  const native = new NativeDeviceClient({ executable, configPath, installationID: "host_fixture" });
  f.cleanup(async () => { await native.close(); });
  await native.loadOnly(20000);
  assert.deepEqual(await pairDevice({ dataDir: f.dataDir, client: native, trust: f.trust, offerId: "offer_fixture", code: "synthetic", name: "Lab", capabilities: ["mac.file.append"], requestTimeoutMs: 5000 }), f.binding);
  const daemon = new MacDeviceDaemon({ dataDir: f.dataDir, client: native, trust: f.trust, handlers: new Map(), stopTimeoutMs: 30 });
  f.cleanup(async () => { await native.close(); daemon.journal.close(); });
  const running = daemon.runOnce(); const outcome = running.catch(e => e); await until(() => native.pending === 1 && readFileSync(calls, "utf8").includes("/v1/device/poll"));
  const stopping = daemon.stop(); await assert.rejects(native.post("device/poll", { deviceId: "dev_fixture", installationId: "host_fixture", receipts: [] }, 5000), code("unavailable"));
  await assert.rejects(stopping, code("timeout")); held(f.dataDir, f.binding); assert.equal(native.pending, 1);
  assert.ok(await outcome instanceof DeviceError); await daemon.stop(); assert.equal(native.pending, 0); released(f.dataDir, f.binding);
  const lines = readFileSync(calls, "utf8").trim().split("\n"); assert.equal(lines.length, 3); assert.throws(() => process.kill(Number(lines[2]!.split(" ")[1]), 0));
});

test("same-tick legacy post/close confirms the allocated TLS close before resolving", async t => {
  const f = lab(t); let requests = 0;
  const peer = await serve(f, (req, res) => { requests++; req.resume(); res.writeHead(200, { "content-type": "application/json" }); res.end('{"jobs":[]}'); });
  const sockets = captureTLS(f), client = new DeviceClient(f.peer, peer.trust);
  f.cleanup(async () => { await client.close(); await until(() => sockets.every(item => item.closed), 20000); });
  const outcome = client.post("device/poll", {}, 20000).catch(e => e), closing = client.close();
  assert.equal(client.close(), closing); await closing;
  const atResolve = sockets.map(item => item.closed); assert.equal(sockets.length, 1, "one actual TLS stream was allocated");
  const result = await outcome; assert.ok(result instanceof DeviceError && result.code === "unavailable");
  await until(() => sockets.every(item => item.closed), 20000); assert.equal(requests, 0);
  assert.deepEqual(atResolve, [true], "close resolved before its allocated TLS socket emitted close");
});
test("same-tick legacy daemon start/stop confirms TLS close before journal lease release", async t => {
  const f = lab(t); f.paired(); let requests = 0;
  const peer = await serve(f, (req, res) => { requests++; req.resume(); res.writeHead(200, { "content-type": "application/json" }); res.end('{"jobs":[]}'); });
  const sockets = captureTLS(f), daemon = new MacDeviceDaemon({ dataDir: f.dataDir, identity: f.peer, trust: peer.trust, handlers: new Map(), stopTimeoutMs: 20000 });
  f.cleanup(async () => { await daemon.stop(); await until(() => sockets.every(item => item.closed), 20000); });
  daemon.start(); await daemon.stop();
  const atRelease = sockets.map(item => item.closed); assert.equal(sockets.length, 1);
  released(f.dataDir, f.binding); await until(() => sockets.every(item => item.closed), 20000); assert.equal(requests, 0);
  assert.deepEqual(atRelease, [true], "lease released before its allocated TLS socket emitted close");
  await assert.rejects(daemon.runOnce(), code("unavailable"));
});
