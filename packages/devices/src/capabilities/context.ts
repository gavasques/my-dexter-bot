import { createHash } from "node:crypto";
import { HandlerRefusal, type HandlerContext, type TrustedJobContext } from "../handlers.js";

/**
 * Thrown after an effect may have started (a navigation sent, a control action handed to the helper) and
 * its outcome was not confirmed: cancellation, revocation, takeover, a dead driver or a deadline. It is
 * deliberately not a `HandlerRefusal`, so the daemon journals `unknown` and never retries.
 */
export class OutcomeUncertain extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OutcomeUncertain";
  }
}

/** The trusted job context for `tool`, or a refusal before any effect when the daemon did not provide it. */
export function requireJob(context: HandlerContext, tool: string): TrustedJobContext {
  const job = context.job;
  if (!job || job.tool !== tool) throw new HandlerRefusal("context_missing");
  return job;
}

/**
 * Stable, non-reversible key of one bot on one host installation and owner. Profile directories, locks
 * and sessions are keyed by it, so a path never carries the bot id and two hosts cannot share a profile.
 */
export function botKeyOf(job: Pick<TrustedJobContext, "hostId" | "ownerId" | "botId">): string {
  return createHash("sha256").update(`dexter-bot-key\0${job.hostId}\0${job.ownerId}\0${job.botId}`).digest("hex").slice(0, 32);
}

/**
 * One abort signal for an operation: daemon stop, the job deadline and any capability-local abort
 * (revocation, takeover, session end). `reason()` names the first cause; `dispose()` clears the timer.
 */
export class OperationScope {
  readonly signal: AbortSignal;
  readonly #controller = new AbortController();
  #reason: string | null = null;
  readonly #timer: NodeJS.Timeout;
  readonly #cleanup: Array<() => void> = [];

  constructor(sources: ReadonlyArray<{ signal: AbortSignal; reason: string }>, deadlineAt: number, clock: () => number) {
    this.signal = this.#controller.signal;
    for (const source of sources) {
      if (source.signal.aborted) { this.abort(source.reason); continue; }
      const onAbort = (): void => { this.abort(source.reason); };
      source.signal.addEventListener("abort", onAbort, { once: true });
      this.#cleanup.push(() => { source.signal.removeEventListener("abort", onAbort); });
    }
    const remaining = deadlineAt - clock();
    this.#timer = setTimeout(() => { this.abort("deadline"); }, Math.max(0, Math.min(remaining, 2 ** 31 - 1)));
    if (remaining <= 0) this.abort("deadline");
  }
  /** Adds a later abort source (e.g. the session the operation runs on). */
  link(signal: AbortSignal, reason: () => string): void {
    if (signal.aborted) { this.abort(reason()); return; }
    const onAbort = (): void => { this.abort(reason()); };
    signal.addEventListener("abort", onAbort, { once: true });
    this.#cleanup.push(() => { signal.removeEventListener("abort", onAbort); });
  }
  abort(reason: string): void {
    if (this.#reason !== null) return;
    this.#reason = reason;
    this.#controller.abort();
  }
  get reason(): string | null { return this.#reason; }
  get aborted(): boolean { return this.#reason !== null; }
  dispose(): void {
    clearTimeout(this.#timer);
    for (const cleanup of this.#cleanup.splice(0)) cleanup();
  }
}

/** Rejects as soon as `signal` aborts; the promise itself keeps running and must be fenced by its owner. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(new Error("aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error instanceof Error ? error : new Error("failed")); },
    );
  });
}

/** Text that came from outside the owner's control (a web page, another app). Never instructions. */
export interface UntrustedText { trust: "untrusted_external"; source: string; text: string; truncated: boolean }

/** Cuts `text` to at most `maxChars` code points and `maxBytes` UTF-8 bytes, without splitting a code point. */
export function boundText(text: string, maxChars: number, maxBytes: number): { text: string; truncated: boolean } {
  let out = "";
  let bytes = 0;
  let chars = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (chars + 1 > maxChars || bytes + size > maxBytes) return { text: out, truncated: true };
    out += ch;
    bytes += size;
    chars += 1;
  }
  return { text: out, truncated: false };
}

/** True when `promise` settled within `ms`. The timer only bounds the wait; it is never evidence of anything. */
export function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(false); }, ms); }),
  ]).finally(() => { clearTimeout(timer); });
}
