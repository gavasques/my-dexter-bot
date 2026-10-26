import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspect } from "node:util";
import { test, type TestContext } from "node:test";
import { ConversationRuntime, HostError, HostStore, type RuntimeDriver } from "@dexter/hub";
import { AgendaHostConsumer } from "../packages/agenda/src/host-consumer.js";
const until = async (check: () => boolean) => { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw Error("synthetic_driver_not_started"); await new Promise(r => setTimeout(r, 5)); } };
const code = (value: string) => (error: unknown) => error instanceof HostError && error.code === value;
function lab(t: TestContext, options: { noDriver?: boolean; failedClose?: boolean; start?: (runtime: ConversationRuntime) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dx-agenda-consumer-"));
  let store = new HostStore({ dataDir: root });
  const bot = store.createBot({ name: "Agenda", profileId: "trusted", engine: "claude" }), thread = store.createThread(bot.id);
  let calls = 0;
  const driver: RuntimeDriver = { id: "claude", sessionReuse: "turn", async open(threadId) { return { threadId, nativeCursor: "synthetic" }; },
    async *turn(session, turnId) { calls++; yield { type: "text.delta", threadId: session.threadId, turnId: turnId, text: "synthetic" };
      yield { type: "turn.completed", threadId: session.threadId, turnId: turnId, usage: {} }; }, async close() {}, async respondToTool() {}, async interrupt() {} };
  let runtime = new ConversationRuntime({ store, drivers: options.noDriver ? [] : [driver] }); options.start?.(runtime);
  let consumer = new AgendaHostConsumer({ store, runtime });
  t.after(async () => { await consumer.close().catch(error => { if (!options.failedClose) throw error; }); await runtime.shutdown({ graceMs: 1000, closeStore: false }); store.close(); rmSync(root, { recursive: true, force: true }); });
  const schedule = (content = "trusted agenda input") => consumer.admin.create({ botId: bot.id, threadId: thread.id, content, when: { kind: "once", at: store.now() } });
  return { root, bot, thread, schedule, get store() { return store; }, get runtime() { return runtime; }, get consumer() { return consumer; }, get calls() { return calls; },
    async reopen() { await consumer.close(); await runtime.shutdown({ graceMs: 1000, closeStore: false }); store.close(); store = new HostStore({ dataDir: root }); runtime = new ConversationRuntime({ store, drivers: [driver] }); consumer = new AgendaHostConsumer({ store, runtime }); } };
}

test("manual tick commits one canonical turn; concurrent/duplicate/restart ticks do not infer twice", async t => {
  const l = lab(t), schedule = l.schedule(); assert.equal(l.calls, 0); assert.equal(l.store.listTurns(l.thread.id).length, 0);
  const first = l.consumer.tick(); assert.equal(l.consumer.tick(), first); const report = await first; assert.equal(report.accepted, 1);
  const occurrence = l.consumer.admin.listOccurrences({ scheduleId: schedule.id }).items[0]!;
  assert.ok(occurrence.turnId); await until(() => l.calls === 1); await l.runtime.waitForTurn(occurrence.turnId!); assert.equal(l.calls, 1);
  assert.equal(l.store.getTurn(occurrence.turnId!).clientRequestId, occurrence.clientRequestId);
  assert.equal((await l.consumer.tick()).attempted, 0); await l.reopen(); assert.equal((await l.consumer.tick()).attempted, 0);
  assert.equal(l.calls, 1); assert.equal(l.store.listTurns(l.thread.id).length, 1);
});

test("commit-before-lost-receipt replay reuses exact ID/turn and content without second inference", async t => {
  let original: ConversationRuntime["startTurn"];
  const l = lab(t, { start(runtime) { original = runtime.startTurn.bind(runtime); let first = true;
    runtime.startTurn = (threadId, input) => { const accepted = original(threadId, input); if (first) { first = false; throw Error("synthetic_lost_receipt"); } return accepted; }; } });
  const schedule = l.schedule("fixed trusted text"); const failed = await l.consumer.tick(); assert.equal(failed.deferred, 1);
  const pending = l.consumer.admin.listOccurrences({ scheduleId: schedule.id }).items[0]!; assert.equal(pending.state, "prepared");
  const committed = l.store.findTurn(l.thread.id, pending.clientRequestId)!; await l.runtime.waitForTurn(committed.id); assert.equal(l.calls, 1);
  await l.reopen(); const retry = await l.consumer.tick(); assert.equal(retry.replayed, 1); assert.equal(retry.accepted, 0);
  assert.equal(l.consumer.admin.listOccurrences({ scheduleId: schedule.id }).items[0]!.turnId, committed.id);
  assert.equal(l.store.listTurns(l.thread.id).length, 1); assert.equal(l.calls, 1);
});

test("foreign runtime/store is rejected before agenda file; schedule and tick cannot select foreign principals", async t => {
  const l = lab(t); const otherRoot = mkdtempSync(join(tmpdir(), "dx-agenda-foreign-")); const other = new HostStore({ dataDir: otherRoot });
  const runtime = new ConversationRuntime({ store: other, drivers: [] });
  t.after(async () => { await runtime.shutdown(); rmSync(otherRoot, { recursive: true, force: true }); });
  assert.throws(() => new AgendaHostConsumer({ store: other, runtime: l.runtime }), code("conflict")); assert.equal(existsSync(join(otherRoot, "agenda.sqlite")), false);
  const bot = l.store.createBot({ name: "Other", profileId: "trusted", engine: "claude" });
  assert.throws(() => l.consumer.admin.create({ botId: bot.id, threadId: l.thread.id, content: "x", when: { kind: "once", at: l.store.now() } }), HostError);
  assert.throws(() => l.consumer.admin.create({ botId: l.bot.id, threadId: l.thread.id, content: "x", when: { kind: "once", at: l.store.now() }, hostId: other.hostId } as never), HostError);
  await assert.rejects((l.consumer.tick as (payload: unknown) => Promise<unknown>)({ botId: bot.id, threadId: l.thread.id }), code("invalid_input")); assert.equal(l.calls, 0);
});

test("revoke/disable after accepted turn cannot retract receipt or cause replacement turn", async t => {
  let consumer: AgendaHostConsumer | undefined;
  let scheduleId = "";
  const l = lab(t, { start(runtime) { const start = runtime.startTurn.bind(runtime); runtime.startTurn = (id, input) => {
    const receipt = start(id, input); consumer!.admin.disable(scheduleId); consumer!.stopAdmission(); return receipt;
  }; } });
  consumer = l.consumer; scheduleId = l.schedule().id;
  const report = await consumer.tick(); assert.equal(report.accepted, 1); assert.equal(report.pending, 0);
  await consumer.close(); assert.equal(l.store.listTurns(l.thread.id).length, 1);
  await assert.rejects(consumer.tick(), code("conflict")); await l.runtime.waitForTurn(l.store.listTurns(l.thread.id)[0]!.id); assert.equal(l.calls, 1);
});

test("close drains acceptance and ACK; admission stopped synchronously, borrowed runtime/store stay open", async t => {
  const l = lab(t), admin = l.consumer.admin; l.schedule(); const tick = l.consumer.tick(); const closing = l.consumer.close();
  assert.equal(l.consumer.close(), closing); assert.throws(() => admin.listSchedules(), code("conflict"));
  await assert.rejects(tick, code("conflict")); await closing; assert.equal(l.consumer.status().inFlight, 0); assert.equal(l.calls, 0);
  assert.equal(l.runtime.status().state, "running"); assert.ok(l.store.getBot(l.bot.id));
  assert.throws(() => new HostStore({ dataDir: l.root }), code("host_locked"));
});

test("lease loss before tick or after committed acceptance leaves durable prepared receipt, no new writer release", async t => {
  const l = lab(t); l.schedule(); const raw = new DatabaseSync(l.store.databasePath); t.after(() => raw.close());
  raw.exec("UPDATE host_lease SET token = 'synthetic-foreign' WHERE id = 1");
  await assert.rejects(l.consumer.tick(), code("host_locked")); assert.throws(() => l.consumer.admin.listSchedules(), code("host_locked")); assert.equal(l.calls, 0);
  await l.consumer.close(); assert.equal(l.consumer.status().closed, true);
});

test("recovered queued turn remains held; consumer never resumes it or starts a replacement", async t => {
  const l = lab(t, { noDriver: true });
  const preexisting = l.store.createTurn(l.thread.id, { clientRequestId: "manual-held", content: "held" });
  await l.reopen(); assert.equal(l.runtime.status().heldQueuedTurns, 1); l.schedule();
  const report = await l.consumer.tick(); assert.equal(report.deferred, 1); assert.equal(report.pending, 1);
  assert.equal(l.calls, 0); assert.equal(l.store.getTurn(preexisting.turn.id).state, "queued"); assert.equal(l.store.listTurns(l.thread.id).length, 1);
  await l.consumer.tick(); assert.equal(l.calls, 0); assert.equal(l.runtime.status().heldQueuedTurns, 1);
});

test("unknown committed turn replay is acknowledged without redispatch; status/inspection omit content", async t => {
  let original: ConversationRuntime["startTurn"];
  const l = lab(t, { noDriver: true, start(runtime) { original = runtime.startTurn.bind(runtime); runtime.startTurn = (id, input) => { const receipt = original(id, input); throw Object.assign(Error("lost"), { receipt }); }; } });
  const schedule = l.schedule("PRIVATE_SYNTHETIC_CONTENT"); assert.equal((await l.consumer.tick()).deferred, 1);
  const occurrence = l.consumer.admin.listOccurrences({ scheduleId: schedule.id }).items[0]!, committed = l.store.findTurn(l.thread.id, occurrence.clientRequestId)!;
  // Simulate only the durable crash boundary; no driver or effect is active in this fixture.
  const raw = new DatabaseSync(l.store.databasePath); raw.prepare("UPDATE turns SET state = 'running' WHERE id = ?").run(committed.id); raw.close();
  await l.reopen(); assert.equal(l.store.getTurn(committed.id).state, "unknown");
  assert.equal((await l.consumer.tick()).replayed, 1); assert.equal(l.calls, 0); assert.equal(l.store.listTurns(l.thread.id).length, 1);
  assert.equal((JSON.stringify(l.consumer) + inspect(l.consumer, { showHidden: true, depth: 10 })).includes("PRIVATE_SYNTHETIC_CONTENT"), false);
});

test("writer loss between committed turn and ACK preserves original intent for read-only replay after recovery", async t => {
  let loseLease = false;
  const l = lab(t, { start(runtime) { const start = runtime.startTurn.bind(runtime); runtime.startTurn = (id, input) => {
    const committed = start(id, input); if (loseLease) { const raw = new DatabaseSync(l.store.databasePath); raw.exec("UPDATE host_lease SET token = 'synthetic-loss-after-commit' WHERE id = 1"); raw.close(); } return committed;
  }; } });
  const schedule = l.schedule(); const raw = new DatabaseSync(l.store.databasePath), token = (raw.prepare("SELECT token FROM host_lease WHERE id = 1").get() as { token: string }).token;
  loseLease = true; await assert.rejects(l.consumer.tick(), code("host_locked")); assert.equal(l.consumer.status().lastOutcome, "failed");
  const agenda = new DatabaseSync(join(l.root, "agenda.sqlite")); const pending = agenda.prepare("SELECT state, client_request_id, turn_id FROM occurrences WHERE schedule_id = ?").get(schedule.id) as { state: string; client_request_id: string; turn_id: string | null };
  assert.equal(pending.state, "prepared"); assert.equal(pending.turn_id, null); const turn = l.store.findTurn(l.thread.id, pending.client_request_id)!; assert.ok(turn);
  // Synthetic restoration of this same test writer only, before any replacement writer is acquired.
  raw.prepare("UPDATE host_lease SET token = ? WHERE id = 1").run(token); raw.close(); agenda.close(); loseLease = false;
  await l.reopen(); assert.equal((await l.consumer.tick()).replayed, 1); assert.equal(l.store.listTurns(l.thread.id).length, 1);
});

test("close requested during acceptance waits for final ACK before owned Agenda closes", async t => {
  let closing: Promise<void> | undefined;
  const l = lab(t, { start(runtime) { const start = runtime.startTurn.bind(runtime); runtime.startTurn = (id, input) => {
    const committed = start(id, input); closing = l.consumer.close(); assert.equal(l.consumer.status().closed, false); return committed;
  }; } });
  const schedule = l.schedule(); const report = await l.consumer.tick(); await closing;
  assert.equal(report.accepted, 1); assert.equal(l.consumer.status().closed, true);
  const raw = new DatabaseSync(join(l.root, "agenda.sqlite")); const receipt = raw.prepare("SELECT state, turn_id FROM occurrences WHERE schedule_id = ?").get(schedule.id) as { state: string; turn_id: string };
  assert.equal(receipt.state, "accepted"); assert.ok(l.store.getTurn(receipt.turn_id)); raw.close(); assert.equal(l.runtime.status().state, "running");
});

test("cancel after actual synthetic start leaves engine drain with runtime and retains canonical writer", async t => {
  const root = mkdtempSync(join(tmpdir(), "dx-agenda-cancel-")); const store = new HostStore({ dataDir: root });
  const bot = store.createBot({ name: "Agenda", profileId: "trusted", engine: "claude" }), thread = store.createThread(bot.id);
  let release = () => {}; let entered = false; const held = new Promise<void>(resolve => { release = resolve; });
  const runtime = new ConversationRuntime({ store, abortGraceMs: 10, drivers: [{ id: "claude", sessionReuse: "turn",
    async open(threadId) { return { threadId, nativeCursor: "synthetic" }; }, async *turn() { entered = true; await held; },
    async close() {}, async interrupt() {}, async respondToTool() {} }] });
  const consumer = new AgendaHostConsumer({ store, runtime });
  t.after(async () => { release(); await consumer.close(); await runtime.shutdown({ graceMs: 1000 }); rmSync(root, { recursive: true, force: true }); });
  consumer.admin.create({ botId: bot.id, threadId: thread.id, content: "trusted", when: { kind: "once", at: store.now() } });
  const report = await consumer.tick(), id = report.attempts[0]!.turnId!;
  const end = Date.now() + 5000; while (!entered) { if (Date.now() > end) throw Error("fixture_timeout"); await new Promise(r => setTimeout(r, 5)); }
  runtime.cancelTurn(id); await consumer.close(); await assert.rejects(runtime.shutdown({ graceMs: 20 }));
  assert.throws(() => new HostStore({ dataDir: root }), code("host_locked")); assert.equal(consumer.status().closed, true);
  release(); await runtime.shutdown({ graceMs: 1000 }); const reopened = new HostStore({ dataDir: root }); assert.equal(reopened.listTurns(thread.id).length, 1); reopened.close();
});

// Synthetic rebinding of the runtime's private store field: models a runtime that no longer serves this host.
const rebind = (runtime: ConversationRuntime, store: HostStore) => { (runtime as unknown as { store: HostStore }).store = store; };
const occurrenceRows = (root: string) => { const raw = new DatabaseSync(join(root, "agenda.sqlite"));
  try { return raw.prepare("SELECT state, turn_id, attempts FROM occurrences ORDER BY scheduled_at, schedule_id").all() as { state: string; turn_id: string | null; attempts: number }[]; } finally { raw.close(); } };
function foreign(t: TestContext) { const root = mkdtempSync(join(tmpdir(), "dx-agenda-other-")); const store = new HostStore({ dataDir: root });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); }); return store; }

test("forged runtime receipt for another turn id is never acknowledged", async t => {
  const l = lab(t, { start(runtime) { const start = runtime.startTurn.bind(runtime);
    runtime.startTurn = (id, input) => { const receipt = start(id, input); return { ...receipt, turn: { ...receipt.turn, id: "turn_forged" } }; }; } });
  const schedule = l.schedule(); const report = await l.consumer.tick();
  assert.equal(report.accepted, 0); assert.equal(report.deferred, 1); assert.equal(report.pending, 1);
  const occurrence = l.consumer.admin.listOccurrences({ scheduleId: schedule.id }).items[0]!;
  assert.equal(occurrence.state, "prepared"); assert.equal(occurrence.turnId, null);
  const turns = l.store.listTurns(l.thread.id); assert.equal(turns.length, 1); assert.equal(turns[0]!.clientRequestId, occurrence.clientRequestId);
  await l.runtime.waitForTurn(turns[0]!.id); assert.equal(l.calls, 1);
});

test("stop inside the first startTurn of two due schedules admits no second runtime call", async t => {
  let starts = 0, late: Promise<unknown> | undefined;
  const l = lab(t, { start(runtime) { const start = runtime.startTurn.bind(runtime);
    runtime.startTurn = (id, input) => { starts++; const receipt = start(id, input); l.consumer.stopAdmission(); late = l.consumer.tick(); late.catch(() => {}); return receipt; }; } });
  const second = l.store.createThread(l.bot.id); l.schedule("first");
  l.consumer.admin.create({ botId: l.bot.id, threadId: second.id, content: "second", when: { kind: "once", at: l.store.now() } });
  const report = await l.consumer.tick();
  // A tick requested after stop is refused rather than joining (and reporting) the in-flight pass.
  await assert.rejects(late!, code("conflict"));
  assert.equal(starts, 1); assert.equal(report.accepted, 1); assert.equal(report.deferred, 1); assert.equal(report.pending, 1);
  assert.equal(l.store.listTurns(l.thread.id).length + l.store.listTurns(second.id).length, 1);
  assert.deepEqual(occurrenceRows(l.root).map(row => row.state).sort(), ["accepted", "prepared"]);
  assert.equal(occurrenceRows(l.root).find(row => row.state === "prepared")!.turn_id, null);
});

test("lost runtime binding is refused by the consumer before Agenda preparation or runtime calls", async t => {
  let starts = 0;
  const l = lab(t, { start(runtime) { const start = runtime.startTurn.bind(runtime); runtime.startTurn = (id, input) => { starts++; return start(id, input); }; } });
  const other = foreign(t); l.schedule(); rebind(l.runtime, other);
  assert.throws(() => l.consumer.admin.listSchedules(), code("conflict"));
  await assert.rejects(l.consumer.tick(), code("conflict"));
  assert.equal(starts, 0); assert.deepEqual(occurrenceRows(l.root), []); assert.equal(l.store.listTurns(l.thread.id).length, 0);
  rebind(l.runtime, l.store);
});

test("binding or writer loss after commit is refused at the consumer before receipt query or ACK", async t => {
  const other = foreign(t); let mode: "rebind" | "lease" | null = null, lost = false, queriesAfterLoss = 0;
  const l = lab(t, { start(runtime) { const start = runtime.startTurn.bind(runtime); runtime.startTurn = (id, input) => {
    const receipt = start(id, input);
    if (mode === "rebind") rebind(runtime, other);
    if (mode === "lease") { const raw = new DatabaseSync(l.store.databasePath); raw.exec("UPDATE host_lease SET token = 'synthetic-post-commit' WHERE id = 1"); raw.close(); }
    lost = mode !== null; return receipt; }; } });
  const find = l.store.findTurn.bind(l.store);
  l.store.findTurn = (threadId, clientRequestId) => { if (lost) queriesAfterLoss++; return find(threadId, clientRequestId); };
  l.schedule(); mode = "rebind";
  // Agenda defers the refused receipt; the pass itself then fails its final binding check instead of completing.
  await assert.rejects(l.consumer.tick(), code("conflict")); assert.deepEqual([l.consumer.status().lastOutcome, l.consumer.status().completedTicks], ["failed", 0]);
  assert.equal(queriesAfterLoss, 0); assert.deepEqual(occurrenceRows(l.root).map(row => [row.state, row.turn_id]), [["prepared", null]]);
  assert.equal(l.store.listTurns(l.thread.id).length, 1); assert.equal(other.listBots().length, 0);
  rebind(l.runtime, l.store); lost = false; mode = "lease";
  const raw = new DatabaseSync(l.store.databasePath), token = (raw.prepare("SELECT token FROM host_lease WHERE id = 1").get() as { token: string }).token;
  await assert.rejects(l.consumer.tick(), code("host_locked"));
  assert.equal(queriesAfterLoss, 0); assert.deepEqual(occurrenceRows(l.root).map(row => [row.state, row.turn_id]), [["prepared", null]]);
  raw.prepare("UPDATE host_lease SET token = ? WHERE id = 1").run(token); raw.close(); mode = null; lost = false;
  assert.equal((await l.consumer.tick()).replayed, 1); assert.equal(l.store.listTurns(l.thread.id).length, 1);
});

test("forged binding by subclass or instance override over a same-id foreign store is rejected before any agenda file", async t => {
  const rootA = mkdtempSync(join(tmpdir(), "dx-agenda-same-a-")), rootB = mkdtempSync(join(tmpdir(), "dx-agenda-same-b-"));
  const seed = new HostStore({ dataDir: rootA }); const bot = seed.createBot({ name: "Agenda", profileId: "trusted", engine: "claude" }), thread = seed.createThread(bot.id); seed.close();
  cpSync(rootA, rootB, { recursive: true });
  // Schema 4: a copied directory never becomes a writer by itself.
  assert.throws(() => new HostStore({ dataDir: rootB }), code("host_locked"));
  // Same-uid forgery (outside the authority model) rebinds the copy, to build the same-id foreign store under test.
  const forge = new DatabaseSync(join(rootB, "dexter.sqlite")), realB = realpathSync(rootB);
  forge.prepare("UPDATE host_authority SET directory = ?, directory_ino = ?").run(realB, statSync(realB, { bigint: true }).ino.toString()); forge.close();
  const store = new HostStore({ dataDir: rootA }), copy = new HostStore({ dataDir: rootB });
  class Forged extends ConversationRuntime { override isBoundTo(_store: HostStore): boolean { return true; } }
  const forged = new Forged({ store: copy, drivers: [] }), overridden = new ConversationRuntime({ store: copy, drivers: [] });
  overridden.isBoundTo = () => true;
  t.after(async () => { await forged.shutdown({ closeStore: false }); await overridden.shutdown({ closeStore: false }); store.close(); copy.close();
    rmSync(rootA, { recursive: true, force: true }); rmSync(rootB, { recursive: true, force: true }); });
  assert.equal(copy.hostId, store.hostId); assert.equal(copy.ownerId, store.ownerId); assert.equal(copy.getThread(thread.id).botId, bot.id);
  assert.equal(forged.isBoundTo(store), true);
  for (const runtime of [forged, overridden]) assert.throws(() => new AgendaHostConsumer({ store, runtime }), code("conflict"));
  assert.equal(existsSync(join(rootA, "agenda.sqlite")), false); assert.equal(copy.listTurns(thread.id).length, 0);
});

test("unused consumer disposes synchronously, closing only its Agenda handle; close becomes a resolved no-op", async t => {
  const l = lab(t), wal = join(l.root, "agenda.sqlite-wal"), admin = l.consumer.admin;
  assert.equal(existsSync(wal), true);
  assert.equal(l.consumer.disposeUnstarted(), undefined); assert.equal(existsSync(wal), false);
  assert.deepEqual([l.consumer.status().closed, l.consumer.status().admission], [true, "stopped"]);
  l.consumer.disposeUnstarted(); const closing = l.consumer.close(); assert.equal(l.consumer.close(), closing); await closing;
  assert.throws(() => admin.listSchedules(), code("conflict")); await assert.rejects(l.consumer.tick(), code("conflict"));
  assert.equal(l.consumer.disposeUnstarted(), undefined);
  assert.equal(l.runtime.status().state, "running"); assert.ok(l.store.getBot(l.bot.id)); assert.throws(() => new HostStore({ dataDir: l.root }), code("host_locked"));
  const next = new AgendaHostConsumer({ store: l.store, runtime: l.runtime }); next.stopAdmission(); next.disposeUnstarted(); assert.equal(next.status().closed, true);
});

test("any used, closing or in-flight consumer refuses dispose without closing its Agenda", async t => {
  const admin = lab(t); admin.consumer.admin.listSchedules();
  assert.throws(() => admin.consumer.disposeUnstarted(), code("conflict")); assert.equal(admin.consumer.admin.listSchedules().items.length, 0);
  const rejected = lab(t); assert.throws(() => rejected.consumer.admin.create({} as never), HostError);
  assert.throws(() => rejected.consumer.disposeUnstarted(), code("conflict"));
  const payload = lab(t); await assert.rejects((payload.consumer.tick as (body: unknown) => Promise<unknown>)({}), code("invalid_input"));
  assert.throws(() => payload.consumer.disposeUnstarted(), code("conflict"));
  const closing = lab(t); const closed = closing.consumer.close(); assert.throws(() => closing.consumer.disposeUnstarted(), code("conflict")); await closed;
  let refused: unknown;
  const flight = lab(t, { start(runtime) { const start = runtime.startTurn.bind(runtime);
    runtime.startTurn = (id, input) => { try { flight.consumer.disposeUnstarted(); } catch (error) { refused = error; } return start(id, input); }; } });
  flight.schedule(); const tick = flight.consumer.tick(); assert.throws(() => flight.consumer.disposeUnstarted(), code("conflict"));
  assert.equal((await tick).accepted, 1); assert.ok(code("conflict")(refused)); assert.equal(flight.consumer.status().closed, false);
  assert.equal(flight.consumer.admin.listOccurrences().items[0]!.state, "accepted"); await flight.consumer.close(); assert.equal(flight.consumer.status().closed, true);
});

test("dispose failure on a lost writer is cached quarantine: no close, retry or recovery", async t => {
  const l = lab(t, { failedClose: true }), wal = join(l.root, "agenda.sqlite-wal");
  const raw = new DatabaseSync(l.store.databasePath), token = (raw.prepare("SELECT token FROM host_lease WHERE id = 1").get() as { token: string }).token;
  raw.exec("UPDATE host_lease SET token = 'synthetic-foreign' WHERE id = 1");
  let failure: unknown; try { l.consumer.disposeUnstarted(); } catch (error) { failure = error; }
  assert.ok(code("host_locked")(failure)); assert.equal(existsSync(wal), true);
  raw.prepare("UPDATE host_lease SET token = ? WHERE id = 1").run(token); raw.close();
  await assert.rejects(l.consumer.tick(), code("conflict")); assert.throws(() => l.consumer.admin.listSchedules(), code("conflict"));
  assert.throws(() => l.consumer.disposeUnstarted(), error => error === failure);
  const closing = l.consumer.close(); assert.equal(l.consumer.close(), closing); await assert.rejects(closing, error => error === failure);
  await assert.rejects(l.consumer.tick(), code("conflict")); assert.throws(() => l.consumer.admin.listSchedules(), code("conflict"));
  assert.deepEqual([l.consumer.status().closed, l.consumer.status().admission], [false, "stopped"]); assert.equal(existsSync(wal), true);
  assert.throws(() => new HostStore({ dataDir: l.root }), code("host_locked"));
});

test("writer lost while Agenda closes its handle is still reported as a failed, quarantined dispose", async t => {
  const l = lab(t, { failedClose: true }); let armed = false, fences = 0;
  const fence = l.store.withWriterLease.bind(l.store);
  l.store.withWriterLease = <T>(operation: () => T): T => {
    if (armed && ++fences === 2) { const raw = new DatabaseSync(l.store.databasePath); raw.exec("UPDATE host_lease SET token = 'synthetic-during-close' WHERE id = 1"); raw.close(); }
    return fence(operation);
  };
  armed = true; assert.throws(() => l.consumer.disposeUnstarted(), code("host_locked")); assert.equal(fences, 3);
  assert.equal(l.consumer.status().closed, false); await assert.rejects(l.consumer.close(), code("host_locked"));
  assert.throws(() => l.consumer.disposeUnstarted(), code("host_locked"));
});
