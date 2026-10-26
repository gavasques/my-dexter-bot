import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { test, type TestContext } from "node:test";
import { NativeDeviceClient } from "../packages/devices/src/native-client.js";
import { DeviceError } from "../packages/devices/src/errors.js";
import { generateSyntheticIdentity } from "../packages/devices/src/lab.js";
const reject = (code: string) => (e: unknown) => e instanceof DeviceError && e.code === code;
async function until(fn: () => boolean, ms = 4000): Promise<void> { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("synthetic helper deadline"); await new Promise(r => setTimeout(r, 5)); } }
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function bounded<T>(promise: Promise<T>, ms = 8000): Promise<T | "STILL_PENDING"> { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([promise, new Promise<"STILL_PENDING">(resolve => { timer = setTimeout(() => resolve("STILL_PENDING"), ms); })]); } finally { clearTimeout(timer); } }
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dexter-native-client-"))), identity = generateSyntheticIdentity(join(root, "public-fixture"), "host"), der = new X509Certificate(identity.certPem).raw.toString("base64");
  const executable = join(root, "helper.mjs"), configPath = join(root, "config.json"), log = join(root, "calls.jsonl"), behavior = join(root, "behavior.json");
  const config = { installationID: "host_fixture", hostURL: "https://127.0.0.1:12345", hostCertificateDER: der, hostFingerprint: identity.fingerprint };
  const save = (value: unknown) => writeFileSync(configPath, JSON.stringify(value), { mode: 0o600 }); save(config);
  const mode = (value: unknown) => writeFileSync(behavior, JSON.stringify(value), { mode: 0o600 }); mode({ mode: "normal" });
  writeFileSync(executable, `#!${process.execPath}\nimport fs from "node:fs";import crypto from "node:crypto";import { spawn } from "node:child_process";const root=${JSON.stringify(root)},config=JSON.parse(fs.readFileSync(process.argv[3],"utf8"));let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",s=>input+=s);process.stdin.on("end",()=>{const cmd=JSON.parse(input),behavior=JSON.parse(fs.readFileSync(root+"/behavior.json","utf8"));fs.appendFileSync(root+"/calls.jsonl",JSON.stringify({operation:cmd.operation,route:cmd.route,pid:process.pid,argv:process.argv.slice(2),env:Object.keys(process.env),eof:true,digest:crypto.createHash("sha256").update(input).digest("hex")})+"\\n",{mode:0o600});const emit=value=>process.stdout.write(JSON.stringify(value)+"\\n");const result=()=>{if(behavior.error){emit({ok:false,error:behavior.error,...(behavior.extra??{})});process.exit(behavior.code??1);return;}if(behavior.stdout!==undefined){process.stdout.write(behavior.stdout);process.exit(behavior.code??0);return;}if(cmd.operation==="load")emit({ok:true,certificateDER:behavior.der??config.hostCertificateDER,fingerprint:behavior.fingerprint??config.hostFingerprint,policy:behavior.policy??"secure_enclave_data_protection_keychain_device_only"});else{const reply=behavior.response??(cmd.route==="/v1/pair/claim"?{claimId:"claim_fixture",status:"pending"}:cmd.route==="/v1/pair/status"?{status:"approved",deviceId:"dev_fixture",installationId:config.installationID,ownerId:"owner_fixture"}:cmd.route==="/v1/device/poll"?{jobs:[]}:{ack:true});emit({ok:true,responseBase64:Buffer.from(JSON.stringify(reply)).toString("base64")});}process.exit(behavior.code??0);};if(behavior.mode==="group"||behavior.mode==="detached"){const detached=behavior.mode==="detached";if(!detached)process.on("SIGTERM",()=>{});const script="import fs from 'node:fs';process.on('SIGTERM',()=>{});fs.writeFileSync("+JSON.stringify(root+"/grandchild.ready")+",'ready');setInterval(()=>{},1000);",g=spawn(process.execPath,["--input-type=module","-e",script],{detached,stdio:["ignore","inherit","inherit"]});fs.writeFileSync(root+"/grandchild.json.tmp",JSON.stringify({pid:g.pid,detached}));fs.renameSync(root+"/grandchild.json.tmp",root+"/grandchild.json");g.unref();const ready=setInterval(()=>{if(!fs.existsSync(root+"/grandchild.ready"))return;clearInterval(ready);process.stdout.write(JSON.stringify({ok:true,responseBase64:Buffer.from('{"jobs":[]}').toString("base64")})+"\\n",()=>{if(detached)process.exit(0);});},5);setInterval(()=>{},1000);}else if(behavior.mode==="hang"){process.on("SIGTERM",()=>{});setInterval(()=>{},1000);}else if(behavior.mode==="late"){process.on("SIGTERM",()=>{});setTimeout(result,behavior.delay??180);}else if(behavior.mode==="flood"){process.stdout.write("x".repeat(400000));setInterval(()=>{},1000);}else if(behavior.mode==="stderr"){process.stderr.write("SYNTHETIC-UNTRUSTED-ERROR".repeat(1000));setInterval(()=>{},1000);}else result();});\n`, { mode: 0o700 });
  const clients: NativeDeviceClient[] = []; const client = () => { const c = new NativeDeviceClient({ executable, configPath, installationID: "host_fixture" }); clients.push(c); return c; };
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(x => JSON.parse(x) as { operation: string; route?: string; pid: number; argv: string[]; env: string[]; eof: boolean; digest: string }) : [];
  const ready = async (c: NativeDeviceClient) => { await c.loadOnly(20000); rmSync(log, { force: true }); };
  const grandchild = () => existsSync(join(root, "grandchild.json")) ? JSON.parse(readFileSync(join(root, "grandchild.json"), "utf8")) as { pid: number; detached: boolean } : null;
  t.after(async () => {
    const grand = grandchild();
    // Counterfactual fixtures may disable escalation/drain. Kill only this fixture's recorded processes.
    for (const pid of [grand?.pid, ...calls().map(call => call.pid)]) if (pid && alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* Exit raced the signal. */ } }
    for (const c of clients) await c.close();
    if (grand) await until(() => !alive(grand.pid), 8000);
    rmSync(root, { recursive: true, force: true });
  });
  return { ready, grandchild, root, executable, configPath, log, config, identity, der, save, mode, calls, client };
}
const poll = { deviceId: "dev_fixture", installationId: "host_fixture", receipts: [] };
const receipt = { actionId: "act_fixture", nonce: "a".repeat(32), requestHash: "b".repeat(64), status: "unknown", result: null, code: "outcome_unknown" };

test("private exact config binds installation and public host pin before any invocation", t => {
  const f = fixture(t), construct = () => new NativeDeviceClient({ executable: f.executable, configPath: f.configPath, installationID: "host_fixture" });
  for (const value of [{ ...f.config, privateKey: "SYNTHETIC-NOT-A-KEY" }, { ...f.config, installationID: "other" }, { ...f.config, hostURL: "https://user:password@127.0.0.1/" }, { ...f.config, hostFingerprint: "c".repeat(64) }]) { f.save(value); assert.throws(construct, e => e instanceof DeviceError); }
  f.save(f.config); chmodSync(f.configPath, 0o644); assert.throws(construct, reject("forbidden")); chmodSync(f.configPath, 0o600);
  rmSync(f.configPath); symlinkSync(join(f.root, "outside-missing"), f.configPath); assert.throws(construct, reject("forbidden")); assert.equal(existsSync(join(f.root, "outside-missing")), false); rmSync(f.configPath); f.save(f.config);
  writeFileSync(f.configPath, "x".repeat(32769)); assert.throws(construct, reject("forbidden")); f.save(f.config);
  chmodSync(f.executable, 0o755); assert.throws(construct, reject("forbidden"));
  chmodSync(f.executable, 0o600); assert.throws(construct, reject("forbidden")); assert.equal(f.calls().length, 0);
});
test("config namespace or executable replacement after construction refuses before spawn", async t => {
  const f = fixture(t), c = f.client(); await f.ready(c); f.save({ ...f.config, installationID: "other" }); await assert.rejects(c.post("device/poll", poll, 20000), reject("forbidden")); assert.equal(f.calls().length, 0);
  f.save(f.config); const second = f.client(); writeFileSync(f.executable, `#!${process.execPath}\nprocess.exit(0);`); await assert.rejects(second.loadOnly(), reject("forbidden")); assert.equal(f.calls().length, 0);
});
test("pre-cancel, invalid route, body identity, getters, sparse arrays and bounds perform zero invocations", async t => {
  const f = fixture(t), c = f.client(), controller = new AbortController(); controller.abort();
  await assert.rejects(c.loadOnly(1000, controller.signal), reject("unavailable")); await assert.rejects(c.post("device/poll", poll, 20000, controller.signal), reject("unavailable"));
  await assert.rejects(c.post("../device/poll", poll, 20000), reject("invalid_input")); await assert.rejects(c.post("device/poll", { ...poll, installationId: "foreign" }, 20000), reject("forbidden"));
  let getters = 0; const bad = { get claimId() { getters++; return "claim_fixture"; } }; await assert.rejects(c.post("pair/status", bad, 20000), reject("invalid_input")); assert.equal(getters, 0);
  let encoded = 0; await assert.rejects(c.post("pair/status", { claimId: "claim_fixture", toJSON() { encoded++; return { claimId: "claim_fixture" }; } }, 20000), reject("invalid_input")); assert.equal(encoded, 0);
  let traps = 0; const proxy = new Proxy({ claimId: "claim_fixture" }, { getPrototypeOf() { traps++; return Object.prototype; }, ownKeys() { traps++; return ["claimId"]; } }); await assert.rejects(c.post("pair/status", proxy, 20000), reject("invalid_input")); assert.equal(traps, 0);
  const sparse: unknown[] = []; sparse[999999999] = null; await assert.rejects(c.post("device/poll", { ...poll, receipts: sparse }, 20000), reject("invalid_input"));
  for (const timeout of [0, NaN, Infinity, 120001]) await assert.rejects(c.post("device/poll", poll, timeout), reject("invalid_input"));
  await assert.rejects(c.post("pair/status", { claimId: "x".repeat(65537) }, 20000), reject("invalid_input")); await assert.rejects(c.post("pair/status", { claimId: "\ud800" }, 20000), reject("invalid_input")); assert.equal(f.calls().length, 0);
});
test("loadOnly validates public DER and policy, uses no provision, and exposes no private paths or keys", async t => {
  const f = fixture(t), c = f.client(), a = await c.loadOnly(20000), b = await c.loadOnly(20000); assert.deepEqual(a, b); assert.equal(a.fingerprint, f.identity.fingerprint); assert.equal(Object.isFrozen(a), true); assert.equal(c.hostFingerprint, f.config.hostFingerprint); assert.equal(Reflect.set(c, "hostFingerprint", "x"), false);
  assert.deepEqual(f.calls().map(x => x.operation), ["load", "load"]); for (const call of f.calls()) { assert.deepEqual(call.argv, ["--config", f.configPath]); assert.ok(call.env.every(key => key === "__CF_USER_TEXT_ENCODING")); assert.equal(call.eof, true); }
  assert.ok(!JSON.stringify(c).includes(f.configPath)); assert.ok(!inspect(c).includes(f.executable)); assert.ok(!JSON.stringify(a).includes("PRIVATE KEY"));
  f.mode({ mode: "normal", policy: "hardware_backed" }); await assert.rejects(c.loadOnly(20000), reject("protocol_error"));
  f.mode({ mode: "normal", fingerprint: "d".repeat(64) }); await assert.rejects(c.loadOnly(20000), reject("protocol_error"));
  const replacement = generateSyntheticIdentity(join(f.root, "replacement-fixture"), "host"), replacementDER = new X509Certificate(replacement.certPem).raw.toString("base64");
  f.mode({ mode: "normal", der: replacementDER, fingerprint: replacement.fingerprint }); await assert.rejects(c.loadOnly(20000), reject("conflict"));
  f.mode({ mode: "normal" }); assert.deepEqual(await c.loadOnly(20000), a);
});
test("four finite request routes use single stdin commands with exact response contracts", async t => {
  const f = fixture(t), c = f.client(); await f.ready(c); assert.deepEqual(await c.post("pair/claim", { offerId: "offer_fixture", code: "synthetic_code", name: "Lab", platform: "macos", capabilities: ["mac.file.append"] }, 20000), { claimId: "claim_fixture", status: "pending" });
  assert.equal((await c.post("pair/status", { claimId: "claim_fixture" }, 20000)).status, "approved"); assert.deepEqual(await c.post("device/poll", poll, 20000), { jobs: [] }); assert.deepEqual(await c.post("device/receipt", { deviceId: "dev_fixture", installationId: "host_fixture", receipt }, 20000), { ack: true });
  assert.deepEqual(f.calls().map(x => x.route), ["/v1/pair/claim", "/v1/pair/status", "/v1/device/poll", "/v1/device/receipt"]); assert.equal(f.calls().length, 4); assert.equal(c.pending, 0);
  const command = { operation: "request", route: "/v1/device/poll", bodyBase64: Buffer.from(JSON.stringify(poll)).toString("base64"), timeoutSeconds: 20, expectedClientFingerprint: f.identity.fingerprint };
  assert.equal(f.calls()[2]!.digest, createHash("sha256").update(JSON.stringify(command) + "\n").digest("hex"));
});
test("status terminal variants retain nullable semantics and cross-installation approved reply is refused", async t => {
  const f = fixture(t), c = f.client(); await f.ready(c);
  for (const status of ["pending", "rejected", "expired", "failed"]) { const value = { status, deviceId: null, installationId: null, ownerId: null }; f.mode({ response: value }); assert.deepEqual(await c.post("pair/status", { claimId: "claim_fixture" }, 20000), value); }
  for (const response of [{ status: "approved", deviceId: "dev_fixture", installationId: "foreign", ownerId: "owner_fixture" }, { status: "pending", deviceId: "dev_fixture", installationId: null, ownerId: null }, { ack: true, arbitrary: "SYNTHETIC" }, { ack: false }, { jobs: [null] }]) { f.mode({ response }); const route = "ack" in response ? "device/receipt" : "jobs" in response ? "device/poll" : "pair/status"; const body = route === "device/receipt" ? { deviceId: "dev_fixture", installationId: "host_fixture", receipt } : route === "device/poll" ? poll : { claimId: "claim_fixture" }; await assert.rejects(c.post(route, body, 20000), reject("outcome_unknown")); }
});
test("fixed helper failures discard diagnostics, never provision/fallback, and ambiguous network failures become unknown", async t => {
  const f = fixture(t), c = f.client();
  for (const [input, output] of [["missing", "not_found"], ["locked", "unavailable"], ["nonExportabilityUnconfirmed", "unsupported"], ["pinMismatch", "tls_pin_mismatch"], ["tls_pin_mismatch", "tls_pin_mismatch"], ["invalidInput", "invalid_input"], ["forbidden", "forbidden"]]) { f.mode({ error: input }); await assert.rejects(c.loadOnly(20000), reject(output!)); }
  f.mode({ error: "SYNTHETIC-SECRET-DIAGNOSTIC" }); await assert.rejects(c.loadOnly(20000), e => e instanceof DeviceError && e.code === "protocol_error" && !String(e).includes("SYNTHETIC"));
  f.mode({ error: "locked", extra: { diagnostic: "SYNTHETIC-SECRET" } }); await assert.rejects(c.loadOnly(20000), reject("protocol_error"));
  f.mode({ mode: "normal" }); await f.ready(c);
  for (const input of ["timeout", "cancelled", "unavailable", "protocol_error", "UNKNOWN"]) { f.mode({ error: input }); await assert.rejects(c.post("device/poll", poll, 20000), reject("outcome_unknown")); }
  assert.ok(f.calls().every(x => x.operation === "load" || x.operation === "request"));
});
test("malformed JSON/base64, nonzero success, stdout and stderr limits discard every body", async t => {
  const f = fixture(t), c = f.client(); await f.ready(c);
  for (const behavior of [{ stdout: '{"ok":true}\n{"ok":true}\n' }, { stdout: '{"ok":true,"responseBase64":"!"}\n' }, { stdout: '{"ok":true,"responseBase64":"W10="}\n' }, { code: 7 }, { mode: "flood" }, { mode: "stderr" }]) { f.mode(behavior); await assert.rejects(c.post("device/poll", poll, 20000), e => e instanceof DeviceError && e.code === "outcome_unknown" && !String(e).includes("SYNTHETIC")); assert.equal(c.pending, 0); }
});
test("abort after handoff waits for real helper exit and never retries its ambiguous request", async t => {
  const f = fixture(t), c = f.client(), controller = new AbortController(); await f.ready(c); f.mode({ mode: "hang" }); let settled = false;
  const result = c.post("device/poll", poll, 2000, controller.signal); void result.catch(() => { settled = true; }); await until(() => f.calls().length === 1); controller.abort();
  await new Promise(r => setTimeout(r, 30)); assert.equal(settled, false); assert.equal(c.pending, 1); const close = c.close(); assert.equal(c.close(), close); let closed = false; void close.then(() => { closed = true; }); await new Promise(r => setTimeout(r, 20)); assert.equal(closed, false);
  await assert.rejects(result, reject("outcome_unknown")); await close; assert.equal(c.pending, 0); assert.equal(f.calls().length, 1); assert.throws(() => process.kill(f.calls()[0]!.pid, 0)); await assert.rejects(c.post("device/poll", poll, 20000), reject("unavailable"));
});
test("timeout discards a late success, holds drain until process exit, and does not resend", async t => {
  const f = fixture(t), c = f.client(); await f.ready(c); f.mode({ mode: "late", delay: 1000 }); const start = Date.now(); let done = false;
  const result = c.post("device/poll", poll, 900); void result.catch(() => { done = true; }); await until(() => f.calls().length === 1); await until(() => Date.now() - start >= 930); assert.equal(done, false); assert.equal(c.pending, 1);
  await assert.rejects(result, reject("outcome_unknown")); assert.ok(Date.now() - start >= 1000); assert.equal(c.pending, 0); assert.equal(f.calls().length, 1); assert.throws(() => process.kill(f.calls()[0]!.pid, 0));
});
test("bounded concurrent admissions and cached close await all confirmed process exits", async t => {
  const f = fixture(t), c = f.client(); f.mode({ mode: "hang" }); const results = Array.from({ length: 16 }, () => c.loadOnly(20000)); const outcomes = results.map(p => p.catch(e => e));
  await assert.rejects(c.loadOnly(20000), reject("unavailable")); await until(() => f.calls().length === 16); assert.equal(c.pending, 16); await c.close(); for (const value of await Promise.all(outcomes)) assert.ok(value instanceof DeviceError && value.code === "unavailable"); assert.equal(c.pending, 0); for (const call of f.calls()) assert.throws(() => process.kill(call.pid, 0));
});
test("missing interpreter spawn failure skips invalid PID kill and drains without invocation", async t => {
  const f = fixture(t); writeFileSync(f.executable, "#!/nonexistent-dexter-fixture-interpreter\n", { mode: 0o700 }); const c = f.client(); await assert.rejects(c.loadOnly(20000), reject("unavailable")); await c.close(); assert.equal(c.pending, 0); assert.equal(f.calls().length, 0);
});

test("prototype helper error names stay protocol_error on load and outcome_unknown after network handoff", async t => {
  const f = fixture(t), c = f.client(); await f.ready(c);
  for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
    f.mode({ error: name });
    await assert.rejects(c.loadOnly(20000), reject("protocol_error"));
    await assert.rejects(c.post("device/poll", poll, 20000), reject("outcome_unknown"));
  }
  assert.equal(c.pending, 0); assert.equal(f.calls().length, 10);
});
test("BOM helper envelopes and BOM response JSON are refused with fixed codes", async t => {
  const f = fixture(t), c = f.client(); await f.ready(c);
  f.mode({ stdout: "\ufeff" + JSON.stringify({ ok: true, certificateDER: f.der, fingerprint: f.identity.fingerprint, policy: "secure_enclave_data_protection_keychain_device_only" }) });
  await assert.rejects(c.loadOnly(20000), reject("protocol_error"));
  f.mode({ stdout: "\ufeff" + JSON.stringify({ ok: true, responseBase64: Buffer.from('{"jobs":[]}').toString("base64") }) });
  await assert.rejects(c.post("device/poll", poll, 20000), reject("outcome_unknown"));
  f.mode({ stdout: JSON.stringify({ ok: true, responseBase64: Buffer.from('\ufeff{"jobs":[]}').toString("base64") }) });
  await assert.rejects(c.post("device/poll", poll, 20000), reject("outcome_unknown"));
});
test("every sparse array hole including a leading nested result hole is refused before spawn", async t => {
  const f = fixture(t), c = f.client(); await f.ready(c);
  const leading = new Array<unknown>(2); leading[1] = "present";
  const middle = ["first", "second", "third"]; delete middle[1];
  const trailing = new Array<unknown>(2); trailing[0] = "present";
  for (const items of [leading, middle, trailing, new Array<unknown>(3)]) {
    const completed = { ...receipt, status: "completed", result: { items }, code: null };
    await assert.rejects(c.post("device/receipt", { deviceId: poll.deviceId, installationId: poll.installationId, receipt: completed }, 20000), reject("invalid_input"));
  }
  assert.equal(f.calls().length, 0);
  const completed = { ...receipt, status: "completed", result: { items: [null, "present"] }, code: null };
  assert.deepEqual(await c.post("device/receipt", { deviceId: poll.deviceId, installationId: poll.installationId, receipt: completed }, 20000), { ack: true });
});
test("network posts require explicit successful load and carry its exact immutable expected fingerprint", async t => {
  const f = fixture(t), c = f.client(); await assert.rejects(c.post("device/poll", poll, 20000), reject("unavailable")); assert.equal(f.calls().length, 0);
  f.mode({ error: "locked" }); await assert.rejects(c.loadOnly(20000), reject("unavailable"));
  await assert.rejects(c.post("device/poll", poll, 20000), reject("unavailable")); assert.deepEqual(f.calls().map(call => call.operation), ["load"]);
  f.mode({ mode: "normal" }); await f.ready(c); await c.post("device/poll", poll, 20000);
  const command = { operation: "request", route: "/v1/device/poll", bodyBase64: Buffer.from(JSON.stringify(poll)).toString("base64"), timeoutSeconds: 20, expectedClientFingerprint: f.identity.fingerprint };
  assert.equal(f.calls()[0]!.digest, createHash("sha256").update(JSON.stringify(command) + "\n").digest("hex")); assert.equal(f.calls().length, 1);
});
test("SIGKILL escalation confirms leader and same-group grandchild exit before local drain", async t => {
  const f = fixture(t), c = f.client(); await f.ready(c); f.mode({ mode: "group" });
  const result = c.post("device/poll", poll, 20000).then(() => "RESOLVED", e => e instanceof DeviceError ? e.code : "OTHER");
  await until(() => f.grandchild() !== null && existsSync(join(f.root, "grandchild.ready")), 18000);
  const grand = f.grandchild()!, started = Date.now(), closing = c.close();
  assert.equal(await bounded(result), "outcome_unknown"); await closing; assert.ok(Date.now() - started >= 200);
  await until(() => !alive(grand.pid), 8000); assert.equal(c.pending, 0); assert.equal(f.calls().length, 1); assert.equal(alive(f.calls()[0]!.pid), false);
});
test("detached grandchild holding stdout keeps actual close pending until its owned pipe exits", async t => {
  const f = fixture(t), c = f.client(); await f.ready(c); f.mode({ mode: "detached" });
  const result = c.post("device/poll", poll, 20000).then(() => "RESOLVED", e => e instanceof DeviceError ? e.code : "OTHER");
  await until(() => f.grandchild() !== null && existsSync(join(f.root, "grandchild.ready")) && f.calls().length === 1 && !alive(f.calls()[0]!.pid), 18000);
  assert.equal(await bounded(result, 500), "STILL_PENDING"); assert.equal(c.pending, 1);
  const closing = c.close(); assert.equal(c.close(), closing); assert.equal(await bounded(closing, 500), "STILL_PENDING");
  const grand = f.grandchild()!; process.kill(grand.pid, "SIGKILL"); await until(() => !alive(grand.pid), 8000);
  assert.equal(await bounded(result), "outcome_unknown"); assert.notEqual(await bounded(closing), "STILL_PENDING"); assert.equal(c.pending, 0); assert.equal(f.calls().length, 1);
});
