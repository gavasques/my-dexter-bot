import { randomBytes } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmdirSync, unlinkSync,
  writeFileSync, type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { OperationsError, fail } from "./errors.js";

export function entry(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw new OperationsError("unsafe_path", "path is unavailable", { cause: error });
  }
}

function canonical(path: string): string {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024 || path.includes("\0") || !isAbsolute(path) || resolve(path) !== path) {
    fail("unsafe_path", "path must be absolute and normalized");
  }
  return path;
}

const exists = (error: unknown): boolean => !!error && typeof error === "object" && "code" in error && error.code === "EEXIST";

/** An absent path whose parent is an existing directory reached without any symlink component. */
export function absentTarget(path: string): { parent: string; name: string } {
  const target = canonical(path);
  const parent = dirname(target);
  let real: string;
  try { real = realpathSync(parent); } catch (error) { throw new OperationsError("unsafe_path", "parent directory is unavailable", { cause: error }); }
  if (real !== parent) fail("unsafe_path", "path must not traverse symlinks");
  if (!entry(parent)?.isDirectory()) fail("unsafe_path", "parent is not a directory");
  if (entry(target) !== undefined) fail("destination_exists", "destination already exists");
  return { parent, name: basename(target) };
}

/** An existing regular file reached without any symlink component, including the final one. */
export function existingFile(path: string): string {
  const target = canonical(path);
  const stat = entry(target);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) fail("unsafe_path", "path is not a regular file");
  let real: string;
  try { real = realpathSync(target); } catch (error) { throw new OperationsError("unsafe_path", "path is unavailable", { cause: error }); }
  if (real !== target) fail("unsafe_path", "path must not traverse symlinks");
  return target;
}

/**
 * Reads one regular, non-symlink file with an explicit byte bound, without following a swapped final link.
 * `admit` sees the size before any buffer is allocated, so an aggregate quota can refuse first.
 */
export function readBounded(path: string, maxBytes: number, admit?: (bytes: number) => void): Buffer {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { throw new OperationsError("unsafe_path", "file could not be opened safely", { cause: error }); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) fail("unsafe_path", "path is not a regular file");
    if (stat.size > maxBytes) fail("quota_exceeded", "file exceeds the size limit");
    admit?.(stat.size);
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) fail("corrupt", "file changed while being read");
      offset += read;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) fail("corrupt", "file changed while being read");
    return buffer;
  } finally {
    closeSync(fd);
  }
}

export function randomSuffix(): string { return randomBytes(9).toString("base64url"); }

export const SQLITE_SIDECARS = ["-journal", "-wal", "-shm"] as const;

/**
 * Refuses to let SQLite open a staged file while any sidecar exists next to it. A sidecar this operation did not
 * create is never ours: SQLite would treat a `-journal` as hot and roll it into (and then delete) our copy.
 */
export function noSidecars(path: string): void {
  for (const suffix of SQLITE_SIDECARS) if (entry(`${path}${suffix}`) !== undefined) fail("corrupt", "a SQLite sidecar exists next to a staged copy");
}

/**
 * Makes directory entries durable: `fsync(2)` on the directory itself. On macOS this orders the entry with the
 * filesystem journal but, like file `fsync`, does not issue `F_FULLFSYNC`; no power-loss test backs this.
 */
export function syncDirectory(path: string): void {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error) { throw new OperationsError("unsafe_path", "directory could not be opened for sync", { cause: error }); }
  try { fsyncSync(fd); }
  catch (error) { throw new OperationsError("unsafe_path", "directory could not be synced", { cause: error }); }
  finally { closeSync(fd); }
}

export interface OwnedEntry { readonly path: string; readonly dev: number; readonly ino: number; readonly directory: boolean }

/**
 * Records exactly the entries this operation created, by inode, so failure cleanup touches nothing else. Files are
 * unlinked and directories `rmdir`ed (never recursive) only while the path still names the recorded inode. Names
 * are never owned by pattern: an unknown entry, a swapped inode or a SQLite sidecar makes cleanup report
 * incomplete and stay in place. Same-uid processes that can write inside the 0700 staging are outside this model;
 * the check-then-unlink window is the residual of path-based POSIX calls without `unlinkat`.
 */
export class OwnedPaths {
  readonly #entries: OwnedEntry[] = [];

  #record(path: string, directory: boolean): OwnedEntry {
    const stat = entry(path);
    if (!stat || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail("unsafe_path", "owned entry is not what was created");
    const owned = { path, dev: stat.dev, ino: stat.ino, directory };
    this.#entries.push(owned);
    return owned;
  }

  /** Create-only: an existing entry of any kind (including an empty directory) is never adopted. */
  mkdir(path: string): string {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) {
      if (exists(error)) throw new OperationsError("destination_exists", "path already exists", { cause: error });
      throw new OperationsError("unsafe_path", "directory could not be created", { cause: error });
    }
    this.#record(path, true);
    return path;
  }
  write(path: string, bytes: Uint8Array): void {
    try { writeFileSync(path, bytes, { flag: "wx", mode: 0o600, flush: true }); }
    catch (error) { throw new OperationsError("unsafe_path", "staged file could not be written", { cause: error }); }
    this.#record(path, false);
  }
  /** Adopts a file this operation just created through another API (for example SQLite `VACUUM INTO`). */
  adopt(path: string): void { this.#record(path, false); }
  /**
   * Create-only hard link of `source` (an entry owned by another `OwnedPaths`) at `path`. `link(2)` never replaces an
   * existing name. The new name is owned by this call either way; the publication is refused unless it names
   * exactly the recorded source inode, so a staged file swapped after validation is never published.
   */
  link(source: OwnedEntry, path: string): void {
    try { linkSync(source.path, path); }
    catch (error) {
      if (exists(error)) throw new OperationsError("destination_exists", "path already exists", { cause: error });
      throw new OperationsError("unsafe_path", "entry could not be published", { cause: error });
    }
    const linked = this.#record(path, false);
    if (linked.dev !== source.dev || linked.ino !== source.ino) fail("corrupt", "staged entry changed before publication");
  }
  /** Still the recorded inode at the recorded path. */
  holds(owned: OwnedEntry): boolean {
    const stat = entry(owned.path);
    return !!stat && !stat.isSymbolicLink() && (owned.directory ? stat.isDirectory() : stat.isFile()) && stat.dev === owned.dev && stat.ino === owned.ino;
  }
  /** Recorded entries in creation order. */
  entries(): readonly OwnedEntry[] { return [...this.#entries]; }
  /** Drops tracking for an entry that was intentionally removed or handed over as part of success. */
  forget(path: string): void {
    for (let index = this.#entries.length - 1; index >= 0; index -= 1) if (this.#entries[index]!.path === path) this.#entries.splice(index, 1);
  }
  forgetAll(): void { this.#entries.length = 0; }

  cleanup(): boolean {
    let complete = true;
    for (const owned of [...this.#entries].reverse()) {
      const stat = entry(owned.path);
      if (!stat) continue;
      if (!this.holds(owned)) { complete = false; continue; }
      try { if (owned.directory) rmdirSync(owned.path); else unlinkSync(owned.path); } catch { complete = false; }
    }
    this.forgetAll();
    return complete;
  }
}

/** Runs `operation`; on failure removes only owned paths and preserves the original error as cause. */
export function withOwnedCleanup<T>(owned: OwnedPaths, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!owned.cleanup()) throw new OperationsError("cleanup_incomplete", "failed operation left owned staging behind", { cause: error });
    throw error;
  }
}

/**
 * Publishes a fully written (already flushed) temporary file under a new name with `link(2)`, which fails instead
 * of replacing an existing destination, makes the new name durable with a parent directory `fsync`, then removes
 * the temporary name. The published name stays owned (and is removed on failure) until it is durable.
 */
export function publishNoReplace(owned: OwnedPaths, temporary: string, destination: string): void {
  const source = owned.entries().find((item) => item.path === temporary && !item.directory);
  if (!source) return fail("unsafe_path", "temporary file is not owned");
  owned.link(source, destination);
  syncDirectory(dirname(destination));
  unlinkSync(temporary);
  owned.forget(temporary);
  owned.forget(destination);
}

/**
 * Create-only publication of a validated staging tree. Node exposes no `renameat2(RENAME_NOREPLACE)` or
 * `renamex_np(RENAME_EXCL)`, and POSIX `rename` replaces an empty directory, so the destination is never renamed
 * onto. Instead:
 *
 * 1. `mkdir(destination)` reserves the name atomically (EEXIST for anything already there, including an empty
 *    directory); the parent is synced.
 * 2. Every owned staged directory is re-created with `mkdir` and every owned staged file hard-linked with `link`,
 *    both create-only, each link checked against the recorded staged inode; the reserved directory's inode is
 *    re-checked before every step.
 * 3. Every published directory is synced deepest-first, then the commit marker is linked last and the destination
 *    synced. A destination without the marker is an incomplete publication, never a result.
 *
 * On failure only entries created here are removed, by inode; anything foreign is preserved and reported as
 * `cleanup_incomplete`. Staging names are left to the caller, which owns them.
 */
export function publishTreeNoReplace(
  staging: OwnedPaths, root: string, destination: string, marker: string, onReserved?: () => void,
): void {
  const published = new OwnedPaths();
  try {
    published.mkdir(destination);
    const reserved = published.entries()[0]!;
    syncDirectory(dirname(destination));
    onReserved?.();
    const held = (): void => { if (!published.holds(reserved)) fail("destination_exists", "reserved destination was replaced"); };
    const prefix = `${root}/`;
    const items = staging.entries().filter((item) => item.path.startsWith(prefix));
    const commit = items.find((item) => item.path === join(root, marker) && !item.directory);
    if (!commit) fail("unsafe_path", "staged commit marker is not owned");
    const directories = [destination];
    for (const item of items) {
      if (item === commit) continue;
      held();
      const target = join(destination, item.path.slice(prefix.length));
      if (item.directory) { published.mkdir(target); directories.push(target); } else published.link(item, target);
    }
    for (const directory of directories.reverse()) syncDirectory(directory);
    held();
    published.link(commit!, join(destination, marker));
    syncDirectory(destination);
    held();
  } catch (error) {
    if (!published.cleanup()) throw new OperationsError("cleanup_incomplete", "failed publication left entries behind", { cause: error });
    throw error;
  }
}
