// One HostStore writer + ConversationRuntime (fake engine) + DeviceServices with a real in-process Mac agent over
// its own TLS listener + AppClientServices over a separate mutual-TLS listener. Synthetic identities only.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:https";
import test, { type TestContext } from "node:test";
import { HostError } from "@dexter/hub";
import { FILE_APPEND, MacDeviceDaemon, createFixtureHandlers, generateSyntheticIdentity, pairDevice, type HostTrust, type TlsIdentity } from "@dexter/devices";
import { DeviceServices } from "../packages/cli/src/device-services.js";
import { ALL_SCOPES, appLab, call, pairClient } from "./app-client-lab.js";

async function composed(t: TestContext) {
  let ds: DeviceServices | undefined;
  let agentIdentity: TlsIdentity | undefined;
  const l = await appLab(t, { devices: (store) => {
    const root = join(store.databasePath, "..", "..");
    agentIdentity = generateSyntheticIdentity(join(root, "id-agent-host"), "agent-host");
    ds = new DeviceServices(store, { identity: agentIdentity, pollWaitMs: 50, receiptTimeoutMs: 3_000 });
    return { http: ds.http, admin: ds.admin, tools: ds.tools, close: () => ds!.close() };
  } });
  const agentUrl = await ds!.start();
  const trust: HostTrust = { hostUrl: agentUrl, hostCertPem: agentIdentity!.certPem, hostFingerprint: agentIdentity!.fingerprint };
  const fixtures = join(l.root, "fixtures"); mkdirSync(fixtures, { mode: 0o700 });
  const macKey = l.identity("agent-mac");
  const offer = ds!.admin.pairingBundle({ kind: "pair" });
  const pairing = pairDevice({ dataDir: join(l.root, "agent"), identity: macKey, trust, offerId: offer.offerId, code: offer.code, name: "Lab Mac agent", capabilities: [FILE_APPEND], pollIntervalMs: 10 });
  const until = async (check: () => boolean) => { const end = Date.now() + 5_000; while (!check()) { if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } };
  await until(() => ds!.admin.pendingClaims().length === 1);
  ds!.admin.approveClaim(ds!.admin.pendingClaims()[0]!.claimId);
  const agentId = (await pairing).deviceId;
  const daemon = new MacDeviceDaemon({ dataDir: join(l.root, "agent"), identity: macKey, trust, pollTimeoutMs: 3_000,
    handlers: createFixtureHandlers({ root: fixtures, enable: [FILE_APPEND] }) });
  t.after(async () => { await daemon.stop(); });
  return { l, ds: ds!, trust, agentId, daemon, macKey, fixtures };
}
function agentPost(trust: HostTrust, identity: TlsIdentity, path: string, body: unknown): Promise<number> {
  const url = new URL(trust.hostUrl), payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, method: "POST", path, agent: false, cert: identity.certPem, key: identity.keyPem,
      ca: [trust.hostCertPem], minVersion: "TLSv1.3", checkServerIdentity: () => undefined,
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
    req.on("error", reject); req.end(payload);
  });
}

test("agent-mac and app-client namespaces never authenticate on each other's listener; projection reports each role", async (t) => {
  const { l, trust, agentId, macKey } = await composed(t);
  const appMac = l.identity("client-mac");
  const clientId = await pairClient(l, appMac, "client-mac", ALL_SCOPES, "Lab Mac app");
  assert.notEqual(clientId, agentId, "same Mac, distinct bindings and keys");
  assert.equal(await agentPost(trust, appMac, "/v1/device/poll", { deviceId: clientId, installationId: l.store.hostId, receipts: [] }), 403);
  assert.equal(await agentPost(trust, appMac, "/v1/device/poll", { deviceId: agentId, installationId: l.store.hostId, receipts: [] }), 403);
  assert.equal((await call(l.trust, macKey, "GET", "/health")).status, 403, "agent pin is not an app client");
  const views = (await call(l.trust, appMac, "GET", "/v1/devices")).json.items as { id: string; role: string; capabilities: string[] }[];
  assert.deepEqual(views.map((v) => [v.id, v.role]), [[agentId, "agent-mac"], [clientId, "client-mac"]]);
  assert.deepEqual(views.find((v) => v.id === clientId)!.capabilities, []);
});

test("grant administration is default-deny, CAS-protected and refuses client destinations", async (t) => {
  const { l, agentId } = await composed(t);
  const phone = l.identity("phone");
  const phoneId = await pairClient(l, phone);
  const bot = (await call(l.trust, phone, "POST", "/v1/bots", { name: "Ops", profileId: "work", engine: "codex" })).json;
  const listed = await call(l.trust, phone, "GET", `/v1/device-grants?botId=${bot.id}`);
  assert.deepEqual(listed.json, { botId: bot.id, items: [{ botId: bot.id, tool: FILE_APPEND, destination: agentId, grant: null }] }, "pairing grants nothing");
  const put = (body: object) => call(l.trust, phone, "PUT", "/v1/device-grants", { botId: bot.id, tool: FILE_APPEND, destination: agentId, policy: "ask", expiresAt: null, expectedRevision: null, ...body });
  assert.equal((await put({ expectedRevision: 1 })).status, 409);
  const first = await put({});
  assert.deepEqual([first.status, first.json.revision, first.json.policy], [200, 1, "ask"]);
  assert.equal((await put({ policy: "allow" })).status, 409, "stale UI revision");
  assert.equal((await put({ destination: phoneId, expectedRevision: null })).status, 403, "client device is never a destination");
  assert.equal((await put({ tool: "file.read", expectedRevision: null })).status, 403, "undeclared operation");
  assert.equal((await put({ ownerId: l.store.ownerId })).status, 400, "closed body");
  const second = await put({ policy: "allow", expectedRevision: 1 });
  assert.equal(second.json.revision, 2);
});

test("approval from the app decides the same canonical action/hash, which the Mac agent then executes once", async (t) => {
  const { l, ds, agentId, daemon, fixtures } = await composed(t);
  const phone = l.identity("phone");
  await pairClient(l, phone);
  const bot = l.store.createBot({ name: "Ops", profileId: "work", engine: "codex" });
  const thread = l.store.createThread(bot.id);
  ds.admin.grant({ botId: bot.id, tool: FILE_APPEND, destination: agentId, policy: "ask" });
  // Stands in for a turn-owned tool request: the canonical action exists before the client sees it.
  const action = l.store.requestAction({ botId: bot.id, threadId: thread.id, tool: FILE_APPEND, destination: agentId,
    arguments: { name: "notes.txt", line: "approved from iPhone" }, idempotencyKey: "app-approval-1" });
  const seen = await call(l.trust, phone, "GET", `/v1/actions/${action.id}`);
  assert.deepEqual([seen.json.state, seen.json.requestHash], ["awaiting_approval", action.requestHash]);
  const wrong = await call(l.trust, phone, "POST", `/v1/actions/${action.id}/decisions`, { decision: "allow", requestHash: "0".repeat(64) });
  assert.notEqual(wrong.status, 200);
  assert.equal(l.store.getAction(action.id).state, "awaiting_approval");
  const decided = await call(l.trust, phone, "POST", `/v1/actions/${action.id}/decisions`, { decision: "allow", requestHash: action.requestHash });
  assert.deepEqual([decided.status, decided.json.id, decided.json.state], [200, action.id, "ready"]);
  assert.equal((await call(l.trust, phone, "POST", `/v1/actions/${action.id}/dispatch`, {})).status, 403, "the client cannot dispatch");
  await daemon.runOnce();
  const [done] = await Promise.all([ds.http.dispatch(action.id), daemon.runOnce()]);
  assert.equal(done.state, "succeeded");
  assert.equal(readFileSync(join(fixtures, "notes.txt"), "utf8"), "approved from iPhone\n");
  assert.equal(l.store.listActions().length, 1);
});

test("revoking the agent from the app is canonical and reaches the agent registry; client bindings are unaffected", async (t) => {
  const { l, ds, agentId, daemon } = await composed(t);
  const phone = l.identity("phone");
  await pairClient(l, phone);
  const revoked = await call(l.trust, phone, "POST", `/v1/devices/${agentId}/revoke`, {});
  assert.deepEqual([revoked.status, revoked.json.role, revoked.json.presence], [200, "unpaired", "revoked"]);
  assert.notEqual(l.store.getDevice(agentId).revokedAt, null);
  assert.equal(ds.tools.snapshot(agentId)?.status, "revoked");
  await assert.rejects(daemon.runOnce());
  assert.equal((await call(l.trust, phone, "GET", "/health")).status, 200);
  assert.throws(() => ds.admin.grant({ botId: l.store.createBot({ name: "B", profileId: "p", engine: "codex" }).id, tool: FILE_APPEND, destination: agentId, policy: "allow" }),
    (e: unknown) => e instanceof HostError && e.code === "forbidden");
});
