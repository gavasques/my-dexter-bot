import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash, verify, createPublicKey } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { inspect } from "node:util";
import { RelayEndpoint, RelayError, RelayStore, MAX_CIPHERTEXT_BYTES, type RelayOptions, type RelayErrorCode } from "../packages/relay/src/index.js";
import { header, envelopeBytes, digest, controlBytes, type Envelope, type DevicePin, type AckRequest } from "../packages/relay/src/protocol.js";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const code = (c: RelayErrorCode) => (e: unknown): boolean => e instanceof RelayError && e.code === c;
function endpoint(deviceId: string, generation = 1, ownerId = "synthetic-owner", installationId = "synthetic-host") {
  return new RelayEndpoint({ ownerId, installationId, deviceId, generation, keyId: `${deviceId}-key-${generation}` });
}
function lab(options: Partial<RelayOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "dexter-relay-synthetic-"));
  let now = NOW;
  const config: RelayOptions = { dataDir: root, ownerId: "synthetic-owner", installationId: "synthetic-host", clock: () => now, ...options };
  let store = new RelayStore(config);
  const a = endpoint("sender"), b = endpoint("recipient"), c = endpoint("third");
  for (const e of [a, b, c]) store.registerDevice(e.publicPin);
  return { root, config, a, b, c, get store() { return store; }, setNow(n: number) { now = n; },
    seal(sequence = 1, messageId: string = randomUUID(), payload = "SYNTHETIC_PRIVATE_PAYLOAD_ONLY") {
      return a.seal(b.publicPin, { messageId, sequence, type: "event", createdAt: now, expiresAt: now + 60_000 }, Buffer.from(payload));
    },
    poll(recipient = b, after = 0, limit = 100) { return store.poll(recipient.poll({ requestId: randomUUID(), issuedAt: now, after, limit })); },
    restart() { store.close(); store = new RelayStore(config); },
    close() { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("standard endpoint crypto roundtrips only to the pinned recipient; relay stores no plaintext", () => {
  const l = lab();
  try {
    const e = l.seal(), receipt = l.store.enqueue(e), polled = l.poll();
    assert.equal(polled.deliveries.length, 1); assert.deepEqual(receipt, { receiptId: polled.deliveries[0]!.receiptId, cursor: polled.cursor });
    assert.equal(l.b.open(e, l.a.publicPin).toString(), "SYNTHETIC_PRIVATE_PAYLOAD_ONLY");
    assert.throws(() => l.c.open(e, l.a.publicPin), code("forbidden"));
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(l.store.databasePath + suffix)) {
      assert.equal(readFileSync(l.store.databasePath + suffix).includes(Buffer.from("SYNTHETIC_PRIVATE_PAYLOAD_ONLY")), false);
      assert.equal(lstatSync(l.store.databasePath + suffix).mode & 0o777, 0o600);
    }
    assert.equal(JSON.stringify(l.store).includes("ciphertext"), false);
    assert.equal(inspect(l.a).includes("PRIVATE KEY"), false);
    assert.deepEqual(Object.keys(l.a), []);
  } finally { l.close(); }
});

test("signature binds ciphertext, tag, nonce and all routing/ordering metadata", () => {
  const l = lab();
  try {
    const e = l.seal();
    const mutations = { messageId: "tampered", senderId: l.c.publicPin.deviceId, recipientId: l.c.publicPin.deviceId,
      senderGeneration: 2, recipientGeneration: 2, senderKeyId: "other", recipientKeyId: "other", type: "command", sequence: 2,
      createdAt: NOW + 1, expiresAt: NOW + 60_001, ciphertext: Buffer.from("tampered").toString("base64"),
      nonce: Buffer.alloc(12, 1).toString("base64"), tag: Buffer.alloc(16, 1).toString("base64"), ephemeralPublicKey: l.c.publicPin.encryptionPublicKey };
    for (const [key, value] of Object.entries(mutations)) {
      assert.throws(() => l.store.enqueue({ ...e, [key]: value }), code("forbidden"), key);
      assert.throws(() => l.b.open({ ...e, [key]: value }, l.a.publicPin), code("forbidden"), key);
    }
    assert.deepEqual(l.poll().deliveries, []);
  } finally { l.close(); }
});

test("unknown devices and cross-owner/installation pins never authorize queue or reads", () => {
  const l = lab();
  try {
    const unknown = endpoint("unknown"), other = endpoint("other", 1, "other-owner"), host = endpoint("other", 1, "synthetic-owner", "other-installation");
    assert.throws(() => l.store.registerDevice(other.publicPin), code("forbidden"));
    assert.throws(() => l.store.registerDevice(host.publicPin), code("forbidden"));
    assert.throws(() => l.store.enqueue(unknown.seal(l.b.publicPin, { messageId: randomUUID(), sequence: 1, type: "event", createdAt: NOW, expiresAt: NOW + 1000 }, Buffer.from("x"))), code("forbidden"));
    assert.throws(() => l.poll(unknown), code("forbidden"));
    assert.throws(() => l.poll(other), code("forbidden"));
    assert.throws(() => l.a.seal(other.publicPin, { messageId: "msg", sequence: 1, type: "event", createdAt: NOW, expiresAt: NOW + 1000 }, Buffer.from("x")), code("forbidden"));
  } finally { l.close(); }
});

test("enqueue replay preserves durable receipt; conflicting ID and skipped/backwards sequence reject", () => {
  const l = lab();
  try {
    const e = l.seal(), receipt = l.store.enqueue(e);
    assert.deepEqual(l.store.enqueue(e), receipt); l.restart(); assert.deepEqual(l.store.enqueue(e), receipt);
    assert.throws(() => l.store.enqueue(l.seal(2, e.messageId, "different")), code("conflict"));
    assert.throws(() => l.store.enqueue(l.seal(1)), code("conflict"));
    assert.throws(() => l.store.enqueue(l.seal(3)), code("conflict"));
    l.store.enqueue(l.seal(2)); assert.equal(l.poll().deliveries.length, 2);
  } finally { l.close(); }
});

test("offline queue survives restart and paginates in stable cursor order", () => {
  const l = lab();
  try {
    const e1 = l.seal(1), e2 = l.seal(2), e3 = l.seal(3);
    [e1, e2, e3].forEach(e => l.store.enqueue(e)); l.restart();
    const first = l.poll(l.b, 0, 2), second = l.poll(l.b, first.cursor, 2);
    assert.deepEqual(first.deliveries.map(x => x.envelope.messageId), [e1.messageId, e2.messageId]);
    assert.deepEqual(second.deliveries.map(x => x.envelope.messageId), [e3.messageId]);
    assert.deepEqual(l.poll(l.b, second.cursor).deliveries, []);
    assert.deepEqual(l.poll(l.c).deliveries, []);
  } finally { l.close(); }
});

test("poll authentication is bound to recipient, cursor, limit and single-use nonce", () => {
  const l = lab();
  try {
    l.store.enqueue(l.seal()); const p = l.b.poll({ requestId: randomUUID(), issuedAt: NOW, after: 0, limit: 1 });
    assert.throws(() => l.store.poll({ ...p, deviceId: "sender" }), code("forbidden"));
    assert.throws(() => l.store.poll({ ...p, after: 1 }), code("forbidden"));
    assert.throws(() => l.store.poll({ ...p, limit: 2 }), code("forbidden"));
    assert.equal(l.store.poll(p).deliveries.length, 1); assert.throws(() => l.store.poll(p), code("conflict"));
    l.restart(); assert.throws(() => l.store.poll(p), code("conflict"));
  } finally { l.close(); }
});

test("ACK binds recipient and receipt; atomic batches reject missing and foreign identifiers", () => {
  const l = lab();
  try {
    const e = l.seal(), receipt = l.store.enqueue(e), item = { messageId: e.messageId, receiptId: receipt.receiptId };
    assert.throws(() => l.store.ack(l.a.ack({ requestId: randomUUID(), issuedAt: NOW, messages: [item] })), code("forbidden"));
    assert.throws(() => l.store.ack(l.b.ack({ requestId: randomUUID(), issuedAt: NOW, messages: [item, { messageId: "missing", receiptId: randomUUID() }] })), code("forbidden"));
    assert.throws(() => l.store.ack(l.b.ack({ requestId: randomUUID(), issuedAt: NOW, messages: [{ ...item, receiptId: randomUUID() }] })), code("forbidden"));
    assert.equal(l.poll().deliveries.length, 1);
    const request = l.b.ack({ requestId: randomUUID(), issuedAt: NOW, messages: [item] }), ack = l.store.ack(request);
    assert.deepEqual(l.poll().deliveries, []); l.restart(); assert.deepEqual(l.store.ack(request), ack);
    assert.deepEqual(l.store.enqueue(e), receipt); assert.deepEqual(l.poll().deliveries, []);
  } finally { l.close(); }
});

test("rotation/revocation makes old queued/replay traffic inaccessible, including generation ABA", () => {
  const l = lab();
  try {
    const e = l.seal(); l.store.enqueue(e);
    const next = endpoint("recipient", 2); l.store.registerDevice(next.publicPin);
    assert.throws(() => l.poll(), code("forbidden")); assert.deepEqual(l.poll(next).deliveries, []);
    assert.throws(() => l.store.enqueue(e), code("forbidden"));
    assert.throws(() => l.store.registerDevice(l.b.publicPin), code("conflict"));
    assert.throws(() => l.store.registerDevice({ ...next.publicPin, generation: 3 }), code("conflict"));
    l.store.revokeDevice("sender"); assert.throws(() => l.store.enqueue(e), code("forbidden"));
    assert.throws(() => l.poll(l.a), code("forbidden"));
    assert.equal(l.store.cleanup(1), 1); l.restart(); assert.throws(() => l.store.enqueue(e), code("forbidden"));
  } finally { l.close(); }
});

test("sender revocation after first delivery prevents retransmission", () => {
  const l = lab();
  try { l.store.enqueue(l.seal()); assert.equal(l.poll().deliveries.length, 1); l.store.revokeDevice("sender"); assert.deepEqual(l.poll().deliveries, []); }
  finally { l.close(); }
});

test("TTL cleanup removes bounded ciphertext while receipts and sequences survive", () => {
  const l = lab();
  try {
    const first = l.seal(1), second = l.seal(2); const receipt = l.store.enqueue(first); l.store.enqueue(second);
    l.setNow(NOW + 60_000); assert.deepEqual(l.poll().deliveries, []);
    assert.equal(l.store.cleanup(1), 1); l.restart(); assert.deepEqual(l.store.enqueue(first), receipt);
    assert.throws(() => l.store.enqueue(l.seal(1)), code("conflict"));
    assert.equal(l.store.cleanup(1), 1); assert.equal(l.store.cleanup(1), 0);
    l.store.enqueue(l.seal(3)); assert.equal(l.poll().deliveries[0]!.envelope.sequence, 3);
  } finally { l.close(); }
});

test("pending quotas and replay marker bounds fail closed without advancing sequence", () => {
  const l = lab({ maximumPending: 2, maximumPendingPerRecipient: 1, maximumMarkers: 10 });
  try {
    const first = l.seal(); const receipt = l.store.enqueue(first);
    assert.throws(() => l.store.enqueue(l.seal(2)), code("quota"));
    l.store.ack(l.b.ack({ requestId: "ack-first", issuedAt: NOW, messages: [{ messageId: first.messageId, receiptId: receipt.receiptId }] }));
    const second = l.store.enqueue(l.seal(2)); assert.ok(second.cursor > receipt.cursor); assert.equal(l.store.status().pending, 1);
  } finally { l.close(); }
  const small = lab({ maximumMarkers: 1 });
  try { small.store.enqueue(small.seal()); assert.throws(() => small.store.enqueue(small.seal(2)), code("quota")); small.poll(); assert.throws(() => small.poll(), code("quota")); }
  finally { small.close(); }
});

test("strict schemas enforce bounded options, payloads, timestamps and cryptographic key kinds", () => {
  const l = lab();
  try {
    for (const limit of [0, -1, 101, Infinity, 1.5]) assert.throws(() => l.b.poll({ requestId: randomUUID(), issuedAt: NOW, after: 0, limit }), code("invalid_input"));
    assert.throws(() => l.store.cleanup(1001), code("invalid_input"));
    assert.throws(() => l.store.enqueue({ ...l.seal(), plaintext: "forbidden" }), code("invalid_input"));
    assert.throws(() => l.store.registerDevice({ ...l.a.publicPin, privateKey: "forbidden" }), code("invalid_input"));
    assert.throws(() => l.store.registerDevice({ ...l.a.publicPin, encryptionPublicKey: l.a.publicPin.signingPublicKey }), code("invalid_input"));
    assert.throws(() => l.a.seal(l.b.publicPin, { messageId: "msg", sequence: 1, type: "event", createdAt: NOW, expiresAt: NOW + 1000 }, Buffer.alloc(MAX_CIPHERTEXT_BYTES + 1)), code("invalid_input"));
    assert.throws(() => l.store.enqueue({ ...l.seal(), signature: "not base64" }), code("invalid_input"));
    assert.throws(() => l.store.poll(l.b.poll({ requestId: randomUUID(), issuedAt: NOW - 30_001, after: 0, limit: 1 })), code("expired"));
    const e = l.a.seal(l.b.publicPin, { messageId: "expired", sequence: 1, type: "event", createdAt: NOW - 10_000, expiresAt: NOW - 1 }, Buffer.from("x"));
    assert.throws(() => l.store.enqueue(e), code("expired"));
  } finally { l.close(); }
});

test("database identity, permissions, live writer and lost token are fenced", () => {
  const l = lab();
  try {
    assert.throws(() => new RelayStore(l.config), code("host_locked"));
    const raw = new DatabaseSync(l.store.databasePath), token = raw.prepare("SELECT token FROM lease WHERE id=1").get()!.token;
    raw.prepare("UPDATE lease SET token='synthetic-lost-token' WHERE id=1").run();
    assert.throws(() => l.store.enqueue(l.seal()), code("host_locked")); assert.throws(() => l.poll(), code("host_locked"));
    raw.prepare("UPDATE lease SET token=? WHERE id=1").run(token!); raw.close();
    l.store.close(); assert.throws(() => new RelayStore({ ...l.config, ownerId: "foreign-owner" }), code("forbidden"));
    assert.throws(() => new RelayStore({ ...l.config, installationId: "foreign-host" }), code("forbidden"));
    l.restart(); assert.equal(lstatSync(l.store.databasePath).mode & 0o777, 0o600);
    chmodSync(l.store.databasePath, 0o644); assert.throws(() => l.poll(), code("forbidden")); chmodSync(l.store.databasePath, 0o600);
  } finally { l.close(); }
});

test("dangling database and sidecar symlinks cause zero outside writes", () => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const root = mkdtempSync(join(tmpdir(), "dexter-relay-link-")), dir = join(root, "data"), outside = join(root, "missing-outside"); mkdirSync(dir, { mode: 0o700 });
    try {
      symlinkSync(outside, join(dir, `relay.sqlite${suffix}`));
      assert.throws(() => new RelayStore({ dataDir: dir, ownerId: "synthetic-owner", installationId: "synthetic-host" }), code("forbidden"));
      assert.equal(existsSync(outside), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("missing anti-replay tables are refused instead of silently resetting counters", () => {
  const l = lab();
  try {
    l.store.enqueue(l.seal()); l.store.close();
    const raw = new DatabaseSync(l.store.databasePath); raw.exec("DROP TABLE sequences"); raw.close();
    assert.throws(() => new RelayStore(l.config), code("forbidden"));
  } finally { l.close(); }
});

test("a crashed writer releases ownership only after process exit; committed queue survives", () => {
  const root = mkdtempSync(join(tmpdir(), "dexter-relay-crash-")), a = endpoint("sender"), b = endpoint("recipient");
  const e = a.seal(b.publicPin, { messageId: randomUUID(), sequence: 1, type: "event", createdAt: NOW, expiresAt: NOW + 60_000 }, Buffer.from("synthetic-crash"));
  let store: RelayStore | undefined;
  try {
    // This child receives only public pins and ciphertext. No shell, network, private keys or engine.
    const moduleUrl = new URL("../packages/relay/src/index.js", import.meta.url).href;
    const script = `import {RelayStore} from ${JSON.stringify(moduleUrl)};
      const input=JSON.parse(process.argv[1]); const s=new RelayStore({...input.options,clock:()=>${NOW}});
      input.pins.forEach(p=>s.registerDevice(p));s.enqueue(input.envelope);
      process.kill(process.pid,'SIGKILL');`;
    const options = { dataDir: root, ownerId: "synthetic-owner", installationId: "synthetic-host" };
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify({ options, pins: [a.publicPin, b.publicPin], envelope: e })],
      { timeout: 5000, env: {}, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(child.signal, "SIGKILL"); assert.equal(child.error, undefined);
    store = new RelayStore({ ...options, clock: () => NOW });
    const batch = store.poll(b.poll({ requestId: "after-crash", issuedAt: NOW, after: 0, limit: 1 }));
    assert.equal(batch.deliveries.length, 1); assert.equal(b.open(batch.deliveries[0]!.envelope, a.publicPin).toString(), "synthetic-crash");
    assert.equal(store.enqueue(e).receiptId, batch.deliveries[0]!.receiptId);
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("fresh approved generation works while stale generations remain permanently refused", () => {
  const l = lab();
  try {
    const old = l.seal(); l.store.enqueue(old);
    const b2 = endpoint("recipient", 2); l.store.registerDevice(b2.publicPin);
    const fresh = l.a.seal(b2.publicPin, { messageId: randomUUID(), sequence: 1, type: "event", createdAt: NOW, expiresAt: NOW + 1000 }, Buffer.from("synthetic-new-generation"));
    l.store.enqueue(fresh); l.restart();
    const batch = l.poll(b2); assert.deepEqual(batch.deliveries.map(x => x.envelope.messageId), [fresh.messageId]);
    assert.equal(b2.open(batch.deliveries[0]!.envelope, l.a.publicPin).toString(), "synthetic-new-generation");
    assert.throws(() => l.store.enqueue(old), code("forbidden")); assert.throws(() => l.poll(l.b), code("forbidden"));
  } finally { l.close(); }
});

test("global pending quota cannot be bypassed by choosing another recipient", () => {
  const l = lab({ maximumPending: 2, maximumPendingPerRecipient: 2 });
  try {
    l.store.enqueue(l.seal());
    l.store.enqueue(l.a.seal(l.c.publicPin, { messageId: randomUUID(), sequence: 1, type: "event", createdAt: NOW, expiresAt: NOW + 1000 }, Buffer.from("x")));
    assert.throws(() => l.store.enqueue(l.b.seal(l.a.publicPin, { messageId: randomUUID(), sequence: 1, type: "event", createdAt: NOW, expiresAt: NOW + 1000 }, Buffer.from("x"))), code("quota"));
  } finally { l.close(); }
});

test("ACK exact obsolete receipts do not poison a batch with live work, but foreign/missing still rollback", () => {
  const l = lab();
  try {
    const e1 = l.seal(1), r1 = l.store.enqueue(e1);
    l.setNow(NOW + 50_000); const e2 = l.seal(2), r2 = l.store.enqueue(e2);
    const items = [{ messageId: e1.messageId, receiptId: r1.receiptId }, { messageId: e2.messageId, receiptId: r2.receiptId }];
    l.setNow(NOW + 61_000); assert.equal(l.store.cleanup(1), 1);
    assert.throws(() => l.store.ack(l.b.ack({ requestId: "bad-expired-batch", issuedAt: NOW + 61_000, messages: [...items, { messageId: "missing", receiptId: "wrong" }] })), code("forbidden"));
    assert.equal(l.poll().deliveries.length, 1);
    l.store.ack(l.b.ack({ requestId: "expired-live-batch", issuedAt: NOW + 61_000, messages: items }));
    assert.deepEqual(l.poll().deliveries, []);
    const e3 = l.seal(3), r3 = l.store.enqueue(e3);
    l.store.revokeDevice("sender");
    l.store.ack(l.b.ack({ requestId: "stale-ack", issuedAt: NOW + 61_000, messages: [{ messageId: e3.messageId, receiptId: r3.receiptId }] }));
  } finally { l.close(); }
});

test("control retention reserves ACK drain and expired nonces stay refused after deletion/restart/clock rollback", () => {
  const l = lab({ maximumMarkers: 1, maximumPending: 1 });
  try {
    const e = l.seal(), receipt = l.store.enqueue(e);
    const poll = l.b.poll({ requestId: "old-poll", issuedAt: NOW, after: 0, limit: 1 });
    l.store.poll(poll); assert.throws(() => l.poll(), code("quota"));
    const ack = l.b.ack({ requestId: "reserved-ack", issuedAt: NOW, messages: [{ messageId: e.messageId, receiptId: receipt.receiptId }] });
    l.store.ack(ack);
    l.setNow(NOW + 30_001); assert.deepEqual(l.poll().deliveries, []);
    const raw = new DatabaseSync(l.store.databasePath);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM controls WHERE request_id='old-poll'").get()!.n, 0); raw.close();
    l.restart(); l.setNow(NOW);
    assert.throws(() => l.store.poll(poll), code("expired")); assert.throws(() => l.store.ack(ack), code("expired"));
    const fresh = l.b.poll({ requestId: "floor-fresh", issuedAt: NOW + 30_001, after: 0, limit: 1 });
    // Fresh control exceeds poll capacity until current retained marker also expires; no stale replay succeeds.
    assert.throws(() => l.store.poll(fresh), code("quota"));
  } finally { l.close(); }
});

test("expired messages never resurface after observed time advances and clock rolls back", () => {
  const l = lab();
  try {
    l.store.enqueue(l.seal()); l.setNow(NOW + 60_001);
    assert.deepEqual(l.poll().deliveries, []); l.restart(); l.setNow(NOW);
    const request = l.b.poll({ requestId: "monotonic-poll", issuedAt: NOW + 60_001, after: 0, limit: 100 });
    assert.deepEqual(l.store.poll(request).deliveries, []);
    assert.throws(() => l.poll(), code("expired"));
  } finally { l.close(); }
});

test("input snapshot rejects proxies, getters and spoofed array iteration using safe errors", () => {
  const l = lab();
  try {
    const e = l.seal(); let called = false;
    const getter = { ...e }; Object.defineProperty(getter, "messageId", { enumerable: true, get() { called = true; return e.messageId; } });
    assert.throws(() => l.store.enqueue(getter), code("invalid_input")); assert.equal(called, false);
    assert.throws(() => l.store.enqueue(new Proxy(e, {})), code("invalid_input"));
    assert.throws(() => l.store.registerDevice(new Proxy(l.a.publicPin, {})), code("invalid_input"));
    const items = [{ messageId: "first", receiptId: "receipt" }];
    Object.defineProperty(items, Symbol.iterator, { value: function* () { yield { messageId: "unvalidated", receiptId: "other" }; } });
    assert.throws(() => l.b.ack({ requestId: "spoofed", issuedAt: NOW, messages: items }), code("invalid_input"));
    assert.throws(() => l.store.poll(new Proxy(l.b.poll({ requestId: "proxy-control", issuedAt: NOW, after: 0, limit: 1 }), {})), code("invalid_input"));
  } finally { l.close(); }
});

test("lifetime sentinel excludes two independent live processes and ignores stale v2 PID/host metadata after crash", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "dexter-relay-lock-probe-")), moduleUrl = new URL("../packages/relay/src/index.js", import.meta.url).href;
  const options = { dataDir: root, ownerId: "synthetic-owner", installationId: "synthetic-host" };
  const holderCode = `import {RelayStore} from ${JSON.stringify(moduleUrl)}; const s=new RelayStore(JSON.parse(process.argv[1])); console.log('ready'); setTimeout(()=>{},10000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", holderCode, JSON.stringify(options)], { env: {}, stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  const lines = createInterface({ input: child.stdout! });
  try {
    assert.equal((await lines[Symbol.asyncIterator]().next()).value, "ready");
    const contenderCode = `import {RelayStore} from ${JSON.stringify(moduleUrl)};try{new RelayStore(JSON.parse(process.argv[1]));console.log('unsafe');}catch(e){console.log(e.code);}`;
    const contender = spawnSync(process.execPath, ["--input-type=module", "-e", contenderCode, JSON.stringify(options)], { env: {}, timeout: 3000 });
    assert.equal(contender.status, 0); assert.equal(contender.stdout.toString().trim(), "host_locked");
    assert.throws(() => new RelayStore(options), code("host_locked"));
    child.kill("SIGKILL"); await exited;
    const raw = new DatabaseSync(join(root, "relay.sqlite"));
    raw.prepare("UPDATE lease SET pid=?,hostname='synthetic-new-container-host' WHERE id=1").run(process.pid); raw.close();
    const recovered = new RelayStore(options); recovered.close();
  } finally { lines.close(); child.kill("SIGKILL"); await exited; rmSync(root, { recursive: true, force: true }); }
});

test("legacy migration needs offline opt-in and never overrides live/reused PID or foreign hostname", () => {
  const l = lab();
  try {
    const e = l.seal(), receipt = l.store.enqueue(e);
    l.store.poll(l.b.poll({ requestId: "v1-permanent-nonce", issuedAt: NOW, after: 0, limit: 1 })); l.store.close();
    const raw = new DatabaseSync(l.store.databasePath);
    raw.exec("DROP INDEX control_expiry; DROP INDEX principal_controls; ALTER TABLE controls RENAME TO controls_new; CREATE TABLE controls(request_id TEXT PRIMARY KEY,digest TEXT NOT NULL,kind TEXT NOT NULL,receipt_id TEXT NOT NULL); INSERT INTO controls SELECT request_id,digest,kind,receipt_id FROM controls_new; DROP TABLE controls_new; ALTER TABLE identity DROP COLUMN time_floor; ALTER TABLE receipts DROP COLUMN digest_version; UPDATE identity SET version=1;");
    const legacyHash = createHash("sha256").update(envelopeBytes(e)).update(Buffer.from(e.signature, "base64")).digest("hex");
    raw.prepare("UPDATE receipts SET digest=?").run(legacyHash);
    raw.prepare("INSERT INTO lease VALUES(1,'legacy',?,?)").run(process.pid, hostname());
    assert.throws(() => new RelayStore({ ...l.config, allowOfflineLegacyMigration: true }), code("host_locked"));
    raw.exec("UPDATE lease SET pid=99999999,hostname='foreign-host'");
    assert.throws(() => new RelayStore({ ...l.config, allowOfflineLegacyMigration: true }), code("host_locked"));
    raw.exec("DELETE FROM lease"); raw.close();
    assert.throws(() => new RelayStore(l.config), code("host_locked"));
    const migrated = new RelayStore({ ...l.config, allowOfflineLegacyMigration: true });
    assert.deepEqual(migrated.enqueue(e), receipt);
    assert.equal(migrated.status().legacyControls, 1);
    assert.throws(() => migrated.poll(l.c.poll({ requestId: "v1-permanent-nonce", issuedAt: NOW, after: 0, limit: 1 })), code("conflict"));
    migrated.cleanup(1); assert.equal(migrated.status().legacyControls, 1); migrated.close();
  } finally { l.close(); }
});

test("public golden vectors pin exact signed bytes/AAD and authenticated-body digest", () => {
  const vectors = JSON.parse(readFileSync(join(process.cwd(), "packages/relay/fixtures/public-vectors.json"), "utf8")) as {
    envelope: Envelope; sender: DevicePin; headerHex: string; signedBytesBase64: string; bodyDigest: string;
    ack: AckRequest; controlBytesHex: string;
  };
  assert.equal(Buffer.from(header(vectors.envelope)).toString("hex"), vectors.headerHex);
  assert.equal(envelopeBytes(vectors.envelope).toString("base64"), vectors.signedBytesBase64);
  assert.equal(digest(vectors.envelope), vectors.bodyDigest);
  assert.equal(controlBytes(vectors.ack).toString("hex"), vectors.controlBytesHex);
  assert.equal(verify(null, envelopeBytes(vectors.envelope), createPublicKey({ key: Buffer.from(vectors.sender.signingPublicKey,"base64"), type:"spki",format:"der" }), Buffer.from(vectors.envelope.signature,"base64")), true);
  assert.equal(header(vectors.envelope).includes("/"), true); assert.equal(header(vectors.envelope).includes("\\/"), false);
});

test("Node and Swift CryptoKit agree on signatures, HKDF/AAD and AES-GCM in both directions", { skip: process.platform !== "darwin", timeout: 120_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dexter-relay-swift-interop-")), binary = join(root, "fixture");
  const compiled = spawnSync("/usr/bin/xcrun", ["swiftc", "-swift-version", "6", "-strict-concurrency=complete", "-warnings-as-errors", "-module-cache-path", join(root,"cache"), join(process.cwd(),"packages/relay/fixtures/interop.swift"), "-o", binary], { env: {}, timeout: 90_000 });
  assert.equal(compiled.status, 0, "Synthetic Swift fixture must compile");
  const child = spawn(binary, [], { env: {}, stdio: ["pipe","pipe","ignore"] });
  const exited = new Promise<number | null>(resolve => child.once("close", resolve));
  const lines = createInterface({ input: child.stdout! }), iter = lines[Symbol.asyncIterator]();
  let store: RelayStore | undefined;
  try {
    const swiftPin = JSON.parse((await iter.next()).value!) as DevicePin;
    const node = endpoint("node-peer");
    const payload = Buffer.from("synthetic Node Swift interop only");
    const e = node.seal(swiftPin,{ messageId:"node-to-swift",sequence:1,type:"event",createdAt:NOW,expiresAt:NOW+60_000 },payload);
    store = new RelayStore({dataDir:join(root,"relay"),ownerId:"synthetic-owner",installationId:"synthetic-host",clock:()=>NOW});
    store.registerDevice(node.publicPin); store.registerDevice(swiftPin);
    const receipt = store.enqueue(e);
    child.stdin!.end(JSON.stringify({ envelope:e,nodePin:node.publicPin,ackItem:{ messageId:e.messageId,receiptId:receipt.receiptId } })+"\n");
    const response = JSON.parse((await iter.next()).value!) as { envelope:Envelope; plaintextDigest:string; nodeAADBase64:string; swiftAADBase64:string; repeatedSignaturesEqual:boolean; secondSignature:string; ack:AckRequest; ackSecondSignature:string; controlBytesBase64:string };
    assert.equal(await exited, 0);
    assert.equal(response.plaintextDigest,createHash("sha256").update(payload).digest("hex"));
    assert.equal(response.nodeAADBase64,Buffer.from(header(e)).toString("base64"));
    assert.equal(response.swiftAADBase64,Buffer.from(header(response.envelope)).toString("base64"));
    assert.deepEqual(node.open(response.envelope,swiftPin),payload);
    const equivalent = { ...response.envelope, signature:response.secondSignature };
    assert.equal(response.repeatedSignaturesEqual,response.envelope.signature === response.secondSignature);
    t.diagnostic(JSON.stringify({ cryptoKitRepeatedSignaturesEqual:response.repeatedSignaturesEqual, authenticatedBodyReplay:true }));
    assert.deepEqual(node.open(equivalent,swiftPin),payload);
    assert.deepEqual(store.enqueue(equivalent),store.enqueue(response.envelope));
    assert.throws(()=>store!.enqueue({...equivalent,signature:Buffer.alloc(64).toString("base64")}),code("forbidden"));
    assert.equal(controlBytes(response.ack).toString("base64"),response.controlBytesBase64);
    const acked = store.ack(response.ack);
    assert.deepEqual(store.ack({...response.ack,signature:response.ackSecondSignature}),acked);
    assert.throws(()=>store!.ack({...response.ack,signature:Buffer.alloc(64).toString("base64")}),code("forbidden"));
  } finally { lines.close(); child.kill("SIGKILL"); await exited; store?.close(); rmSync(root,{ recursive:true,force:true }); }
});

test("a control nonce stays spent throughout the signed window, including pruning one second later", () => {
  const l = lab();
  try {
    const request = l.b.poll({ requestId: "within-window", issuedAt: NOW, after: 0, limit: 1 });
    l.store.poll(request);
    l.setNow(NOW + 1000); l.store.cleanup(1);
    assert.throws(() => l.store.poll(request), code("conflict"));
    l.restart(); assert.throws(() => l.store.poll(request), code("conflict"));
    l.setNow(NOW + 30_000); l.store.cleanup(1);
    assert.throws(() => l.store.poll(request), code("conflict"));
    l.setNow(NOW + 30_001); l.store.cleanup(1);
    assert.throws(() => l.store.poll(request), code("expired"));
  } finally { l.close(); }
});

test("rejected authenticated-shape operations still commit the observed time floor", () => {
  const l = lab();
  try {
    l.store.enqueue(l.seal());
    l.setNow(NOW + 60_001);
    const invalid = { ...l.b.poll({ requestId: "invalid-at-future", issuedAt: NOW + 60_001, after: 0, limit: 1 }), signature: Buffer.alloc(64).toString("base64") };
    assert.throws(() => l.store.poll(invalid), code("forbidden"));
    l.setNow(NOW);
    assert.throws(() => l.poll(), code("expired"));
    l.restart(); assert.throws(() => l.poll(), code("expired"));
    assert.deepEqual(l.store.poll(l.b.poll({ requestId: "valid-at-floor", issuedAt: NOW + 60_001, after: 0, limit: 1 })).deliveries, []);
  } finally { l.close(); }
});

test("a current recipient generation cannot acknowledge an earlier generation's exact receipt", () => {
  const l = lab();
  try {
    const old = l.seal(), receipt = l.store.enqueue(old);
    const b2 = endpoint("recipient", 2); l.store.registerDevice(b2.publicPin);
    const ack = b2.ack({ requestId: "new-generation-old-receipt", issuedAt: NOW, messages: [{ messageId: old.messageId, receiptId: receipt.receiptId }] });
    assert.throws(() => l.store.ack(ack), code("forbidden"));
    l.restart(); assert.throws(() => l.store.ack(ack), code("forbidden"));
    const fresh = l.a.seal(b2.publicPin, { messageId: "fresh-generation-receipt", sequence: 1, type: "event", createdAt: NOW, expiresAt: NOW + 1000 }, Buffer.from("synthetic"));
    const freshReceipt = l.store.enqueue(fresh);
    l.store.ack(b2.ack({ requestId: "new-generation-fresh-receipt", issuedAt: NOW, messages: [{ messageId: fresh.messageId, receiptId: freshReceipt.receiptId }] }));
    assert.deepEqual(l.poll(b2).deliveries, []);
  } finally { l.close(); }
});

test("a forward clock jump refuses before floor or pruning and normal wall time works again", () => {
  const l = lab();
  try {
    const e = l.seal(); l.store.enqueue(e);
    const request = l.b.poll({ requestId: "before-jump", issuedAt: NOW, after: 0, limit: 1 }); l.store.poll(request);
    const before = l.store.status();
    l.setNow(NOW + 365 * 86_400_000);
    assert.throws(() => l.store.cleanup(1), code("clock_untrusted"));
    assert.deepEqual(l.store.status(), before);
    l.setNow(NOW + 1000);
    assert.throws(() => l.store.poll(request), code("conflict"));
    assert.equal(l.poll().deliveries[0]!.envelope.messageId, e.messageId);
    l.restart(); assert.equal(l.poll().deliveries.length, 1);
  } finally { l.close(); }
});

test("real elapsed monotonic time permits long progress; downtime confirmation is exact CAS and forward only", () => {
  let elapsed = 0;
  const l = lab({ monotonicClock: () => elapsed });
  try {
    elapsed += 365 * 86_400_000; l.setNow(NOW + elapsed);
    assert.equal(l.store.cleanup(1), 0);
    assert.equal(l.store.status().timeFloor, NOW + elapsed);
    l.restart();
    const before = l.store.status().timeFloor;
    l.setNow(before + 86_400_000);
    assert.throws(() => l.store.cleanup(1), code("clock_untrusted"));
    assert.throws(() => l.store.acknowledgeClockAdvance(before - 1, before + 86_400_000), code("conflict"));
    assert.throws(() => l.store.acknowledgeClockAdvance(before, before + 86_400_001), code("conflict"));
    assert.equal(l.store.status().timeFloor, before);
    l.store.acknowledgeClockAdvance(before, before + 86_400_000);
    assert.equal(l.store.cleanup(1), 0);
    assert.throws(() => l.store.acknowledgeClockAdvance(before, before + 86_400_000), code("conflict"));
    l.setNow(before - 1);
    assert.throws(() => l.store.acknowledgeClockAdvance(before + 86_400_000, before - 1), code("invalid_input"));
    assert.equal(l.store.status().timeFloor, before + 86_400_000);
  } finally { l.close(); }
});

test("64 identity slots isolate nonce and ACK quota while keeping global controls and message caps bounded", () => {
  const l = lab({ maximumMarkers: 64, maximumPending: 64, maximumPendingPerRecipient: 1 });
  try {
    const peers = [l.a, l.b, l.c];
    for (let i = 3; i < 64; i++) { const peer = endpoint(`peer_${i}`); peers.push(peer); l.store.registerDevice(peer.publicPin); }
    assert.throws(() => l.store.registerDevice(endpoint("sixty_fifth").publicPin), code("quota"));
    assert.deepEqual(l.store.controlPolicy(), { devices: 64, pollPerGeneration: 1, ackReservePerGeneration: 1, globalControls: 128 });
    for (const [i, peer] of peers.entries()) {
      const sender = peers[(i + 1) % peers.length]!;
      const e = sender.seal(peer.publicPin, { messageId: `own_${peer.publicPin.deviceId}`, sequence: 1, type: "event", createdAt: NOW, expiresAt: NOW + 1000 }, Buffer.from("synthetic"));
      const receipt = l.store.enqueue(e);
      l.store.poll(peer.poll({ requestId: "same-poll-id", issuedAt: NOW, after: 0, limit: 1 }));
      const ack = peer.ack({ requestId: "same-ack-id", issuedAt: NOW, messages: [{ messageId: e.messageId, receiptId: receipt.receiptId }] });
      const result = l.store.ack(ack); assert.deepEqual(l.store.ack(ack), result);
      assert.throws(() => l.store.ack(peer.ack({ requestId: "malicious-fresh-nonce", issuedAt: NOW, messages: ack.messages })), code("quota"));
    }
    assert.equal(l.store.status().controls, 128); assert.equal(l.store.status().pending, 0);
    assert.throws(() => l.store.enqueue(l.seal()), code("quota")); // Controls policy never expands message lifetime cap.
  } finally { l.close(); }
});

test("small configurations reserve each peer and retired-generation nonce cannot block its new generation", () => {
  const l = lab({ maximumMarkers: 1, maximumPending: 1 });
  try {
    assert.equal(l.store.controlPolicy().globalControls, 128);
    l.store.poll(l.c.poll({ requestId: "shared", issuedAt: NOW, after: 0, limit: 1 }));
    assert.throws(() => l.store.poll(l.c.poll({ requestId: "exhausted-own-slot", issuedAt: NOW, after: 0, limit: 1 })), code("quota"));
    const e = l.seal(), receipt = l.store.enqueue(e);
    l.store.poll(l.b.poll({ requestId: "shared", issuedAt: NOW, after: 0, limit: 1 }));
    l.store.ack(l.b.ack({ requestId: "reserved", issuedAt: NOW, messages: [{ messageId: e.messageId, receiptId: receipt.receiptId }] }));
    const c2 = endpoint("third", 2); l.store.registerDevice(c2.publicPin);
    l.store.poll(c2.poll({ requestId: "shared", issuedAt: NOW, after: 0, limit: 1 }));
    assert.throws(() => l.store.poll(l.c.poll({ requestId: "shared", issuedAt: NOW, after: 0, limit: 1 })), code("forbidden"));
  } finally { l.close(); }
});

test("legacy v2 global nonces remain spent during their window and prune only after replay is expired", () => {
  const l = lab();
  try {
    const old = l.b.poll({ requestId: "legacy-global", issuedAt: NOW, after: 0, limit: 1 }); l.store.poll(old); l.store.close();
    const raw = new DatabaseSync(l.store.databasePath);
    raw.exec("DROP INDEX control_expiry; DROP INDEX principal_controls; ALTER TABLE controls RENAME TO controls_new; CREATE TABLE controls(request_id TEXT PRIMARY KEY,digest TEXT NOT NULL,kind TEXT NOT NULL,receipt_id TEXT NOT NULL,issued_at INTEGER NOT NULL); INSERT INTO controls SELECT request_id,digest,kind,receipt_id,issued_at FROM controls_new; DROP TABLE controls_new; UPDATE identity SET version=2;"); raw.close();
    l.restart(); assert.equal(l.store.status().legacyControls, 1);
    assert.throws(() => l.store.poll(old), code("conflict"));
    assert.throws(() => l.store.poll(l.c.poll({ requestId: "legacy-global", issuedAt: NOW, after: 0, limit: 1 })), code("conflict"));
    l.setNow(NOW + 30_001); l.store.cleanup(1);
    assert.throws(() => l.store.poll(old), code("expired"));
    l.store.poll(l.c.poll({ requestId: "legacy-global", issuedAt: NOW + 30_001, after: 0, limit: 1 }));
  } finally { l.close(); }
});

test("owner compaction only retires unauthenticatable generations and never resets live dedup or cursors", () => {
  let elapsed = 0;
  const l = lab({ maximumMarkers: 2, monotonicClock: () => elapsed });
  try {
    const old = l.seal(1, "reused-after-rotation"), oldReceipt = l.store.enqueue(old);
    const live = l.c.seal(l.b.publicPin, { messageId: "keep-live", sequence: 1, type: "event", createdAt: NOW, expiresAt: NOW + 1000 }, Buffer.from("synthetic"));
    const liveReceipt = l.store.enqueue(live);
    l.store.ack(l.b.ack({ requestId: "ack-live", issuedAt: NOW, messages: [{ messageId: live.messageId, receiptId: liveReceipt.receiptId }] }));
    assert.equal(l.store.compactRetiredGenerations(1), 0); // ACK/expiry alone cannot erase dedup.
    const a2 = endpoint("sender", 2); l.store.registerDevice(a2.publicPin);
    assert.equal(l.store.compactRetiredGenerations(1), 0); // Current recipient keeps its exact receipt during ACK retention.
    elapsed = 2 * DAY; l.setNow(NOW + elapsed);
    assert.equal(l.store.compactRetiredGenerations(1), 1);
    assert.deepEqual(l.store.enqueue(live), liveReceipt);
    assert.throws(() => l.store.enqueue(old), code("forbidden"));
    const fresh = a2.seal(l.b.publicPin, { messageId: old.messageId, sequence: 1, type: "event", createdAt: NOW + elapsed, expiresAt: NOW + elapsed + 1000 }, Buffer.from("synthetic-new-generation"));
    const freshReceipt = l.store.enqueue(fresh); assert.ok(freshReceipt.cursor > liveReceipt.cursor); assert.notEqual(freshReceipt.receiptId, oldReceipt.receiptId);
    assert.equal(l.store.compactRetiredGenerations(1000), 0);
    l.restart(); assert.deepEqual(l.store.enqueue(live), liveReceipt); assert.deepEqual(l.store.enqueue(fresh), freshReceipt);
    assert.throws(() => l.store.enqueue(old), code("forbidden"));
    assert.throws(() => l.store.compactRetiredGenerations(1001), code("invalid_input"));
  } finally { l.close(); }
});

test("expired control pruning is bounded to 1000 rows per operation", () => {
  const l = lab();
  try {
    for (let i = 0; i < 1005; i++) l.store.poll(l.b.poll({ requestId: `bounded_${i}`, issuedAt: NOW, after: 0, limit: 1 }));
    l.setNow(NOW + 30_001); l.store.cleanup(1);
    assert.equal(l.store.status().controls, 5);
    l.store.cleanup(1); assert.equal(l.store.status().controls, 0);
  } finally { l.close(); }
});

test("bounded retirement frees exhausted markers only through explicit owner pin rotation", () => {
  let elapsed = 0;
  const l = lab({ maximumMarkers: 3, monotonicClock: () => elapsed });
  try {
    const messages = [l.seal(1), l.seal(2), l.seal(3)]; const cursors = messages.map(e => l.store.enqueue(e).cursor);
    assert.throws(() => l.store.enqueue(l.seal(4)), code("quota"));
    assert.equal(l.store.compactRetiredGenerations(2), 0);
    const sender2 = endpoint("sender", 2); l.store.registerDevice(sender2.publicPin);
    assert.equal(l.store.compactRetiredGenerations(2), 0);
    elapsed = 2 * DAY; l.setNow(NOW + elapsed);
    assert.equal(l.store.compactRetiredGenerations(2), 2);
    assert.equal(l.store.status().messages, 1); assert.equal(l.store.status().pending, 1);
    assert.equal(l.store.compactRetiredGenerations(2), 1);
    const fresh = sender2.seal(l.b.publicPin, { messageId: messages[0]!.messageId, sequence: 1, type: "event", createdAt: NOW + elapsed, expiresAt: NOW + elapsed + 1000 }, Buffer.from("synthetic"));
    assert.ok(l.store.enqueue(fresh).cursor > Math.max(...cursors));
    l.restart(); for (const old of messages) assert.throws(() => l.store.enqueue(old), code("forbidden"));
    assert.equal(l.store.status().messages, 1);
  } finally { l.close(); }
});

test("a compacted global ID can name a different current authenticated stream, never its old receipt or cursor", () => {
  let elapsed = 0;
  const l = lab({ maximumMarkers: 2, monotonicClock: () => elapsed });
  try {
    const old = l.seal(1, "retired-global-id"), oldReceipt = l.store.enqueue(old);
    const early = l.c.seal(l.b.publicPin, { messageId: old.messageId, sequence: 1, type: "event", createdAt: NOW, expiresAt: NOW + 1000 }, Buffer.from("synthetic-different-peer"));
    assert.throws(() => l.store.enqueue(early), code("conflict")); // Still-active global marker owns the ID.
    l.store.revokeDevice(l.a.publicPin.deviceId);
    assert.equal(l.store.compactRetiredGenerations(1), 0);
    assert.throws(() => l.store.enqueue(early), code("conflict"));
    elapsed = 2 * DAY; l.setNow(NOW + elapsed);
    assert.equal(l.store.compactRetiredGenerations(1), 1);
    const other = l.c.seal(l.b.publicPin, { messageId: old.messageId, sequence: 1, type: "event", createdAt: NOW + elapsed, expiresAt: NOW + elapsed + 1000 }, Buffer.from("synthetic-different-peer"));
    const receipt = l.store.enqueue(other);
    assert.ok(receipt.cursor > oldReceipt.cursor); assert.notEqual(receipt.receiptId, oldReceipt.receiptId);
    assert.throws(() => l.store.enqueue(old), code("forbidden"));
    assert.throws(() => l.store.ack(l.b.ack({ requestId: "wrong-retired-receipt", issuedAt: NOW + elapsed, messages: [{ messageId: other.messageId, receiptId: oldReceipt.receiptId }] })), code("forbidden"));
    l.restart(); assert.deepEqual(l.store.enqueue(other), receipt); assert.throws(() => l.store.enqueue(old), code("forbidden"));
    assert.equal(l.poll().deliveries[0]!.receiptId, receipt.receiptId);
  } finally { l.close(); }
});

test("a store reopened with wall time already ahead quarantines before any write, at the exact 300000 ms boundary", () => {
  const l = lab({ monotonicClock: () => 0 });
  try {
    const e = l.a.seal(l.b.publicPin, { messageId: "boot-quarantine", sequence: 1, type: "event", createdAt: NOW, expiresAt: NOW + 600_000 }, Buffer.from("synthetic"));
    l.store.enqueue(e);
    const floor = l.store.status().timeFloor; assert.equal(floor, NOW);
    const reopenAt = (time: number) => { l.store.close(); l.setNow(time); l.restart(); }; // Stopped process, wall clock moves, then boot.
    reopenAt(NOW + 365 * DAY); // Boot anchor must be the persisted floor, not the advanced boot clock.
    const quarantined = l.store.status();
    assert.throws(() => l.poll(), code("clock_untrusted"));
    assert.throws(() => l.store.enqueue(l.seal(2)), code("clock_untrusted"));
    assert.throws(() => l.store.revokeDevice(l.c.publicPin.deviceId), code("clock_untrusted")); // Revocation waits for the CAS.
    assert.deepEqual(l.store.status(), quarantined); assert.equal(quarantined.timeFloor, floor);
    assert.throws(() => l.store.close(), code("clock_untrusted")); // Close still frees its handles and sentinel.
    reopenAt(NOW + 300_001);
    assert.throws(() => l.store.cleanup(1), code("clock_untrusted"));
    assert.equal(l.store.status().timeFloor, floor);
    l.setNow(NOW + 300_000);
    assert.equal(l.poll().deliveries[0]!.envelope.messageId, e.messageId); // Boundary itself is accepted; nothing expired permanently.
    assert.equal(l.store.status().timeFloor, NOW + 300_000);
    l.setNow(NOW + 300_001); assert.throws(() => l.store.cleanup(1), code("clock_untrusted")); // Same session: anchor did not ratchet.
    l.setNow(NOW + 300_000); reopenAt(NOW + 365 * DAY);
    l.store.acknowledgeClockAdvance(NOW + 300_000, NOW + 365 * DAY);
    assert.equal(l.store.cleanup(1), 1); assert.deepEqual(l.poll().deliveries, []);
  } finally { l.close(); }
});

test("compaction keeps a current recipient's receipt through ACK retention, then a stale batch fails closed whole", () => {
  let elapsed = 0;
  const l = lab({ monotonicClock: () => elapsed });
  try {
    const old = l.seal(1, "retired-sender-old"), oldReceipt = l.store.enqueue(old);
    const live = l.c.seal(l.b.publicPin, { messageId: "current-sender-live", sequence: 1, type: "event", createdAt: NOW, expiresAt: NOW + 60_000 }, Buffer.from("synthetic"));
    const liveReceipt = l.store.enqueue(live);
    assert.equal(l.poll().deliveries.length, 2);
    const a2 = endpoint("sender", 2); l.store.registerDevice(a2.publicPin);
    const before = l.store.status();
    assert.equal(l.store.compactRetiredGenerations(1000), 0); // Deterministic repeated no-op inside retention.
    assert.equal(l.store.compactRetiredGenerations(1000), 0); assert.deepEqual(l.store.status(), before);
    const batch = [{ messageId: old.messageId, receiptId: oldReceipt.receiptId }, { messageId: live.messageId, receiptId: liveReceipt.receiptId }];
    assert.throws(() => l.store.ack(l.c.ack({ requestId: "foreign-retained", issuedAt: NOW, messages: batch })), code("forbidden"));
    const b2 = endpoint("recipient", 2);
    l.store.ack(l.b.ack({ requestId: "old-plus-live", issuedAt: NOW, messages: batch }));
    assert.deepEqual(l.poll().deliveries, []);
    assert.throws(() => l.store.enqueue(old), code("forbidden"));

    // One millisecond before the retention edge the receipt survives; at expiry + retention it becomes eligible.
    elapsed = 60_000 + DAY - 1; l.setNow(NOW + elapsed);
    assert.equal(l.store.compactRetiredGenerations(1000), 0);
    const late = l.c.seal(l.b.publicPin, { messageId: "current-sender-late", sequence: 2, type: "event", createdAt: NOW + elapsed, expiresAt: NOW + elapsed + 60_000 }, Buffer.from("synthetic"));
    const lateReceipt = l.store.enqueue(late);
    elapsed += 1; l.setNow(NOW + elapsed);
    assert.equal(l.store.compactRetiredGenerations(1000), 1);
    assert.equal(l.store.compactRetiredGenerations(1000), 0);
    const stale = [{ messageId: old.messageId, receiptId: oldReceipt.receiptId }, { messageId: late.messageId, receiptId: lateReceipt.receiptId }];
    assert.throws(() => l.store.ack(l.b.ack({ requestId: "expired-plus-live", issuedAt: NOW + elapsed, messages: stale })), code("forbidden"));
    assert.equal(l.poll().deliveries[0]!.receiptId, lateReceipt.receiptId); // Whole batch rolled back; live work stays queued.
    l.store.ack(l.b.ack({ requestId: "split-live", issuedAt: NOW + elapsed, messages: [stale[1]!] }));
    assert.deepEqual(l.poll().deliveries, []);
    assert.throws(() => l.store.enqueue(old), code("forbidden"));

    // Recipient retirement is unaffected: compacted at once, and the new generation never reads or ACKs it.
    const toRetire = l.c.seal(l.b.publicPin, { messageId: "recipient-retired", sequence: 3, type: "event", createdAt: NOW + elapsed, expiresAt: NOW + elapsed + 60_000 }, Buffer.from("synthetic"));
    const retiredReceipt = l.store.enqueue(toRetire);
    l.store.registerDevice(b2.publicPin);
    assert.equal(l.store.compactRetiredGenerations(1000), 3); // live + late (acked) and recipient-retired, all addressed to b gen 1.
    assert.deepEqual(l.poll(b2).deliveries, []);
    assert.throws(() => l.store.ack(b2.ack({ requestId: "new-gen-retired", issuedAt: NOW + elapsed, messages: [{ messageId: toRetire.messageId, receiptId: retiredReceipt.receiptId }] })), code("forbidden"));
    l.restart(); assert.throws(() => l.store.enqueue(toRetire), code("forbidden"));
  } finally { l.close(); }
});
