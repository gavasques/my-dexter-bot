import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, type SecureVersion, type TLSSocket } from "node:tls";
import { createServer as netServer, connect as netConnect, type Server as NetServer, type Socket as NetSocket, type AddressInfo } from "node:net";
import { createServer as httpsServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { RelayEndpoint, RelayStore, type DevicePin, type Envelope, type QueueReceipt, type RelayOptions } from "@dexter/relay";
import { createRelayMemoryCa, createRelayMemoryLeaf } from "./fixtures/relay-memory-tls.js";
import { encodeRelayMemoryRecord, encodeRelayMemoryRecordBytes, readRelayMemoryRecord } from "./fixtures/relay-memory-ipc.js";
import { PinnedRelayTransport, RelayService, RelayServiceError, RelayTransportError, type RelayServiceErrorCode,
  type TransportErrorCode, type TransportOutcome } from "../packages/relay-service/src/index.js";

// ---------- synthetic lab PKI (factory-issued Node memory material; private keys never enter the filesystem) ----------
interface Leaf { key: Buffer; cert: Buffer; pin: string }
const { CA, ROGUE_CA, GOOD, OTHER, WRONG_SAN, CLIENT_ONLY, EXPIRED, ROGUE } = (() => {
  const now = Date.now();
  const caAuthority = createRelayMemoryCa("relay-lab-ca", new Date(now - 7 * 86_400_000), new Date(now + 7 * 86_400_000));
  const rogueAuthority = createRelayMemoryCa("relay-rogue-ca", new Date(now - 7 * 86_400_000), new Date(now + 7 * 86_400_000));
  return {
    CA: Buffer.from(caAuthority.identity.certPem), ROGUE_CA: Buffer.from(rogueAuthority.identity.certPem),
    GOOD: createRelayMemoryLeaf("host", "good", caAuthority, ["DNS:relay.test"]),
    OTHER: createRelayMemoryLeaf("host", "other", caAuthority, ["DNS:relay.test"]),
    WRONG_SAN: createRelayMemoryLeaf("host", "wrong-san", caAuthority, ["DNS:other.test"]),
    CLIENT_ONLY: createRelayMemoryLeaf("client", "client-only", caAuthority, ["DNS:relay.test"]),
    EXPIRED: createRelayMemoryLeaf("host", "expired", caAuthority, ["DNS:relay.test"], { notBefore: new Date(now - 2 * 86_400_000), notAfter: new Date(now - 86_400_000) }),
    ROGUE: createRelayMemoryLeaf("host", "rogue", rogueAuthority, ["DNS:relay.test"]),
  };
})();
test.after(() => {
  for (const identity of [GOOD, OTHER, WRONG_SAN, CLIENT_ONLY, EXPIRED, ROGUE]) identity.key.fill(0);
  CA.fill(0); ROGUE_CA.fill(0);
});

// ---------- synthetic E2E endpoints (lab helper; private keys only in this test process) ----------
const OWNER = "lab-owner", INSTALL = "lab-install", PAYLOAD = "SYNTHETIC_RELAY_SERVICE_PAYLOAD";
const endpoint = (deviceId: string) => new RelayEndpoint({ ownerId: OWNER, installationId: INSTALL, deviceId, generation: 1, keyId: `${deviceId}-k1` });
function seal(from: RelayEndpoint, to: RelayEndpoint, sequence: number, payload: string | Buffer = PAYLOAD): Envelope {
  const now = Date.now();
  return from.seal(to.publicPin, { messageId: randomUUID(), sequence, type: "command", createdAt: now, expiresAt: now + 60_000 }, Buffer.from(payload));
}
const pollOf = (e: RelayEndpoint, after = 0, limit = 10) => e.poll({ requestId: randomUUID(), issuedAt: Date.now(), after, limit });
const ackOf = (e: RelayEndpoint, messages: { messageId: string; receiptId: string }[]) => e.ack({ requestId: randomUUID(), issuedAt: Date.now(), messages });
const fails = (code: TransportErrorCode, outcome: TransportOutcome, label = "") => (e: unknown): boolean => {
  assert.ok(e instanceof RelayTransportError, String(e));
  assert.deepEqual([e.code, e.outcome], [code, outcome], label || undefined);
  return true;
};
const serviceFails = (code: RelayServiceErrorCode) => (e: unknown): boolean => e instanceof RelayServiceError && e.code === code;
const client = (port: number, over: Partial<{ servername: string; ca: Buffer; leafSha256: string; timeoutMs: number }> = {}) =>
  new PinnedRelayTransport({ host: "127.0.0.1", port, servername: "relay.test", ca: CA, leafSha256: GOOD.pin, timeoutMs: 5_000, ...over });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("condition not reached"); await sleep(10); }
}
function privateDir(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); chmodSync(d, 0o700); return d; }
function privateFile(path: string, data: string | Buffer, mode = 0o600): string { writeFileSync(path, data, { mode }); chmodSync(path, mode); return path; }

// ---------- separate-process service fixture ----------
const CHILD = fileURLToPath(new URL("./fixtures/relay-service-child.js", import.meta.url));
interface Child { port: number; dir: string; proc: ChildProcess; output: () => string; cmd(op: object): Promise<Record<string, any>>; close(): Promise<void> }
async function sendMemoryRecord(proc: ChildProcess, record: Buffer): Promise<void> {
  const channel = proc.stdio[3] as Writable | null;
  try {
    if (!channel) throw new Error("memory_ipc_unavailable");
    await new Promise<void>((resolve, reject) => {
      channel.once("error", reject);
      channel.end(record, resolve);
    });
  } finally { record.fill(0); }
}
const CLI_MEMORY_LOADER = fileURLToPath(new URL("./fixtures/relay-service-cli-memory-loader.js", import.meta.url));
async function memoryCli(entry: string, args: string[], config: object, tls: Leaf = GOOD): Promise<ChildProcess> {
  const proc = spawn(process.execPath, ["--no-warnings", "--experimental-loader", CLI_MEMORY_LOADER, entry, ...args], { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"], env: {} });
  await sendMemoryRecord(proc, encodeRelayMemoryRecord(config, tls.key, tls.cert));
  return proc;
}
async function memoryCliRawConfig(entry: string, args: string[], configBytes: Buffer, tls: Leaf = GOOD): Promise<ChildProcess> {
  const proc = spawn(process.execPath, ["--no-warnings", "--experimental-loader", CLI_MEMORY_LOADER, entry, ...args], { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"], env: {} });
  await sendMemoryRecord(proc, encodeRelayMemoryRecordBytes(configBytes, tls.key, tls.cert));
  return proc;
}
interface CollectedChild { code: number | null; stdout: string; stderr: string; wipe: string; timedOut: boolean }
function collectBoundedChild(proc: ChildProcess, timeoutMs = 8_000): Promise<CollectedChild> {
  let stdout = "", stderr = "", wipe = "", timedOut = false;
  proc.stdout!.on("data", d => { stdout += String(d); });
  proc.stderr!.on("data", d => { stderr += String(d); });
  const wipeStream = proc.stdio[4];
  if (wipeStream) wipeStream.on("data", d => { wipe += String(d); });
  return new Promise(resolve => {
    const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, timeoutMs);
    proc.once("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr, wipe, timedOut }); });
  });
}

test("test-only memory IPC admits anonymous pipes and refuses regular descriptors before reading", async () => {
  const dir = privateDir("dexter-relay-memory-fd-");
  const sentinelPath = privateFile(join(dir, "public-inert-sentinel.bin"), "public inert descriptor sentinel");
  const fd = openSync(sentinelPath, "r");
  try {
    assert.throws(() => readRelayMemoryRecord(fd), (error: unknown) => error instanceof Error && error.message === "relay_memory_descriptor_untrusted");
    const firstByte = Buffer.alloc(1);
    assert.equal(readSync(fd, firstByte, 0, 1, null), 1);
    assert.equal(firstByte.toString("ascii"), "p", "fstat rejected the regular file before the reader consumed its sentinel");
    firstByte.fill(0);

    const cli = fileURLToPath(new URL("./fixtures/relay-service-cli.js", import.meta.url));
    const cliFd = openSync(sentinelPath, "r");
    try {
      const cliProc = spawn(process.execPath, ["--no-warnings", "--experimental-loader", CLI_MEMORY_LOADER, cli, "--config", "relay-memory://config"],
        { stdio: ["ignore", "pipe", "pipe", cliFd, "pipe"], env: {} });
      const cliResult = await collectBoundedChild(cliProc);
      assert.deepEqual(cliResult, { code: 1, stdout: "", stderr: `${JSON.stringify({ error: "config_untrusted" })}\n`, wipe: "WIPE_MISSING", timedOut: false },
        "the real CLI child refuses a regular file inherited as FD3 before accepting any memory record");
      const untouched = Buffer.alloc(1);
      assert.equal(readSync(cliFd, untouched, 0, 1, null), 1);
      assert.equal(untouched.toString("ascii"), "p", "the real CLI loader also leaves regular FD3 bytes unread");
      untouched.fill(0);
    } finally { closeSync(cliFd); }

    const helperURL = new URL("./fixtures/relay-memory-ipc.js", import.meta.url).href;
    const probeSource = `import { readRelayMemoryRecord } from ${JSON.stringify(helperURL)}; const r=readRelayMemoryRecord(3); if(r.config.toString()!=="{\\"version\\":1}") process.exitCode=2; r.config.fill(0); r.key.fill(0); r.cert.fill(0); console.log("PIPE_OK");`;
    const proc = spawn(process.execPath, ["--input-type=module", "-e", probeSource], { stdio: ["ignore", "pipe", "pipe", "pipe"], env: {} });
    const completed = collectBoundedChild(proc);
    const configBytes = Buffer.from('{"version":1}'), inertKey = Buffer.from("inert-key-buffer-placeholder"), inertCert = Buffer.from("inert-certificate-placeholder");
    const record = encodeRelayMemoryRecordBytes(configBytes, inertKey, inertCert);
    configBytes.fill(0); inertKey.fill(0); inertCert.fill(0);
    await sendMemoryRecord(proc, record);
    const result = await completed;
    assert.deepEqual(result, { code: 0, stdout: "PIPE_OK\n", stderr: "", wipe: "", timedOut: false }, "the same bounded reader accepts an inherited anonymous pipe");
  } finally { closeSync(fd); rmSync(dir, { recursive: true, force: true }); }
});

async function child(pins: DevicePin[], tls: Leaf = GOOD): Promise<Child> {
  const dir = privateDir("dexter-relay-service-child-");
  const config = { dataDir: join(dir, "data"), ownerId: OWNER, installationId: INSTALL, pins };
  const proc = spawn(process.execPath, [CHILD], { stdio: ["pipe", "pipe", "pipe", "pipe"], env: {} });
  await sendMemoryRecord(proc, encodeRelayMemoryRecord(config, tls.key, tls.cert));
  let stdout = "", stderr = "";
  const lines: string[] = [], waiters: ((l: string) => void)[] = [];
  createInterface({ input: proc.stdout! }).on("line", l => { stdout += `${l}\n`; const w = waiters.shift(); if (w) w(l); else lines.push(l); });
  proc.stderr!.on("data", d => { stderr += String(d); });
  const next = () => new Promise<Record<string, any>>((resolve, reject) => {
    const take = (l: string) => resolve(JSON.parse(l));
    const l = lines.shift(); if (l !== undefined) return take(l);
    const timer = setTimeout(() => reject(new Error("child_silent")), 10_000);
    waiters.push(x => { clearTimeout(timer); take(x); });
  });
  const first = await next();
  const exited = new Promise<void>(r => proc.once("exit", () => r()));
  return { port: first.port as number, dir, proc, output: () => stdout + stderr,
    cmd: async op => { proc.stdin!.write(`${JSON.stringify(op)}\n`); return next(); },
    close: async () => { if (proc.exitCode === null) { proc.stdin!.write(`${JSON.stringify({ op: "close" })}\n`); await exited; } } };
}

// ---------- raw TLS HTTP client for framing and lifecycle cases ----------
function httpRequest(body: string | Buffer, opts: { path?: string; method?: string; version?: string; type?: string | null; length?: number | null; extra?: string[]; connection?: string | null } = {}): Buffer {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const head = [`${opts.method ?? "POST"} ${opts.path ?? "/v1/poll"} ${opts.version ?? "HTTP/1.1"}`, "Host: relay.test",
    ...(opts.type === null ? [] : [`Content-Type: ${opts.type ?? "application/json"}`]),
    ...(opts.length === null ? [] : [`Content-Length: ${opts.length ?? b.length}`]),
    ...(opts.connection === null ? [] : [`Connection: ${opts.connection ?? "close"}`]), ...(opts.extra ?? [])];
  return Buffer.concat([Buffer.from(`${head.join("\r\n")}\r\n\r\n`), b]);
}
function openTls(port: number, extra: { maxVersion?: SecureVersion; session?: Buffer } = {}): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tlsConnect({ host: "127.0.0.1", port, servername: "relay.test", ca: CA, ALPNProtocols: ["http/1.1"], ...extra });
    s.once("secureConnect", () => resolve(s)); s.once("error", reject);
  });
}
function collect(s: TLSSocket): Promise<string> {
  return new Promise(resolve => { let text = ""; s.on("data", d => { text += String(d); }); s.on("error", () => undefined); s.once("close", () => resolve(text)); });
}
async function raw(port: number, ...chunks: Buffer[]): Promise<{ status: number | null; text: string }> {
  const s = await openTls(port), done = collect(s);
  for (const c of chunks) s.write(c);
  const text = await done, m = /^HTTP\/1\.1 (\d{3}) /.exec(text);
  return { status: m ? Number(m[1]) : null, text };
}
const errorOf = (text: string): unknown => { const i = text.indexOf("\r\n\r\n"); return i < 0 ? null : JSON.parse(text.slice(i + 4)).error; };

// ---------- fake TLS peers for client validation ----------
async function fakeServer(leafCert: Leaf, handler: (req: IncomingMessage, res: ServerResponse) => void, maxVersion: SecureVersion = "TLSv1.3"): Promise<{ port: number; requests: () => number; close(): Promise<void>; server: HttpsServer }> {
  let requests = 0;
  const server = httpsServer({ key: leafCert.key, cert: leafCert.cert, ALPNProtocols: ["http/1.1"], minVersion: "TLSv1.2", maxVersion }, (req, res) => { requests++; handler(req, res); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as AddressInfo).port, requests: () => requests, server,
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}
/** TCP passthrough that forwards the TLS handshake and the request, then drops every later server byte (lost response). */
async function lossyProxy(target: number): Promise<{ port: number; upstreams: () => number; close(): Promise<void> }> {
  let upstreams = 0;
  const server: NetServer = netServer(down => {
    upstreams++;
    const up = netConnect(target, "127.0.0.1");
    let pending = Buffer.alloc(0), appRecords = 0, dropping = false;
    down.on("data", (d: Buffer) => {
      pending = Buffer.concat([pending, d]);
      while (pending.length >= 5 && pending.length >= 5 + pending.readUInt16BE(3)) { if (pending[0] === 0x17) appRecords++; pending = pending.subarray(5 + pending.readUInt16BE(3)); }
      if (appRecords >= 2) dropping = true; // client Finished + first request record
      up.write(d);
    });
    up.on("data", (d: Buffer) => { if (!dropping) down.write(d); });
    const end = () => { down.destroy(); up.destroy(); };
    for (const s of [up, down]) { s.on("close", end); s.on("error", end); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as AddressInfo).port, upstreams: () => upstreams, close: () => new Promise<void>(r => server.close(() => r())) };
}

function labStore(): { options: RelayOptions; dir: string; phone: RelayEndpoint; host: RelayEndpoint; seed(): void } {
  const dir = privateDir("dexter-relay-service-store-"), phone = endpoint("phone"), host = endpoint("host");
  const options: RelayOptions = { dataDir: join(dir, "data"), ownerId: OWNER, installationId: INSTALL };
  return { options, dir, phone, host, seed: () => { const s = new RelayStore(options); s.registerDevice(phone.publicPin); s.registerDevice(host.publicPin); s.close(); } };
}

// =====================================================================================

test("separate-process HTTPS TLS 1.3: signed enqueue/poll/ack, exact replays keep receipts, child store holds ciphertext only", async () => {
  const phone = endpoint("phone"), host = endpoint("host"), c = await child([phone.publicPin, host.publicPin]);
  const t = client(c.port);
  try {
    assert.notEqual(c.proc.pid, process.pid);
    const e1 = seal(phone, host, 1), r1 = await t.enqueue(e1);
    assert.deepEqual(await t.enqueue(e1), r1, "exact envelope replay returns the same durable receipt");
    const polled = await t.poll(pollOf(host));
    assert.equal(polled.deliveries.length, 1);
    assert.equal(polled.deliveries[0]!.receiptId, r1.receiptId);
    assert.equal(host.open(polled.deliveries[0]!.envelope, phone.publicPin).toString(), PAYLOAD, "only the E2E recipient opens it");
    const ack = ackOf(host, [{ messageId: e1.messageId, receiptId: r1.receiptId }]), a1 = await t.ack(ack);
    assert.deepEqual(await t.ack(ack), a1, "exact signed ACK replay inside the window returns the same receipt");
    assert.deepEqual((await t.poll(pollOf(host))).deliveries, []);
    const s = await c.cmd({ op: "status" });
    assert.equal(s.service.acceptedConnections, 6, "one fresh TLS connection per request");
    assert.equal(s.service.refusedResumptions, 0);
    assert.equal(s.store.pending, 0);
    assert.equal("online" in s.service || "presence" in s.service, false);
  } finally { await t.close(); await c.close(); }
  for (const f of readdirSync(join(c.dir, "data"))) assert.equal(readFileSync(join(c.dir, "data", f)).includes(Buffer.from(PAYLOAD)), false, f);
  assert.equal(/PRIVATE KEY|SYNTHETIC_RELAY|ciphertext/.test(c.output()), false, "no key/plaintext/ciphertext on child stdout/stderr");
  rmSync(c.dir, { recursive: true, force: true });
});

test("TLS identity: wrong leaf pin, SAN, CA, missing serverAuth and TLS 1.2 fail closed before any request", async () => {
  const phone = endpoint("phone"), host = endpoint("host"), c = await child([phone.publicPin, host.publicPin]), lab = labStore();
  const fakes: Awaited<ReturnType<typeof fakeServer>>[] = [];
  try {
    for (const over of [{ leafSha256: OTHER.pin }, { servername: "other.test" }, { ca: ROGUE_CA }]) {
      const t = client(c.port, over);
      await assert.rejects(t.enqueue(seal(phone, host, 1)), fails("tls_identity", "not_sent", Object.keys(over)[0]));
      await t.close();
    }
    const s = await c.cmd({ op: "status" });
    assert.deepEqual([s.store.messages, s.store.controls], [0, 0], "no request reached the store");
    for (const [cert, version, pin] of [[WRONG_SAN, "TLSv1.3", WRONG_SAN.pin], [CLIENT_ONLY, "TLSv1.3", CLIENT_ONLY.pin], [EXPIRED, "TLSv1.3", EXPIRED.pin], [ROGUE, "TLSv1.3", ROGUE.pin], [GOOD, "TLSv1.2", GOOD.pin]] as const) {
      const fake = await fakeServer(cert, (_q, r) => r.end("{}"), version); fakes.push(fake);
      const t = client(fake.port, { leafSha256: pin });
      await assert.rejects(t.poll(pollOf(host)), fails("tls_identity", "not_sent", `${pin === GOOD.pin ? "tls12" : pin}`));
      await t.close();
      assert.equal(fake.requests(), 0);
    }
    await assert.rejects(openTls(c.port, { maxVersion: "TLSv1.2" }), "service refuses TLS 1.2 clients");
    await assert.rejects(RelayService.start({ store: { own: lab.options }, tls: { key: CLIENT_ONLY.key, cert: CLIENT_ONLY.cert }, host: "127.0.0.1", port: 0 }), serviceFails("tls_config"));
    await assert.rejects(RelayService.start({ store: { own: lab.options }, tls: { key: OTHER.key, cert: GOOD.cert }, host: "127.0.0.1", port: 0 }), serviceFails("tls_config"));
    assert.equal(existsSync(lab.options.dataDir), false, "TLS config is refused before the owned store opens");
  } finally { for (const f of fakes) await f.close(); await c.close(); rmSync(c.dir, { recursive: true, force: true }); rmSync(lab.dir, { recursive: true, force: true }); }
});

test("authority is the signed envelope/control against current pins; no admin routes and no caller-header principal", async () => {
  const phone = endpoint("phone"), host = endpoint("host"), stranger = endpoint("stranger"), c = await child([phone.publicPin, host.publicPin]);
  const t = client(c.port);
  try {
    const e1 = seal(phone, host, 1);
    await assert.rejects(t.enqueue({ ...e1, ciphertext: Buffer.from("tampered").toString("base64") }), fails("forbidden", "rejected"));
    await assert.rejects(t.enqueue(seal(stranger, host, 1)), fails("forbidden", "rejected"));
    await assert.rejects(t.poll({ ...pollOf(host), deviceId: "phone" }), fails("forbidden", "rejected"));
    await t.enqueue(e1);
    assert.deepEqual(await c.cmd({ op: "revoke", deviceId: "phone" }), { ok: true });
    await assert.rejects(t.enqueue(seal(phone, host, 2)), fails("forbidden", "rejected"), "revoked current pin no longer authenticates");
    await assert.rejects(t.enqueue(e1), fails("forbidden", "rejected"), "even an exact replay is rechecked against current pins");
    assert.deepEqual((await t.poll(pollOf(host))).deliveries, [], "revoked sender traffic is not delivered");
    await assert.rejects(t.poll(pollOf(phone)), fails("forbidden", "rejected"));
    const body = JSON.stringify(pollOf(host));
    for (const path of ["/v1/devices", "/v1/register", "/v1/revoke", "/v1/rotate", "/v1/cleanup", "/v1/compact", "/admin", "/v1/poll?x=1", "/v1/poll/"])
      assert.equal((await raw(c.port, httpRequest(body, { path }))).status, 404, path);
    assert.equal((await raw(c.port, httpRequest(body, { method: "PUT" }))).status, 405);
    for (const header of ["Origin: https://relay.test", "Authorization: Bearer x", "X-Dexter-Device: host", "Cookie: a=b", "X-Forwarded-For: 10.0.0.1"]) {
      const r = await raw(c.port, httpRequest(JSON.stringify(pollOf(host)), { extra: [header] }));
      assert.deepEqual([r.status, errorOf(r.text)], [400, "bad_request"], header);
    }
    const s = await c.cmd({ op: "status" });
    assert.equal(s.store.controls, 1, "only the authenticated host poll consumed a nonce; header-rejected polls never reached the store");
  } finally { await t.close(); await c.close(); rmSync(c.dir, { recursive: true, force: true }); }
});

test("closed framing: size/header bounds, chunked, compression, duplicates, upgrade, expect, version and strict JSON", async () => {
  const phone = endpoint("phone"), host = endpoint("host"), c = await child([phone.publicPin, host.publicPin]);
  try {
    const ok = await raw(c.port, httpRequest(JSON.stringify(pollOf(host))));
    assert.equal(ok.status, 200);
    assert.match(ok.text, /\r\nconnection: close\r\n/i);
    assert.match(ok.text, /\r\ncontent-length: \d+\r\n/i);
    const valid = JSON.stringify(pollOf(host));
    const cases: [string, Buffer, number | null, string | null][] = [
      ["oversize body", httpRequest("{}", { length: 65_537 }), 413, "payload_too_large"],
      ["header block over 16 KiB", httpRequest(valid, { extra: [`X-Pad: ${"a".repeat(17_000)}`] }), 431, null],
      ["chunked", Buffer.from(`POST /v1/poll HTTP/1.1\r\nHost: relay.test\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\n{}\r\n0\r\n\r\n`), 400, "bad_request"],
      ["compression", httpRequest(valid, { extra: ["Content-Encoding: gzip"] }), 400, "bad_request"],
      ["duplicate content-type", httpRequest(valid, { extra: ["Content-Type: application/json"] }), 400, "bad_request"],
      ["missing content-length", httpRequest(valid, { length: null }), 400, "bad_request"],
      ["keep-alive", httpRequest(valid, { connection: "keep-alive" }), 400, "bad_request"],
      ["media type", httpRequest(valid, { type: "text/plain" }), 415, "unsupported_media_type"],
      ["charset parameter", httpRequest(valid, { type: "application/json; charset=utf-8" }), 415, "unsupported_media_type"],
      ["expect", httpRequest(valid, { extra: ["Expect: 100-continue"] }), 400, "bad_request"],
      ["HTTP/1.0", httpRequest(valid, { version: "HTTP/1.0" }), 505, "version_not_supported"],
      ["BOM", httpRequest(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(valid)])), 400, "bad_request"],
      ["invalid UTF-8", httpRequest(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])), 400, "bad_request"],
      ["duplicate key", httpRequest(valid.replace("{", "{\"kind\":\"poll\",")), 400, "bad_request"],
      ["trailing data", httpRequest(`${valid} x`), 400, "bad_request"],
      ["top-level array", httpRequest("[1]"), 400, "bad_request"],
      ["deep nesting", httpRequest(`{"a":${"[".repeat(20)}${"]".repeat(20)}}`), 400, "bad_request"],
    ];
    for (const [name, bytes, status, code] of cases) {
      const r = await raw(c.port, bytes);
      assert.equal(r.status, status, name);
      if (code) assert.equal(errorOf(r.text), code, name);
    }
    const upgrade = await raw(c.port, httpRequest(valid, { connection: "Upgrade", extra: ["Upgrade: websocket"] }));
    assert.equal(upgrade.status === 101, false, "no protocol upgrade");
    const beforePipeline = (await c.cmd({ op: "status" })).store.controls;
    const pipelined = await raw(c.port, Buffer.concat([httpRequest(JSON.stringify(pollOf(host)), { connection: null }), httpRequest(JSON.stringify(pollOf(host)), { connection: null })]));
    assert.equal(pipelined.text.match(/HTTP\/1\.1 200 /g)?.length, 1, "one request per connection");
    assert.match(pipelined.text, /\r\nconnection: close\r\n/i);
    const before = (await c.cmd({ op: "status" })).store.controls;
    assert.equal(before, beforePipeline + 1, "the pipelined second request never reached the store");
    const over = pollOf(host, 0, 11);
    const r = await raw(c.port, httpRequest(JSON.stringify(over)));
    assert.deepEqual([r.status, errorOf(r.text)], [400, "poll_limit"]);
    assert.equal((await c.cmd({ op: "status" })).store.controls, before, "transport poll cap refuses before the store consumes the nonce");
    const t = client(c.port);
    await assert.rejects(t.poll(pollOf(host, 0, 11)), fails("poll_limit", "not_sent"));
    for (let i = 1; i <= 10; i++) await t.enqueue(seal(phone, host, i, Buffer.alloc(32_768, i)));
    const full = await t.poll(pollOf(host, 0, 10));
    assert.equal(full.deliveries.length, 10, "ten maximum-size ciphertexts fit the 512 KiB poll response");
    await t.close();
  } finally { await c.close(); rmSync(c.dir, { recursive: true, force: true }); }
});

test("lost responses after handoff are ambiguous, never retried; explicit exact replay classifies enqueue/ACK; poll nonce is one-use", async () => {
  const phone = endpoint("phone"), host = endpoint("host"), c = await child([phone.publicPin, host.publicPin]);
  const proxy = await lossyProxy(c.port), lossy = client(proxy.port), direct = client(c.port);
  try {
    const e1 = seal(phone, host, 1);
    await assert.rejects(lossy.enqueue(e1), fails("connection_lost", "unknown"));
    assert.equal(proxy.upstreams(), 1, "no implicit retry");
    const r1 = await direct.enqueue(e1);
    const polled = await direct.poll(pollOf(host));
    assert.deepEqual(polled.deliveries.map(d => d.receiptId), [r1.receiptId], "the lost enqueue committed exactly once");
    await assert.rejects(direct.enqueue(seal(phone, host, 1)), fails("conflict", "rejected"), "sequence 1 is consumed");
    const e2 = seal(phone, host, 2), r2 = await direct.enqueue(e2);
    const ack = ackOf(host, [{ messageId: e1.messageId, receiptId: r1.receiptId }]);
    await assert.rejects(lossy.ack(ack), fails("connection_lost", "unknown"));
    assert.equal(proxy.upstreams(), 2);
    const a = await direct.ack(ack);
    assert.deepEqual(await direct.ack(ack), a, "manual exact ACK repeat is idempotent");
    assert.deepEqual((await direct.poll(pollOf(host))).deliveries.map(d => d.receiptId), [r2.receiptId]);
    const lostPoll = pollOf(host);
    await assert.rejects(lossy.poll(lostPoll), fails("connection_lost", "unknown"));
    await assert.rejects(direct.poll(lostPoll), fails("conflict", "rejected"), "a consumed poll nonce is never reusable");
    assert.equal((await direct.poll(pollOf(host))).deliveries.length, 1, "fresh nonce redelivers (at-least-once)");
  } finally { await lossy.close(); await direct.close(); await proxy.close(); await c.close(); rmSync(c.dir, { recursive: true, force: true }); }
});

test("pinned client: same-tick close destroys the eagerly captured TLS stream; in-flight close is unknown; response validation", async () => {
  const phone = endpoint("phone"), host = endpoint("host"), c = await child([phone.publicPin, host.publicPin]);
  const fakes: Awaited<ReturnType<typeof fakeServer>>[] = [];
  try {
    const t = client(c.port);
    const pending = t.enqueue(seal(phone, host, 1)), closing = t.close();
    assert.equal(t.close(), closing, "close returns the same cached promise");
    await assert.rejects(pending, fails("closed", "not_sent"));
    await closing;
    await assert.rejects(t.enqueue(seal(phone, host, 1)), fails("closed", "not_sent"), "close is permanent");
    let s = await c.cmd({ op: "status" });
    for (let i = 0; i < 100 && s.service.openConnections !== 0; i++) { await sleep(20); s = await c.cmd({ op: "status" }); }
    assert.equal(s.store.messages, 0);
    assert.equal(s.service.openConnections, 0, "server observed the client stream closing");

    let arrived = false, serverSide: import("node:net").Socket | null = null;
    const silent = await fakeServer(GOOD, (q) => { serverSide = q.socket; q.resume(); q.once("end", () => { arrived = true; }); }); fakes.push(silent);
    const t2 = client(silent.port);
    const inflight = t2.enqueue(seal(phone, host, 1));
    await until(() => arrived);
    await t2.close();
    await assert.rejects(inflight, fails("closed", "unknown"));
    await until(() => (serverSide as { destroyed: boolean } | null)?.destroyed === true);

    const respond = (status: number, body: string, headers: Record<string, string> = {}) => (q: IncomingMessage, r: ServerResponse) => {
      q.resume(); r.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers }); r.end(body);
    };
    const bad: [string, (q: IncomingMessage, r: ServerResponse) => void][] = [
      ["redirect", respond(302, "{}", { location: "https://relay.test/v1/elsewhere" })],
      ["gzip", respond(200, JSON.stringify({ receiptId: "abc", cursor: 1 }), { "content-encoding": "gzip" })],
      ["chunked", (q, r) => { q.resume(); r.writeHead(200, { "content-type": "application/json" }); r.write("{\"receiptId\":\"a\","); r.end("\"cursor\":1}"); }],
      ["oversize", respond(200, JSON.stringify({ receiptId: "a".repeat(4_200), cursor: 1 }))],
      ["extra field", respond(200, JSON.stringify({ receiptId: "abc", cursor: 1, x: 1 }))],
      ["duplicate key", respond(200, "{\"receiptId\":\"abc\",\"cursor\":1,\"cursor\":2}")],
      ["unknown error code", respond(418, JSON.stringify({ error: "teapot" }))],
      ["status/code mismatch", respond(200, JSON.stringify({ error: "forbidden" }))],
    ];
    for (const [name, handler] of bad) {
      const fake = await fakeServer(GOOD, handler); fakes.push(fake);
      const t3 = client(fake.port);
      await assert.rejects(t3.enqueue(seal(phone, host, 1)), fails("response_invalid", "unknown"), name);
      await t3.close();
      assert.equal(fake.requests(), 1, `${name}: exactly one request, no redirect/retry`);
    }
    const hostile = new Proxy(seal(phone, host, 1), {});
    const getter = Object.defineProperty({ ...seal(phone, host, 1) }, "ciphertext", { get: () => "x", enumerable: true });
    const toJson = { ...seal(phone, host, 1), toJSON: () => ({}) };
    const sparse = ackOf(host, [{ messageId: "m", receiptId: "r" }]); (sparse.messages as unknown[]).length = 3;
    const t4 = client(c.port);
    for (const value of [hostile, getter, toJson]) await assert.rejects(t4.enqueue(value as Envelope), fails("invalid_input", "not_sent"));
    await assert.rejects(t4.ack(sparse), fails("invalid_input", "not_sent"));
    await t4.close();
    assert.equal((await c.cmd({ op: "status" })).store.messages, 0);
  } finally { for (const f of fakes) await f.close(); await c.close(); rmSync(c.dir, { recursive: true, force: true }); }
});

test("service close: permanent admission stop; a body completed after close is refused; idle and in-flight sockets drain first (borrowed store)", async () => {
  const lab = labStore(); lab.seed();
  const store = new RelayStore(lab.options);
  const service = await RelayService.start({ store: { borrow: store }, tls: { key: GOOD.key, cert: GOOD.cert }, host: "127.0.0.1", port: 0, timeouts: { drainMs: 5_000 } });
  const port = service.address.port;
  try {
    const idle = await openTls(port), idleClosed = new Promise<void>(r => idle.once("close", () => r()));
    const bytes = httpRequest(JSON.stringify(seal(lab.phone, lab.host, 1)), { path: "/v1/envelopes" });
    const split = bytes.indexOf("\r\n\r\n") + 4 + 50;
    const slow = await openTls(port), slowText = collect(slow);
    let slowClosed = false; slow.once("close", () => { slowClosed = true; });
    slow.write(bytes.subarray(0, split));
    await until(() => service.status().activeRequests === 1);
    const closing = service.close();
    assert.equal(service.close(), closing);
    assert.equal(service.status().state, "closing");
    await idleClosed;
    await assert.rejects(openTls(port), "listener stopped accepting");
    slow.write(bytes.subarray(split));
    const text = await slowText;
    assert.deepEqual([/^HTTP\/1\.1 (\d+)/.exec(text)?.[1], errorOf(text)], ["503", "shutting_down"]);
    await closing;
    assert.equal(slowClosed, true, "close resolved only after the actual TLS socket close event");
    assert.equal(service.status().state, "closed");
    assert.doesNotThrow(() => store.status(), "borrowed store remains open and owned by the caller");
    assert.equal(store.status().messages, 0, "no admission after close: nothing was enqueued");
  } finally { store.close(); rmSync(lab.dir, { recursive: true, force: true }); }
});

test("ownership: XOR validated before state; owned/borrowed startup rollback; owned close drains before store.close; close failure quarantines", async () => {
  const lab = labStore(), tls = { key: GOOD.key, cert: GOOD.cert };
  try {
    for (const store of [{}, { own: lab.options, borrow: null }, { borrow: {} }, { own: null }] as never[])
      await assert.rejects(RelayService.start({ store, tls, host: "127.0.0.1", port: 0 }), serviceFails("invalid_config"));
    await assert.rejects(RelayService.start({ store: { own: lab.options }, tls, host: "0.0.0.0" as "127.0.0.1", port: 0 }), serviceFails("invalid_config"));
    await assert.rejects(RelayService.start({ store: { own: lab.options }, tls, host: "127.0.0.1", port: 0, extra: 1 } as never), serviceFails("invalid_config"));
    assert.equal(existsSync(lab.options.dataDir), false, "invalid config created no store state");

    const blocker = netServer(); await new Promise<void>(r => blocker.listen(0, "127.0.0.1", () => r()));
    const busy = (blocker.address() as AddressInfo).port;
    lab.seed();
    await assert.rejects(RelayService.start({ store: { own: lab.options }, tls, host: "127.0.0.1", port: busy }), serviceFails("listen_failed"));
    new RelayStore(lab.options).close(); // owned writer was rolled back
    const borrowed = new RelayStore(lab.options);
    await assert.rejects(RelayService.start({ store: { borrow: borrowed }, tls, host: "127.0.0.1", port: busy }), serviceFails("listen_failed"));
    assert.equal(borrowed.status().messages, 0, "borrowed store still open after failed startup");
    borrowed.close();
    await new Promise<void>(r => blocker.close(() => r()));

    const owned = await RelayService.start({ store: { own: lab.options }, tls, host: "127.0.0.1", port: 0 });
    assert.throws(() => new RelayStore(lab.options), "owned writer held while serving");
    const t = client(owned.address.port);
    const r1 = await t.enqueue(seal(lab.phone, lab.host, 1));
    assert.equal(owned.status().pending, 1);
    await t.close();
    const bytes = httpRequest(JSON.stringify(pollOf(lab.host)));
    const s = await openTls(owned.address.port), done = collect(s);
    let socketClosed = false; s.once("close", () => { socketClosed = true; });
    s.write(bytes.subarray(0, bytes.length - 10));
    await until(() => owned.status().activeRequests === 1);
    const closing = owned.close();
    s.write(bytes.subarray(bytes.length - 10));
    await closing;
    assert.equal(socketClosed, true, "owned store closed only after the actual socket close event");
    assert.equal(errorOf(await done), "shutting_down");
    const reopened = new RelayStore(lab.options);
    assert.deepEqual([reopened.status().pending, reopened.status().controls], [1, 0], "late poll never reached the store");
    reopened.close();
    assert.ok(r1.receiptId);

    let now = Date.now();
    const quarantined = await RelayService.start({ store: { own: { ...lab.options, clock: () => now } }, tls, host: "127.0.0.1", port: 0 });
    now += 3_600_000;
    const failing = quarantined.close();
    assert.equal(quarantined.close(), failing, "close failure keeps the same cached promise");
    await assert.rejects(failing, serviceFails("store_close_failed"));
    assert.equal(quarantined.status().state, "quarantined");
    await assert.rejects(quarantined.close(), serviceFails("store_close_failed"));
  } finally { rmSync(lab.dir, { recursive: true, force: true }); }
});

test("every request is a fresh full TLS 1.3 handshake: no keep-alive, no ticket/session resumption even when offered", async () => {
  const phone = endpoint("phone"), host = endpoint("host"), c = await child([phone.publicPin, host.publicPin]);
  try {
    let session: Buffer | undefined;
    const first = await openTls(c.port);
    first.on("session", (s: Buffer) => { session = s; });
    const firstDone = collect(first);
    assert.equal(first.getProtocol(), "TLSv1.3");
    first.write(httpRequest(JSON.stringify(pollOf(host))));
    assert.match(await firstDone, /^HTTP\/1\.1 200/);
    const second = await openTls(c.port, session ? { session } : {}), secondDone = collect(second);
    assert.equal(second.isSessionReused(), false, "server never resumes");
    second.write(httpRequest(JSON.stringify(pollOf(host))));
    assert.match(await secondDone, /^HTTP\/1\.1 200/);
    const t = client(c.port);
    for (let i = 0; i < 3; i++) await t.poll(pollOf(host));
    await t.close();
    const s = await c.cmd({ op: "status" });
    assert.equal(s.service.acceptedConnections, 5);
    assert.equal(s.service.refusedResumptions, 0);
  } finally { await c.close(); rmSync(c.dir, { recursive: true, force: true }); }
});

test("CLI process keeps canonical nofollow file custody by default and starts real handlers from test-only FD3 memory", async () => {
  const cli = fileURLToPath(new URL("./fixtures/relay-service-cli.js", import.meta.url));
  const dir = realpathSync(privateDir("dexter-relay-service-cli-")), phone = endpoint("phone"), host = endpoint("host");
  const sentinel = privateFile(join(dir, "public-sentinel.bin"), "inert public sentinel", 0o644);
  const readableSentinel = privateFile(join(dir, "readable-sentinel.bin"), "public text, not key material");
  const oversizedSentinel = privateFile(join(dir, "oversized-sentinel.bin"), "P".repeat(70_000));
  const base = { version: 1, dataDir: join(dir, "data"), ownerId: OWNER, installationId: INSTALL, host: "127.0.0.1", port: 0,
    tlsKeyFile: sentinel, tlsCertFile: join(dir, "missing-public-cert"), pins: [phone.publicPin, host.publicPin] };
  const run = (config: string) => spawnSync(process.execPath, [cli, "--config", config], { encoding: "utf8", timeout: 10_000, env: {} });
  try {
    const loose = privateFile(join(dir, "loose.json"), JSON.stringify(base), 0o640);
    const link = join(dir, "link.json"); symlinkSync(privateFile(join(dir, "target.json"), JSON.stringify(base)), link);
    const keyLink = join(dir, "key-link"); symlinkSync(sentinel, keyLink);
    const expectations: [string, string][] = [
      [loose, "config_untrusted"], [link, "config_untrusted"], [join(dir, "missing.json"), "config_untrusted"],
      [privateFile(join(dir, "big.json"), " ".repeat(70_000)), "config_untrusted"],
      [privateFile(join(dir, "badkey.json"), JSON.stringify({ ...base, tlsKeyFile: keyLink })), "tls_file_untrusted"],
      [privateFile(join(dir, "badmode.json"), JSON.stringify(base)), "tls_file_untrusted"],
      [privateFile(join(dir, "badtype.json"), JSON.stringify({ ...base, tlsKeyFile: dir })), "tls_file_untrusted"],
      [privateFile(join(dir, "badsize.json"), JSON.stringify({ ...base, tlsKeyFile: oversizedSentinel })), "tls_file_untrusted"],
      [privateFile(join(dir, "badcertsize.json"), JSON.stringify({ ...base, tlsKeyFile: readableSentinel, tlsCertFile: oversizedSentinel })), "tls_file_untrusted"],
      [privateFile(join(dir, "badcertlink.json"), JSON.stringify({ ...base, tlsKeyFile: readableSentinel, tlsCertFile: keyLink })), "tls_file_untrusted"],
      [privateFile(join(dir, "badcertmode.json"), JSON.stringify({ ...base, tlsKeyFile: readableSentinel, tlsCertFile: sentinel })), "tls_file_untrusted"],
      [privateFile(join(dir, "public.json"), JSON.stringify({ ...base, host: "0.0.0.0", tlsKeyFile: readableSentinel, tlsCertFile: readableSentinel })), "invalid_config"],
      [privateFile(join(dir, "extra.json"), JSON.stringify({ ...base, adminRoutes: true })), "config_invalid"],
    ];
    for (const [config, code] of expectations) {
      const r = run(config);
      assert.equal(r.status, 1, code);
      assert.equal(r.stdout, "");
      assert.equal(r.stderr, `${JSON.stringify({ error: code })}\n`, code);
    }
    const memoryConfig = { ...base, tlsKeyFile: "relay-memory://tls-key", tlsCertFile: "relay-memory://tls-cert" };
    const proc = await memoryCli(cli, ["--config", "relay-memory://config"], memoryConfig);
    let stdout = "", stderr = "";
    proc.stderr!.on("data", d => { stderr += String(d); });
    const listening = await new Promise<{ port: number }>((resolve, reject) => {
      proc.stdout!.on("data", d => { stdout += String(d); const line = stdout.split("\n")[0]; if (stdout.includes("\n")) resolve(JSON.parse(line!)); });
      proc.once("exit", () => reject(new Error("memory_cli_exited_before_listening")));
    });
    assert.notEqual(proc.pid, process.pid, "actual CLI handlers run in a separate process");
    const t = client(listening.port);
    const r = await t.enqueue(seal(phone, host, 1));
    assert.deepEqual((await t.poll(pollOf(host))).deliveries.map(d => d.receiptId), [r.receiptId]);
    await t.close();
    let wipe = ""; proc.stdio[4]!.on("data", d => { wipe += String(d); });
    const exit = new Promise<number | null>(res => proc.once("close", code => res(code)));
    proc.kill("SIGTERM");
    assert.equal(await exit, 0);
    assert.equal(wipe, "WIPE_OK", "the real CLI lifecycle wipes the exact private Buffer delivered on FD3");
    assert.deepEqual(stdout.trim().split("\n").map(l => JSON.parse(l).event), ["listening", "closed"]);
    assert.equal(stderr, "");
    assert.equal(/PRIVATE KEY|CERTIFICATE|SYNTHETIC_RELAY/.test(stdout + stderr), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI WIPE_OK observes the handed Buffer before fixture cleanup and detects a missing real CLI wipe", async t => {
  const originalCli = fileURLToPath(new URL("./fixtures/relay-service-cli.js", import.meta.url));
  const distRoot = fileURLToPath(new URL("..", import.meta.url));
  const privateRoot = privateDir("dexter-relay-wipe-regression-");
  const mutantRoot = join(privateRoot, "counterfactual");
  mkdirSync(mutantRoot, { mode: 0o700 });
  const mutantService = join(mutantRoot, "packages/relay-service/src");
  const mutantFixtures = join(mutantRoot, "tests/fixtures");
  mkdirSync(mutantService, { recursive: true, mode: 0o700 });
  mkdirSync(mutantFixtures, { recursive: true, mode: 0o700 });
  cpSync(join(distRoot, "packages/relay-service/src"), mutantService, { recursive: true });
  for (const file of ["relay-service-cli.js", "relay-service-cli-memory-loader.js", "relay-service-cli-memory-files.js", "relay-memory-ipc.js"])
    cpSync(join(distRoot, "tests/fixtures", file), join(mutantFixtures, file));
  writeFileSync(join(mutantRoot, "package.json"), '{"type":"module"}\n', { mode: 0o600 });
  symlinkSync(join(distRoot, "..", "node_modules"), join(mutantRoot, "node_modules"), "dir");

  const mutantCliSourcePath = join(mutantService, "cli.js");
  const cliSource = readFileSync(mutantCliSourcePath, "utf8");
  const wipeStatement = "this.key?.fill(0);";
  assert.equal(cliSource.split(wipeStatement).length - 1, 1, "the counterfactual targets exactly the real compiled Lifecycle wipe");
  writeFileSync(mutantCliSourcePath, cliSource.replace(wipeStatement, "/* counterfactual: only the actual CLI key wipe is absent */"));

  const phone = endpoint("phone"), host = endpoint("host");
  const runCli = async (entry: string, loader: string, label: string) => {
    mkdirSync(join(privateRoot, label), { recursive: true, mode: 0o700 });
    const config = { version: 1, dataDir: join(privateRoot, label, "data"), ownerId: OWNER, installationId: INSTALL,
      host: "127.0.0.1", port: 0, tlsKeyFile: "relay-memory://tls-key", tlsCertFile: "relay-memory://tls-cert",
      pins: [phone.publicPin, host.publicPin] };
    const proc = spawn(process.execPath, ["--no-warnings", "--experimental-loader", loader, entry, "--config", "relay-memory://config"],
      { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"], env: {} });
    let stdout = "", stderr = "", wipe = "", timedOut = false, closed = false;
    proc.stdout!.on("data", d => { stdout += String(d); });
    proc.stderr!.on("data", d => { stderr += String(d); });
    proc.stdio[4]!.on("data", d => { wipe += String(d); });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => proc.once("close", (code, signal) => { closed = true; resolve({ code, signal }); }));
    const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, 12_000);
    try {
      await sendMemoryRecord(proc, encodeRelayMemoryRecord(config, GOOD.key, GOOD.cert));
      await until(() => stdout.includes("\n") || proc.exitCode !== null, 8_000);
      const firstLine = stdout.split("\n")[0]!;
      const listening = JSON.parse(firstLine) as { event: string; port: number };
      assert.equal(listening.event, "listening", `${label} is the actual CLI child process`);
      const transport = client(listening.port);
      try { assert.deepEqual((await transport.poll(pollOf(host))).deliveries, [], `${label} handled a real signed TLS request`); }
      finally { await transport.close(); }
      proc.kill("SIGTERM");
      const result = await exit;
      const events = stdout.trim().split("\n").filter(Boolean).map(line => (JSON.parse(line) as { event: string }).event);
      return { ...result, stdout, stderr, wipe, timedOut, events };
    } finally {
      clearTimeout(timer);
      if (!closed) { proc.kill("SIGKILL"); await exit; }
    }
  };

  try {
    const control = await runCli(originalCli, CLI_MEMORY_LOADER, "control");
    assert.deepEqual([control.code, control.signal, control.timedOut, control.events, control.stderr, control.wipe],
      [0, null, false, ["listening", "closed"], "", "WIPE_OK"], "the real CLI wipes the exact issued Buffer before fixture cleanup");
    const mutant = await runCli(join(mutantFixtures, "relay-service-cli.js"), join(mutantFixtures, "relay-service-cli-memory-loader.js"), "wipe-disabled");
    assert.deepEqual([mutant.code, mutant.signal, mutant.timedOut, mutant.events, mutant.stderr],
      [0, null, false, ["listening", "closed"], ""], "only the actual CLI key wipe changed; handlers and TLS lifecycle still ran");
    assert.equal(mutant.wipe, "WIPE_MISSING", "the fixture cannot manufacture WIPE_OK by clearing the Buffer after CLI exit");
    t.diagnostic(`control_exit=${control.code};control_receipt=${control.wipe};control_events=listening,closed;mutant_exit=${mutant.code};mutant_receipt=${mutant.wipe};mutant_events=listening,closed;stderr_bytes=${Buffer.byteLength(control.stderr + mutant.stderr)}`);
  } finally { rmSync(privateRoot, { recursive: true, force: true }); }
});

test("test-only CLI memory reader preserves raw bytes for real strict config refusals and wipes unread material", async () => {
  const cli = fileURLToPath(new URL("./fixtures/relay-service-cli.js", import.meta.url));
  const dir = realpathSync(privateDir("dexter-relay-cli-config-bytes-"));
  const base = { version: 1, dataDir: join(dir, "data"), ownerId: OWNER, installationId: INSTALL, host: "127.0.0.1", port: 0,
    tlsKeyFile: "relay-memory://tls-key", tlsCertFile: "relay-memory://tls-cert", pins: [endpoint("phone").publicPin, endpoint("host").publicPin] };
  const valid = Buffer.from(JSON.stringify(base));
  const duplicateKey = Buffer.from(`{"version":2,${JSON.stringify(base).slice(1)}`);
  const invalidUtf8 = Buffer.from(valid);
  const ownerOffset = invalidUtf8.indexOf(Buffer.from("lab-owner"));
  assert.notEqual(ownerOffset, -1);
  invalidUtf8[ownerOffset] = 0xff;
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]);
  let deeplyNested: unknown = null;
  for (let i = 0; i < 40; i++) deeplyNested = [deeplyNested];
  const excessiveDepth = Buffer.from(JSON.stringify({ ...base, extra: deeplyNested }));
  const trailing = Buffer.concat([valid, Buffer.from(" trailing")]);
  const cases: [string, Buffer][] = [
    ["duplicate top-level key", duplicateKey], ["invalid UTF-8", invalidUtf8], ["BOM", bom],
    ["excessive JSON depth", excessiveDepth], ["trailing data", trailing],
  ];
  try {
    for (const [name, bytes] of cases) {
      const proc = await memoryCliRawConfig(cli, ["--config", "relay-memory://config"], bytes);
      const result = await collectBoundedChild(proc);
      assert.deepEqual(result, { code: 1, stdout: "", stderr: `${JSON.stringify({ error: "config_untrusted" })}\n`, wipe: "WIPE_RECORD_OK", timedOut: false }, name);
    }
  } finally {
    valid.fill(0); duplicateKey.fill(0); invalidUtf8.fill(0); bom.fill(0); excessiveDepth.fill(0); trailing.fill(0);
    rmSync(dir, { recursive: true, force: true });
  }
});

// =====================================================================================
// R2 corrections: L1 absolute deadline, L2 internal is ambiguous, L3 limitation, L4 drain destroy, L5 lifecycle
// =====================================================================================

/** TLS-looking peer that answers the ClientHello with an unfinished record and drips one byte per 100 ms. */
async function dripPeer(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<NetSocket>();
  const server = netServer(s => {
    sockets.add(s); s.on("error", () => undefined);
    s.write(Buffer.from([0x16, 0x03, 0x03, 0x40, 0x00]));
    let n = 0;
    const timer = setInterval(() => { if (n++ >= 40 || s.destroyed) clearInterval(timer); else s.write("x"); }, 100);
    s.once("close", () => { clearInterval(timer); sockets.delete(s); });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>(r => { for (const s of sockets) s.destroy(); server.close(() => r()); }) };
}

test("L1 absolute deadline: timeoutMs bounds the whole request; a slow response drip is unknown, a slow handshake drip is not_sent", async () => {
  const phone = endpoint("phone"), host = endpoint("host");
  let serverSide: NetSocket | null = null;
  const dripResponse = await fakeServer(GOOD, (q, r) => {
    serverSide = q.socket; q.resume();
    r.writeHead(200, { "content-type": "application/json", "content-length": 4_000 });
    let n = 0;
    const timer = setInterval(() => { if (n++ >= 50 || r.destroyed) clearInterval(timer); else r.write("x"); }, 100);
    r.once("close", () => clearInterval(timer));
  });
  const drip = await dripPeer();
  try {
    const t = client(dripResponse.port, { timeoutMs: 1_000 });
    let started = Date.now();
    await assert.rejects(t.enqueue(seal(phone, host, 1)), fails("timeout", "unknown"));
    assert.ok(Date.now() - started < 2_600, `response drip bounded by the absolute deadline (took ${Date.now() - started} ms)`);
    await until(() => (serverSide as { destroyed: boolean } | null)?.destroyed === true);
    await t.close();
    assert.equal(dripResponse.requests(), 1, "no retry after the deadline");

    const t2 = client(drip.port, { timeoutMs: 1_000 });
    started = Date.now();
    await assert.rejects(t2.poll(pollOf(host)), fails("timeout", "not_sent"));
    const took = Date.now() - started;
    assert.ok(took >= 800 && took < 2_600, `handshake drip bounded from before connect (took ${took} ms)`);
    await t2.close();
  } finally { await dripResponse.close(); await drip.close(); }
});

test("L2 internal after commit is unknown, never rejected: real TLS service over a store that commits then fails to serialize", async () => {
  class CommitThenCorrupt extends RelayStore {
    override enqueue(value: unknown): QueueReceipt { return { ...super.enqueue(value), cursor: 1.5 }; }
  }
  const lab = labStore(); lab.seed();
  const store = new CommitThenCorrupt(lab.options);
  const service = await RelayService.start({ store: { borrow: store }, tls: { key: GOOD.key, cert: GOOD.cert }, host: "127.0.0.1", port: 0 });
  const t = client(service.address.port);
  const fake = await fakeServer(GOOD, (q, r) => { q.resume(); r.writeHead(500, { "content-type": "application/json", "content-length": 20 }); r.end('{"error":"internal"}'); });
  const t2 = client(fake.port);
  try {
    await assert.rejects(t.enqueue(seal(lab.phone, lab.host, 1)), fails("internal", "unknown"));
    assert.equal(store.status().messages, 1, "the store committed although the caller saw an error: rejected would be a lie");
    assert.equal(store.status().pending, 1);
    await assert.rejects(t2.enqueue(seal(lab.phone, lab.host, 1)), fails("internal", "unknown"), "any wire internal is ambiguous");
    assert.equal(fake.requests(), 1);
  } finally { await t.close(); await t2.close(); await fake.close(); await service.close(); store.close(); rmSync(lab.dir, { recursive: true, force: true }); }
});

test("L3 limitation: failed owned store close quarantines the wrapper, which never admits again, but the frozen store releases its writer", async () => {
  const lab = labStore(); lab.seed();
  let now = Date.now();
  const service = await RelayService.start({ store: { own: { ...lab.options, clock: () => now } }, tls: { key: GOOD.key, cert: GOOD.cert }, host: "127.0.0.1", port: 0 });
  const port = service.address.port;
  try {
    assert.throws(() => new RelayStore(lab.options), "owned writer held while serving");
    now += 3_600_000;
    await assert.rejects(service.close(), serviceFails("store_close_failed"));
    assert.equal(service.status().state, "quarantined");
    assert.equal(service.status().pending, null);
    await assert.rejects(openTls(port), "a quarantined wrapper accepts no new flow");
    await assert.rejects(service.close(), serviceFails("store_close_failed"), "same permanent failure");
    // Known limitation: the frozen RelayStore.close releases its writer in finally, so
    // the wrapper cannot keep it. Canonical writer retention belongs to the consumer/HostServices layer.
    const taken = new RelayStore(lab.options);
    assert.doesNotThrow(() => taken.status(), "writer was NOT retained by the quarantined service");
    taken.close();
  } finally { rmSync(lab.dir, { recursive: true, force: true }); }
});

test("L4 drain deadline destroys held TLS and pre-handshake sockets; close resolves only after their actual close events", async () => {
  const lab = labStore(); lab.seed();
  const service = await RelayService.start({ store: { own: lab.options }, tls: { key: GOOD.key, cert: GOOD.cert }, host: "127.0.0.1", port: 0, timeouts: { drainMs: 600 } });
  const port = service.address.port, events: string[] = [];
  const held = await openTls(port), rawSocket = netConnect(port, "127.0.0.1");
  held.on("error", () => undefined); rawSocket.on("error", () => undefined); held.resume();
  held.once("close", () => events.push("held-tls-close")); rawSocket.once("close", () => events.push("raw-tcp-close"));
  const bytes = httpRequest(JSON.stringify(pollOf(lab.host)));
  held.write(bytes.subarray(0, bytes.length - 10));
  let closing: Promise<void> = Promise.resolve();
  try {
    await until(() => service.status().activeRequests === 1 && service.status().openConnections === 2);
    const started = Date.now();
    closing = service.close().then(() => { events.push("service-close"); });
    await sleep(250);
    assert.deepEqual(events, [], "a held body and a silent socket keep close pending before the deadline");
    assert.throws(() => new RelayStore(lab.options), "owned store writer is still held while sockets drain");
    const outcome = await Promise.race([closing.then(() => "closed"), sleep(4_000).then(() => "hung")]);
    assert.equal(outcome, "closed", "the deadline destroyed the held sockets; a timer alone would never settle close");
    assert.ok(Date.now() - started >= 550, "close waited for the deadline");
    assert.equal(events.at(-1), "service-close");
    assert.deepEqual([...events].sort(), ["held-tls-close", "raw-tcp-close", "service-close"], "every socket's actual close came before close resolved");
    assert.equal(service.status().openConnections, 0);
    const reopened = new RelayStore(lab.options);
    assert.equal(reopened.status().controls, 0, "the held poll never reached the store");
    reopened.close();
  } finally {
    held.destroy(); rawSocket.destroy();
    await Promise.race([closing, sleep(3_000)]);
    rmSync(lab.dir, { recursive: true, force: true });
  }
});

test("L5 borrowed store that is already closed fails preflight before listening, leaving the caller's store alone", async () => {
  const lab = labStore(); lab.seed();
  const blocker = netServer(); await new Promise<void>(r => blocker.listen(0, "127.0.0.1", () => r()));
  const busy = (blocker.address() as AddressInfo).port;
  const closed = new RelayStore(lab.options); closed.close();
  try {
    await assert.rejects(RelayService.start({ store: { borrow: closed }, tls: { key: GOOD.key, cert: GOOD.cert }, host: "127.0.0.1", port: busy }), serviceFails("store_unavailable"),
      "preflight (before listen) not listen_failed on the busy port");
    await assert.rejects(RelayService.start({ store: { borrow: closed }, tls: { key: GOOD.key, cert: GOOD.cert }, host: "127.0.0.1", port: 0 }), serviceFails("store_unavailable"));
  } finally { await new Promise<void>(r => blocker.close(() => r())); rmSync(lab.dir, { recursive: true, force: true }); }
});

interface CliRun { code: number | null; stdout: string; stderr: string; calls: string; wipe: string }
const DRAINED_THEN_STORE = "service-close-begin,service-close-end,store-close";
async function cliProbe(mode: string, config: object, calls: string, signals: (proc: ChildProcess, listening: Promise<void>) => void = () => undefined): Promise<CliRun> {
  const probe = fileURLToPath(new URL("./fixtures/relay-service-cli-probe.js", import.meta.url));
  const proc = await memoryCli(probe, [mode, calls, "--config", "relay-memory://config"], config);
  let stdout = "", stderr = "", wipe = "";
  let heard!: () => void; const listening = new Promise<void>(r => { heard = r; });
  proc.stdout!.on("data", d => { stdout += String(d); if (stdout.includes("listening")) heard(); });
  proc.stderr!.on("data", d => { stderr += String(d); });
  proc.stdio[4]!.on("data", d => { wipe += String(d); });
  signals(proc, listening);
  return new Promise(resolve => {
    const guard = setTimeout(() => proc.kill("SIGKILL"), 10_000);
    proc.once("close", code => { clearTimeout(guard); resolve({ code, stdout, stderr, calls: existsSync(calls) ? readFileSync(calls, "utf8") : "missing", wipe }); });
  });
}

test("L5 CLI: real startup signals drain service before closing the borrowed store exactly once", async () => {
  const dir = realpathSync(privateDir("dexter-relay-service-cli2-")), phone = endpoint("phone"), host = endpoint("host");
  const base = { version: 1, dataDir: join(dir, "data"), ownerId: OWNER, installationId: INSTALL, host: "127.0.0.1", port: 0,
    tlsKeyFile: "relay-memory://tls-key", tlsCertFile: "relay-memory://tls-cert", pins: [phone.publicPin, host.publicPin] };
  const config = (over: object = {}) => ({ ...base, ...over });
  const events = (r: CliRun) => r.stdout.trim().split("\n").filter(Boolean).map(l => JSON.parse(l).event);
  try {
    const early = await cliProbe("startup-signal", config(), join(dir, "calls-a"));
    assert.deepEqual([early.code, early.stderr, events(early), early.calls, early.wipe], [0, "", ["closed"], DRAINED_THEN_STORE, "WIPE_OK"], "SIGTERM during real startup drains the service and wipes the CLI-owned key before process exit");
    const afterEarly = new RelayStore({ dataDir: base.dataDir, ownerId: OWNER, installationId: INSTALL });
    afterEarly.close(); // writer was released

    const blocker = netServer(); await new Promise<void>(r => blocker.listen(0, "127.0.0.1", () => r()));
    const busy = (blocker.address() as AddressInfo).port;
    try {
      const listenFailed = await cliProbe("run", config({ port: busy }), join(dir, "calls-b"));
      assert.deepEqual([listenFailed.code, listenFailed.stdout, listenFailed.stderr, listenFailed.calls, listenFailed.wipe], [1, "", `${JSON.stringify({ error: "listen_failed" })}\n`, "store-close", "WIPE_OK"], "listener rollback closes the borrowed store and wipes its key once");
    } finally { await new Promise<void>(r => blocker.close(() => r())); }

    const badPin = await cliProbe("run", config({ pins: [{ deviceId: "x" }] }), join(dir, "calls-c"));
    assert.deepEqual([badPin.code, badPin.stdout, badPin.calls, badPin.wipe], [1, "", "store-close", "WIPE_OK"], "invalid public pin registration closes the store and wipes its key");
    assert.match(badPin.stderr, /^\{"error":"[a-z_]{1,40}"\}\n$/);

    const twice = await cliProbe("run", config(), join(dir, "calls-d"), (proc, listening) => { void listening.then(() => { proc.kill("SIGTERM"); proc.kill("SIGTERM"); proc.kill("SIGINT"); }); });
    assert.deepEqual([twice.code, twice.stderr, events(twice), twice.calls, twice.wipe], [0, "", ["listening", "closed"], DRAINED_THEN_STORE, "WIPE_OK"], "repeat signals share one cached stop and wipe the key");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
