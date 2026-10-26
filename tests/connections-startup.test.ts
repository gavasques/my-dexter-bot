import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { HostError } from "@dexter/hub";
import type { EngineDriver } from "@dexter/engines";
import { HostServices, type HostServicesOptions } from "../packages/cli/src/host-services.js";
import { planHostStartup } from "../packages/cli/src/host-startup.js";
import { SERVICE_ORIGIN } from "./fixtures/connections-lab.js";

// Composition only: no network request, capability read or provider call happens at plan/construct time.
const driver = (id: EngineDriver["id"]): EngineDriver => ({ id, capabilities: { resume: true, interrupt: true, fork: false, steer: false },
  async status() { return { engine: id, installed: true, version: "fixture", authentication: "authenticated", billing: "subscription" }; },
  async open(threadId) { return { threadId, nativeCursor: "synthetic" }; }, async *turn(session, turnId) { yield { type: "turn.completed", threadId: session.threadId, turnId, usage: {} }; },
  async respondToTool() {}, async interrupt() {}, async close() {} });
const invalid = (e: unknown) => e instanceof HostError && e.code === "invalid_input";
function provider() {
  const counts = { capability: 0, fetch: 0 };
  const value: NonNullable<HostServicesOptions["connections"]> = { credentialRef: "cred-connections", platform: { origin: SERVICE_ORIGIN,
    capability: () => { counts.capability++; return "c".repeat(43); }, fetch: async () => { counts.fetch++; throw new Error("no network in composition tests"); } } };
  return { value, counts };
}
function dir(t: TestContext) { const d = mkdtempSync(join(tmpdir(), "dx-connections-startup-")); t.after(() => rmSync(d, { recursive: true, force: true })); return d; }

test("startup plan: intent ⇔ provider, MCP engines required, exclusive with managed apps; refusals create nothing", t => {
  const d = dir(t), absent = join(d, "absent"), p = provider();
  const base = { dataDir: absent, enableEngines: true, enableMcp: true };
  assert.throws(() => planHostStartup({ route: "production", options: { ...base, enableConnections: true } }), /connections provider; none is configured/);
  assert.throws(() => planHostStartup({ route: "production", options: base, providers: { connections: p.value } }), /requires its explicit enable flag/);
  assert.throws(() => planHostStartup({ route: "production", options: { dataDir: absent, enableEngines: true, enableConnections: true }, providers: { connections: p.value } }), invalid);
  assert.throws(() => planHostStartup({ route: "production", options: { ...base, enableConnections: true, enableManagedApps: true },
    providers: { connections: p.value, managedApps: {} as never } }), invalid);
  for (const bad of [{ ...p.value, platform: { ...p.value.platform, origin: "http://connections.dexter.test" } }, { ...p.value, credentialRef: "" }, { ...p.value, extra: true }])
    assert.throws(() => planHostStartup({ route: "production", options: { ...base, enableConnections: true }, providers: { connections: bad as never } }), invalid);
  const plan = planHostStartup({ route: "production", options: { ...base, enableConnections: true }, providers: { connections: p.value } });
  assert.equal(plan.description.connections, "configured");
  assert.equal(planHostStartup({ route: "production", options: base }).description.connections, "unconfigured");
  assert.equal(existsSync(absent), false);
  assert.deepEqual(p.counts, { capability: 0, fetch: 0 });
});

test("HostServices: configured connections bind their own store; unconfigured is honest; native MCP projected as volatile", async t => {
  const d = dir(t), p = provider();
  const configured = new HostServices({ dataDir: join(d, "on"), enableEngines: true, enableMcp: true, connections: p.value, makeDriver: engine => driver(engine) });
  assert.equal(configured.upstreamConfigured, true);
  assert.ok(readdirSync(join(d, "on")).includes("connections.sqlite"));
  const status = configured.connectionsHttp.status() as { platform: string; managedProviders: string[]; direct: string };
  assert.deepEqual([status.platform, status.managedProviders, status.direct], ["available", ["composio"], "unconfigured"]);
  assert.deepEqual(p.counts, { capability: 0, fetch: 0 }, "no capability read or request before an owner operation");
  await configured.shutdown({ graceMs: 100 });
  assert.throws(() => configured.connectionsHttp.status(), (e: unknown) => e instanceof HostError && e.code === "conflict");
  assert.throws(() => new HostServices({ dataDir: join(d, "x"), enableEngines: true, enableMcp: true, connections: p.value, managedApps: {} as never }), invalid);
  const plain = new HostServices({ dataDir: join(d, "plain"), enableEngines: true, enableMcp: true, nativeMcp: { runsOn: "owner_mac" }, makeDriver: engine => driver(engine) });
  t.after(() => plain.shutdown({ graceMs: 100 }).catch(() => undefined));
  assert.equal(readdirSync(join(d, "plain")).includes("connections.sqlite"), false);
  const honest = plain.connectionsHttp.status() as { platform: string; managedProviders: string[]; direct: string; nativeOAuthPersistence: string };
  assert.deepEqual([honest.platform, honest.managedProviders, honest.direct, honest.nativeOAuthPersistence], ["unconfigured", [], "native_mcp", "volatile"]);
  const catalog = await plain.connectionsHttp.catalog() as { platform: string; services: unknown[] };
  assert.deepEqual([catalog.platform, catalog.services], ["unconfigured", []]);
  await assert.rejects(plain.connectionsHttp.startAuthorization({}), (e: unknown) => e instanceof HostError && e.code === "device_unavailable");
});
