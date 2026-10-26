import { randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { DeviceError } from "../../errors.js";
import { privateDirectory, privateFile } from "../../files.js";
import { HandlerRefusal } from "../../handlers.js";

const BOT_KEY = /^[0-9a-f]{32}$/;
const MAX_GENERATION = Number.MAX_SAFE_INTEGER;

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Exclusive hold of one bot's profile directory. `generation` increases on every acquisition. */
export interface ProfileLease {
  readonly botKey: string;
  readonly profileDir: string;
  readonly homeDir: string;
  readonly generation: number;
  readonly token: string;
  release(): void;
}

/**
 * Per-bot browser profiles under the daemon's private directory:
 *
 *   <root>/profiles/<botKey>/   user-data-dir given to the browser (0700)
 *   <root>/home/<botKey>/       HOME of the browser process (0700)
 *   <root>/locks/<botKey>.lock  {pid, token}, created with O_EXCL; a dead holder's lock is reclaimed
 *   <root>/state/<botKey>.json  {generation}, written atomically before the lease is returned
 *
 * Directory names are a hash of host/owner/bot, never the bot id. Nothing here returns profile contents,
 * cookies or paths to a caller. This separates bots' browser state for Dexter's routes; it is not an OS
 * boundary between personal bots of the same owner.
 */
export class BrowserProfileStore {
  readonly #root: string;
  constructor(root: string) {
    this.#root = root;
    privateDirectory(root);
    for (const sub of ["profiles", "home", "locks", "state"]) privateDirectory(join(root, sub));
  }

  toJSON(): object { return { kind: "browser-profiles" }; }
  [inspect.custom](): object { return this.toJSON(); }

  acquire(botKey: string): ProfileLease {
    if (!BOT_KEY.test(botKey)) throw new DeviceError("invalid_input", "invalid bot key");
    const lockPath = join(this.#root, "locks", `${botKey}.lock`);
    const token = randomBytes(16).toString("hex");
    this.lock(lockPath, token);
    try {
      const profileDir = join(this.#root, "profiles", botKey);
      const homeDir = join(this.#root, "home", botKey);
      privateDirectory(profileDir);
      privateDirectory(homeDir);
      const generation = this.bumpGeneration(botKey);
      let released = false;
      return Object.freeze({
        botKey, profileDir, homeDir, generation, token,
        release: () => {
          if (released) return;
          released = true;
          this.unlock(lockPath, token);
        },
      });
    } catch (error) {
      this.unlock(lockPath, token);
      throw error;
    }
  }

  /** Last generation handed out for the bot (0 when the profile was never used). */
  generationOf(botKey: string): number {
    if (!BOT_KEY.test(botKey)) throw new DeviceError("invalid_input", "invalid bot key");
    const path = join(this.#root, "state", `${botKey}.json`);
    try { lstatSync(path); } catch { return 0; }
    privateFile(path);
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { generation?: unknown };
      if (typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 0) throw new Error("bad");
      return value.generation;
    } catch { throw new DeviceError("invalid_input", "profile state unreadable"); }
  }

  private bumpGeneration(botKey: string): number {
    const current = this.generationOf(botKey);
    if (current >= MAX_GENERATION) throw new DeviceError("conflict", "generation exhausted");
    const next = current + 1;
    const path = join(this.#root, "state", `${botKey}.json`);
    const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, JSON.stringify({ generation: next })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    return next;
  }

  private lock(path: string, token: string): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      let fd: number;
      try {
        fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new DeviceError("unavailable", "profile lock unavailable");
        const holder = this.readLock(path);
        if (holder !== null && pidAlive(holder.pid)) throw new HandlerRefusal("profile_busy");
        // A dead holder (crash) leaves its lock behind; reclaim it once. A symlink or foreign file is refused.
        try { unlinkSync(path); } catch { throw new DeviceError("unavailable", "profile lock unavailable"); }
        continue;
      }
      try { writeSync(fd, JSON.stringify({ pid: process.pid, token })); fsyncSync(fd); } finally { closeSync(fd); }
      return;
    }
    throw new HandlerRefusal("profile_busy");
  }
  private readLock(path: string): { pid: number; token: string } | null {
    privateFile(path);
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; token?: unknown };
      if (typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.token === "string") {
        return { pid: value.pid, token: value.token };
      }
    } catch { /* torn write by a crashed holder */ }
    return null;
  }
  private unlock(path: string, token: string): void {
    try {
      if (this.readLock(path)?.token === token) unlinkSync(path);
    } catch { /* already gone */ }
  }
}
