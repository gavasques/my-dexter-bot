// DeviceServices.tools (DeviceToolsPort) over a real HostStore, pairing registry and TLS 1.3 loopback
// listener, with MacDeviceDaemon peers in process and one in a separate process. Synthetic identities in
// private temp dirs only; no engine, account, Keychain, UI or non-loopback network. Not production wiring.
import assert from "node:assert/strict";
import { sendMemoryIdentity } from "./fixtures/memory-identity-channel.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Action, JsonValue } from "@dexter/contracts";
import { canonicalJson, HostError, HostStore } from "@dexter/hub";
import {
  DEVICE_OPERATIONS, DeviceError, DeviceHostServer, DevicePairingRegistry, FILE_APPEND, MacDeviceDaemon, createFixtureHandlers, deviceOperationSchemaHash, generateSyntheticIdentity, pairDevice,
  type HostTrust, type TlsIdentity,
} from "@dexter/devices";
import type { DevicePinSnapshot } from "../packages/cli/src/device-turn-surface.js";
const { DeviceServices } = await import(pathToFileURL(resolve("packages/cli/dist/device-services.js")).href) as typeof import("../packages/cli/src/device-services.js");
const { DeviceDispatchPreflightError, DeviceTurnSurface } = await import(pathToFileURL(resolve("packages/cli/dist/device-turn-surface.js")).href) as typeof import("../packages/cli/src/device-turn-surface.js");
type Services = InstanceType<typeof DeviceServices>;

const until = async (check: () => boolean, ms = 8_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("until timeout"); await new Promise((r) => setTimeout(r, 10)); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hostCode = (c: string) => (e: unknown) => e instanceof HostError && e.code === c;
const preflight = (c: string) => (e: unknown) => DeviceDispatchPreflightError.is(e) && e.code === c;
const generic = (e: unknown) => !DeviceDispatchPreflightError.is(e);

async function lab(t: TestContext, options: { pollWaitMs?: number; receiptTimeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dexter-tools-port-"));
  chmodSync(root, 0o700);
  const ids = { host: generateSyntheticIdentity(join(root, "id-host"), "host"), dev: generateSyntheticIdentity(join(root, "id-dev"), "dev"),
    next: generateSyntheticIdentity(join(root, "id-next"), "next") };
  const dataDir = join(root, "host");
  const store = new HostStore({ dataDir });
  const config = { identity: ids.host, pollWaitMs: options.pollWaitMs ?? 100, receiptTimeoutMs: options.receiptTimeoutMs ?? 3_000 };
  let services: Services = new DeviceServices(store, config);
  const url = await services.start();
  const trust: HostTrust = { hostUrl: url, hostCertPem: ids.host.certPem, hostFingerprint: ids.host.fingerprint };
  const fixtures = join(root, "fixtures");
  mkdirSync(fixtures, { mode: 0o700 });
  const daemons: MacDeviceDaemon[] = [];
  const children: ChildProcess[] = [];
  const cleanups: Array<() => void> = [];
  t.after(async () => {
    writeFileSync(join(fixtures, "release"), "release");
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.all(children.map((c) => c.exitCode !== null || c.signalCode !== null ? null : new Promise((r) => c.once("exit", r))));
    for (const d of daemons) await d.stop().catch(() => undefined);
    for (const fn of cleanups) fn();
    await services.close().catch(() => undefined);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const l = {
    root, dataDir, store, ids, trust, fixtures, cleanups, get services() { return services; },
    async restartServices() { await services.close(); services = new DeviceServices(store, config); await services.start(); },
    async pair(identity: TlsIdentity = ids.dev, dir = join(root, "mac")): Promise<string> {
      const bundle = services.admin.pairingBundle({ kind: "pair" });
      const pairing = pairDevice({ dataDir: dir, identity, trust, offerId: bundle.offerId, code: bundle.code, name: "Fixture Mac", capabilities: [FILE_APPEND], pollIntervalMs: 20 });
      await until(() => services.admin.pendingClaims().length === 1);
      services.admin.approveClaim(services.admin.pendingClaims()[0]!.claimId);
      return (await pairing).deviceId;
    },
    async rotate(deviceId: string, identity: TlsIdentity = ids.next, dir = join(root, "mac")): Promise<void> {
      const bundle = services.admin.pairingBundle({ kind: "rotate", deviceId });
      const rotating = pairDevice({ dataDir: dir, identity, trust, offerId: bundle.offerId, code: bundle.code, name: "Fixture Mac", capabilities: [FILE_APPEND], pollIntervalMs: 20 });
      await until(() => services.admin.pendingClaims().length === 1);
      services.admin.approveClaim(services.admin.pendingClaims()[0]!.claimId);
      await rotating;
    },
    daemon(identity: TlsIdentity = ids.dev, beforeEffect?: () => Promise<void>, dir = join(root, "mac")): MacDeviceDaemon {
      const d = new MacDeviceDaemon({ dataDir: dir, identity, trust, pollTimeoutMs: 5_000,
        handlers: createFixtureHandlers({ root: fixtures, enable: [FILE_APPEND], ...(beforeEffect ? { beforeEffect } : {}) }) });
      daemons.push(d);
      return d;
    },
    async child(): Promise<ChildProcess> {
      const dir = join(root, "mac"), identityDir = join(root, "id-dev");
      const configPath = join(root, `peer-${children.length}.json`);
      writeFileSync(configPath, JSON.stringify({ dataDir: dir, identityDir, fixtureRoot: fixtures, name: "Fixture Mac", capabilities: [FILE_APPEND],
        hostUrl: url, hostCertPath: join(root, "id-host", "cert.pem"), hostFingerprint: ids.host.fingerprint }), { mode: 0o600 });
      const entry = resolve("packages/devices/dist/daemon-main.js");
      const preload = fileURLToPath(new URL("./fixtures/device-memory-preload.js", import.meta.url));
      // Only this owned real daemon entry/config receives the bounded anonymous LAB identity IPC.
      const child = spawn(process.execPath, ["--import", preload, entry, "--config", configPath], { shell: false, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { PATH: process.env.PATH } });
      child.stdout!.resume(); child.stderr!.resume(); children.push(child);
      try { await sendMemoryIdentity(child, ids.dev); }
      catch (error) { child.kill("SIGTERM"); throw error; }
      return child;
    },
    grant(deviceId: string, policy: "allow" | "ask" | "deny" = "allow") {
      const bot = store.createBot({ name: "Fixture", profileId: "lab", engine: "claude" }), thread = store.createThread(bot.id);
      services.admin.grant({ botId: bot.id, tool: FILE_APPEND, destination: deviceId, policy });
      let n = 0;
      return { bot, thread, request: (line = "once") => store.requestAction({ botId: bot.id, threadId: thread.id, tool: FILE_APPEND, destination: deviceId,
        arguments: { name: "notes.txt", line }, idempotencyKey: `k${++n}` }) };
    },
    lines(): number { const p = join(fixtures, "notes.txt"); return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).length : 0; },
  };
  return l;
}
/** Records each guard consultation; `decide(n)` answers the n-th call (1 = enqueue, 2 = delivery, 3 = receipt). */
function recorder(decide: (n: number, peer: DevicePinSnapshot) => boolean = () => true) {
  const calls: Array<{ action: Action; peer: DevicePinSnapshot }> = [];
  return { calls, guard: (action: Action, peer: DevicePinSnapshot): boolean => { calls.push({ action, peer }); return decide(calls.length, peer); } };
}
const live = () => new AbortController().signal;

test("tools is one frozen trusted port: owner snapshot from persisted bindings, canonical 8 operations, generations across restart", async (t) => {
  const l = await lab(t);
  const port = l.services.tools;
  assert.equal(l.services.tools, port);
  assert.ok(Object.isFrozen(port));
  assert.equal(port.installationId, l.store.hostId);
  assert.equal(port.ownerId, l.store.ownerId);
  assert.throws(() => { (port as { dispatchBound: unknown }).dispatchBound = () => null; });
  const id = await l.pair();
  assert.deepEqual({ ...port.snapshot(id)! }, { installationId: l.store.hostId, ownerId: l.store.ownerId, deviceId: id, fingerprint: l.ids.dev.fingerprint, generation: 1, revision: 1, status: "active" });
  assert.equal(port.snapshot("dev_unknown"), null);
  assert.equal(port.authenticatedPresence(id), "stale", "approval is not presence");
  await l.rotate(id);
  await l.restartServices();
  const after = l.services.tools.snapshot(id)!;
  assert.deepEqual([after.fingerprint, after.generation, after.revision, after.status], [l.ids.next.fingerprint, 2, 2, "active"]);
  l.services.http.revoke(id);
  assert.deepEqual([l.services.tools.snapshot(id)!.generation, l.services.tools.snapshot(id)!.revision, l.services.tools.snapshot(id)!.status], [2, 3, "revoked"]);
  assert.equal(l.services.tools.authenticatedPresence(id), "revoked");
  // Operations: exactly the declared, current canonical set; hashes recomputed from published fields only.
  assert.equal(DEVICE_OPERATIONS.size, 9);
  for (const [tool, declared] of DEVICE_OPERATIONS) {
    const op = l.services.tools.operation(tool);
    assert.ok(Object.isFrozen(op) && Object.isFrozen(op.inputSchema));
    const recomputed = createHash("sha256").update(canonicalJson({ version: op.version, tool: op.tool, effect: op.effect, description: op.description, inputSchema: op.inputSchema } as unknown as JsonValue)).digest("hex");
    assert.equal(op.schemaHash, recomputed);
    assert.equal(op.schemaHash, deviceOperationSchemaHash(declared));
    assert.equal(op.version, declared.version);
    assert.throws(() => op.validate({ unexpected: true }));
  }
  assert.deepEqual(l.services.tools.operation(FILE_APPEND).validate({ name: "a.txt", line: "x" }), { name: "a.txt", line: "x" });
  assert.throws(() => l.services.tools.operation("mac.browser.cdp"), hostCode("invalid_input"));
  assert.throws(() => l.services.tools.operation("mac.shell.exec"), hostCode("invalid_input"));
  // Status never exposes pins or bindings.
  assert.deepEqual(Object.keys(l.services.status()).sort(), ["listening", "pendingDispatches"]);
});

test("guarded dispatch: guard sees frozen running action and persisted pin at enqueue, delivery and receipt; one effect", async (t) => {
  const l = await lab(t);
  const id = await l.pair();
  const d = l.daemon();
  await d.runOnce();
  assert.equal(l.services.tools.authenticatedPresence(id), "online");
  const action = l.grant(id).request();
  const r = recorder();
  const [done, run] = await Promise.all([l.services.tools.dispatchBound(action.id, { signal: live(), guard: r.guard }), d.runOnce()]);
  assert.equal(done.state, "succeeded");
  assert.equal(run.jobs, 1);
  assert.equal(l.lines(), 1);
  assert.equal(r.calls.length, 3);
  for (const call of r.calls) {
    assert.ok(Object.isFrozen(call.action) && Object.isFrozen(call.action.request.arguments) && Object.isFrozen(call.peer));
    assert.equal(call.action.state, "running");
    assert.equal(call.action.id, action.id);
    assert.deepEqual({ ...call.peer }, { ...l.services.tools.snapshot(id)! });
  }
  // Replay of a terminal action is read-only.
  assert.equal((await l.services.tools.dispatchBound(action.id, { signal: live(), guard: () => true })).state, "succeeded");
  assert.equal(l.lines(), 1);
});

test("separate-process daemon: guarded dispatch over TLS appends once", async (t) => {
  const l = await lab(t);
  const id = await l.pair();
  await l.child();
  await until(() => l.services.tools.authenticatedPresence(id) === "online");
  const done = await l.services.tools.dispatchBound(l.grant(id).request("child").id, { signal: live(), guard: () => true });
  assert.equal(done.state, "succeeded");
  assert.equal(readFileSync(join(l.fixtures, "notes.txt"), "utf8"), "child\n");
});

test("preflight refusals have no effect, leave the action pre-claim and never hold the writer", async (t) => {
  const l = await lab(t);
  const id = await l.pair();
  const g = l.grant(id);
  const offline = g.request("offline");
  await assert.rejects(l.services.tools.dispatchBound(offline.id, { signal: live(), guard: () => true }), preflight("unavailable"));
  assert.equal(l.store.getAction(offline.id).state, "ready");
  const d = l.daemon();
  await d.runOnce();
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(l.services.tools.dispatchBound(offline.id, { signal: aborted.signal, guard: () => true }), preflight("unavailable"));
  await assert.rejects(l.services.tools.dispatchBound(offline.id, { signal: live(), guard: "yes" as unknown as () => boolean }), preflight("conflict"));
  await assert.rejects(l.services.tools.dispatchBound(offline.id, null as unknown as { signal: AbortSignal; guard: () => boolean }), preflight("conflict"));
  const asking = l.grant(id, "ask").request("ask");
  assert.equal(asking.state, "awaiting_approval");
  await assert.rejects(l.services.tools.dispatchBound(asking.id, { signal: live(), guard: () => true }), preflight("conflict"));
  assert.equal(l.store.getAction(offline.id).state, "ready");
  assert.equal(l.services.status().pendingDispatches, 0);
  assert.equal((await d.runOnce()).jobs, 0);
  assert.equal(l.lines(), 0);
  l.services.stopAdmission();
  await assert.rejects(l.services.tools.dispatchBound(offline.id, { signal: live(), guard: () => true }), preflight("unavailable"));
  assert.throws(() => l.services.tools.snapshot(id), hostCode("conflict"));
  await l.services.close(); // offline/refused work never pins the writer
  l.store.close();
  const reopened = new HostStore({ dataDir: l.dataDir });
  assert.equal(reopened.getAction(offline.id).state, "ready");
  reopened.close();
  // Keep teardown idempotent.
  (l.store as unknown as { close(): void }).close = () => undefined;
});

test("N2: revoked devices block pre-existing HTTP/bound actions and refuse fresh admission; offline unrevoked stays ready/503", async (t) => {
  const l = await lab(t);
  const id = await l.pair();
  const g = l.grant(id);
  const staleHttp = g.request("stale-http"), staleBound = g.request("stale-bound");
  assert.deepEqual([staleHttp.state, staleBound.state], ["ready", "ready"]);
  await assert.rejects(l.services.http.dispatch(staleHttp.id), hostCode("device_unavailable"));
  assert.equal(l.store.getAction(staleHttp.id).state, "ready");
  assert.equal(l.store.getAction(staleBound.id).state, "ready");
  l.services.http.revoke(id);
  for (const action of [staleHttp, staleBound]) {
    assert.deepEqual([l.store.getAction(action.id).state, l.store.getAction(action.id).reason], ["blocked", "permission_changed"], "revocation durably blocks both pending paths");
    assert.equal(l.store.getAction(action.id).result, null);
  }
  // Already terminal HTTP actions replay without dispatch; bound dispatch returns the same blocked result.
  assert.equal((await l.services.http.dispatch(staleHttp.id)).state, "blocked");
  let guardCalls = 0;
  const result = await l.services.tools.dispatchBound(staleBound.id, { signal: live(), guard: () => { guardCalls++; throw new Error("guard must not run"); } });
  assert.deepEqual([result.state, result.reason], ["blocked", "permission_changed"]);
  assert.equal(result.result, null);
  assert.equal(guardCalls, 0);
  const actionsBeforeFresh = l.store.listActions().length, eventsBeforeFresh = l.store.listEvents(0, 1000).length;
  for (const line of ["after-revoke-http", "after-revoke-port"]) {
    assert.throws(() => g.request(line), hostCode("forbidden"));
    assert.equal(l.store.listActions().length, actionsBeforeFresh, "fresh revoked request refuses before insert");
    assert.equal(l.store.listEvents(0, 1000).length, eventsBeforeFresh, "fresh revoked request emits no event");
  }
  // Terminal replay stays read-only after the fresh refusals as well.
  assert.deepEqual([(await l.services.http.dispatch(staleHttp.id)).state, l.store.getAction(staleHttp.id).reason], ["blocked", "permission_changed"]);
  assert.equal(l.store.listActions().length, actionsBeforeFresh);
  assert.equal(l.store.listEvents(0, 1000).length, eventsBeforeFresh);
  assert.equal(l.services.status().pendingDispatches, 0);
  assert.equal(l.lines(), 0);
  await l.services.close();
});

test("guard refusals: at enqueue (nothing sent), after the long-poll (nothing sent) and after the receipt (unknown, effect not published)", async (t) => {
  const l = await lab(t, { pollWaitMs: 1_000 });
  const id = await l.pair();
  const d = l.daemon();
  await d.runOnce();
  const g = l.grant(id);
  const enqueue = g.request("enqueue");
  const atEnqueue = await l.services.tools.dispatchBound(enqueue.id, { signal: live(), guard: () => false });
  assert.deepEqual([atEnqueue.state, atEnqueue.reason], ["unknown", "executor_error"]);
  assert.equal((await d.runOnce()).jobs, 0);
  // The daemon is already waiting in its long-poll when the job is queued; the guard flips before delivery.
  const polling = d.runOnce();
  await sleep(250);
  const r = recorder((n) => n === 1);
  const afterPoll = await l.services.tools.dispatchBound(g.request("after-poll").id, { signal: live(), guard: r.guard });
  assert.equal(afterPoll.state, "unknown");
  assert.equal((await polling).jobs, 0);
  assert.equal(r.calls.length, 2);
  assert.equal(l.lines(), 0);
  const receipt = recorder((n) => n < 3);
  const action = g.request("receipt");
  const [late] = await Promise.all([l.services.tools.dispatchBound(action.id, { signal: live(), guard: receipt.guard }), d.runOnce()]);
  assert.deepEqual([late.state, late.result], ["unknown", null]);
  assert.equal(l.lines(), 1, "the effect happened once; its result is not published");
  assert.equal((await l.services.tools.dispatchBound(action.id, { signal: live(), guard: () => true })).state, "unknown");
  assert.equal((await d.runOnce()).jobs, 0);
  assert.equal(l.lines(), 1);
});

test("pin rotation with a queued job: the bound guard refuses the new pin; unguarded legacy would deliver to it", async (t) => {
  const l = await lab(t);
  const id = await l.pair();
  const old = l.daemon();
  await old.runOnce();
  const saved = l.services.tools.snapshot(id)!;
  const g = l.grant(id);
  const guard = (_a: Action, peer: DevicePinSnapshot) => peer.fingerprint === saved.fingerprint && peer.generation === saved.generation && peer.revision === saved.revision;
  const queued = l.services.tools.dispatchBound(g.request("bound").id, { signal: live(), guard });
  await old.stop();
  await l.rotate(id);
  assert.equal(l.services.tools.snapshot(id)!.generation, 2);
  const fresh = l.daemon(l.ids.next);
  assert.equal((await fresh.runOnce()).jobs, 0, "nothing reaches the rotated pin");
  assert.equal((await queued).state, "unknown");
  assert.equal(l.lines(), 0);
  // Counterfactual for the same rotation window without a bound guard (legacy contract).
  const legacy = g.request("legacy");
  const [delivered] = await Promise.all([l.services.http.dispatch(legacy.id), fresh.runOnce()]);
  assert.equal(delivered.state, "succeeded");
  assert.equal(l.lines(), 1);
});

test("grant revocation while queued, cancellation and drain end unknown with no redelivery", async (t) => {
  const l = await lab(t);
  const id = await l.pair();
  const d = l.daemon();
  await d.runOnce();
  const g = l.grant(id);
  const revoked = l.services.tools.dispatchBound(g.request("grant").id, { signal: live(), guard: () => true });
  l.services.admin.grant({ botId: g.bot.id, tool: FILE_APPEND, destination: id, policy: "deny" });
  assert.equal((await d.runOnce()).jobs, 0);
  assert.equal((await revoked).state, "unknown");
  l.services.admin.grant({ botId: g.bot.id, tool: FILE_APPEND, destination: id, policy: "allow" });
  const controller = new AbortController();
  const cancelled = g.request("cancel");
  const pending = l.services.tools.dispatchBound(cancelled.id, { signal: controller.signal, guard: () => true });
  controller.abort();
  assert.equal((await pending).state, "unknown");
  assert.equal((await d.runOnce()).jobs, 0);
  assert.equal((await l.services.tools.dispatchBound(cancelled.id, { signal: live(), guard: () => true })).state, "unknown");
  assert.equal(l.lines(), 0);
  // Drain with a job the daemon holds: close settles it unknown and releases cleanly.
  let entered = false, release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await d.stop();
  const held = l.daemon(l.ids.dev, async () => { entered = true; await gate; });
  await held.runOnce();
  const draining = l.services.tools.dispatchBound(g.request("drain").id, { signal: live(), guard: () => true });
  const run = held.runOnce().catch(() => null);
  await until(() => entered);
  await l.services.close();
  assert.equal((await draining).state, "unknown");
  release();
  await run;
  assert.throws(() => l.services.tools.snapshot(id), hostCode("conflict"));
});

test("one flight per action: duplicates cannot swap or downgrade the guard; context is read once", async (t) => {
  const l = await lab(t);
  const id = await l.pair();
  const d = l.daemon();
  await d.runOnce();
  const action = l.grant(id).request();
  const first = recorder();
  const context = { signal: live(), guard: first.guard };
  const flight = l.services.tools.dispatchBound(action.id, context);
  context.guard = () => false;
  const second = recorder(() => false);
  await assert.rejects(l.services.tools.dispatchBound(action.id, { signal: live(), guard: second.guard }), (e: unknown) => generic(e) && hostCode("conflict")(e));
  const coalesced = l.services.http.dispatch(action.id);
  const [done, viaHttp] = await Promise.all([flight, coalesced, d.runOnce()]);
  assert.equal(done.state, "succeeded");
  assert.equal(viaHttp.state, "succeeded");
  assert.equal(first.calls.length, 3);
  assert.equal(second.calls.length, 0);
  assert.equal(l.lines(), 1);
});

test("borrowed port refuses after a lost writer; turn ownership closes the legacy HTTP bypass", async (t) => {
  const l = await lab(t);
  const id = await l.pair();
  const d = l.daemon();
  await d.runOnce();
  const g = l.grant(id);
  const owned = g.request("owned"), free = g.request("free");
  l.services.attachTurnOwnership((actionId) => actionId === owned.id);
  assert.throws(() => l.services.attachTurnOwnership(() => false), hostCode("conflict"));
  await assert.rejects(l.services.http.dispatch(owned.id), hostCode("forbidden"));
  assert.equal(l.store.getAction(owned.id).state, "ready");
  const [ok] = await Promise.all([l.services.http.dispatch(free.id), d.runOnce()]);
  assert.equal(ok.state, "succeeded");
  const raw = new DatabaseSync(l.store.databasePath);
  const token = (raw.prepare("SELECT token FROM host_lease WHERE id = 1").get() as { token: string }).token;
  raw.exec("UPDATE host_lease SET token = 'stolen-by-test'");
  try {
    assert.throws(() => l.services.tools.snapshot(id), hostCode("host_locked"));
    assert.throws(() => l.services.tools.authenticatedPresence(id), hostCode("host_locked"));
    await assert.rejects(l.services.tools.dispatchBound(owned.id, { signal: live(), guard: () => true }), (e: unknown) => generic(e) && hostCode("host_locked")(e));
  } finally {
    raw.prepare("UPDATE host_lease SET token = ? WHERE id = 1").run(token);
    raw.close();
  }
  assert.equal(l.store.getAction(owned.id).state, "ready");
  assert.equal(l.lines(), 1);
});

for (const path of ["port", "http"] as const) {
  test(`N3 (${path}): real completeAction and markUnknown failures leave the action running; close rejects permanently and keeps the writer`, async (t) => {
    const l = await lab(t);
    const id = await l.pair();
    const d = l.daemon();
    await d.runOnce();
    const action = l.grant(id).request();
    const store = l.store as unknown as { completeAction: unknown; markUnknown: unknown };
    const original = { completeAction: store.completeAction, markUnknown: store.markUnknown };
    const failure = () => { throw new HostError("conflict", "fixture finalization failure"); };
    store.completeAction = failure; store.markUnknown = failure;
    l.cleanups.push(() => {
      Object.assign(store, original);
      if (l.store.getAction(action.id).state === "running") l.store.markUnknown(action.id, "executor_error");
    });
    const dispatched = path === "port"
      ? l.services.tools.dispatchBound(action.id, { signal: live(), guard: () => true })
      : l.services.http.dispatch(action.id);
    const [outcome] = await Promise.allSettled([dispatched, d.runOnce()]);
    assert.equal(outcome.status, "rejected");
    assert.ok(generic((outcome as PromiseRejectedResult).reason), "never the pre-claim marker after a claim");
    assert.equal(l.store.getAction(action.id).state, "running");
    assert.equal(l.lines(), 1);
    const closing = l.services.close();
    await assert.rejects(closing, hostCode("conflict"));
    assert.equal(l.services.close(), closing, "cached rejection");
    await assert.rejects(l.services.close(), hostCode("conflict"));
    assert.throws(() => new HostStore({ dataDir: l.dataDir }), hostCode("host_locked"));
    assert.throws(() => l.services.tools.snapshot(id), hostCode("conflict"));
    await assert.rejects(l.services.tools.dispatchBound(action.id, { signal: live(), guard: () => true }), preflight("unavailable"));
  });
}

test("real DeviceTurnSurface over the real port: one canonical action, one effect; rotation hides the route", async (t) => {
  const l = await lab(t);
  const id = await l.pair();
  const d = l.daemon();
  await d.runOnce();
  const bot = l.store.createBot({ name: "Surface", profileId: "lab", engine: "claude" });
  const thread = l.store.createThread(bot.id);
  const turn = l.store.createTurn(thread.id, { clientRequestId: "fixture", content: "synthetic" }).turn;
  l.store.claimNextTurn(thread.id);
  const surface = new DeviceTurnSurface(l.store, l.services.tools);
  t.after(() => surface.close().catch(() => undefined));
  l.services.admin.grant({ botId: bot.id, tool: FILE_APPEND, destination: id, policy: "allow" });
  const route = surface.admin.bindRoute({ botId: bot.id, deviceId: id, tool: FILE_APPEND });
  const { token } = surface.issueCapability({ turnId: turn.id });
  assert.equal(surface.listTools(token).length, 1);
  const [result] = await Promise.all([surface.call(token, { tool: FILE_APPEND, connectionId: route.id, callId: "c1", arguments: { name: "notes.txt", line: "surface" } }), d.runOnce()]);
  assert.equal(result.status, "succeeded");
  assert.equal(l.store.listActions().length, 1);
  assert.equal(l.lines(), 1);
  await d.stop();
  await l.rotate(id);
  assert.deepEqual(surface.listTools(token), []);
  await surface.close();
});

test("DeviceHostServer: a raw duplicate or parallel dispatch can neither replace nor settle the bound guard", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dexter-raw-guard-"));
  chmodSync(root, 0o700);
  const host = generateSyntheticIdentity(join(root, "id-host"), "host"), dev = generateSyntheticIdentity(join(root, "id-dev"), "dev");
  const store = new HostStore({ dataDir: join(root, "host") });
  const registry = new DevicePairingRegistry(store);
  const server = new DeviceHostServer({ store, registry, identity: host, pollWaitMs: 100, receiptTimeoutMs: 3_000 });
  const trust: HostTrust = { hostUrl: await server.start(), hostCertPem: host.certPem, hostFingerprint: host.fingerprint };
  const fixtures = join(root, "fixtures");
  mkdirSync(fixtures, { mode: 0o700 });
  let d: MacDeviceDaemon | null = null;
  t.after(async () => { await d?.stop().catch(() => undefined); await server.close(); registry.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const offer = server.pairingBundle({ kind: "pair" });
  const pairing = pairDevice({ dataDir: join(root, "mac"), identity: dev, trust, offerId: offer.offerId, code: offer.code, name: "Fixture Mac", capabilities: [FILE_APPEND], pollIntervalMs: 20 });
  await until(() => registry.listPendingClaims().length === 1);
  const deviceId = registry.approveClaim(registry.listPendingClaims()[0]!.claimId).deviceId;
  await pairing;
  d = new MacDeviceDaemon({ dataDir: join(root, "mac"), identity: dev, trust, pollTimeoutMs: 5_000, handlers: createFixtureHandlers({ root: fixtures, enable: [FILE_APPEND] }) });
  await d.runOnce();
  const bot = store.createBot({ name: "Raw", profileId: "lab", engine: "claude" }), thread = store.createThread(bot.id);
  store.setGrant({ botId: bot.id, tool: FILE_APPEND, destination: deviceId, policy: "allow" });
  const action = store.requestAction({ botId: bot.id, threadId: thread.id, tool: FILE_APPEND, destination: deviceId, arguments: { name: "raw.txt", line: "x" }, idempotencyKey: "raw" });
  const bound = recorder(), other = recorder(() => false);
  const first = server.dispatch(action.id, live(), bound.guard);
  assert.equal(server.dispatching(action.id), true);
  await assert.rejects(server.dispatch(action.id, live(), other.guard), (e: unknown) => e instanceof DeviceError && e.code === "conflict");
  await assert.rejects(server.dispatch(action.id), (e: unknown) => e instanceof DeviceError && e.code === "conflict");
  const [done] = await Promise.all([first, d.runOnce()]);
  assert.equal(done.state, "succeeded");
  assert.equal(bound.calls.length, 3);
  assert.equal(other.calls.length, 0);
  assert.equal(server.dispatching(action.id), false);
  await assert.rejects(server.dispatch(action.id, live(), "x" as unknown as () => boolean), (e: unknown) => e instanceof DeviceError && e.code === "invalid_input");
});
