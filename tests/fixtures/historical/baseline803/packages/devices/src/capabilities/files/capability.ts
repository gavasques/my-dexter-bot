import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeSync, type BigIntStats } from "node:fs";
import { TextDecoder } from "node:util";
import type { JsonValue } from "@dexter/contracts";
import { HandlerRefusal, type HandlerContext, type OperationHandler } from "../../handlers.js";
import { FILE_APPEND, FILE_READ, checkOperationArgs } from "../../operations.js";
import { OutcomeUncertain, requireJob } from "../context.js";
import { selectedFilePath, type SelectedFileGrant, type SelectedFilesPolicy } from "./policy.js";

export const SELECTED_FILE_READ_BYTES = 4096;
export const SELECTED_FILE_APPEND_BYTES = 64 * 1024;
export interface SelectedFilesCapabilityOptions {
  policy: SelectedFilesPolicy;
  clock?: () => number;
  /** Trusted test seam only, never JSON/engine input. */
  beforeEffect?: (tool: string) => Promise<void>;
}
function stable(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function inspect(path: string, stat: BigIntStats, grant: Readonly<SelectedFileGrant>): void {
  selectedFilePath(path);
  const named = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || named.isSymbolicLink() || !stable(stat, named)
    || stat.uid !== BigInt(process.getuid!()) || stat.dev.toString() !== grant.identity.device || stat.ino.toString() !== grant.identity.inode) {
    throw new HandlerRefusal("file_identity_changed");
  }
}
/** Each call owns one no-follow fd; close blocks admissions and drains calls before releasing authority. */
export class SelectedFilesCapability {
  #closed = false;
  #undrained = false;
  readonly #pending = new Set<Promise<JsonValue>>();
  readonly #clock: () => number;
  constructor(private readonly options: SelectedFilesCapabilityOptions) { this.#clock = options.clock ?? Date.now; }
  handlers(): Map<string, OperationHandler> {
    return new Map([FILE_READ, FILE_APPEND].map(tool => [tool, (args, context) => {
      if (this.#closed) return Promise.reject(new HandlerRefusal("files_closed"));
      const pending = this.run(tool, args, context); this.#pending.add(pending);
      void pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending)); return pending;
    }]));
  }
  async close(): Promise<void> {
    this.#closed = true; await Promise.allSettled([...this.#pending]);
    if (this.#undrained) throw new OutcomeUncertain("file_descriptor_undrained");
  }
  toJSON(): object { return { kind: "selected-files", closed: this.#closed }; }
  private async run(tool: string, args: Record<string, JsonValue>, context: HandlerContext): Promise<JsonValue> {
    const job = requireJob(context, tool);
    let input: Record<string, JsonValue>;
    try { input = checkOperationArgs(tool, args); } catch { throw new HandlerRefusal("invalid_file_arguments"); }
    const name = input.name as string;
    const grant = this.options.policy.authorize(job.botId, name, tool);
    let fd: number | null = null, effected = false;
    const release = (): void => {
      if (fd === null) return;
      const descriptor = fd; fd = null;
      try { closeSync(descriptor); } catch {
        // An ambiguous close must never retry a potentially reused descriptor or release authority.
        this.#closed = true; this.#undrained = true;
        throw new OutcomeUncertain("file_descriptor_undrained");
      }
    };
    const check = (): void => {
      if (this.#closed || context.signal.aborted || job.deadlineAt <= this.#clock()) throw new HandlerRefusal("file_cancelled");
      if (!this.options.policy.current()) throw new HandlerRefusal("file_policy_changed");
    };
    try {
      check(); selectedFilePath(grant.path);
      const named = lstatSync(grant.path, { bigint: true }); inspect(grant.path, named, grant);
      fd = openSync(grant.path, (tool === FILE_READ ? constants.O_RDONLY : constants.O_WRONLY | constants.O_APPEND) | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = fstatSync(fd, { bigint: true }); inspect(grant.path, before, grant);
      const data = tool === FILE_APPEND ? Buffer.from(`${input.line as string}\n`, "utf8") : null;
      if (before.size > BigInt(tool === FILE_READ ? SELECTED_FILE_READ_BYTES : SELECTED_FILE_APPEND_BYTES)
        || (data && before.size + BigInt(data.length) > BigInt(SELECTED_FILE_APPEND_BYTES))) throw new HandlerRefusal("file_too_large");
      if (this.options.beforeEffect) await this.options.beforeEffect(tool);
      // No await between authority/identity checks and fd effect; no create, truncate or caller path.
      check(); const final = fstatSync(fd, { bigint: true }); inspect(grant.path, final, grant);
      if (!stable(before, final)) throw new HandlerRefusal("file_changed");
      if (data) {
        effected = true;
        const written = writeSync(fd, data, 0, data.length);
        if (written !== data.length) throw new OutcomeUncertain("file_append_unconfirmed");
        fsyncSync(fd); check();
        const after = fstatSync(fd, { bigint: true }); inspect(grant.path, after, grant);
        if (after.size !== before.size + BigInt(data.length)) throw new OutcomeUncertain("file_append_unconfirmed");
        release();
        return { name, appendedBytes: data.length };
      }
      const bytes = Buffer.alloc(Number(before.size) + 1); let n = 0;
      while (n < bytes.length) { const got = readSync(fd, bytes, n, bytes.length - n, null); if (!got) break; n += got; }
      check(); const after = fstatSync(fd, { bigint: true }); inspect(grant.path, after, grant);
      if (n !== Number(before.size) || !stable(before, after)) throw new HandlerRefusal("file_changed");
      const content = bytes.subarray(0, n), text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new HandlerRefusal("file_not_text");
      return { name, bytes: n, sha256: createHash("sha256").update(content).digest("hex"), text,
        trust: "untrusted_external", source: "selected_file", truncated: false };
    } catch (error) {
      if (effected) throw new OutcomeUncertain("file_append_unconfirmed");
      if (error instanceof HandlerRefusal) throw error;
      throw new HandlerRefusal("selected_file_refused");
    } finally { release(); }
  }
}
