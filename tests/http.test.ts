import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostStore } from "@dexter/hub";
import { createHostApp } from "@dexter/hub/http";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "dexter-http-"));
  const store = new HostStore({ dataDir: dir });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, app: createHostApp(store) };
}
function json(body: unknown, extra: Record<string, string> = {}): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) };
}

test("API persists user messages idempotently and supports event replay", async (t) => {
  const { app } = fixture(t);
  const botResponse = await app.request("/v1/bots", json({ name: "General", profileId: "personal", engine: "codex" }));
  assert.equal(botResponse.status, 201);
  const bot = await botResponse.json() as { id: string };
  const thread = await (await app.request(`/v1/bots/${bot.id}/threads`, json({}))).json() as { id: string };
  const input = { clientMessageId: "retryable-message", content: "Prepare a summary." };
  const a = await (await app.request(`/v1/threads/${thread.id}/messages`, json(input))).json() as { id: string };
  const b = await (await app.request(`/v1/threads/${thread.id}/messages`, json(input))).json() as { id: string };
  assert.equal(a.id, b.id);
  const messages = await (await app.request(`/v1/threads/${thread.id}/messages`)).json() as { items: { role: string }[] };
  assert.equal(messages.items.length, 1);
  assert.equal(messages.items[0]?.role, "user");
  const first = await (await app.request("/v1/events?limit=2")).json() as { items: unknown[]; nextCursor: number };
  assert.equal(first.items.length, 2);
  const replay = await (await app.request(`/v1/events?after=${first.nextCursor}`)).json() as { items: { kind: string }[] };
  assert.deepEqual(replay.items.map((event) => event.kind), ["message.appended"]);
  const health = await (await app.request("/health")).json() as { engineRouting: string; remotePairing: string };
  assert.equal(health.engineRouting, "not_connected");
  assert.equal(health.remotePairing, "not_implemented");
});

test("host rejects browser origins, forged host headers and non-JSON writes", async (t) => {
  const { app } = fixture(t);
  assert.equal((await app.request("/v1/bots", json({}, { origin: "https://attacker.example" }))).status, 403);
  assert.equal((await app.request("/health", { headers: { host: "attacker.example" } })).status, 403);
  assert.equal((await app.request("http://attacker.example/health")).status, 403);
  assert.equal((await app.request("/v1/bots", { method: "POST", body: "{}" })).status, 415);
});

test("invalid inputs and payloads never echo raw data in errors", async (t) => {
  const { app } = fixture(t);
  const marker = "synthetic-sensitive-marker";
  const response = await app.request("/v1/bots", json({ name: marker, ownerId: marker }));
  assert.equal(response.status, 400);
  assert.equal((await response.text()).includes(marker), false);
  assert.equal((await app.request("/v1/bots", { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status, 400);
  assert.equal((await app.request("/v1/events?after=-1")).status, 400);
  assert.equal((await app.request("/v1/events?limit=501")).status, 400);
  assert.equal((await app.request("/v1/bots/missing")).status, 404);
  assert.equal((await app.request("/v1/bots", json({ name: "a".repeat(270_000) }))).status, 413);
  for (const after of ["0x10", "1e2", "1.5"]) {
    assert.equal((await app.request(`/v1/events?after=${after}`)).status, 400);
  }
  assert.deepEqual(await (await app.request("/missing")).json(), { error: "not_found", message: "Route not found." });
});

test("HTTP accepts the full message contract including escaped Unicode", async (t) => {
  const { store, app } = fixture(t);
  const bot = store.createBot({ name: "Português", profileId: "personal", engine: "codex" });
  const thread = store.createThread(bot.id);
  const content = "界".repeat(32_768);
  const escaped = `{"clientMessageId":"unicode-escaped","content":"${"\\u754c".repeat(32_768)}"}`;
  const response = await app.request(`/v1/threads/${thread.id}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: escaped,
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json() as { content: string }).content, content);
});

test("approval requires its frozen request hash and a grant; owner is not supplied by the caller", async (t) => {
  const { app, store } = fixture(t);
  const bot = store.createBot({ name: "General", profileId: "personal", engine: "claude" });
  const thread = store.createThread(bot.id);
  const request = { botId: bot.id, threadId: thread.id, tool: "mail.send", destination: "host",
    arguments: { to: "example@example.invalid", subject: "Test" }, idempotencyKey: "send-1" };
  assert.equal((await app.request("/v1/actions", json(request))).status, 403);
  store.setGrant({ botId: bot.id, tool: "mail.send", destination: "host", policy: "ask" });
  const action = await (await app.request("/v1/actions", json(request))).json() as { id: string; requestHash: string };
  const wrong = await app.request(`/v1/actions/${action.id}/decisions`, json({ decision: "allow", requestHash: "0".repeat(64) }));
  assert.equal(wrong.status, 409);
  const correct = await app.request(`/v1/actions/${action.id}/decisions`, json({ decision: "allow", requestHash: action.requestHash }));
  assert.equal(correct.status, 200);
  assert.equal((await app.request(`/v1/actions/${action.id}/decisions`, json({ decision: "deny", requestHash: action.requestHash }))).status, 409);
});
