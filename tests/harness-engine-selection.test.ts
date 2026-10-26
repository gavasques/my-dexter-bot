import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import type { EngineId } from "@dexter/contracts";
import { EngineError, type EngineDriver } from "@dexter/engines";
import { HostError, type HostStore } from "@dexter/hub";
import { HostServices } from "../packages/cli/src/host-services.js";
import { planHostStartup } from "../packages/cli/src/host-startup.js";
import { WorkspaceDriver, type WorkspaceNativeOptions } from "../packages/cli/src/workspace-driver.js";

// Synthetic temp executables and fixture drivers only: no real engine binary, auth, inference, network or account files.
const CLI = resolve("packages/cli/dist/index.js");
const invalid = (message?: string) => (error: unknown) => error instanceof HostError && error.code === "invalid_input"
  && (message === undefined || error.message === message);
const dirOf = (t: TestContext) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dexter-engine-selection-"))); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
};
const script = (path: string, body = "exit 0", mode = 0o700) => { writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode }); chmodSync(path, mode); return path; };
function fixtures(t: TestContext) {
  const calls: { engine: EngineId; options: WorkspaceNativeOptions }[] = [];
  const cursors: (string | undefined)[] = [];
  const makeDriver = (engine: EngineId, options: WorkspaceNativeOptions): EngineDriver => {
    calls.push({ engine, options });
    return { id: engine, capabilities: { resume: true, interrupt: true, fork: false, steer: false },
      async status() { return { engine, installed: true, version: "fixture", authentication: "authenticated", billing: "subscription" }; },
      async open(threadId, cursor) { cursors.push(cursor); return { threadId, nativeCursor: cursor ?? "fixture-cursor" }; },
      async *turn(session, turnId) { yield { type: "turn.completed", threadId: session.threadId, turnId, usage: {} }; },
      async respondToTool() {}, async interrupt() {}, async close() {} };
  };
  return { dir: dirOf(t), calls, cursors, makeDriver };
}

test("engine commands are refused before any store work: off, shape, accessor/proxy and path checks", (t) => {
  const dir = dirOf(t), data = join(dir, "host"), exe = script(join(dir, "engine"));
  let traps = 0, getters = 0;
  const proxy = new Proxy({ claude: exe }, { get() { traps++; return exe; }, ownKeys() { traps++; return ["claude"]; },
    getOwnPropertyDescriptor() { traps++; return undefined; }, getPrototypeOf() { traps++; return Object.prototype; } });
  const accessor = Object.defineProperty({}, "claude", { enumerable: true, get() { getters++; return exe; } });
  mkdirSync(join(dir, "folder"));
  const plain = script(join(dir, "plain"), "exit 0", 0o600);
  const cases: [string, unknown][] = [
    ["empty", {}], ["unknown key", { gemini: exe }], ["array", [exe]], ["proxy", proxy], ["accessor", accessor],
    ["symbol", { [Symbol("claude")]: exe }], ["function", { claude: () => exe }], ["relative", { claude: "bin/claude" }],
    ["noncanonical", { claude: `${dir}/./engine` }], ["nul", { claude: `${exe}\0` }], ["control", { claude: `${exe}\n` }],
    ["oversize", { claude: `/${"a".repeat(2048)}` }], ["not executable", { claude: plain }], ["directory", { claude: join(dir, "folder") }],
    ["missing", { codex: join(dir, "absent") }], ["non-enumerable", Object.defineProperty({}, "claude", { value: exe })],
  ];
  for (const [name, engineCommands] of cases) {
    assert.throws(() => planHostStartup({ route: "production", options: { dataDir: data, enableEngines: true, engineCommands: engineCommands as never } }),
      invalid(), name);
    assert.throws(() => new HostServices({ dataDir: data, enableEngines: true, engineCommands: engineCommands as never }), invalid(), `direct ${name}`);
  }
  // Paths never arm engines (plan and direct HostServices injection alike).
  for (const enableEngines of [undefined, false]) {
    assert.throws(() => planHostStartup({ route: "production", options: { dataDir: data, ...(enableEngines === false ? { enableEngines } : {}), engineCommands: { claude: exe } } }),
      invalid("Engine commands require enabled engines."));
    assert.throws(() => new HostServices({ dataDir: data, ...(enableEngines === false ? { enableEngines } : {}), engineCommands: { claude: exe } }),
      invalid("Engine commands require enabled engines."));
  }
  assert.equal(traps, 0); assert.equal(getters, 0);
  assert.equal(existsSync(data), false, "no data directory, store or writer was created");
});

for (const engine of ["claude", "codex"] as const) {
  test(`${engine}-only selection registers only that driver with the resolved command; the other ends no_driver`, { timeout: 15_000 }, async (t) => {
    const { dir, calls, cursors, makeDriver } = fixtures(t);
    const other: EngineId = engine === "claude" ? "codex" : "claude";
    const target = script(join(dir, `${engine}-target`)), decoy = script(join(dir, "decoy"));
    const link = join(dir, `${engine}-link`); symlinkSync(target, link);
    const source: Record<string, string> = { [engine]: link };
    const plan = planHostStartup({ route: "laboratory", options: { dataDir: join(dir, "host"), enableEngines: true, enableMcp: true, engineCommands: source }, makeDriver });
    source[engine] = decoy; source[other] = decoy; // caller mutation after planning changes neither path nor subset
    const services = plan.open();
    t.after(() => services.shutdown({ graceMs: 2_000 }));
    const runtime = services.runtime!;
    assert.deepEqual(runtime.status().engines, [engine]);

    const bot = services.store.createBot({ name: "Selected", profileId: "personal", engine });
    const thread = services.store.createThread(bot.id);
    for (const id of ["first", "second"]) {
      const { turn } = runtime.startTurn(thread.id, { clientRequestId: id, content: "synthetic" });
      { const d = await runtime.waitForTurn(turn.id); assert.deepEqual([d.state, d.code], ["completed", null]); }
    }
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.engine, engine);
      assert.equal(call.options.command, target, "symlink resolved once at plan time to the regular executable");
      assert.equal(call.options.cwd, join(dir, "host", "workspaces", bot.id, thread.id));
      assert.ok(call.options.localMcpServer, "per-turn native MCP lease preserved beside the command");
    }
    assert.deepEqual(cursors, [undefined, "fixture-cursor"], "native cursor resume unchanged");

    const otherBot = services.store.createBot({ name: "Unselected", profileId: "personal", engine: other });
    const { turn } = runtime.startTurn(services.store.createThread(otherBot.id).id, { clientRequestId: "other", content: "synthetic" });
    const done = await runtime.waitForTurn(turn.id);
    assert.deepEqual([done.state, done.code], ["failed", "no_driver"]);
    assert.equal(calls.length, 2, "no fallback or remapping to the selected engine");
  });
}

test("native drivers spawn the selected absolute command for status, never a PATH homonym; legacy keeps PATH lookup", { timeout: 20_000 }, async (t) => {
  const dir = dirOf(t), log = join(dir, "log"), bin = join(dir, "bin"); mkdirSync(bin);
  const selected = script(join(dir, "selected"), `printf 'selected %s\\n' "$1" >> '${log}'\necho 9.9.9`);
  for (const name of ["claude", "codex"]) script(join(bin, name), `printf 'homonym %s\\n' "$1" >> '${log}'\necho 1.2.3`);
  const store = {} as HostStore; // status() never touches the store
  const path = process.env["PATH"];
  process.env["PATH"] = `${bin}:${path ?? ""}`;
  try {
    for (const engine of ["claude", "codex"] as const) {
      writeFileSync(log, "");
      const status = await new WorkspaceDriver(engine, store, dir, { command: selected }).status();
      assert.deepEqual([status.installed, status.version], [true, "9.9.9"], engine);
      const lines = readFileSync(log, "utf8");
      assert.match(lines, /^selected --version$/m); assert.doesNotMatch(lines, /homonym/);
      writeFileSync(log, "");
      assert.equal((await new WorkspaceDriver(engine, store, dir).status()).version, "1.2.3", `${engine} legacy PATH name`);
      assert.doesNotMatch(readFileSync(log, "utf8"), /selected/);
    }
  } finally { if (path === undefined) delete process.env["PATH"]; else process.env["PATH"] = path; }
  assert.throws(() => new WorkspaceDriver("claude", store, dir, { command: "claude" }), (error: unknown) => error instanceof EngineError);
});

test("legacy enable registers both engines without commands; makeDriver stays laboratory-only; CLI flags are serve-only", async (t) => {
  const { dir, calls, makeDriver } = fixtures(t);
  const services = new HostServices({ dataDir: join(dir, "legacy"), enableEngines: true, makeDriver });
  t.after(() => services.shutdown({ graceMs: 2_000 }));
  assert.deepEqual(services.runtime!.status().engines, ["claude", "codex"]);
  const bot = services.store.createBot({ name: "Legacy", profileId: "personal", engine: "codex" });
  const { turn } = services.runtime!.startTurn(services.store.createThread(bot.id).id, { clientRequestId: "legacy", content: "synthetic" });
  assert.equal((await services.runtime!.waitForTurn(turn.id)).state, "completed");
  assert.equal(calls[0]!.options.command, undefined);

  const exe = script(join(dir, "engine"));
  assert.throws(() => planHostStartup({ route: "production", options: { dataDir: join(dir, "prod"), enableEngines: true, engineCommands: { claude: exe } }, makeDriver }),
    invalid("Synthetic drivers are laboratory-only."));

  const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 10_000,
    env: { PATH: "/usr/bin:/bin", HOME: dir } });
  for (const command of ["contracts", "help", "doctor"]) {
    const result = run([command, "--data-dir", join(dir, "cli"), "--claude-command", exe]);
    assert.equal(result.status, 1, command); assert.equal(result.stdout, "");
    assert.equal(result.stderr, "invalid_input: Engine command options apply to dexter serve only.\n");
  }
  const serve = run(["serve", "--data-dir", join(dir, "cli"), "--port", "0", "--codex-command", exe]);
  assert.equal(serve.status, 1); assert.equal(serve.stderr, "invalid_input: Engine commands require enabled engines.\n");
  const empty = run(["serve", "--data-dir", join(dir, "cli"), "--port", "0", "--enable-engines", "--claude-command", ""]);
  assert.equal(empty.status, 1); assert.match(empty.stderr, /^invalid_input: Engine command must be an absolute path/);
  assert.equal(existsSync(join(dir, "cli")), false);
});
