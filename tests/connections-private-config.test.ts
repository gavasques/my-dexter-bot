import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { inspect } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import {
  CONNECTIONS_CAPABILITY_ACK_SCHEMA, CONNECTIONS_CAPABILITY_FRAME_SCHEMA, CONNECTIONS_PLATFORM_CREDENTIAL_REF, ConnectionsConfigurationStatusSchema,
  SetConnectionsConfigurationSchema, isTrustedConnectionsOrigin,
} from "@dexter/contracts";
import { connectionsConfigurationDigest } from "@dexter/connectors";
import type { EngineDriver } from "@dexter/engines";
import { HostError } from "@dexter/hub";
import { createAuthorizedHostRouter, createHostApp, type HostRequestAuthority } from "@dexter/hub/http";
import { CHECKPOINT_EXCLUDED } from "@dexter/operations";
import { HostServices } from "../packages/cli/src/host-services.js";
import { planHostStartup } from "../packages/cli/src/host-startup.js";
import { bindBrowserUsePrivateInput } from "../packages/cli/src/browser-use-private-input.js";
import {
  CONNECTIONS_CONFIGURATION_DATABASE_FILE, connectionsConfigurationHttpPort, connectionsConfigurationRequestHash, withPrivateCustodyStatus, type ConnectionsComposition,
  type ConnectionsPrivateEnvironment,
} from "../packages/cli/src/connections-configuration.js";
import { ConnectionsCapabilityVault } from "../packages/cli/src/connections-private-custody.js";
import { planConnectionsPrivateStartup } from "../packages/cli/src/connections-startup.js";
import { SERVICE_ORIGIN } from "./fixtures/connections-lab.js";
import { tlsServiceLab } from "./fixtures/connections-tls-lab.js";

// Owner-private configuration of the connections service: metadata ledger (CAS + receipts), startup planner into
// planHostStartup → providers.connections, in-memory capability custody filled ONLY by the app-owned private pipe, and a
// real connections service over synthetic TLS. No real provider, account, Keychain, network or product port.
const driver = (id: EngineDriver["id"]): EngineDriver => ({ id, capabilities: { resume: true, interrupt: true, fork: false, steer: false },
  async status() { return { engine: id, installed: true, version: "fixture", authentication: "authenticated", billing: "subscription" }; },
  async open(threadId) { return { threadId, nativeCursor: "synthetic" }; }, async *turn(session, turnId) { yield { type: "turn.completed", threadId: session.threadId, turnId, usage: {} }; },
  async respondToTool() {}, async interrupt() {}, async close() {} });
const code = (name: string) => (e: unknown) => e instanceof HostError && e.code === name;
const ENV: ConnectionsPrivateEnvironment = Object.freeze({ channel: true, mcpEngines: true, exclusiveUpstream: false });
const dir = (t: TestContext, prefix: string): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const input = (hostId: string, id: string, revision: number, origin: string | null, enabled: boolean, renewCredential = false) =>
  ({ expectedHostId: hostId, clientRequestId: id, expectedRevision: revision, origin, enabled, renewCredential });
function portOf(services: HostServices, composition: () => ConnectionsComposition = () => null, custody: ConnectionsCapabilityVault | null = new ConnectionsCapabilityVault(null),
  environment = ENV) {
  return connectionsConfigurationHttpPort({ ledger: () => services.connectionsConfigurationLedger,
    identity: () => ({ hostId: services.store.hostId, ownerId: services.store.ownerId }), environment, composition, custody });
}
/** Saves an enabled configuration through the real owner port of a short-lived host, then releases the writer. */
async function configured(t: TestContext, origin = SERVICE_ORIGIN): Promise<{ dataDir: string; hostId: string; ownerId: string }> {
  const dataDir = dir(t, "dx-conn-private-");
  const services = new HostServices({ dataDir });
  try {
    portOf(services).configure(input(services.store.hostId, "seed-1", 0, origin, true));
    return { dataDir, hostId: services.store.hostId, ownerId: services.store.ownerId };
  } finally { await services.shutdown(); }
}

test("contract: closed trusted origin, strict request (no credential field), consistent status", () => {
  for (const ok of ["https://connections.dexter.test", "https://conn.example.com", "https://a-b.c.example"]) assert.ok(isTrustedConnectionsOrigin(ok), ok);
  for (const bad of ["http://connections.dexter.test", "https://connections.dexter.test/", "https://connections.dexter.test:8443", "https://Connections.dexter.test",
    "https://user@connections.dexter.test", "https://connections.dexter.test/v1", "https://connections.dexter.test?x=1", "https://127.0.0.1", "https://[::1]",
    "https://localhost", "https://svc.localhost", "https://intranet", "https://1.2.3.4", "https://-bad.example.com", "", "ftp://x.example.com"])
    assert.equal(isTrustedConnectionsOrigin(bad), false, bad);
  const base = input("host", "r1", 0, SERVICE_ORIGIN, true);
  assert.ok(SetConnectionsConfigurationSchema.safeParse(base).success);
  for (const bad of [{ ...base, origin: null }, { ...base, capability: "c".repeat(43) }, { ...base, credentialRef: "other" }, { ...base, renewCredential: undefined },
    { ...base, clientRequestId: "../x" }, { ...base, expectedRevision: -1 }])
    assert.equal(SetConnectionsConfigurationSchema.safeParse(bad).success, false, JSON.stringify(bad));
  assert.equal(connectionsConfigurationRequestHash(base), connectionsConfigurationRequestHash({ ...base }), "canonical hash is key-order independent");
});

test("ledger: CAS, generations, receipt dedup, conflicts, lost ACK by GET only; owner-only file without any secret; checkpoint excludes it", async t => {
  const dataDir = dir(t, "dx-conn-ledger-"), services = new HostServices({ dataDir });
  t.after(() => services.shutdown());
  const hostId = services.store.hostId, port = portOf(services);
  let status = port.status();
  assert.deepEqual([status.configuration.revision, status.configuration.generation, status.configuration.enabled, status.runtime.state, status.runtime.reason,
    status.custody.channel, status.custody.state], [0, 0, false, "inactive", "disabled", "app_private_channel", "absent"]);
  assert.equal(statSync(dataDir).isDirectory() && !readFileSync(join(dataDir, "dexter.sqlite")).length, false);
  assert.throws(() => statSync(join(dataDir, CONNECTIONS_CONFIGURATION_DATABASE_FILE)), "reads never create the ledger");
  const first = port.configure(input(hostId, "c-1", 0, SERVICE_ORIGIN, true));
  assert.deepEqual([first.receipt.previousRevision, first.receipt.configuration.revision, first.receipt.configuration.generation, first.receipt.restartRequired],
    [0, 1, 1, true]);
  assert.equal(first.receipt.requestHash, connectionsConfigurationRequestHash(input(hostId, "c-1", 0, SERVICE_ORIGIN, true)));
  assert.equal(first.status.runtime.state, "restart_required", "saving is not running, let alone connected");
  assert.deepEqual(port.configure(input(hostId, "c-1", 0, SERVICE_ORIGIN, true)).receipt, first.receipt, "exact replay returns the original receipt");
  assert.throws(() => port.configure(input(hostId, "c-1", 0, SERVICE_ORIGIN, false)), code("conflict"), "same id, other body");
  assert.throws(() => port.configure(input(hostId, "c-2", 0, SERVICE_ORIGIN, false)), code("conflict"), "stale revision");
  assert.throws(() => port.configure(input("host_other", "c-3", 1, SERVICE_ORIGIN, false)), code("conflict"), "another host");
  assert.throws(() => port.configure(input(hostId, "c-4", 1, SERVICE_ORIGIN, true)), code("conflict"), "already current");
  assert.throws(() => port.configure(input(hostId, "c-5", 1, null, false, true)), code("invalid_input"), "renewal without origin");
  assert.throws(() => port.configure({ ...input(hostId, "c-6", 1, SERVICE_ORIGIN, true, true), capability: "c".repeat(43) }), code("invalid_input"), "no credential field");
  const renewed = port.configure(input(hostId, "c-7", 1, SERVICE_ORIGIN, true, true)).receipt;
  assert.deepEqual([renewed.configuration.revision, renewed.configuration.generation, renewed.previousGeneration], [2, 2, 1]);
  const moved = port.configure(input(hostId, "c-8", 2, "https://conn.example.com", true)).receipt;
  assert.equal(moved.configuration.generation, 3, "another origin starts another credential generation");
  const off = port.configure(input(hostId, "c-9", 3, "https://conn.example.com", false)).receipt;
  assert.deepEqual([off.configuration.generation, off.restartRequired], [3, false], "disabling without a composed service needs no restart");
  // Lost acknowledgement: only GET of the original id decides; an absent receipt is unconfirmed (null), never "not applied".
  assert.deepEqual(port.receipt("c-8"), moved);
  assert.equal(port.receipt("never-sent"), null);
  status = port.status();
  assert.equal(ConnectionsConfigurationStatusSchema.safeParse(status).success, true);
  const file = join(dataDir, CONNECTIONS_CONFIGURATION_DATABASE_FILE);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const columns = (db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all() as Array<{ sql: string }>).map(r => r.sql).join(" ");
    assert.doesNotMatch(columns, /capability|secret|token|key_value|bearer/i);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='installation_id'").get()!.value, hostId);
  } finally { db.close(); }
  assert.equal(CHECKPOINT_EXCLUDED[CONNECTIONS_CONFIGURATION_DATABASE_FILE], "connections_platform_configuration_reentered_by_owner");
  // A ledger copied from another installation is refused, never adopted.
  const other = dir(t, "dx-conn-ledger-other-"), foreign = new HostServices({ dataDir: other });
  t.after(() => foreign.shutdown());
  copyFileSync(file, join(other, CONNECTIONS_CONFIGURATION_DATABASE_FILE)); chmodSync(join(other, CONNECTIONS_CONFIGURATION_DATABASE_FILE), 0o600);
  assert.throws(() => portOf(foreign).status(), code("conflict"));
});

test("startup planner: composes providers.connections only with channel + MCP engines + sole upstream + same bound origin; capability never read", async t => {
  const fetch = async (): Promise<Response> => { throw new Error("no network at plan time"); };
  const plan = (dataDir: string, over: Partial<{ channel: boolean; enableMcp: boolean; enableEngines: boolean; exclusiveUpstream: boolean }> = {}) =>
    planConnectionsPrivateStartup({ dataDir, channel: true, enableMcp: true, enableEngines: true, exclusiveUpstream: false, fetch, ...over });
  const fresh = dir(t, "dx-conn-fresh-");
  let p = plan(fresh);
  assert.deepEqual([p.provider, p.reason, p.composition], [undefined, null, null]);
  assert.ok(p.vault && p.vault.scope === null, "a vault without a composed service refuses every capability");
  assert.equal(plan(fresh, { channel: false }).vault, undefined);
  const lab = await configured(t);
  assert.deepEqual(["channel", "enableMcp", "enableEngines", "exclusiveUpstream"].map(flag =>
    plan(lab.dataDir, { [flag]: flag === "exclusiveUpstream" }).reason), ["private_channel_unavailable", "requires_mcp_engines", "requires_mcp_engines", "exclusive_upstream"]);
  p = plan(lab.dataDir);
  assert.ok(p.provider && p.vault);
  assert.deepEqual(p.composition, { source: "owner_private", origin: SERVICE_ORIGIN, generation: 1 });
  assert.deepEqual([p.provider.credentialRef, p.provider.platform.origin], [CONNECTIONS_PLATFORM_CREDENTIAL_REF, SERVICE_ORIGIN]);
  assert.throws(() => p.provider!.platform.capability(), "nothing until the private pipe delivers it");
  const startup = planHostStartup({ route: "laboratory", options: { dataDir: lab.dataDir, enableEngines: true, enableMcp: true, enableConnections: true },
    providers: { connections: p.provider }, makeDriver: driver });
  assert.equal(startup.description.connections, "configured");
  // connections.sqlite bound to another configuration: compose nothing (the runtime would refuse it), never crash startup.
  const bound = join(lab.dataDir, "connections.sqlite"), db = new DatabaseSync(bound);
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
  db.prepare("INSERT INTO meta VALUES ('configuration', ?)").run(connectionsConfigurationDigest("https://other.example.com", CONNECTIONS_PLATFORM_CREDENTIAL_REF)); db.close();
  assert.equal(plan(lab.dataDir).reason, "origin_bound_to_other_connections");
  rmSync(bound);
  chmodSync(join(lab.dataDir, CONNECTIONS_CONFIGURATION_DATABASE_FILE), 0o644);
  assert.equal(plan(lab.dataDir).reason, "configuration_unavailable", "an unsafe ledger is never trusted");
});

test("real HostServices + real connections service over synthetic TLS: capability only via the private pipe, exact scope, lock, lost ACK by GET", async t => {
  const service = await tlsServiceLab(t), lab = await configured(t);
  const startup = planConnectionsPrivateStartup({ dataDir: lab.dataDir, channel: true, enableMcp: true, enableEngines: true, exclusiveUpstream: false, fetch: service.fetch });
  assert.ok(startup.provider && startup.vault);
  const services = planHostStartup({ route: "laboratory", options: { dataDir: lab.dataDir, enableEngines: true, enableMcp: true, enableConnections: true },
    providers: { connections: startup.provider }, makeDriver: driver }).open();
  t.after(() => services.shutdown());
  const vault = startup.vault; vault.arm(services.store.hostId);
  const composition = (): ConnectionsComposition => services.connectionsServiceOrigin === SERVICE_ORIGIN ? startup.composition : null;
  const port = portOf(services, composition, vault);
  // Same composition as `dexter serve`: the status of an owner-private service follows its custody, never the capability.
  const app = createHostApp(services.store, { connections: withPrivateCustodyStatus(services.connectionsHttp, { composition, custody: vault }), connectionsConfiguration: port });
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await app.request("http://127.0.0.1" + path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: r.status, json: await r.json() as any, text: "" };
  };
  let status = (await api("GET", "/v1/connections/platform-configuration")).json;
  assert.deepEqual([status.runtime.state, status.runtime.origin, status.runtime.generation, status.custody.state], ["active", SERVICE_ORIGIN, 1, "absent"]);
  assert.equal((await api("GET", "/v1/connections/status")).json.platform, "unavailable", "composed without its capability is not available");
  await api("GET", "/v1/connections/catalog");
  assert.equal(service.seen.length, 0, "no request leaves the host without the capability");
  // The REAL private pipe reader (the same function `dexter serve` binds to stdin), fed like the app's FIFO.
  const pipe = new PassThrough(), acks: Array<Record<string, unknown>> = [];
  const reader = bindBrowserUsePrivateInput(pipe, services.store.hostId, services.browserUseKeyVault, line => acks.push(JSON.parse(line)), undefined, undefined, vault);
  t.after(() => reader.close());
  const capability = service.issue({ installationId: services.store.hostId, ownerId: services.store.ownerId });
  const send = async (frame: Record<string, unknown>): Promise<Record<string, unknown> | undefined> => {
    const before = acks.length; pipe.write(JSON.stringify(frame) + "\n");
    for (let i = 0; i < 100 && acks.length === before; i++) await new Promise(r => setTimeout(r, 5));
    return acks[before];
  };
  const frame = (over: Record<string, unknown> = {}) => ({ schema: CONNECTIONS_CAPABILITY_FRAME_SCHEMA, requestId: randomUUID(), hostID: services.store.hostId,
    operation: "set", origin: SERVICE_ORIGIN, generation: 1, capability, ...over });
  for (const bad of [{ generation: 2 }, { origin: "https://conn.example.com" }, { capability: "short" }, { extra: true }])
    assert.equal((await send(frame(bad)))?.status, "refused", JSON.stringify(Object.keys(bad)));
  const ready = frame(), ack = await send(ready);
  assert.deepEqual(ack, { schema: CONNECTIONS_CAPABILITY_ACK_SCHEMA, requestId: ready.requestId, hostID: services.store.hostId, status: "ready" });
  status = (await api("GET", "/v1/connections/platform-configuration")).json;
  assert.deepEqual([status.custody.state, status.custody.generation, status.privateRequest.requestId, status.privateRequest.state], ["ready", 1, ready.requestId, "ready"]);
  const catalog = await api("GET", "/v1/connections/catalog");
  assert.equal(catalog.status, 200); assert.deepEqual(catalog.json.services.map((s: { serviceId: string }) => s.serviceId), ["gmail"]);
  assert.ok(service.seen.length >= 1 && service.seen.every(r => r.authorization === `Bearer ${capability}` && r.installation === services.store.hostId),
    "only the delivered capability, over verified TLS to the configured origin");
  assert.equal((await api("GET", "/v1/connections/status")).json.platform, "available");
  // Lost acknowledgement: the lock is written, its ACK dropped; GET (not a resend) settles the exact request id.
  const lock = frame({ operation: "lock" }); delete (lock as Record<string, unknown>).capability;
  pipe.write(JSON.stringify(lock) + "\n");
  for (let i = 0; i < 100 && vault.status().state !== "locked"; i++) await new Promise(r => setTimeout(r, 5));
  status = (await api("GET", "/v1/connections/platform-configuration")).json;
  assert.deepEqual([status.privateRequest.requestId, status.privateRequest.operation, status.privateRequest.state, status.custody.state],
    [lock.requestId, "lock", "locked", "locked"]);
  assert.equal((await send(ready))?.status, "ready", "a repeated request id returns its recorded outcome");
  assert.equal(vault.status().state, "locked", "...without a second effect");
  const before = service.seen.length;
  await api("GET", "/v1/connections/catalog");
  assert.equal(service.seen.length, before, "locked custody sends nothing");
  // The secret never reaches persisted metadata, receipts, acknowledgements, status or the runtime's own files.
  for (const text of [JSON.stringify(status), JSON.stringify(acks), JSON.stringify(port.receipt("seed-1")),
    readFileSync(join(lab.dataDir, CONNECTIONS_CONFIGURATION_DATABASE_FILE)).toString("latin1"), readFileSync(join(lab.dataDir, "connections.sqlite")).toString("latin1"),
    inspect(services, { depth: 6 }), inspect(vault, { depth: 6 })]) assert.ok(!text.includes(capability));
});

test("owner loopback only: paired router 403, no query, absent receipt 404; an operator-injected service is configured externally and refuses owner saves", async t => {
  const dataDir = dir(t, "dx-conn-routes-"), services = new HostServices({ dataDir });
  t.after(() => services.shutdown());
  const port = portOf(services), app = createHostApp(services.store, { connectionsConfiguration: port });
  assert.equal((await app.request("http://127.0.0.1/v1/connections/platform-configuration?x=1")).status, 400);
  assert.equal((await app.request("http://127.0.0.1/v1/connections/platform-configuration/receipts/never")).status, 404);
  const put = await app.request("http://127.0.0.1/v1/connections/platform-configuration", { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify(input(services.store.hostId, "route-1", 0, SERVICE_ORIGIN, true)) });
  assert.equal(put.status, 200);
  assert.equal(((await put.json()) as { receipt: { configuration: { revision: number } } }).receipt.configuration.revision, 1);
  const authority = { principal: "paired-client", installationId: services.store.hostId, ownerId: services.store.ownerId, deviceId: "device_fixture", role: "client-mac",
    scopes: ["approvals.decide", "approvals.read", "chat.read", "chat.write", "devices.manage", "devices.read", "grants.manage", "grants.read", "outputs.manage", "outputs.read"],
    pinGeneration: 1, bindingRevision: 1, assertCurrent() {}, noteSelfRevoke() {} } as unknown as HostRequestAuthority;
  const paired = createAuthorizedHostRouter(services.store, {});
  for (const [method, path] of [["GET", "/v1/connections/platform-configuration"], ["PUT", "/v1/connections/platform-configuration"],
    ["GET", "/v1/connections/platform-configuration/receipts/route-1"]] as const) {
    const r = await paired.fetch(new Request("https://app-client.invalid" + path, { method, ...(method === "PUT" ? { headers: { "content-type": "application/json" },
      body: JSON.stringify(input(services.store.hostId, "route-2", 1, SERVICE_ORIGIN, false)) } : {}) }), { authority });
    assert.equal(r.status, 403, `${method} ${path}`);
  }
  const external = portOf(services, () => ({ source: "external", origin: SERVICE_ORIGIN }), null, { channel: false, mcpEngines: true, exclusiveUpstream: false });
  const status = external.status();
  assert.deepEqual([status.runtime.state, status.custody.channel, status.custody.state], ["configured_externally", "unavailable", "absent"]);
  assert.throws(() => external.configure(input(services.store.hostId, "route-3", 1, SERVICE_ORIGIN, false)), code("conflict"));
  const noChannel = portOf(services, () => null, null, { channel: false, mcpEngines: true, exclusiveUpstream: false }).status();
  assert.deepEqual([noChannel.runtime.state, noChannel.runtime.reason], ["inactive", "private_channel_unavailable"], "saved and enabled is still honest without the channel");
});
