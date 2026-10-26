import { observeChild, childExitError } from "./fixtures/child-observation.js";
import { sendMemoryIdentity } from "./fixtures/memory-identity-channel.js";
// HostServices composition of the owner control socket (staged with the private HostServices/CLI patch 03): pure
// preflight, the socket only after the app-client TLS channel listens, the same writer for both, and shutdown that
// stops owner admission first and retains the writer until admitted owner connections drained. Synthetic identities,
// loopback/private Unix socket only; the generated pairing code stays in memory and is never printed.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HostError, HostStore } from "@dexter/hub";
import { HostServices } from "../packages/cli/src/host-services.js";
import { ownerControlRequest, runOwnerControlCli } from "../packages/cli/src/owner-control-client.js";
import { call, clientIdentity, hostIdentity, removeDir, tempDir } from "./app-client-lab.js";

const io = () => { const out = { stdout: "", stderr: "" }; return { out, io: { stdout: (s: string) => { out.stdout += s; }, stderr: (s: string) => { out.stderr += s; } } }; };
const root = (): string => realpathSync(tempDir("dexter-oc-host-"));

test("owner control preflight is pure and requires the app-client channel", (t) => {
  const dir = root(); t.after(() => removeDir(dir));
  const identity = hostIdentity(join(dir, "id"));
  const dataDir = join(dir, "absent");
  assert.throws(() => new HostServices({ dataDir, ownerControl: { socketPath: join(dir, "c", "o.sock") } }), HostError);
  assert.throws(() => new HostServices({ dataDir, appClients: { identity }, ownerControl: { socketPath: "rel.sock" } }), HostError);
  assert.equal(existsSync(dataDir), false);
  assert.equal(existsSync(join(dir, "c")), false);
});

test("owner CLI reaches the same live HostServices; shutdown drains owner connections before releasing the writer", async (t) => {
  const dir = root(); t.after(() => removeDir(dir));
  const appHost = hostIdentity(join(dir, "app-id"));
  const dataDir = join(dir, "host");
  const socketPath = join(dir, "ctl", "owner.sock");
  const services = new HostServices({ dataDir, appClients: { identity: appHost }, ownerControl: { socketPath, requestTimeoutMs: 5_000 } });
  // Failure hygiene: a failed assertion must not leave listeners holding the test process.
  t.after(async () => { await services.shutdown({ graceMs: 3_000 }).catch(() => {}); });
  assert.equal(existsSync(socketPath), false, "no socket before start");
  assert.equal(await services.startOwnerControl(), socketPath);
  const url = await services.startAppClients();
  const trust = { url, certPem: appHost.certPem, fingerprint: appHost.fingerprint };
  const s = ["--owner-control-socket", socketPath];
  const outDir = join(dir, "out"); mkdirSync(outDir, { mode: 0o700 });
  assert.equal(await runOwnerControlCli(["offer", ...s, "--role", "client-mac", "--scope", "devices.read", "--out", join(outDir, "b.json")], io().io), 0);
  const bundle = JSON.parse(readFileSync(join(outDir, "b.json"), "utf8")) as { offerId: string; code: string; hostUrl: string };
  assert.equal(bundle.hostUrl, url);
  const mac = clientIdentity(join(dir, "mac"));
  const claimed = await call(trust, mac, "POST", "/app-client/v1/pair/claim", { offerId: bundle.offerId, code: bundle.code, name: "Lab Mac" });
  assert.equal(await runOwnerControlCli(["approve", claimed.json.claimId as string, "--fingerprint", mac.fingerprint, ...s], io().io), 0);
  assert.equal((await call(trust, mac, "GET", "/v1/devices")).status, 200, "approved client authenticates on the same host");
  assert.throws(() => new HostStore({ dataDir }), (e: unknown) => e instanceof HostError && e.code === "host_locked", "no second writer");
  // The compiled `dexter app-client` entry talks to this process; it never opens the store.
  const cli = fileURLToPath(new URL("../../packages/cli/dist/index.js", import.meta.url));
  const statusOut = await new Promise<string>((ok, fail) => execFile(process.execPath, [resolve(cli), "app-client", "status", ...s],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeout: 15_000 }, (e, out) => e ? fail(e) : ok(out)));
  assert.equal((JSON.parse(statusOut) as { installationId: string }).installationId, services.store.hostId);
  // An admitted owner connection (incomplete frame) keeps the writer through a short shutdown.
  const held = connect({ path: socketPath }); held.on("error", () => {});
  await new Promise<void>(r => held.once("connect", () => r()));
  held.write(Buffer.from([0, 0, 0]));
  await new Promise(r => setTimeout(r, 50));
  const first = services.shutdown({ graceMs: 200 });
  assert.deepEqual(await ownerControlRequest(socketPath, { op: "status", args: {} }), { kind: "not_sent" }, "admission stopped synchronously");
  await assert.rejects(first, /cleanup is not confirmed/);
  assert.throws(() => services.appClientsAdmin, HostError, "retained admin refused");
  assert.throws(() => new HostStore({ dataDir }), (e: unknown) => e instanceof HostError && e.code === "host_locked", "writer retained");
  assert.equal(existsSync(join(dir, "ctl")), true, "owner directory kept until drained");
  held.destroy();
  await services.shutdown({ graceMs: 3_000 });
  assert.equal(existsSync(join(dir, "ctl")), false);
  await assert.rejects(services.startOwnerControl(), HostError);
  const reopened = new HostStore({ dataDir });
  try {
    assert.equal(reopened.listDevices().filter(d => d.revokedAt === null).length, 1);
    assert.equal(reopened.summary().counts.grants, 0);
  } finally { reopened.close(); }
});

test("dexter serve with --owner-control-socket: CLI subprocesses use the live host; SIGTERM removes the socket", async (t) => {
  const dir = root(); t.after(() => removeDir(dir));
  const identity=hostIdentity(join(dir, "app-id"));
  const socketPath = join(dir, "ctl", "owner.sock");
  const cli = resolve(fileURLToPath(new URL("../../packages/cli/dist/index.js", import.meta.url)));
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const host = spawn(process.execPath, ["--import",fileURLToPath(new URL("./fixtures/device-memory-preload.js",import.meta.url)),cli, "serve", "--data-dir", join(dir, "host"), "--port", "0", "--app-client-identity-dir", join(dir, "app-id"),
    "--app-client-offer-ttl-seconds", "120", "--owner-control-socket", socketPath], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const observed=observeChild(host);
  const identityReady=sendMemoryIdentity(host,identity); void identityReady.catch(()=>{host.kill("SIGTERM");});
  t.after(async () => { if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL"); await observed.closed; });
  let stdout = "";
  const ready = await new Promise<{ ownerControl: { status: string; socket: string } }>((ok, fail) => {
    host.stdout!.on("data", (c: Buffer) => { if (stdout.length + c.length > 32768) { host.kill("SIGTERM"); fail(Error("child startup stdout_bound")); return; } stdout += c.toString("utf8"); try { ok(JSON.parse(stdout)); } catch { /* partial */ } });
    void observed.closed.then(value=>fail(childExitError(value)));
    void identityReady.catch(()=>observed.closed.then(value=>fail(childExitError(value))));
  });
  assert.deepEqual(ready.ownerControl, { status: "listening", socket: socketPath });
  const run = (argv: string[]) => new Promise<{ code: number; out: string; err: string }>(ok =>
    execFile(process.execPath, [cli, "app-client", ...argv, "--owner-control-socket", socketPath], { env, timeout: 15_000 },
      (e, out, err) => ok({ code: e ? Number((e as { code?: number }).code ?? 1) : 0, out, err })));
  assert.equal((await run(["status"])).code, 0);
  mkdirSync(join(dir, "out"), { mode: 0o700 });
  const offer = await run(["offer", "--role", "client-ios", "--no-scopes", "--out", join(dir, "out", "b.json")]);
  assert.equal(offer.code, 0);
  const bundle = JSON.parse(readFileSync(join(dir, "out", "b.json"), "utf8")) as { code: string; expiresAt: number; offerId: string };
  assert.ok(!offer.out.includes(bundle.code) && !offer.err.includes(bundle.code) && !stdout.includes(bundle.code));
  assert.equal((await run(["cancel", bundle.offerId])).code, 0);
  assert.equal((await run(["claims"])).code, 0);
  host.kill("SIGTERM");
  const stopped=await observed.closed; assert.equal(stopped.exitCode,0); assert.equal(stopped.signal,null); assert.equal(stopped.stderr.category,"none");
  assert.equal(existsSync(socketPath), false);
  assert.equal(existsSync(join(dir, "ctl")), false);
  new HostStore({ dataDir: join(dir, "host") }).close();
});
