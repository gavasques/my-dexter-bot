import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test, type TestContext } from "node:test";
import { ContextError, ContextHost, FixtureMemoryAdapter } from "@dexter/context";
import { HostStore } from "@dexter/hub";

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "dexter-context-maintenance-")); const store = new HostStore({ dataDir: dir });
  const context = new ContextHost(store, new FixtureMemoryAdapter([]));
  const bot = store.createBot({ name: "Synthetic maintenance fixture", profileId: "personal", engine: "claude" }); const thread = store.createThread(bot.id);
  const turn = store.createTurn(thread.id, { clientRequestId: "fixture", content: "synthetic" }).turn; store.claimNextTurn(thread.id); const token = context.issue(turn.id);
  t.after(() => { mock.restoreAll(); syncBuiltinESMExports(); context.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, context, token, git: join(context.repositoryPath, ".git") };
}
// Node builtin binding replacement is confined to this test process and always restored.
function replaceReaddir(fn: (path: fs.PathLike, options?: any) => any) { mock.method(fs, "readdirSync", fn); syncBuiltinESMExports(); }
const restore = () => { mock.restoreAll(); syncBuiltinESMExports(); };

test("a Git directory removed between lstat and readdir does not orphan a revision or burn a skill version", t => {
  const f = setup(t); const transient = join(f.git, "objects", "transient-fixture"); mkdirSync(transient); const original = fs.readdirSync; let removed = 0;
  replaceReaddir((path, options) => { if (String(path) === transient) { rmSync(transient, { recursive: true }); removed++; } return original(path, options); });
  try { const skill = f.context.registerSkill("maintenance", "1.0.0", "# Safe skill"); f.context.activateSkill({ kind: "global" }, skill); assert.equal(f.context.skills(f.token)[0]?.markdown, "# Safe skill"); assert.equal(removed, 1); }
  finally { restore(); }
});

test("an entry removed after directory enumeration is safe while dangling symlinks remain rejected", t => {
  const f = setup(t); const transient = join(f.git, "objects", "transient-fixture"); mkdirSync(transient); const original = fs.readdirSync; let removed = 0;
  replaceReaddir((path, options) => { const names = original(path, options); if (String(path) === join(f.git, "objects") && existsSync(transient)) { rmSync(transient, { recursive: true }); removed++; } return names; });
  try { const artifact = f.context.createArtifact(f.token, "# Survived lstat race", "fixture"); assert.equal(f.context.artifact(f.token, artifact.id).markdown, artifact.markdown); assert.equal(removed, 1); }
  finally { restore(); }
  symlinkSync(join(f.context.repositoryPath, "nonexistent-outside"), transient);
  assert.throws(() => f.context.registerSkill("reject-link", "1.0.0", "# Fail closed"), error => error instanceof ContextError && error.code === "tampered");
});

test("readdir permission errors use fixed ContextError and ENOENT cannot hide a replacement symlink", t => {
  const f = setup(t); const objectDir = join(f.git, "objects"); const original = fs.readdirSync;
  const sensitive = "synthetic-private-diagnostic";
  replaceReaddir((path, options) => { if (String(path) === objectDir) throw Object.assign(new Error(sensitive), { code: "EACCES" }); return original(path, options); });
  try { assert.throws(() => f.context.registerSkill("permission", "1.0.0", "# Fail closed"), error => error instanceof ContextError && error.code === "tampered" && error.message === "tampered" && !error.message.includes(sensitive)); }
  finally { restore(); }
  const transient = join(objectDir, "transient-fixture"); mkdirSync(transient);
  replaceReaddir((path, options) => { if (String(path) === transient) { rmSync(transient, { recursive: true }); symlinkSync(join(f.context.repositoryPath, "missing-target"), transient); throw Object.assign(new Error(sensitive), { code: "ENOENT" }); } return original(path, options); });
  try { assert.throws(() => f.context.registerSkill("replacement", "1.0.0", "# Fail closed"), error => error instanceof ContextError && error.code === "tampered" && error.message === "tampered"); }
  finally { restore(); }
});

test("bounded real Git revision loop overrides local auto-maintenance per command and preserves unrelated staging", t => {
  const f = setup(t); const original = childProcess.execFileSync;
  const git = (...args: string[]) => original("git", ["-c", "core.hooksPath=/dev/null", "-C", f.context.repositoryPath, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
  f.store.withWriterLease(() => { git("config", "maintenance.auto", "true"); git("config", "gc.auto", "1"); git("config", "maintenance.autoDetach", "true"); git("config", "gc.autoDetach", "true"); writeFileSync(join(f.context.repositoryPath, "unrelated.md"), "# Unrelated staged data"); git("add", "--", "unrelated.md"); });
  const configBefore = readFileSync(join(f.git, "config")); const indexBefore = git("show", ":unrelated.md"); let gitCalls = 0;
  mock.method(childProcess, "execFileSync", (command: string, args: readonly string[], options: any) => {
    if (command === "git") { gitCalls++; for (const setting of ["maintenance.auto=false", "gc.auto=0", "maintenance.autoDetach=false", "gc.autoDetach=false"]) { const index = args.indexOf(setting); assert.ok(index > 0 && args[index - 1] === "-c", `missing per-command ${setting}`); } }
    return original(command, args, options);
  }); syncBuiltinESMExports();
  try {
    const first = f.context.createArtifact(f.token, "# Revision 1", "fixture");
    for (let revision = 2; revision <= 40; revision++) { const result = f.context.reviseArtifact(f.token, first.id, revision - 1, `# Revision ${revision}`, "fixture"); assert.equal(result.revision, revision); }
    assert.equal(f.context.artifactHistory(f.token, first.id).length, 40);
    assert.equal(f.context.artifact(f.token, first.id).markdown, "# Revision 40");
    assert.ok(gitCalls >= 120);
  } finally { restore(); }
  assert.deepEqual(readFileSync(join(f.git, "config")), configBefore); assert.equal(git("show", ":unrelated.md"), indexBefore); assert.equal(git("diff", "--cached", "--name-only"), "unrelated.md");
  assert.equal(existsSync(join(f.git, "gc.log")), false); assert.equal(existsSync(join(f.git, "gc.pid")), false);
});
