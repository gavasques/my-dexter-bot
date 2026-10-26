import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { chmodSync, closeSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { HostStore } from "@dexter/hub";
import { TlsIdentity } from "@dexter/devices";
import type { OperatorSealedCustody as Custody } from "../packages/cli/src/operator-sealed-custody.js";

// Actual OS process proof of the SHIPPED `dexter-operator-host` (packages/cli/dist): real fork/exec, inherited FD 3, real
// SIGTERM/SIGINT delivery and process exit. Synthetic installation, TLS and passphrase only; engines/MCP/agenda/device
// tools/app clients stay default-off; loopback port 0; private HOME/TMPDIR; no accounts, auth files or network.
// Works from tests/ (Node type stripping) and from scripts/run-node-tests.mjs's emitted copy at <source>/.test-dist/tests:
// the root is the nearest ancestor holding package.json (the runner copies it) and the built packages/cli/dist bin.
let root = dirname(fileURLToPath(import.meta.url));
while (!(existsSync(join(root, "package.json")) && existsSync(join(root, "packages/cli/dist/operator-host-bin.js")))) {
  const up = dirname(root); if (up === root) throw new Error("shipped operator host bin not found"); root = up;
}
const BIN = join(root, "packages/cli/dist/operator-host-bin.js");
const { OperatorSealedCustody } = await import(pathToFileURL(join(root, "packages/cli/dist/operator-sealed-custody.js")).href) as { OperatorSealedCustody: typeof Custody };

// Synthetic self-signed loopback certificate (same construction as tests/fixtures/relay-host-lab.ts memoryTLS).
const der = (tag: number, ...parts: Buffer[]) => { const b = Buffer.concat(parts), n = b.length;
  return Buffer.concat([Buffer.from([tag]), n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]), b]); };
const seq = (...p: Buffer[]) => der(0x30, ...p), oid = (hex: string) => der(6, Buffer.from(hex, "hex"));
function syntheticTLS(): TlsIdentity {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" }), alg = seq(oid("2a8648ce3d040302"));
  const name = seq(der(0x31, seq(oid("550403"), der(0x0c, Buffer.from("operator-process-lab")))));
  const dt = (d: Date) => der(0x18, Buffer.from(d.toISOString().replace(/[-:T]/g, "").replace(/\.\d{3}Z$/, "Z")));
  const ext = (o: string, v: Buffer) => seq(oid(o), der(4, v));
  const extensions = der(0xa3, seq(ext("551d11", seq(der(0x87, Buffer.from([127, 0, 0, 1])))), ext("551d13", seq())));
  const tbs = seq(der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([1])), alg, name,
    seq(dt(new Date(Date.now() - 60_000)), dt(new Date(Date.now() + 86_400_000))), name, keys.publicKey.export({ type: "spki", format: "der" }), extensions);
  const pem = `-----BEGIN CERTIFICATE-----\n${seq(tbs, alg, der(3, Buffer.from([0]), sign("sha256", tbs, keys.privateKey))).toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  return new TlsIdentity(pem, keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), createHash("sha256").update(new X509Certificate(pem).raw).digest("hex"));
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function within<T>(what: string, ms: number, probe: () => T | undefined): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) { const v = probe(); if (v !== undefined) return v; }
  throw new Error(`bounded wait expired: ${what}`);
}

test("shipped operator host bin: real SIGTERM/SIGINT keep one ordered shutdown, cut admission, exit 0 and release writer + port", { timeout: 20_000 }, async t => {
  const lab = mkdtempSync(join(realpathSync(tmpdir()), "doh-proc-")); chmodSync(lab, 0o700);
  for (const d of ["home", "tmp", "logs"]) mkdirSync(join(lab, d), { mode: 0o700 });
  let passed = false, child: ReturnType<typeof spawn> | undefined, held: Socket | undefined;
  t.after(() => {
    held?.destroy();
    // Synthetic fallback only for the PID this test created; never any other process.
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (passed) rmSync(lab, { recursive: true, force: true }); else t.diagnostic(`private lab retained: ${lab}`);
  });

  // Synthetic canonical store + sealed custody bound to it.
  const data = join(lab, "host"), store = new HostStore({ dataDir: data });
  const binding = { installationId: store.hostId, ownerId: store.ownerId, deviceId: "host", generation: 1, keyId: "hostkey" }; store.close();
  const password = randomBytes(32), file = join(lab, "keys", "host.sealed");
  const secretMarkers = [password.toString("base64"), password.toString("hex")];
  void OperatorSealedCustody.create(file, binding, password, syntheticTLS()).close();

  // Owner-private regular file inherited as FD 3; the parent's copy of the passphrase is zeroed once written.
  const fdPath = join(lab, `fd-${randomBytes(6).toString("hex")}`);
  writeFileSync(fdPath, password, { mode: 0o600 }); chmodSync(fdPath, 0o600); password.fill(0);
  const fd = openSync(fdPath, "r");
  const errLog = createWriteStream(join(lab, "logs", "child-stderr.log"), { mode: 0o600 });
  child = spawn(process.execPath, [BIN, "--data-dir", data, "--file", file, "--installation", binding.installationId, "--owner", binding.ownerId,
    "--device", binding.deviceId, "--generation", "1", "--key-id", binding.keyId, "--password-fd", "3", "--port", "0"], {
    cwd: lab, stdio: ["ignore", "pipe", "pipe", fd],
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(lab, "home"), TMPDIR: `${join(lab, "tmp")}/`, NODE_NO_WARNINGS: "1" } });
  closeSync(fd);
  child.stderr!.pipe(errLog); // private diagnostic only; never asserted on or printed
  let stdout = ""; child.stdout!.setEncoding("utf8").on("data", (s: string) => { stdout += s; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(r => child!.once("exit", (code, signal) => r({ code, signal })));
  const lines = () => stdout.split("\n").slice(0, -1).filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
  const status = (s: string) => () => lines().find(l => l["status"] === s);
  const alive = () => child!.exitCode === null && child!.signalCode === null;

  const ready = await within("ready", 10_000, () => { if (!alive()) throw new Error(`child exited early: ${stdout}`); return status("ready")(); });
  unlinkSync(fdPath); // unlocked and serving: the ephemeral FD file is gone
  assert.equal(ready["mode"], "operator-sealed-local");
  assert.equal(ready["engineExecution"], "disabled"); assert.equal(ready["mcpGateway"], "disabled");
  assert.equal(ready["deviceTurnTools"], "disabled"); assert.equal(ready["agenda"], "disabled");
  assert.deepEqual(ready["deviceChannel"], { status: "unconfigured" }); assert.deepEqual(ready["appClientChannel"], { status: "unconfigured" });
  assert.deepEqual(ready["ownerControl"], { status: "unconfigured" }); assert.equal(ready["tlsFingerprint"], undefined);
  assert.deepEqual(ready["trustedProviders"], { relay: "unconfigured", relayRecovery: "unconfigured", managedApps: "unconfigured" });
  const url = String(ready["url"]); assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/); const port = Number(new URL(url).port);
  const health = await fetch(`${url}/health`); assert.equal(health.status, 200); await health.arrayBuffer();
  assert.throws(() => new HostStore({ dataDir: data })); // single canonical writer held by the live child

  // One raw connection with a begun (incomplete) request keeps the listener close pending across the signals.
  held = connect(port, "127.0.0.1"); let received = "";
  held.on("data", chunk => { received += chunk.toString("latin1"); }); held.on("error", () => {});
  await new Promise<void>(r => held!.once("connect", () => r()));
  held.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n");
  await sleep(100);

  assert.equal(child.kill("SIGTERM"), true);
  await within("stopping", 2_000, status("stopping"));
  // Repeated real signals inside the held window: handlers stay installed, no default termination, no second flow.
  assert.equal(child.kill("SIGINT"), true); await sleep(50);
  assert.equal(child.kill("SIGTERM"), true); await sleep(50);
  assert.equal(alive(), true); assert.equal(process.kill(child.pid!, 0), true);
  assert.deepEqual(lines().map(l => l["status"]), ["ready", "stopping"]);

  held.write("\r\n"); // complete the request after the admission cut
  await within("503 response", 2_000, () => received.includes("\r\n\r\n") && received.includes("host_stopping") ? true : undefined);
  assert.match(received, /^HTTP\/1\.1 503 /); assert.match(received, /host_stopping/);
  held.destroy();

  let exitTimer: NodeJS.Timeout | undefined; // cancelled so a won race does not keep the worker alive for 10 s
  const exit = await Promise.race([exited, new Promise<never>((_, reject) => { exitTimer = setTimeout(() => reject(new Error("child did not exit")), 10_000); })])
    .finally(() => clearTimeout(exitTimer));
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.deepEqual(lines().map(l => l["status"]), ["ready", "stopping", "stopped"]);
  const output = stdout;
  assert.equal(output.includes(lab), false); assert.doesNotMatch(output, /PRIVATE KEY|keyPem|password|sqlite/);
  for (const m of secretMarkers) assert.equal(output.includes(m), false);

  // Same port no longer accepts; writer can be reopened after exit.
  const refused = await new Promise<string>(r => { const s = connect(port, "127.0.0.1"); s.once("connect", () => { s.destroy(); r("connected"); }); s.once("error", e => r((e as NodeJS.ErrnoException).code ?? "error")); });
  assert.equal(refused, "ECONNREFUSED");
  const reopened = new HostStore({ dataDir: data }); reopened.close();
  await new Promise<void>(r => errLog.end(() => r()));
  t.diagnostic(JSON.stringify({ node: process.version, statuses: lines().map(l => l["status"]), exit, heldResponse: 503, portAfterExit: refused, writerReopened: true, fdFileUnlinked: !existsSync(fdPath) }));
  passed = true;
});
