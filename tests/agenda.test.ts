import assert from "node:assert/strict";
import { copyFileSync, readFileSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Agenda, AGENDA_DATABASE_FILE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_SCHEDULES_PER_TICK, MIN_INTERVAL_MS } from "../packages/agenda/src/index.js";
import { ConversationRuntime, HostError, HostStore, type HostStoreOptions } from "@dexter/hub";

type Ctx = { after: (fn: () => void | Promise<void>) => void };
interface Stack {
  dir: string;
  time: { now: number };
  store: HostStore;
  runtime: ConversationRuntime;
  agenda: Agenda;
  botId: string;
  threadId: string;
}

function code(expected: string) {
  return (error: unknown) => error instanceof HostError && error.code === expected;
}

function makeStack(t: Ctx, dir: string | undefined = mkdtempSync(join(tmpdir(), "dexter-agenda-")), options: {
  now?: number; store?: Partial<HostStoreOptions>; maxSchedulesPerTick?: number; maxDispatchesPerTick?: number;
} = {}): Stack {
  const time = { now: options.now ?? 1_800_000_000_000 };
  const store = new HostStore({ dataDir: dir, clock: () => time.now, ...options.store });
  const bot = store.createBot({ name: "Agenda fixture", profileId: "local-test", engine: "claude" });
  const thread = store.createThread(bot.id);
  const runtime = new ConversationRuntime({ store, drivers: [] });
  const agenda = new Agenda(store, {
    clock: () => time.now,
    ...(options.maxSchedulesPerTick === undefined ? {} : { maxSchedulesPerTick: options.maxSchedulesPerTick }),
    ...(options.maxDispatchesPerTick === undefined ? {} : { maxDispatchesPerTick: options.maxDispatchesPerTick }),
  });
  t.after(async () => {
    try {
      agenda.close();
      await runtime.shutdown({ graceMs: 500 });
    } catch { store.close(); }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, time, store, runtime, agenda, botId: bot.id, threadId: thread.id };
}

async function stop(stack: Stack): Promise<void> {
  stack.agenda.close();
  await stack.runtime.shutdown({ graceMs: 500 });
}

function once(stack: Stack, at = stack.time.now, content = "Read the local agenda item") {
  return stack.agenda.create({ botId: stack.botId, threadId: stack.threadId, content, when: { kind: "once", at } });
}

function scheduleRows(stack: Stack) { return stack.agenda.listSchedules().items; }
function occurrenceRows(stack: Stack, scheduleId?: string) {
  return stack.agenda.listOccurrences(scheduleId === undefined ? {} : { scheduleId }).items;
}

test("once creates one durable intent before startTurn and accepts a single Hub receipt", async (t) => {
  const s = makeStack(t);
  assert.throws(() => new HostStore({ dataDir: s.dir }), code("host_locked"));
  const schedule = once(s);
  const report = s.agenda.tick(s.runtime);

  assert.deepEqual([report.prepared, report.attempted, report.accepted, report.pending], [1, 1, 1, 0]);
  const occurrence = occurrenceRows(s, schedule.id)[0]!;
  assert.deepEqual([occurrence.state, occurrence.scheduleRevision, occurrence.attempts], ["accepted", 1, 1]);
  assert.match(occurrence.clientRequestId, /^agenda_[a-f0-9]{64}$/);
  assert.equal(s.runtime.listTurns(s.threadId).length, 1);
  assert.equal(s.store.listMessages(s.threadId).filter((message) => message.role === "user").length, 1);
  assert.equal(scheduleRows(s)[0]!.state, "completed");

  // A terminal driver failure is the Hub's receipt, not a reason to deliver this once-schedule again.
  const turn = s.runtime.listTurns(s.threadId)[0]!;
  assert.equal((await s.runtime.waitForTurn(turn.id)).code, "no_driver");
  const repeat = s.agenda.tick(s.runtime);
  assert.deepEqual([repeat.prepared, repeat.attempted, s.runtime.listTurns(s.threadId).length], [0, 0, 1]);
});

test("pending due intent survives host restart and is dispatched only after reopening", async (t) => {
  const s = makeStack(t);
  const schedule = once(s);
  assert.deepEqual(s.agenda.prepareDue(), { prepared: 1, pending: 1, truncated: false });
  assert.equal(occurrenceRows(s, schedule.id)[0]!.state, "prepared");
  const requestId = occurrenceRows(s, schedule.id)[0]!.clientRequestId;
  await stop(s);

  const reopened = makeStack(t, s.dir, { now: s.time.now });
  assert.deepEqual(occurrenceRows(reopened, schedule.id).map((row) => row.clientRequestId), [requestId]);
  const report = reopened.agenda.dispatchPrepared(reopened.runtime);
  assert.deepEqual([report.accepted, report.replayed, report.pending], [1, 0, 0]);
  assert.equal(reopened.runtime.listTurns(schedule.threadId).length, 1);
  assert.equal(reopened.store.listMessages(schedule.threadId).filter((message) => message.role === "user").length, 1);
});

test("a lost response after Hub commit replays the same request ID after restart", async (t) => {
  const s = makeStack(t);
  const schedule = once(s);
  const loseReceipt = {
    startTurn(threadId: string, input: { clientRequestId: string; content: string }) {
      s.runtime.startTurn(threadId, input); // HostStore has committed; simulate process loss before agenda receipt.
      throw new Error("synthetic lost receipt; deliberately not persisted or returned");
    },
  };
  const first = s.agenda.tick(loseReceipt);
  assert.deepEqual([first.attempted, first.deferred, first.pending], [1, 1, 1]);
  assert.deepEqual(s.agenda.pruneTerminalOccurrences({ beforeUpdatedAt: s.time.now }), { deleted: 0, truncated: false });
  assert.equal(occurrenceRows(s, schedule.id)[0]!.state, "prepared");
  const original = s.runtime.listTurns(s.threadId)[0]!;
  await s.runtime.waitForTurn(original.id);
  const originalId = occurrenceRows(s, schedule.id)[0]!.clientRequestId;
  await stop(s);

  const reopened = makeStack(t, s.dir, { now: s.time.now });
  const recovered = reopened.agenda.dispatchPrepared(reopened.runtime);
  assert.deepEqual([recovered.accepted, recovered.replayed, recovered.deferred], [0, 1, 0]);
  const turns = reopened.runtime.listTurns(schedule.threadId);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.clientRequestId, originalId);
  assert.deepEqual([occurrenceRows(reopened, schedule.id)[0]!.state, occurrenceRows(reopened, schedule.id)[0]!.turnId],
    ["accepted", original.id]);
});

test("a reentrant disable after Hub commit records the accepted receipt instead of claiming cancellation", (t) => {
  const s = makeStack(t);
  const schedule = once(s);
  const unsubscribe = s.runtime.subscribe((notice) => {
    if (notice.state === "queued") s.agenda.disable(schedule.id);
  });
  const report = s.agenda.tick(s.runtime);
  unsubscribe();

  assert.deepEqual([report.attempted, report.accepted, report.replayed, report.deferred], [1, 1, 0, 0]);
  assert.equal(scheduleRows(s)[0]!.state, "disabled");
  const occurrence = occurrenceRows(s, schedule.id)[0]!;
  assert.deepEqual([occurrence.state, occurrence.turnId], ["accepted", s.runtime.listTurns(schedule.threadId)[0]!.id]);
});

test("accepted timeout and unknown turns are replayed as receipts, never delivered again", (t) => {
  const s = makeStack(t);
  const scenarios = [
    { state: "failed" as const, code: "timeout" as const, content: "Timed out once" },
    { state: "unknown" as const, code: "host_interrupted" as const, content: "Unknown outcome once" },
  ];
  for (const scenario of scenarios) {
    const schedule = once(s, s.time.now, scenario.content);
    assert.equal(s.agenda.prepareDue().prepared, 1);
    const occurrence = occurrenceRows(s, schedule.id)[0]!;

    // Exercise the public HostStore commit path and simulate a terminal state reached before the agenda
    // could write its receipt. The deterministic request ID must resolve to this exact durable turn.
    const accepted = s.store.createTurn(schedule.threadId, { clientRequestId: occurrence.clientRequestId, content: schedule.content });
    assert.equal(accepted.created, true);
    assert.equal(s.store.claimNextTurn(schedule.threadId)!.id, accepted.turn.id);
    s.store.finishTurn(accepted.turn.id, scenario.state, scenario.code);
    const recovered = s.agenda.dispatchPrepared(s.runtime);
    assert.equal(recovered.replayed, 1);
    assert.equal(occurrenceRows(s, schedule.id)[0]!.turnId, accepted.turn.id);
    assert.deepEqual([s.runtime.getTurn(accepted.turn.id).state, s.runtime.getTurn(accepted.turn.id).code], [scenario.state, scenario.code]);
  }
  assert.equal(s.runtime.listTurns(s.threadId).length, scenarios.length);
  assert.equal(s.store.listMessages(s.threadId).filter((message) => message.role === "user").length, scenarios.length);
});

test("interval catch-up coalesces to the latest missed UTC slot and a backward clock creates nothing", (t) => {
  const s = makeStack(t);
  const interval = MIN_INTERVAL_MS;
  const anchor = s.time.now - 8 * interval;
  const schedule = s.agenda.create({ botId: s.botId, threadId: s.threadId, content: "Check once after downtime",
    when: { kind: "interval", everyMs: interval, firstAt: anchor } });
  const latest = anchor + Math.floor((s.time.now - anchor) / interval) * interval;

  const first = s.agenda.prepareDue();
  assert.deepEqual([first.prepared, first.pending], [1, 1]);
  assert.deepEqual(occurrenceRows(s, schedule.id).map((row) => row.scheduledAt), [latest]);
  assert.equal(scheduleRows(s)[0]!.nextAt, latest + interval);
  assert.equal(s.agenda.prepareDue().prepared, 0);
  assert.deepEqual(s.agenda.dispatchPrepared(s.runtime).accepted, 1);

  s.time.now = latest - 3 * interval;
  assert.equal(s.agenda.prepareDue().prepared, 0);
  s.time.now = latest + interval;
  assert.deepEqual(s.agenda.prepareDue().prepared, 1);
  assert.deepEqual(occurrenceRows(s, schedule.id).map((row) => row.scheduledAt), [latest, latest + interval]);
});

test("disable and re-enable revision changes withdraw an old prepared intent across an ABA", (t) => {
  const s = makeStack(t);
  const schedule = s.agenda.create({ botId: s.botId, threadId: s.threadId, content: "Do not start stale intent",
    when: { kind: "interval", everyMs: MIN_INTERVAL_MS, firstAt: s.time.now } });
  s.agenda.prepareDue();
  const old = occurrenceRows(s, schedule.id)[0]!;
  assert.equal(old.state, "prepared");

  const disabled = s.agenda.disable(schedule.id);
  assert.deepEqual([disabled.state, disabled.revision], ["disabled", 2]);
  const enabled = s.agenda.enableInterval(schedule.id, s.time.now + 3 * MIN_INTERVAL_MS);
  assert.deepEqual([enabled.state, enabled.revision], ["active", 3]);
  const report = s.agenda.dispatchPrepared(s.runtime);
  assert.deepEqual([report.attempted, report.pending], [0, 0]);
  assert.equal(occurrenceRows(s, schedule.id)[0]!.state, "withdrawn");
  assert.equal(s.runtime.listTurns(s.threadId).length, 0);

  s.time.now = enabled.nextAt!;
  const fresh = s.agenda.tick(s.runtime);
  assert.deepEqual([fresh.accepted, fresh.pending], [1, 0]);
  const rows = occurrenceRows(s, schedule.id);
  assert.deepEqual(rows.map((row) => row.state), ["withdrawn", "accepted"]);
  assert.notEqual(rows[0]!.clientRequestId, rows[1]!.clientRequestId);
});

test("due capture and dispatch each obey explicit work limits", (t) => {
  const s = makeStack(t, undefined, { maxSchedulesPerTick: 2, maxDispatchesPerTick: 1 });
  once(s, s.time.now, "one");
  once(s, s.time.now, "two");
  once(s, s.time.now, "three");

  const prepared = s.agenda.prepareDue();
  assert.deepEqual([prepared.prepared, prepared.pending, prepared.truncated], [2, 2, true]);
  const dispatched = s.agenda.dispatchPrepared(s.runtime);
  assert.deepEqual([dispatched.attempted, dispatched.pending, dispatched.truncated], [1, 1, true]);
  assert.equal(occurrenceRows(s).length, 2);
  const nextCapture = s.agenda.prepareDue();
  assert.deepEqual([nextCapture.prepared, nextCapture.pending], [1, 2]);
});

test("a deferred head rotates fairly across restart and keeps its deterministic request ID", async (t) => {
  const s = makeStack(t, undefined, { maxDispatchesPerTick: 1 });
  once(s, s.time.now, "first pending item");
  once(s, s.time.now, "second pending item");
  assert.equal(s.agenda.prepareDue().prepared, 2);

  let deferredId: string | undefined;
  const firstCalls: string[] = [];
  const failingRuntime = {
    startTurn(_threadId: string, input: { clientRequestId: string; content: string }) {
      firstCalls.push(input.clientRequestId);
      deferredId ??= input.clientRequestId;
      throw new Error("synthetic permanent runtime failure");
    },
  };
  const first = s.agenda.dispatchPrepared(failingRuntime);
  assert.deepEqual([first.attempted, first.deferred, first.pending, first.truncated], [1, 1, 2, true]);
  assert.ok(deferredId);
  assert.deepEqual(firstCalls, [deferredId]);
  const initial = occurrenceRows(s);
  const deferredScheduleId = initial.find((row) => row.clientRequestId === deferredId)!.scheduleId;
  const nextOccurrence = initial.find((row) => row.clientRequestId !== deferredId)!;
  await stop(s);

  const reopened = makeStack(t, s.dir, { now: s.time.now, maxDispatchesPerTick: 1 });
  const calls: string[] = [];
  const recoveryRuntime = {
    startTurn(threadId: string, input: { clientRequestId: string; content: string }) {
      calls.push(input.clientRequestId);
      if (input.clientRequestId === deferredId) throw new Error("same intent remains deferred");
      return reopened.runtime.startTurn(threadId, input);
    },
  };

  const fair = reopened.agenda.dispatchPrepared(recoveryRuntime);
  assert.deepEqual([fair.attempts[0]!.scheduleId, fair.accepted, fair.deferred], [nextOccurrence.scheduleId, 1, 0]);
  assert.deepEqual(calls, [nextOccurrence.clientRequestId]);
  const retried = reopened.agenda.dispatchPrepared(recoveryRuntime);
  assert.deepEqual([retried.attempts[0]!.scheduleId, retried.deferred], [deferredScheduleId, 1]);
  assert.deepEqual(calls, [nextOccurrence.clientRequestId, deferredId]);
  assert.equal(reopened.runtime.listTurns(s.threadId).length, 1);
});

test("dispatch withdraws stale prepared intents after direct revision or state changes", (t) => {
  const s = makeStack(t);
  const staleState = s.agenda.create({ botId: s.botId, threadId: s.threadId, content: "state changed",
    when: { kind: "interval", everyMs: MIN_INTERVAL_MS, firstAt: s.time.now } });
  const staleRevision = s.agenda.create({ botId: s.botId, threadId: s.threadId, content: "revision changed",
    when: { kind: "interval", everyMs: MIN_INTERVAL_MS, firstAt: s.time.now } });
  assert.equal(s.agenda.prepareDue().prepared, 2);
  const raw = new DatabaseSync(s.agenda.databasePath);
  raw.prepare("UPDATE schedules SET state = 'disabled' WHERE id = ?").run(staleState.id);
  raw.prepare("UPDATE schedules SET revision = revision + 1 WHERE id = ?").run(staleRevision.id);
  raw.close();

  const report = s.agenda.dispatchPrepared(s.runtime);
  assert.deepEqual([report.attempted, report.withdrawn, report.blocked, report.pending], [0, 2, 0, 0]);
  assert.deepEqual(occurrenceRows(s).map((row) => row.state), ["withdrawn", "withdrawn"]);
  assert.equal(s.runtime.listTurns(s.threadId).length, 0);
});

test("a prepared interval coalesces a newly due slot until its pending intent is handled", (t) => {
  const s = makeStack(t);
  const schedule = s.agenda.create({ botId: s.botId, threadId: s.threadId, content: "one outstanding interval",
    when: { kind: "interval", everyMs: MIN_INTERVAL_MS, firstAt: s.time.now } });
  assert.equal(s.agenda.prepareDue().prepared, 1);
  const first = occurrenceRows(s, schedule.id)[0]!;
  const firstNextAt = scheduleRows(s)[0]!.nextAt;

  s.time.now = firstNextAt!;
  const whilePending = s.agenda.prepareDue();
  assert.deepEqual([whilePending.prepared, whilePending.pending], [0, 1]);
  assert.deepEqual(occurrenceRows(s, schedule.id).map((row) => row.clientRequestId), [first.clientRequestId]);
  assert.equal(scheduleRows(s)[0]!.nextAt, firstNextAt);

  assert.equal(s.agenda.dispatchPrepared(s.runtime).accepted, 1);
  assert.equal(s.agenda.prepareDue().prepared, 1);
  assert.equal(occurrenceRows(s, schedule.id).length, 2);
});

test("bounded keyset pages enumerate schedules and occurrences without gaps or duplicates", (t) => {
  const s = makeStack(t);
  const expected = new Set<string>();
  for (let i = 0; i < 150; i++) expected.add(once(s, s.time.now, `page item ${i}`).id);

  const scheduleIds: string[] = [];
  let scheduleCursor: { createdAt: number; id: string } | undefined;
  do {
    const page = s.agenda.listSchedules({ limit: 17, ...(scheduleCursor ? { after: scheduleCursor } : {}) });
    assert.ok(page.items.length <= 17);
    scheduleIds.push(...page.items.map((row) => row.id));
    scheduleCursor = page.nextCursor ?? undefined;
  } while (scheduleCursor);
  assert.equal(scheduleIds.length, 150);
  assert.equal(new Set(scheduleIds).size, 150);
  assert.deepEqual(new Set(scheduleIds), expected);

  assert.ok(s.agenda.listSchedules().items.length <= DEFAULT_PAGE_SIZE);
  assert.throws(() => s.agenda.listOccurrences({ limit: MAX_PAGE_SIZE + 1 }), code("invalid_input"));
  assert.throws(() => s.agenda.listSchedules({ limit: 0 }), code("invalid_input"));
  assert.throws(() => s.agenda.listSchedules({ limit: MAX_PAGE_SIZE + 1 }), code("invalid_input"));
  assert.throws(() => s.agenda.listSchedules({ limit: 1, unexpected: true } as never), code("invalid_input"));

  const firstPass = s.agenda.tick(s.runtime);
  const secondPass = s.agenda.tick(s.runtime);
  assert.deepEqual([firstPass.prepared, firstPass.accepted, secondPass.prepared, secondPass.accepted], [100, 100, 50, 50]);

  const occurrenceIds: string[] = [];
  let occurrenceCursor: { scheduleId: string; scheduledAt: number } | undefined;
  do {
    const page = s.agenda.listOccurrences({ limit: 13, ...(occurrenceCursor ? { after: occurrenceCursor } : {}) });
    assert.ok(page.items.length <= 13);
    occurrenceIds.push(...page.items.map((row) => `${row.scheduleId}:${row.scheduledAt}`));
    occurrenceCursor = page.nextCursor ?? undefined;
  } while (occurrenceCursor);
  assert.equal(occurrenceIds.length, 150);
  assert.equal(new Set(occurrenceIds).size, 150);
  assert.ok(s.agenda.listOccurrences().items.length <= DEFAULT_PAGE_SIZE);
  assert.throws(() => s.agenda.listOccurrences({ limit: 0 }), code("invalid_input"));
  assert.throws(() => s.agenda.listOccurrences({ scheduleId: scheduleIds[0]!, extra: true } as never), code("invalid_input"));
  assert.throws(() => s.agenda.listOccurrences({ after: { scheduleId: scheduleIds[0]!, scheduledAt: -1 } }), code("invalid_input"));
});

test("due schedule SQL returns only the configured page plus one truncation row", (t) => {
  const s = makeStack(t);
  for (let i = 0; i < 150; i++) once(s, s.time.now, `bounded due ${i}`);

  const observedRows: number[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")!;
  const originalPrepare = DatabaseSync.prototype.prepare;
  Object.defineProperty(DatabaseSync.prototype, "prepare", {
    configurable: true,
    writable: true,
    value: function (this: DatabaseSync, sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (!sql.includes("SELECT s.* FROM schedules s")) return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property === "all") return (...parameters: unknown[]) => {
            const rows = Reflect.apply(Reflect.get(target, "all", target), target, parameters) as unknown[];
            observedRows.push(rows.length);
            return rows;
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as typeof statement;
    },
  });
  let report;
  try { report = s.agenda.prepareDue(); }
  finally { Object.defineProperty(DatabaseSync.prototype, "prepare", descriptor); }

  assert.deepEqual([report!.prepared, report!.pending, report!.truncated], [MAX_SCHEDULES_PER_TICK, MAX_SCHEDULES_PER_TICK, true]);
  assert.deepEqual(observedRows, [MAX_SCHEDULES_PER_TICK + 1]);
});

test("manual bounded pruning keeps prepared intents, Hub receipts, and interval slot markers", (t) => {
  const s = makeStack(t);
  const schedule = s.agenda.create({ botId: s.botId, threadId: s.threadId, content: "retained Hub receipt",
    when: { kind: "interval", everyMs: MIN_INTERVAL_MS, firstAt: s.time.now } });
  assert.deepEqual([s.agenda.tick(s.runtime).accepted], [1]);
  const accepted = occurrenceRows(s, schedule.id)[0]!;
  const acceptedTurn = s.store.findTurn(schedule.threadId, accepted.clientRequestId)!;
  const scheduledNextAt = scheduleRows(s)[0]!.nextAt;
  assert.equal(s.store.turnInput(acceptedTurn.id), schedule.content);

  assert.deepEqual(s.agenda.pruneTerminalOccurrences({ beforeUpdatedAt: s.time.now, limit: 1 }), { deleted: 1, truncated: false });
  assert.deepEqual(occurrenceRows(s, schedule.id), []);
  assert.equal(s.store.findTurn(schedule.threadId, accepted.clientRequestId)!.id, acceptedTurn.id);
  assert.equal(scheduleRows(s)[0]!.nextAt, scheduledNextAt);

  s.time.now = accepted.scheduledAt - MIN_INTERVAL_MS;
  assert.equal(s.agenda.prepareDue().prepared, 0);
  s.agenda.disable(schedule.id);
  assert.throws(() => s.agenda.enableInterval(schedule.id, accepted.scheduledAt), code("conflict"));
  const enabled = s.agenda.enableInterval(schedule.id, accepted.scheduledAt + MIN_INTERVAL_MS);
  assert.equal(enabled.state, "active");
  s.time.now = enabled.nextAt!;
  assert.equal(s.agenda.tick(s.runtime).accepted, 1);
  assert.equal(s.runtime.listTurns(schedule.threadId).length, 2);
  assert.throws(() => s.agenda.deleteTerminalSchedule(schedule.id), code("conflict"));

  s.agenda.disable(schedule.id);
  assert.deepEqual(s.agenda.pruneTerminalOccurrences({ beforeUpdatedAt: s.time.now, limit: 1 }), { deleted: 1, truncated: false });
  s.agenda.deleteTerminalSchedule(schedule.id);
  assert.equal(scheduleRows(s).some((row) => row.id === schedule.id), false);
  assert.equal(s.runtime.listTurns(schedule.threadId).length, 2);
});

test("terminal retention deletes in bounded batches and never prunes an ambiguous prepared intent", (t) => {
  const s = makeStack(t);
  const schedules = [once(s), once(s), once(s)];
  assert.equal(s.agenda.tick(s.runtime).accepted, 3);
  const first = s.agenda.pruneTerminalOccurrences({ beforeUpdatedAt: s.time.now, limit: 1 });
  assert.deepEqual(first, { deleted: 1, truncated: true });
  assert.deepEqual(s.agenda.pruneTerminalOccurrences({ beforeUpdatedAt: s.time.now, limit: 1 }), { deleted: 1, truncated: true });
  assert.deepEqual(s.agenda.pruneTerminalOccurrences({ beforeUpdatedAt: s.time.now, limit: 1 }), { deleted: 1, truncated: false });
  for (const schedule of schedules) assert.deepEqual(occurrenceRows(s, schedule.id), []);
  assert.throws(() => s.agenda.pruneTerminalOccurrences({ beforeUpdatedAt: s.time.now, limit: 0 }), code("invalid_input"));
  assert.throws(() => s.agenda.pruneTerminalOccurrences({ beforeUpdatedAt: s.time.now, unknown: true } as never), code("invalid_input"));

  const pending = once(s);
  assert.equal(s.agenda.prepareDue().prepared, 1);
  const unresolved = { startTurn() { throw new Error("ambiguous runtime outcome"); } };
  assert.equal(s.agenda.dispatchPrepared(unresolved).deferred, 1);
  assert.deepEqual(s.agenda.pruneTerminalOccurrences({ beforeUpdatedAt: s.time.now }), { deleted: 0, truncated: false });
  assert.equal(occurrenceRows(s, pending.id)[0]!.state, "prepared");
});

test("foreign thread identities and invalid schedule input are rejected", (t) => {
  const s = makeStack(t);
  const foreignDir = mkdtempSync(join(tmpdir(), "dexter-agenda-foreign-"));
  const foreign = new HostStore({ dataDir: foreignDir });
  const bot = foreign.createBot({ name: "Foreign", profileId: "other", engine: "claude" });
  const thread = foreign.createThread(bot.id);
  t.after(() => { foreign.close(); rmSync(foreignDir, { recursive: true, force: true }); });

  assert.throws(() => s.agenda.create({ botId: bot.id, threadId: thread.id, content: "foreign", when: { kind: "once", at: s.time.now } }), code("not_found"));
  assert.throws(() => s.agenda.create({ botId: s.botId, threadId: s.threadId, content: "", when: { kind: "once", at: s.time.now } }), code("invalid_input"));
  assert.throws(() => s.agenda.create({ botId: s.botId, threadId: s.threadId, content: "text", when: { kind: "interval", everyMs: 1, firstAt: s.time.now } }), code("invalid_input"));
  assert.throws(() => s.agenda.create({ botId: s.botId, threadId: s.threadId, content: "text", when: { kind: "once", at: s.time.now, command: "sh" } } as never), code("invalid_input"));
});

test("agenda database rejects symlink targets and binds its schema to installation and owner", async (t) => {
  const s = makeStack(t);
  assert.equal(lstatSync(s.agenda.databasePath).mode & 0o777, 0o600);
  s.agenda.close();
  await s.runtime.shutdown({ graceMs: 500 });

  const foreignDir = mkdtempSync(join(tmpdir(), "dexter-agenda-copy-"));
  const foreignStore = new HostStore({ dataDir: foreignDir });
  const foreignBot = foreignStore.createBot({ name: "Foreign", profileId: "foreign", engine: "claude" });
  const foreignThread = foreignStore.createThread(foreignBot.id);
  const foreignAgenda = new Agenda(foreignStore);
  foreignAgenda.create({ botId: foreignBot.id, threadId: foreignThread.id, content: "foreign owner page", when: { kind: "once", at: 1 } });
  // Close the foreign database before copying its owner-bound metadata into the local host directory.
  foreignAgenda.close();
  foreignStore.close();
  copyFileSync(join(foreignDir, AGENDA_DATABASE_FILE), join(s.dir, AGENDA_DATABASE_FILE));
  rmSync(foreignDir, { recursive: true, force: true });

  const reopenedStore = new HostStore({ dataDir: s.dir });
  assert.throws(() => new Agenda(reopenedStore), code("conflict"));
  reopenedStore.close();

  const otherDir = mkdtempSync(join(tmpdir(), "dexter-agenda-symlink-"));
  const otherStore = new HostStore({ dataDir: otherDir });
  const target = join(otherDir, "outside.sqlite");
  writeFileSync(target, "synthetic");
  symlinkSync(target, join(otherDir, AGENDA_DATABASE_FILE));
  assert.throws(() => new Agenda(otherStore), code("conflict"));
  otherStore.close();
  rmSync(otherDir, { recursive: true, force: true });

  const walDir = mkdtempSync(join(tmpdir(), "dexter-agenda-wal-symlink-"));
  const walStore = new HostStore({ dataDir: walDir });
  const walTarget = join(walDir, "outside-wal");
  writeFileSync(walTarget, "synthetic");
  symlinkSync(walTarget, `${join(walDir, AGENDA_DATABASE_FILE)}-wal`);
  assert.throws(() => new Agenda(walStore), code("conflict"));
  walStore.close();
  rmSync(walDir, { recursive: true, force: true });
});

test("agenda rejects an owner-only metadata mismatch", (t) => {
  const s = makeStack(t);
  s.agenda.close();
  const raw = new DatabaseSync(s.agenda.databasePath);
  const original = raw.prepare("SELECT value FROM meta WHERE key = 'owner_id'").get() as { value: string };
  raw.prepare("UPDATE meta SET value = 'foreign-owner' WHERE key = 'owner_id'").run();
  raw.close();

  assert.notEqual(original.value, "foreign-owner");
  assert.throws(() => new Agenda(s.store), code("conflict"));
});

test("agenda rejects an installation-only metadata mismatch", (t) => {
  const s = makeStack(t);
  s.agenda.close();
  const raw = new DatabaseSync(s.agenda.databasePath);
  const original = raw.prepare("SELECT value FROM meta WHERE key = 'installation_id'").get() as { value: string };
  raw.prepare("UPDATE meta SET value = 'foreign-installation' WHERE key = 'installation_id'").run();
  raw.close();

  assert.notEqual(original.value, "foreign-installation");
  assert.throws(() => new Agenda(s.store), code("conflict"));
});

test("schema v1 migration preserves prepared work and derives its last interval slot", (t) => {
  const s = makeStack(t);
  const schedule = s.agenda.create({ botId: s.botId, threadId: s.threadId, content: "preserve old prepared work",
    when: { kind: "interval", everyMs: MIN_INTERVAL_MS, firstAt: s.time.now } });
  assert.equal(s.agenda.prepareDue().prepared, 1);
  const before = occurrenceRows(s, schedule.id)[0]!;
  s.agenda.close();

  const raw = new DatabaseSync(s.agenda.databasePath);
  raw.exec("CREATE TEMP TABLE old_schedules AS SELECT id,owner_id,installation_id,bot_id,thread_id,kind,at,interval_ms,next_at,content,state,revision,created_at,updated_at,last_occurrence_at FROM schedules; CREATE TEMP TABLE old_occurrences AS SELECT schedule_id,scheduled_at,schedule_revision,client_request_id,state,turn_id,attempts,created_at,updated_at FROM occurrences;CREATE TEMP TABLE old_meta AS SELECT * FROM meta;DROP TABLE occurrences;DROP TABLE receipts;DROP TABLE schedules;DROP TABLE meta;");
  raw.exec(readFileSync(join(process.cwd(), "tests/fixtures/agenda-v2.sql"),"utf8"));
  raw.exec("INSERT INTO schedules SELECT * FROM old_schedules;INSERT INTO occurrences SELECT * FROM old_occurrences;INSERT INTO meta SELECT * FROM old_meta;DROP TABLE old_occurrences;DROP TABLE old_schedules;DROP TABLE old_meta;");
  raw.exec("DROP INDEX occurrences_pending; DROP INDEX occurrences_terminal; DROP INDEX occurrences_schedule_state; DROP INDEX schedules_page; ALTER TABLE schedules DROP COLUMN last_occurrence_at;");
  raw.exec("CREATE INDEX occurrences_pending ON occurrences (state, created_at, schedule_id, scheduled_at);");
  raw.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
  raw.exec("PRAGMA user_version = 1;");
  raw.close();

  s.agenda = new Agenda(s.store, { clock: () => s.time.now });
  const after = occurrenceRows(s, schedule.id)[0]!;
  assert.deepEqual([after.clientRequestId, after.state, after.attempts], [before.clientRequestId, "prepared", before.attempts]);
  const scheduleRow = new DatabaseSync(s.agenda.databasePath);
  assert.equal(scheduleRow.prepare("PRAGMA user_version").get()?.["user_version"], 3);
  assert.equal(scheduleRow.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.["value"], "3");
  scheduleRow.close();

  s.agenda.disable(schedule.id);
  s.time.now = before.scheduledAt - MIN_INTERVAL_MS;
  assert.throws(() => s.agenda.enableInterval(schedule.id, before.scheduledAt), code("conflict"));
});

test("losing the canonical HostStore lease blocks schedule writes and dispatch", (t) => {
  const s = makeStack(t);
  once(s);
  const raw = new DatabaseSync(s.store.databasePath);
  raw.exec("UPDATE host_lease SET token = 'foreign-writer-token' WHERE id = 1");
  raw.close();

  assert.throws(() => s.agenda.tick(s.runtime), code("host_locked"));
  assert.equal(s.runtime.listTurns(s.threadId).length, 0);
});
