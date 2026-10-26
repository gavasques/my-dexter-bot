import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import { HostError, HostStore } from "@dexter/hub";
import { OperatorSealedCustody } from "../packages/cli/src/operator-sealed-custody.js";
import { openOperatorSealedHost } from "../packages/cli/src/operator-sealed-host.js";
import { runOperatorHost, type OperatorHostDependencies, type OperatorHostQuarantine } from "../packages/cli/src/operator-host-server.js";
import { memoryTLS } from "./fixtures/relay-host-lab.js";

// Test-owned private base under realpath TMPDIR; synthetic installation, TLS and passphrase only (no accounts/Health).
const BASE = mkdtempSync(join(realpathSync(tmpdir()), "doh-"));
chmodSync(BASE, 0o700);
after(() => rmSync(BASE, { recursive: true, force: true }));

function installation(t: TestContext) {
  const dir = mkdtempSync(join(BASE, "synthetic-")); chmodSync(dir, 0o700); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const data = join(dir, "host"), store = new HostStore({ dataDir: data });
  const b = { installationId: store.hostId, ownerId: store.ownerId, deviceId: "host", generation: 1, keyId: "hostkey" }; store.close();
  const password = randomBytes(32), tls = memoryTLS(), file = join(dir, "keys", "host.sealed"); t.after(() => password.fill(0));
  void OperatorSealedCustody.create(file, b, password, tls).close();
  const args = (extra: string[] = [], dataDir = data) => ["--data-dir", dataDir, "--file", file, "--installation", b.installationId, "--owner", b.ownerId,
    "--device", b.deviceId, "--generation", "1", "--key-id", b.keyId, ...extra];
  return { dir, data, tls, password, args };
}
/** Synthetic owner-private inherited FD: opened, then unlinked right after the launcher's synchronous read. */
function launch(dir: string, secret: Buffer, argv: (fd: string) => string[], seam: Pick<OperatorHostDependencies, "open"> = {}) {
  const path = join(dir, `fd-${randomBytes(6).toString("hex")}`); writeFileSync(path, secret, { mode: 0o600 });
  const fd = openSync(path, "r"), lines: string[] = [], trace: string[] = [], signals = new EventEmitter();
  // Unreferenced stand-in for the executable's referenced lifetime, so the proof can observe acquire/release.
  const lifetime = { acquired: 0, released: 0 }, retained: OperatorHostQuarantine[] = [];
  let onLine: (() => void) | undefined;
  const result = runOperatorHost(argv(String(fd)), { write: line => { lines.push(line); onLine?.(); }, signals, trace: phase => trace.push(phase), shutdownGraceMs: 1_000,
    keepAlive: () => { lifetime.acquired++; return { release: () => { lifetime.released++; } }; }, retained: q => retained.push(q), ...seam });
  unlinkSync(path); closeSync(fd);
  const until = (status: string) => new Promise<Record<string, unknown>>(done => {
    const check = () => { const hit = lines.map(l => JSON.parse(l) as Record<string, unknown>).find(l => l["status"] === status); if (hit) done(hit); };
    onLine = check; check();
  });
  const handlers = () => signals.listenerCount("SIGINT") + signals.listenerCount("SIGTERM");
  return { result, lines, trace, signals, until, lifetime, retained, handlers };
}

test("shipped launcher composes sealed host on loopback without implicit engines and closes custody only after ordered drain", async t => {
  const f = installation(t);
  const run = launch(f.dir, f.password, fd => f.args(["--password-fd", fd, "--port", "0", "--app-client-port", "0"]));
  const ready = await Promise.race([run.until("ready"), run.result.then(c => { throw new Error(`exited ${c}: ${run.lines.join("|")}`); })]);
  assert.equal(ready["engineExecution"], "disabled"); assert.equal(ready["mcpGateway"], "disabled"); assert.equal(ready["agenda"], "disabled");
  assert.equal((ready["appClientChannel"] as { status: string }).status, "listening"); assert.equal(ready["tlsFingerprint"], f.tls.fingerprint);
  assert.match(String(ready["url"]), /^http:\/\/127\.0\.0\.1:\d+$/);
  const health = await fetch(`${String(ready["url"])}/health`); assert.equal(health.status, 200); await health.arrayBuffer();
  assert.throws(() => new HostStore({ dataDir: f.data })); // single canonical writer held by the launcher
  assert.equal(run.handlers(), 2);
  run.signals.emit("SIGTERM");
  // F1: while the listener close/host drain is pending, handlers stay installed and repeats join the single flow.
  assert.equal(run.handlers(), 2); run.signals.emit("SIGINT"); run.signals.emit("SIGTERM"); assert.equal(run.handlers(), 2);
  assert.equal(await run.result, 0);
  assert.equal(run.handlers(), 0); assert.deepEqual(run.lifetime, { acquired: 1, released: 1 }); assert.deepEqual(run.retained, []);
  assert.deepEqual(run.trace, ["admission_cut", "http_closed", "host_drained", "custody_closed"]);
  assert.deepEqual(run.lines.map(l => (JSON.parse(l) as { status: string }).status), ["ready", "stopping", "stopped"]);
  await assert.rejects(fetch(`${String(ready["url"])}/health`));
  const output = run.lines.join("\n");
  assert.equal(output.includes(f.dir), false); assert.doesNotMatch(output, /PRIVATE KEY|keyPem|password|sqlite/);
  assert.equal(output.includes(f.password.toString("base64")), false);
  const reopened = new HostStore({ dataDir: f.data }); reopened.close();
});

test("unlock, flag and preflight failures refuse with stable codes, open no writer and create no data directory", async t => {
  const f = installation(t);
  const refused = async (secret: Buffer, argv: (fd: string) => string[], expected: string) => {
    const run = launch(f.dir, secret, argv); assert.equal(await run.result, 1);
    assert.deepEqual(run.lines.map(l => JSON.parse(l) as unknown), [{ status: "refused", error: expected }]); assert.deepEqual(run.trace, []);
    const store = new HostStore({ dataDir: f.data }); store.close();
  };
  const wrong = randomBytes(32); t.after(() => wrong.fill(0));
  await refused(wrong, fd => f.args(["--password-fd", fd, "--port", "0"]), "authentication_failed");
  await refused(f.password, fd => f.args(["--password-fd", fd]), "invalid_input"); // no implicit port
  await refused(f.password, fd => f.args(["--password-fd", fd, "--port", "0", "--password", "x"]), "invalid_input");
  await refused(f.password, () => f.args(["--password-fd", "0", "--port", "0"]), "invalid_input"); // stdio FDs refused
  await refused(f.password, fd => f.args(["--password-fd", fd, "--port", "0", "--enable-agenda"]), "invalid_input"); // agenda needs explicit engines
  await refused(f.password, fd => f.args(["--password-fd", fd, "--port", "0", "--owner-control-socket", join(f.dir, "s")]), "invalid_input");
  const missing = join(f.dir, "missing");
  const run = launch(f.dir, f.password, fd => f.args(["--password-fd", fd, "--port", "0"], missing)); assert.equal(await run.result, 1);
  assert.equal((JSON.parse(run.lines[0]!) as { status: string }).status, "refused"); assert.equal(existsSync(missing), false);
});

const settledWithin = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => true), new Promise<false>(r => setTimeout(() => r(false), ms))]);

test("admission cut is synchronous: a request completed on an already-active socket after the signal never reaches the app", async t => {
  const f = installation(t);
  const run = launch(f.dir, f.password, fd => f.args(["--password-fd", fd, "--port", "0"]));
  const ready = await run.until("ready"), port = Number(new URL(String(ready["url"])).port);
  const socket = connect(port, "127.0.0.1"); let received = "";
  socket.on("data", chunk => { received += chunk.toString("latin1"); }); socket.on("error", () => {});
  await new Promise<void>(r => socket.once("connect", () => r()));
  socket.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n"); // message begun: active, not idle
  await new Promise(r => setTimeout(r, 100));
  run.signals.emit("SIGTERM");
  socket.write("\r\n");
  await new Promise<void>(r => { const check = () => received.includes("\r\n\r\n") ? r() : setTimeout(check, 10); check(); });
  assert.match(received, /^HTTP\/1\.1 503 /); assert.match(received, /host_stopping/);
  socket.destroy();
  assert.equal(await run.result, 0);
  assert.deepEqual(run.trace, ["admission_cut", "http_closed", "host_drained", "custody_closed"]);
});

test("uncertain open() keeps an explicit retained owner, handlers and referenced lifetime; signals do not close, retry or exit", async t => {
  const f = installation(t); let custody: OperatorSealedCustody | undefined, opens = 0;
  const run = launch(f.dir, f.password, fd => f.args(["--password-fd", fd, "--port", "0"]),
    { open: c => { custody = c; opens++; throw new HostError("conflict", "synthetic uncertain open"); } });
  await run.until("startup_uncertain");
  t.after(async () => { run.signals.removeAllListeners(); await custody?.close(); });
  assert.equal(run.retained.length, 1); const q = run.retained[0]!;
  assert.equal(q.state, "startup_uncertain"); assert.equal(q.custody, custody); assert.equal(q.host, undefined);
  assert.equal(q.custody.toJSON().unlocked, true); assert.deepEqual(run.lifetime, { acquired: 1, released: 0 }); assert.equal(run.handlers(), 2);
  run.signals.emit("SIGTERM"); run.signals.emit("SIGINT");
  assert.equal(await settledWithin(run.result, 200), false);
  assert.equal(opens, 1); assert.equal(run.handlers(), 2); assert.equal(q.custody.toJSON().unlocked, true); assert.equal(run.lifetime.released, 0);
  assert.deepEqual(run.trace, ["custody_retained"]);
  assert.deepEqual(run.lines.map(l => JSON.parse(l) as unknown), [{ status: "startup_uncertain", error: "conflict", custody: "retained" }]);
});

test("non-waitable shutdown failure quarantines with host + custody + writer retained and no blind retry", async t => {
  const f = installation(t); let shutdowns = 0, real: ReturnType<typeof openOperatorSealedHost> | undefined;
  const run = launch(f.dir, f.password, fd => f.args(["--password-fd", fd, "--port", "0"]), { open: (c, i) => {
    real = openOperatorSealedHost(c, i); const target = real.host;
    const host = new Proxy(target, { get: (o, key) => {
      if (key === "shutdown") return async () => { shutdowns++; throw new HostError("conflict", "synthetic shutdown failure"); };
      const value = Reflect.get(o, key, o) as unknown; return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(o) : value;
    } });
    return { host, shutdown: real.shutdown };
  } });
  await run.until("ready");
  t.after(async () => { run.signals.removeAllListeners(); await real?.host.shutdown(); await real?.shutdown(); });
  run.signals.emit("SIGTERM");
  await run.until("shutdown_failed");
  const q = run.retained[0]!;
  assert.equal(q.state, "shutdown_failed"); assert.ok(q.host); assert.equal(q.custody.toJSON().unlocked, true);
  assert.throws(() => new HostStore({ dataDir: f.data })); // writer retained
  run.signals.emit("SIGINT"); run.signals.emit("SIGTERM");
  assert.equal(await settledWithin(run.result, 200), false);
  assert.equal(shutdowns, 1); assert.equal(run.handlers(), 2); assert.deepEqual(run.lifetime, { acquired: 1, released: 0 });
  assert.deepEqual(run.trace, ["admission_cut", "http_closed", "custody_retained"]);
  assert.deepEqual(run.lines.map(l => (JSON.parse(l) as { status: string }).status), ["ready", "stopping", "shutdown_failed"]);
});
