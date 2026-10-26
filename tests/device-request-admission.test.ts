import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { HostError, HostStore } from "@dexter/hub";

const code = (expected: string) => (error: unknown) => error instanceof HostError && error.code === expected;
function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), "admission-"));
  let now = 1_000;
  const store = new HostStore({ dataDir, clock: () => now, deviceTtlMs: 100 });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const bot = store.createBot({ name: "Synthetic", profileId: "personal", engine: "codex" });
  const thread = store.createThread(bot.id);
  const device = store.registerDevice({ name: "Synthetic Mac", platform: "macos", capabilities: ["fixture.run"] });
  store.setGrant({ botId: bot.id, tool: "fixture.run", destination: device.id, policy: "allow" });
  const request = (key: string, destination = device.id, tool = "fixture.run") => ({
    botId: bot.id, threadId: thread.id, tool, destination, arguments: { note: "synthetic" }, idempotencyKey: key,
  });
  const snapshot = () => ({ actions: store.listActions(), events: store.listEvents(0, 1000) });
  return { dataDir, store, bot, thread, device, request, snapshot, advance: () => { now += 101; } };
}

test("fresh revoked requests with historical allow or ask grants add no action or event", (t) => {
  const f = fixture(t);
  f.store.setGrant({ botId: f.bot.id, tool: "fixture.ask", destination: f.device.id, policy: "ask" });
  f.store.revokeDevice(f.device.id);
  const before = f.snapshot();
  for (const tool of ["fixture.run", "fixture.ask"]) assert.throws(() => f.store.requestAction(f.request(tool, f.device.id, tool)), code("forbidden"));
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.store.getGrant(f.bot.id, "fixture.run", f.device.id)?.policy, "allow");
  assert.throws(() => f.store.heartbeatDevice(f.device.id), code("forbidden"));
});

test("active offline device admits ready; claim stays pending until heartbeat", (t) => {
  const f = fixture(t); f.advance();
  assert.equal(f.store.devicePresence(f.device.id), "stale");
  const action = f.store.requestAction(f.request("offline"));
  assert.equal(action.state, "ready"); assert.equal(action.result, null);
  assert.throws(() => f.store.claimAction(action.id), code("device_unavailable"));
  assert.equal(f.store.getAction(action.id).state, "ready");
  f.store.heartbeatDevice(f.device.id);
  assert.equal(f.store.claimAction(action.id).state, "running");
});

test("active offline device admits approval without bypassing decision", (t) => {
  const f = fixture(t); f.advance();
  f.store.setGrant({ botId: f.bot.id, tool: "fixture.run", destination: f.device.id, policy: "ask" });
  assert.equal(f.store.requestAction(f.request("offline-ask")).state, "awaiting_approval");
});

test("registered device missing capability refuses fresh requests despite allow grant", (t) => {
  const f = fixture(t);
  f.store.setGrant({ botId: f.bot.id, tool: "fixture.other", destination: f.device.id, policy: "allow" });
  const before = f.snapshot();
  assert.throws(() => f.store.requestAction(f.request("missing-cap", f.device.id, "fixture.other")), code("forbidden"));
  assert.deepEqual(f.snapshot(), before);
});

test("zero-capability Apple client-shaped device is no action executor", (t) => {
  const f = fixture(t);
  const client = f.store.registerDevice({ name: "Synthetic app client", platform: "ios", capabilities: [] });
  f.store.setGrant({ botId: f.bot.id, tool: "fixture.run", destination: client.id, policy: "allow" });
  const before = f.snapshot();
  assert.throws(() => f.store.requestAction(f.request("client", client.id)), code("forbidden"));
  assert.deepEqual(f.snapshot(), before);
});

test("unknown dev_ destination refuses fresh action and event even with explicit grant", (t) => {
  const f = fixture(t);
  f.store.setGrant({ botId: f.bot.id, tool: "fixture.run", destination: "dev_unknown", policy: "allow" });
  const before = f.snapshot();
  assert.throws(() => f.store.requestAction(f.request("unknown", "dev_unknown")), code("forbidden"));
  assert.deepEqual(f.snapshot(), before);
});

test("connector and generic owner legacy destinations preserve grant and dispatch behavior", (t) => {
  const f = fixture(t);
  for (const destination of ["composio_account", "dest_legacy", "mac-local"]) {
    f.store.setGrant({ botId: f.bot.id, tool: "fixture.run", destination, policy: "allow" });
    const action = f.store.requestAction(f.request(destination, destination));
    assert.equal(action.state, "ready"); assert.equal(f.store.claimAction(action.id).state, "running");
  }
});

test("later revoke atomically blocks ready and approval; historical replay is exact and event-free", (t) => {
  const f = fixture(t);
  const ready = f.store.requestAction(f.request("ready"));
  f.store.setGrant({ botId: f.bot.id, tool: "fixture.run", destination: f.device.id, policy: "ask" });
  const waiting = f.store.requestAction(f.request("waiting"));
  f.store.revokeDevice(f.device.id);
  const before = f.snapshot();
  for (const [action, key] of [[ready, "ready"], [waiting, "waiting"]] as const) {
    const stored = f.store.getAction(action.id);
    assert.equal(stored.state, "blocked"); assert.equal(stored.reason, "permission_changed");
    assert.deepEqual(f.store.requestAction(f.request(key)), stored);
    assert.throws(() => f.store.claimAction(action.id), code("conflict"));
  }
  assert.deepEqual(f.snapshot(), before);
});

test("succeeded replay survives revoke; conflicting arguments and thread still conflict", (t) => {
  const f = fixture(t); const request = f.request("done");
  const action = f.store.requestAction(request); f.store.claimAction(action.id);
  const done = f.store.completeAction(action.id, { ok: true });
  const otherThread = f.store.createThread(f.bot.id);
  f.store.revokeDevice(f.device.id); const before = f.snapshot();
  assert.deepEqual(f.store.requestAction(request), done);
  assert.throws(() => f.store.requestAction({ ...request, arguments: { note: "changed" } }), code("conflict"));
  assert.throws(() => f.store.requestAction({ ...request, threadId: otherThread.id }), code("conflict"));
  assert.deepEqual(f.snapshot(), before);
});

test("fresh wrong bot/thread and missing per-bot grant cannot admit", (t) => {
  const f = fixture(t);
  const other = f.store.createBot({ name: "Other", profileId: "personal", engine: "codex" });
  const otherThread = f.store.createThread(other.id);
  const before = f.snapshot();
  assert.throws(() => f.store.requestAction({ ...f.request("wrong-thread"), threadId: otherThread.id }), code("forbidden"));
  assert.throws(() => f.store.requestAction({ ...f.request("wrong-bot"), botId: other.id }), code("forbidden"));
  assert.throws(() => f.store.requestAction({ ...f.request("no-grant"), botId: other.id, threadId: otherThread.id }), code("forbidden"));
  assert.deepEqual(f.snapshot(), before);
});

test("same key in another bot does not replay or inherit grant", (t) => {
  const f = fixture(t); f.store.requestAction(f.request("shared"));
  const other = f.store.createBot({ name: "Other", profileId: "personal", engine: "codex" });
  const otherThread = f.store.createThread(other.id); const before = f.snapshot();
  assert.throws(() => f.store.requestAction({ ...f.request("shared"), botId: other.id, threadId: otherThread.id }), code("forbidden"));
  assert.deepEqual(f.snapshot(), before);
});

test("writer fence refuses both fresh requests and exact historical replay", (t) => {
  const f = fixture(t); const request = f.request("existing"); f.store.requestAction(request);
  assert.throws(() => new HostStore({ dataDir: f.dataDir }), code("host_locked"));
  const raw = new DatabaseSync(f.store.databasePath);
  try { raw.exec("UPDATE host_lease SET token = 'synthetic-stolen'"); } finally { raw.close(); }
  const before = f.snapshot();
  assert.throws(() => f.store.requestAction(f.request("fresh")), code("host_locked"));
  assert.throws(() => f.store.requestAction(request), code("host_locked"));
  assert.deepEqual(f.snapshot(), before);
});
