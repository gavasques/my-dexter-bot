import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HostError, HostStore, canonicalJson, dispatchAction, hashRequest } from "@dexter/hub";
import type { JsonValue, ToolRequest } from "@dexter/contracts";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "dexter-review-"));
  let now = 1000;
  const store = new HostStore({ dataDir: dir, clock: () => now, approvalTtlMs: 100 });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const bot = store.createBot({ name: "General", profileId: "personal", engine: "claude" });
  const thread = store.createThread(bot.id);
  return { store, bot, thread, setTime: (time: number) => { now = time; } };
}

test("review P1: approval expires while waiting and never reaches the executor", async (t) => {
  const { store, bot, thread, setTime } = fixture(t);
  store.setGrant({ botId: bot.id, tool: "mail.send", destination: "host", policy: "ask" });
  const action = store.requestAction({ botId: bot.id, threadId: thread.id, tool: "mail.send", destination: "host",
    arguments: { subject: "Test" }, idempotencyKey: "approval-expiry" });
  store.decideAction(action.id, { decision: "allow", requestHash: action.requestHash });
  setTime(1200);
  let effects = 0;
  await assert.rejects(dispatchAction(store, action.id, async () => { effects++; return {}; }));
  assert.equal(effects, 0);
  assert.equal(store.getAction(action.id).state, "denied");
  assert.equal(store.getAction(action.id).reason, "approval_expired");
});

test("review P2: circular or throwing receipts never leave an action running", async (t) => {
  const { store, bot, thread } = fixture(t);
  store.setGrant({ botId: bot.id, tool: "files.read", destination: "host", policy: "allow" });
  const circular: Record<string, JsonValue> = {};
  circular["self"] = circular;
  const action = store.requestAction({ botId: bot.id, threadId: thread.id, tool: "files.read", destination: "host",
    arguments: {}, idempotencyKey: "circular-receipt" });
  const receipt = await dispatchAction(store, action.id, async () => circular);
  assert.equal(receipt.state, "succeeded");
  assert.deepEqual(receipt.result, { omitted: "result_not_json" });
  await assert.rejects(dispatchAction(store, action.id, async () => circular));
});

test("device namespace cannot silently turn an unknown device into a host destination", async (t) => {
  const { store, bot, thread } = fixture(t);
  store.setGrant({ botId: bot.id, tool: "files.read", destination: "dev_missing", policy: "allow" });
  const counts = store.summary().counts;
  assert.throws(() => store.requestAction({ botId: bot.id, threadId: thread.id, tool: "files.read", destination: "dev_missing",
    arguments: {}, idempotencyKey: "missing-device" }), forbidden);
  assert.deepEqual(store.summary().counts, counts);
  assert.equal(store.listActions().length, 0);
});

const forbidden = (error: unknown) => error instanceof HostError && error.code === "forbidden";

// Test-only pre-upgrade database fixture: the old request admission could persist these READY rows.
// Keep matching request hash, grant revision and owner/bot/thread so claim must reach the device guard.
function preUpgradeReady(store: HostStore, request: ToolRequest) {
  const grant = store.getGrant(request.botId, request.tool, request.destination)!;
  assert.equal(grant.policy, "allow");
  const id = "act_pre_upgrade";
  const raw = new DatabaseSync(store.databasePath);
  try {
    raw.prepare(`INSERT INTO actions (id, bot_id, thread_id, tool, destination, idempotency_key,
      request, request_hash, grant_revision, state, created_at, updated_at, approval_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 1000, 1000, NULL)`)
      .run(id, request.botId, request.threadId, request.tool, request.destination, request.idempotencyKey,
        canonicalJson(request as unknown as JsonValue), hashRequest(request), grant.revision);
  } finally { raw.close(); }
  const action = store.getAction(id);
  assert.equal(action.state, "ready");
  assert.equal(action.requestHash, hashRequest(request));
  assert.equal(action.grantRevision, grant.revision);
  return action;
}

for (const kind of ["unknown canonical device", "missing device capability"] as const) {
  test(`pre-upgrade READY row: claim blocks ${kind} without executor effects`, async (t) => {
    const { store, bot, thread } = fixture(t);
    const destination = kind === "unknown canonical device" ? "dev_missing"
      : store.registerDevice({ name: "Synthetic pre-upgrade Mac", platform: "macos", capabilities: [] }).id;
    store.setGrant({ botId: bot.id, tool: "files.read", destination, policy: "allow" });
    const request: ToolRequest = { botId: bot.id, threadId: thread.id, tool: "files.read", destination,
      arguments: {}, idempotencyKey: "pre-upgrade" };
    const beforeFresh = store.summary().counts;
    assert.throws(() => store.requestAction(request), forbidden);
    assert.deepEqual(store.summary().counts, beforeFresh);
    const action = preUpgradeReady(store, request);
    const actionsBeforeClaim = store.listActions().length;
    const cursor = store.listEvents().at(-1)!.cursor;
    let effects = 0;
    await assert.rejects(dispatchAction(store, action.id, async () => { effects++; return {}; }), forbidden);
    assert.equal(effects, 0);
    const blocked = store.getAction(action.id);
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.reason, "permission_changed");
    assert.equal(blocked.result, null);
    assert.equal(store.listActions().length, actionsBeforeClaim);
    assert.deepEqual(store.listEvents(cursor).map(e => e.kind), ["action.blocked"]);
    assert.equal(store.getGrant(bot.id, request.tool, destination)!.revision, action.grantRevision);
    if (kind === "missing device capability") assert.deepEqual(store.getDevice(destination).capabilities, []);
    const beforeReplay = store.summary().counts;
    assert.deepEqual(store.requestAction(request), blocked, "historical replay survives fresh admission refusal");
    await assert.rejects(dispatchAction(store, action.id, async () => { effects++; return {}; }));
    assert.equal(effects, 0);
    assert.deepEqual(store.summary().counts, beforeReplay);
  });
}
