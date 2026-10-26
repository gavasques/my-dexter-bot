import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, lstatSync, realpathSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { entry, rejectSymlink } from "./filesystem.js";
import { ContextError } from "./types.js";
export function sha256(content: string): string { return createHash("sha256").update(content).digest("hex"); }
/** Called only inside ContextHost's synchronous writer fence. No hooks, signing, network or global git configuration. */
export class ContextRepository {
  constructor(readonly root: string) {
    rejectSymlink(root);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.checkStorage(true);
    this.git(["init", "--quiet", "--initial-branch=master"]);
  }
  private checkStorage(allowMissingGit = false): void {
    const root = rejectSymlink(this.root);
    if (!root?.isDirectory()) throw new ContextError("tampered");
    const walk = (path: string): void => {
      const stat = rejectSymlink(path);
      if (!stat?.isDirectory()) return;
      let names: string[];
      try { names = readdirSync(path); }
      catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          // Git maintenance can remove a transient directory after lstat. Recheck
          // so a dangling symlink replacing it is still rejected, then skip the
          // vanished enumeration. Other errors must remain fail closed and safe.
          rejectSymlink(path);
          return;
        }
        throw new ContextError("tampered");
      }
      for (const name of names) walk(join(path, name));
    };
    const gitDir = rejectSymlink(join(this.root, ".git"));
    if (!gitDir && !allowMissingGit) throw new ContextError("tampered");
    if (gitDir && !gitDir.isDirectory()) throw new ContextError("tampered");
    if (gitDir) walk(join(this.root, ".git"));
  }
  private git(args: string[], trim = true): string {
    this.checkStorage(args[0] === "init");
    try { const result = execFileSync("git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "maintenance.autoDetach=false", "-c", "gc.autoDetach=false", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "core.fsync=all", "-c", "user.name=Dexter Context", "-c", "user.email=context@dexter.invalid", "-C", this.root, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }); return trim ? result.trim() : result; }
    catch { throw new ContextError("conflict", "context git operation failed"); }
  }
  private file(path: string, create = false): string {
    if (!/^(skills|artifacts|memory)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.md$/.test(path)) throw new ContextError("invalid_input");
    this.checkStorage();
    const parent = dirname(join(this.root, path));
    const family = dirname(parent);
    if (create) {
      for (const directory of [family, parent]) {
        const stat = rejectSymlink(directory);
        if (!stat) mkdirSync(directory, { mode: 0o700 });
        else if (!stat.isDirectory()) throw new ContextError("tampered");
      }
    } else {
      for (const directory of [family, parent]) if (!rejectSymlink(directory)?.isDirectory()) throw new ContextError("tampered");
    }
    if (!realpathSync(parent).startsWith(realpathSync(this.root) + "/")) throw new ContextError("tampered");
    return join(this.root, path);
  }
  write(path: string, markdown: string): { path: string; sha256: string; commit: string } {
    const file = this.file(path, true);
    // Never overwrite an existing index entry, including an orphan staged by another operation.
    if (this.git(["ls-files", "--stage", "--", path])) throw new ContextError("conflict");
    try { writeFileSync(file, markdown, { flag: "wx", mode: 0o600, flush: true }); }
    catch { throw new ContextError("conflict", "context revision write failed"); }
    const created = lstatSync(file);
    try {
      this.git(["add", "--", path]);
      this.git(["commit", "--quiet", "--only", "-m", "Record context revision", "--", path]);
    } catch (error) {
      // Only clean our new, demonstrably uncommitted file. A successful Git commit followed by
      // metadata rollback is retained. If the commit probe fails, preserve rather than guess.
      try {
        if (!this.git(["log", "--all", "--format=%H", "--", path])) {
          try { this.git(["rm", "--cached", "--force", "--ignore-unmatch", "--", path]); } catch { /* index may remain locked */ }
          const current = entry(file);
          if (current && !current.isSymbolicLink() && current.dev === created.dev && current.ino === created.ino) unlinkSync(file);
        }
      } catch { /* unknown Git state: no destructive cleanup */ }
      throw error;
    }
    return { path, sha256: sha256(markdown), commit: this.git(["rev-parse", "HEAD"]) };
  }
  read(pin: { path: string; sha256: string; commit: string }): string {
    try {
      const file = this.file(pin.path);
      if (lstatSync(file).isSymbolicLink() || !/^[0-9a-f]{40,64}$/.test(pin.commit)) throw new ContextError("tampered");
      const markdown = readFileSync(file, "utf8");
      if (sha256(markdown) !== pin.sha256 || sha256(this.git(["show", `${pin.commit}:${pin.path}`], false)) !== pin.sha256) throw new ContextError("tampered");
      return markdown;
    } catch { throw new ContextError("tampered"); }
  }
}
