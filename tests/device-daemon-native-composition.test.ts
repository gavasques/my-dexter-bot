import { sendMemoryIdentity } from "./fixtures/memory-identity-channel.js";
// Native helper composition of the trusted operator daemon. Everything is synthetic: an owned Node helper
// speaks the exact NativeDeviceClient stdin/stdout protocol and dials a real DeviceHostServer over pinned
// TLS 1.3 with its own temporary key. No Swift, Keychain, TCC, account or external network is involved.
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { HostStore, HostError } from "@dexter/hub";
import { DeviceError, generateSyntheticIdentity, DevicePairingRegistry, DeviceHostServer, MacDeviceDaemon } from "../packages/devices/src/index.js";
import { NativeDeviceClient, type NativeDeviceClientOptions } from "../packages/devices/src/native-client.js";
import { readDaemonConfig } from "../packages/devices/src/daemon-config.js";
import { main, type DaemonMainDependencies, type NativeClientHandle } from "../packages/devices/src/daemon-main.js";

import { nativeMemorySpawn } from "./fixtures/native-memory-spawn.js";
import { memoryCustody } from "./fixtures/device-memory-custody.js";
import { fileURLToPath } from "node:url";

const refusal = (code: string) => (e: unknown) => e instanceof DeviceError && e.code === code;
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
async function until(fn: () => boolean, ms = 8000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("fixture deadline"); await new Promise(r => setTimeout(r, 5)); } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const HELPER = (dir: string) => `#!${process.execPath}
import fs from "node:fs";import https from "node:https";import crypto from "node:crypto";
const dir=${JSON.stringify(dir)},cfg=JSON.parse(fs.readFileSync(process.argv[3],"utf8"));
const sha=b=>crypto.createHash("sha256").update(b).digest("hex");
const emit=(v,code=0)=>{process.stdout.write(JSON.stringify(v)+"\\n");process.exitCode=code;};
const chunks=[];for await(const c of fs.createReadStream(null,{fd:3,autoClose:true})){chunks.push(c);if(chunks.reduce((n,b)=>n+b.length,0)>16384)throw Error("memory bound");}
const encoded=Buffer.concat(chunks),identity=JSON.parse(encoded.toString("utf8"));encoded.fill(0);for(const c of chunks)c.fill(0);
let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",s=>{input+=s;});process.stdin.on("end",()=>{
 const cmd=JSON.parse(input),behavior=fs.existsSync(dir+"/behavior.json")?JSON.parse(fs.readFileSync(dir+"/behavior.json","utf8")):{};
 fs.appendFileSync(dir+"/calls.jsonl",JSON.stringify({pid:process.pid,operation:cmd.operation,route:cmd.route??null,expected:cmd.expectedClientFingerprint??null,argv:process.argv.slice(2),env:Object.keys(process.env)})+"\\n",{mode:0o600});
 const own=sha(new crypto.X509Certificate(identity.cert).raw);
 if(behavior.hang===(cmd.route??cmd.operation)){process.on("SIGTERM",()=>process.exit(143));setInterval(()=>{},1000);return;}
 if(cmd.operation==="load"){
  if(behavior.load)return emit({ok:false,error:behavior.load},1);
  const der=new crypto.X509Certificate(identity.cert).raw;
  return emit({ok:true,certificateDER:der.toString("base64"),fingerprint:sha(der),policy:"secure_enclave_data_protection_keychain_device_only"});
 }
 if(cmd.operation!=="request")return emit({ok:false,error:"invalidInput"},1);
 if(cmd.expectedClientFingerprint!==own)return emit({ok:false,error:"conflict"},1);
 const url=new URL(cfg.hostURL),body=Buffer.from(cmd.bodyBase64,"base64");
 const ca="-----BEGIN CERTIFICATE-----\\n"+cfg.hostCertificateDER.match(/.{1,64}/g).join("\\n")+"\\n-----END CERTIFICATE-----\\n";
 const req=https.request({hostname:url.hostname,port:url.port,method:"POST",path:cmd.route,agent:false,ca:[ca],
  cert:identity.cert,key:identity.key,minVersion:"TLSv1.3",maxVersion:"TLSv1.3",
  checkServerIdentity:(_h,c)=>c.raw&&sha(c.raw)===cfg.hostFingerprint?undefined:new Error("pin"),
  headers:{"content-type":"application/json","content-length":body.length,accept:"application/json"}},res=>{
   const chunks=[];res.on("data",c=>chunks.push(c));res.on("end",()=>{const text=Buffer.concat(chunks);
    if(res.statusCode===200)return emit({ok:true,responseBase64:text.toString("base64")});
    let code="protocolError";try{const e=JSON.parse(text.toString("utf8")).error;if(["invalid_input","forbidden","not_found","conflict","unavailable","timeout","unsupported","outcome_unknown","protocol_error"].includes(e))code=e;}catch{}
    emit({ok:false,error:code},1);});});
 req.on("error",()=>emit({ok:false,error:"unavailable"},1));req.setTimeout(Math.max(1,cmd.timeoutSeconds*1000),()=>req.destroy());req.end(body);
});
`;

interface Call { pid: number; operation: string; route: string | null; expected: string | null; argv: string[]; env: string[] }
async function setup(t: TestContext) {
  const cleanup: (() => void | Promise<void>)[] = [];
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dexter-native-daemon-")));
  const host = generateSyntheticIdentity(join(root, "host-id"), "host");
  const store = new HostStore({ dataDir: join(root, "hub") }), registry = new DevicePairingRegistry(store);
  const server = new DeviceHostServer({ store, registry, identity: host, pollWaitMs: 50, receiptTimeoutMs: 8000 });
  const hostUrl = await server.start();
  const helperDir = join(root, "helper"); mkdirSync(helperDir, { mode: 0o700 });
  // Synthetic stand-in for the helper's non-exportable key: only the helper process ever reads it.
  let device = generateSyntheticIdentity(join(helperDir, "keychain"), "device");
  const executable = join(helperDir, "native-helper.mjs"); writeFileSync(executable, HELPER(helperDir), { mode: 0o700 });
  cleanup.push(nativeMemorySpawn(executable,()=>device));
  const swapIdentity=()=>{rmSync(join(helperDir,"keychain"),{recursive:true});device=generateSyntheticIdentity(join(helperDir,"keychain"),"device");};
  const nativeConfigPath = join(helperDir, "native.json"), installationID = store.hostId;
  const nativeConfig = { installationID, hostURL: hostUrl, hostCertificateDER: new X509Certificate(host.certPem).raw.toString("base64"), hostFingerprint: host.fingerprint };
  const saveNative = (value: unknown) => writeFileSync(nativeConfigPath, JSON.stringify(value), { mode: 0o600 }); saveNative(nativeConfig);
  const behave = (value: unknown) => writeFileSync(join(helperDir, "behavior.json"), JSON.stringify(value), { mode: 0o600 });
  const dataDir = join(root, "data"), fixtureRoot = join(root, "fixtures"); mkdirSync(dataDir, { mode: 0o700 }); mkdirSync(fixtureRoot, { mode: 0o700 });
  const path = join(root, "config.json");
  const client = { kind: "native-helper", executable, configPath: nativeConfigPath, installationID };
  const config = { mode: "laboratory", version: 2, dataDir, name: "Native Mac", capabilities: ["mac.file.append"], hostUrl, hostCertPath: join(root, "host-id/cert.pem"), hostFingerprint: host.fingerprint, fixtureRoot, client };
  const save = (value: unknown) => { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); return path; }; save(config);
  const calls = (): Call[] => { const p = join(helperDir, "calls.jsonl"); return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as Call) : []; };
  const leases = () => { const db = new DatabaseSync(join(dataDir, "journal.sqlite")); try { return (db.prepare("SELECT COUNT(*) n FROM lease").get() as { n: number }).n; } finally { db.close(); } };
  t.after(async () => { for (const f of cleanup.reverse()) await f(); await server.close(); registry.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const deviceFp = () => createHash("sha256").update(new X509Certificate(readFileSync(join(helperDir, "keychain", "cert.pem"))).raw).digest("hex");
  assert.equal(deviceFp(), device.fingerprint);
  return { get device(){return device;}, swapIdentity, deviceFp, cleanup: (f: () => void | Promise<void>) => cleanup.push(f), root, host, store, registry, server, hostUrl, helperDir, executable, nativeConfigPath, nativeConfig, installationID, saveNative, behave, dataDir, fixtureRoot, path, config, client, save, calls, leases };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

/** Wraps the real frozen client; counts trusted lifecycle calls and optionally holds/rejects close. */
function tracked(options: NativeDeviceClientOptions, hooks: { closeGate?: Promise<void>; closeReject?: DeviceError; hostFingerprint?: string } = {}) {
  const real = new NativeDeviceClient(options);
  const state = { real, loads: 0, closes: 0, posts: [] as string[], closedAtPost: -1 };
  const handle: NativeClientHandle = {
    get hostFingerprint() { return hooks.hostFingerprint ?? real.hostFingerprint; },
    loadOnly: (ms, signal) => { state.loads++; return real.loadOnly(ms, signal); },
    post: (name, body, ms, signal) => { state.posts.push(name); return real.post(name, body, ms, signal); },
    close: () => { state.closes++; state.closedAtPost = state.posts.length; const closing = real.close(); return (async () => { await closing; if (hooks.closeGate) await hooks.closeGate; if (hooks.closeReject) throw hooks.closeReject; })(); },
  };
  return { state, handle };
}
function harness(_s: Fixture, extra: Partial<DaemonMainDependencies> & { hooks?: Parameters<typeof tracked>[1] } = {}) {
  const out: Record<string, unknown>[] = [], clients: ReturnType<typeof tracked>[] = [];let pemLoads = 0;
  const controller = new AbortController();
  const { hooks, ...rest } = extra;
  const deps: DaemonMainDependencies = {
    signal: controller.signal, emit: e => out.push(e),
    loadIdentity: () => { pemLoads++; throw new Error("PEM must never load for a native selection"); },
    createNativeClient: o => { const c = tracked(o, hooks); clients.push(c); return c.handle; },
    ...rest,
  };
  return { out, clients, deps, controller, pemLoads: () => pemLoads };
}
async function approveWhenClaimed(s: Fixture) { await until(() => s.registry.listPendingClaims().length === 1); s.registry.approveClaim(s.registry.listPendingClaims()[0]!.claimId); }

test("native pair→ready→declared job dispatch→receipt→restart reuses the binding; never PEM, public load only, no auto grant", async t => {
  const s = await setup(t), bundle = s.server.pairingBundle({ kind: "pair" });
  const h = harness(s, { readPairingLine: async () => ({ offerId: bundle.offerId, code: bundle.code }) });
  const run = main(["--config", s.path, "--pair"], h.deps); s.cleanup(async () => { h.controller.abort(); await run; });
  await approveWhenClaimed(s); await until(() => h.out.some(e => e.event === "ready"));
  assert.equal(h.pemLoads(), 0); assert.equal(h.clients.length, 1);
  const c = h.clients[0]!.state; assert.equal(c.loads, 1);
  // Pairing borrowed the client: it was not closed before the daemon took ownership.
  assert.equal(c.closes, 0); assert.deepEqual(c.posts.slice(0, 2), ["pair/claim", "pair/status"]);
  const deviceId = (h.out.find(e => e.event === "paired") as { deviceId: string }).deviceId;
  const binding = readFileSync(join(s.dataDir, "binding.json"), "utf8");
  assert.deepEqual(JSON.parse(binding), { installationId: s.installationID, ownerId: s.store.ownerId, deviceId, hostFingerprint: s.host.fingerprint });
  const bot = s.store.createBot({ name: "Synthetic", profileId: "fixture", engine: "claude" }), thread = s.store.createThread(bot.id);
  const ask = (key: string) => s.store.requestAction({ botId: bot.id, threadId: thread.id, tool: "mac.file.append", destination: deviceId, arguments: { name: "native.txt", line: "SYNTHETIC-" + key }, idempotencyKey: key });
  // Pairing and startup never create a grant.
  assert.throws(() => ask("ungranted"), e => e instanceof HostError && e.code === "forbidden"); assert.equal(s.store.listActions().length, 0);
  s.store.setGrant({ botId: bot.id, tool: "mac.file.append", destination: deviceId, policy: "allow" });
  const done = await s.server.dispatch(ask("one").id);
  assert.equal(done.state, "succeeded"); assert.equal(readFileSync(join(s.fixtureRoot, "native.txt"), "utf8"), "SYNTHETIC-one\n");
  assert.ok(c.posts.includes("device/receipt"));
  h.controller.abort(); assert.equal(await run, 0);
  assert.deepEqual(h.out.map(e => e.event), ["claiming", "paired", "ready", "stopped"]);
  assert.equal(c.closes, 1); assert.equal(s.leases(), 0);
  const text = JSON.stringify(h.out); for (const secret of [bundle.code, "PRIVATE KEY", "CERTIFICATE", s.nativeConfig.hostCertificateDER.slice(0, 40)]) assert.ok(!text.includes(secret));
  const first = s.calls();
  assert.equal(first[0]!.operation, "load"); assert.ok(first.every(x => x.operation === "load" || x.operation === "request"));
  assert.deepEqual(JSON.parse(readFileSync(join(s.dataDir, "native-device.json"), "utf8")), { fingerprint: s.deviceFp() });
  assert.equal(first.filter(x => x.operation === "load").length, 1, "exactly one public load per startup");
  assert.ok(first.filter(x => x.operation === "request").every(x => x.expected === s.deviceFp()));
  assert.ok(first.every(x => x.env.every(key => key === "__CF_USER_TEXT_ENCODING") && x.argv.join(" ") === `--config ${s.nativeConfigPath}`));
  const quiet = first.length; await sleep(250); assert.equal(s.calls().length, quiet, "no helper admission after stop");
  await assert.rejects(c.real.post("device/poll", { deviceId, installationId: s.installationID, receipts: [] }, 1000), refusal("unavailable")); assert.equal(s.calls().length, quiet);

  // Restart: same binding, no pairing input, no new claim and no new grant.
  const r = harness(s, { readPairingLine: async () => { throw new Error("restart must not read pairing input"); } });
  const second = main(["--config", s.path], r.deps); s.cleanup(async () => { r.controller.abort(); await second; });
  await until(() => r.out.some(e => e.event === "ready")); assert.deepEqual(r.out[0], { event: "ready", deviceId });
  const again = await s.server.dispatch(ask("two").id); assert.equal(again.state, "succeeded");
  r.controller.abort(); assert.equal(await second, 0); assert.equal(readFileSync(join(s.dataDir, "binding.json"), "utf8"), binding);
  const restartCalls = s.calls().slice(quiet); assert.equal(restartCalls[0]!.operation, "load");
  assert.ok(!restartCalls.some(x => x.route === "/v1/pair/claim" || x.route === "/v1/pair/status")); assert.equal(r.pemLoads(), 0);
  assert.equal(readFileSync(join(s.fixtureRoot, "native.txt"), "utf8"), "SYNTHETIC-one\nSYNTHETIC-two\n"); assert.equal(s.leases(), 0);
});

test("schema discriminators are exact: no ambiguous client, no v1 native, no PEM read for native selections", async t => {
  const s = await setup(t), pemDir = join(s.root, "pem"); memoryCustody(pemDir, generateSyntheticIdentity(pemDir, "device"),t);
  const native = readDaemonConfig(s.path); assert.equal(native.client.kind, "native-helper");
  assert.ok(!JSON.stringify(native).includes(pemDir));
  const bad = [
    { ...s.config, version: 1 }, { ...s.config, mode: "laboratory", version: undefined }, { ...s.config, identityDir: pemDir },
    { ...s.config, client: { ...s.client, identityDir: pemDir } }, { ...s.config, client: { kind: "laboratory-pem", identityDir: pemDir, executable: s.executable } },
    { ...s.config, client: { ...s.client, kind: "native" } }, { ...s.config, client: null }, { ...s.config, client: { ...s.client, installationID: "../x" } },
    { mode: "local-capabilities", version: 1, dataDir: s.dataDir, name: "x", capabilities: ["mac.browser.navigate"], hostUrl: s.hostUrl, hostCertPath: s.config.hostCertPath, hostFingerprint: s.host.fingerprint, policyPath: join(s.root, "policy.json"), browser: { executable: process.execPath, networkIsolation: "loopback_only" }, cua: null, client: s.client },
    { ...s.config, client: undefined, identityDir: pemDir },
  ];
  for (const value of bad) { s.save(value); assert.throws(() => readDaemonConfig(s.path), refusal("invalid_input"), JSON.stringify(value)); }
  s.save({ ...s.config, client: { kind: "laboratory-pem", identityDir: pemDir } }); const pem = readDaemonConfig(s.path);
  assert.deepEqual(pem.client, { kind: "laboratory-pem", identityDir: pemDir });
  const { fixtureRoot: _f, ...noFixtures } = s.config;
  s.save({ ...noFixtures, mode: "local-capabilities", capabilities: ["mac.browser.navigate"], policyPath: join(s.root, "policy.json"), browser: { executable: process.execPath, networkIsolation: "loopback_only" }, cua: null });
  const local = readDaemonConfig(s.path); assert.equal(local.mode, "local-capabilities"); assert.equal(local.client.kind, "native-helper");
  s.save({ ...s.config, capabilities: ["mac.browser.navigate"] }); assert.throws(() => readDaemonConfig(s.path), refusal("unsupported"));
  assert.equal(s.calls().length, 0);
});

test("helper/outer trust drift and private-path violations refuse before any client, helper, identity or journal", async t => {
  const s = await setup(t), other = generateSyntheticIdentity(join(s.root, "other-host"), "host");
  const cases: [string, () => void, string][] = [
    ["installation", () => s.saveNative({ ...s.nativeConfig, installationID: "host_other" }), "forbidden"],
    ["selection installation", () => s.save({ ...s.config, client: { ...s.client, installationID: "host_other" } }), "forbidden"],
    ["url port", () => s.saveNative({ ...s.nativeConfig, hostURL: s.hostUrl.replace(/:(\d+)$/, (_m, p) => `:${Number(p) + 1}`) }), "forbidden"],
    ["url spelling", () => s.saveNative({ ...s.nativeConfig, hostURL: s.hostUrl + "/" }), "forbidden"],
    ["helper pin", () => s.saveNative({ ...s.nativeConfig, hostFingerprint: other.fingerprint }), "tls_pin_mismatch"],
    ["helper der", () => s.saveNative({ ...s.nativeConfig, hostCertificateDER: new X509Certificate(other.certPem).raw.toString("base64") }), "tls_pin_mismatch"],
    ["helper extra key", () => s.saveNative({ ...s.nativeConfig, privateKey: "SYNTHETIC-NOT-A-KEY" }), "invalid_input"],
    ["helper public mode", () => chmodSync(s.nativeConfigPath, 0o644), "forbidden"],
    ["helper config symlink", () => { rmSync(s.nativeConfigPath); symlinkSync(join(s.root, "outside-missing"), s.nativeConfigPath); }, "forbidden"],
    ["executable group mode", () => chmodSync(s.executable, 0o750), "forbidden"],
    ["non-canonical path", () => { symlinkSync(s.helperDir, join(s.root, "alias")); s.save({ ...s.config, client: { ...s.client, configPath: join(s.root, "alias", "native.json") } }); }, "forbidden"],
    ["binding other installation", () => writeFileSync(join(s.dataDir, "binding.json"), JSON.stringify({ installationId: "host_other", ownerId: s.store.ownerId, deviceId: "dev_fixture", hostFingerprint: s.host.fingerprint }), { mode: 0o600 }), "conflict"],
    ["binding other pin", () => writeFileSync(join(s.dataDir, "binding.json"), JSON.stringify({ installationId: s.installationID, ownerId: s.store.ownerId, deviceId: "dev_fixture", hostFingerprint: other.fingerprint }), { mode: 0o600 }), "tls_pin_mismatch"],
  ];
  for (const [name, mutate, code] of cases) {
    s.save(s.config); s.saveNative(s.nativeConfig); chmodSync(s.executable, 0o700); rmSync(join(s.dataDir, "binding.json"), { force: true }); rmSync(join(s.root, "alias"), { force: true });
    if (existsSync(s.nativeConfigPath)) chmodSync(s.nativeConfigPath, 0o600);
    mutate();
    let constructed = 0, pairs = 0; const h = harness(s, { readPairingLine: async () => { pairs++; return { offerId: "off_fixture", code: "synthetic" }; } });
    const createNative = h.deps.createNativeClient!; h.deps.createNativeClient = o => { constructed++; return createNative(o); };
    assert.equal(await main(["--config", s.path, "--pair"], h.deps), 1, name);
    assert.deepEqual(h.out, [{ event: "error", code }], name);
    assert.equal(constructed + pairs + h.pemLoads(), 0, name); assert.equal(s.calls().length, 0, name);
    assert.equal(existsSync(join(s.dataDir, "journal.sqlite")), false, name);
    rmSync(s.nativeConfigPath, { force: true });
  }
});

test("helper config changed after validation refuses at construction re-check and on each later invocation", async t => {
  const s = await setup(t);
  // Changed between validation and the client's frozen read: refused before load, client closed.
  const h = harness(s); const create = h.deps.createNativeClient!;
  h.deps.createNativeClient = o => { const c = create(o); s.saveNative({ ...s.nativeConfig, laboratoryID: "0".repeat(32) }); return c; };
  assert.equal(await main(["--config", s.path, "--pair"], h.deps), 1); assert.deepEqual(h.out, [{ event: "error", code: "forbidden" }]);
  assert.equal(h.clients[0]!.state.loads, 0); assert.equal(h.clients[0]!.state.closes, 1); assert.equal(s.calls().length, 0);
  // Changed while running: the next helper invocation is refused by the frozen client and the daemon stops (exit 3).
  s.saveNative(s.nativeConfig); const bundle = s.server.pairingBundle({ kind: "pair" });
  const r = harness(s, { readPairingLine: async () => ({ offerId: bundle.offerId, code: bundle.code }) });
  const run = main(["--config", s.path, "--pair"], r.deps); s.cleanup(async () => { r.controller.abort(); await run; });
  await approveWhenClaimed(s); await until(() => r.out.some(e => e.event === "ready")); await until(() => s.calls().some(x => x.route === "/v1/device/poll"));
  s.saveNative({ ...s.nativeConfig, laboratoryID: "1".repeat(32) }); const at = s.calls().length;
  assert.equal(await run, 3); assert.deepEqual(r.out.at(-1), { event: "stopped", reason: "forbidden" });
  assert.ok(s.calls().length <= at + 1, "at most the invocation already admitted before the change"); assert.equal(s.leases(), 0);
});

test("startup failures close the owned client with full drain; abort during load waits for the helper", async t => {
  const s = await setup(t);
  // Missing native identity: fixed code, never provisions, never pairs.
  s.behave({ load: "missing" }); let pairs = 0;
  const a = harness(s, { readPairingLine: async () => { pairs++; return { offerId: "off_fixture", code: "synthetic" }; } });
  assert.equal(await main(["--config", s.path, "--pair"], a.deps), 1); assert.deepEqual(a.out, [{ event: "error", code: "not_found" }]);
  assert.equal(pairs, 0); assert.equal(a.clients[0]!.state.closes, 1); assert.deepEqual(s.calls().map(x => x.operation), ["load"]);
  // Abort while the helper is mid-load: main returns only after the helper process drained.
  s.behave({ hang: "load" }); const b = harness(s); const run = main(["--config", s.path, "--pair"], b.deps);
  await until(() => s.calls().length === 2); b.controller.abort(); assert.equal(await run, 1);
  assert.deepEqual(b.out, [{ event: "error", code: "unavailable" }]); assert.equal(b.clients[0]!.state.real.pending, 0); assert.equal(b.clients[0]!.state.closes, 1);
  s.behave({});
  // Pairing failure plus a rejected client close: the cleanup rejection is reported, never hidden.
  const c = harness(s, { readPairingLine: async () => ({ offerId: "off_fixture", code: "synthetic" }), pairDevice: async () => { throw new DeviceError("forbidden"); }, hooks: { closeReject: new DeviceError("timeout") } });
  assert.equal(await main(["--config", s.path, "--pair"], c.deps), 1); assert.deepEqual(c.out, [{ event: "claiming" }, { event: "error", code: "timeout" }]);
  // Abort after approval: client closed, no resources, no daemon, no paired/ready.
  const d = harness(s, { readPairingLine: async () => ({ offerId: "off_fixture", code: "synthetic" }), pairDevice: async () => { d.controller.abort(); return { deviceId: "dev_fixture" } as never; }, createDaemon: () => { throw new Error("must not construct"); } });
  assert.equal(await main(["--config", s.path, "--pair"], d.deps), 1); assert.deepEqual(d.out, [{ event: "claiming" }, { event: "error", code: "unavailable" }]); assert.equal(d.clients[0]!.state.closes, 1);
  // Pairing borrowed the same client instance the daemon would receive.
  let borrowed: object | null = null; const e = harness(s, { readPairingLine: async () => ({ offerId: "off_fixture", code: "synthetic" }), pairDevice: async o => { borrowed = o; throw new DeviceError("forbidden"); } });
  assert.equal(await main(["--config", s.path, "--pair"], e.deps), 1); assert.equal((borrowed as { client?: unknown } | null)?.client, e.clients[0]!.handle);
  assert.equal("identity" in borrowed!, false); assert.equal(e.clients[0]!.state.closes, 1);
  assert.equal(existsSync(join(s.dataDir, "journal.sqlite")), false);
});

test("daemon constructor failure leaves the client with main; after construction only daemon.stop drains it", async t => {
  const s = await setup(t); writeFileSync(join(s.dataDir, "binding.json"), JSON.stringify({ installationId: s.installationID, ownerId: s.store.ownerId, deviceId: "dev_fixture", hostFingerprint: s.host.fingerprint }), { mode: 0o600 });
  writeFileSync(join(s.dataDir, "native-device.json"), JSON.stringify({ fingerprint: s.deviceFp() }), { mode: 0o600 });
  const a = harness(s, { createDaemon: () => { throw new Error("SYNTHETIC-CTOR-BODY"); } });
  assert.equal(await main(["--config", s.path], a.deps), 1); assert.deepEqual(a.out, [{ event: "error", code: "unavailable" }]); assert.equal(a.clients[0]!.state.closes, 1);
  // Real daemon owns the client; a held close keeps the journal lease and suppresses "stopped".
  // start() is a no-op here: the lifecycle is under test, not polling with a hand-written binding.
  const idle = (o: Parameters<NonNullable<DaemonMainDependencies["createDaemon"]>>[0]) => { const d = new MacDeviceDaemon(o); d.start = () => {}; return d; };
  const g = gate(), b = harness(s, { hooks: { closeGate: g.promise }, createDaemon: idle }); let finished = false;
  const run = main(["--config", s.path], b.deps); s.cleanup(async () => { g.release(); b.controller.abort(); await run; }); void run.then(() => { finished = true; });
  await until(() => b.out.some(e => e.event === "ready")); b.controller.abort(); await until(() => b.clients[0]!.state.closes === 1); await sleep(50);
  assert.equal(finished, false); assert.ok(!b.out.some(e => e.event === "stopped")); assert.equal(s.leases(), 1);
  g.release(); assert.equal(await run, 0); assert.equal(b.clients[0]!.state.closes, 1); assert.equal(s.leases(), 0); assert.deepEqual(b.out.map(e => e.event), ["ready", "stopped"]);
  // A rejected close is quarantined: fixed error, never "stopped", lease stays held.
  const c = harness(s, { hooks: { closeReject: new DeviceError("unavailable") } }); let daemon: MacDeviceDaemon | null = null;
  c.deps.createDaemon = o => (daemon = idle(o));
  const third = main(["--config", s.path], c.deps); await until(() => c.out.some(e => e.event === "ready")); c.controller.abort();
  assert.equal(await third, 1); assert.deepEqual(c.out.map(e => e.event), ["ready", "error"]); assert.deepEqual(c.out[1], { event: "error", code: "unavailable" });
  assert.equal(c.clients[0]!.state.closes, 1); assert.equal(s.leases(), 1);
  await assert.rejects(daemon!.stop(), refusal("unavailable")); assert.equal(s.leases(), 1);
});

test("native identity is pinned to the data directory: swap, unrecorded binding and client pin drift fail before any request", async t => {
  const s = await setup(t), bundle = s.server.pairingBundle({ kind: "pair" });
  const h = harness(s, { readPairingLine: async () => ({ offerId: bundle.offerId, code: bundle.code }) });
  const run = main(["--config", s.path, "--pair"], h.deps); s.cleanup(async () => { h.controller.abort(); await run; });
  await approveWhenClaimed(s); await until(() => h.out.some(e => e.event === "ready")); h.controller.abort(); assert.equal(await run, 0);
  const recorded = s.deviceFp(), binding = readFileSync(join(s.dataDir, "binding.json"), "utf8"), before = s.calls().length;
  // Helper key swapped after pairing (synthetic rotation): load reports another fingerprint → conflict, zero requests.
  s.swapIdentity(); assert.notEqual(s.deviceFp(), recorded);
  for (const args of [["--config", s.path], ["--config", s.path, "--pair"]]) {
    let pairs = 0; const r = harness(s, { readPairingLine: async () => { pairs++; return { offerId: bundle.offerId, code: bundle.code }; } });
    assert.equal(await main(args, r.deps), 1); assert.deepEqual(r.out, [{ event: "error", code: "conflict" }]); assert.equal(pairs + r.pemLoads(), 0);
    assert.equal(r.clients[0]!.state.closes, 1); assert.equal(r.clients[0]!.state.posts.length, 0);
  }
  assert.deepEqual(s.calls().slice(before).map(x => x.operation), ["load", "load"]);
  assert.deepEqual(JSON.parse(readFileSync(join(s.dataDir, "native-device.json"), "utf8")), { fingerprint: recorded }); assert.equal(readFileSync(join(s.dataDir, "binding.json"), "utf8"), binding);
  // A binding without a recorded native fingerprint (e.g. paired by the PEM seam) is never adopted.
  rmSync(join(s.dataDir, "native-device.json")); const u = harness(s);
  assert.equal(await main(["--config", s.path], u.deps), 1); assert.deepEqual(u.out, [{ event: "error", code: "conflict" }]); assert.equal(existsSync(join(s.dataDir, "native-device.json")), false);
  // The client's typed host pin must equal the outer trust before any helper invocation.
  const calls = s.calls().length, p = harness(s, { hooks: { hostFingerprint: "f".repeat(64) } });
  assert.equal(await main(["--config", s.path], p.deps), 1); assert.deepEqual(p.out, [{ event: "error", code: "tls_pin_mismatch" }]);
  assert.equal(p.clients[0]!.state.loads, 0); assert.equal(p.clients[0]!.state.closes, 1); assert.equal(s.calls().length, calls);
});

// R4 regressions: production factory/CLI entry, native pairing abort, stop during an in-flight helper request,
// and pairing retry after the public fingerprint was recorded. All helpers remain synthetic Node processes.
test("production CLI entry with the default native factory pairs over stdin, serves a job and stops on real signals", async t => {
  const s = await setup(t), bundle = s.server.pairingBundle({ kind: "pair" }), entry = resolve("packages/devices/dist/daemon-main.js");
  const child = (args: string[]) => {
    const c = spawn(process.execPath, ["--import",fileURLToPath(new URL("./fixtures/native-memory-preload.js",import.meta.url)),entry, "--config", s.path, ...args], { shell: false, env: { PATH: "/usr/bin:/bin", NODE_NO_WARNINGS: "1" }, stdio: ["pipe","pipe","pipe","ipc"] });
  const identityReady=sendMemoryIdentity(c,s.device); void identityReady.catch(()=>{c.kill("SIGTERM");});
    let out = "", err = "", code: number | null | undefined; const exited = new Promise<number | null>(r => c.once("exit", x => { code = x; r(x); }));
    c.stdout!.on("data", b => { out += b.toString(); }); c.stderr!.on("data", b => { err += b.toString(); });
    s.cleanup(async () => { if (code === undefined) { c.kill("SIGKILL"); await exited; } });
    return { c, exited, done: () => code !== undefined, events: () => out.trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>), text: () => out + err };
  };
  const first = child(["--pair"]); first.c.stdin!.write(JSON.stringify({ offerId: bundle.offerId, code: bundle.code }) + "\n");
  // An early exit (for example a refused default factory) is an assertion failure, never a fixture deadline.
  await until(() => s.registry.listPendingClaims().length === 1 || first.done(), 15000); assert.equal(first.done(), false, JSON.stringify(first.events()));
  await approveWhenClaimed(s); await until(() => first.events().some(e => e.event === "ready") || first.done(), 15000); assert.equal(first.done(), false, JSON.stringify(first.events()));
  const deviceId = (first.events().find(e => e.event === "paired") as { deviceId: string }).deviceId;
  const bot = s.store.createBot({ name: "Synthetic", profileId: "fixture", engine: "claude" }), thread = s.store.createThread(bot.id);
  s.store.setGrant({ botId: bot.id, tool: "mac.file.append", destination: deviceId, policy: "allow" });
  const ask = (key: string) => s.store.requestAction({ botId: bot.id, threadId: thread.id, tool: "mac.file.append", destination: deviceId, arguments: { name: "cli.txt", line: "SYNTHETIC-" + key }, idempotencyKey: key });
  assert.equal((await s.server.dispatch(ask("cli-one").id)).state, "succeeded");
  first.c.kill("SIGTERM"); assert.equal(await first.exited, 0);
  assert.deepEqual(first.events().map(e => e.event), ["claiming", "paired", "ready", "stopped"]);
  for (const secret of [bundle.code, "PRIVATE KEY", "CERTIFICATE", s.nativeConfig.hostCertificateDER.slice(0, 40)]) assert.ok(!first.text().includes(secret));
  const calls = s.calls(); assert.equal(calls.filter(x => x.operation === "load").length, 1); assert.ok(calls.every(x => x.operation === "load" || x.operation === "request"));
  assert.ok(calls.filter(x => x.operation === "request").every(x => x.expected === s.deviceFp())); assert.ok(calls.every(x => !alive(x.pid)), "no helper outlives the daemon");
  assert.equal(s.leases(), 0); assert.deepEqual(JSON.parse(readFileSync(join(s.dataDir, "native-device.json"), "utf8")), { fingerprint: s.deviceFp() });
  // Restart through the same entry: binding reused, no stdin read, SIGINT also drains.
  const second = child([]); await until(() => second.events().some(e => e.event === "ready") || second.done(), 15000); assert.equal(second.done(), false, JSON.stringify(second.events()));
  assert.deepEqual(second.events()[0], { event: "ready", deviceId }); assert.equal((await s.server.dispatch(ask("cli-two").id)).state, "succeeded");
  second.c.kill("SIGINT"); assert.equal(await second.exited, 0); assert.deepEqual(second.events().map(e => e.event), ["ready", "stopped"]);
  assert.ok(s.calls().slice(calls.length).every(x => x.route !== "/v1/pair/claim" && !alive(x.pid))); assert.equal(s.leases(), 0);
  assert.equal(readFileSync(join(s.fixtureRoot, "cli.txt"), "utf8"), "SYNTHETIC-cli-one\nSYNTHETIC-cli-two\n");
});

test("abort during a held native pairing request drains the helper before main returns; no claim, binding or journal", async t => {
  const s = await setup(t), bundle = s.server.pairingBundle({ kind: "pair" }); s.behave({ hang: "/v1/pair/claim" });
  const h = harness(s, { readPairingLine: async () => ({ offerId: bundle.offerId, code: bundle.code }) });
  const run = main(["--config", s.path, "--pair"], h.deps); s.cleanup(async () => { h.controller.abort(); await run; });
  await until(() => s.calls().some(x => x.route === "/v1/pair/claim")); await sleep(100);
  const held = s.calls().find(x => x.route === "/v1/pair/claim")!; assert.ok(alive(held.pid)); assert.equal(h.clients[0]!.state.real.pending, 1);
  h.controller.abort(); assert.equal(await run, 1);
  // The claim was handed to the helper: the host may or may not have seen it, so the honest code is outcome_unknown.
  assert.deepEqual(h.out, [{ event: "claiming" }, { event: "error", code: "outcome_unknown" }]);
  assert.equal(alive(held.pid), false, "helper drained before main returned"); assert.equal(h.clients[0]!.state.real.pending, 0); assert.equal(h.clients[0]!.state.closes, 1);
  assert.equal(s.registry.listPendingClaims().length, 0); assert.equal(existsSync(join(s.dataDir, "binding.json")), false); assert.equal(existsSync(join(s.dataDir, "journal.sqlite")), false);
  const after = s.calls().length; await sleep(200); assert.equal(s.calls().length, after, "no retry or late admission");
});

test("stop during an in-flight native device request drains the helper before the lease is released", async t => {
  const s = await setup(t), bundle = s.server.pairingBundle({ kind: "pair" });
  const h = harness(s, { readPairingLine: async () => ({ offerId: bundle.offerId, code: bundle.code }) });
  const run = main(["--config", s.path, "--pair"], h.deps); s.cleanup(async () => { h.controller.abort(); await run; });
  await approveWhenClaimed(s); await until(() => h.out.some(e => e.event === "ready"));
  s.behave({ hang: "/v1/device/poll" }); const before = s.calls().length;
  await until(() => s.calls().slice(before).some(x => x.route === "/v1/device/poll")); await sleep(100);
  const held = s.calls().slice(before).find(x => x.route === "/v1/device/poll")!; assert.ok(alive(held.pid)); assert.equal(s.leases(), 1);
  h.controller.abort(); assert.equal(await run, 0); assert.deepEqual(h.out.map(e => e.event), ["claiming", "paired", "ready", "stopped"]);
  assert.equal(alive(held.pid), false); assert.equal(h.clients[0]!.state.real.pending, 0); assert.equal(h.clients[0]!.state.closes, 1); assert.equal(s.leases(), 0);
  const after = s.calls().length; await sleep(200); assert.equal(s.calls().length, after, "no helper admission after stop");
});

test("a failed pairing keeps the recorded public fingerprint: the same identity retries, a swapped one is refused", async t => {
  const s = await setup(t), wrong = s.server.pairingBundle({ kind: "pair" });
  const a = harness(s, { readPairingLine: async () => ({ offerId: wrong.offerId, code: "SYNTHETICWRONGCODE" }) });
  assert.equal(await main(["--config", s.path, "--pair"], a.deps), 1); assert.equal(a.out[0]!.event, "claiming"); assert.equal(a.out.at(-1)!.event, "error");
  assert.equal(existsSync(join(s.dataDir, "binding.json")), false); assert.equal(a.clients[0]!.state.closes, 1);
  const recorded = s.deviceFp(); assert.deepEqual(JSON.parse(readFileSync(join(s.dataDir, "native-device.json"), "utf8")), { fingerprint: recorded });
  // Same helper identity: retry pairs and becomes ready.
  const bundle = s.server.pairingBundle({ kind: "pair" }), b = harness(s, { readPairingLine: async () => ({ offerId: bundle.offerId, code: bundle.code }) });
  const run = main(["--config", s.path, "--pair"], b.deps); s.cleanup(async () => { b.controller.abort(); await run; });
  await approveWhenClaimed(s); await until(() => b.out.some(e => e.event === "ready")); b.controller.abort(); assert.equal(await run, 0);
  // Swapped helper identity on an unbound-but-recorded data directory: conflict, no pairing input, zero requests.
  rmSync(join(s.dataDir, "binding.json")); s.swapIdentity();
  let reads = 0; const c = harness(s, { readPairingLine: async () => { reads++; return { offerId: bundle.offerId, code: bundle.code }; } });
  assert.equal(await main(["--config", s.path, "--pair"], c.deps), 1); assert.deepEqual(c.out, [{ event: "error", code: "conflict" }]);
  assert.equal(reads, 0); assert.equal(c.clients[0]!.state.posts.length, 0); assert.deepEqual(JSON.parse(readFileSync(join(s.dataDir, "native-device.json"), "utf8")), { fingerprint: recorded });
});

// R5 regressions: the real CLI entry with an open stdin pipe under real SIGTERM, the paired installation
// check after approval, and a re-pair/revocation on a bound data directory. Helpers remain synthetic Node.
function cli(s: Fixture, args: string[]) {
  const entry = resolve("packages/devices/dist/daemon-main.js");
  const c = spawn(process.execPath, ["--import",fileURLToPath(new URL("./fixtures/native-memory-preload.js",import.meta.url)),entry, "--config", s.path, ...args], { shell: false, env: { PATH: "/usr/bin:/bin", NODE_NO_WARNINGS: "1" }, stdio: ["pipe","pipe","pipe","ipc"] });
  const identityReady=sendMemoryIdentity(c,s.device); void identityReady.catch(()=>{c.kill("SIGTERM");});
  let out = "", code: number | null | undefined; const exited = new Promise<number | null>(r => c.once("exit", x => { code = x; r(x); }));
  c.stdout!.on("data", b => { out += b.toString(); });
  s.cleanup(async () => { if (code === undefined) { c.kill("SIGKILL"); await exited; } c.stdin!.destroy(); });
  return { c, exited, done: () => code !== undefined, text: () => out, events: () => out.trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>) };
}
test("CLI entry with an open stdin pipe: SIGTERM while awaiting pairing input or during a held claim drains the helper", async t => {
  const s = await setup(t), bundle = s.server.pairingBundle({ kind: "pair" });
  // No line written and the pipe never ended: the public load was recorded, then SIGTERM stops the input wait.
  const idle = cli(s, ["--pair"]);
  await until(() => existsSync(join(s.dataDir, "native-device.json")) || idle.done(), 15000); assert.equal(idle.done(), false, idle.text()); await sleep(100);
  assert.deepEqual(s.calls().map(x => x.operation), ["load"]); assert.equal(idle.c.stdin!.writableEnded, false);
  idle.c.kill("SIGTERM"); assert.equal(await idle.exited, 1); assert.deepEqual(idle.events(), [{ event: "error", code: "unavailable" }]);
  assert.equal(alive(s.calls()[0]!.pid), false); assert.equal(s.registry.listPendingClaims().length, 0);
  // Line written, pipe still open, helper held inside the claim request: SIGTERM drains it before exit.
  s.behave({ hang: "/v1/pair/claim" }); const held = cli(s, ["--pair"]); held.c.stdin!.write(JSON.stringify({ offerId: bundle.offerId, code: bundle.code }) + "\n");
  await until(() => s.calls().some(x => x.route === "/v1/pair/claim") || held.done(), 15000); assert.equal(held.done(), false, held.text()); await sleep(100);
  const claim = s.calls().find(x => x.route === "/v1/pair/claim")!; assert.ok(alive(claim.pid)); assert.equal(held.c.stdin!.writableEnded, false);
  held.c.kill("SIGTERM"); assert.equal(await held.exited, 1);
  assert.deepEqual(held.events(), [{ event: "claiming" }, { event: "error", code: "outcome_unknown" }]);
  assert.equal(alive(claim.pid), false, "helper drained before the CLI exited"); assert.ok(!held.text().includes(bundle.code));
  assert.deepEqual(s.calls().map(x => x.operation), ["load", "load", "request"], "one load per process, no retry");
  assert.equal(s.registry.listPendingClaims().length, 0); assert.equal(existsSync(join(s.dataDir, "binding.json")), false); assert.equal(existsSync(join(s.dataDir, "journal.sqlite")), false);
  assert.deepEqual(JSON.parse(readFileSync(join(s.dataDir, "native-device.json"), "utf8")), { fingerprint: s.deviceFp() });
});

test("an approval for another installation is refused after pairing and the written binding never serves", async t => {
  const s = await setup(t), bundle = s.server.pairingBundle({ kind: "pair" }), other = "host_synthetic_other";
  // Trusted wrapper around the real client that rewrites only the approved status installation.
  let closes = 0; const created: NativeDeviceClient[] = [];
  const h = harness(s, { readPairingLine: async () => ({ offerId: bundle.offerId, code: bundle.code }), createDaemon: () => { throw new Error("must not construct"); },
    createNativeClient: o => { const real = new NativeDeviceClient(o); created.push(real); return {
      get hostFingerprint() { return real.hostFingerprint; }, loadOnly: (ms, signal) => real.loadOnly(ms, signal), close: () => { closes++; return real.close(); },
      post: async (name, body, ms, signal) => { const out = await real.post(name, body, ms, signal) as Record<string, unknown>; return name === "pair/status" && out.status === "approved" ? { ...out, installationId: other } : out; } }; } });
  const run = main(["--config", s.path, "--pair"], h.deps); s.cleanup(async () => { h.controller.abort(); await run; });
  await approveWhenClaimed(s); assert.equal(await run, 1);
  assert.deepEqual(h.out, [{ event: "claiming" }, { event: "error", code: "conflict" }]); assert.equal(closes, 1); assert.equal(created[0]!.pending, 0);
  assert.equal(JSON.parse(readFileSync(join(s.dataDir, "binding.json"), "utf8")).installationId, other); assert.equal(existsSync(join(s.dataDir, "journal.sqlite")), false);
  // Restart refuses the mismatched binding before any helper invocation, identity or journal.
  const before = s.calls().length, r = harness(s);
  assert.equal(await main(["--config", s.path], r.deps), 1); assert.deepEqual(r.out, [{ event: "error", code: "conflict" }]);
  assert.equal(r.clients.length, 0); assert.equal(s.calls().length, before); assert.equal(existsSync(join(s.dataDir, "journal.sqlite")), false);
});

test("re-pair and revocation on a bound native data directory keep the device id, binding and grants; nothing revives", async t => {
  const s = await setup(t), bundle = s.server.pairingBundle({ kind: "pair" });
  const h = harness(s, { readPairingLine: async () => ({ offerId: bundle.offerId, code: bundle.code }) });
  const run = main(["--config", s.path, "--pair"], h.deps); s.cleanup(async () => { h.controller.abort(); await run; });
  await approveWhenClaimed(s); await until(() => h.out.some(e => e.event === "ready"));
  const deviceId = (h.out.find(e => e.event === "paired") as { deviceId: string }).deviceId;
  const bot = s.store.createBot({ name: "Synthetic", profileId: "fixture", engine: "claude" }), thread = s.store.createThread(bot.id);
  s.store.setGrant({ botId: bot.id, tool: "mac.file.append", destination: deviceId, policy: "allow" });
  const ask = (key: string) => s.store.requestAction({ botId: bot.id, threadId: thread.id, tool: "mac.file.append", destination: deviceId, arguments: { name: "repair.txt", line: "SYNTHETIC-" + key }, idempotencyKey: key });
  assert.equal((await s.server.dispatch(ask("one").id)).state, "succeeded"); h.controller.abort(); assert.equal(await run, 0);
  const binding = readFileSync(join(s.dataDir, "binding.json"), "utf8"), recorded = readFileSync(join(s.dataDir, "native-device.json"), "utf8"), devices = s.store.listDevices().length;
  // Explicit re-pair with the same helper identity and a fresh offer: the host never mints a second device.
  const again = s.server.pairingBundle({ kind: "pair" }), p = harness(s, { readPairingLine: async () => ({ offerId: again.offerId, code: again.code }) });
  const repair = main(["--config", s.path, "--pair"], p.deps); s.cleanup(async () => { p.controller.abort(); await repair; });
  await until(() => p.out.some(e => e.event === "error" || e.event === "ready") || s.registry.listPendingClaims().length > 0, 15000);
  assert.ok(!p.out.some(e => e.event === "ready"), "--pair on a bound directory is verified by the host, never served directly");
  assert.equal(s.registry.listPendingClaims().length, 0, "the same public key cannot open a second pending claim");
  assert.equal(await repair, 1); assert.deepEqual(p.out.map(e => e.event), ["claiming", "error"]); assert.equal(p.clients[0]!.state.closes, 1);
  assert.equal(readFileSync(join(s.dataDir, "binding.json"), "utf8"), binding); assert.equal(readFileSync(join(s.dataDir, "native-device.json"), "utf8"), recorded);
  assert.equal(s.store.listDevices().length, devices); assert.equal(s.leases(), 0);
  // Admit an action before revocation so the durable blocking/dispatch defense stays exercised.
  const pending = ask("pending");
  assert.equal(pending.state, "ready");
  // Host revokes the device: the restarted daemon stops with a fixed refusal and its lease is released, not lost.
  s.registry.revokeDevice(deviceId);
  assert.equal(s.store.getAction(pending.id).state, "blocked");
  assert.equal(s.store.getAction(pending.id).reason, "permission_changed");
  assert.equal(s.store.getAction(pending.id).result, null);
  const r = harness(s);
  const restart = main(["--config", s.path], r.deps); s.cleanup(async () => { r.controller.abort(); await restart; });
  const code = await restart; assert.equal(code, 3, JSON.stringify(r.out)); assert.equal(r.out.at(-1)!.event, "stopped"); assert.equal(r.out.at(-1)!.reason, "forbidden");
  assert.equal(r.clients[0]!.state.closes, 1); assert.equal(r.clients[0]!.state.real.pending, 0); assert.equal(s.leases(), 0);
  assert.equal(readFileSync(join(s.dataDir, "binding.json"), "utf8"), binding);
  // The old grant never revives dispatch to the revoked device, and nothing new was created.
  await assert.rejects(s.server.dispatch(pending.id), e => e instanceof HostError && e.code === "conflict");
  const counts = s.store.summary().counts;
  assert.throws(() => ask("two"), e => e instanceof HostError && e.code === "forbidden");
  assert.deepEqual(s.store.summary().counts, counts);
  await assert.rejects(s.server.dispatch(pending.id), e => e instanceof HostError && e.code === "conflict");
  assert.deepEqual(s.store.summary().counts, counts);
  assert.equal(s.store.getGrant(bot.id, "mac.file.append", deviceId)!.policy, "allow");
  assert.equal(s.store.listDevices().length, devices);
  assert.equal(readFileSync(join(s.fixtureRoot, "repair.txt"), "utf8"), "SYNTHETIC-one\n");
});
