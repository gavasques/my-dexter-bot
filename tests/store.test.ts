import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { HostError, HostStore, SCHEMA_VERSION, hashRequest, type HostStoreOptions } from "@dexter/hub";

type Ctx = { after: (fn: () => void) => void };
const TTL = 60_000;

function tempDir(t: Ctx): string {
  const dir = mkdtempSync(join(tmpdir(), "dexter-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function open(t: Ctx, extra: Partial<HostStoreOptions> = {}) {
  const dir = tempDir(t);
  const clock = { now: 1_000_000 };
  const store = new HostStore({ dataDir: dir, clock: () => clock.now, approvalTtlMs: TTL, deviceTtlMs: TTL, ...extra });
  t.after(() => store.close());
  return { dir, store, clock };
}
function seed(store: HostStore) {
  const bot = store.createBot({ name: "General", profileId: "personal", engine: "claude" });
  const thread = store.createThread(bot.id);
  return { bot, thread };
}
function request(botId: string, threadId: string, overrides: Record<string, unknown> = {}) {
  return { botId, threadId, tool: "mail.send", destination: "composio", arguments: { to: "a@example.com" }, idempotencyKey: "k1", ...overrides };
}
function code(expected: string) {
  return (error: unknown) => error instanceof HostError && error.code === expected;
}

test("opens a WAL database with schema version, foreign keys and private permissions", (t) => {
  const { dir, store } = open(t);
  const raw = new DatabaseSync(store.databasePath, { readOnly: true });
  t.after(() => raw.close());
  assert.equal((raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  assert.equal((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(store.databasePath).mode & 0o777, 0o600);
  assert.throws(() => store.createThread("bot_missing"), code("not_found"));
  const summary = store.summary();
  assert.equal(summary.lease.pid, process.pid);
  assert.equal(summary.hostId, store.hostId);
  assert.deepEqual(summary.counts.bots, 0);
});

test("messages are idempotent per thread and listed by cursor; events carry no content", (t) => {
  const { store } = open(t);
  const { thread } = seed(store);
  const first = store.appendMessage(thread.id, { clientMessageId: "m1", content: "private words" });
  assert.deepEqual(store.appendMessage(thread.id, { clientMessageId: "m1", content: "private words" }), first);
  assert.throws(() => store.appendMessage(thread.id, { clientMessageId: "m1", content: "other" }), code("conflict"));
  assert.throws(() => store.appendMessage(thread.id, { clientMessageId: "m1", content: "private words" }, "assistant"), code("conflict"));
  const second = store.appendMessage(thread.id, { clientMessageId: "m2", content: "reply" }, "assistant");
  assert.ok(second.cursor > first.cursor);
  assert.deepEqual(store.listMessages(thread.id, first.cursor).map((m) => m.id), [second.id]);
  assert.deepEqual(store.listMessages(thread.id, 0, 1).map((m) => m.id), [first.id]);
  assert.throws(() => store.appendMessage(thread.id, { clientMessageId: "m3", content: "" }), code("invalid_input"));
  const events = store.listEvents();
  assert.deepEqual(events.map((e) => e.kind), ["bot.created", "thread.created", "message.appended", "message.appended"]);
  assert.ok(!JSON.stringify(events).includes("private words"));
  assert.deepEqual(store.listEvents(events[1]!.cursor, 1).map((e) => e.id), [events[2]!.id]);
  assert.ok(!JSON.stringify(store.summary()).includes("private words"));
});

test("a second writer is refused while the lease is held, and allowed after close", (t) => {
  const { dir, store } = open(t);
  assert.throws(() => new HostStore({ dataDir: dir }), code("host_locked"));
  store.close();
  const reopened = new HostStore({ dataDir: dir });
  assert.equal(reopened.hostId, store.hostId);
  reopened.close();
});

test("a lease held by another hostname is never taken over implicitly", (t) => {
  const dir = tempDir(t);
  new HostStore({ dataDir: dir }).close();
  const raw = new DatabaseSync(join(dir, "dexter.sqlite"));
  raw.prepare("INSERT INTO host_lease (id, hostname, pid, token, acquired_at) VALUES (1, ?, 1, 'foreign', 0)").run(`${hostname()}-other`);
  raw.close();
  assert.throws(() => new HostStore({ dataDir: dir }), code("host_locked"));
});

test("writes are fenced by the lease token", (t) => {
  const { store } = open(t);
  const raw = new DatabaseSync(store.databasePath);
  raw.exec("UPDATE host_lease SET token = 'stolen'");
  raw.close();
  assert.throws(() => store.createBot({ name: "x", profileId: "p", engine: "codex" }), code("host_locked"));
  assert.equal(store.listBots().length, 0);
});

test("owner and schema version mismatches are refused", (t) => {
  const dir = tempDir(t);
  new HostStore({ dataDir: dir, ownerId: "owner-a" }).close();
  assert.throws(() => new HostStore({ dataDir: dir, ownerId: "owner-b" }), code("forbidden"));
  const raw = new DatabaseSync(join(dir, "dexter.sqlite"));
  raw.exec("PRAGMA user_version = 99");
  raw.close();
  assert.throws(() => new HostStore({ dataDir: dir }), code("conflict"));
});

test("actions require an effective grant and are idempotent by key", (t) => {
  const { store, clock } = open(t);
  const { bot, thread } = seed(store);
  assert.throws(() => store.requestAction(request(bot.id, thread.id)), code("forbidden"));
  store.setGrant({ botId: bot.id, tool: "mail.send", destination: "composio", policy: "deny" });
  assert.throws(() => store.requestAction(request(bot.id, thread.id)), code("forbidden"));
  const grant = store.setGrant({ botId: bot.id, tool: "mail.send", destination: "composio", policy: "allow", expiresAt: clock.now + 1_000 });
  assert.equal(grant.revision, 2);
  const action = store.requestAction(request(bot.id, thread.id));
  assert.equal(action.state, "ready");
  assert.equal(action.grantRevision, 2);
  assert.equal(action.requestHash, hashRequest(action.request));
  assert.deepEqual(store.requestAction(request(bot.id, thread.id)), action);
  assert.throws(() => store.requestAction(request(bot.id, thread.id, { arguments: { to: "b@example.com" } })), code("conflict"));
  clock.now += 1_000;
  assert.throws(() => store.requestAction(request(bot.id, thread.id, { idempotencyKey: "k2" })), code("forbidden"));
  assert.throws(() => store.requestAction(request(bot.id, thread.id, { idempotencyKey: "k3", arguments: { apiKey: "x" } })), code("invalid_input"));
  const other = store.createBot({ name: "Other", profileId: "personal", engine: "codex" });
  assert.throws(() => store.requestAction(request(other.id, thread.id, { idempotencyKey: "k4" })), code("forbidden"));
});

test("grant revocation blocks pending actions and claims revalidate the revision", (t) => {
  const { store } = open(t);
  const { bot, thread } = seed(store);
  store.setGrant({ botId: bot.id, tool: "mail.send", destination: "composio", policy: "ask" });
  const pending = store.requestAction(request(bot.id, thread.id));
  assert.equal(pending.state, "awaiting_approval");
  store.setGrant({ botId: bot.id, tool: "mail.send", destination: "composio", policy: "deny" });
  const blocked = store.getAction(pending.id);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.reason, "permission_changed");
  assert.throws(() => store.decideAction(pending.id, { decision: "allow", requestHash: pending.requestHash }), code("conflict"));
  assert.throws(() => store.claimAction(pending.id), code("conflict"));
  assert.equal(store.getGrant(bot.id, "mail.send", "composio")?.revision, 2);

  // A grant edited outside setGrant (defense in depth) is caught at claim time.
  store.setGrant({ botId: bot.id, tool: "mail.send", destination: "composio", policy: "allow" });
  const ready = store.requestAction(request(bot.id, thread.id, { idempotencyKey: "k2" }));
  const raw = new DatabaseSync(store.databasePath);
  raw.exec("UPDATE grants SET revision = revision + 1");
  raw.close();
  assert.throws(() => store.claimAction(ready.id), code("forbidden"));
  assert.equal(store.getAction(ready.id).state, "blocked");
});

test("approval is bound to the request hash; first decision wins", (t) => {
  const { store } = open(t);
  const { bot, thread } = seed(store);
  store.setGrant({ botId: bot.id, tool: "mail.send", destination: "composio", policy: "ask" });
  const action = store.requestAction(request(bot.id, thread.id));
  const otherHash = hashRequest({ ...action.request, arguments: { to: "evil@example.com" } });
  assert.throws(() => store.decideAction(action.id, { decision: "allow", requestHash: otherHash }), code("conflict"));
  assert.equal(store.getAction(action.id).state, "awaiting_approval");
  const approved = store.decideAction(action.id, { decision: "allow", requestHash: action.requestHash });
  assert.equal(approved.state, "ready");
  assert.equal(approved.decidedBy, store.ownerId);
  assert.throws(() => store.decideAction(action.id, { decision: "deny", requestHash: action.requestHash }), code("conflict"));
  assert.equal(store.getAction(action.id).state, "ready");

  const second = store.requestAction(request(bot.id, thread.id, { idempotencyKey: "k2" }));
  assert.equal(store.decideAction(second.id, { decision: "deny", requestHash: second.requestHash }).reason, "user_denied");
  assert.throws(() => store.decideAction(second.id, { decision: "allow", requestHash: second.requestHash }), code("conflict"));
  assert.equal(store.getAction(second.id).state, "denied");
});

test("expired approvals are persisted as denied and cannot be approved", (t) => {
  const { store, clock } = open(t);
  const { bot, thread } = seed(store);
  store.setGrant({ botId: bot.id, tool: "mail.send", destination: "composio", policy: "ask" });
  const action = store.requestAction(request(bot.id, thread.id));
  assert.equal(action.approvalExpiresAt, clock.now + TTL);
  clock.now += TTL;
  assert.throws(() => store.decideAction(action.id, { decision: "allow", requestHash: action.requestHash }), code("conflict"));
  const expired = store.getAction(action.id);
  assert.equal(expired.state, "denied");
  assert.equal(expired.reason, "approval_expired");
  const swept = store.requestAction(request(bot.id, thread.id, { idempotencyKey: "k2" }));
  clock.now += TTL;
  assert.equal(store.expireApprovals(), 1);
  assert.equal(store.getAction(swept.id).reason, "approval_expired");
});

test("device presence, stale devices and revocation gate dispatch", (t) => {
  const { store, clock } = open(t);
  const { bot, thread } = seed(store);
  const phone = store.registerDevice({ name: "iPhone", platform: "ios", capabilities: ["health.read"] });
  assert.equal(store.devicePresence(phone.id), "online");
  store.setGrant({ botId: bot.id, tool: "health.read", destination: phone.id, policy: "allow" });
  const action = store.requestAction(request(bot.id, thread.id, { tool: "health.read", destination: phone.id, arguments: {} }));
  clock.now += TTL;
  assert.equal(store.devicePresence(phone.id), "stale");
  assert.throws(() => store.claimAction(action.id), code("device_unavailable"));
  assert.equal(store.getAction(action.id).state, "ready");
  store.heartbeatDevice(phone.id);
  assert.equal(store.claimAction(action.id).state, "running");

  const later = store.requestAction(request(bot.id, thread.id, { tool: "health.read", destination: phone.id, arguments: {}, idempotencyKey: "k2" }));
  store.revokeDevice(phone.id);
  assert.equal(store.devicePresence(phone.id), "revoked");
  assert.equal(store.getAction(later.id).state, "blocked");
  assert.throws(() => store.heartbeatDevice(phone.id), code("forbidden"));
  assert.equal(store.summary().counts.devices.revoked, 1);

  const mac = store.registerDevice({ name: "Mac", platform: "macos", capabilities: [] });
  store.setGrant({ botId: bot.id, tool: "health.read", destination: mac.id, policy: "allow" });
  const actionsBeforeMissing = store.listActions().length, eventsBeforeMissing = store.listEvents(0, 1000).length;
  assert.throws(() => store.requestAction(request(bot.id, thread.id, { tool: "health.read", destination: mac.id, arguments: {}, idempotencyKey: "k3" })), code("forbidden"));
  assert.equal(store.listActions().length, actionsBeforeMissing, "missing capability refuses before insert");
  assert.equal(store.listEvents(0, 1000).length, eventsBeforeMissing, "missing capability emits no event");
});
