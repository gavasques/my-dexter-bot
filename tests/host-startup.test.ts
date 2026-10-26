import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { HostError, HostStore } from "@dexter/hub";
import type { EngineDriver } from "@dexter/engines";
import type { EngineId } from "@dexter/contracts";
import type { ManagedAppsProvider } from "@dexter/connectors";
import type { RelayHostOptions } from "@dexter/relay-host";
import type { RelayTransport } from "@dexter/relay-consumer";
import { HostServices } from "../packages/cli/src/host-services.js";
import { planHostStartup, type HostStartupInput, type HostStartupProviders } from "../packages/cli/src/host-startup.js";
import { memoryCustody, memoryTLS } from "./fixtures/relay-host-lab.js";

// Synthetic, in-memory only: laboratory-labelled custody, fixture engines, no network, no key/auth files.
const CLI = resolve("packages/cli/dist/index.js");
const code = (name: string) => (error: unknown) => error instanceof HostError && error.code === name;
const dirOf = (t: TestContext, prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
};
const driver = (id: EngineId): EngineDriver => ({ id, capabilities: { resume: true, interrupt: true, fork: false, steer: false },
  async status() { return { engine: id, installed: true, version: "fixture", authentication: "authenticated", billing: "subscription" }; },
  async open(threadId) { return { threadId, nativeCursor: "synthetic" }; },
  async *turn(session, turnId) { yield { type: "turn.completed", threadId: session.threadId, turnId, usage: {} }; },
  async respondToTool() {}, async interrupt() {}, async close() {} });
/** Initialized canonical store (identity minted by the store itself), writer released. */
function seeded(dir: string) {
  const data = join(dir, "host"), store = new HostStore({ dataDir: data }), identity = { installationId: store.hostId, ownerId: store.ownerId };
  store.close(); return { data, identity };
}
function transport() {
  let closes = 0, polls = 0;
  const value: RelayTransport = { async poll() { polls++; return { deliveries: [], cursor: 0 }; }, async ack() { throw Error("unexpected ack"); }, async close() { closes++; } };
  return { value, get closes() { return closes; }, get polls() { return polls; } };
}
function relayProvider(identity: { installationId: string; ownerId: string }, ownership: "owned" | "borrowed" = "owned") {
  const custody = memoryCustody({ ...identity, deviceId: "relay_host", generation: 1, keyId: "host_key" }), t = transport();
  const options: RelayHostOptions = { recipient: custody.pin, custody: custody.provider, custodyMode: "laboratory-memory", transport: t.value,
    transportOwnership: ownership, deployment: { maximumPendingPerRecipient: 16 } };
  return { custody, transport: t, options };
}
function managed() {
  let effects = 0, disposals = 0;
  const effect = async () => { effects++; throw Error("synthetic provider must not be called"); };
  const provider: ManagedAppsProvider = { catalog: effect, provision: effect, lookup: effect, account: effect };
  const config = { provider, credentialRef: "cred-synthetic", broker: { acquire() { effects++; return null; }, secretValues() { return []; } },
    fetch: async () => { effects++; return Response.json({}); }, disposeOwnedBroker: async () => { disposals++; } };
  return { config, get effects() { return effects; }, get disposals() { return disposals; } };
}
const writerFree = (data: string) => { const reopened = new HostStore({ dataDir: data }); reopened.close(); };
/** Every entry under `root` with type, mode and content hash (empty when absent): byte-level before/after evidence. */
function tree(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (path: string, rel: string) => {
    const s = lstatSync(path);
    out.push(`${rel}|${s.isDirectory() ? "d" : s.isFile() ? "f" : "o"}|${(s.mode & 0o777).toString(8)}|${s.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : ""}`);
    if (s.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name), `${rel}/${name}`);
  };
  walk(root, ".");
  return out;
}

test("default startup keeps Agenda off; explicit flag enables the existing manual Agenda through the same plan", async t => {
  const dir = dirOf(t, "dx-startup-agenda-");
  const off = planHostStartup({ route: "laboratory", options: { dataDir: join(dir, "off"), enableEngines: true }, makeDriver: driver });
  assert.equal(off.description.agenda, false);
  const offHost = off.open(); t.after(() => offHost.shutdown({ graceMs: 1000 }));
  assert.throws(() => offHost.agendaAdmin, code("conflict"));
  await offHost.shutdown({ graceMs: 1000 });
  const on = planHostStartup({ route: "laboratory", options: { dataDir: join(dir, "on"), enableEngines: true, enableAgenda: true }, makeDriver: driver });
  assert.equal(on.description.agenda, true);
  const onHost = on.open(); t.after(() => onHost.shutdown({ graceMs: 1000 }));
  assert.ok(onHost.agendaAdmin);
  assert.equal((onHost.hostToolStatus() as { agenda: { admission: string } }).agenda.admission, "open");
  assert.deepEqual((offHost.hostToolStatus() as { agenda: object }).agenda, { configured: false });
  assert.deepEqual((offHost.hostToolStatus() as { memoryBackend: object }).memoryBackend,
    { backend: "openviking", state: "unavailable", readiness: "not_checked" },
    "closed diagnostics do not query the private backend or imply readiness");
  assert.throws(() => on.open(), code("conflict"), "plan is single-use");
  await onHost.shutdown({ graceMs: 1000 });
  writerFree(join(dir, "on"));
});

test("refused combinations create no data directory, writer or provider effect", t => {
  const dir = dirOf(t, "dx-startup-refuse-"), absent = join(dir, "absent"), seed = seeded(dir), r = relayProvider(seed.identity), m = managed();
  let getter = 0;
  const cases: [string, unknown][] = [
    ["agenda without engines", { route: "production", options: { dataDir: absent, enableAgenda: true } }],
    ["non-boolean flag", { route: "production", options: { dataDir: absent, enableEngines: "yes" } }],
    ["mcp without engines", { route: "production", options: { dataDir: absent, enableMcp: true } }],
    ["device tools without devices", { route: "production", options: { dataDir: absent, enableEngines: true, enableMcp: true, enableDeviceTools: true } }],
    ["owner control without app clients", { route: "production", options: { dataDir: absent, ownerControl: { socketPath: join(dir, "c", "owner.sock") } } }],
    ["unknown public key (upstream)", { route: "production", options: { dataDir: absent, enableEngines: true, upstream: {} } }],
    ["unknown public key (authorityMaintenance)", { route: "production", options: { dataDir: absent, authorityMaintenance: {} } }],
    ["unknown provider key", { route: "production", options: { dataDir: absent }, providers: { custodyFile: "/x" } }],
    ["synthetic driver in production", { route: "production", options: { dataDir: absent, enableEngines: true }, makeDriver: driver }],
    ["unknown route", { route: "auto", options: { dataDir: absent } }],
    ["relay provider without its flag", { route: "laboratory", options: { dataDir: seed.data, enableEngines: true, appClients: { identity: memoryTLS() } }, providers: { relay: r.options } }],
    ["managed provider without its flag", { route: "laboratory", options: { dataDir: absent, enableEngines: true, enableMcp: true }, providers: { managedApps: m.config } }],
    ["managed flag without MCP", { route: "laboratory", options: { dataDir: absent, enableEngines: true, enableManagedApps: true }, providers: { managedApps: m.config } }],
    ["managed provider missing function", { route: "laboratory", options: { dataDir: absent, enableEngines: true, enableMcp: true, enableManagedApps: true },
      providers: { managedApps: { ...m.config, fetch: undefined, provider: { catalog: m.config.provider.catalog } } } }],
    ["relay and recovery together", { route: "laboratory", options: { dataDir: seed.data, enableEngines: true, enableRelay: true, enableRelayRecovery: true,
      appClients: { identity: memoryTLS() } }, providers: { relay: r.options, relayRecovery: {} } }],
    ["relay without app clients", { route: "laboratory", options: { dataDir: seed.data, enableEngines: true, enableRelay: true }, providers: { relay: r.options } }],
    ["getter provider is never invoked", { route: "laboratory", options: { dataDir: seed.data, enableEngines: true, enableRelay: true, appClients: { identity: memoryTLS() } },
      providers: Object.defineProperty({}, "relay", { enumerable: true, get() { getter++; return r.options; } }) }],
    ["proxy options", { route: "production", options: new Proxy({ dataDir: absent }, {}) }],
  ];
  for (const [name, input] of cases) {
    assert.throws(() => planHostStartup(input as HostStartupInput), code("invalid_input"), name);
    assert.equal(existsSync(absent), false, name);
    assert.equal(existsSync(join(seed.data, "relay-host")), false, name);
  }
  assert.equal(getter, 0); assert.equal(m.effects, 0); assert.equal(m.disposals, 0);
  assert.equal(r.custody.closes, 0); assert.equal(r.custody.signStarted, false); assert.equal(r.transport.closes, 0); assert.equal(r.transport.polls, 0);
  writerFree(seed.data);
});

test("production route refuses a missing relay provider and laboratory custody before the store opens", t => {
  const dir = dirOf(t, "dx-startup-prod-"), absent = join(dir, "absent"), seed = seeded(dir), r = relayProvider(seed.identity);
  const base = { dataDir: seed.data, enableEngines: true, enableRelay: true, appClients: { identity: memoryTLS() } };
  assert.throws(() => planHostStartup({ route: "production", options: base }), code("invalid_input"));
  assert.throws(() => planHostStartup({ route: "production", options: base, providers: {} }), code("invalid_input"));
  assert.throws(() => planHostStartup({ route: "production", options: base, providers: { relay: r.options } }), /laboratory relay custody/);
  // Lab label cannot be relabelled into production by mode alone: the custody kind must match the mode.
  assert.throws(() => planHostStartup({ route: "production", options: base, providers: { relay: { ...r.options, custodyMode: "persistent" } } }), code("invalid_input"));
  // Laboratory route refuses a persistent mode label too: no route upgrades or downgrades a custody claim.
  assert.throws(() => planHostStartup({ route: "laboratory", options: base, providers: { relay: { ...r.options, custodyMode: "persistent" } } }), code("invalid_input"));
  // Identity is never minted for a provider: relay against an uninitialized store refuses without creating it.
  assert.throws(() => planHostStartup({ route: "laboratory", options: { ...base, dataDir: absent }, providers: { relay: r.options } }), /initialized canonical store/);
  assert.equal(existsSync(absent), false);
  assert.equal(existsSync(join(seed.data, "relay-host")), false);
  assert.equal(r.custody.closes, 0); assert.equal(r.transport.closes, 0);
  writerFree(seed.data);
});

test("recovery is exclusive with relay; production recovery refuses laboratory next-recipient custody", t => {
  const dir = dirOf(t, "dx-startup-recovery-"), seed = seeded(dir), r = relayProvider(seed.identity);
  const next = memoryCustody({ ...seed.identity, deviceId: "relay_host", generation: 2, keyId: "next_key" });
  const base = { dataDir: seed.data, enableRelayRecovery: true, appClients: { identity: memoryTLS() } };
  const recovery = { nextRecipient: { custody: next.provider, custodyMode: "laboratory-memory" as const } };
  assert.throws(() => planHostStartup({ route: "production", options: base, providers: { relayRecovery: recovery } }), /laboratory relay custody/);
  assert.throws(() => planHostStartup({ route: "laboratory", options: { ...base, enableEngines: true, enableRelay: true }, providers: { relay: r.options, relayRecovery: recovery } }), /mutually exclusive/);
  assert.throws(() => planHostStartup({ route: "laboratory", options: { ...base, appClients: undefined }, providers: { relayRecovery: recovery } }), code("invalid_input"));
  const plan = planHostStartup({ route: "laboratory", options: base, providers: { relayRecovery: recovery } });
  assert.deepEqual(plan.description.relayRecovery, { status: "configured", nextRecipient: "laboratory-memory", persistentCustodyVerified: false });
  assert.equal(next.closes, 0); assert.equal(next.signStarted, false);
  assert.equal(existsSync(join(seed.data, "relay-host")), false);
  writerFree(seed.data);
});

test("laboratory relay composes through the plan: owned transport and custody close once, writer released", async t => {
  const dir = dirOf(t, "dx-startup-relay-owned-"), seed = seeded(dir), r = relayProvider(seed.identity, "owned");
  const input = { route: "laboratory" as const, options: { dataDir: seed.data, enableEngines: true, enableRelay: true, appClients: { identity: memoryTLS() } }, providers: { relay: r.options } as HostStartupProviders, makeDriver: driver };
  const plan = planHostStartup(input);
  // Caller mutation after preflight cannot enable a feature or swap a provider.
  (input.options as Record<string, unknown>)["enableAgenda"] = true; delete input.providers.relay;
  assert.deepEqual(plan.description.relay, { status: "configured", custodyMode: "laboratory-memory", transportOwnership: "owned", persistentCustodyVerified: false });
  assert.equal(JSON.stringify(plan.description).includes("PRIVATE"), false);
  const host = plan.open(); t.after(() => host.shutdown({ graceMs: 1000 }));
  assert.throws(() => host.agendaAdmin, code("conflict"));
  const status = host.relayStatus() as { configured: boolean; custodyMode: string; persistentCustodyVerified: boolean };
  assert.equal(status.configured, true); assert.equal(status.custodyMode, "laboratory-memory"); assert.equal(status.persistentCustodyVerified, false);
  assert.equal(r.custody.closes, 0);
  await host.shutdown({ graceMs: 1000 });
  assert.equal(r.transport.closes, 1); assert.equal(r.custody.closes, 1);
  writerFree(seed.data);
});

test("borrowed transport stays caller-owned; foreign pin refuses at preflight; post-open recipient check still rolls back", async t => {
  const dir = dirOf(t, "dx-startup-relay-borrowed-"), seed = seeded(dir), r = relayProvider(seed.identity, "borrowed");
  const options = { dataDir: seed.data, enableEngines: true, enableRelay: true, appClients: { identity: memoryTLS() } };
  const host = planHostStartup({ route: "laboratory", options, providers: { relay: r.options }, makeDriver: driver }).open();
  await host.shutdown({ graceMs: 1000 });
  assert.equal(r.transport.closes, 0); assert.equal(r.custody.closes, 1);
  // Pin bound to another installation: the read-only identity probe refuses before any store/writer/relay file.
  const other = seeded(join(dir, "other")), wrong = relayProvider(other.identity, "owned"), before = tree(seed.data);
  assert.throws(() => planHostStartup({ route: "laboratory", options, providers: { relay: wrong.options }, makeDriver: driver }), /another installation or owner/);
  assert.deepEqual(tree(seed.data), before);
  assert.equal(wrong.transport.closes, 0); assert.equal(wrong.custody.closes, 0); assert.equal(wrong.custody.signStarted, false);
  // Same installation, different (unapproved) recipient keys: only the existing HostServices/RelayHost check after open
  // can see the persisted association. It refuses, rolls back, keeps provider ownership with the caller and frees the writer.
  const rotated = relayProvider(seed.identity, "owned");
  const plan = planHostStartup({ route: "laboratory", options, providers: { relay: rotated.options }, makeDriver: driver });
  assert.throws(() => plan.open());
  assert.equal(rotated.transport.closes, 0); assert.equal(rotated.custody.closes, 0); assert.equal(rotated.custody.signStarted, false);
  assert.throws(() => plan.open(), code("conflict"));
  writerFree(seed.data);
});

test("trusted managed-app provider: no effect at open, broker disposal only after successful construction", async t => {
  const dir = dirOf(t, "dx-startup-managed-"), data = join(dir, "host");
  const options = { dataDir: data, enableEngines: true, enableMcp: true, enableManagedApps: true };
  const failing = managed(), locked = new HostStore({ dataDir: data });
  const lockedPlan = planHostStartup({ route: "laboratory", options, providers: { managedApps: failing.config }, makeDriver: driver });
  assert.throws(() => lockedPlan.open(), code("host_locked"));
  locked.close();
  assert.equal(failing.effects, 0); assert.equal(failing.disposals, 0);
  const m = managed();
  const plan = planHostStartup({ route: "laboratory", options, providers: { managedApps: m.config }, makeDriver: driver });
  assert.equal(plan.description.managedApps, "configured");
  const host = plan.open(); t.after(() => host.shutdown({ graceMs: 1000 }));
  assert.equal(host.upstreamConfigured, true); assert.ok(host.managedAppsAdmin);
  assert.equal(m.effects, 0);
  await host.shutdown({ graceMs: 1000 });
  assert.equal(m.disposals, 1); assert.equal(m.effects, 0);
  writerFree(data);
});

function cli(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 10_000, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: tmpdir(), TMPDIR: tmpdir() } });
}
async function serve(t: TestContext, dataDir: string, ...flags: string[]): Promise<Record<string, unknown>> {
  const child: ChildProcess = spawn(process.execPath, [CLI, "serve", "--port", "0", "--data-dir", dataDir, ...flags],
    { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: tmpdir(), TMPDIR: tmpdir() } });
  const exited = new Promise<void>(done => child.once("exit", () => done()));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; } });
  return await new Promise((done, reject) => {
    let out = ""; const timer = setTimeout(() => reject(Error("not ready")), 8000);
    child.once("exit", () => { clearTimeout(timer); reject(Error("exited before ready")); });
    child.stdout!.on("data", (b: Buffer) => { out += b; try { const r = JSON.parse(out); clearTimeout(timer); done(r); } catch { /* partial */ } });
  });
}

test("executable serve keeps defaults, adds explicit --enable-agenda, and never configures trusted providers", async t => {
  const dir = dirOf(t, "dx-startup-cli-");
  const refused = cli("serve", "--port", "0", "--data-dir", join(dir, "refused"), "--enable-agenda");
  assert.equal(refused.status, 1); assert.match(refused.stderr, /Agenda requires enabled engines/);
  assert.equal(existsSync(join(dir, "refused")), false);
  assert.match(cli("help").stdout, /\[--enable-agenda\]/);
  const plain = await serve(t, join(dir, "plain"));
  assert.equal(plain["engineExecution"], "disabled"); assert.equal(plain["agenda"], "disabled"); assert.equal(plain["upstreamApps"], "unconfigured");
  assert.deepEqual(plain["trustedProviders"], { relay: "unconfigured", relayRecovery: "unconfigured", managedApps: "unconfigured" });
  const agenda = await serve(t, join(dir, "agenda"), "--enable-engines", "--enable-agenda");
  assert.equal(agenda["engineExecution"], "enabled"); assert.equal(agenda["agenda"], "enabled");
  assert.deepEqual(agenda["trustedProviders"], { relay: "unconfigured", relayRecovery: "unconfigured", managedApps: "unconfigured" });
});

// ---- AUTHOR2: Sol REVIEW1 blockers R1 (nested accessors/proxies/hooks), R2 (pure memory/sync/recovery bounds), R3 (identity probe).

test("R1: Sol REVIEW1 probe inputs refuse with zero getter/trap/hook calls and no data directory", t => {
  // Inputs copied unchanged from Sol's review-probes.mjs; only the counters are asserted instead of printed.
  const dir = dirOf(t, "dx-startup-sol-probes-"), data = (name: string) => join(dir, name);
  const plan = (input: unknown) => planHostStartup(input as HostStartupInput);
  { let calls = 0; const devices = new Proxy({}, { ownKeys() { calls++; return []; } });
    assert.throws(() => plan({ route: "production", options: { dataDir: data("dev"), devices } }), code("invalid_input"));
    assert.equal(calls, 0, "devices Proxy trap"); assert.equal(existsSync(data("dev")), false); }
  { let calls = 0; const fn = async () => { throw Error("never"); };
    const provider = { get catalog() { calls++; return fn; }, provision: fn, lookup: fn, account: fn };
    assert.throws(() => plan({ route: "laboratory", options: { dataDir: data("managed"), enableEngines: true, enableMcp: true, enableManagedApps: true },
      providers: { managedApps: { provider, broker: { acquire: () => null, secretValues: () => [] }, credentialRef: "synthetic", fetch: fn } } }), code("invalid_input"));
    assert.equal(calls, 0, "catalog accessor"); assert.equal(existsSync(data("managed")), false); }
  { let calls = 0; const fn = async () => {}; const limits = { toJSON() { calls++; return {}; } };
    assert.throws(() => plan({ route: "laboratory", options: { dataDir: data("json"), enableEngines: true, enableMcp: true, enableManagedApps: true },
      providers: { managedApps: { provider: { catalog: fn, provision: fn, lookup: fn, account: fn }, broker: { acquire: () => null, secretValues: () => [] },
        credentialRef: "synthetic", fetch: fn, limits } } }), code("invalid_input"));
    assert.equal(calls, 0, "limits.toJSON"); assert.equal(existsSync(data("json")), false); }
  { let calls = 0; const memory = { get origin() { calls++; return "http://127.0.0.1:1"; }, labLoopbackWithoutAuth: true };
    assert.throws(() => plan({ route: "laboratory", options: { dataDir: data("context"), enableEngines: true, enableMcp: true,
      context: { memory, ownerExclusiveDeployment: true } } }), code("invalid_input"));
    assert.equal(calls, 0, "memory.origin accessor"); assert.equal(existsSync(data("context")), false); }
  const seed = data("seed"), s = new HostStore({ dataDir: seed }), identity = { ownerId: s.ownerId, installationId: s.hostId }; s.close();
  { let calls = 0; const c = memoryCustody({ ...identity, deviceId: "relay_host", generation: 2, keyId: "next_key" });
    const custody = { ...c.provider }; Object.defineProperty(custody, "publicPin", { enumerable: true, get() { calls++; return c.pin; } });
    assert.throws(() => plan({ route: "laboratory", options: { dataDir: seed, enableRelayRecovery: true, appClients: { identity: memoryTLS() } },
      providers: { relayRecovery: { nextRecipient: { custody, custodyMode: "laboratory-memory" } } } }), code("invalid_input"));
    assert.equal(calls, 0, "recovery publicPin accessor"); assert.equal(c.closes, 0); assert.equal(existsSync(join(seed, "relay-host")), false); }
  { const c = memoryCustody({ ...identity, deviceId: "relay_host", generation: 2, keyId: "next_key" });
    assert.throws(() => plan({ route: "laboratory", options: { dataDir: seed, enableRelayRecovery: true, appClients: { identity: memoryTLS() } },
      providers: { relayRecovery: { nextRecipient: { custody: { ...c.provider, kind: "unknown_provider" }, custodyMode: "laboratory-memory" } } } }), code("invalid_input"));
    assert.equal(c.closes, 0); }
  writerFree(seed);
});

test("R1: nested accessors, proxies, symbols and JSON hooks anywhere refuse before any provider, store or file", t => {
  const dir = dirOf(t, "dx-startup-nested-"), absent = join(dir, "absent"), seed = seeded(dir), m = managed();
  let calls = 0;
  const count = () => { calls++; };
  const getter = (value: unknown) => ({ enumerable: true, get() { count(); return value; } });
  const accessor = <T extends object>(base: T, key: string, value: unknown): T => Object.defineProperty({ ...base }, key, getter(value));
  const trap = <T extends object>(target: T): T => new Proxy(target, { get(o, k) { count(); return Reflect.get(o, k); }, ownKeys(o) { count(); return Reflect.ownKeys(o); },
    getOwnPropertyDescriptor(o, k) { count(); return Reflect.getOwnPropertyDescriptor(o, k); }, getPrototypeOf(o) { count(); return Reflect.getPrototypeOf(o); },
    apply(f, self, args) { count(); return Reflect.apply(f as (...a: unknown[]) => unknown, self, args); } });
  const fixture = relayProvider(seed.identity), r = fixture.options, app = { identity: memoryTLS() };
  const relayInput = (relay: unknown) => ({ route: "laboratory", options: { dataDir: seed.data, enableEngines: true, enableRelay: true, appClients: app }, providers: { relay } });
  const managedInput = (managedApps: unknown) => ({ route: "laboratory", options: { dataDir: absent, enableEngines: true, enableMcp: true, enableManagedApps: true }, providers: { managedApps } });
  const contextInput = (context: unknown) => ({ route: "laboratory", options: { dataDir: absent, enableEngines: true, enableMcp: true, context } });
  const lab = { origin: "http://127.0.0.1:1", labLoopbackWithoutAuth: true };
  class GetterProvider { get catalog() { count(); return async () => []; } async provision() { throw Error(); } async lookup() { return null; } async account() { throw Error(); } }
  const cases: [string, unknown][] = [
    ["relay recipient accessor", relayInput(accessor(r, "recipient", r.recipient))],
    ["relay recipient pin field accessor", relayInput({ ...r, recipient: accessor(r.recipient, "keyId", r.recipient.keyId) })],
    ["relay custody proxy", relayInput({ ...r, custody: trap({ ...r.custody }) })],
    ["relay custody method accessor", relayInput({ ...r, custody: accessor(r.custody, "sign", r.custody.sign) })],
    ["relay custody publicPin proxy", relayInput({ ...r, custody: { ...r.custody, publicPin: trap({ ...r.custody.publicPin }) } })],
    ["relay custody proxied function", relayInput({ ...r, custody: { ...r.custody, decrypt: trap(r.custody.decrypt) } })],
    ["relay transport proxy", relayInput({ ...r, transport: trap({ ...r.transport }) })],
    ["relay transport accessor", relayInput({ ...r, transport: accessor(r.transport, "close", r.transport.close) })],
    ["relay deployment accessor", relayInput({ ...r, deployment: accessor(r.deployment, "maximumPendingPerRecipient", 16) })],
    ["relay deployment toJSON hook", relayInput({ ...r, deployment: { maximumPendingPerRecipient: 16, toJSON() { count(); return {}; } } })],
    ["relay deployment symbol key", relayInput({ ...r, deployment: { maximumPendingPerRecipient: 16, [Symbol("x")]: 1 } })],
    ["relay deployment object number", relayInput({ ...r, deployment: { maximumPendingPerRecipient: { valueOf() { count(); return 16; } } } })],
    ["relay options proxy", relayInput(trap({ ...r }))],
    ["managed provider proxy", managedInput({ ...m.config, provider: trap({ ...m.config.provider }) })],
    ["managed provider prototype accessor", managedInput({ ...m.config, provider: new GetterProvider() })],
    ["managed broker accessor", managedInput({ ...m.config, broker: accessor(m.config.broker, "acquire", m.config.broker.acquire) })],
    ["managed broker proxy", managedInput({ ...m.config, broker: trap({ ...m.config.broker }) })],
    ["managed fetch proxy", managedInput({ ...m.config, fetch: trap(m.config.fetch) })],
    ["managed limits accessor", managedInput({ ...m.config, limits: accessor({}, "timeoutMs", 1000) })],
    ["managed limits proxy", managedInput({ ...m.config, limits: trap({ timeoutMs: 1000 }) })],
    ["managed authHeaders proxy", managedInput({ ...m.config, authHeaders: trap(["x-api-key"]) })],
    ["managed authHeaders index accessor", managedInput({ ...m.config, authHeaders: Object.defineProperty(["x"], "0", getter("x-api-key")) })],
    ["managed authHeaders extra key", managedInput({ ...m.config, authHeaders: Object.assign(["x-api-key"], { toJSON() { count(); return []; } }) })],
    ["managed config accessor", managedInput(accessor(m.config, "credentialRef", "cred-synthetic"))],
    ["managed credentialRef toString object", managedInput({ ...m.config, credentialRef: { toString() { count(); return "cred"; } } })],
    ["context proxy", contextInput(trap({ memory: lab, ownerExclusiveDeployment: true }))],
    ["context memory proxy", contextInput({ memory: trap({ ...lab }), ownerExclusiveDeployment: true })],
    ["context memory credential proxy", contextInput({ memory: { origin: "https://memory.example", credential: trap(() => "aim_x") }, ownerExclusiveDeployment: true })],
    ["context sync accessor", contextInput({ memory: lab, ownerExclusiveDeployment: true, sync: accessor({}, "maxJobsPerFlush", 5) })],
    ["context sync toJSON", contextInput({ memory: lab, ownerExclusiveDeployment: true, sync: { toJSON() { count(); return {}; } } })],
    ["context isolation smuggled", contextInput({ memory: { ...lab, isolation: { mode: "owner_exclusive_deployment" } }, ownerExclusiveDeployment: true })],
    ["device identity proxy", { route: "production", options: { dataDir: absent, devices: { identity: trap({ certPem: "", keyPem: "", fingerprint: "" }) } } }],
    ["device identity key accessor", { route: "production", options: { dataDir: absent, devices: { identity: accessor({ certPem: "", fingerprint: "" }, "keyPem", "") } } }],
    ["app client identity subclass", { route: "production", options: { dataDir: absent, appClients: { identity: Object.setPrototypeOf({ certPem: "", fingerprint: "" }, Object.create(Object.getPrototypeOf(app.identity) as object)) } } }],
    ["app client port accessor", { route: "production", options: { dataDir: absent, appClients: accessor(app, "port", 0) } }],
    ["owner control accessor", { route: "production", options: { dataDir: absent, appClients: app, ownerControl: accessor({}, "socketPath", join(dir, "o.sock")) } }],
    ["public options symbol key", { route: "production", options: { dataDir: absent, [Symbol("enableEngines")]: true } }],
    ["synthetic driver proxy", { route: "laboratory", options: { dataDir: absent, enableEngines: true }, makeDriver: trap(driver) }],
  ];
  for (const [name, input] of cases) {
    assert.throws(() => planHostStartup(input as HostStartupInput), code("invalid_input"), name);
    assert.equal(calls, 0, `${name}: no getter/trap/hook ran`);
    assert.equal(existsSync(absent), false, name);
    assert.equal(existsSync(join(seed.data, "relay-host")), false, name);
  }
  assert.equal(m.effects, 0); assert.equal(m.disposals, 0);
  assert.equal(fixture.custody.closes, 0); assert.equal(fixture.custody.signStarted, false); assert.equal(fixture.transport.closes, 0); assert.equal(fixture.transport.polls, 0);
  writerFree(seed.data);
});

test("R1: legitimate opaque providers keep their receivers; function name/length accessors are never read", async t => {
  const dir = dirOf(t, "dx-startup-receivers-"), seed = seeded(dir);
  // Managed apps: class-instance provider/broker (prototype methods, private state) accepted without being called.
  let reads = 0;
  const sneaky = Object.defineProperties(async () => { throw Error("never"); }, { name: { get() { reads++; return "x"; } }, length: { get() { reads++; return 0; } } });
  class Provider { readonly #tag = "synthetic"; async catalog() { return this.#tag ? [] : []; } async provision(): Promise<never> { throw Error("never"); }
    async lookup() { return null; } async account(): Promise<never> { throw Error("never"); } }
  class Broker { readonly #secrets: string[] = []; acquire() { return null; } secretValues() { return this.#secrets; } }
  let disposeReceiver: unknown = null;
  const config = { provider: new Provider() as unknown as ManagedAppsProvider, broker: new Broker(), credentialRef: "cred-synthetic", fetch: sneaky as never,
    authHeaders: ["x-api-key"], limits: { timeoutMs: 1000 }, disposeOwnedBroker() { disposeReceiver = this; } };
  const data = join(dir, "managed");
  const plan = planHostStartup({ route: "laboratory", options: { dataDir: data, enableEngines: true, enableMcp: true, enableManagedApps: true },
    providers: { managedApps: config }, makeDriver: driver });
  assert.equal(existsSync(data), false);
  const host = plan.open(); t.after(() => host.shutdown({ graceMs: 1000 }));
  await host.shutdown({ graceMs: 1000 });
  assert.equal(disposeReceiver, config, "disposeOwnedBroker runs with the original receiver after successful construction");
  assert.equal(reads, 0, "neither plan nor HostServices read the provider function's name/length");
  // Relay: plain custody/transport whose methods rely on `this`; owned close runs once on the original objects.
  const fixture = relayProvider(seed.identity, "owned");
  let custodyReceiver: unknown = null, transportReceiver: unknown = null;
  const custody = { ...fixture.custody.provider, close(this: unknown) { custodyReceiver = this; return fixture.custody.provider.close(); } };
  const transport = { poll: fixture.options.transport.poll, ack: fixture.options.transport.ack, close(this: unknown) { transportReceiver = this; return fixture.options.transport.close(); } };
  const relayHost = planHostStartup({ route: "laboratory", options: { dataDir: seed.data, enableEngines: true, enableRelay: true, appClients: { identity: memoryTLS() } },
    providers: { relay: { ...fixture.options, custody, transport } }, makeDriver: driver }).open();
  t.after(() => relayHost.shutdown({ graceMs: 1000 }));
  assert.equal(custodyReceiver, null); assert.equal(fixture.custody.signStarted, false);
  await relayHost.shutdown({ graceMs: 1000 });
  assert.equal(custodyReceiver, custody); assert.equal(transportReceiver, transport);
  assert.equal(fixture.custody.closes, 1); assert.equal(fixture.transport.closes, 1);
  writerFree(seed.data);
});

test("R2: invalid memory/sync/recovery bounds refuse at plan with no data directory, store or auxiliary file; bounds match the actual constructors", t => {
  const dir = dirOf(t, "dx-startup-bounds-"), absent = join(dir, "absent"), empty = join(dir, "empty"), seed = seeded(dir);
  mkdirSync(empty, { mode: 0o700 });
  const lab = { origin: "http://127.0.0.1:1", labLoopbackWithoutAuth: true };
  const contextPlan = (dataDir: string, context: unknown) => planHostStartup({ route: "laboratory",
    options: { dataDir, enableEngines: true, enableMcp: true, context } } as HostStartupInput);
  const syncCases: [Record<string, unknown>, boolean][] = [
    [{}, true], [{ maxJobsPerFlush: 1 }, true], [{ maxJobsPerFlush: 1000 }, true], [{ maxDiscoveredPerFlush: 100_000 }, true], [{ maxDiscoveredPerFlush: 1 }, true],
    [{ maxJobsPerFlush: 0 }, false], [{ maxJobsPerFlush: 1001 }, false], [{ maxJobsPerFlush: 1.5 }, false], [{ maxJobsPerFlush: "5" }, false],
    [{ maxJobsPerFlush: -1 }, false], [{ maxDiscoveredPerFlush: 0 }, false], [{ maxDiscoveredPerFlush: 100_001 }, false], [{ maxDiscoveredPerFlush: Number.NaN }, false],
  ];
  for (const [sync, valid] of syncCases) {
    const label = JSON.stringify(sync);
    for (const dataDir of [absent, empty]) {
      if (valid) assert.equal(contextPlan(dataDir, { memory: lab, ownerExclusiveDeployment: true, sync }).description.mcp, true, label);
      else assert.throws(() => contextPlan(dataDir, { memory: lab, ownerExclusiveDeployment: true, sync }), /Invalid ai-memory sync configuration/, label);
    }
    assert.equal(existsSync(absent), false, label); assert.deepEqual(readdirSync(empty), [], label);
    // Parity: the unchanged HostServices (second authority) refuses exactly the same values, in its own scratch directory
    // (where, as Sol REVIEW1 recorded, it reaches its store first; the plan route never lets it get there).
    if (!valid) {
      const scratch = join(dir, `scratch-${createHash("sha256").update(label).digest("hex").slice(0, 8)}`);
      assert.throws(() => new HostServices({ dataDir: scratch, enableEngines: true, enableMcp: true, context: { memory: lab, ownerExclusiveDeployment: true, sync: sync as never } }),
        (error: unknown) => (error as { code?: unknown }).code === "invalid_input", `HostServices parity ${label}`);
    }
  }
  for (const memory of [{ origin: "ftp://127.0.0.1" }, { ...lab, credential: () => "aim_x" }, { origin: "https://memory.example/path", credential: () => "aim_x" },
    { ...lab, labLoopbackWithoutAuth: "yes" }, { origin: "https://memory.example" }]) {
    assert.throws(() => contextPlan(empty, { memory, ownerExclusiveDeployment: true }), code("invalid_input"), JSON.stringify(memory));
  }
  assert.throws(() => contextPlan(empty, { memory: lab, ownerExclusiveDeployment: false }), /owner-exclusive/);
  assert.deepEqual(readdirSync(empty), []);
  // Recovery maximum: plan bound == HostServices bound (HostServices refuses these before any store as well).
  const app = { identity: memoryTLS() }, before = tree(seed.data);
  for (const [maximum, valid] of [[1, true], [100_000, true], [4096, true], [0, false], [100_001, false], [1.5, false], ["7", false], [-3, false]] as const) {
    const recoveryPlan = () => planHostStartup({ route: "laboratory", options: { dataDir: seed.data, enableRelayRecovery: true, appClients: app },
      providers: { relayRecovery: { maximumAssociations: maximum as number } } });
    if (valid) assert.equal((recoveryPlan().description.relayRecovery as { status: string }).status, "configured");
    else {
      const scratch = join(dir, `recovery-${String(maximum)}`);
      assert.throws(recoveryPlan, /Invalid relay recovery configuration/, String(maximum));
      assert.throws(() => new HostServices({ dataDir: scratch, appClients: app, relayRecovery: { maximumAssociations: maximum as number } }),
        /Invalid relay recovery configuration/, `HostServices parity ${String(maximum)}`);
      assert.equal(existsSync(scratch), false, `HostServices also refuses ${String(maximum)} before its store`);
    }
  }
  assert.deepEqual(tree(seed.data), before);
  assert.equal(existsSync(join(seed.data, "ai-memory-outbox.sqlite")), false);
  writerFree(seed.data);
});

test("R3: empty, uninitialized, corrupt, unsupported or identity-less stores refuse relay/recovery byte-for-byte unchanged", t => {
  const dir = dirOf(t, "dx-startup-identity-"), base = seeded(dir);
  const fixture = relayProvider(base.identity, "owned"), next = memoryCustody({ ...base.identity, deviceId: "relay_host", generation: 2, keyId: "next_key" });
  const app = { identity: memoryTLS() };
  const variants: [string, (path: string) => void][] = [
    ["absent data directory", () => {}],
    ["empty private directory", path => { mkdirSync(path, { mode: 0o700 }); }],
    ["zero-byte dexter.sqlite (Sol REVIEW1 trigger)", path => { mkdirSync(path, { mode: 0o700 }); writeFileSync(join(path, "dexter.sqlite"), ""); }],
    ["corrupt dexter.sqlite", path => { mkdirSync(path, { mode: 0o700 }); writeFileSync(join(path, "dexter.sqlite"), Buffer.alloc(8192, 0x5a)); }],
    ["foreign SQLite schema", path => { mkdirSync(path, { mode: 0o700 }); const db = new DatabaseSync(join(path, "dexter.sqlite"));
      db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('host_id','host_x'),('owner_id','own_x'); PRAGMA user_version = 99;"); db.close(); }],
    ["legacy schema without authority", path => { const s = new HostStore({ dataDir: path }); s.close();
      const db = new DatabaseSync(join(path, "dexter.sqlite")); db.exec("PRAGMA user_version = 3;"); db.close(); }],
    ["missing owner identity row", path => { const s = new HostStore({ dataDir: path }); s.close();
      const db = new DatabaseSync(join(path, "dexter.sqlite"), { enableForeignKeyConstraints: false }); db.exec("DELETE FROM meta WHERE key = 'owner_id';"); db.close(); }],
    ["checkpointed authority", path => { const s = new HostStore({ dataDir: path }); s.close();
      const db = new DatabaseSync(join(path, "dexter.sqlite")); db.exec("UPDATE host_authority SET state = 'checkpointed', checkpoint_id = 'ckp_synthetic_checkpoint_0001';"); db.close(); }],
    ["lone WAL sidecar", path => { const s = new HostStore({ dataDir: path }); s.close(); writeFileSync(join(path, "dexter.sqlite-wal"), ""); }],
  ];
  for (const [name, prepare] of variants) {
    const data = join(dir, name.replace(/[^a-z0-9]+/gi, "-")); prepare(data);
    const before = tree(data);
    for (const route of ["relay", "recovery"] as const) {
      const input = route === "relay"
        ? { route: "laboratory", options: { dataDir: data, enableEngines: true, enableRelay: true, appClients: app }, providers: { relay: fixture.options }, makeDriver: driver }
        : { route: "laboratory", options: { dataDir: data, enableRelayRecovery: true, appClients: app },
          providers: { relayRecovery: { nextRecipient: { custody: next.provider, custodyMode: "laboratory-memory" } } } };
      assert.throws(() => planHostStartup(input as HostStartupInput), /initialized canonical store/, `${name} (${route})`);
      assert.deepEqual(tree(data), before, `${name} (${route}): no file created or modified`);
    }
    assert.equal(existsSync(join(data, "relay-host")), false, name);
  }
  assert.equal(fixture.custody.closes, 0); assert.equal(fixture.custody.signStarted, false); assert.equal(fixture.transport.closes, 0); assert.equal(fixture.transport.polls, 0);
  assert.equal(next.closes, 0); assert.equal(next.signStarted, false);
  // Recovery next-recipient of another installation is refused by the same public identity read.
  const other = memoryCustody({ installationId: "host_other", ownerId: base.identity.ownerId, deviceId: "relay_host", generation: 2, keyId: "next_key" });
  const seedBefore = tree(base.data);
  assert.throws(() => planHostStartup({ route: "laboratory", options: { dataDir: base.data, enableRelayRecovery: true, appClients: app },
    providers: { relayRecovery: { nextRecipient: { custody: other.provider, custodyMode: "laboratory-memory" } } } }), /another installation or owner/);
  assert.deepEqual(tree(base.data), seedBefore);
  writerFree(base.data);
});

test("R3: valid initialized store is probed read-only, including from a separate process beside the live writer", t => {
  const dir = dirOf(t, "dx-startup-coexist-"), seed = seeded(dir), app = { identity: memoryTLS() };
  // Closed store: immutable read, nothing created next to it.
  const before = tree(seed.data), fixture = relayProvider(seed.identity);
  const plan = planHostStartup({ route: "laboratory", options: { dataDir: seed.data, enableEngines: true, enableRelay: true, appClients: app }, providers: { relay: fixture.options } });
  assert.equal((plan.description.relay as { status: string }).status, "configured");
  assert.deepEqual(tree(seed.data), before);
  // Live writer in this process; the probe runs in a child process that plans against the same directory.
  const writer = new HostStore({ dataDir: seed.data });
  t.after(() => { writer.close(); });
  const names = () => readdirSync(seed.data).sort();
  const live = names();
  const script = `import { planHostStartup } from ${JSON.stringify(resolve("packages/cli/dist/host-startup.js"))};
import { memoryCustody, memoryTLS } from ${JSON.stringify(resolve(".test-dist/tests/fixtures/relay-host-lab.js"))};
const [dataDir, installationId, ownerId] = process.argv.slice(1);
const c = memoryCustody({ installationId, ownerId, deviceId: "relay_host", generation: 1, keyId: "host_key" });
const transport = { async poll() { throw Error("unused"); }, async ack() { throw Error("unused"); }, async close() { throw Error("unused"); } };
const plan = planHostStartup({ route: "laboratory", options: { dataDir, enableEngines: true, enableRelay: true, appClients: { identity: memoryTLS() } },
  providers: { relay: { recipient: c.pin, custody: c.provider, custodyMode: "laboratory-memory", transport, transportOwnership: "borrowed", deployment: { maximumPendingPerRecipient: 16 } } } });
const o = memoryCustody({ installationId, ownerId: "own_other", deviceId: "relay_host", generation: 1, keyId: "host_key" });
let foreign = "accepted";
try { planHostStartup({ route: "laboratory", options: { dataDir, enableEngines: true, enableRelay: true, appClients: { identity: memoryTLS() } },
  providers: { relay: { recipient: o.pin, custody: o.provider, custodyMode: "laboratory-memory", transport, transportOwnership: "borrowed", deployment: { maximumPendingPerRecipient: 16 } } } }); }
catch (e) { foreign = e.code; }
process.stdout.write(JSON.stringify({ relay: plan.description.relay, foreign, closes: c.closes + o.closes, signStarted: c.signStarted || o.signStarted }));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, seed.data, seed.identity.installationId, seed.identity.ownerId],
    { encoding: "utf8", timeout: 20_000, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: tmpdir(), TMPDIR: tmpdir() } });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { relay: { status: "configured", custodyMode: "laboratory-memory", transportOwnership: "borrowed", persistentCustodyVerified: false },
    foreign: "invalid_input", closes: 0, signStarted: false });
  assert.deepEqual(names(), live, "the probe process created no file beside the live writer");
  // The writer kept its lease and fence throughout; a second writer through the plan is still refused.
  writer.withWriterLease(() => undefined);
  assert.equal(writer.hostId, seed.identity.installationId);
  assert.throws(() => planHostStartup({ route: "laboratory", options: { dataDir: seed.data, enableEngines: true, enableRelay: true, appClients: app },
    providers: { relay: relayProvider(seed.identity).options }, makeDriver: driver }).open(), code("host_locked"));
  assert.equal(existsSync(join(seed.data, "relay-host")), false);
});
