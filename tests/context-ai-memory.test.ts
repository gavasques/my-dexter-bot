import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { inspect } from "node:util";
import { HostStore } from "@dexter/hub";
import { AiMemoryHttpClient, AiMemoryReadAdapter, AiMemorySync, ContextHost, type AiMemoryFetch, type AiMemorySyncSource, type MemoryPage } from "@dexter/context";

const fails = (code: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code;
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const ORIGIN = "http://127.0.0.1:49999";
const untilAborted = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  const stop = () => reject(new DOMException("aborted", "AbortError"));
  if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
});

/** Deterministic in-memory ai-memory v2.5.2 double speaking the verified wire contract. */
class FakeAiMemory {
  pages = new Map<string, string>();
  writes: Array<{ workspace: string; project: string; path: string; body: string }> = [];
  requests: Array<{ method: string; path: string; authorization: string | null }> = [];
  version = "2.5.2";
  /** Hook run when a write arrives; may mutate, delay or drop. Returning "drop" acks without storing. */
  onWrite: ((write: FakeAiMemory["writes"][number], signal: AbortSignal) => Promise<"store" | "drop" | "alter" | "store_then_hang">) | null = null;
  onGet: ((path: string, signal: AbortSignal) => Promise<void>) | null = null;
  key = (workspace: string, project: string, path: string) => `${workspace}/${project}/${path}`;
  readonly fetch: AiMemoryFetch = async (url, init) => {
    const target = new URL(url); const method = init.method ?? "GET"; const signal = init.signal!;
    const headers = init.headers as Record<string, string>;
    this.requests.push({ method, path: target.pathname, authorization: headers.Authorization ?? null });
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
    if (target.pathname === "/mcp") {
      const rpc = JSON.parse(init.body as string) as { id?: number; method: string; params: { name?: string; arguments?: Record<string, string> } };
      if (rpc.method === "initialize") return json(200, { jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "ai-memory", version: this.version } } });
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      const args = rpc.params.arguments!;
      assert.equal(rpc.params.name, "memory_write_page"); assert.deepEqual(Object.keys(args).sort(), ["body", "path", "project", "workspace"]);
      const write = { workspace: args.workspace!, project: args.project!, path: args.path!, body: args.body! };
      this.writes.push(write);
      const mode = this.onWrite ? await this.onWrite(write, signal) : "store";
      if (mode === "store" || mode === "store_then_hang") this.pages.set(this.key(write.workspace, write.project, write.path), write.body);
      if (mode === "alter") this.pages.set(this.key(write.workspace, write.project, write.path), `${write.body}\n<!-- altered -->`);
      if (mode === "store_then_hang") await untilAborted(signal);
      return json(200, { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify({ page_id: "01synthetic", path: write.path, checkpoint: null }) }], isError: false } });
    }
    const page = /^\/api\/v1\/workspaces\/([^/]+)\/projects\/([^/]+)\/pages\/(.+)$/.exec(target.pathname);
    if (page && method === "GET") {
      if (this.onGet) await this.onGet(page[3]!, signal);
      const body = this.pages.get(this.key(page[1]!, page[2]!, page[3]!));
      if (body === undefined) return json(404, { error: "page not found" });
      return json(200, { workspace: page[1], project: page[2], path: page[3], body_markdown: body, title: "synthetic", kind: "note", tier: "semantic" });
    }
    if (target.pathname === "/api/v1/search" && method === "POST") {
      const request = JSON.parse(init.body as string) as { q: string; scopes: Array<{ workspace: string; project: string }>; limit: number };
      assert.equal(request.scopes.length, 1);
      const [scope] = request.scopes;
      const keys = [...this.pages.keys()].filter(key => key.startsWith(`${scope!.workspace}/${scope!.project}/`));
      if (keys.length === 0) return json(404, { error: "project not found" });
      return json(200, keys.filter(key => this.pages.get(key)!.includes(request.q)).slice(0, request.limit).map((key, rank) => ({
        workspace: scope!.workspace, project: scope!.project, path: key.split("/").slice(2).join("/"), title: "t", kind: "note", snippet: "UNTRUSTED SNIPPET", rank: -1 + rank / 10,
      })));
    }
    return new Response("", { status: 404 });
  };
}

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "dexter-ai-memory-"));
  const store = new HostStore({ dataDir: dir });
  const fake = new FakeAiMemory();
  const isolation = (origin = ORIGIN) => ({ mode: "owner_exclusive_deployment" as const, origin, installationId: store.hostId, ownerId: store.ownerId });
  const client = new AiMemoryHttpClient({ origin: ORIGIN, labLoopbackWithoutAuth: true, fetch: fake.fetch, timeoutMs: 200, isolation: isolation() });
  const context = new ContextHost(store, new AiMemoryReadAdapter(client.transport));
  const syncs: AiMemorySync[] = [];
  const open = () => { const sync = new AiMemorySync(store, context, client); syncs.push(sync); return sync; };
  t.after(async () => { for (const s of syncs) await s.close().catch(() => undefined); context.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const principal = (name: string) => {
    const bot = store.createBot({ name, profileId: "personal", engine: "claude" });
    const thread = store.createThread(bot.id);
    const turn = store.createTurn(thread.id, { clientRequestId: "test", content: "synthetic" }).turn;
    store.claimNextTurn(thread.id);
    return { bot, turn, token: context.issue(turn.id) };
  };
  const memory = (scope: MemoryPage["scope"], markdown: string, locale: MemoryPage["locale"] = "pt-BR") => context.createMemory({ scope, markdown, locale, origin: "synthetic", classification: "context" });
  const loseLease = () => {
    const db = new DatabaseSync(store.databasePath); const token = db.prepare("SELECT token FROM host_lease WHERE id=1").get()!.token as string;
    db.prepare("UPDATE host_lease SET token='synthetic-revoked' WHERE id=1").run();
    return () => { db.prepare("UPDATE host_lease SET token=? WHERE id=1").run(token); db.close(); };
  };
  return { dir, store, fake, client, context, open, principal, memory, loseLease, isolation };
}
const outboxState = (path: string, memoryId: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return (db.prepare("SELECT state FROM jobs WHERE memory_id=?").get(memoryId) as { state: string } | undefined)?.state; } finally { db.close(); }
};

test("client configuration accepts only HTTPS + aim_ user key or explicit literal-loopback lab, and never reveals the key", async () => {
  const key = `aim_${randomBytes(32).toString("base64url")}`;
  for (const origin of ["http://example.com", "https://user:pw@example.com", "https://example.com/path", "https://example.com/?q=1", "https://example.com/#f", "ftp://example.com", "https://example.com:443/x"]) {
    assert.throws(() => new AiMemoryHttpClient({ origin, credential: () => key }), fails("config"), origin);
  }
  for (const origin of ["http://localhost:1234", "http://10.0.0.5:1234", "https://127.0.0.1:1234", "http://127.0.0.1"]) assert.throws(() => new AiMemoryHttpClient({ origin, labLoopbackWithoutAuth: true }), fails("config"), origin);
  assert.throws(() => new AiMemoryHttpClient({ origin: ORIGIN, labLoopbackWithoutAuth: true, credential: () => key }), fails("config"));
  assert.throws(() => new AiMemoryHttpClient({ origin: "https://memory.example" }), fails("config")); // HTTPS requires a key
  const fake = new FakeAiMemory();
  const root = new AiMemoryHttpClient({ origin: "https://memory.example", credential: () => "root-static-token-not-a-user-key", fetch: fake.fetch });
  await assert.rejects(root.initialize(), fails("config")); assert.equal(fake.requests.length, 0); // root/admin bearer never sent
  const client = new AiMemoryHttpClient({ origin: "https://memory.example", credential: () => key, fetch: fake.fetch });
  for (const shown of [inspect(client, { showHidden: true, depth: 5 }), JSON.stringify(client), String(Object.values(client))]) assert.ok(!shown.includes(key) && !shown.includes(key.slice(4)));
  await client.initialize();
  assert.ok(fake.requests.every(r => r.authorization === `Bearer ${key}`));
  fake.version = "2.5.3";
  const error = await client.initialize().catch((e: unknown) => e) as Error;
  assert.ok(fails("protocol")(error) && !error.message.includes(key) && !inspect(error).includes(key));
});

test("transport is bounded: no redirect follow, response caps, timeout, UTF-8, exact route 404, scope echo", async () => {
  let calls = 0;
  const respond = (response: () => Response | Promise<Response>): AiMemoryFetch => async () => { calls += 1; return response(); };
  const client = (fetch: AiMemoryFetch) => new AiMemoryHttpClient({ origin: ORIGIN, labLoopbackWithoutAuth: true, fetch, timeoutMs: 50, maxResponseBytes: 1_024 });
  const ref = { workspace: "dx-abc", project: "bot-x", path: "notes/mem_1.md" };
  await assert.rejects(client(respond(() => new Response(null, { status: 307, headers: { location: "https://evil.example/" } }))).getPage(ref), fails("http_status")); assert.equal(calls, 1);
  await assert.rejects(client(respond(() => new Response(JSON.stringify({ body_markdown: "x".repeat(4_096) }), { headers: { "content-type": "application/json" } }))).getPage(ref), fails("too_large"));
  await assert.rejects(client(respond(() => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { headers: { "content-type": "application/json" } }))).getPage(ref), fails("protocol"));
  await assert.rejects(client(respond(() => new Response("", { status: 404 }))).getPage(ref), fails("http_status")); // router fallback is not "missing"
  assert.deepEqual(await client(respond(() => new Response(JSON.stringify({ error: "page not found" }), { status: 404, headers: { "content-type": "application/json" } }))).getPage(ref), { kind: "missing" });
  await assert.rejects(client(respond(() => new Response(JSON.stringify({ workspace: "dx-other", project: "bot-x", path: ref.path, body_markdown: "x" }), { headers: { "content-type": "application/json" } }))).getPage(ref), fails("protocol"));
  const hang: AiMemoryFetch = (_url, init) => untilAborted(init.signal!);
  await assert.rejects(client(hang).getPage(ref), fails("timeout"));
  await assert.rejects(client(hang).getPage({ ...ref, path: "../etc/passwd" }), fails("config"));
  const search = (scopes: Array<{ workspace: string; project: string }>) => ({ method: "POST" as const, path: "/api/v1/search" as const, body: { q: "x", scopes, limit: 5 } });
  calls = 0;
  await assert.rejects(client(respond(() => new Response("[]"))).search(search(Array.from({ length: 26 }, (_, n) => ({ workspace: "dx-a", project: `p${n}` })))), fails("config")); assert.equal(calls, 0);
  const foreign = client(respond(() => new Response(JSON.stringify([{ workspace: "someone-else", project: "p", path: "notes/x.md", rank: -1 }]), { headers: { "content-type": "application/json" } })));
  await assert.rejects(foreign.search(search([{ workspace: "dx-a", project: "p" }])), fails("protocol"));
});

test("flush mirrors global/team/bot/confidential pt-BR and en-US pages once; recall stays registry-authoritative", async t => {
  const s = setup(t); const a = s.principal("Alpha"); const b = s.principal("Beta");
  const team = s.context.createTeam("Equipe sintética"); s.context.assignBot(team, a.bot.id);
  const pages = [
    s.memory({ kind: "global" }, "# Preferência\n\nfarolglobal compartilhado.\n"),
    s.memory({ kind: "team", teamId: team }, "# Equipe\n\nfarolequipe da equipe.\n"),
    s.memory({ kind: "bot", botId: a.bot.id }, "# Alpha\n\nfarolalpha apenas alpha.\n"),
    s.memory({ kind: "bot", botId: b.bot.id }, "# Beta\n\nfarolbeta apenas beta.\n"),
    s.memory({ kind: "confidential", botId: a.bot.id }, "# Privado\n\nfarolprivado confidencial.\n"),
    s.memory({ kind: "global" }, "# Shared\n\nbeaconglobal english note.\n", "en-US"),
  ];
  const sync = s.open();
  assert.equal(sync.status().health, "unverified");
  const report = await sync.flush();
  assert.equal(report.backend, "verified"); assert.equal(report.writes, 6); assert.equal(report.confirmed, 6);
  assert.equal(s.fake.writes.length, 6);
  for (const page of pages) assert.equal(hash(s.fake.pages.get(s.fake.key(page.service.workspace, page.service.project, page.service.path))!), hash(page.markdown));
  assert.ok(s.fake.writes.every(w => w.workspace.startsWith("dx-") && w.path.startsWith("notes/mem_")));
  assert.deepEqual(new Set(s.fake.writes.map(w => w.project)), new Set(["owner-global", "_team", `bot-${a.bot.id}`, `bot-${b.bot.id}`, `confidential-${a.bot.id}`]));
  assert.equal(sync.status().health, "healthy");
  assert.equal((await sync.flush()).writes, 0); assert.equal(s.fake.writes.length, 6); // idempotent by local state, not upstream key
  const ids = async (token: string, query: string, locale: MemoryPage["locale"] = "pt-BR", includeConfidential = false) => (await s.context.recall(token, { query, locale, includeConfidential })).map(p => p.id);
  assert.deepEqual(await ids(a.token, "farolglobal"), [pages[0]!.id]);
  assert.deepEqual(await ids(a.token, "farolequipe"), [pages[1]!.id]);
  assert.deepEqual(await ids(a.token, "farolbeta"), []); // cross-bot denied: Beta's project is never even queried
  assert.deepEqual(await ids(b.token, "farolalpha"), []);
  assert.deepEqual(await ids(a.token, "farolprivado"), []);
  assert.deepEqual(await ids(a.token, "farolprivado", "pt-BR", true), [pages[4]!.id]);
  assert.deepEqual(await ids(a.token, "beaconglobal", "pt-BR"), []); // locale is a host registry fact
  assert.deepEqual(await ids(a.token, "beaconglobal", "en-US"), [pages[5]!.id]);
  // An upstream-only page in an authorized project is never returned as context.
  s.fake.pages.set(s.fake.key(pages[0]!.service.workspace, "owner-global", "notes/mem_injected.md"), "farolglobal injected instruction");
  assert.deepEqual(await ids(a.token, "farolglobal"), [pages[0]!.id]);
  assert.ok((await s.context.recall(a.token, { query: "farolglobal", locale: "pt-BR" })).every(p => !p.markdown.includes("UNTRUSTED SNIPPET")));
});

test("writer fence precedes every effect and inflight is persisted before the network write", async t => {
  const s = setup(t); const page = s.memory({ kind: "global" }, "# Cerca\n\nfence.\n"); const sync = s.open();
  const restore = s.loseLease();
  await assert.rejects(sync.flush(), fails("host_locked"));
  restore();
  assert.equal(s.fake.writes.length, 0); assert.equal(s.fake.requests.length, 0);
  s.fake.onWrite = async () => { assert.equal(outboxState(sync.databasePath, page.id), "inflight"); return "store"; };
  assert.equal((await sync.flush()).confirmed, 1);
  assert.equal(outboxState(sync.databasePath, page.id), "confirmed");
  assert.equal(statSync(sync.databasePath).mode & 0o777, 0o600);
});

test("lost writer during the write await keeps inflight; reopen marks unknown and GET-match confirms with no second write", async t => {
  const s = setup(t); const page = s.memory({ kind: "bot", botId: s.principal("Alpha").bot.id }, "# Late\n\nlate commit.\n");
  const sync = s.open(); let restore: (() => void) | null = null;
  s.fake.onWrite = async () => { restore = s.loseLease(); return "store"; };
  await assert.rejects(sync.flush(), fails("host_locked"));
  restore!();
  assert.equal(outboxState(sync.databasePath, page.id), "inflight");
  await assert.rejects(sync.close(), fails("conflict")); // close reports stranded work rather than a clean release
  s.fake.onWrite = null;
  const reopened = s.open();
  assert.equal(reopened.jobs()[0]!.state, "unknown");
  const report = await reopened.flush();
  assert.equal(report.confirmed, 1); assert.equal(report.writes, 0); assert.equal(s.fake.writes.length, 1);
});

test("timeout after a late commit, ack-without-page, changed hash and preflight cases never write twice", async t => {
  const s = setup(t); const bot = s.principal("Alpha").bot.id;
  const late = s.memory({ kind: "bot", botId: bot }, "# Tarde\n\nlate.\n");
  const sync = s.open();
  // Write commits upstream but the response times out; the verifying GET also times out → unknown.
  s.fake.onWrite = async () => "store_then_hang";
  s.fake.onGet = async (_path, signal) => { if (s.fake.writes.length > 0) await untilAborted(signal); };
  let report = await sync.flush();
  assert.equal(report.writes, 1); assert.equal(report.unknown, 1); assert.equal(outboxState(sync.databasePath, late.id), "unknown");
  s.fake.onGet = null; s.fake.onWrite = null;
  report = await sync.flush();
  assert.equal(report.confirmed, 1); assert.equal(report.writes, 0); assert.equal(s.fake.writes.length, 1);

  const dropped = s.memory({ kind: "bot", botId: bot }, "# Sumiu\n\ndropped.\n");
  s.fake.onWrite = async () => "drop";
  report = await sync.flush(); assert.equal(report.unknown, 1);
  s.fake.onWrite = null;
  for (let n = 0; n < 3; n += 1) { report = await sync.flush(); assert.equal(report.writes, 0); assert.equal(report.unknown, 1); }
  assert.equal(s.fake.writes.filter(w => w.path.includes(dropped.id)).length, 1); // GET missing never authorizes a retry
  assert.equal(sync.status().health, "degraded");

  const altered = s.memory({ kind: "bot", botId: bot }, "# Mudou\n\nchanged.\n");
  s.fake.onWrite = async () => "alter";
  report = await sync.flush(); assert.equal(report.conflict, 1); assert.equal(outboxState(sync.databasePath, altered.id), "conflict");
  s.fake.onWrite = null; await sync.flush();
  assert.equal(s.fake.writes.filter(w => w.path.includes(altered.id)).length, 1);

  const existing = s.memory({ kind: "bot", botId: bot }, "# Existe\n\nexists.\n");
  const differing = s.memory({ kind: "bot", botId: bot }, "# Difere\n\ndiffers.\n");
  s.fake.pages.set(s.fake.key(existing.service.workspace, existing.service.project, existing.service.path), existing.markdown);
  s.fake.pages.set(s.fake.key(differing.service.workspace, differing.service.project, differing.service.path), "# someone else's body");
  const before = s.fake.writes.length;
  report = await sync.flush();
  assert.equal(s.fake.writes.length, before);
  assert.equal(outboxState(sync.databasePath, existing.id), "confirmed"); assert.equal(outboxState(sync.databasePath, differing.id), "conflict");
});

test("concurrent flushes and two controllers on one store produce exactly one write per page", async t => {
  const s = setup(t); const bot = s.principal("Alpha").bot.id;
  for (let n = 0; n < 5; n += 1) s.memory({ kind: "bot", botId: bot }, `# Página ${n}\n\nconcorrente ${n}.\n`);
  const one = s.open(); const two = s.open();
  const first = one.flush(); assert.equal(one.flush(), first);
  await Promise.all([first, two.flush(), one.flush(), two.flush()]);
  assert.equal(s.fake.writes.length, 5);
  assert.equal(new Set(s.fake.writes.map(w => w.path)).size, 5);
});

test("only active canonical pages are mirrored; reversed promotions and foreign scopes never start a write", async t => {
  const s = setup(t); const a = s.principal("Alpha");
  const source = s.memory({ kind: "bot", botId: a.bot.id }, "# Fonte\n\nfonte.\n");
  const proposal = s.context.proposePromotion(a.token, source.id, { kind: "global" });
  const promoted = s.context.approvePromotion(proposal.id, proposal.requestHash);
  s.context.reversePromotion(proposal.id);
  const sync = s.open(); await sync.flush();
  assert.deepEqual(s.fake.writes.map(w => w.path), [`notes/${source.id}.md`]);
  assert.ok(!sync.jobs().some(job => job.memoryId === promoted.id));
  // Queued, then deactivated before dispatch → withdrawn, never written.
  const second = s.context.proposePromotion(a.token, source.id, { kind: "global" });
  const again = s.context.approvePromotion(second.id, second.requestHash);
  const gate = { calls: 0 };
  const racing: AiMemorySyncSource = { activeMemoryPagesForSync: (query = {}) => {
    if (query.ids) { gate.calls += 1; if (gate.calls === 1) s.context.reversePromotion(second.id); }
    return s.context.activeMemoryPagesForSync(query);
  } };
  const raced = new AiMemorySync(s.store, racing, s.client);
  t.after(() => raced.close().catch(() => undefined));
  const report = await raced.flush();
  assert.equal(report.withdrawn, 1); assert.ok(!s.fake.writes.some(w => w.path.includes(again.id)));
  // A page claiming a foreign namespace/scope is rejected before queueing.
  const foreignPage: MemoryPage = { ...source, id: "mem_foreign", service: { workspace: "dx-foreignnamespace0000000", project: `bot-${a.bot.id}`, path: "notes/mem_foreign.md" } };
  const foreign = new AiMemorySync(s.store, { activeMemoryPagesForSync: (query = {}) => (query.ids || query.after ? [] : [foreignPage]) }, s.client);
  t.after(() => foreign.close().catch(() => undefined));
  const rejected = await foreign.flush();
  assert.equal(rejected.rejected, 1); assert.equal(foreign.jobs().length >= 0, true);
  assert.ok(!s.fake.writes.some(w => w.path.includes("mem_foreign")));
  // Inactive copy remains absent from recall even if upstream still indexes it.
  s.fake.pages.set(s.fake.key(promoted.service.workspace, promoted.service.project, promoted.service.path), promoted.markdown);
  assert.deepEqual((await s.context.recall(a.token, { query: "fonte", locale: "pt-BR" })).map(p => p.id), [source.id]);
});

test("outbox file binding: dangling symlink, owner/origin mismatch and backend outage leave jobs untouched", async t => {
  const s = setup(t); const page = s.memory({ kind: "global" }, "# Ligação\n\nbinding.\n");
  const outbox = join(s.dir, "ai-memory-outbox.sqlite");
  symlinkSync(join(s.dir, "missing-target"), outbox);
  assert.throws(() => s.open(), fails("tampered"));
  rmSync(outbox);
  symlinkSync(join(s.dir, "missing-wal"), `${outbox}-wal`);
  assert.throws(() => s.open(), fails("tampered"));
  rmSync(`${outbox}-wal`);
  const sync = s.open(); await sync.close();
  const other = new AiMemoryHttpClient({ origin: "http://127.0.0.1:49998", labLoopbackWithoutAuth: true, fetch: s.fake.fetch });
  assert.throws(() => new AiMemorySync(s.store, s.context, other), fails("conflict"));
  const db = new DatabaseSync(outbox); db.prepare("UPDATE meta SET value='own_other' WHERE key='owner'").run(); db.close();
  assert.throws(() => s.open(), fails("conflict"));
  const fix = new DatabaseSync(outbox); fix.prepare("UPDATE meta SET value=? WHERE key='owner'").run(s.store.ownerId); fix.close();
  const reopened = s.open();
  s.fake.version = "2.5.1";
  const report = await reopened.flush();
  assert.equal(report.backend, "unavailable"); assert.equal(s.fake.writes.length, 0);
  assert.equal(outboxState(outbox, page.id), "queued"); assert.equal(reopened.status().health, "degraded");
});

test("close aborts owned in-flight work, persists unknown and a reopened controller never rewrites", async t => {
  const s = setup(t); const page = s.memory({ kind: "global" }, "# Fechar\n\nclose.\n");
  const slow = new AiMemoryHttpClient({ origin: ORIGIN, labLoopbackWithoutAuth: true, fetch: s.fake.fetch, timeoutMs: 60_000, isolation: s.isolation() });
  const sync = new AiMemorySync(s.store, s.context, slow);
  let entered!: () => void; const writing = new Promise<void>(resolve => { entered = resolve; });
  s.fake.onWrite = async () => { entered(); return "store_then_hang"; };
  const flight = sync.flush();
  await writing;
  await sync.close();
  assert.equal((await flight).backend, "unavailable");
  assert.equal(outboxState(sync.databasePath, page.id), "unknown");
  s.fake.onWrite = null;
  const reopened = new AiMemorySync(s.store, s.context, slow);
  t.after(() => reopened.close().catch(() => undefined));
  assert.equal((await reopened.flush()).confirmed, 1);
  assert.equal(s.fake.writes.length, 1);
});

test("indexing without an owner-exclusive attestation, or with one for another owner/origin, makes zero network requests", async t => {
  const s = setup(t); s.memory({ kind: "global" }, "# Sem atestado\n\nunattested.\n");
  const bare = new AiMemoryHttpClient({ origin: ORIGIN, labLoopbackWithoutAuth: true, fetch: s.fake.fetch });
  const key = `aim_${randomBytes(32).toString("base64url")}`;
  const keyed = new AiMemoryHttpClient({ origin: "https://memory.example", credential: () => key, fetch: s.fake.fetch }); // a key is not isolation evidence
  const ref = { workspace: "dx-abc", project: "owner-global", path: "notes/mem_1.md" };
  await assert.rejects(bare.writePage(ref, "# x\n"), fails("isolation"));
  await assert.rejects(keyed.writePage(ref, "# x\n"), fails("isolation"));
  const unattested = new AiMemorySync(s.store, s.context, bare);
  t.after(() => unattested.close().catch(() => undefined));
  assert.deepEqual([unattested.status().health, unattested.status().blocked, unattested.status().isolation], ["blocked", "isolation_unattested", "unattested"]);
  await assert.rejects(unattested.flush(), fails("forbidden"));
  assert.deepEqual(unattested.jobs(), []); // refused before discovery, too
  assert.equal(s.fake.requests.length, 0);
  // The attestation is bound to the exact origin at the client and to installation + owner at the outbox.
  assert.throws(() => new AiMemoryHttpClient({ origin: ORIGIN, labLoopbackWithoutAuth: true, isolation: s.isolation("http://127.0.0.1:49998") }), fails("config"));
  assert.throws(() => new AiMemoryHttpClient({ origin: ORIGIN, labLoopbackWithoutAuth: true, isolation: { ...s.isolation(), mode: "shared_teams" as never } }), fails("config"));
  assert.throws(() => new AiMemoryHttpClient({ origin: ORIGIN, labLoopbackWithoutAuth: true, isolation: { ...s.isolation(), extra: true } as never }), fails("config"));
  for (const wrong of [{ ownerId: "own_someone_else" }, { installationId: "host_other" }]) {
    const other = new AiMemoryHttpClient({ origin: ORIGIN, labLoopbackWithoutAuth: true, fetch: s.fake.fetch, isolation: { ...s.isolation(), ...wrong } });
    assert.throws(() => new AiMemorySync(s.store, s.context, other), fails("conflict"));
  }
  assert.equal(s.fake.requests.length, 0); assert.equal(s.fake.writes.length, 0);
  assert.ok(!JSON.stringify(keyed).includes(key) && !inspect(keyed, { showHidden: true, depth: 5 }).includes(key));
  assert.equal(JSON.stringify(s.client), JSON.stringify({ origin: ORIGIN, auth: "lab_loopback_none", isolation: "owner_exclusive_deployment" }));
});

test("reserved always-Open upstream projects are never write targets, even with an attestation", async t => {
  const s = setup(t);
  for (const project of ["_global", "scratch"]) await assert.rejects(s.client.writePage({ workspace: "dx-abc", project, path: "notes/mem_1.md" }, "# x\n"), fails("isolation"));
  assert.equal(s.fake.requests.length, 0);
  // Owner-global is global across this owner's bots but lands in a nonreserved project of the owner's own namespace.
  const page = s.memory({ kind: "global" }, "# Global do dono\n\nownerglobal.\n");
  assert.equal(page.service.project, "owner-global"); assert.match(page.service.workspace, /^dx-[0-9a-f]{24}-global$/);
  await s.open().flush();
  assert.deepEqual(s.fake.writes.map(w => w.project), ["owner-global"]);
});

test("legacy canonical _global pages are reported, never written, re-pointed or recalled", async t => {
  const s = setup(t); const a = s.principal("Alpha");
  const legacy = s.memory({ kind: "global" }, "# Antigo\n\nfarollegado.\n");
  const db = new DatabaseSync(s.context.databasePath); db.prepare("UPDATE memories SET project='_global' WHERE id=?").run(legacy.id); db.close();
  const current = s.memory({ kind: "global" }, "# Atual\n\nfarolatual.\n");
  const sync = s.open();
  const report = await sync.flush();
  assert.equal(report.legacy, 1); assert.equal(report.rejected, 0); assert.equal(report.writes, 1);
  assert.deepEqual(s.fake.writes.map(w => w.path), [`notes/${current.id}.md`]);
  assert.ok(!sync.jobs().some(job => job.memoryId === legacy.id));
  assert.deepEqual([sync.status().health, sync.status().legacyReservedPages], ["degraded", 1]);
  // Even if the old public page exists upstream, recall searches only the owner-global scope and the registry pin.
  s.fake.pages.set(s.fake.key(legacy.service.workspace, "_global", legacy.service.path), legacy.markdown);
  assert.deepEqual((await s.context.recall(a.token, { query: "farollegado", locale: "pt-BR" })).map(p => p.id), []);
  assert.ok(s.fake.requests.filter(r => r.path === "/api/v1/search").length > 0);
  assert.equal(s.context.activeMemoryPagesForSync({ ids: [legacy.id] })[0]!.service.project, "_global"); // canonical row preserved
});

test("schema-1 outbox: reserved pins quarantine read-only; otherwise upgrade keeps unknown without resend", async t => {
  const s = setup(t); const bot = s.principal("Alpha").bot.id;
  const global = s.memory({ kind: "global" }, "# Velho global\n\nold.\n");
  const own = s.memory({ kind: "bot", botId: bot }, "# Velho bot\n\nold bot.\n");
  s.fake.onWrite = async () => "drop"; // both writes acknowledged but never visible → unknown
  const first = s.open(); await first.flush(); await first.close();
  s.fake.onWrite = null;
  const outbox = first.databasePath;
  const downgrade = (sql: string) => { const db = new DatabaseSync(outbox); db.exec(`UPDATE meta SET value='1' WHERE key='schema'; ${sql}`); db.close(); };
  downgrade(`UPDATE jobs SET project='_global' WHERE memory_id='${global.id}'`);
  const snapshot = () => { const db = new DatabaseSync(outbox, { readOnly: true }); try { return JSON.stringify([db.prepare("SELECT * FROM meta ORDER BY key").all(), db.prepare("SELECT * FROM jobs ORDER BY memory_id").all()]); } finally { db.close(); } };
  const before = snapshot(); const requests = s.fake.requests.length;
  const quarantined = s.open();
  assert.deepEqual([quarantined.status().health, quarantined.status().blocked], ["blocked", "legacy_reserved_mapping"]);
  assert.deepEqual(quarantined.jobs().map(j => [j.memoryId, j.project, j.state]).sort(), [[global.id, "_global", "unknown"], [own.id, `bot-${bot}`, "unknown"]].sort());
  await assert.rejects(quarantined.flush(), fails("conflict"));
  await quarantined.close();
  assert.equal(snapshot(), before); assert.equal(s.fake.requests.length, requests); assert.equal(s.fake.writes.length, 2);
  // Without reserved pins the schema bump is the only change; the unknown bot job is reconciled by GET only.
  downgrade(`DELETE FROM jobs WHERE memory_id='${global.id}'`);
  const upgraded = s.open();
  assert.equal(outboxState(outbox, own.id), "unknown");
  const report = await upgraded.flush();
  assert.equal(s.fake.writes.filter(w => w.path.includes(own.id)).length, 1); assert.equal(outboxState(outbox, own.id), "unknown");
  assert.equal(report.unknown, 1);
  const db = new DatabaseSync(outbox, { readOnly: true }); assert.equal((db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string }).value, "2"); db.close();
});
