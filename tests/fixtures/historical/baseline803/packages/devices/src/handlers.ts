import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type promises as fsPromises } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@dexter/contracts";
import { privateDirectory } from "./files.js";
import { FILE_APPEND, FILE_READ, PROCESS_PROBE } from "./operations.js";

/**
 * Thrown by a handler only before any effect happened (validation, missing file, size limit). The daemon
 * records it as a definitive `failed` receipt. Any other error after the journal start is `unknown`.
 */
export class HandlerRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HandlerRefusal";
  }
}
/**
 * Identity of the job being executed, derived by the daemon from the host job it authenticated (pinned
 * channel, its own binding, recomputed request hash). Handlers that scope state per bot read the bot from
 * here and never from `args`, which an engine may shape.
 */
export interface TrustedJobContext {
  readonly hostId: string;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly botId: string;
  readonly threadId: string;
  readonly actionId: string;
  readonly requestHash: string;
  readonly tool: string;
  readonly deadlineAt: number;
}
/** `job` is always set by the daemon; a handler that needs it refuses when it is absent. */
export interface HandlerContext { signal: AbortSignal; job?: TrustedJobContext }
export type OperationHandler = (args: Record<string, JsonValue>, context: HandlerContext) => Promise<JsonValue>;

export interface FixtureHandlerOptions {
  /** The single selected root. Must be a private directory chosen by the operator (tests use a temp dir). */
  root: string;
  /** Which operations to enable; nothing is granted implicitly. */
  enable: readonly string[];
  /** Test seam: awaited after validation and immediately before the effect. */
  beforeEffect?: (tool: string) => Promise<void>;
  probeTimeoutMs?: number;
}

const MAX_READ_BYTES = 16 * 1024;
const MAX_APPEND_FILE_BYTES = 64 * 1024;
const MAX_PROBE_OUTPUT = 4 * 1024;
/** Constant, read-only probe. No caller-chosen program, argument, shell or environment. */
export const PROBE_SCRIPT = "process.stdout.write(JSON.stringify({probe:'dexter-synthetic',platform:process.platform,arch:process.arch,node:process.versions.node}))";

/**
 * Lab handlers for the declared operations: one selected root for files (names only, no paths, no symlink
 * follow) and one constant `process.execPath -e` probe. They are not a sandbox: personal bots share the
 * owner's OS authority by product decision, and these handlers only limit what the Dexter route exposes.
 */
export function createFixtureHandlers(options: FixtureHandlerOptions): Map<string, OperationHandler> {
  const root = options.root;
  privateDirectory(root, false);
  const beforeEffect = options.beforeEffect ?? (async () => {});
  const probeTimeoutMs = options.probeTimeoutMs ?? 5_000;
  const all: Record<string, OperationHandler> = {
    [FILE_READ]: async (args) => {
      privateDirectory(root, false);
      const name = args.name as string;
      const file = await openNoFollow(join(root, name), constants.O_RDONLY);
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new HandlerRefusal("not_a_file");
        if (stat.size > MAX_READ_BYTES) throw new HandlerRefusal("too_large");
        await beforeEffect(FILE_READ);
        const { buffer, bytesRead } = await file.read(Buffer.alloc(stat.size), 0, stat.size, 0);
        const content = buffer.subarray(0, bytesRead);
        return { name, bytes: bytesRead, sha256: createHash("sha256").update(content).digest("hex"), text: content.toString("utf8") };
      } finally { await file.close(); }
    },
    [FILE_APPEND]: async (args) => {
      privateDirectory(root, false);
      const name = args.name as string;
      const data = Buffer.from(`${args.line as string}\n`, "utf8");
      const file = await openNoFollow(join(root, name), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new HandlerRefusal("not_a_file");
        if (stat.size + data.length > MAX_APPEND_FILE_BYTES) throw new HandlerRefusal("too_large");
        await beforeEffect(FILE_APPEND);
        await file.write(data);
        return { name, appendedBytes: data.length };
      } finally { await file.close(); }
    },
    [PROCESS_PROBE]: async (_args, { signal }) => {
      privateDirectory(root, false);
      await beforeEffect(PROCESS_PROBE);
      return runProbe(root, probeTimeoutMs, signal);
    },
  };
  const selected = new Map<string, OperationHandler>();
  for (const tool of options.enable) {
    const handler = all[tool];
    if (!handler) throw new HandlerRefusal("unsupported");
    selected.set(tool, handler);
  }
  return selected;
}

async function openNoFollow(path: string, flags: number, mode?: number): Promise<fsPromises.FileHandle> {
  try {
    return await open(path, flags | constants.O_NOFOLLOW, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new HandlerRefusal(code === "ENOENT" ? "not_found" : code === "ELOOP" ? "symlink_refused" : "unavailable");
  }
}

function runProbe(cwd: string, timeoutMs: number, signal: AbortSignal): Promise<JsonValue> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", PROBE_SCRIPT], {
      cwd, env: {}, shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error: Error | null, value?: JsonValue): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (error) reject(error); else resolve(value!);
    };
    const onAbort = (): void => { finish(new Error("probe_aborted")); };
    const timer = setTimeout(() => { finish(new Error("probe_timeout")); }, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PROBE_OUTPUT) { finish(new Error("probe_output_limit")); return; }
      chunks.push(chunk);
    });
    child.on("error", () => { finish(new HandlerRefusal("probe_unavailable")); });
    child.on("close", (code) => {
      if (code !== 0) { finish(new Error("probe_failed")); return; }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        finish(null, {
          probe: String(parsed.probe), platform: String(parsed.platform), arch: String(parsed.arch), node: String(parsed.node),
        });
      } catch {
        finish(new Error("probe_failed"));
      }
    });
  });
}
