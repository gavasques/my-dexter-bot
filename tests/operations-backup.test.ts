import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, createSecretKey, randomBytes, type KeyObject } from "node:crypto";
import fs, {
  appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { deflateSync } from "node:zlib";
import { Agenda } from "@dexter/agenda";
import { ContextHost, FixtureMemoryAdapter } from "@dexter/context";
import { HostStore } from "@dexter/hub";
import {
  INSPECTION_DIR, INSPECTION_FILES, INSPECTION_GIT_DIR, OperationsError, QUARANTINE_FILE, captureInspectionSnapshot, requestAuthorityTransfer,
  restoreForInspection, type CaptureOptions, type CaptureReceipt, type OperationsErrorCode, type SnapshotKey,
} from "@dexter/operations";

// ---- synthetic fixtures (test-owned temp paths, synthetic keys and phrases only) ---------------------------

const KEY_ID = "fixture-key-1";
function fixtureKey(seed = 7, keyId = KEY_ID): SnapshotKey & { lends: number } {
  const key = createSecretKey(Buffer.alloc(32, seed));
  const capability = { keyId, lends: 0, use<T>(operation: (lent: KeyObject) => T): T { capability.lends += 1; return operation(key); } };
  return capability;
}
const code = (expected: OperationsErrorCode) => (error: unknown) => {
  assert.ok(error instanceof OperationsError, `expected OperationsError, got ${String(error)}`);
  assert.equal(error.code, expected, error.message);
  return true;
};
const hostCode = (expected: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === expected;

function workspace(t: TestContext): string {
  // Canonical (realpath) temp root: /var on macOS is a symlink, and the API refuses symlink components.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dexter-ops-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

interface Fixture {
  root: string; dataDir: string; out: string; store: HostStore; context: ContextHost; agenda: Agenda;
  botId: string; threadId: string; artifactId: string; forkId: string; nativeCursor: string; leaseToken: string;
  awaitingActionId: string; runningActionId: string; runningTurnId: string; occurrenceRequestId: string;
  close(): void;
}

function seed(t: TestContext, options: { context?: boolean; agenda?: boolean } = {}): Fixture {
  const root = workspace(t);
  const dataDir = join(root, "data"); const out = join(root, "out");
  mkdirSync(out, { mode: 0o700 });
  const store = new HostStore({ dataDir });
  const context = new ContextHost(store, new FixtureMemoryAdapter([]));
  const agenda = new Agenda(store);
  let closed = false;
  const close = (): void => { if (closed) return; closed = true; agenda.close(); context.close(); store.close(); };
  t.after(close);

  const bot = store.createBot({ name: "Synthetic", profileId: "personal", engine: "claude" });
  const thread = store.createThread(bot.id);
  store.appendMessage(thread.id, { clientMessageId: "m1", content: "synthetic hello one" });
  store.appendMessage(thread.id, { clientMessageId: "m2", content: "synthetic hello two" });
  const first = store.createTurn(thread.id, { clientRequestId: "turn-1", content: "synthetic turn one" }).turn;
  store.claimNextTurn(thread.id);
  const nativeCursor = "nativeCursorSyntheticABC123";
  store.finishTurn(first.id, "completed", null, nativeCursor);
  const running = store.createTurn(thread.id, { clientRequestId: "turn-2", content: "synthetic turn two" }).turn;
  store.claimNextTurn(thread.id);

  store.setGrant({ botId: bot.id, tool: "fixture.ask", destination: "dest_ask", policy: "ask" });
  const awaiting = store.requestAction({ botId: bot.id, threadId: thread.id, tool: "fixture.ask", destination: "dest_ask", arguments: { note: "synthetic" }, idempotencyKey: "act-ask" });
  store.setGrant({ botId: bot.id, tool: "fixture.run", destination: "dest_run", policy: "allow" });
  const ready = store.requestAction({ botId: bot.id, threadId: thread.id, tool: "fixture.run", destination: "dest_run", arguments: { note: "synthetic" }, idempotencyKey: "act-run" });
  store.claimAction(ready.id);
  store.registerDevice({ name: "Synthetic Mac", platform: "macos", capabilities: ["fixture.run"] });

  let artifactId = ""; let forkId = "";
  if (options.context !== false) {
    const token = context.issue(running.id);
    const artifact = context.createArtifact(token, "# Synthetic artifact r1\n", "fixture");
    context.reviseArtifact(token, artifact.id, 1, "# Synthetic artifact r2\n", "fixture");
    forkId = context.forkArtifact(token, artifact.id, 1).id;
    artifactId = artifact.id;
    const lock = context.registerSkill("synthetic_skill", "1.0.0", "# Synthetic skill\n");
    context.activateSkill({ kind: "global" }, lock);
    context.createMemory({ scope: { kind: "global" }, locale: "pt-BR", markdown: "# Memória sintética\n", origin: "fixture", classification: "context" });
  }
  let occurrenceRequestId = "";
  if (options.agenda !== false) {
    agenda.create({ botId: bot.id, threadId: thread.id, content: "synthetic reminder", when: { kind: "once", at: store.now() } });
    assert.equal(agenda.prepareDue().prepared, 1);
    occurrenceRequestId = agenda.listOccurrences().items[0]!.clientRequestId;
  }
  // Last write lands in WAL (no checkpoint at this size).
  store.appendMessage(thread.id, { clientMessageId: "m3", content: "synthetic latest in wal" });
  const raw = new DatabaseSync(join(dataDir, "dexter.sqlite"), { readOnly: true });
  const leaseToken = String((raw.prepare("SELECT token FROM host_lease").get() as { token: string }).token);
  raw.close();
  return {
    root, dataDir, out, store, context, agenda, botId: bot.id, threadId: thread.id, artifactId, forkId, nativeCursor, leaseToken,
    awaitingActionId: awaiting.id, runningActionId: ready.id, runningTurnId: running.id, occurrenceRequestId, close,
  };
}

function capture(f: Fixture, overrides: Partial<CaptureOptions> = {}): CaptureReceipt {
  return captureInspectionSnapshot({
    source: f.store, include: { context: true, agenda: true, deviceRegistry: false, deviceSurface: false }, key: fixtureKey(), output: join(f.out, "snapshot.dxg8"), ...overrides,
  });
}
const entries = (path: string): string[] => readdirSync(path).sort();
const rows = (path: string, sql: string, ...args: Array<string | number>): Array<Record<string, unknown>> => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return (db.prepare(sql).all(...args) as Array<Record<string, unknown>>).map((row) => ({ ...row })); } finally { db.close(); }
};
function walk(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory() ? [join(path, item.name), ...walk(join(path, item.name))] : [join(path, item.name)]);
}

// ---- independent reimplementation of the documented envelope (used to forge authenticated payloads) -------

interface Opened { header: Buffer; payload: Buffer }
function unseal(envelope: Buffer, seedByte = 7): Opened {
  const headerLength = envelope.readUInt16BE(8);
  const aadLength = 10 + headerLength + 12;
  const decipher = createDecipheriv("aes-256-gcm", createSecretKey(Buffer.alloc(32, seedByte)), envelope.subarray(10 + headerLength, aadLength), { authTagLength: 16 });
  decipher.setAAD(envelope.subarray(0, aadLength));
  decipher.setAuthTag(envelope.subarray(envelope.length - 16));
  const payload = Buffer.concat([decipher.update(envelope.subarray(aadLength, envelope.length - 16)), decipher.final()]);
  return { header: envelope.subarray(10, 10 + headerLength), payload };
}
function reseal(payload: Buffer, seedByte = 7, keyId = KEY_ID): Buffer {
  const header = Buffer.from(JSON.stringify({ v: 1, alg: "AES-256-GCM", purpose: "dexter.g8.inspection-snapshot", keyId, ciphertextBytes: payload.length }));
  const length = Buffer.alloc(2); length.writeUInt16BE(header.length);
  const nonce = randomBytes(12);
  const aad = Buffer.concat([Buffer.from([0x44, 0x58, 0x47, 0x38, 0x53, 0x4e, 0x50, 0x01]), length, header, nonce]);
  const cipher = createCipheriv("aes-256-gcm", createSecretKey(Buffer.alloc(32, seedByte)), nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([aad, ciphertext, cipher.getAuthTag()]);
}
interface Decoded { manifest: Record<string, any>; members: Map<string, Buffer> }
function decode(payload: Buffer): Decoded {
  const length = payload.readUInt32BE(0);
  const manifest = JSON.parse(payload.subarray(4, 4 + length).toString("utf8"));
  const members = new Map<string, Buffer>();
  let offset = 4 + length;
  for (const member of manifest.members) { members.set(member.name, payload.subarray(offset, offset + member.bytes)); offset += member.bytes; }
  return { manifest, members };
}
/** Re-encodes with member sizes/digests recomputed, so only the intended semantic corruption remains. */
function encode(decoded: Decoded, order: string[] = decoded.manifest.members.map((m: { name: string }) => m.name)): Buffer {
  const manifest = { ...decoded.manifest, members: order.map((name) => {
    const bytes = decoded.members.get(name)!;
    return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }) };
  const json = Buffer.from(JSON.stringify(manifest));
  const length = Buffer.alloc(4); length.writeUInt32BE(json.length);
  return Buffer.concat([length, json, ...order.map((name) => decoded.members.get(name)!)]);
}
function forge(artifact: string, target: string, mutate: (decoded: Decoded) => Buffer | void): void {
  const decoded = decode(unseal(readFileSync(artifact)).payload);
  const payload = mutate(decoded) ?? encode(decoded);
  writeFileSync(target, reseal(payload), { flag: "wx" });
}
function mutateDatabase(bytes: Buffer, dir: string, sql: string): Buffer {
  const path = join(dir, `mutate-${randomBytes(4).toString("hex")}.sqlite`);
  writeFileSync(path, bytes);
  const db = new DatabaseSync(path);
  db.exec(sql); db.close();
  const changed = readFileSync(path); unlinkSync(path);
  return changed;
}

// ---- capture ------------------------------------------------------------------------------------------

test("capture under the real writer fence includes WAL-resident writes and blocks every canonical writer", (t) => {
  const f = seed(t);
  assert.ok(statSync(join(f.dataDir, "dexter.sqlite-wal")).size > 0, "fixture keeps its latest write in WAL");
  const probes: string[] = [];
  let lateWrite = false;
  setImmediate(() => { f.store.appendMessage(f.threadId, { clientMessageId: "late", content: "synthetic after capture" }); lateWrite = true; });
  const receipt = capture(f, {
    onStage: (stage) => {
      if (stage !== "hub_copied" && stage !== "agenda_copied") return;
      // SQLite level: another connection cannot take the Hub write lock while the lease transaction is open.
      const raw = new DatabaseSync(join(f.dataDir, "dexter.sqlite"), { timeout: 0 });
      assert.throws(() => raw.exec("BEGIN IMMEDIATE"), /locked|busy/i); raw.close();
      // In process: Hub, Context and Agenda writes all need the same fence and cannot commit inside it.
      assert.throws(() => f.store.appendMessage(f.threadId, { clientMessageId: `in-${stage}`, content: "synthetic racing write" }));
      assert.throws(() => f.context.createTeam("racing team"));
      assert.throws(() => f.agenda.create({ botId: f.botId, threadId: f.threadId, content: "racing", when: { kind: "once", at: f.store.now() } }));
      probes.push(stage);
    },
  });
  assert.deepEqual(probes, ["hub_copied", "agenda_copied"]);
  assert.equal(lateWrite, false, "a write scheduled before capture can only run after it");
  assert.equal(receipt.counts.hub.messages, 5, "WAL-resident message is captured; racing writes are not");
  assert.equal(rows(join(f.dataDir, "dexter.sqlite"), "SELECT COUNT(*) AS n FROM messages WHERE client_message_id LIKE 'in-%'")[0]?.n, 0);
  assert.equal(receipt.counts.context?.revisions, 3);
  assert.equal(receipt.counts.agenda?.occurrences.prepared, 1);
  assert.equal(receipt.fence, "host_writer_lease");
  assert.equal(receipt.drain, "caller_responsibility_not_verified");
  assert.deepEqual(entries(f.out), ["snapshot.dxg8"], "only the final artifact remains next to the output");
  // Source is never sanitized: lease, cursor and in-flight states stay as the live host left them.
  assert.equal(rows(join(f.dataDir, "dexter.sqlite"), "SELECT token FROM host_lease")[0]?.token, f.leaseToken);
  assert.equal(f.store.getThreadSession(f.threadId)?.nativeCursor, f.nativeCursor);
  assert.equal(f.store.getAction(f.runningActionId).state, "running");
  assert.equal((statSync(join(f.out, "snapshot.dxg8")).mode & 0o777), 0o600);
  return new Promise<void>((resolve) => setImmediate(() => { assert.equal(lateWrite, true); resolve(); }));
});

test("fixture coordinator drains before capture and keeps the writer held until it finishes", async (t) => {
  const f = seed(t, { context: false, agenda: false });
  // Fixture only: models admission/drain around the real fence; HostServices has no such maintenance mode yet.
  const inflight = new Set<Promise<void>>();
  let admitting = true;
  const submit = (job: () => Promise<void>): Promise<void> => {
    if (!admitting) return Promise.reject(new Error("admission closed"));
    const promise = job().finally(() => inflight.delete(promise));
    inflight.add(promise);
    return promise;
  };
  const drained = submit(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); f.store.appendMessage(f.threadId, { clientMessageId: "drained", content: "synthetic drained" }); });
  admitting = false;
  await assert.rejects(submit(async () => {}), /admission closed/);
  await Promise.allSettled([...inflight]);
  await drained;
  assert.equal(inflight.size, 0);
  const receipt = captureInspectionSnapshot({ source: f.store, include: { context: false, agenda: false, deviceRegistry: false, deviceSurface: false }, key: fixtureKey(), output: join(f.out, "a.dxg8") });
  assert.equal(receipt.counts.hub.messages, 6, "drained work is part of the snapshot");
  assert.equal(receipt.counts.context, null);
  // Still inside the coordinator: the canonical lease is held, a second writer is refused.
  assert.throws(() => new HostStore({ dataDir: f.dataDir }), hostCode("host_locked"));
  f.close();
  const reopened = new HostStore({ dataDir: f.dataDir });
  reopened.close();
  const restored = restoreForInspection({ artifact: receipt.path, key: fixtureKey(), destination: join(f.root, "hub-only") });
  assert.deepEqual(restored.files, [QUARANTINE_FILE, `${INSPECTION_DIR}/${INSPECTION_FILES.hub}`]);
  assert.deepEqual(entries(join(f.root, "hub-only", INSPECTION_DIR)), [INSPECTION_FILES.hub]);
});

test("capture without an open writer fence, or after shutdown, refuses instead of copying files", (t) => {
  const f = seed(t, { context: false, agenda: false });
  f.close();
  assert.throws(() => captureInspectionSnapshot({ source: f.store, include: { context: false, agenda: false, deviceRegistry: false, deviceSurface: false }, key: fixtureKey(), output: join(f.out, "x.dxg8") }),
    code("fence_unavailable"));
  assert.throws(() => captureInspectionSnapshot({ source: null as never, include: { context: false, agenda: false, deviceRegistry: false, deviceSurface: false }, key: fixtureKey(), output: join(f.out, "x.dxg8") }),
    code("fence_unavailable"));
  assert.deepEqual(entries(f.out), []);
});

test("capture refuses unknown schemas, foreign identity, unsafe Git and never runs repository hooks", (t) => {
  const f = seed(t);
  const marker = join(f.root, "hook-ran");
  const git = join(f.dataDir, "context-revisions", ".git");
  for (const hook of ["post-checkout", "pre-commit", "post-commit", "reference-transaction", "fsmonitor-watchman"]) {
    writeFileSync(join(git, "hooks", hook), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  }
  appendFileSync(join(git, "config"), `[core]\n\tfsmonitor = ${join(git, "hooks", "fsmonitor-watchman")}\n\thooksPath = hooks\n`);
  const receipt = capture(f);
  restoreForInspection({ artifact: receipt.path, key: fixtureKey(), destination: join(f.root, "inspect") });
  assert.equal(existsSync(marker), false, "no Git hook or fsmonitor executed during capture or restore");

  // Unsupported Git shapes fail closed.
  const objects = join(git, "objects");
  const link = join(objects, "pack", "pack-evil.pack");
  symlinkSync("/etc/hosts", link);
  assert.throws(() => capture(f, { output: join(f.out, "b.dxg8") }), code("unsupported_schema"));
  unlinkSync(link);
  const loose = readdirSync(objects).find((name) => /^[0-9a-f]{2}$/.test(name))!;
  const evil = join(objects, loose, "f".repeat(38));
  symlinkSync("/etc/hosts", evil);
  assert.throws(() => capture(f, { output: join(f.out, "b.dxg8") }), code("unsafe_path"));
  unlinkSync(evil);
  writeFileSync(join(git, "packed-refs"), "# synthetic\n");
  assert.throws(() => capture(f, { output: join(f.out, "b.dxg8") }), code("unsupported_schema"));
  unlinkSync(join(git, "packed-refs"));
  const bad = join(objects, loose, "0".repeat(38));
  writeFileSync(bad, deflateSync(Buffer.from("blob 4\0evil")));
  assert.throws(() => capture(f, { output: join(f.out, "b.dxg8") }), code("corrupt"));
  unlinkSync(bad);

  // Unknown schema objects and foreign identity in the canonical databases.
  const hub = new DatabaseSync(join(f.dataDir, "agenda.sqlite"));
  hub.exec("CREATE TRIGGER synthetic_trigger AFTER INSERT ON schedules BEGIN SELECT 1; END;"); hub.close();
  assert.throws(() => capture(f, { output: join(f.out, "b.dxg8") }), code("unsupported_schema"));
  assert.ok(capture(f, { output: join(f.out, "no-agenda.dxg8"), include: { context: true, agenda: false, deviceRegistry: false, deviceSurface: false } }));
  const ctx = new DatabaseSync(join(f.dataDir, "context.sqlite"));
  ctx.exec("UPDATE meta SET value = 'own_someone_else' WHERE key = 'owner'"); ctx.close();
  assert.throws(() => capture(f, { output: join(f.out, "b.dxg8"), include: { context: true, agenda: false, deviceRegistry: false, deviceSurface: false } }), code("identity_mismatch"));
  assert.deepEqual(entries(f.out), ["no-agenda.dxg8", "snapshot.dxg8"], "failed captures publish nothing and leave no staging");
});

test("capture refuses unsafe outputs and quotas, and interruption leaves no partial artifact", (t) => {
  const f = seed(t);
  writeFileSync(join(f.out, "taken.dxg8"), "keep");
  assert.throws(() => capture(f, { output: join(f.out, "taken.dxg8") }), code("destination_exists"));
  assert.equal(readFileSync(join(f.out, "taken.dxg8"), "utf8"), "keep");
  assert.throws(() => capture(f, { output: "relative.dxg8" }), code("unsafe_path"));
  assert.throws(() => capture(f, { output: `${f.out}/../out/x.dxg8` }), code("unsafe_path"));
  symlinkSync(f.out, join(f.root, "out-link"));
  assert.throws(() => capture(f, { output: join(f.root, "out-link", "x.dxg8") }), code("unsafe_path"));
  assert.throws(() => capture(f, { limits: { maxDatabaseBytes: 4096 } }), code("quota_exceeded"));
  assert.throws(() => capture(f, { limits: { maxMembers: 3 } }), code("quota_exceeded"));
  assert.throws(() => capture(f, { limits: { maxDatabaseBytes: Number.MAX_SAFE_INTEGER } }), code("invalid_input"));
  for (const stop of ["fenced", "context_copied", "agenda_copied", "released", "sanitized", "sealed"] as const) {
    assert.throws(() => capture(f, { onStage: (stage) => { if (stage === stop) throw new Error(`synthetic crash at ${stop}`); } }), /synthetic crash/);
    assert.deepEqual(entries(f.out), ["taken.dxg8"], `no artifact or staging survives a crash at ${stop}`);
  }
  // The writer survived every interrupted capture and still owns the installation.
  f.store.appendMessage(f.threadId, { clientMessageId: "after-crash", content: "synthetic still writable" });
  assert.throws(() => new HostStore({ dataDir: f.dataDir }), hostCode("host_locked"));
});

// ---- restore -------------------------------------------------------------------------------------------

test("restore authenticates, validates and promotes a quarantined, non-executing inspection copy", (t) => {
  const f = seed(t);
  const key = fixtureKey();
  const receipt = capture(f, { key });
  const fetchCalls: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: unknown[]) => { fetchCalls.push(args); throw new Error("network forbidden"); }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const destination = join(f.root, "inspect");
  const restored = restoreForInspection({ artifact: receipt.path, key, destination, expect: { ownerId: f.store.ownerId, installationId: f.store.hostId } });
  assert.equal(fetchCalls.length, 0);
  assert.ok(key.lends >= 2, "key is lent per operation, never retained");
  assert.equal(restored.state, "quarantined_inspection");
  assert.equal(restored.activatable, false);
  assert.deepEqual(restored.counts, receipt.counts);
  assert.equal(restored.artifactSha256, receipt.sha256);

  // Layout cannot be mistaken for a dataDir: no canonical file name anywhere.
  const all = walk(destination).map((path) => path.slice(destination.length + 1));
  for (const canonical of ["dexter.sqlite", "context.sqlite", "agenda.sqlite", "context-revisions"]) assert.ok(!all.some((p) => p.split("/").includes(canonical)));
  assert.deepEqual(entries(destination), [QUARANTINE_FILE, INSPECTION_DIR]);
  const quarantine = JSON.parse(readFileSync(join(destination, QUARANTINE_FILE), "utf8"));
  assert.equal(quarantine.activatable, false);
  assert.equal(quarantine.authority.transfer, "unavailable");
  assert.equal(JSON.stringify(quarantine).includes(f.leaseToken), false);

  const hub = join(destination, INSPECTION_DIR, INSPECTION_FILES.hub);
  const hubBytes = readFileSync(hub);
  assert.equal(hubBytes.includes(f.leaseToken), false, "lease token bytes are gone, not just the row");
  assert.equal(hubBytes.includes(f.nativeCursor), false, "native cursor bytes are gone");
  assert.equal(rows(hub, "SELECT COUNT(*) AS n FROM host_lease")[0]?.n, 0);
  assert.deepEqual(rows(hub, "SELECT content FROM messages ORDER BY cursor").map((r) => r.content),
    ["synthetic hello one", "synthetic hello two", "synthetic turn one", "synthetic turn two", "synthetic latest in wal"]);
  assert.equal(rows(hub, "SELECT state FROM actions WHERE id = ?", f.awaitingActionId)[0]?.state, "awaiting_approval");
  assert.deepEqual(rows(hub, "SELECT state, reason FROM actions WHERE id = ?", f.runningActionId)[0], { state: "unknown", reason: "host_interrupted" });
  assert.deepEqual(rows(hub, "SELECT state, code FROM turns WHERE id = ?", f.runningTurnId)[0], { state: "unknown", code: "host_interrupted" });
  assert.equal(rows(hub, "SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL")[0]?.n, 0);
  assert.equal(rows(hub, "SELECT COUNT(*) AS n FROM grants WHERE expires_at IS NULL OR expires_at > ?", receipt.capturedAt)[0]?.n, 0);
  assert.equal(rows(hub, "SELECT COUNT(*) AS n FROM thread_sessions WHERE native_cursor IS NOT NULL")[0]?.n, 0);

  // Context: two artifact commits, history, hashes and fork reference, readable by git without trusting source config.
  const context = join(destination, INSPECTION_DIR, INSPECTION_FILES.context);
  const revisions = rows(context, "SELECT revision, hash, git_commit, path FROM revisions WHERE artifact_id = ? ORDER BY revision", f.artifactId);
  assert.equal(revisions.length, 2);
  assert.notEqual(revisions[0]!.git_commit, revisions[1]!.git_commit);
  assert.deepEqual(rows(context, "SELECT fork_id, fork_revision FROM artifacts WHERE id = ?", f.forkId)[0], { fork_id: f.artifactId, fork_revision: 1 });
  const gitDir = join(destination, INSPECTION_DIR, INSPECTION_GIT_DIR);
  const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const revision of revisions) {
    const blob = execFileSync("git", ["-c", "core.hooksPath=/dev/null", "--git-dir", gitDir, "show", `${revision.git_commit}:${revision.path}`], { env: gitEnv });
    assert.equal(createHash("sha256").update(blob).digest("hex"), revision.hash);
  }
  assert.equal(execFileSync("git", ["--git-dir", gitDir, "rev-list", "--count", "master"], { env: gitEnv, encoding: "utf8" }).trim(), "5", "artifact r1, r2, fork, skill and memory commits");

  // Agenda: prepared intent stays prepared and undispatched; no turn exists for its request id.
  const agenda = join(destination, INSPECTION_DIR, INSPECTION_FILES.agenda);
  assert.deepEqual(rows(agenda, "SELECT state, attempts, turn_id FROM occurrences")[0], { state: "prepared", attempts: 0, turn_id: null });
  assert.equal(rows(hub, "SELECT COUNT(*) AS n FROM turns WHERE client_request_id = ?", f.occurrenceRequestId)[0]?.n, 0);

  // Source is untouched and still the only writer; authority transfer is a typed, side-effect-free refusal.
  const transfer = requestAuthorityTransfer(restored);
  assert.equal(transfer.status, "unavailable");
  assert.deepEqual([...transfer.missing], ["authority_epoch_checkpoint", "persisted_source_revocation", "owner_activation_receipt"]);
  assert.equal(f.store.getAction(f.runningActionId).state, "running");
  assert.equal(f.store.listMessages(f.threadId).length, 5);
  assert.throws(() => new HostStore({ dataDir: f.dataDir }), hostCode("host_locked"));
  assert.deepEqual(f.agenda.listOccurrences().items.map((item) => item.state), ["prepared"]);

  // A repeated restore never overwrites an existing inspection copy.
  const before = readFileSync(join(destination, QUARANTINE_FILE));
  assert.throws(() => restoreForInspection({ artifact: receipt.path, key, destination }), code("destination_exists"));
  assert.deepEqual(readFileSync(join(destination, QUARANTINE_FILE)), before);
  assert.ok(restoreForInspection({ artifact: receipt.path, key, destination: join(f.root, "inspect-2") }));
});

test("wrong key, wrong key id and any header/body/tag tampering fail closed before plaintext is used", (t) => {
  const f = seed(t, { agenda: false });
  const receipt = capture(f);
  const original = readFileSync(receipt.path);
  const parentBefore = entries(f.root);
  const attempt = (bytes: Buffer, key: SnapshotKey = fixtureKey()): void => {
    const path = join(f.out, `case-${randomBytes(4).toString("hex")}.dxg8`);
    writeFileSync(path, bytes);
    try { restoreForInspection({ artifact: path, key, destination: join(f.root, "never") }); } finally { unlinkSync(path); }
  };
  assert.throws(() => restoreForInspection({ artifact: receipt.path, key: fixtureKey(8), destination: join(f.root, "never") }), code("authentication_failed"));
  assert.throws(() => restoreForInspection({ artifact: receipt.path, key: fixtureKey(7, "other-key"), destination: join(f.root, "never") }), code("authentication_failed"));
  const flip = (offset: number): Buffer => { const copy = Buffer.from(original); copy[offset] = copy[offset]! ^ 0x01; return copy; };
  const headerLength = original.readUInt16BE(8);
  assert.throws(() => attempt(flip(0)), code("corrupt"), "magic");
  assert.throws(() => attempt(flip(10 + headerLength - 3)), (e) => e instanceof OperationsError && ["corrupt", "authentication_failed"].includes(e.code), "header");
  assert.throws(() => attempt(flip(10 + headerLength + 1)), code("authentication_failed"), "nonce");
  assert.throws(() => attempt(flip(10 + headerLength + 12 + 100)), code("authentication_failed"), "ciphertext");
  assert.throws(() => attempt(flip(original.length - 1)), code("authentication_failed"), "tag");
  assert.throws(() => attempt(original.subarray(0, original.length - 1)), code("corrupt"), "truncated");
  assert.throws(() => attempt(Buffer.concat([original, Buffer.from([0])])), code("corrupt"), "trailing");
  assert.throws(() => attempt(Buffer.alloc(0)), code("corrupt"));
  // A swapped header claiming another purpose is rejected even if it parses.
  const header = JSON.parse(original.subarray(10, 10 + headerLength).toString());
  const swapped = Buffer.from(JSON.stringify({ ...header, purpose: "dexter.other" }).padEnd(headerLength, " "));
  assert.throws(() => attempt(Buffer.concat([original.subarray(0, 10), swapped, original.subarray(10 + headerLength)])), code("corrupt"));
  assert.throws(() => restoreForInspection({ artifact: receipt.path, key: { keyId: KEY_ID, use: (op) => op(createSecretKey(Buffer.alloc(16, 7))) }, destination: join(f.root, "never") }), code("invalid_input"));
  assert.deepEqual(entries(f.root), parentBefore, "no destination or staging was created");
  assert.ok(restoreForInspection({ artifact: receipt.path, key: fixtureKey(), destination: join(f.root, "ok") }));
});

test("authenticated but corrupt payloads fail validation with exact owned cleanup", (t) => {
  const f = seed(t);
  const receipt = capture(f);
  const scratch = join(f.root, "scratch"); mkdirSync(scratch);
  let n = 0;
  const reject = (expected: OperationsErrorCode, mutate: (decoded: Decoded) => Buffer | void, expect?: { ownerId?: string; installationId?: string }): void => {
    const path = join(f.out, `forged-${n += 1}.dxg8`);
    forge(receipt.path, path, mutate);
    const before = entries(f.root);
    assert.throws(() => restoreForInspection({ artifact: path, key: fixtureKey(), destination: join(f.root, "never"), ...(expect ? { expect } : {}) }), code(expected), `case ${n}`);
    assert.deepEqual(entries(f.root), before, `case ${n} leaves nothing behind`);
  };
  const hubName = "hub.sqlite";
  // Sanity: the forging helper itself produces a restorable artifact.
  forge(receipt.path, join(f.out, "identity.dxg8"), () => {});
  assert.ok(restoreForInspection({ artifact: join(f.out, "identity.dxg8"), key: fixtureKey(), destination: join(f.root, "forged-ok") }));

  // Byte corruption with a stale digest; with a recomputed digest SQLite integrity catches it.
  reject("corrupt", (d) => { const encoded = encode(d); const at = encoded.length - 20; encoded.writeUInt8(encoded.readUInt8(at) ^ 0xff, at); return encoded; });
  reject("corrupt", (d) => { const b = Buffer.from(d.members.get(hubName)!); b.fill(0x5a, 4096, 4200); d.members.set(hubName, b); });
  reject("corrupt", (d) => { d.members.set(hubName, d.members.get(hubName)!.subarray(0, 8192)); });
  // Schema / identity.
  reject("unsupported_schema", (d) => { d.members.set(hubName, mutateDatabase(d.members.get(hubName)!, scratch, "PRAGMA user_version = 5")); });
  reject("unsupported_schema", (d) => { d.members.set(hubName, mutateDatabase(d.members.get(hubName)!, scratch, "CREATE TABLE extra (x)")); });
  reject("unsupported_schema", (d) => { d.manifest.version = 3; });
  reject("identity_mismatch", (d) => { d.members.set("agenda.sqlite", mutateDatabase(d.members.get("agenda.sqlite")!, scratch, "UPDATE meta SET value = 'own_other' WHERE key = 'owner_id'")); });
  reject("identity_mismatch", () => {}, { ownerId: "own_someone_else" });
  reject("identity_mismatch", () => {}, { installationId: "host_someone_else" });
  // Sanitization invariants re-checked on restore.
  reject("corrupt", (d) => { d.members.set(hubName, mutateDatabase(d.members.get(hubName)!, scratch, "INSERT INTO host_lease VALUES (1, 'h', 1, 'tok', 1)")); });
  reject("corrupt", (d) => { d.members.set(hubName, mutateDatabase(d.members.get(hubName)!, scratch, "UPDATE actions SET state = 'running' WHERE state = 'unknown'")); });
  reject("corrupt", (d) => { d.members.set(hubName, mutateDatabase(d.members.get(hubName)!, scratch, "UPDATE devices SET revoked_at = NULL")); });
  reject("corrupt", (d) => { d.manifest.counts.hub.messages += 1; });
  // References: Context pins and Git history, Agenda to Hub.
  reject("reference_broken", (d) => { d.members.set("context.sqlite", mutateDatabase(d.members.get("context.sqlite")!, scratch, "UPDATE revisions SET hash = 'aa' || substr(hash, 3) WHERE revision = 2")); });
  reject("reference_broken", (d) => { d.members.set("context.sqlite", mutateDatabase(d.members.get("context.sqlite")!, scratch, "UPDATE artifacts SET fork_revision = 9 WHERE fork_id IS NOT NULL")); });
  reject("reference_broken", (d) => { d.members.set("context.sqlite", mutateDatabase(d.members.get("context.sqlite")!, scratch, "UPDATE artifacts SET bot_id = 'bot_missing'")); });
  reject("reference_broken", (d) => { d.members.set("agenda.sqlite", mutateDatabase(d.members.get("agenda.sqlite")!, scratch, "UPDATE schedules SET thread_id = 'thr_missing'")); });
  reject("reference_broken", (d) => {
    const pin = d.manifest.members.find((m: { name: string }) => m.name.startsWith("context-git/objects/"))!.name;
    d.members.delete(pin); d.manifest.counts.context.gitObjects -= 1;
    return encode(d, d.manifest.members.map((m: { name: string }) => m.name).filter((name: string) => name !== pin));
  });
  reject("reference_broken", (d) => { d.members.set("context-git/refs/heads/master", Buffer.from(`${"0".repeat(40)}\n`)); });
  // Member allowlist, traversal, duplicates and Context/Git pairing.
  reject("unsafe_path", (d) => { d.members.set("../escape", Buffer.from("x")); return encode(d, [...d.manifest.members.map((m: { name: string }) => m.name), "../escape"]); });
  reject("unsafe_path", (d) => { d.members.set("context-git/hooks/post-checkout", Buffer.from("#!/bin/sh")); return encode(d, [...d.manifest.members.map((m: { name: string }) => m.name), "context-git/hooks/post-checkout"]); });
  reject("unsafe_path", (d) => { d.members.set("dexter.sqlite", d.members.get(hubName)!); return encode(d, [...d.manifest.members.map((m: { name: string }) => m.name), "dexter.sqlite"]); });
  reject("unsafe_path", (d) => encode(d, [...d.manifest.members.map((m: { name: string }) => m.name), hubName]));
  reject("corrupt", (d) => encode(d, d.manifest.members.map((m: { name: string }) => m.name).filter((name: string) => name !== "context.sqlite")));
  reject("corrupt", (d) => { d.manifest.extra = true; });
  reject("corrupt", (d) => { const b = encode(d); return Buffer.concat([b, Buffer.from("trailing")]); });
});

test("restore refuses unsafe paths, quotas and interrupted staging without touching anything else", (t) => {
  const f = seed(t, { agenda: false });
  const receipt = capture(f);
  const key = fixtureKey();
  mkdirSync(join(f.root, "exists"));
  writeFileSync(join(f.root, "exists", "keep"), "keep");
  assert.throws(() => restoreForInspection({ artifact: receipt.path, key, destination: join(f.root, "exists") }), code("destination_exists"));
  assert.equal(readFileSync(join(f.root, "exists", "keep"), "utf8"), "keep");
  assert.throws(() => restoreForInspection({ artifact: receipt.path, key, destination: "relative" }), code("unsafe_path"));
  assert.throws(() => restoreForInspection({ artifact: receipt.path, key, destination: `${f.root}/./x` }), code("unsafe_path"));
  symlinkSync(f.root, join(f.out, "root-link"));
  assert.throws(() => restoreForInspection({ artifact: receipt.path, key, destination: join(f.out, "root-link", "x") }), code("unsafe_path"));
  symlinkSync(receipt.path, join(f.out, "artifact-link"));
  assert.throws(() => restoreForInspection({ artifact: join(f.out, "artifact-link"), key, destination: join(f.root, "x") }), code("unsafe_path"));
  assert.throws(() => restoreForInspection({ artifact: join(f.out, "missing"), key, destination: join(f.root, "x") }), code("unsafe_path"));
  assert.throws(() => restoreForInspection({ artifact: receipt.path, key, destination: join(f.root, "x"), limits: { maxArtifactBytes: 1024 } }), code("quota_exceeded"));
  assert.throws(() => restoreForInspection({ artifact: receipt.path, key, destination: join(f.root, "x"), limits: { maxMembers: 3 } }), code("quota_exceeded"));
  assert.throws(() => restoreForInspection({ artifact: receipt.path, key, destination: join(f.root, "x"), limits: { maxDatabaseBytes: 4096 } }), code("quota_exceeded"));
  assert.throws(() => restoreForInspection({ artifact: receipt.path, key, destination: join(f.root, "x"), limits: { bogus: 1 } as never }), code("invalid_input"));
  const before = entries(f.root);
  for (const stop of ["authenticated", "staged", "validated", "reserved"] as const) {
    assert.throws(() => restoreForInspection({ artifact: receipt.path, key, destination: join(f.root, "x"), onStage: (stage) => { if (stage === stop) throw new Error(`synthetic crash at ${stop}`); } }), /synthetic crash/);
    assert.deepEqual(entries(f.root), before, `crash at ${stop} leaves no destination or staging`);
  }
  // A destination created by someone else during staging is never replaced.
  assert.throws(() => restoreForInspection({ artifact: receipt.path, key, destination: join(f.root, "x"), onStage: (stage) => {
    if (stage === "validated") { mkdirSync(join(f.root, "x")); writeFileSync(join(f.root, "x", "theirs"), "theirs"); }
  } }), code("destination_exists"));
  assert.deepEqual(entries(join(f.root, "x")), ["theirs"]);
  rmSync(join(f.root, "x"), { recursive: true });
  // Cleanup removes only what restore created: a foreign file planted in its staging is preserved and reported.
  assert.throws(() => restoreForInspection({ artifact: receipt.path, key, destination: join(f.root, "x"), onStage: (stage) => {
    if (stage !== "staged") return;
    const staging = readdirSync(f.root).find((name) => name.startsWith(".x.restore-"))!;
    writeFileSync(join(f.root, staging, "foreign"), "foreign");
    throw new Error("synthetic crash");
  } }), code("cleanup_incomplete"));
  const leftover = readdirSync(f.root).filter((name) => name.startsWith(".x.restore-"));
  assert.equal(leftover.length, 1);
  assert.deepEqual(entries(join(f.root, leftover[0]!)), ["foreign"], "owned files removed, foreign file kept");
  assert.equal(existsSync(join(f.root, "x")), false);
  assert.ok(restoreForInspection({ artifact: receipt.path, key, destination: join(f.root, "x") }));
});

// ---- round 2 regressions: create-only publication, aggregate budgets, inode-owned cleanup ----------------------

type Patchable = "mkdirSync" | "linkSync" | "openSync" | "fsyncSync" | "readSync" | "renameSync";
/** Swaps one `node:fs` export (live ESM bindings included) for the duration of `run`; fixtures only. */
function withFs<K extends Patchable, T>(name: K, replacement: (original: (typeof fs)[K]) => (typeof fs)[K], run: () => T): T {
  const target = fs as unknown as Record<K, (typeof fs)[K]>;
  const original = target[name];
  target[name] = replacement(original);
  syncBuiltinESMExports();
  try { return run(); } finally { target[name] = original; syncBuiltinESMExports(); }
}
const causeCode = (error: unknown): unknown => error instanceof OperationsError && error.cause instanceof OperationsError ? error.cause.code : undefined;
function looseBlob(body: Buffer): [string, Buffer] {
  const raw = Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]);
  const id = createHash("sha1").update(raw).digest("hex");
  return [`context-git/objects/${id.slice(0, 2)}/${id.slice(2)}`, deflateSync(raw)];
}
function orphanBlobs(count: number, size: number): Array<[string, Buffer]> {
  return Array.from({ length: count }, (_, index) => { const body = Buffer.alloc(size, 65 + (index % 26)); body.writeUInt32BE(index); return looseBlob(body); });
}
function withOrphans(d: Decoded, blobs: Array<[string, Buffer]>): Buffer {
  for (const [name, bytes] of blobs) d.members.set(name, bytes);
  d.manifest.counts.context.gitObjects += blobs.length;
  return encode(d, [...d.manifest.members.map((m: { name: string }) => m.name), ...blobs.map(([name]) => name)]);
}

test("restore publication is create-only: a destination that appears in any window is never replaced", (t) => {
  const f = seed(t, { agenda: false });
  const receipt = capture(f);
  const key = fixtureKey();
  const staging = (): string[] => readdirSync(f.root).filter((name) => name.includes(".restore-"));

  // Round-1 probe shape: an empty directory created at the destination when a rename targets it. No rename targets it now.
  const renamed: string[] = [];
  const a = join(f.root, "a");
  withFs("renameSync", (original) => (from, to) => { renamed.push(String(to)); if (to === a) mkdirSync(a); return original(from, to); },
    () => restoreForInspection({ artifact: receipt.path, key, destination: a }));
  assert.deepEqual(renamed, []);
  assert.ok(existsSync(join(a, QUARANTINE_FILE)));

  // The same race in the only remaining window: an empty directory appears just before the reservation.
  const b = join(f.root, "b");
  let racer = -1;
  assert.throws(() => withFs("mkdirSync", (original) => ((path: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
    if (path === b && racer < 0) { original(b); racer = statSync(b).ino; }
    return original(path, options);
  }) as typeof fs.mkdirSync, () => restoreForInspection({ artifact: receipt.path, key, destination: b })), code("destination_exists"));
  assert.equal(statSync(b).ino, racer, "the racing empty directory is the same inode");
  assert.deepEqual(entries(b), []);
  assert.deepEqual(staging(), []);

  // After validation, before publication.
  const c = join(f.root, "c");
  assert.throws(() => restoreForInspection({ artifact: receipt.path, key, destination: c, onStage: (stage) => { if (stage === "validated") mkdirSync(c); } }),
    code("destination_exists"));
  assert.deepEqual(entries(c), []);

  // After the reservation: a foreign entry inside the reserved directory is kept, nothing is published over it.
  const d = join(f.root, "d");
  assert.throws(() => restoreForInspection({ artifact: receipt.path, key, destination: d, onStage: (stage) => {
    if (stage === "reserved") { mkdirSync(join(d, INSPECTION_DIR)); writeFileSync(join(d, INSPECTION_DIR, "theirs"), "theirs"); }
  } }), (error) => code("cleanup_incomplete")(error) && causeCode(error) === "destination_exists");
  assert.deepEqual(entries(d), [INSPECTION_DIR], "no commit marker: an incomplete publication is recognisable");
  assert.deepEqual(entries(join(d, INSPECTION_DIR)), ["theirs"]);
  assert.deepEqual(staging(), []);

  // After the reservation: the reserved directory is swapped for a foreign one; nothing is created or removed in it.
  const e = join(f.root, "e");
  assert.throws(() => restoreForInspection({ artifact: receipt.path, key, destination: e, onStage: (stage) => {
    if (stage === "reserved") { renameSync(e, `${e}-moved`); mkdirSync(e); writeFileSync(join(e, "theirs"), "theirs"); }
  } }), (error) => code("cleanup_incomplete")(error) && causeCode(error) === "destination_exists");
  assert.deepEqual(entries(e), ["theirs"]);
  assert.deepEqual(entries(`${e}-moved`), []);
  assert.deepEqual(staging(), []);

  // A staged file replaced after validation is never published, and the replacement is not deleted.
  const g = join(f.root, "g");
  assert.throws(() => restoreForInspection({ artifact: receipt.path, key, destination: g, onStage: (stage) => {
    if (stage !== "validated") return;
    const hub = join(f.root, staging()[0]!, INSPECTION_DIR, INSPECTION_FILES.hub);
    unlinkSync(hub); writeFileSync(hub, "SYNTHETIC SWAPPED CONTENT", { flag: "wx" });
  } }), (error) => code("cleanup_incomplete")(error) && causeCode(error) === "corrupt");
  assert.equal(existsSync(g), false);
  assert.equal(readFileSync(join(f.root, staging()[0]!, INSPECTION_DIR, INSPECTION_FILES.hub), "utf8"), "SYNTHETIC SWAPPED CONTENT");

  assert.ok(restoreForInspection({ artifact: receipt.path, key, destination: join(f.root, "h") }));
});

test("publication syncs the reservation and every directory, and links the commit marker last", (t) => {
  const f = seed(t, { agenda: false });
  const events: string[] = [];
  const directories = new Map<number, string>();
  const traced = <T>(run: () => T): T => withFs("openSync", (open) => ((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = open(path, flags, mode);
    if (typeof flags === "number" && (flags & fs.constants.O_DIRECTORY) !== 0) directories.set(fd, String(path));
    return fd;
  }) as typeof fs.openSync, () => withFs("fsyncSync", (fsync) => (fd) => { events.push(`fsync:${directories.get(fd) ?? "file"}`); return fsync(fd); },
    () => withFs("linkSync", (link) => (from, to) => { events.push(`link:${String(to)}`); return link(from, to); },
      () => withFs("mkdirSync", (mkdir) => ((path: fs.PathLike, options?: fs.MakeDirectoryOptions) => { events.push(`mkdir:${String(path)}`); return mkdir(path, options); }) as typeof fs.mkdirSync,
        run))));

  const output = join(f.out, "traced.dxg8");
  const receipt = traced(() => capture(f, { output }));
  assert.ok(events.indexOf(`fsync:${f.out}`) > events.indexOf(`link:${output}`), "capture syncs the parent after linking the artifact");

  events.length = 0;
  const destination = join(f.root, "traced");
  traced(() => restoreForInspection({ artifact: receipt.path, key: fixtureKey(), destination }));
  const at = (event: string, from = 0): number => events.indexOf(event, from);
  const reserved = at(`mkdir:${destination}`);
  const parentSynced = at(`fsync:${f.root}`, reserved);
  assert.ok(reserved >= 0 && parentSynced > reserved, "reservation is synced in its parent first");
  const links = events.flatMap((event, index) => event.startsWith(`link:${destination}/`) ? [index] : []);
  const marker = at(`link:${join(destination, QUARANTINE_FILE)}`);
  assert.equal(links.length, walk(destination).filter((path) => lstatSync(path).isFile()).length);
  assert.ok(links.every((index) => index > parentSynced));
  assert.equal(marker, Math.max(...links), "the commit marker is the last link");
  const published = events.flatMap((event) => event.startsWith(`mkdir:${destination}`) ? [event.slice("mkdir:".length)] : []);
  assert.ok(published.length >= 4);
  for (const directory of published) {
    const synced = at(`fsync:${directory}`, reserved);
    assert.ok(synced > reserved && synced < marker, `${directory} is synced before the commit marker`);
  }
  assert.ok(at(`fsync:${destination}`, marker) > marker, "the destination is synced after the commit marker");
});

test("authenticated Git inflation is bounded in aggregate before allocation, orphans included", (t) => {
  const f = seed(t, { agenda: false });
  const receipt = capture(f);
  const key = fixtureKey();
  let n = 0;
  const forged = (blobs: Array<[string, Buffer]>): string => {
    const path = join(f.out, `inflate-${n += 1}.dxg8`);
    forge(receipt.path, path, (d) => withOrphans(d, blobs));
    return path;
  };
  const before = entries(f.root);

  // Round-1 probe: 128 orphan blobs of 256 KiB (32 MiB inflated) inside a ~300 KiB artifact under a 1 MiB quota.
  const probe = forged(orphanBlobs(128, 256 * 1024));
  assert.ok(statSync(probe).size < 1024 * 1024);
  assert.throws(() => restoreForInspection({ artifact: probe, key, destination: join(f.root, "never"),
    limits: { maxArtifactBytes: 1024 * 1024, maxGitInflatedObjectBytes: 256 * 1024 } }), code("quota_exceeded"));
  assert.throws(() => restoreForInspection({ artifact: probe, key, destination: join(f.root, "never"), limits: { maxGitInflatedBytes: 8 * 1024 * 1024 } }),
    code("quota_exceeded"));
  // Scaled up under default limits: nine 15 MiB orphans (135 MiB) in a small artifact exceed the 128 MiB aggregate.
  const scaled = forged(orphanBlobs(9, 15 * 1024 * 1024));
  assert.ok(statSync(scaled).size < 1024 * 1024);
  assert.throws(() => restoreForInspection({ artifact: scaled, key, destination: join(f.root, "never") }), code("quota_exceeded"));
  // History walks and pin lookups have their own budget.
  assert.throws(() => restoreForInspection({ artifact: receipt.path, key, destination: join(f.root, "never"), limits: { maxGitTraversalBytes: 64 } }),
    code("quota_exceeded"));
  assert.deepEqual(entries(f.root), before, "refusals leave nothing behind");

  // Orphan policy is unchanged within budget: orphans are verified against their names and carried over.
  const modest = orphanBlobs(4, 256 * 1024);
  const restored = restoreForInspection({ artifact: forged(modest), key, destination: join(f.root, "orphans") });
  assert.equal(restored.counts.context?.gitObjects, receipt.counts.context!.gitObjects + 4);
  for (const [name] of modest) assert.ok(existsSync(join(f.root, "orphans", INSPECTION_DIR, INSPECTION_GIT_DIR, name.slice("context-git/".length))));
  const tampered = forged([[modest[0]![0], deflateSync(Buffer.from("blob 4\0evil"))]]);
  assert.throws(() => restoreForInspection({ artifact: tampered, key, destination: join(f.root, "never") }), code("corrupt"));
});

test("capture admits every member against the artifact quota before reading it, framing included", (t) => {
  const f = seed(t);
  const clock = (): number => 1_700_000_000_000;
  const receipt = capture(f, { clock, output: join(f.out, "a.dxg8") });
  // Exact accounting: framing, manifest and envelope overhead are part of the quota, to the byte.
  assert.equal(capture(f, { clock, output: join(f.out, "b.dxg8"), limits: { maxArtifactBytes: receipt.bytes } }).bytes, receipt.bytes);
  assert.throws(() => capture(f, { clock, output: join(f.out, "c.dxg8"), limits: { maxArtifactBytes: receipt.bytes - 1 } }), code("quota_exceeded"));
  // A manifest restore would refuse is refused at capture instead of being published.
  assert.throws(() => capture(f, { clock, output: join(f.out, "c.dxg8"), limits: { maxManifestBytes: 512 } }), code("quota_exceeded"));

  // A quota below the Hub copy refuses before any staged byte is read into memory.
  const opened = new Map<number, string>();
  let stagedBytesRead = 0;
  assert.throws(() => withFs("openSync", (open) => ((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = open(path, flags, mode); opened.set(fd, String(path)); return fd;
  }) as typeof fs.openSync, () => withFs("readSync", (read) => ((fd: number, ...rest: unknown[]) => {
    const bytes = (read as (...args: unknown[]) => number)(fd, ...rest);
    if (opened.get(fd)?.includes(".c.dxg8.capture-")) stagedBytesRead += bytes;
    return bytes;
  }) as typeof fs.readSync, () => capture(f, { clock, output: join(f.out, "c.dxg8"), limits: { maxArtifactBytes: 32 * 1024 } }))), code("quota_exceeded"));
  assert.equal(stagedBytesRead, 0);
  assert.deepEqual(entries(f.out), ["a.dxg8", "b.dxg8"]);
});

test("cleanup removes only recorded inodes: foreign sidecars, symlinks and swapped directories survive", (t) => {
  const f = seed(t, { agenda: false });
  const stagingIn = (dir: string, marker: string): string => join(dir, readdirSync(dir).find((name) => name.includes(marker))!);
  const foreign = "SYNTHETIC FOREIGN CONTENT";

  // Round-1 probe: a foreign hub.sqlite-journal created exclusively after the copy, then an interruption.
  let journal = "";
  assert.throws(() => capture(f, { include: { context: false, agenda: false, deviceRegistry: false, deviceSurface: false }, output: join(f.out, "p.dxg8"), onStage: (stage) => {
    if (stage !== "hub_copied") return;
    journal = join(stagingIn(f.out, ".p.dxg8.capture-"), "hub.sqlite-journal");
    writeFileSync(journal, foreign, { flag: "wx" });
    throw new Error("synthetic interruption");
  } }), code("cleanup_incomplete"));
  assert.equal(readFileSync(journal, "utf8"), foreign);
  assert.deepEqual(readdirSync(dirname(journal)), ["hub.sqlite-journal"], "the owned copy is gone, the foreign sidecar is not");

  // Without an interruption SQLite never opens the staged copy next to it (it would roll a hot journal in and delete it).
  assert.throws(() => capture(f, { include: { context: false, agenda: false, deviceRegistry: false, deviceSurface: false }, output: join(f.out, "q.dxg8"), onStage: (stage) => {
    if (stage === "hub_copied") { journal = join(stagingIn(f.out, ".q.dxg8.capture-"), "hub.sqlite-journal"); writeFileSync(journal, foreign, { flag: "wx" }); }
  } }), (error) => code("cleanup_incomplete")(error) && causeCode(error) === "corrupt");
  assert.equal(readFileSync(journal, "utf8"), foreign);

  // A symlinked sidecar is neither followed nor removed; its target is untouched.
  const outside = join(f.root, "outside.txt");
  writeFileSync(outside, foreign);
  let link = "";
  assert.throws(() => capture(f, { include: { context: false, agenda: false, deviceRegistry: false, deviceSurface: false }, output: join(f.out, "r.dxg8"), onStage: (stage) => {
    if (stage === "hub_copied") { link = join(stagingIn(f.out, ".r.dxg8.capture-"), "hub.sqlite-wal"); symlinkSync(outside, link); }
  } }), code("cleanup_incomplete"));
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readFileSync(outside, "utf8"), foreign);

  // A staging directory swapped for a foreign empty one is not removed.
  let swapped = "";
  assert.throws(() => capture(f, { include: { context: false, agenda: false, deviceRegistry: false, deviceSurface: false }, output: join(f.out, "s.dxg8"), onStage: (stage) => {
    if (stage !== "hub_copied") return;
    swapped = stagingIn(f.out, ".s.dxg8.capture-");
    renameSync(swapped, `${swapped}-moved`); mkdirSync(swapped);
    throw new Error("synthetic interruption");
  } }), code("cleanup_incomplete"));
  assert.deepEqual(entries(swapped), []);
  assert.deepEqual(entries(`${swapped}-moved`), ["hub.sqlite"]);

  // Restore: a foreign sidecar next to a staged inspection copy is preserved and nothing is published.
  const receipt = capture(f, { include: { context: false, agenda: false, deviceRegistry: false, deviceSurface: false }, output: join(f.out, "ok.dxg8") });
  assert.throws(() => restoreForInspection({ artifact: receipt.path, key: fixtureKey(), destination: join(f.root, "never"), onStage: (stage) => {
    if (stage === "staged") { journal = join(stagingIn(f.root, ".never.restore-"), INSPECTION_DIR, `${INSPECTION_FILES.hub}-journal`); writeFileSync(journal, foreign, { flag: "wx" }); }
  } }), (error) => code("cleanup_incomplete")(error) && causeCode(error) === "corrupt");
  assert.equal(readFileSync(journal, "utf8"), foreign);
  assert.equal(existsSync(join(f.root, "never")), false);
  assert.deepEqual(entries(f.out).filter((name) => !name.startsWith(".")), ["ok.dxg8"], "no failed capture published an artifact");

  // The source was only read: it is still the single writer and accepts writes.
  f.store.appendMessage(f.threadId, { clientMessageId: "after-cleanup", content: "synthetic still writable" });
  assert.throws(() => new HostStore({ dataDir: f.dataDir }), hostCode("host_locked"));
});
