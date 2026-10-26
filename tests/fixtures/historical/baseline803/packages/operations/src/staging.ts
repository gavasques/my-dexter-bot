import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AuthorityCoordinator } from "./coordinator.js";
import { OperationsError, fail } from "./errors.js";
import { entry, syncDirectory } from "./files.js";

/** Upper bounds of one recovered staging tree: a checkpoint's members plus the Context repository directories. */
export const STAGING_RECOVERY_MAX_ENTRIES = 60_000;
export const STAGING_RECOVERY_MAX_DEPTH = 8;

export interface StagingRecoveryReport { stagingId: string; purpose: "capture" | "activation"; outcome: "removed" | "already_absent" | "already_removed"; entriesRemoved: number }

/**
 * Explicit operator recovery of ONE plaintext staging directory a crashed capture or activation left behind. Only a
 * staging the coordinator reserved is touched, and only when:
 * - its recorded process is gone (a live attempt, including this process, is refused);
 * - its parent is still the recorded real directory (no symlink) and the entry is a real, owner-only (0700)
 *   directory of this uid — never a symlink — whose inode is the recorded one (when the crash came before the
 *   inode was recorded, the reserved random name alone identifies it);
 * - the whole tree is plain files and directories within fixed entry/depth bounds. Anything else (symlink, socket,
 *   too many entries, a swapped inode) refuses before the first removal.
 * Files are unlinked and directories `rmdir`ed one by one, each re-checked against the inode collected for it; there
 * is no recursive or pattern delete. A removed staging is then recorded removed. The plaintext was only ever
 * protected by 0700 permissions; removal is not secure erasure.
 */
export function recoverStaging(coordinator: AuthorityCoordinator, stagingId: string, now: number): StagingRecoveryReport {
  const record = coordinator.staging(stagingId);
  const report = (outcome: StagingRecoveryReport["outcome"], entriesRemoved = 0): StagingRecoveryReport => ({ stagingId, purpose: record.purpose, outcome, entriesRemoved });
  if (record.state === "removed") return report("already_removed");
  const live = coordinator.openStagings().find((item) => item.stagingId === stagingId);
  if (record.pid === process.pid || live?.processAlive) fail("destination_exists", "the staging's attempt is still running");
  let parent: string;
  try { parent = realpathSync(record.parent); } catch (error) { throw new OperationsError("unsafe_path", "staging parent is unavailable", { cause: error }); }
  if (parent !== record.parent) fail("unsafe_path", "staging parent moved");
  const path = join(parent, record.name);
  const root = entry(path);
  if (!root) { coordinator.recordStagingRemoved(stagingId, now); return report("already_absent"); }
  const stat = lstatSync(path, { bigint: true });
  if (root.isSymbolicLink() || !root.isDirectory() || (root.mode & 0o077) !== 0 || root.uid !== process.getuid?.()) fail("unsafe_path", "staging is not a private directory");
  if (record.ino !== null && stat.ino.toString() !== record.ino) fail("identity_mismatch", "staging directory is not the reserved one");
  const items = collect(path);
  let removed = 0;
  for (const item of items) {
    const current = entry(item.path);
    if (!current || current.isSymbolicLink() || (item.directory ? !current.isDirectory() : !current.isFile()) || lstatSync(item.path, { bigint: true }).ino !== item.ino) {
      fail("cleanup_incomplete", "staging changed during recovery");
    }
    if (item.directory) rmdirSync(item.path); else unlinkSync(item.path);
    removed += 1;
  }
  syncDirectory(parent);
  if (entry(path)) fail("cleanup_incomplete", "staging was not fully removed");
  coordinator.recordStagingRemoved(stagingId, now);
  return report("removed", removed);
}

interface Collected { path: string; ino: bigint; directory: boolean }
/** Deepest-first list of the tree (root last), refused as a whole on any non-plain entry or bound. */
function collect(root: string): Collected[] {
  const out: Collected[] = [];
  const walk = (path: string, depth: number): void => {
    if (depth > STAGING_RECOVERY_MAX_DEPTH) fail("unsafe_path", "staging tree is too deep");
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const stat = lstatSync(child, { bigint: true });
      if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory())) fail("unsafe_path", "staging holds an entry it never creates");
      if (stat.isDirectory()) walk(child, depth + 1);
      out.push({ path: child, ino: stat.ino, directory: stat.isDirectory() });
      if (out.length > STAGING_RECOVERY_MAX_ENTRIES) fail("quota_exceeded", "staging tree exceeds the recovery bound");
    }
  };
  walk(root, 0);
  out.push({ path: root, ino: lstatSync(root, { bigint: true }).ino, directory: true });
  return out;
}
