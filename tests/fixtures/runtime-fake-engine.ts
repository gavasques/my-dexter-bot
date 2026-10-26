/**
 * Scripted in-memory engine for runtime tests. No inference, no processes, no credentials.
 * The user input selects the behaviour:
 *   echo:<text>        streams <text> word by word asynchronously, then completes
 *   big:<n>            streams n characters in 1000-char chunks, then completes
 *   hang               streams one delta, then waits for abort and reports interrupted
 *   deaf               streams one delta, then ignores abort until its session is closed (like a killed process)
 *   zombie             streams one delta, then ignores abort and close forever
 *   gate               streams one delta, waits for `release(turnId)`, then completes even if aborted
 *   fail:<code>        reports turn.failed with <code>
 *   fail-secret        reports turn.failed whose code is secret-looking stderr
 *   throw              throws an error whose message looks like secret stderr
 *   double             completes, then keeps emitting (failed + delta) which must be ignored
 *   end                ends the stream without a terminal event
 *   foreign            emits a delta for another turn id
 *   tool:<json>        emits tool.request(s) from {"requests":[...]} and reports each outcome as text
 * `cleanupMs` delays the stream's finally (async cleanup, like a real process driver); a turn started on a
 * thread whose previous stream has not finished cleaning up fails with `busy`.
 */
import type { JsonValue, ToolRequest } from "@dexter/contracts";
import type { RuntimeDriver, RuntimeEngineEvent, RuntimeSession } from "@dexter/hub";

export const SECRET_STDERR = "stderr: Authorization: Bearer sk-fixture-secret-0000";

export class FakeEngine implements RuntimeDriver {
  readonly opens: Array<{ threadId: string; cursor: string | undefined }> = [];
  readonly turns: Array<{ turnId: string; threadId: string; input: string }> = [];
  readonly tools: Array<{ turnId: string; requestId: string; result: JsonValue }> = [];
  readonly interrupts: string[] = [];
  closes = 0;
  maxPerThread = 0;
  maxGlobal = 0;
  failOpen: string | null = null;
  cursorOverride: string | null = null;
  cleanupMs = 0;
  private gates = new Map<string, () => void>();
  private closers = new Map<string, Set<() => void>>();
  private running = new Map<string, number>();
  private pendingTools = new Map<string, (result: JsonValue) => void>();
  private sequence = 0;

  constructor(readonly id: "claude" | "codex" = "claude", private readonly stepMs = 2) {}

  async open(threadId: string, nativeCursor?: string): Promise<RuntimeSession> {
    this.opens.push({ threadId, cursor: nativeCursor });
    await delay(1);
    if (this.failOpen) throw Object.assign(new Error(SECRET_STDERR), { code: this.failOpen });
    return { threadId, nativeCursor: this.cursorOverride ?? nativeCursor ?? `fake-cursor-${++this.sequence}` };
  }

  async *turn(session: RuntimeSession, turnId: string, input: string, signal: AbortSignal): AsyncIterable<RuntimeEngineEvent> {
    this.turns.push({ turnId, threadId: session.threadId, input });
    if ((this.running.get(session.threadId) ?? 0) > 0) {
      yield { type: "turn.failed", threadId: session.threadId, turnId, code: "busy" };
      return;
    }
    const perThread = (this.running.get(session.threadId) ?? 0) + 1;
    this.running.set(session.threadId, perThread);
    this.maxPerThread = Math.max(this.maxPerThread, perThread);
    this.maxGlobal = Math.max(this.maxGlobal, [...this.running.values()].reduce((a, b) => a + b, 0));
    const id = { threadId: session.threadId, turnId };
    try {
      if (input.startsWith("echo:")) {
        for (const word of input.slice(5).split(/(?<= )/)) { await delay(this.stepMs); yield { type: "text.delta", ...id, text: word }; }
        yield { type: "turn.completed", ...id, usage: {} };
      } else if (input.startsWith("big:")) {
        let left = Number(input.slice(4));
        while (left > 0) { const n = Math.min(1000, left); left -= n; await delay(0); yield { type: "text.delta", ...id, text: "x".repeat(n) }; }
        yield { type: "turn.completed", ...id, usage: {} };
      } else if (input === "hang") {
        yield { type: "text.delta", ...id, text: "thinking" };
        await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
        yield { type: "turn.interrupted", ...id };
      } else if (input === "deaf") {
        yield { type: "text.delta", ...id, text: "thinking" };
        await new Promise<void>((resolve) => {
          const set = this.closers.get(session.threadId) ?? new Set();
          set.add(resolve);
          this.closers.set(session.threadId, set);
        });
        return;
      } else if (input === "zombie") {
        yield { type: "text.delta", ...id, text: "thinking" };
        await new Promise<void>(() => {});
      } else if (input === "gate") {
        yield { type: "text.delta", ...id, text: "late" };
        await new Promise<void>((resolve) => this.gates.set(turnId, resolve));
        yield { type: "turn.completed", ...id, usage: {} };
      } else if (input.startsWith("fail:")) {
        await delay(this.stepMs);
        yield { type: "turn.failed", ...id, code: input.slice(5) };
      } else if (input === "fail-secret") {
        await delay(this.stepMs);
        yield { type: "turn.failed", ...id, code: SECRET_STDERR };
      } else if (input === "throw") {
        await delay(this.stepMs);
        throw new Error(SECRET_STDERR);
      } else if (input === "double") {
        yield { type: "text.delta", ...id, text: "once" };
        yield { type: "turn.completed", ...id, usage: {} };
        yield { type: "turn.failed", ...id, code: "engine_failed" };
        yield { type: "text.delta", ...id, text: "late" };
      } else if (input === "end") {
        yield { type: "text.delta", ...id, text: "partial" };
      } else if (input === "foreign") {
        yield { type: "text.delta", threadId: session.threadId, turnId: "turn_someone_else", text: "x" };
      } else if (input.startsWith("tool:")) {
        const { requests } = JSON.parse(input.slice(5)) as { requests: ToolRequest[] };
        for (const request of requests) {
          const answered = new Promise<JsonValue>((resolve) => this.pendingTools.set(`${turnId}/${request.idempotencyKey}`, resolve));
          yield { type: "tool.request", ...id, request };
          const outcome = await Promise.race([answered, aborted(signal)]);
          if (outcome === ABORTED) { yield { type: "turn.interrupted", ...id }; return; }
          yield { type: "text.delta", ...id, text: `[${String((outcome as { state?: unknown }).state)}]` };
        }
        yield { type: "turn.completed", ...id, usage: {} };
      } else {
        yield { type: "turn.failed", ...id, code: "unsupported" };
      }
    } finally {
      if (this.cleanupMs > 0) await delay(this.cleanupMs);
      this.running.set(session.threadId, (this.running.get(session.threadId) ?? 1) - 1);
    }
  }

  async respondToTool(_session: RuntimeSession, turnId: string, requestId: string, result: JsonValue): Promise<void> {
    this.tools.push({ turnId, requestId, result });
    this.pendingTools.get(`${turnId}/${requestId}`)?.(result);
  }
  async interrupt(_session: RuntimeSession, turnId: string): Promise<void> { this.interrupts.push(turnId); }
  async close(session: RuntimeSession): Promise<void> {
    this.closes += 1;
    for (const resolve of this.closers.get(session.threadId) ?? []) resolve();
    this.closers.delete(session.threadId);
  }
  /** Lets a `gate` turn continue to its (late) completion. */
  release(turnId: string): boolean {
    const resolve = this.gates.get(turnId);
    this.gates.delete(turnId);
    resolve?.();
    return resolve !== undefined;
  }
}

const ABORTED = Symbol("aborted");
function aborted(signal: AbortSignal): Promise<typeof ABORTED> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(ABORTED); else signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
  });
}
export function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
