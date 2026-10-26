import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import { test, type TestContext } from "node:test";

const EXPECTED_PUBLIC_SCHEMA_EXPORTS = [
  "action",
  "automationCalendar",
  "automationCreate",
  "automationHistory",
  "automationList",
  "automationPreview",
  "automationRun",
  "automationState",
  "automationUpdate",
  "avatarImage",
  "bot",
  "botApprovalPolicy",
  "botApprovalPolicyReceipt",
  "botCommunicationConfirmation",
  "botCommunicationConfirmationResult",
  "botCommunicationPatch",
  "botCommunicationReceipt",
  "botDelegation",
  "botExecutionAccess",
  "botExecutionAccessReceipt",
  "browserUseBotPolicy",
  "browserUseSettings",
  "createGroup",
  "createGroupConversation",
  "createTeam",
  "device",
  "deviceView",
  "engineSelection",
  "event",
  "grant",
  "groupDispatchMutation",
  "groupList",
  "groupPost",
  "groupRead",
  "groupToolCreate",
  "groupToolUpdate",
  "imageAttachment",
  "liveVoiceContext",
  "liveVoiceSettings",
  "liveVoiceTranscript",
  "liveVoiceTranscriptReceipt",
  "message",
  "patchBot",
  "patchBrowserUseSettings",
  "patchLiveVoiceSettings",
  "patchTeam",
  "reconcileUncertainty",
  "registerSkill",
  "renameDevice",
  "sendGroupMessage",
  "setBotApprovalPolicy",
  "setBotExecutionAccess",
  "setSkillActivation",
  "skillActivation",
  "skillLock",
  "startTurn",
  "team",
  "teamThread",
  "thread",
  "threadEngineSelection",
  "turn",
  "turnEvent",
  "updateGroup",
  "uploadAvatarImage",
  "uploadImageAttachment",
];

const CLI = resolve("packages/cli/dist/index.js");
function command(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 10_000 });
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    child.once("exit", () => { clearTimeout(timer); resolveStop(); });
    child.kill("SIGTERM");
  });
}
async function start(dataDir: string, ...options: string[]): Promise<{ child: ChildProcess; url: string; ready: Record<string, unknown> }> {
  const child = spawn(process.execPath, [CLI, "serve", "--port", "0", "--data-dir", dataDir, ...options], { stdio: ["ignore", "pipe", "pipe"] });
  let ready: Record<string, unknown> = {};
  try {
    const url = await new Promise<string>((resolveReady, reject) => {
      let stdout = "";
      const timer = setTimeout(() => reject(new Error("Host did not become ready.")), 8_000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      child.once("error", fail);
      child.once("exit", () => fail(new Error("Host exited before readiness.")));
      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
        try {
          const record = JSON.parse(stdout) as { status: string; url: string };
          if (record.status === "ready") { ready = record; clearTimeout(timer); resolveReady(record.url); }
        } catch { /* JSON startup record can span chunks. */ }
      });
    });
    return { child, url, ready };
  } catch (error) { await stop(child); throw error; }
}

test("doctor is read-only and contracts export needs no initialized host", () => {
  const dir = mkdtempSync(join(tmpdir(), "dexter-cli-empty-"));
  const absent = join(dir, "not-created");
  try {
    const diagnosis = command("doctor", "--data-dir", absent);
    assert.equal(diagnosis.status, 0);
    assert.equal(JSON.parse(diagnosis.stdout).status, "not_initialized");
    assert.equal(existsSync(absent), false);
    const contracts = command("contracts");
    assert.equal(contracts.status, 0);
    assert.deepEqual(Object.keys(JSON.parse(contracts.stdout).schemas).sort(), EXPECTED_PUBLIC_SCHEMA_EXPORTS);
    assert.equal(command("serve", "--port", "invalid", "--data-dir", absent).status, 1);
    assert.equal(existsSync(absent), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI composes opt-in MCP and doctor selects the canonical database alongside its gateway", { timeout: 20_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dexter-cli-mcp-"));
  const children: ChildProcess[] = [];
  t.after(async () => { for (const child of children) await stop(child); rmSync(dir, { recursive: true, force: true }); });
  const invalid = join(dir, "invalid");
  assert.equal(command("serve", "--data-dir", invalid, "--enable-mcp").status, 1);
  assert.equal(existsSync(invalid), false);
  const host = await start(dir, "--enable-engines", "--enable-mcp");
  children.push(host.child);
  assert.equal(host.ready.engineExecution, "enabled");
  assert.equal(host.ready.mcpGateway, "enabled");
  assert.equal(host.ready.upstreamApps, "unconfigured");
  assert.equal(existsSync(join(dir, "gateway.sqlite")), true);
  const health = await fetch(`${host.url}/health`);
  assert.equal(health.status, 200);
  const result = command("doctor", "--data-dir", dir);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).status, "initialized");
  await stop(host.child);
  const restarted = await start(dir, "--enable-engines", "--enable-mcp");
  children.push(restarted.child);
  assert.equal((await fetch(`${restarted.url}/health`)).status, 200);
});

test("actual loopback listener survives restart and doctor reads alongside its writer", { timeout: 25_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dexter-cli-live-"));
  const children: ChildProcess[] = [];
  t.after(async () => { for (const child of children) await stop(child); rmSync(dir, { recursive: true, force: true }); });
  const first = await start(dir);
  children.push(first.child);
  const health = await (await fetch(`${first.url}/health`)).json() as { hostId: string };
  const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const botResponse = await fetch(`${first.url}/v1/bots`, post({ name: "General", profileId: "personal", engine: "codex" }));
  assert.equal(botResponse.status, 201);
  const bot = await botResponse.json() as { id: string };
  const thread = await (await fetch(`${first.url}/v1/bots/${bot.id}/threads`, post({}))).json() as { id: string };
  assert.equal((await fetch(`${first.url}/v1/threads/${thread.id}/messages`, post({ clientMessageId: "msg-1", content: "Persistent message" }))).status, 201);
  const doctor = command("doctor", "--data-dir", dir);
  assert.equal(doctor.status, 0);
  assert.equal(JSON.parse(doctor.stdout).counts.messages, 1);
  await stop(first.child);
  const second = await start(dir);
  children.push(second.child);
  const restored = await (await fetch(`${second.url}/health`)).json() as { hostId: string };
  assert.equal(restored.hostId, health.hostId);
  const messages = await (await fetch(`${second.url}/v1/threads/${thread.id}/messages`)).json() as { items: { content: string }[] };
  assert.equal(messages.items[0]?.content, "Persistent message");
  const forgedHostStatus = await new Promise<number>((resolveStatus, reject) => {
    const req = request(`${second.url}/health`, { headers: { Host: "rebind.example" } }, (response) => {
      response.resume();
      resolveStatus(response.statusCode ?? 0);
    });
    req.on("error", reject);
    req.setTimeout(5_000, () => req.destroy(new Error("Request timed out.")));
    req.end();
  });
  assert.equal(forgedHostStatus, 403);
});

test("CLI context is explicit, isolated and unverified at startup without contacting a backend", { timeout: 15_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "dexter-cli-context-")); const absent = join(dir, "absent");
  const children: ChildProcess[] = [];
  t.after(async () => { for (const child of children) await stop(child); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(command("serve", "--data-dir", absent, "--ai-memory-lab").status, 1);
  assert.equal(command("serve", "--data-dir", absent, "--enable-engines", "--enable-mcp",
    "--ai-memory-origin", "http://127.0.0.1:1", "--ai-memory-lab").status, 1);
  assert.equal(existsSync(absent), false);
  const host = await start(dir, "--enable-engines", "--enable-mcp", "--ai-memory-origin", "http://127.0.0.1:1",
    "--ai-memory-lab", "--ai-memory-owner-exclusive"); children.push(host.child);
  assert.equal(host.ready.context, "enabled"); assert.equal(host.ready.memoryIndex, "unverified");
  assert.equal(host.ready.upstreamApps, "unconfigured");
  for (const name of ["context.sqlite", "ai-memory-outbox.sqlite", "gateway.sqlite"]) assert.equal(existsSync(join(dir, name)), true);
  assert.equal((await fetch(`${host.url}/health`)).status, 200);
  assert.equal(command("doctor", "--data-dir", dir).status, 0);
});

test("bad ai-memory origins create no canonical files and report a typed configuration error", () => {
  const dir = mkdtempSync(join(tmpdir(), "dexter-cli-memory-origin-")); const absent = join(dir, "absent");
  try {
    for (const [origin, lab] of [["not-a-url", true], ["http://10.0.0.5:9", true], ["http://example.com", true],
      ["http://127.0.0.1:1/x", true], ["http://example.com", false], ["https://h.example/path", false]] as const) {
      const result = spawnSync(process.execPath, [CLI, "serve", "--data-dir", absent, "--enable-engines", "--enable-mcp",
        "--ai-memory-owner-exclusive", "--ai-memory-origin", origin, ...(lab ? ["--ai-memory-lab"] : [])],
      { encoding: "utf8", timeout: 10_000, env: { ...process.env, DEXTER_AI_MEMORY_USER_KEY: "aim_synthetic_configuration_fixture" } });
      assert.equal(result.status, 1); assert.match(result.stderr, /^invalid_input: Invalid ai-memory origin or authentication mode\./);
      assert.equal(existsSync(absent), false); assert.equal(result.stderr.includes("aim_synthetic"), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** Every entry under `root` with type, size and content hash, sidecars included: byte-level before/after evidence. */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (path: string, rel: string) => {
    const s = lstatSync(path);
    out.push(`${rel}|${s.isDirectory() ? "d" : s.isFile() ? "f" : s.isSymbolicLink() ? "l" : "o"}|${s.size}|${s.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : ""}`);
    if (s.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name), `${rel}/${name}`);
  };
  walk(root, ".");
  return out;
}
/** A separate synthetic process commits one row into the WAL with autocheckpoint off and is SIGKILLed: a genuine committed WAL+SHM pair. */
async function orphanWal(t: TestContext, data: string): Promise<void> {
  mkdirSync(data, { mode: 0o700 });
  const script = `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1] + "/dexter.sqlite");
db.exec("CREATE TABLE bots (id INTEGER PRIMARY KEY, name TEXT); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 64) INSERT INTO bots (name) SELECT printf('%0500d', i) FROM n;");
db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; INSERT INTO bots (name) VALUES ('wal-only');");
process.stdout.write("committed\\n"); setInterval(() => {}, 10_000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, data], { stdio: ["ignore", "pipe", "inherit"],
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: tmpdir(), TMPDIR: tmpdir() } });
  const exited = new Promise(resolveExit => child.once("exit", resolveExit));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await new Promise<void>((done, fail) => { child.stdout?.once("data", () => done()); child.once("error", fail); void exited.then(() => fail(new Error("exited before commit"))); });
  child.kill("SIGKILL"); await exited;
  assert.ok(lstatSync(join(data, "dexter.sqlite-wal")).size > 0); assert.ok(lstatSync(join(data, "dexter.sqlite")).size >= 32_768);
}

test("doctor refuses a known-empty or truncated database before any SQLite read, so a committed WAL beside it survives", { timeout: 30_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "dexter-cli-doctor-main-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Positive: a complete main beside the genuine committed orphan pair is read (WAL-only row counted) without consuming it.
  const valid = join(dir, "valid"); await orphanWal(t, valid);
  const main = (data: string) => tree(data).filter(line => /^\.\/dexter\.sqlite(-wal)?\|/.test(line));
  const kept = main(valid), read = command("doctor", "--data-dir", valid);
  assert.equal(read.status, 0); assert.equal(JSON.parse(read.stdout).status, "initialized");
  assert.equal(JSON.parse(read.stdout).counts.bots, 65); assert.deepEqual(main(valid), kept);
  const layouts: [string, (data: string) => void][] = [];
  for (const [size, label] of [[0, "zero-byte"], [100, "short (<512)"], [1000, "off-512"]] as const) for (const shm of [true, false])
    layouts.push([`${label} main beside a committed ${shm ? "WAL/-shm pair" : "lone WAL"}`, data => {
      truncateSync(join(data, "dexter.sqlite"), size); if (!shm) unlinkSync(join(data, "dexter.sqlite-shm"));
    }]);
  layouts.push(["symlinked main (target untouched)", data => {
    unlinkSync(join(data, "dexter.sqlite")); symlinkSync(join(valid, "dexter.sqlite"), join(data, "dexter.sqlite"));
  }], ["directory in place of the main", data => { unlinkSync(join(data, "dexter.sqlite")); mkdirSync(join(data, "dexter.sqlite")); }]);
  for (const [index, [name, shape]] of layouts.entries()) {
    const data = join(dir, `case-${index}`); await orphanWal(t, data); shape(data);
    const before = tree(data), target = tree(valid);
    const result = command("doctor", "--data-dir", data);
    assert.equal(result.status, 1, name); assert.equal(result.stdout, "", name);
    assert.equal(result.stderr, "conflict: Canonical database is not a complete regular SQLite file; doctor did not open it.\n", name);
    assert.equal(result.stderr.includes(dir), false, name);
    assert.deepEqual(tree(data), before, name); assert.deepEqual(tree(valid), target, name);
  }
});
