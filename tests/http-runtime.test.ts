import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostStore, ConversationRuntime } from "@dexter/hub";
import type { RuntimeDriver, RuntimeEngineEvent, Turn } from "@dexter/hub";
import { createHostApp } from "@dexter/hub/http";
import { TurnSchema, TurnEventSchema } from "@dexter/contracts";

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("HTTP accepts a durable turn and replays its result without a second inference", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dexter-http-runtime-"));
  const store = new HostStore({ dataDir });
  let calls = 0;
  const driver: RuntimeDriver = {
    id: "codex",
    open: async (threadId) => ({ threadId, nativeCursor: "native-test-session" }),
    async *turn(session, turnId): AsyncIterable<RuntimeEngineEvent> {
      calls++;
      yield { type: "text.delta", threadId: session.threadId, turnId, text: "Olá, " };
      yield { type: "text.delta", threadId: session.threadId, turnId, text: "Dexter." };
      yield { type: "turn.completed", threadId: session.threadId, turnId, usage: {} };
    },
    respondToTool: async () => {}, interrupt: async () => {}, close: async () => {},
  };
  const runtime = new ConversationRuntime({ store, drivers: [driver] });
  t.after(async () => { await runtime.shutdown(); rmSync(dataDir, { recursive: true, force: true }); });
  const app = createHostApp(store, { runtime });
  const bot = store.createBot({ name: "General", profileId: "personal", engine: "codex" });
  const thread = store.createThread(bot.id);
  const input = { clientRequestId: "http-turn-1", content: "Oi." };
  const response = await app.request(`/v1/threads/${thread.id}/turns`, post(input));
  assert.equal(response.status, 201);
  const turn = TurnSchema.parse(await response.json());
  await runtime.waitForTurn(turn.id);
  const replay = await app.request(`/v1/threads/${thread.id}/turns`, post(input));
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as Turn).id, turn.id);
  assert.equal(calls, 1);
  const current = TurnSchema.parse(await (await app.request(`/v1/turns/${turn.id}`)).json());
  assert.equal(current.state, "completed");
  const timeline = await (await app.request(`/v1/turns/${turn.id}/events?limit=2`)).json() as { items: unknown[]; nextCursor: number };
  assert.equal(timeline.items.length, 2);
  timeline.items.forEach((event) => TurnEventSchema.parse(event));
  const rest = await (await app.request(`/v1/turns/${turn.id}/events?after=${timeline.nextCursor}`)).json() as { items: unknown[] };
  assert.equal(rest.items.map((event) => TurnEventSchema.parse(event).text ?? "").join(""), "Olá, Dexter.");
  assert.equal(store.listMessages(thread.id).at(-1)?.content, "Olá, Dexter.");
  const health = await (await app.request("/health")).json() as { engineRouting: string };
  assert.equal(health.engineRouting, "connected");
});

test("default development listener cannot execute an engine turn", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "dexter-http-no-inference-"));
  const store = new HostStore({ dataDir });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const bot = store.createBot({ name: "General", profileId: "personal", engine: "codex" });
  const thread = store.createThread(bot.id);
  const response = await createHostApp(store).request(`/v1/threads/${thread.id}/turns`, post({ clientRequestId: "off", content: "No inference" }));
  assert.equal(response.status, 503);
  assert.equal(store.listTurns(thread.id).length, 0);
});
