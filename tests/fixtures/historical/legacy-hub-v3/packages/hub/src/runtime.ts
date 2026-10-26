import { createHash } from "node:crypto";
import type { Action, EngineId, JsonValue } from "@dexter/contracts";
import { dispatchAction, type ToolExecutor } from "./dispatcher.js";
import { HostError } from "./errors.js";
import type { HostStore } from "./store.js";
import {
  MAX_TOOL_REQUESTS_PER_TURN, NATIVE_CURSOR, TERMINAL_TURN_STATES, normalizeTurnCode,
  type RuntimeDriver, type RuntimeEngineEvent, type RuntimeSession, type StartedTurn, type Turn, type TurnCode,
  type TurnCounts, type TurnEvent, type TurnState,
} from "./turns.js";

export interface RuntimeOptions {
  store: HostStore;
  /** One driver per engine. Drivers are injected; the runtime never spawns engines itself. */
  drivers: ReadonlyArray<RuntimeDriver>;
  /** Trusted executor for approved tool actions. Without one, every tool request is refused. */
  executor?: ToolExecutor;
  /** Hard limit for one turn, including approval waits. Default 10 minutes. */
  turnTimeoutMs?: number;
  /**
   * After an abort, how long a driver (or tool executor) may take to stop before the turn is marked unknown.
   * Also bounds each wait for a driver's stream cleanup and session close.
   */
  abortGraceMs?: number;
  /** Poll interval while an action awaits an approval decided outside this runtime. */
  approvalPollMs?: number;
}
export interface ShutdownOptions {
  /**
   * How long running turns, engine streams, sessions and tool executions may take to wind down. If any is
   * still in progress afterwards, shutdown rejects with ShutdownIncompleteError and keeps the store and its
   * lease; call shutdown again to keep waiting, or end the process (the next open records them unknown).
   */
  graceMs?: number;
  /** Close the store after draining (default true). */
  closeStore?: boolean;
}
export interface RuntimeNotice { turnId: string; threadId: string; state: TurnState }
export interface RuntimeStatus {
  state: "running" | "draining" | "closed";
  engines: EngineId[];
  activeTurns: Array<{ turnId: string; threadId: string; engine: EngineId; startedAt: number | null }>;
  openSessions: number;
  /** Queued turns left by a previous process; they wait for `resumeQueued` or `cancelTurn`. */
  heldQueuedTurns: number;
  /** Null once the store has been released. */
  counts: TurnCounts | null;
  /** Work of this process still in flight; while any is non-zero the store and its lease are kept. */
  pending: RuntimePending;
}
export interface RuntimePending {
  /** Turns not yet terminal in this process. */
  turns: number;
  /** Engine streams whose cleanup has not finished (their thread runs nothing else meanwhile). */
  streams: number;
  /**
   * Driver sessions whose close or tool response has not finished. Includes sessions whose close rejected or
   * threw: that is no proof the driver stopped, so they stay counted (and their thread blocked) for the life
   * of this process, and shutdown keeps rejecting until the process ends.
   */
  sessions: number;
  /** Tool executions started by this process that have not returned (outcome not yet known). */
  executions: number;
}

/**
 * Shutdown could not finish within its grace. Nothing was released: the store stays open and the writer
 * lease is kept, because work of this process may still produce effects. Retry `shutdown`, or end the
 * process; the next open then records the in-flight turns and actions as unknown and never re-runs them.
 */
export class ShutdownIncompleteError extends HostError {
  constructor(readonly pending: RuntimePending) {
    super("outcome_unknown", `shutdown incomplete: ${pending.turns} turns, ${pending.streams} engine streams, `
      + `${pending.sessions} sessions and ${pending.executions} tool executions still in progress; store and lease kept`);
    this.name = "ShutdownIncompleteError";
  }
}

type Terminal = { state: Exclude<TurnState, "queued" | "running">; code: TurnCode | null };
type AbortReason = "cancelled" | "shutdown" | "timeout";
interface Active {
  turn: Turn;
  controller: AbortController;
  reason: AbortReason | null;
  binding: Binding | null;
  /** Settles once the driver's stream has run its cleanup (never rejects). */
  cleanup: Promise<void> | null;
  done: Promise<void>;
}
interface Binding { driver: RuntimeDriver; session: RuntimeSession }
/**
 * In-process work that outlives its turn's bookkeeping. While any exists for a thread, it starts nothing.
 * A session close that rejected or threw is kept forever (quarantined), never treated as closed.
 */
interface Residue { kind: "stream" | "session" | "execution"; threadId: string; settled: Promise<void> }

const HARD_STOP = Symbol("hard-stop");
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;

/**
 * Durable conversation runtime. Every accepted input is committed before any driver runs; each turn
 * reaches exactly one terminal state; a crash leaves running turns `unknown` (never re-sent). This
 * gives at-most-once delivery of each input to an engine, not exactly-once inference.
 */
export class ConversationRuntime {
  private readonly store: HostStore;
  private readonly drivers = new Map<EngineId, RuntimeDriver>();
  private readonly executor: ToolExecutor | undefined;
  private readonly turnTimeoutMs: number;
  private readonly abortGraceMs: number;
  private readonly approvalPollMs: number;
  private readonly sessions = new Map<string, Binding>();
  /** Sessions of `turn` drivers, open only for the turn that opened them (never cached or reused). */
  private readonly turnBindings = new Set<Binding>();
  private readonly active = new Map<string, Active>();
  private readonly pumping = new Set<string>();
  private readonly held = new Set<string>();
  private readonly listeners = new Set<(notice: RuntimeNotice) => void>();
  private readonly wakers = new Set<() => void>();
  private readonly residues = new Set<Residue>();
  private state: RuntimeStatus["state"] = "running";
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: RuntimeOptions) {
    this.store = options.store;
    for (const driver of options.drivers) {
      if (driver.id !== "claude" && driver.id !== "codex") throw new HostError("invalid_input", "drivers: invalid_value");
      if (this.drivers.has(driver.id)) throw new HostError("invalid_input", "drivers: duplicate engine");
      this.drivers.set(driver.id, driver);
    }
    this.executor = options.executor;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.abortGraceMs = options.abortGraceMs ?? 5_000;
    this.approvalPollMs = options.approvalPollMs ?? 250;
    // Queued turns from a previous process never reached a driver. They are held, not auto-run.
    for (const turn of this.store.listTurnsByState("queued")) this.held.add(turn.id);
  }

  // ---- API for HTTP / CLI --------------------------------------------------------------------

  /** Trusted composition check; does not expose the canonical store or confer authority. */
  isBoundTo(store: HostStore): boolean { return this.store === store; }

  /**
   * Durably accepts an input and schedules it. Returns once committed; the engine runs in the background,
   * detached from the caller's connection. Replays with the same clientRequestId return the same turn.
   */
  startTurn(threadId: string, input: unknown): StartedTurn {
    const clientRequestId = typeof input === "object" && input !== null ? (input as Record<string, unknown>).clientRequestId : undefined;
    const replay = typeof clientRequestId === "string" ? this.store.findTurn(threadId, clientRequestId) : null;
    if (replay) return this.store.createTurn(threadId, input); // validates same content; never re-runs
    if (this.state !== "running") throw new HostError("host_locked", "runtime is shutting down");
    if ([...this.held].some((id) => this.store.getTurn(id).threadId === threadId)) {
      throw new HostError("conflict", "thread has queued turns from a previous run; resume or cancel them first");
    }
    const started = this.store.createTurn(threadId, input);
    this.notify(started.turn);
    this.kick(threadId);
    return started;
  }
  getTurn(turnId: string): Turn { return this.store.getTurn(turnId); }
  listTurns(threadId: string, after = 0, limit = 100): Turn[] { return this.store.listTurns(threadId, after, limit); }
  listTurnEvents(scope: { turnId: string } | { threadId: string }, after = 0, limit = 100): TurnEvent[] {
    return this.store.listTurnEvents(scope, after, limit);
  }

  /**
   * Cancels regardless of who started the turn. Queued: interrupted immediately. Running: the driver is
   * aborted and the turn ends as interrupted (or unknown if the driver does not stop within the grace).
   * Terminal turns are returned unchanged.
   */
  cancelTurn(turnId: string): Turn {
    const turn = this.store.getTurn(turnId);
    if (turn.state === "queued") {
      this.held.delete(turnId);
      const cancelled = this.store.cancelQueuedTurn(turnId);
      this.notify(cancelled);
      this.kick(turn.threadId);
      return cancelled;
    }
    const active = this.active.get(turnId);
    if (active) this.abort(active, "cancelled");
    return this.store.getTurn(turnId);
  }

  /** Explicitly releases queued turns held from a previous process, in FIFO order. Returns how many. */
  resumeQueued(threadId: string): number {
    if (this.state !== "running") throw new HostError("host_locked", "runtime is shutting down");
    this.store.getThread(threadId);
    let released = 0;
    for (const id of [...this.held]) {
      if (this.store.getTurn(id).threadId === threadId) { this.held.delete(id); released += 1; }
    }
    this.kick(threadId);
    return released;
  }

  /** Owner decision on an action; wakes a turn waiting for it. Same rules as HostStore.decideAction. */
  decideAction(actionId: string, decision: unknown): Action {
    try { return this.store.decideAction(actionId, decision); } finally { this.wake(); }
  }

  /** Resolves with the turn once it is terminal (or rejects on timeout). Does not affect the turn. */
  async waitForTurn(turnId: string, timeoutMs = 30_000): Promise<Turn> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const turn = this.store.getTurn(turnId);
      if (TERMINAL_TURN_STATES.has(turn.state)) return turn;
      if (Date.now() >= deadline) throw new HostError("conflict", "turn still in progress");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(50, Math.max(deadline - Date.now(), 0)));
        const unsubscribe = this.subscribe((notice) => { if (notice.turnId === turnId) done(); });
        function done(): void { clearTimeout(timer); unsubscribe(); resolve(); }
      });
    }
  }

  /** In-process notifications of turn state changes (ids and states only). */
  subscribe(listener: (notice: RuntimeNotice) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Snapshot without content, arguments, cursors or secrets. */
  status(): RuntimeStatus {
    return {
      state: this.state,
      engines: [...this.drivers.keys()],
      activeTurns: [...this.active.values()].map(({ turn }) =>
        ({ turnId: turn.id, threadId: turn.threadId, engine: turn.engine, startedAt: turn.startedAt })),
      openSessions: this.sessions.size + this.turnBindings.size,
      heldQueuedTurns: this.held.size,
      counts: this.state === "closed" ? null : this.store.turnCounts(),
      pending: this.pending(),
    };
  }

  /**
   * Stops accepting input, aborts running turns (and signals their tool executors), waits up to `graceMs`
   * for turns, engine streams, sessions and executions to finish, and only then releases the store and
   * its lease. Never reports success while work of this process is in flight: it rejects with
   * ShutdownIncompleteError and keeps everything open instead. Calling it again keeps waiting.
   */
  shutdown(options: ShutdownOptions = {}): Promise<void> {
    if (this.state === "closed") return Promise.resolve();
    this.shutdownPromise ??= this.drain(options.graceMs ?? 5_000, options.closeStore ?? true)
      .finally(() => { this.shutdownPromise = null; });
    return this.shutdownPromise;
  }

  // ---- internals -----------------------------------------------------------------------------

  private async drain(graceMs: number, closeStore: boolean): Promise<void> {
    this.state = "draining";
    const deadline = Date.now() + graceMs;
    const left = (): number => Math.max(deadline - Date.now(), 0);
    for (const active of this.active.values()) this.abort(active, "shutdown");
    this.wake();
    await withTimeout(Promise.allSettled([...this.active.values()].map((active) => active.done)), left());
    const bindings = [...this.sessions.values()];
    this.sessions.clear();
    for (const binding of bindings) this.track("session", binding.session.threadId, this.closeSession(binding), true);
    await withTimeout(Promise.allSettled([...this.residues].map((residue) => residue.settled)), left());
    const pending = this.pending();
    if (pending.turns + pending.streams + pending.sessions + pending.executions > 0) throw new ShutdownIncompleteError(pending);
    this.state = "closed";
    if (closeStore) this.store.close();
  }

  private pending(): RuntimePending {
    const count = (kind: Residue["kind"]): number => [...this.residues].filter((residue) => residue.kind === kind).length;
    return { turns: this.active.size, streams: count("stream"), sessions: count("session"), executions: count("execution") };
  }
  /**
   * Keeps `promise` visible until it settles; its thread starts no new turn meanwhile. With `failClosed`, a
   * rejection keeps it visible for good: the thread, the store and its lease stay held until the process ends.
   * The returned promise settles (never rejects) when `promise` does.
   */
  private track(kind: Residue["kind"], threadId: string, promise: Promise<unknown>, failClosed = false): Promise<void> {
    const residue: Residue = { kind, threadId, settled: Promise.resolve() };
    this.residues.add(residue);
    const release = (): void => { this.residues.delete(residue); this.kick(threadId); };
    residue.settled = promise.then(release, () => { if (!failClosed) release(); });
    return residue.settled;
  }
  private threadBusy(threadId: string): boolean {
    for (const residue of this.residues) if (residue.threadId === threadId) return true;
    return false;
  }
  /**
   * Only a close that resolves proves the driver has stopped using the session. A rejection or synchronous
   * throw is surfaced (as a rejection) so callers track it with `failClosed`; it is never retried, because a
   * driver may forget the session on a failed close and resolve a second one without having drained it.
   */
  private closeSession(binding: Binding): Promise<void> {
    try { return Promise.resolve(binding.driver.close(binding.session)).then(() => {}); } catch (error) { return Promise.reject(error); }
  }

  private kick(threadId: string): void {
    if (this.pumping.has(threadId) || this.state !== "running") return;
    this.pumping.add(threadId);
    void this.pump(threadId);
  }
  private async pump(threadId: string): Promise<void> {
    // One pump per thread: turns of a thread run strictly one after another, and a turn starts only once
    // the previous one's stream cleanup, session close and tool executions have finished.
    for (;;) {
      let turn: Turn | null = null;
      try {
        if (this.state === "running" && !this.threadBusy(threadId)) turn = this.store.claimNextTurn(threadId, this.held);
      } catch { turn = null; }
      if (!turn) { this.pumping.delete(threadId); return; }
      const active: Active = {
        turn, controller: new AbortController(), reason: null, binding: null, cleanup: null, done: Promise.resolve(),
      };
      active.done = this.run(active);
      this.active.set(turn.id, active);
      this.notify(turn);
      await active.done;
      this.active.delete(turn.id);
    }
  }

  private abort(active: Active, reason: AbortReason): void {
    if (active.controller.signal.aborted) return;
    active.reason = reason;
    active.controller.abort();
    this.wake();
    const binding = active.binding;
    if (binding) void binding.driver.interrupt(binding.session, active.turn.id).catch(() => {});
  }

  private async run(active: Active): Promise<void> {
    await Promise.resolve(); // let pump() register the turn before anything can settle
    const { turn, controller } = active;
    const signal = controller.signal;
    const timer = setTimeout(() => this.abort(active, "timeout"), this.turnTimeoutMs);
    let terminal: Terminal;
    try {
      terminal = await this.execute(active, signal);
    } catch (error) {
      terminal = this.aborted(active) ?? { state: "failed", code: normalizeTurnCode((error as { code?: unknown } | null)?.code) };
    } finally {
      clearTimeout(timer);
    }
    const binding = active.binding;
    let finished: Turn | null = null;
    try {
      const cursor = terminal.state === "completed" ? binding?.session.nativeCursor : undefined;
      finished = this.store.finishTurn(turn.id, terminal.state, terminal.code, cursor);
    } catch {
      // Store closed or lease lost: the turn stays running and the next open records it as unknown.
    }
    if (finished) this.notify(finished);
    // The thread is released only after the driver has finished with this turn's stream.
    const cleanup = active.cleanup;
    let clean = cleanup === null || (await withTimeout(cleanup, this.abortGraceMs)) !== HARD_STOP;
    const perTurn = binding !== null && this.turnBindings.delete(binding);
    if (binding && (perTurn || terminal.state !== "completed" || !clean)) {
      // After any non-clean ending the in-memory session may be uncertain; reopen from the persisted cursor.
      // A per-turn session is always closed. Either way the close counts as pending until it resolves, and a
      // failed close quarantines the thread, store and lease for the rest of this process.
      if (this.sessions.get(turn.threadId) === binding) this.sessions.delete(turn.threadId);
      await withTimeout(this.track("session", turn.threadId, this.closeSession(binding), true), this.abortGraceMs);
      if (!clean) clean = (await withTimeout(cleanup!, this.abortGraceMs)) !== HARD_STOP;
    }
    if (!clean) this.track("stream", turn.threadId, cleanup!);
  }

  private aborted(active: Active): Terminal | null {
    if (active.reason === "timeout") return { state: "failed", code: "timeout" };
    if (active.reason) return { state: "interrupted", code: active.reason };
    return null;
  }

  private async execute(active: Active, signal: AbortSignal): Promise<Terminal> {
    const { turn } = active;
    const driver = this.drivers.get(turn.engine);
    if (!driver) return { state: "failed", code: "no_driver" };
    const binding = await this.sessionFor(turn, driver, signal);
    if (!binding) return this.aborted(active) ?? { state: "failed", code: "session_closed" };
    active.binding = binding;
    if (signal.aborted) return this.aborted(active)!;
    const stream = driver.turn(binding.session, turn.id, this.store.turnInput(turn.id), signal)[Symbol.asyncIterator]();
    // Leaving the loop for any reason closes the stream; the driver's cleanup may be asynchronous.
    const closeStream = (): Promise<void> => {
      try { return Promise.resolve(stream.return?.()).then(() => {}, () => {}); } catch { return Promise.resolve(); }
    };
    const hardStop = abortedThenGrace(signal, this.abortGraceMs);
    let tools = 0;
    try {
      for (;;) {
        const next = await Promise.race([stream.next(), hardStop.promise]);
        if (next === HARD_STOP) {
          // The driver ignored the abort: inference may still be happening. Do not claim interrupted.
          return { state: "unknown", code: "driver_unresponsive" };
        }
        if (next.done) return this.aborted(active) ?? { state: "failed", code: "protocol_error" };
        const event = next.value as RuntimeEngineEvent;
        if (event?.threadId !== turn.threadId || event.turnId !== turn.id) return { state: "failed", code: "protocol_error" };
        switch (event.type) {
          case "text.delta":
            if (typeof event.text === "string") this.store.appendTurnDelta(turn.id, event.text);
            break;
          case "tool.request": {
            tools += 1;
            if (tools > MAX_TOOL_REQUESTS_PER_TURN) return { state: "failed", code: "tool_limit" };
            const failure = await this.handleTool(active, binding, event.request, signal);
            // An executor that ignored the abort may still produce its effect: the turn's outcome is unknown.
            if (failure === "executor_unresponsive" || failure === "driver_unresponsive") return { state: "unknown", code: failure };
            if (failure) return this.aborted(active) ?? { state: "failed", code: failure };
            break;
          }
          // A recorded cancel/timeout/shutdown wins over a late success: no message and no cursor advance.
          case "turn.completed": return this.aborted(active) ?? { state: "completed", code: null };
          case "turn.interrupted": return this.aborted(active) ?? { state: "interrupted", code: null };
          case "turn.failed": return this.aborted(active) ?? { state: "failed", code: normalizeTurnCode(event.code) };
          default: return { state: "failed", code: "protocol_error" };
        }
      }
    } finally {
      hardStop.dispose();
      // Leaving early (first terminal, protocol error) closes the driver's stream; later events are ignored.
      active.cleanup = closeStream();
    }
  }

  private async sessionFor(turn: Turn, driver: RuntimeDriver, signal: AbortSignal): Promise<Binding | null> {
    const perTurn = driver.sessionReuse === "turn";
    const cached = perTurn ? undefined : this.sessions.get(turn.threadId);
    if (cached && cached.driver === driver) return cached;
    const stored = this.store.getThreadSession(turn.threadId);
    if (stored && stored.engine !== driver.id) throw Object.assign(new Error("engine mismatch"), { code: "protocol_error" });
    const cursor = stored?.nativeCursor ?? undefined;
    if (cursor !== undefined && !NATIVE_CURSOR.test(cursor)) throw Object.assign(new Error("bad cursor"), { code: "protocol_error" });
    const opening = perTurn ? driver.open(turn.threadId, cursor, { turnId: turn.id, signal }) : driver.open(turn.threadId, cursor);
    const session = await raceAbort(opening, signal);
    if (session === HARD_STOP) {
      // Do not leak a session that finishes opening after the abort; the thread waits until it is closed.
      // A rejected open returned no session to close.
      this.track("session", turn.threadId, opening.then((late) => this.closeSession({ driver, session: late }), () => {}), true);
      return null;
    }
    if (session?.threadId !== turn.threadId || typeof session.nativeCursor !== "string") {
      // Not awaited: the turn ends now (a hung close cannot outlive its timeout), while the thread, store and
      // lease stay held until the close resolves (or for good, if it fails).
      if (typeof session === "object" && session !== null) this.track("session", turn.threadId, this.closeSession({ driver, session }), true);
      throw Object.assign(new Error("bad session"), { code: "protocol_error" });
    }
    const binding = { driver, session };
    if (perTurn) this.turnBindings.add(binding); else this.sessions.set(turn.threadId, binding);
    return binding;
  }

  /**
   * Engine tool requests go through grants, approvals and the dispatcher. Identity is fixed by the
   * turn: a request naming another bot or thread fails the turn. The engine's idempotency key is scoped
   * to the turn so it can neither collide with nor read back actions of other turns. Returns a failure
   * code, or null to continue the turn.
   */
  private async handleTool(active: Active, binding: Binding, request: unknown, signal: AbortSignal): Promise<TurnCode | null> {
    const { turn } = active;
    const raw = (typeof request === "object" && request !== null ? request : {}) as Record<string, unknown>;
    if (raw.botId !== turn.botId || raw.threadId !== turn.threadId || typeof raw.idempotencyKey !== "string") {
      this.store.recordToolEvent(turn.id, "tool.resolved", { actionId: null, state: "rejected", code: "tool_identity_mismatch" });
      return "tool_identity_mismatch";
    }
    const requestId = raw.idempotencyKey;
    const scopedKey = `${turn.id}/${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`;
    let action: Action | null = null;
    let refusal: string | null = null;
    try {
      action = this.store.requestAction({ ...raw, botId: turn.botId, threadId: turn.threadId, idempotencyKey: scopedKey });
    } catch (error) {
      if (!(error instanceof HostError)) throw error;
      refusal = error.code;
    }
    if (action) {
      this.store.recordToolEvent(turn.id, "tool.requested",
        { actionId: action.id, tool: action.request.tool, destination: action.request.destination, state: action.state });
      const settled = await this.settleAction(turn, action, signal);
      if (settled === HARD_STOP) {
        // Still running in this process: tracked, the store and lease are kept until it returns.
        this.store.recordToolEvent(turn.id, "tool.resolved", { actionId: action.id, state: "running", code: "executor_unresponsive" });
        return "executor_unresponsive";
      }
      action = settled;
    }
    const outcome: JsonValue = action
      ? { actionId: action.id, state: action.state, reason: action.reason, result: action.state === "succeeded" ? action.result : null }
      : { actionId: null, state: "refused", reason: refusal, result: null };
    this.store.recordToolEvent(turn.id, "tool.resolved",
      action ? { actionId: action.id, state: action.state, code: action.reason } : { actionId: null, state: "refused", code: refusal });
    if (signal.aborted) return "cancelled";
    const hardStop = abortedThenGrace(signal, this.abortGraceMs);
    try {
      const response = binding.driver.respondToTool(binding.session, turn.id, requestId, outcome);
      // Sending the result is another live session operation. A driver may ignore the abort here,
      // even after the dispatcher has returned; retain its thread and writer until it settles.
      this.track("session", turn.threadId, response);
      if (await Promise.race([response, hardStop.promise]) === HARD_STOP) return "driver_unresponsive";
    } catch {
      return "tool_response_failed";
    } finally {
      hardStop.dispose();
    }
    return null;
  }

  /**
   * Waits for a decision if needed, then dispatches once. Never dispatches after abort or expiry. A started
   * execution receives the turn's abort signal; if it has not returned `abortGraceMs` after an abort this
   * resolves HARD_STOP while the execution stays tracked (its result is still recorded when it returns).
   */
  private async settleAction(turn: Turn, initial: Action, signal: AbortSignal): Promise<Action | typeof HARD_STOP> {
    let action = initial;
    while (action.state === "awaiting_approval") {
      if (signal.aborted) return this.store.withdrawAction(action.id, "user_denied");
      if (action.approvalExpiresAt !== null && this.store.now() >= action.approvalExpiresAt) {
        this.store.expireApprovals();
      } else {
        await this.sleepOrWake(signal);
      }
      action = this.store.getAction(action.id);
    }
    if (action.state !== "ready") return action; // terminal, or a replay of an action that already ran
    if (signal.aborted) return this.store.withdrawAction(action.id, "user_denied");
    if (!this.executor) return this.store.withdrawAction(action.id, "user_denied");
    const id = action.id;
    const dispatch = dispatchAction(this.store, id, this.executor, signal)
      // Claim refused (grant changed, device revoked, expired, offline): state already persisted.
      .catch(() => this.store.getAction(id));
    this.track("execution", turn.threadId, dispatch);
    const hardStop = abortedThenGrace(signal, this.abortGraceMs);
    try {
      return await Promise.race([dispatch, hardStop.promise]);
    } finally {
      hardStop.dispose();
    }
  }

  private sleepOrWake(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => { clearTimeout(timer); this.wakers.delete(done); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, this.approvalPollMs);
      this.wakers.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }
  private wake(): void { for (const waker of [...this.wakers]) waker(); }
  private notify(turn: Turn): void {
    for (const listener of [...this.listeners]) {
      try { listener({ turnId: turn.id, threadId: turn.threadId, state: turn.state }); } catch { /* listeners cannot break turns */ }
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof HARD_STOP> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<typeof HARD_STOP>((resolve) => { timer = setTimeout(() => resolve(HARD_STOP), ms); })])
    .finally(() => clearTimeout(timer));
}
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof HARD_STOP> {
  if (signal.aborted) { promise.catch(() => {}); return Promise.resolve(HARD_STOP); }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(HARD_STOP);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
/** Resolves HARD_STOP `graceMs` after the signal aborts. */
function abortedThenGrace(signal: AbortSignal, graceMs: number): { promise: Promise<typeof HARD_STOP>; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = (): void => {};
  const promise = new Promise<typeof HARD_STOP>((resolve) => {
    onAbort = () => { timer = setTimeout(() => resolve(HARD_STOP), graceMs); };
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
  });
  return { promise, dispose: () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); } };
}
