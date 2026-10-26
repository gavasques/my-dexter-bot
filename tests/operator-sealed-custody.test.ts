import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto, { createHash, randomBytes, verify } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import { inspect } from "node:util";
import type { TLSSocket } from "node:tls";
import { HostStore } from "@dexter/hub";
import { captureInspectionSnapshot, requireOwnerSigner, requireSnapshotKey, restoreForInspection } from "@dexter/operations";
import { RelayEndpoint } from "../packages/relay/src/endpoint.js";
import { header } from "@dexter/relay/protocol";
import { custodySnapshot, StableRelayOpener } from "@dexter/relay-host";
import { OperatorSealedCustody, readOperatorPrivateFd, SealedCustodyError, type CustodyBinding } from "../packages/cli/src/operator-sealed-custody.js";
import { openOperatorSealedHost, runOperatorSealedOperations } from "../packages/cli/src/operator-sealed-host.js";
import { runOperatorCustodyCli } from "../packages/cli/src/operator-custody-bin.js";
import { planHostStartup } from "../packages/cli/src/host-startup.js";
import { memoryTLS } from "./fixtures/relay-host-lab.js";
// Canonical test-owned base: never an author/reviewer lab constant, and never cleanup a shared temp directory.
const TEST_BASE = mkdtempSync(join(realpathSync(tmpdir()), "dsc-"));
chmodSync(TEST_BASE, 0o700);
after(() => rmSync(TEST_BASE, { recursive: true, force: true }));
function fixture(t: TestContext, input?: CustodyBinding) {
  const dir = mkdtempSync(join(TEST_BASE, "synthetic-")); chmodSync(dir, 0o700); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const b = input ?? { installationId: "installation", ownerId: "owner", deviceId: "host", generation: 1, keyId: "hostkey" };
  const password = randomBytes(32), tls = memoryTLS(), file = join(dir, "keys", "host.sealed");
  const custody = OperatorSealedCustody.create(file, b, password, tls); t.after(async () => { await custody.close(); password.fill(0); });
  return { dir, b, password, tls, file, custody };
}
const sealedCode = (code: string) => (e: unknown) => e instanceof SealedCustodyError && e.code === code;
test("create-only private publication starts locked and restart keeps authenticated identity", async t => {
  const f = fixture(t); assert.equal(statSync(join(f.dir, "keys")).mode & 0o777, 0o700); assert.equal(statSync(f.file).mode & 0o777, 0o600);
  assert.equal(f.custody.toJSON().unlocked, false); assert.throws(() => f.custody.operations(), sealedCode("locked"));
  const before = readFileSync(f.file); assert.throws(() => OperatorSealedCustody.create(f.file, f.b, f.password, f.tls), sealedCode("conflict")); assert.deepEqual(readFileSync(f.file), before);
  assert.deepEqual(readdirSync(join(f.dir, "keys")), ["host.sealed"]);
  f.custody.unlock(f.password); const description = f.custody.toJSON().identity; await f.custody.close();
  const restarted = new OperatorSealedCustody(f.file, f.b); t.after(() => restarted.close()); assert.throws(() => restarted.relay(), sealedCode("locked")); restarted.unlock(f.password);
  assert.deepEqual(restarted.toJSON().identity, description); assert.deepEqual(readFileSync(f.file), before);
});
test("wrong passphrase, altered ciphertext/tag/nonce/header and foreign binding refuse without unlock/write", async t => {
  const f = fixture(t), original = readFileSync(f.file);
  assert.throws(() => f.custody.unlock(randomBytes(32)), sealedCode("authentication_failed")); assert.equal(f.custody.toJSON().unlocked, false);
  for (const offset of [60, original.length - 17, original.length - 1]) {
    const changed = Buffer.from(original); changed[offset] = changed[offset]! ^ 1; writeFileSync(f.file, changed); assert.throws(() => f.custody.unlock(f.password), sealedCode("authentication_failed")); assert.equal(f.custody.toJSON().unlocked, false); assert.deepEqual(readFileSync(f.file), changed);
  }
  const changed = Buffer.from(original); const index = changed.indexOf(Buffer.from('"tlsFingerprint":"')) + '"tlsFingerprint":"'.length;
  changed[index] = changed[index] === 97 ? 98 : 97; writeFileSync(f.file, changed); assert.throws(() => f.custody.unlock(f.password), sealedCode("authentication_failed"));
  writeFileSync(f.file, original); const other = new OperatorSealedCustody(f.file, { ...f.b, ownerId: "foreign" }); assert.throws(() => other.unlock(f.password), sealedCode("authentication_failed")); await other.close();
});
test("malicious KDF/length/oversize fails before native scrypt", t => {
  const f = fixture(t), original = readFileSync(f.file), native = crypto.scryptSync; let calls = 0;
  crypto.scryptSync = (() => { calls++; throw new Error("test KDF must not execute"); }) as typeof crypto.scryptSync; syncBuiltinESMExports();
  try {
    for (const offset of [8, 12, 16, 20, 24]) { const altered = Buffer.from(original); altered.writeUInt32BE(0xffffffff, offset); writeFileSync(f.file, altered); assert.throws(() => f.custody.unlock(f.password), sealedCode("invalid_input")); }
    writeFileSync(f.file, Buffer.alloc(65537)); assert.throws(() => f.custody.unlock(f.password), sealedCode("invalid_input")); assert.equal(calls, 0);
  } finally { crypto.scryptSync = native; syncBuiltinESMExports(); }
});
test("unsafe modes, symlink file/parent, missing file never repair or regenerate", async t => {
  const f = fixture(t); chmodSync(f.file, 0o644); assert.throws(() => f.custody.unlock(f.password), sealedCode("private_path_required")); assert.equal(statSync(f.file).mode & 0o777, 0o644); chmodSync(f.file, 0o600);
  chmodSync(join(f.dir, "keys"), 0o755); assert.throws(() => f.custody.unlock(f.password), sealedCode("private_path_required")); chmodSync(join(f.dir, "keys"), 0o700);
  const linked = join(f.dir, "keys", "linked"); symlinkSync(f.file, linked); const other = new OperatorSealedCustody(linked, f.b); assert.throws(() => other.unlock(f.password)); await other.close();
  const parent = join(f.dir, "link"); symlinkSync(join(f.dir, "keys"), parent); assert.throws(() => OperatorSealedCustody.create(join(parent, "other"), f.b, f.password, f.tls)); assert.equal(existsSync(join(f.dir, "keys", "other")), false);
  const missing = join(f.dir, "keys", "missing"); const absent = new OperatorSealedCustody(missing, f.b); assert.throws(() => absent.unlock(f.password)); assert.equal(existsSync(missing), false); await absent.close();
});
test("input proxies/accessors/control fields refuse without executing hooks", t => {
  const f = fixture(t); let calls = 0;
  for (const input of [new Proxy(f.b, { get() { calls++; throw Error(); } }), { ...f.b, get installationId() { calls++; return "x"; } }, { ...f.b, toJSON() { calls++; return {}; } }]) assert.throws(() => new OperatorSealedCustody(f.file, input));
  assert.equal(calls, 0); assert.throws(() => OperatorSealedCustody.create(join(f.dir, "keys", "weak"), f.b, Buffer.alloc(15), f.tls), sealedCode("invalid_input"));
});
test("real owner signatures and retained snapshot/signer/relay capabilities fail after lock and re-unlock", async t => {
  const f = fixture(t); f.custody.unlock(f.password); const ops = f.custody.operations(), signer = requireOwnerSigner(ops, "sign_receipt"), key = requireSnapshotKey(ops, "capture"), relay = f.custody.relay();
  const message = Buffer.from("synthetic activation"); assert.equal(verify(null, message, signer.publicKey, signer.sign(message)), true);
  await f.custody.lock(); assert.throws(() => signer.sign(message), sealedCode("locked")); assert.throws(() => key.use(() => 1), sealedCode("locked")); assert.throws(() => ops.ownerSigner("sign_receipt"), sealedCode("locked")); await assert.rejects(relay.sign(message), sealedCode("locked")); assert.equal(relay.current(), false);
  f.custody.unlock(f.password); assert.throws(() => signer.sign(message), sealedCode("locked")); await assert.rejects(relay.sign(message), sealedCode("locked"));
  const fresh = f.custody.operations(); assert.equal(verify(null, message, requireOwnerSigner(fresh, "sign_receipt").publicKey, requireOwnerSigner(fresh, "sign_receipt").sign(message)), true);
  await f.custody.close(); assert.throws(() => f.custody.unlock(f.password), sealedCode("locked"));
});
test("lock cuts future admission and drains already-admitted sign before releasing material", async t => {
  const f = fixture(t); f.custody.unlock(f.password); const r = f.custody.relay();
  const started = r.sign(Buffer.from("admitted")); const lock = f.custody.lock(); assert.equal(r.current(), false); await assert.rejects(r.sign(Buffer.from("future")), sealedCode("locked"));
  assert.equal((await started).length, 64); await lock; assert.equal(f.custody.toJSON().unlocked, false);
});
test("sealed export/rekey authenticated reimport preserves all pins and original file; locked export refuses", async t => {
  const f = fixture(t), target = join(f.dir, "keys", "backup.sealed"), newer = randomBytes(32); t.after(() => newer.fill(0)); const original = readFileSync(f.file);
  assert.throws(() => f.custody.exportSealed(target, newer), sealedCode("locked")); assert.equal(existsSync(target), false);
  f.custody.unlock(f.password); const description = f.custody.toJSON().identity; f.custody.exportSealed(target, newer); assert.deepEqual(readFileSync(f.file), original); assert.notDeepEqual(readFileSync(target), original);
  assert.throws(() => f.custody.exportSealed(target, newer), sealedCode("conflict")); const imported = new OperatorSealedCustody(target, f.b); t.after(() => imported.close()); assert.throws(() => imported.unlock(f.password), sealedCode("authentication_failed")); imported.unlock(newer); assert.deepEqual(imported.toJSON().identity, description);
  assert.deepEqual(readdirSync(f.dir), ["keys"]); // no DB, grants, coordinator or canonical writer created by export/reimport
});
test("real relay AEAD decrypt and StableRelayOpener signing verify; poisoned tag refuses", async t => {
  const f = fixture(t); f.custody.unlock(f.password); const provider = f.custody.relay(), opener = new StableRelayOpener(provider, () => undefined), sender = new RelayEndpoint({ ...f.b, deviceId: "sender", keyId: "senderkey" });
  const now = Date.now(), message = sender.seal(provider.publicPin, { messageId: "m1", sequence: 1, type: "command", createdAt: now, expiresAt: now + 5000 }, Buffer.from("synthetic relay"));
  assert.equal((await opener.open(message, sender.publicPin)).toString(), "synthetic relay"); const poll = await opener.poll({ requestId: "poll1", issuedAt: now, after: 0, limit: 1 }); assert.equal(poll.signature.length, 88);
  await assert.rejects(provider.decrypt({ installationId: f.b.installationId, ephemeralPublicKey: message.ephemeralPublicKey, nonce: message.nonce, ciphertext: message.ciphertext, tag: Buffer.alloc(16).toString("base64"), aad: header(message) }), sealedCode("authentication_failed")); await opener.close();
});
test("contract production accepts honest software kind only and keeps lab/nonexportable modes distinct", async t => {
  const dir = mkdtempSync(join(TEST_BASE, "canonical-")); t.after(() => rmSync(dir, { recursive: true, force: true })); const data = join(dir, "host"), store = new HostStore({ dataDir: data }); const b = { installationId: store.hostId, ownerId: store.ownerId, deviceId: "host", generation: 1, keyId: "hostkey" }; store.close();
  const f = fixture(t, b); f.custody.unlock(f.password); const custody = f.custody.relay(); custodySnapshot(custody, "operator-sealed-exportable", custody.publicPin);
  assert.throws(() => custodySnapshot(custody, "persistent", custody.publicPin)); assert.throws(() => custodySnapshot(custody, "laboratory-memory", custody.publicPin));
  const options = { dataDir: data, enableEngines: true, enableRelay: true, appClients: { identity: f.custody.tlsIdentity() } };
  const relay = { recipient: custody.publicPin, custody, custodyMode: "operator-sealed-exportable" as const, transport: { async poll() { return { deliveries: [], cursor: 0 }; }, async ack() { return { receiptId: "synthetic" }; }, async close() {} }, transportOwnership: "borrowed" as const, deployment: { maximumPendingPerRecipient: 8 } };
  const plan = planHostStartup({ route: "production", options, providers: { relay } }); assert.equal(typeof plan.description.relay, "object");
  assert.throws(() => planHostStartup({ route: "production", options, providers: { relay: { ...relay, custodyMode: "persistent" } } }));
  assert.throws(() => planHostStartup({ route: "production", options, providers: { relay: { ...relay, custody: { ...custody, kind: "laboratory_memory_only" } } } }));
  await f.custody.lock(); assert.equal(custody.current(), false);
});
test("normal local host uses sealed TLS and holds single writer; shutdown closes custody then restart locked", async t => {
  const dir = mkdtempSync(join(TEST_BASE, "host-lifecycle-")); t.after(() => rmSync(dir, { recursive: true, force: true })); const data = join(dir, "host"), store = new HostStore({ dataDir: data }); const b = { installationId: store.hostId, ownerId: store.ownerId, deviceId: "host", generation: 1, keyId: "hostkey" }; store.close();
  const f = fixture(t, b); f.custody.unlock(f.password); const composed = openOperatorSealedHost(f.custody, { route: "production", options: { dataDir: data, appClients: { identity: f.tls } } });
  assert.throws(() => new HostStore({ dataDir: data })); await composed.shutdown(); assert.equal(f.custody.toJSON().unlocked, false); const reopened = new HostStore({ dataDir: data }); assert.equal(reopened.hostId, b.installationId); reopened.close();
  const restart = new OperatorSealedCustody(f.file, b); assert.throws(() => openOperatorSealedHost(restart, { route: "production", options: { dataDir: data } }), sealedCode("locked")); restart.unlock(f.password); assert.equal(restart.tlsIdentity().fingerprint, f.tls.fingerprint); await restart.close();
});
test("actual TLS1.3 loopback uses sealed key and stable certificate fingerprint", async t => {
  const f = fixture(t); f.custody.unlock(f.password); const tls = f.custody.tlsIdentity(); const server = createServer({ cert: tls.certPem, key: tls.keyPem, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }, (_r, response) => response.end("synthetic tls"));
  t.after(() => new Promise<void>(r => server.close(() => r()))); await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); const address = server.address(); assert.ok(address && typeof address === "object");
  const body = await new Promise<string>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: address.port, ca: tls.certPem, minVersion: "TLSv1.3", maxVersion: "TLSv1.3", agent: false, timeout: 2000 }, response => { const chunks: Buffer[] = []; response.on("data", b => chunks.push(Buffer.from(b))); response.on("end", () => resolve(Buffer.concat(chunks).toString())); });
    req.on("socket", socket => socket.on("secureConnect", () => { assert.equal(createHash("sha256").update((socket as TLSSocket).getPeerCertificate().raw).digest("hex"), tls.fingerprint); })); req.on("error", reject); req.on("timeout", () => req.destroy(Error("synthetic deadline"))); req.end();
  }); assert.equal(body, "synthetic tls");
});
test("capture and inspection use real custody adapters and retain quarantined writer semantics", t => {
  const f = fixture(t); f.custody.unlock(f.password); const store = new HostStore({ dataDir: join(f.dir, "data") }); t.after(() => store.close());
  const bot = store.createBot({ name: "Synthetic", profileId: "personal", engine: "claude" }); store.createThread(bot.id); const key = requireSnapshotKey(f.custody.operations(), "capture");
  const capture = captureInspectionSnapshot({ source: store, include: { context: false, agenda: false, deviceRegistry: false, deviceSurface: false }, key, output: join(f.dir, "keys", "inspection.dxg8") });
  const result = restoreForInspection({ artifact: capture.path, key: requireSnapshotKey(f.custody.operations(), "inspect"), destination: join(f.dir, "inspection") }); assert.equal(result.productBackup, false);
});
test("public inspect/JSON and dedicated commands never expose private bytes, and static ops path runs actual CLI", async t => {
  const f = fixture(t); f.custody.unlock(f.password); const output = JSON.stringify(f.custody) + inspect(f.custody); assert.doesNotMatch(output, /PRIVATE KEY|keyPem|snapshot\":|password|passphrase/); assert.equal(output.includes(f.password.toString("base64")), false);
  const lines: string[] = []; assert.equal(await runOperatorSealedOperations(f.custody, ["version"], { write: s => lines.push(s) }), 0); assert.equal(lines.length, 1);
  assert.equal(await runOperatorCustodyCli(["unlock-check", "--password", "forbidden"], s => lines.push(s)), 1); assert.equal(lines[1], '{"error":"invalid_input"}');
  assert.throws(() => readOperatorPrivateFd(0), sealedCode("invalid_input"));
  // A synthetic inherited owner-private FD exercises secret input; no plaintext secret is written by this test.
  assert.equal(await runOperatorCustodyCli(["create", "--file", f.file, "--installation", f.b.installationId, "--owner", f.b.ownerId, "--device", f.b.deviceId, "--generation", "1", "--key-id", f.b.keyId, "--password-fd", "0", "--tls-fd", "0"], s => lines.push(s)), 1);
  const fd = openSync(f.file, "r"); try { assert.throws(() => readOperatorPrivateFd(fd, 16), sealedCode("private_path_required")); } finally { closeSync(fd); }
  assert.equal(lines.some(s => s.includes("PRIVATE KEY")), false);
});

test("symlinked dedicated executable create/unlock/export uses inherited OS pipes without plaintext secret files", async t => {
  const f = fixture(t), path = join(f.dir, "keys", "cli.sealed"), newer = randomBytes(32), backup = join(f.dir, "keys", "cli-backup.sealed"); t.after(() => newer.fill(0));
  const symlink = join(f.dir, "dexter custody link.js"); symlinkSync(resolve("packages/cli/dist/operator-custody-bin.js"), symlink);
  const bridge = `import os,json,sys,subprocess,base64,threading,hashlib
x=json.load(sys.stdin); pairs=[os.pipe() for _ in x['inputs']]
args=[v.replace('@FD'+str(i),str(pairs[i][0])) for v in x['args'] for i in [next((n for n in range(len(pairs)) if v=='@FD'+str(n)),0)]]
p=subprocess.Popen([sys.argv[1],sys.argv[2]]+args,pass_fds=tuple(r for r,w in pairs),stdout=subprocess.PIPE,stderr=subprocess.PIPE)
for r,w in pairs:os.close(r)
def send(w,data):
 try:os.write(w,base64.b64decode(data))
 finally:os.close(w)
threads=[threading.Thread(target=send,args=(w,data)) for (r,w),data in zip(pairs,x['inputs'])]
for thread in threads:thread.start()
out,err=p.communicate(timeout=10)
for thread in threads:thread.join()
print(json.dumps({'code':p.returncode,'output':out.decode(),'stderrBytes':len(err),'stderrSha256':hashlib.sha256(err).hexdigest()}))`;
  const base = ["--file", path, "--installation", f.b.installationId, "--owner", f.b.ownerId, "--device", f.b.deviceId, "--generation", "1", "--key-id", f.b.keyId, "--password-fd", "@FD0"];
  const call = (args: string[], inputs: Buffer[]) => {
    const processResult = spawnSync("python3", ["-c", bridge, process.execPath, symlink], { input: JSON.stringify({ args, inputs: inputs.map(b => b.toString("base64")) }), encoding: "utf8", timeout: 15000 });
    assert.equal(processResult.status, 0); const result = JSON.parse(processResult.stdout) as { code: number; output: string; stderrBytes: number; stderrSha256: string }; assert.doesNotMatch(result.output, /PRIVATE KEY|keyPem|password/); assert.equal(result.stderrBytes, 0); return result;
  };
  const tls = Buffer.from(JSON.stringify({ certPem: f.tls.certPem, keyPem: f.tls.keyPem }));
  try {
    const created = call(["create", ...base, "--tls-fd", "@FD1"], [f.password, tls]); assert.equal(created.code, 0); assert.equal(JSON.parse(created.output).unlocked, false);
    const unlocked = call(["unlock-check", ...base], [f.password]); assert.equal(unlocked.code, 0); assert.equal(JSON.parse(unlocked.output).unlocked, true);
    const exported = call(["export-sealed", ...base, "--destination", backup, "--new-password-fd", "@FD1"], [f.password, newer]); assert.equal(exported.code, 0);
    const reimport = new OperatorSealedCustody(backup, f.b); reimport.unlock(newer); assert.deepEqual(reimport.toJSON().identity, JSON.parse(unlocked.output).identity); await reimport.close();
    assert.deepEqual(readdirSync(join(f.dir, "keys")).sort(), ["cli-backup.sealed", "cli.sealed", "host.sealed"]);
  } finally { tls.fill(0); }
});

test("canonical test base owns every fixture under realpath TMPDIR", t => {
  assert.equal(dirname(TEST_BASE), realpathSync(tmpdir())); assert.equal(realpathSync(TEST_BASE), TEST_BASE);
  assert.equal(statSync(TEST_BASE).mode & 0o777, 0o700);
  const f = fixture(t); assert.equal(dirname(f.dir), TEST_BASE);
});
test("symlinked CLI failure executes and reports invalid_input rather than silent exit0", t => {
  const f = fixture(t), link = join(f.dir, "custody failure link.js"); symlinkSync(resolve("packages/cli/dist/operator-custody-bin.js"), link);
  const result = spawnSync(process.execPath, [link, "unlock-check"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 1); assert.equal(result.stdout, '{"error":"invalid_input"}\n');
});
test("locked and stale relay close returns rejected Promise without synchronous throw", async t => {
  const f = fixture(t); f.custody.unlock(f.password); const relay = f.custody.relay(); await f.custody.lock();
  let result: Promise<void> | undefined; assert.doesNotThrow(() => { result = relay.close(); });
  assert.ok(result instanceof Promise); await assert.rejects(result, sealedCode("locked"));
  f.custody.unlock(f.password); assert.doesNotThrow(() => { result = relay.close(); });
  assert.ok(result instanceof Promise); await assert.rejects(result, sealedCode("locked"));
  assert.equal(f.custody.toJSON().unlocked, true);
});
test("preflight failure keeps caller-owned custody unlocked until explicit close", async t => {
  const f = fixture(t); f.custody.unlock(f.password);
  assert.throws(() => openOperatorSealedHost(f.custody, { route: "production", options: { dataDir: join(f.dir, "missing") } }));
  assert.equal(f.custody.toJSON().unlocked, true); assert.equal(existsSync(join(f.dir, "missing")), false);
  await f.custody.close(); assert.equal(f.custody.toJSON().unlocked, false);
});
