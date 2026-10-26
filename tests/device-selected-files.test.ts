import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { SelectedFilesCapability } from "../packages/devices/src/capabilities/files/capability.js";
import { SelectedFilesPolicy, type SelectedFilesPolicyConfig } from "../packages/devices/src/capabilities/files/policy.js";
import { FILE_APPEND, FILE_READ, operationFor } from "@dexter/devices";
import { HandlerRefusal, type TrustedJobContext } from "../packages/devices/src/handlers.js";

const context = (tool: string, botId = "synthetic-bot", signal = new AbortController().signal) => ({ signal, job: {
  hostId: "synthetic-installation", ownerId: "synthetic-owner", deviceId: "synthetic-device", botId,
  threadId: "synthetic-thread", actionId: "synthetic-action", requestHash: "0".repeat(64), tool, deadlineAt: Date.now() + 30000,
} satisfies TrustedJobContext });
const refused = (code?: string) => (e: unknown) => e instanceof HandlerRefusal && (!code || e.code === code);

test("selected files: explicit aliases, no-create and identity gates; cancellation, policy fence and close drain before append", async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dexter-selected-files-"))); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "selected.txt"), policyPath = join(dir, "files-policy.json");
  writeFileSync(target, "synthetic text\n", { mode: 0o600 });
  const identity = lstatSync(target, { bigint: true });
  const config: SelectedFilesPolicyConfig = { version: 1, installationId: "synthetic-installation", bots: [{ botId: "synthetic-bot", files: [{
    name: "notes", path: target, operations: [FILE_READ, FILE_APPEND], identity: { device: identity.dev.toString(), inode: identity.ino.toString() }, fence: "a".repeat(32),
  }] }] };
  const persist = () => writeFileSync(policyPath, JSON.stringify(config), { mode: 0o600 }); persist();
  const load = () => SelectedFilesPolicy.load(policyPath, "synthetic-installation");
  const caps = new SelectedFilesCapability({ policy: load() });
  const read = caps.handlers().get(FILE_READ)!, append = caps.handlers().get(FILE_APPEND)!;
  // These published old validators/hash inputs remain untouched; alias arguments are exactly name/line.
  const oldReadHash = operationFor(FILE_READ).schemaHash, oldAppendHash = operationFor(FILE_APPEND).schemaHash;
  const result = await read({ name: "notes" }, context(FILE_READ));
  assert.equal((result as Record<string, unknown>).text, "synthetic text\n");
  assert.equal((result as Record<string, unknown>).trust, "untrusted_external");
  assert.equal(JSON.stringify(result).includes(target), false);
  await assert.rejects(read({ name: "unknown" }, context(FILE_READ)), refused("file_not_granted"));
  await assert.rejects(read({ name: "notes" }, context(FILE_READ, "other-bot")), refused("file_not_granted"));
  await assert.rejects(read({ name: target }, context(FILE_READ)), refused());
  assert.deepEqual(await append({ name: "notes", line: "added" }, context(FILE_APPEND)), { name: "notes", appendedBytes: 6 });
  assert.equal(readFileSync(target, "utf8"), "synthetic text\nadded\n");
  // A hard link or symlink is never followed, even when a selected inode originally matched.
  const hard = join(dir, "hard"); linkSync(target, hard);
  await assert.rejects(read({ name: "notes" }, context(FILE_READ)), refused("file_identity_changed")); unlinkSync(hard);
  const backup = join(dir, "backup"); renameSync(target, backup); symlinkSync(backup, target);
  await assert.rejects(append({ name: "notes", line: "no" }, context(FILE_APPEND)), refused());
  assert.equal(readFileSync(backup, "utf8"), "synthetic text\nadded\n"); unlinkSync(target);
  await assert.rejects(append({ name: "notes", line: "no" }, context(FILE_APPEND)), refused()); assert.equal(existsSync(target), false);
  renameSync(backup, target);
  const symlinkParent = join(dir, "parent-link"); symlinkSync(dir, symlinkParent);
  const invalid = structuredClone(config); invalid.bots[0]!.files[0]!.path = join(symlinkParent, "selected.txt");
  writeFileSync(policyPath, JSON.stringify(invalid)); assert.throws(load); persist();
  const directoryConfig = structuredClone(config), folder = join(dir, "folder"); mkdirSync(folder, { mode: 0o700 });
  const folderStat = lstatSync(folder, { bigint: true }); directoryConfig.bots[0]!.files[0]!.path = folder;
  directoryConfig.bots[0]!.files[0]!.identity = { device: folderStat.dev.toString(), inode: folderStat.ino.toString() };
  writeFileSync(policyPath, JSON.stringify(directoryConfig));
  const folderCaps = new SelectedFilesCapability({ policy: load() });
  await assert.rejects(folderCaps.handlers().get(FILE_READ)!({ name: "notes" }, context(FILE_READ)), refused()); await folderCaps.close(); persist();
  // Each test seam holds the call after fd validation. No authority changes after the effect are retried.
  for (const mode of ["cancel", "drift", "fence", "close"] as const) {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const controller = new AbortController(), policy = load();
    const current = new SelectedFilesCapability({ policy, beforeEffect: async () => { entered(); await gate; } });
    const before = readFileSync(target);
    const pending = current.handlers().get(FILE_APPEND)!({ name: "notes", line: "must-not-append" }, context(FILE_APPEND, "synthetic-bot", controller.signal));
    await started; let closing: Promise<void> | null = null;
    if (mode === "cancel") controller.abort();
    if (mode === "drift") writeFileSync(target, "external synthetic edit\n");
    if (mode === "fence") { const changed = structuredClone(config); changed.bots[0]!.files[0]!.fence = "b".repeat(32); writeFileSync(policyPath, JSON.stringify(changed)); }
    if (mode === "close") { let drained = false; closing = current.close().then(() => { drained = true; }); await Promise.resolve(); assert.equal(drained, false); }
    const expected = readFileSync(target); release(); await assert.rejects(pending, refused()); assert.deepEqual(readFileSync(target), expected);
    if (closing) await closing; else await current.close();
    if (mode === "drift") writeFileSync(target, before);
    if (mode === "fence") { persist(); assert.equal(policy.current(), false, "observed revocation remains quarantined"); }
  }
  const binary = Buffer.from([0xff, 0]); writeFileSync(target, binary);
  await assert.rejects(read({ name: "notes" }, context(FILE_READ)), refused());
  assert.equal(operationFor(FILE_READ).schemaHash, oldReadHash); assert.equal(operationFor(FILE_APPEND).schemaHash, oldAppendHash);
  await caps.close();
});
