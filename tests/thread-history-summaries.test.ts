import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ThreadListResponseSchema, ThreadSchema, ThreadSummarySchema, type ThreadSummary } from "@dexter/contracts";
import { HostStore } from "@dexter/hub";
import { createAuthorizedHostRouter, createHostApp } from "@dexter/hub/http";
import { HostServices } from "../packages/cli/src/host-services.js";
import { boundedThreadSummaries, threadDisplayText } from "../packages/hub/src/thread-summaries.js";

type List = { items: Array<Record<string, unknown> & { id: string; createdAt: number }>; summaries?: ThreadSummary[] };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dexter-thread-history-")));
  let now = 1_000;
  const store = new HostStore({ dataDir: dir, clock: () => (now += 10) });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const app = createHostApp(store);
  const list = async (botId: string): Promise<List> => {
    const response = await app.request(`/v1/bots/${botId}/threads`);
    assert.equal(response.status, 200);
    return ThreadListResponseSchema.parse(await response.json()) as List;
  };
  return { store, app, list };
}
const say = (store: HostStore, threadId: string, content: string, role: "user" | "assistant" = "user", attachmentIds?: string[]) =>
  store.appendMessage(threadId, { clientMessageId: randomUUID(), content, ...(attachmentIds ? { attachmentIds } : {}) }, role);
const byThread = (list: List) => new Map((list.summaries ?? []).map(summary => [summary.threadId, summary]));

test("history summary: real first human title, last textual preview, image flag, count and activity", async (t) => {
  const { store, list } = fixture(t);
  const bot = store.createBot({ name: "Synthetic", profileId: "synthetic", engine: "codex" });
  const empty = store.createThread(bot.id);
  const thread = store.createThread(bot.id);
  say(store, thread.id, "Synthetic assistant greeting", "assistant");
  say(store, thread.id, "   \n\t ");
  say(store, thread.id, "```\n```");
  say(store, thread.id, "## Plan the  synthetic\n\n trip to Lisbon");
  say(store, thread.id, "Synthetic answer about the trip", "assistant");
  const imageId = store.uploadImageAttachment(thread.id, { clientAttachmentId: randomUUID(), mediaType: "image/png", dataBase64: PNG }).id;
  const last = say(store, thread.id, "", "user", [imageId]);
  const summaries = byThread(await list(bot.id));
  const summary = ThreadSummarySchema.parse(summaries.get(thread.id));
  assert.equal(summary.title, "Plan the synthetic trip to Lisbon", "first persisted human text, Markdown/whitespace normalized; never the assistant greeting");
  assert.equal(summary.preview, "Synthetic answer about the trip");
  assert.equal(summary.previewRole, "assistant");
  assert.equal(summary.lastMessageHasImage, true);
  assert.equal(summary.messageCount, 6);
  assert.equal(summary.lastMessageAt, last.createdAt);
  assert.equal(summary.updatedAt, last.createdAt);
  assert.ok(!JSON.stringify(summary).includes(PNG.slice(0, 24)), "no image bytes or base64 in summaries");
  assert.deepEqual(summaries.get(empty.id), { threadId: empty.id, title: null, preview: null, previewRole: null,
    lastMessageHasImage: false, messageCount: 0, lastMessageAt: null, updatedAt: empty.createdAt });
});

test("display text is bounded, single-line, bidi-free and masks obvious credentials", () => {
  assert.equal(threadDisplayText("a‮b​c\nd", 80), "a b c d");
  assert.equal(threadDisplayText("key sk-" + "A".repeat(30) + " and Bearer " + "x".repeat(24), 80), "key •••• and Bearer ••••");
  assert.equal(threadDisplayText("ghp_" + "a".repeat(36), 80), null, "a message that is only a token never becomes a title");
  assert.equal(threadDisplayText("-- ...", 80), null);
  const long = threadDisplayText("👩🏽‍💻".repeat(40), 80)!;
  assert.ok(long.length <= 80 && long.endsWith("…"));
  assert.ok(!long.includes("�"));
  assert.equal([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(long.slice(0, -1))].every(s => s.segment === "👩🏽‍💻"), true, "no split grapheme");
});

test("history summaries never leak across bots, Team lanes or Group lanes and keep legacy items", async (t) => {
  const { store, list, app } = fixture(t);
  const a = store.createBot({ name: "A", profileId: "synthetic", engine: "codex" });
  const b = store.createBot({ name: "B", profileId: "synthetic", engine: "codex" });
  const own = store.createThread(a.id), other = store.createThread(b.id), lane = store.createThread(a.id);
  say(store, own.id, "Synthetic private A");
  say(store, other.id, "SYNTHETIC_PRIVATE_B_MARKER");
  say(store, lane.id, "SYNTHETIC_GROUP_MARKER");
  // Synthetic seam: mark one thread as a Group lane without seeding a full Group conversation.
  const groups = store.groups as unknown as { threadAudience: (id: string) => unknown };
  const audience = groups.threadAudience.bind(groups);
  groups.threadAudience = id => id === lane.id ? { groupId: "g", conversationId: "c", dispatchId: "d", recipientId: "r" } : audience(id);
  const listA = await list(a.id);
  assert.deepEqual(listA.items.map(item => ThreadSchema.parse(item)), listA.items, "items stay strict legacy Thread objects");
  assert.ok(listA.items.every(item => !("summary" in item) && !("title" in item)));
  const textA = JSON.stringify(listA);
  assert.ok(!textA.includes("SYNTHETIC_PRIVATE_B_MARKER"));
  assert.ok(!textA.includes("SYNTHETIC_GROUP_MARKER"), "Group lane gets no summary");
  assert.deepEqual(listA.summaries?.map(summary => summary.threadId), [own.id]);
  assert.deepEqual((await list(b.id)).summaries?.map(summary => summary.threadId), [other.id]);
  assert.deepEqual(store.threadSummaries([{ ...other, botId: a.id }], "private"), [], "a forged bot association gets nothing");
  assert.equal((await app.request("/v1/bots/missing/threads")).status, 404);
  const thread = await (await app.request(`/v1/threads/${own.id}`)).json();
  assert.deepEqual(Object.keys(thread).sort(), ["audience", "botId", "createdAt", "groupConversationId", "groupId", "id"], "GET thread unchanged");
});

test("Team conversations: summary only through the owner Team list, never through the private bot list", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dexter-thread-history-team-")));
  const services = new HostServices({ dataDir: join(root, "host") });
  t.after(async () => { await services.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const bot = services.store.createBot({ name: "Coordinator", profileId: "synthetic", engine: "codex" });
  const app = createHostApp(services.store, { teams: services.teamsHttp });
  const request = (path: string, method = "GET", body?: unknown) => app.request(`http://127.0.0.1${path}`,
    body === undefined ? {} : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const team = await (await request("/v1/teams", "POST", { expectedHostID: services.store.hostId, clientRequestId: randomUUID(),
    name: "Synthetic team", coordinatorBotId: bot.id, botIds: [bot.id] })).json() as { id: string; revision: number };
  const reply = await request(`/v1/teams/${team.id}/threads`, "POST", { expectedHostID: services.store.hostId, expectedRevision: team.revision, clientRequestId: randomUUID() });
  assert.equal(reply.status, 201);
  const teamThread = (await reply.json() as { thread: { id: string } }).thread;
  const privateThread = services.store.createThread(bot.id);
  say(services.store, teamThread.id, "SYNTHETIC_TEAM_TOPIC");
  say(services.store, privateThread.id, "Synthetic private topic");
  const teamList = ThreadListResponseSchema.parse(await (await request(`/v1/teams/${team.id}/threads`)).json());
  assert.deepEqual(teamList.items.map(item => item.teamId), [team.id]);
  assert.deepEqual(teamList.summaries?.map(summary => [summary.threadId, summary.title]), [[teamThread.id, "SYNTHETIC_TEAM_TOPIC"]]);
  const botList = ThreadListResponseSchema.parse(await (await request(`/v1/bots/${bot.id}/threads`)).json());
  assert.ok(botList.items.some(item => item.id === teamThread.id), "legacy item listing is unchanged");
  assert.deepEqual(botList.summaries?.map(summary => summary.threadId), [privateThread.id]);
  assert.ok(!JSON.stringify(botList).includes("SYNTHETIC_TEAM_TOPIC"));
  assert.equal((await request(`/v1/teams/${team.id}/threads?summaries=1`)).status, 400, "Team list still refuses queries");
});

test("bounded pagination: newest 500 threads, summaries independent of message pages and response budget", async (t) => {
  const { store, list } = fixture(t);
  const bot = store.createBot({ name: "Busy", profileId: "synthetic", engine: "codex" });
  const threads = Array.from({ length: 501 }, () => store.createThread(bot.id));
  const long = threads.at(-1)!;
  for (const thread of threads.slice(0, 499)) say(store, thread.id, "🧪".repeat(79) + "\"\\" + "x".repeat(200));
  say(store, long.id, "First synthetic question");
  for (let i = 0; i < 119; i += 1) say(store, long.id, `Synthetic follow-up ${i}`, i % 2 ? "assistant" : "user");
  const page = await list(bot.id);
  assert.equal(page.items.length, 500);
  assert.equal(page.items[0]!.id, threads[0]!.id, "an older active conversation stays visible");
  assert.ok(!page.items.some(item => item.id === threads[499]!.id), "the inactive conversation is outside the activity cap");
  assert.deepEqual(page.items.map(item => item.createdAt), [...page.items.map(item => item.createdAt)].sort((x, y) => x - y), "items keep ascending order");
  const summary = byThread(page).get(long.id)!;
  assert.equal(summary.title, "First synthetic question");
  assert.equal(summary.messageCount, 120);
  assert.equal(summary.preview, "Synthetic follow-up 118");
  assert.ok(page.summaries!.length < 500 && page.summaries!.length > 50, "byte budget trims older summaries, keeps recent ones");
  assert.equal(page.summaries![0]!.threadId, long.id, "most recent activity first");
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 262_144, "fits the app-client response cap");
  const tiny = boundedThreadSummaries(page.summaries!, 600);
  assert.ok(tiny.length >= 1 && tiny.length < 4 && tiny[0]!.threadId === long.id);
});

test("listing summaries is read-only: no events, turns, receipts or replay; paired chat.read gets the same projection", async (t) => {
  const { store, list } = fixture(t);
  const bot = store.createBot({ name: "Quiet", profileId: "synthetic", engine: "codex" });
  const thread = store.createThread(bot.id);
  say(store, thread.id, "Synthetic quiet request");
  const before = { events: store.listEvents(0, 500).length, counts: JSON.stringify(store.summary().counts), turns: store.listTurns(thread.id, 0, 500).length };
  const first = await list(bot.id), second = await list(bot.id);
  assert.deepEqual(second, first, "deterministic re-read");
  assert.deepEqual({ events: store.listEvents(0, 500).length, counts: JSON.stringify(store.summary().counts), turns: store.listTurns(thread.id, 0, 500).length }, before);
  const paired = createAuthorizedHostRouter(store);
  const authority = (scopes: string[]) => ({ principal: "paired-client", installationId: store.hostId, ownerId: store.ownerId, deviceId: "synthetic",
    role: "client-ios", scopes, pinGeneration: 1, bindingRevision: 1, assertCurrent() {}, noteSelfRevoke() {} });
  const remote = await paired.fetch(new Request(`https://app-client.invalid/v1/bots/${bot.id}/threads`), { authority: authority(["chat.read"]) } as never);
  assert.equal(remote.status, 200);
  assert.deepEqual(await remote.json(), first);
  const denied = await paired.fetch(new Request(`https://app-client.invalid/v1/bots/${bot.id}/threads`), { authority: authority(["approvals.read"]) } as never);
  assert.equal(denied.status, 403);
});
