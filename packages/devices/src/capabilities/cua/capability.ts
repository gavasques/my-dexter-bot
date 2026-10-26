import { inspect } from "node:util";
import type { JsonValue } from "@dexter/contracts";
import { HandlerRefusal, type HandlerContext, type OperationHandler, type TrustedJobContext } from "../../handlers.js";
import { DeviceError } from "../../errors.js";
import { CUA_CONTROL, CUA_OBSERVE, CUA_STATUS } from "../../operations.js";
import { OperationScope, OutcomeUncertain, boundText, botKeyOf, requireJob } from "../context.js";
import type { Authorization, LocalCapabilityPolicy } from "../policy.js";
import { CuaTransportError, type CuaTransport } from "./transport.js";

/** Refusal codes the helper may report. Anything else from the helper is a protocol error. */
export const CUA_REFUSALS: readonly string[] = Object.freeze([
  "no_session", "session_ended", "session_expired", "surface_mismatch", "surface_gone", "element_unknown", "element_unsupported",
  "screen_locked", "lock_state_unknown", "permission_missing", "indicator_hidden", "consent_pending", "consent_denied", "busy",
]);
export const SESSION_END_REASONS: readonly string[] = Object.freeze([
  "operator_stop", "takeover", "expired", "screen_locked", "lock_state_unknown", "permission_lost", "surface_gone", "daemon", "revoked", "helper_exit",
]);
/** Default and maximum time the operator has to answer one consent prompt; the helper enforces it too. */
export const CUA_CONSENT_PROMPT_SECONDS = 120;
export const MAX_CUA_CONSENT_PROMPT_SECONDS = 300;
/** Delivery delay tolerated between the helper's own deadline check and the daemon seeing its event. */
const EVENT_SLACK_MS = 2_000;
const MAX_NODE_TEXT = 160;
const MAX_RESULT_BYTES = 14 * 1024;
const SURFACE_ID = /^srf_[0-9a-f]{32}$/;
const SESSION_ID = /^cus_[0-9a-f]{32}$/;
const ELEMENT_ID = /^el_[0-9]{1,6}$/;

export interface CuaCapabilityOptions {
  policy: LocalCapabilityPolicy;
  /** Starts (or restarts after a crash or a forced drain) the helper. Called lazily on first use. */
  transport: () => CuaTransport;
  clock?: () => number;
  /** Bound for one helper answer; a helper that does not answer is killed (non-cooperative drain). */
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
  /** How long one consent prompt stays open (1..300 s, default 120). */
  consentPromptSeconds?: number;
}

interface CuaSession {
  readonly sessionId: string;
  readonly botKey: string;
  readonly surfaceId: string;
  readonly expiresAt: number;
  /** The bot's policy generation the consent was asked under; any grant change ends the session. */
  readonly generation: number;
  readonly ended: AbortController;
  endReason: string | null;
}
/**
 * The last consent prompt this side asked the helper to show for a bot, under one grant generation.
 * `pending` while it may be answered; `denied`/`expired` once the operator refused or let it lapse. A closed
 * record stops further prompts for that bot until the owner re-arms it (`rearmConsent`) or changes the
 * bot's local grant (new generation): no prompt renewal on the bot's own initiative.
 */
interface Consent { readonly generation: number; promptExpiresAt: number; state: "pending" | "denied" | "expired" }

/**
 * Computer use on this Mac, opt-in per bot and per operation, through the local helper:
 *
 * - A session exists only after the operator consented locally and selected one surface (an app window)
 *   in the helper UI. `mac.cua.status` (or the first observe/control) of a bot without a session asks
 *   the helper to show the consent prompt, with the bot's label and session bound from the local policy
 *   and a bounded prompt deadline; nothing is granted by the request itself, and only the operator picks
 *   the surface. At most one prompt per bot and grant generation: while it is open, calls share it; once
 *   denied or expired, status only reports that, and a new prompt needs the owner (`rearmConsent` or a
 *   change of the bot's local grant). `mac.cua.status` then reports the bot's own session id, selected surface id and expiry,
 *   after the helper re-checked its gates, so the bot can address that surface in observe/control.
 * - Sessions are short (the bot's local bound, at most 15 min), show an indicator while active and end
 *   on operator stop, takeover (physical input), lock, unknown lock state, lost permission or expiry. The
 *   helper enforces this before every action; this side mirrors it and fences after every await.
 * - Any change of the bot's local grant (or a quarantined policy) ends its session and cancels its prompt;
 *   a session that starts from a prompt asked under an older grant generation is ended at once.
 * - Observation returns accessibility metadata of the selected surface only (no screenshots, no other
 *   apps) as untrusted text. Control is press/focus/set_value on an element id from that surface.
 *
 * A control action the helper did not confirm (timeout, abort, helper exit) is `unknown`; a helper that
 * stops answering is killed, which also removes its indicator and every session.
 */
export class CuaCapability {
  private readonly policy: LocalCapabilityPolicy;
  private readonly makeTransport: () => CuaTransport;
  private readonly clock: () => number;
  private readonly requestTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly promptSeconds: number;
  private transport: CuaTransport | null = null;
  private readonly sessions = new Map<string, CuaSession>();
  private readonly consents = new Map<string, Consent>();
  private readonly botIds = new Map<string, string>();
  private readonly unsubscribe: () => void;
  private readonly inflight = new Set<Promise<unknown>>();
  private closed = false;

  constructor(options: CuaCapabilityOptions) {
    this.policy = options.policy;
    this.makeTransport = options.transport;
    this.clock = options.clock ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 3_000;
    const prompt = options.consentPromptSeconds ?? CUA_CONSENT_PROMPT_SECONDS;
    if (!Number.isSafeInteger(prompt) || prompt < 1 || prompt > MAX_CUA_CONSENT_PROMPT_SECONDS) throw new DeviceError("invalid_input", "invalid consent prompt bound");
    this.promptSeconds = prompt;
    this.unsubscribe = this.policy.onChange((botIds) => {
      // Any change of a bot's grant ends its sessions and withdraws its prompt; consent must be given again.
      for (const session of [...this.sessions.values()]) {
        const botId = this.botIdOf(session.botKey);
        if (botId === null || botIds.has(botId)) void this.end(session, "revoked", true);
      }
      for (const botKey of [...this.consents.keys()]) {
        const botId = this.botIdOf(botKey);
        if (botId === null || botIds.has(botId)) this.withdrawConsent(botKey);
      }
    });
  }

  private botIdOf(botKey: string): string | null { return this.botIds.get(botKey) ?? null; }

  handlers(): Map<string, OperationHandler> {
    return new Map<string, OperationHandler>([
      [CUA_STATUS, (_args, context) => this.track(this.statusOf(context))],
      [CUA_OBSERVE, (args, context) => this.track(this.observe(context, args))],
      [CUA_CONTROL, (args, context) => this.track(this.control(context, args))],
    ]);
  }

  /** Session view without labels or element data. */
  status(): { helper: boolean; sessions: Array<{ sessionId: string; expiresAt: number }>; consentsPending: number } {
    return {
      helper: this.transport?.alive ?? false,
      sessions: [...this.sessions.values()].map((s) => ({ sessionId: s.sessionId, expiresAt: s.expiresAt })),
      consentsPending: [...this.consents.values()].filter((c) => c.state === "pending").length,
    };
  }

  /**
   * Local owner intent (never reachable from a job): allows one new consent prompt for a bot whose last one
   * was denied or expired. It grants nothing and starts no session.
   */
  rearmConsent(botId: string): void {
    for (const [botKey, consent] of [...this.consents]) {
      if (consent.state !== "pending" && this.botIdOf(botKey) === botId) this.consents.delete(botKey);
    }
  }
  toJSON(): object { return this.status(); }
  [inspect.custom](): object { return this.status(); }

  /** Daemon stop: ends sessions, asks the helper to exit, kills it after the bound, then waits for in-flight work. */
  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe();
    for (const session of [...this.sessions.values()]) void this.end(session, "daemon", true);
    this.consents.clear();
    const transport = this.transport;
    this.transport = null;
    if (transport) await transport.close(this.closeTimeoutMs);
    await Promise.allSettled([...this.inflight]);
  }

  // ---- operations ------------------------------------------------------------------------------

  /**
   * The calling bot's own session after the helper re-checked its gates, or a pending consent prompt.
   * Never another bot's session, never labels, apps or raw helper state.
   */
  private async statusOf(context: HandlerContext): Promise<JsonValue> {
    const { job, auth, transport, botKey } = this.admit(context, CUA_STATUS);
    const scope = new OperationScope([{ signal: context.signal, reason: "daemon_stopping" }],
      Math.min(job.deadlineAt, this.clock() + this.requestTimeoutMs), this.clock);
    try {
      if (scope.aborted) throw new HandlerRefusal(scope.reason!);
      const session = this.sessions.get(botKey);
      if (session && this.clock() >= session.expiresAt) void this.end(session, "expired", true);
      else if (session) {
        scope.link(session.ended.signal, () => session.endReason ?? "session_ended");
        let response;
        try {
          response = await transport.request({ op: "check", sessionId: session.sessionId, surfaceId: session.surfaceId }, scope.signal);
        } catch (error) {
          // A status read changes nothing; an interrupted one releases nothing.
          this.drainIfUnresponsive(error, scope);
          throw new HandlerRefusal(scope.reason ?? session.endReason ?? "cua_unavailable");
        }
        if (!this.current(auth, session, scope)) throw new HandlerRefusal(scope.reason ?? session.endReason ?? "revoked");
        if (response.ok !== true) throw this.refusal(response);
        if (this.clock() >= session.expiresAt) { void this.end(session, "expired", true); throw new HandlerRefusal("session_expired"); }
        return { state: "active", session: { sessionId: session.sessionId, surfaceId: session.surfaceId, expiresAt: session.expiresAt } };
      }
      const last = this.consentOf(botKey, auth);
      if (last?.state === "pending") return { state: "consent_pending", promptExpiresAt: last.promptExpiresAt };
      // Denied or lapsed: reported, never re-asked on the bot's initiative.
      if (last) return { state: last.state === "denied" ? "consent_denied" : "consent_expired" };
      let response;
      try {
        response = await this.askConsent(botKey, auth, transport, scope.signal);
      } catch (error) {
        this.drainIfUnresponsive(error, scope);
        throw new HandlerRefusal(scope.reason ?? "cua_unavailable");
      }
      // The grant may have changed while the helper answered: then the prompt was withdrawn already.
      if (!this.policy.isCurrent(auth) || scope.aborted) throw new HandlerRefusal(scope.reason ?? "revoked");
      const consent = this.consentOf(botKey, auth);
      if (response.ok !== true || !consent) throw this.refusal(response);
      // The operator may already have answered (or the prompt lapsed) while the helper replied.
      if (consent.state !== "pending") return { state: consent.state === "denied" ? "consent_denied" : "consent_expired" };
      return { state: "consent_pending", promptExpiresAt: consent.promptExpiresAt };
    } finally { scope.dispose(); }
  }

  private async observe(context: HandlerContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const { job, auth, session, scope, transport } = this.begin(context, CUA_OBSERVE, args.surfaceId as string);
    try {
      let response;
      try {
        response = await transport.request({ op: "observe", sessionId: session.sessionId, surfaceId: session.surfaceId, maxNodes: args.maxNodes as number }, scope.signal);
      } catch (error) {
        // Observation changes nothing on the Mac; an interrupted one is a refusal and releases no data.
        this.drainIfUnresponsive(error, scope);
        throw new HandlerRefusal(scope.reason ?? session.endReason ?? "cua_unavailable");
      }
      if (!this.current(auth, session, scope)) throw new HandlerRefusal(scope.reason ?? session.endReason ?? "revoked");
      if (response.ok !== true) throw this.refusal(response);
      return this.observation(job, session, response);
    } finally { scope.dispose(); }
  }

  private async control(context: HandlerContext, args: Record<string, JsonValue>): Promise<JsonValue> {
    const { auth, session, scope, transport } = this.begin(context, CUA_CONTROL, args.surfaceId as string);
    try {
      const message: Record<string, JsonValue> = { op: "control", sessionId: session.sessionId, surfaceId: session.surfaceId, elementId: args.elementId!, action: args.action! };
      if (args.value !== undefined) message.value = args.value;
      let response;
      try {
        response = await transport.request(message, scope.signal);
      } catch (error) {
        this.drainIfUnresponsive(error, scope);
        // Handed to the helper and not confirmed: the input may have been delivered.
        throw new OutcomeUncertain(scope.reason ?? session.endReason ?? "helper_unavailable");
      }
      if (response.ok !== true) {
        if (response.effect === "none") throw this.refusal(response);
        throw new OutcomeUncertain("action_unconfirmed");
      }
      if (response.performed !== true) throw new OutcomeUncertain("action_unconfirmed");
      // Confirmed by the helper. If the session ended meanwhile the action still happened; say so.
      const stillCurrent = this.current(auth, session, scope);
      return { performed: true, sessionActive: stillCurrent, ...(stillCurrent ? {} : { endedBy: scope.reason ?? session.endReason ?? "revoked" }) };
    } finally { scope.dispose(); }
  }

  // ---- gates -----------------------------------------------------------------------------------

  /** Trusted job, local grant with a CUA bound, open capability and a helper; nothing else is decided here. */
  private admit(context: HandlerContext, tool: string): { job: TrustedJobContext; auth: Authorization; transport: CuaTransport; botKey: string } {
    const job = requireJob(context, tool);
    const auth = this.policy.authorize(job, tool);
    if (auth.grant.cuaMaxSessionSeconds === 0) throw new HandlerRefusal("not_granted");
    if (this.closed) throw new HandlerRefusal("capability_closed");
    const transport = this.ensureTransport();
    const botKey = botKeyOf(job);
    this.botIds.set(botKey, job.botId);
    return { job, auth, transport, botKey };
  }

  private begin(context: HandlerContext, tool: string, surfaceId: string): { job: TrustedJobContext; auth: Authorization; session: CuaSession; scope: OperationScope; transport: CuaTransport } {
    const { job, auth, transport, botKey } = this.admit(context, tool);
    const session = this.sessions.get(botKey);
    if (!session) {
      const last = this.consentOf(botKey, auth);
      if (last === null) {
        this.askConsent(botKey, auth, transport, AbortSignal.timeout(this.requestTimeoutMs)).catch(() => { /* withdrawn below */ });
      } else if (last.state !== "pending") {
        throw new HandlerRefusal(last.state === "denied" ? "consent_denied" : "consent_expired");
      }
      throw new HandlerRefusal("consent_required");
    }
    if (session.surfaceId !== surfaceId) throw new HandlerRefusal("surface_mismatch");
    if (this.clock() >= session.expiresAt) {
      void this.end(session, "expired", true);
      throw new HandlerRefusal("session_expired");
    }
    const scope = new OperationScope([
      { signal: context.signal, reason: "daemon_stopping" },
    ], Math.min(job.deadlineAt, this.clock() + this.requestTimeoutMs), this.clock);
    scope.link(session.ended.signal, () => session.endReason ?? "session_ended");
    if (scope.aborted) { scope.dispose(); throw new HandlerRefusal(scope.reason!); }
    return { job, auth, session, scope, transport };
  }

  private current(auth: Authorization, session: CuaSession, scope: OperationScope): boolean {
    return this.policy.isCurrent(auth) && session.generation === auth.generation && session.endReason === null
      && this.sessions.get(session.botKey) === session && !scope.aborted;
  }

  private refusal(response: Record<string, unknown>): HandlerRefusal {
    const code = typeof response.code === "string" && CUA_REFUSALS.includes(response.code) ? response.code : "helper_refused";
    return new HandlerRefusal(code);
  }

  /** Non-cooperative drain: a helper that did not answer within the bound is killed. */
  private drainIfUnresponsive(error: unknown, scope: OperationScope): void {
    if (error instanceof CuaTransportError && error.code === "aborted" && scope.reason === "deadline") this.transport?.kill();
  }

  private observation(_job: TrustedJobContext, session: CuaSession, response: Record<string, unknown>): JsonValue {
    const surface = response.surface as { surfaceId?: unknown; label?: unknown } | undefined;
    if (!surface || surface.surfaceId !== session.surfaceId || !Array.isArray(response.nodes)) throw new HandlerRefusal("helper_refused");
    const nodes: JsonValue[] = [];
    let truncated = response.truncated === true;
    let size = 512;
    for (const raw of response.nodes as unknown[]) {
      const n = raw as Record<string, unknown>;
      if (typeof n.elementId !== "string" || !ELEMENT_ID.test(n.elementId) || typeof n.role !== "string") throw new HandlerRefusal("helper_refused");
      const node = {
        elementId: n.elementId, role: boundText(n.role, 48, 192).text, enabled: n.enabled === true,
        title: boundText(typeof n.title === "string" ? n.title : "", MAX_NODE_TEXT, 640).text,
        value: boundText(typeof n.value === "string" ? n.value : "", MAX_NODE_TEXT, 640).text,
      };
      const encoded = Buffer.byteLength(JSON.stringify(node));
      if (size + encoded > MAX_RESULT_BYTES) { truncated = true; break; }
      size += encoded;
      nodes.push(node);
    }
    return {
      // Element titles and values come from another app: data, never instructions.
      trust: "untrusted_external", source: "accessibility",
      surface: { surfaceId: session.surfaceId, label: boundText(typeof surface.label === "string" ? surface.label : "", 80, 320).text },
      nodes, truncated, session: { sessionId: session.sessionId, expiresAt: session.expiresAt },
    };
  }

  // ---- helper, consent and sessions ------------------------------------------------------------

  /** Owner startup admission: warm the same helper transport without a bot, grant, request or session. */
  prepareForOwner(): void {
    if(this.closed)throw new HandlerRefusal("capability_closed");
    this.ensureTransport();
  }

  private ensureTransport(): CuaTransport {
    if (this.transport?.alive) return this.transport;
    let transport: CuaTransport;
    try { transport = this.makeTransport(); } catch { throw new HandlerRefusal("cua_unavailable"); }
    this.transport = transport;
    this.dropPendingConsents();
    transport.onEvent((event) => { if (this.transport === transport) this.onEvent(event); });
    transport.onExit(() => {
      // The helper owned the indicator, the prompt and the sessions; with it gone, none survives.
      for (const session of [...this.sessions.values()]) void this.end(session, "helper_exit", false);
      if (this.transport === transport) { this.transport = null; this.dropPendingConsents(); }
    });
    return transport;
  }

  /**
   * The bot's last prompt under its current grant: still `pending` only before its deadline (this side's
   * clock, even when the helper's `consent_expired` event never arrives), then `expired`. A record of an
   * older generation is dropped.
   */
  private consentOf(botKey: string, auth: Authorization): Consent | null {
    const consent = this.consents.get(botKey);
    if (!consent) return null;
    if (consent.generation !== auth.generation) { this.consents.delete(botKey); return null; }
    if (consent.state === "pending" && this.clock() >= consent.promptExpiresAt) consent.state = "expired";
    return consent;
  }
  /** A helper that (re)starts or exits shows no prompt any more; closed records stay. */
  private dropPendingConsents(): void {
    for (const [botKey, consent] of [...this.consents]) if (consent.state === "pending") this.consents.delete(botKey);
  }

  /**
   * Asks the helper to show the consent prompt. The label and session bound come from the local policy,
   * never from the job; the prompt deadline is this side's bound. The helper refuses while another prompt or
   * session is open, the screen is (or may be) locked or permission is missing.
   */
  private async askConsent(botKey: string, auth: Authorization, transport: CuaTransport, signal: AbortSignal): Promise<Record<string, unknown>> {
    const bound = this.clock() + this.promptSeconds * 1000;
    const consent: Consent = { generation: auth.generation, promptExpiresAt: bound, state: "pending" };
    this.consents.set(botKey, consent);
    let response: Record<string, unknown>;
    try {
      response = await transport.request({ op: "request_consent", botKey, botLabel: auth.grant.label, maxSeconds: auth.grant.cuaMaxSessionSeconds,
        promptSeconds: this.promptSeconds }, signal);
    } catch (error) {
      if (this.consents.get(botKey) === consent) this.consents.delete(botKey);
      throw error;
    }
    if (this.consents.get(botKey) !== consent) return response;
    if (response.ok !== true) { this.consents.delete(botKey); return response; }
    // The helper's own deadline, never later than the one this side asked for.
    if (typeof response.promptExpiresAt === "number" && Number.isSafeInteger(response.promptExpiresAt)) {
      consent.promptExpiresAt = Math.min(bound, response.promptExpiresAt);
    }
    return response;
  }

  /** Forgets the bot's prompt and asks the helper to close it; a helper that does not answer is killed. */
  private withdrawConsent(botKey: string): void {
    this.consents.delete(botKey);
    const transport = this.transport;
    if (!transport?.alive) return;
    transport.request({ op: "cancel_consent", botKey }, AbortSignal.timeout(this.requestTimeoutMs))
      .then((r) => { if (r.ok !== true) transport.kill(); }, () => { transport.kill(); });
  }

  private onEvent(event: Record<string, unknown>): void {
    if (event.event === "session_started") {
      const s = event.session as Record<string, unknown> | undefined;
      if (!s || typeof s.sessionId !== "string" || !SESSION_ID.test(s.sessionId) || typeof s.botKey !== "string"
        || typeof s.surfaceId !== "string" || !SURFACE_ID.test(s.surfaceId) || typeof s.expiresAt !== "number" || s.indicatorVisible !== true) {
        this.transport?.kill();
        return;
      }
      const consent = this.consents.get(s.botKey);
      const botId = this.botIdOf(s.botKey);
      const generation = botId === null ? null : this.policy.generation(botId);
      const grant = botId === null ? null : this.policy.grantOf(botId);
      const now = this.clock();
      // An approval after the prompt's deadline closes it as expired (no renewal); it never clears it.
      if (consent?.state === "pending" && now > consent.promptExpiresAt + EVENT_SLACK_MS) consent.state = "expired";
      const previous = this.sessions.get(s.botKey);
      if (previous) void this.end(previous, "daemon", true);
      const session: CuaSession = {
        sessionId: s.sessionId, botKey: s.botKey, surfaceId: s.surfaceId, expiresAt: s.expiresAt, generation: generation ?? -1,
        ended: new AbortController(), endReason: null,
      };
      this.sessions.set(s.botKey, session);
      // Admitted only from a prompt this side asked for, under the bot's current grant, answered in time and
      // within the bot's session bound. Anything else (a bot that never asked, a revoked or changed grant, a
      // late approval) is ended at once.
      const admitted = consent !== undefined && consent.state === "pending" && grant !== null && grant.cuaMaxSessionSeconds > 0 && generation !== null
        && consent.generation === generation && now <= consent.promptExpiresAt + EVENT_SLACK_MS
        && s.expiresAt <= now + grant.cuaMaxSessionSeconds * 1000 + EVENT_SLACK_MS;
      if (admitted) this.consents.delete(s.botKey);
      else void this.end(session, "daemon", true);
      return;
    }
    if (event.event === "session_ended") {
      const reason = typeof event.reason === "string" && SESSION_END_REASONS.includes(event.reason) ? event.reason : "session_ended";
      for (const session of [...this.sessions.values()]) if (session.sessionId === event.sessionId) void this.end(session, reason, false);
      return;
    }
    if ((event.event === "consent_denied" || event.event === "consent_expired") && typeof event.botKey === "string") {
      const consent = this.consents.get(event.botKey);
      if (consent?.state === "pending") consent.state = event.event === "consent_denied" ? "denied" : "expired";
    }
  }

  private async end(session: CuaSession, reason: string, notifyHelper: boolean): Promise<void> {
    if (session.endReason === null) session.endReason = reason;
    session.ended.abort();
    if (this.sessions.get(session.botKey) === session) this.sessions.delete(session.botKey);
    const transport = this.transport;
    if (notifyHelper && transport?.alive) {
      try {
        const r = await transport.request({ op: "end_session", sessionId: session.sessionId, reason: "daemon" }, AbortSignal.timeout(this.requestTimeoutMs));
        if (r.ok !== true) transport.kill();
      } catch { transport.kill(); }
    }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inflight.add(promise);
    const clear = (): void => { this.inflight.delete(promise); };
    promise.then(clear, clear);
    return promise;
  }
}

export { CuaTransportError };
