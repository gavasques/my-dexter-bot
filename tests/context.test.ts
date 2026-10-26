import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { HostStore, type HostStoreOptions } from "@dexter/hub";
import { AiMemoryReadAdapter, ContextHost, FixtureMemoryAdapter, type ContextHostOptions, type MemoryAdapter, type MemoryPage, type ServiceHit } from "@dexter/context";

const fails = (code: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code;
function setup(t: TestContext, adapter?: MemoryAdapter, storeOptions: Omit<HostStoreOptions, "dataDir"> = {}, contextOptions: ContextHostOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dexter-context-"));
  const store = new HostStore({ dataDir: dir, ...storeOptions });
  const cases: { query: string; locale: string; hits: ServiceHit[] }[] = [];
  let context = new ContextHost(store, adapter ?? new FixtureMemoryAdapter(cases), contextOptions);
  t.after(() => { context.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const principal = (name: string) => {
    const bot = store.createBot({ name, profileId: "personal", engine: "claude" });
    const thread = store.createThread(bot.id);
    const turn = store.createTurn(thread.id, { clientRequestId: "test", content: "synthetic" }).turn;
    store.claimNextTurn(thread.id);
    return { bot, thread, turn, token: context.issue(turn.id) };
  };
  const a = principal("Alpha"); const b = principal("Beta");
  const memory = (scope: MemoryPage["scope"], markdown: string, locale: MemoryPage["locale"] = "pt-BR") => context.createMemory({ scope, markdown, locale, origin: "synthetic fixture", classification: "context" });
  return { dir, store, get context() { return context; }, a, b, cases, memory,
    reopen: () => { context.close(); context = new ContextHost(store, adapter ?? new FixtureMemoryAdapter(cases), contextOptions); } };
}

test("fixed bilingual recall isolates bot, team and explicit confidential scopes", async t => {
  // Host filtering is tested even against an overbroad adapter, independent of fixture filtering.
  const hits: ServiceHit[] = [];
  const adapter: MemoryAdapter = { implementation: "fixture", targetVersion: "2.5.2", search: async () => hits };
  const { context: c, a, b, store, memory } = setup(t, adapter);
  const team = c.createTeam("Synthetic team"); c.assignBot(team, a.bot.id);
  const global = memory({ kind: "global" }, "# Compartilhado");
  const own = memory({ kind: "bot", botId: a.bot.id }, "# Alpha");
  const other = memory({ kind: "bot", botId: b.bot.id }, "# Beta");
  const confidential = memory({ kind: "confidential", botId: a.bot.id }, "# Privado");
  const otherConfidential = memory({ kind: "confidential", botId: b.bot.id }, "# Beta privado");
  const shared = memory({ kind: "team", teamId: team }, "# Equipe");
  const english = memory({ kind: "global" }, "# Shared", "en-US");
  hits.push(...[global, own, other, confidential, otherConfidential, shared, english].map(p => p.service));
  assert.deepEqual((await c.recall(a.token, { query: "tema", locale: "pt-BR" })).map(p => p.id), [global.id, own.id]);
  assert.deepEqual((await c.recall(a.token, { query: "tema", locale: "pt-BR", includeConfidential: true })).map(p => p.id), [global.id, own.id, confidential.id]);
  assert.deepEqual((await c.recall(a.token, { query: "topic", locale: "en-US" })).map(p => p.id), [english.id]);
  await assert.rejects(c.recall(a.token, { query: "x", locale: "pt-BR", botId: b.bot.id } as never), fails("invalid_input"));
  c.setMember(team, store.ownerId, false);
  assert.deepEqual((await c.recall(a.token, { query: "tema", locale: "pt-BR" })).map(p => p.id), [global.id, own.id]);
  assert.throws(() => c.assignBot(team, b.bot.id), fails("forbidden"));
  c.setMember(team, "synthetic_outsider", true); // does not change host principal
  assert.deepEqual((await c.recall(b.token, { query: "tema", locale: "pt-BR" })).map(p => p.id), [global.id, other.id]);
});

test("fixed fixtures require the chosen query and locale; sensitive classifications never persist", async t => {
  const { context: c, cases, a, memory } = setup(t);
  const page = memory({ kind: "global" }, "# Preferência de idioma");
  cases.push({ query: "idioma", locale: "pt-BR", hits: [page.service] });
  assert.equal((await c.recall(a.token, { query: "idioma", locale: "pt-BR" }))[0]?.markdown, page.markdown);
  assert.deepEqual(await c.recall(a.token, { query: "language", locale: "en-US" }), []);
  for (const classification of ["secret", "health"] as const) assert.throws(() => c.createMemory({ scope: { kind: "global" }, locale: "pt-BR", markdown: "synthetic excluded marker", origin: "fixture", classification }), fails("forbidden"));
  assert.throws(() => c.createMemory({ scope: { kind: "global" }, locale: "de-DE" as never, markdown: "invalid locale", origin: "fixture", classification: "context" }), fails("invalid_input"));
  const db = new DatabaseSync(c.databasePath, { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM memories").get()?.n, 1); db.close();
  assert.deepEqual(c.status(), { backend: "fixture", targetVersion: "2.5.2", integration: "fixture", activeCapabilities: 2 });
});

test("revocation during asynchronous recall is fail closed, and capabilities do not survive reopen", async t => {
  let release!: (hits: ServiceHit[]) => void;
  const adapter: MemoryAdapter = { implementation: "fixture", targetVersion: "2.5.2", search: () => new Promise(resolve => { release = resolve; }) };
  const s = setup(t, adapter); const page = s.memory({ kind: "global" }, "# Public");
  const pending = s.context.recall(s.a.token, { query: "x", locale: "pt-BR" });
  s.context.setRecallGrant(s.a.bot.id, { kind: "global" }, false);
  s.context.setRecallGrant(s.a.bot.id, { kind: "global" }, true); // ABA must also invalidate in-flight recall
  release([page.service]); await assert.rejects(pending, fails("forbidden"));
  const team = s.context.createTeam("Await membership"); s.context.assignBot(team, s.a.bot.id);
  const pendingTeam = s.context.recall(s.a.token, { query: "x", locale: "pt-BR" });
  s.context.setMember(team, s.store.ownerId, false); s.context.setMember(team, s.store.ownerId, true);
  release([page.service]); await assert.rejects(pendingTeam, fails("forbidden"));
  s.context.revoke(s.b.token); await assert.rejects(s.context.recall(s.b.token, { query: "x", locale: "pt-BR" }), fails("forbidden"));
  s.reopen(); await assert.rejects(s.context.recall(s.a.token, { query: "x", locale: "pt-BR" }), fails("forbidden"));
  const fresh = s.context.issue(s.a.turn.id);
  assert.match(fresh, /^[a-f0-9]{64}$/);
  s.store.finishTurn(s.a.turn.id, "completed", null);
  await assert.rejects(s.context.recall(fresh, { query: "x", locale: "pt-BR" }), fails("forbidden"));
  assert.throws(() => s.context.issue(s.a.turn.id), fails("forbidden"));
});

test("explicit promotion freezes its approval, rechecks grants and is reversible without deleting source", async t => {
  const { context: c, a, b, memory, cases } = setup(t);
  const source = memory({ kind: "bot", botId: a.bot.id }, "# Promote deliberately");
  cases.push({ query: "x", locale: "pt-BR", hits: [source.service] });
  const proposal = c.proposePromotion(a.token, source.id, { kind: "global" });
  assert.deepEqual(await c.recall(b.token, { query: "x", locale: "pt-BR" }), []);
  assert.throws(() => c.approvePromotion(proposal.id, "wrong"), fails("conflict"));
  const promoted = c.approvePromotion(proposal.id, proposal.requestHash); cases[0]!.hits.push(promoted.service);
  assert.equal((await c.recall(b.token, { query: "x", locale: "pt-BR" }))[0]?.markdown, source.markdown);
  c.reversePromotion(proposal.id);
  assert.deepEqual(await c.recall(b.token, { query: "x", locale: "pt-BR" }), []);
  assert.equal((await c.recall(a.token, { query: "x", locale: "pt-BR" }))[0]?.id, source.id);
  const denied = c.proposePromotion(a.token, source.id, { kind: "global" });
  c.setRecallGrant(a.bot.id, { kind: "global" }, false);
  assert.throws(() => c.approvePromotion(denied.id, denied.requestHash), fails("forbidden"));
  const confidential = memory({ kind: "confidential", botId: a.bot.id }, "# Private");
  assert.throws(() => c.proposePromotion(a.token, confidential.id, { kind: "bot", botId: a.bot.id }), fails("forbidden"));
});

test("skills pin Git content, apply deterministic global/team/bot overrides and reject tampering", t => {
  const { context: c, a, b, store } = setup(t);
  const team = c.createTeam("Team"); c.assignBot(team, a.bot.id);
  const global = c.registerSkill("write", "1.0.0", "# Global\n\n");
  const shared = c.registerSkill("write", "1.1.0", "# Team");
  const own = c.registerSkill("write", "2.0.0", "# Bot");
  c.activateSkill({ kind: "global" }, global); c.activateSkill({ kind: "team", teamId: team }, shared); c.activateSkill({ kind: "bot", botId: a.bot.id }, own);
  assert.equal(c.skills(a.token)[0]?.version, "2.0.0"); assert.equal(c.skills(b.token)[0]?.version, "1.0.0");
  c.deactivateSkill({ kind: "bot", botId: a.bot.id }, "write"); assert.equal(c.skills(a.token)[0]?.version, "1.0.0", "team membership does not activate skills in private turns");
  c.setMember(team, store.ownerId, false); assert.equal(c.skills(a.token)[0]?.markdown, "# Global\n\n");
  assert.throws(() => c.activateSkill({ kind: "global" }, { ...global, sha256: own.sha256 }), fails("tampered"));
  assert.throws(() => c.registerSkill("write", "1.0.0", "# Replace"), fails("conflict"));
  writeFileSync(join(c.repositoryPath, global.path), "# Modified");
  assert.throws(() => c.skills(b.token), fails("tampered"));
});

test("artifact CAS, history, restore and fork keep immutable revisions and bot authority", t => {
  const s = setup(t); const c = s.context;
  const first = c.createArtifact(s.a.token, "# First\n\n", "synthetic label");
  const second = c.reviseArtifact(s.a.token, first.id, 1, "# Second", "synthetic edit");
  assert.throws(() => c.reviseArtifact(s.a.token, first.id, 1, "# Stale", "stale"), fails("conflict"));
  const restored = c.restoreArtifact(s.a.token, first.id, 2, 1);
  assert.equal(restored.revision, 3); assert.equal(restored.restoredFrom, 1); assert.equal(restored.markdown, first.markdown);
  assert.equal(c.artifact(s.a.token, first.id, 2).markdown, second.markdown);
  assert.deepEqual(c.artifactHistory(s.a.token, first.id).map(r => r.revision), [1, 2, 3]);
  const db = new DatabaseSync(c.databasePath, { readOnly: true });
  const counts = () => ["memories", "skills", "activations"].map(table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
  const before = counts();
  const fork = c.forkArtifact(s.a.token, first.id, 2);
  assert.deepEqual(counts(), before); db.close();
  assert.deepEqual(fork.forkedFrom, { artifactId: first.id, revision: 2 }); assert.equal(fork.revision, 1);
  assert.equal(c.artifactHistory(s.a.token, fork.id).length, 1);
  assert.throws(() => c.artifact(s.b.token, first.id), fails("not_found"));
  assert.throws(() => c.forkArtifact(s.b.token, first.id, 1), fails("not_found"));
  s.reopen(); const token = s.context.issue(s.a.turn.id);
  assert.equal(s.context.artifact(token, first.id).revision, 3);
  writeFileSync(join(s.context.repositoryPath, restored.path), "# Tampered");
  assert.throws(() => s.context.restoreArtifact(token, first.id, 3, 3), fails("tampered"));
  assert.equal(s.context.artifactHistory(token, first.id).length, 3);
});

test("all persistent context mutations are fenced by the actual host lease", t => {
  const { context: c, store, a } = setup(t);
  const artifact = c.createArtifact(a.token, "# One", "fixture");
  const headPath = join(c.repositoryPath, ".git", "refs", "heads", "master");
  // Git default branch is host-local and must not depend on global configuration.
  const head = readFileSync(headPath, "utf8");
  const db = new DatabaseSync(store.databasePath);
  const lease = db.prepare("SELECT token FROM host_lease WHERE id=1").get()!.token as string;
  db.prepare("UPDATE host_lease SET token='synthetic-revoked' WHERE id=1").run();
  try {
    for (const operation of [() => c.createTeam("lost"), () => c.registerSkill("lost", "1.0.0", "lost"), () => c.reviseArtifact(a.token, artifact.id, 1, "lost", "fixture"), () => c.createMemory({ scope: { kind: "global" }, locale: "pt-BR", markdown: "lost", origin: "fixture", classification: "context" }), () => c.issue(a.turn.id), () => new ContextHost(store, new FixtureMemoryAdapter([]))]) assert.throws(operation, fails("host_locked"));
    assert.equal(readFileSync(headPath, "utf8"), head);
    assert.throws(() => c.artifactHistory(a.token, artifact.id), fails("host_locked"), "lost writer authority cannot authorize a capability read");
  } finally { db.prepare("UPDATE host_lease SET token=? WHERE id=1").run(lease); db.close(); }
});

test("context metadata cannot be silently rebound to another installation", t => {
  const original = setup(t); original.context.close();
  const dir = mkdtempSync(join(tmpdir(), "dexter-context-other-"));
  const store = new HostStore({ dataDir: dir });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  cpSync(original.context.databasePath, join(dir, "context.sqlite"));
  assert.throws(() => new ContextHost(store, new FixtureMemoryAdapter([])), fails("conflict"));
});

test("ai-memory v2.5.2 read seam sends explicit scopes and ignores provider content and diagnostics", async () => {
  const calls: unknown[] = [];
  const adapter = new AiMemoryReadAdapter(async call => { calls.push(call); return [{ workspace: "isolated", project: "_global", path: "notes/a.md", snippet: "untrusted ignored" }]; });
  const request = { query: "idioma", locale: "pt-BR" as const, scopes: [{ workspace: "isolated", project: "_global" }], limit: 4 };
  assert.deepEqual(await adapter.search(request), [{ workspace: "isolated", project: "_global", path: "notes/a.md" }]);
  assert.deepEqual(calls, [{ method: "POST", path: "/api/v1/search", body: { q: "idioma", scopes: request.scopes, limit: 4 } }]);
  await assert.rejects(adapter.search({ ...request, scopes: [] }), fails("invalid_input"));
  const broken = new AiMemoryReadAdapter(async () => { throw new Error("synthetic sensitive diagnostic"); });
  await assert.rejects(broken.search(request), error => fails("adapter_failed")(error) && (error as Error).message === "adapter_failed");
  const malformed = new AiMemoryReadAdapter(async () => [{ workspace: "x" }]);
  await assert.rejects(malformed.search(request), fails("adapter_failed"));
});

function gitContext(root: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", root, ...args], {
    encoding: "utf8", env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

test("dangling SQLite, Git and context-directory symlinks never create their outside targets", t => {
  for (const source of ["context.sqlite", "context.sqlite-wal", "context.sqlite-shm", "context-revisions", "context-revisions/.git", "context-revisions/.git/objects"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "dexter-context-symlink-"));
    const store = new HostStore({ dataDir: dir });
    const outside = `${dir}-outside-missing-target`;
    t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
    if (source.endsWith("/objects")) {
      const original = new ContextHost(store, new FixtureMemoryAdapter([])); original.close();
      rmSync(join(dir, source), { recursive: true });
    } else if (source.includes("/.git")) mkdirSync(join(dir, "context-revisions"));
    symlinkSync(outside, join(dir, source));
    assert.throws(() => new ContextHost(store, new FixtureMemoryAdapter([])), fails("tampered"), source);
    assert.equal(existsSync(outside), false, `${source} must not create any outside data`);
  }
  const s = setup(t);
  const outside = join(s.dir, "missing-skills-target");
  symlinkSync(outside, join(s.context.repositoryPath, "skills"));
  assert.throws(() => s.context.registerSkill("never", "1.0.0", "# Safe"), fails("tampered"));
  assert.equal(existsSync(outside), false);
});

test("capabilities are one per live turn, expire, prune terminal entries and reject malformed revoke safely", async t => {
  let now = 1_000;
  const s = setup(t, undefined, { clock: () => now }, { capabilityTTLms: 10 });
  assert.equal(s.context.status().activeCapabilities, 2);
  for (let n = 0; n < 5; n++) assert.throws(() => s.context.issue(s.a.turn.id), fails("conflict"));
  assert.deepEqual(s.context.skills(s.a.token), []); // duplicate issue did not invalidate the original
  s.store.finishTurn(s.a.turn.id, "completed", null);
  assert.equal(s.context.status().activeCapabilities, 1);
  now += 10;
  assert.equal(s.context.status().activeCapabilities, 0);
  await assert.rejects(s.context.recall(s.b.token, { query: "x", locale: "pt-BR" }), fails("forbidden"));
  const fresh = s.context.issue(s.b.turn.id);
  assert.throws(() => s.context.revoke(undefined as never), fails("invalid_input"));
  assert.throws(() => s.context.revoke("bad"), fails("invalid_input"));
  assert.equal(s.context.status().activeCapabilities, 1);
  s.context.revoke(fresh);
  const replacement = s.context.issue(s.b.turn.id);
  assert.notEqual(replacement, fresh);
  assert.throws(() => s.context.skills(fresh), fails("forbidden"));
  for (let n = 0; n < 30; n++) {
    const turn = s.store.createTurn(s.a.thread.id, { clientRequestId: `bounded-${n}`, content: "synthetic" }).turn;
    s.store.claimNextTurn(s.a.thread.id);
    s.context.issue(turn.id);
    assert.equal(s.context.status().activeCapabilities, 2);
    s.store.finishTurn(turn.id, "completed", null);
  }
  assert.equal(s.context.status().activeCapabilities, 1);
});

test("transient Git index locks clean only the new skill file and allow the same version retry", t => {
  const s = setup(t); const c = s.context;
  c.createArtifact(s.a.token, "# Baseline", "fixture");
  writeFileSync(join(c.repositoryPath, "unrelated.md"), "unrelated staged change");
  gitContext(c.repositoryPath, "add", "--", "unrelated.md");
  const before = readFileSync(join(c.repositoryPath, ".git", "index"));
  const lock = join(c.repositoryPath, ".git", "index.lock");
  writeFileSync(lock, "synthetic lock");
  assert.throws(() => c.registerSkill("retry", "1.0.0", "# Retry"), fails("conflict"));
  assert.equal(existsSync(join(c.repositoryPath, "skills", "retry", "1.0.0.md")), false);
  assert.deepEqual(readFileSync(join(c.repositoryPath, ".git", "index")), before);
  unlinkSync(lock);
  const registered = c.registerSkill("retry", "1.0.0", "# Retry");
  c.activateSkill({ kind: "global" }, registered);
  assert.equal(c.skills(s.a.token)[0]?.markdown, "# Retry");
  assert.equal(gitContext(c.repositoryPath, "diff", "--cached", "--name-only"), "unrelated.md");
});

test("a successful Git revision survives a later SQLite metadata rollback", t => {
  const s = setup(t); const c = s.context;
  const db = new DatabaseSync(c.databasePath);
  try {
    s.store.withWriterLease(() => db.exec("CREATE TRIGGER reject_skill BEFORE INSERT ON skills BEGIN SELECT RAISE(ABORT,'synthetic metadata failure'); END"));
    assert.throws(() => c.registerSkill("orphan", "1.0.0", "# Committed orphan"));
    const path = "skills/orphan/1.0.0.md";
    assert.equal(readFileSync(join(c.repositoryPath, path), "utf8"), "# Committed orphan");
    assert.equal(gitContext(c.repositoryPath, "show", `HEAD:${path}`), "# Committed orphan");
    assert.equal(db.prepare("SELECT count(*) AS n FROM skills").get()?.n, 0);
    s.store.withWriterLease(() => db.exec("DROP TRIGGER reject_skill"));
    assert.throws(() => c.registerSkill("orphan", "1.0.0", "# Overwrite"), fails("conflict"));
    assert.equal(readFileSync(join(c.repositoryPath, path), "utf8"), "# Committed orphan");
  } finally { db.close(); }
});

test("unpaired surrogates are rejected before Git writes and valid Unicode roundtrips exactly", async t => {
  const s = setup(t); const c = s.context;
  const artifact = c.createArtifact(s.a.token, "# Baseline", "fixture");
  const head = gitContext(c.repositoryPath, "rev-parse", "HEAD");
  for (const malformed of ["\ud800", "prefix\udfffend", "\ud800\ud800"]) {
    const operations = [
      () => c.createMemory({ scope: { kind: "global" }, locale: "pt-BR", markdown: malformed, origin: "fixture", classification: "context" }),
      () => c.createMemory({ scope: { kind: "global" }, locale: "pt-BR", markdown: "valid", origin: malformed, classification: "context" }),
      () => c.registerSkill("unicode", "1.0.0", malformed),
      () => c.createArtifact(s.a.token, malformed, "fixture"),
      () => c.createArtifact(s.a.token, "valid", malformed),
      () => c.reviseArtifact(s.a.token, artifact.id, 1, malformed, "fixture"),
      () => c.reviseArtifact(s.a.token, artifact.id, 1, "valid", malformed),
    ];
    for (const operation of operations) assert.throws(operation, fails("invalid_input"));
    assert.equal(gitContext(c.repositoryPath, "rev-parse", "HEAD"), head);
    assert.equal(c.artifactHistory(s.a.token, artifact.id).length, 1);
  }
  const body = "# Café 👩🏽‍💻\n\n中文\n";
  const memory = s.memory({ kind: "global" }, body);
  s.cases.push({ query: "unicode", locale: "pt-BR", hits: [memory.service] });
  assert.equal((await c.recall(s.a.token, { query: "unicode", locale: "pt-BR" }))[0]?.markdown, body);
  const skill = c.registerSkill("unicode", "1.0.0", body); c.activateSkill({ kind: "global" }, skill);
  assert.equal(c.skills(s.a.token)[0]?.markdown, body);
  const revised = c.reviseArtifact(s.a.token, artifact.id, 1, body, "edição 📝");
  assert.equal(c.artifact(s.a.token, revised.id).markdown, body);
});
