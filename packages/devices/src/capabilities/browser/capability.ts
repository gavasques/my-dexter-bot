import { inspect } from "node:util";
import type { JsonValue } from "@dexter/contracts";
import { DeviceError } from "../../errors.js";
import { HandlerRefusal, type HandlerContext, type OperationHandler, type TrustedJobContext } from "../../handlers.js";
import { BROWSER_CLOSE, BROWSER_NAVIGATE, BROWSER_READ } from "../../operations.js";
import { OperationScope, OutcomeUncertain, boundText, botKeyOf, requireJob, settlesWithin, untilAborted, type UntrustedText } from "../context.js";
import type { Authorization, LocalCapabilityPolicy } from "../policy.js";
import { BrowserDriverError, type BrowserDriver, type BrowserSession } from "./driver.js";
import { BrowserProfileStore, type ProfileLease } from "./profiles.js";

/** UTF-8 budget of returned page text; the receipt itself is bounded at 16 KiB. */
export const MAX_TEXT_BYTES = 12 * 1024;
const MAX_TITLE_CHARS = 200;

export interface BrowserCapabilityOptions {
  /** Private directory owned by the daemon (e.g. `<dataDir>/capabilities/browser`). */
  root: string;
  policy: LocalCapabilityPolicy;
  driver: BrowserDriver;
  clock?: () => number;
  closeTimeoutMs?: number;
}

interface Slot {
  readonly botId: string;
  readonly botKey: string;
  readonly lease: ProfileLease;
  readonly session: BrowserSession;
  /** Aborted when the slot is torn down (revocation, takeover, close); in-flight work sees it after each await. */
  readonly ended: AbortController;
  endReason: string | null;
}

/**
 * A browser being started for one bot. It is fenced like a slot: revocation, takeover and shutdown set
 * `endReason` and abort `ended` (which the driver receives as its launch signal). A browser that still
 * comes up afterwards is never admitted: it is closed (killed after the bound) and its lock released.
 */
interface LaunchState {
  readonly botId: string;
  readonly botKey: string;
  readonly ended: AbortController;
  endReason: string | null;
}
interface Launch extends LaunchState { readonly promise: Promise<Slot> }
/** Outcome of ending one browser: `drained` is false when its processes could not be shown gone. */
interface Teardown { forced: boolean; drained: boolean }

/**
 * Browser per bot. Each bot gets its own persistent profile under the daemon's private directory and at
 * most one live browser process, launched lazily by its first granted navigation. The bot is taken from
 * the trusted job context, never from arguments, so a bot can only reach its own session and results.
 *
 * Gates, in order, all before any effect: trusted job context, the operator's local grant for this bot
 * and operation, and for navigation the URL's origin in that bot's granted origins. Then, after every
 * await, the grant generation, the slot and the scope are checked again. A navigation that was handed to
 * the browser and then cancelled, revoked, taken over or timed out is `unknown` (it may have loaded).
 *
 * `takeover(botId)` and policy revocation end the bot's session preemptively: in-flight work is aborted,
 * the browser is closed (forced after a bound) and its profile lock is released; the profile stays.
 *
 * A browser counts as ended only when the driver observed every one of its processes gone. If that cannot
 * be shown (even after a kill and the bound) the bot is quarantined for this daemon run: its profile lock
 * is kept, its operations refuse `browser_quarantined`, and `takeover`/`close` reject, so the daemon's stop
 * keeps its resources failure. Clearing it needs the operator (check the processes, restart the daemon).
 */
export class BrowserCapability {
  readonly profiles: BrowserProfileStore;
  private readonly policy: LocalCapabilityPolicy;
  private readonly driver: BrowserDriver;
  private readonly clock: () => number;
  private readonly closeTimeoutMs: number;
  private readonly slots = new Map<string, Slot>();
  private readonly starting = new Map<string, Launch>();
  /** Per-bot serialization: one operation at a time on a bot's browser. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly teardowns = new Set<Promise<Teardown>>();
  /** Bots whose browser processes could not be shown gone; their profile lock stays held. */
  private readonly quarantined = new Map<string, string>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(options: BrowserCapabilityOptions) {
    this.profiles = new BrowserProfileStore(options.root);
    this.policy = options.policy;
    this.driver = options.driver;
    this.clock = options.clock ?? Date.now;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    this.unsubscribe = this.policy.onChange((botIds) => {
      for (const launch of [...this.starting.values()]) if (botIds.has(launch.botId)) this.abortLaunch(launch, "revoked");
      for (const slot of [...this.slots.values()]) if (botIds.has(slot.botId)) void this.endSlot(slot, "revoked");
    });
  }

  handlers(): Map<string, OperationHandler> {
    return new Map<string, OperationHandler>([
      [BROWSER_NAVIGATE, async (args, context) => this.serialized(context, BROWSER_NAVIGATE, (job, auth, scope) => this.navigate(job, auth, scope, args.url as string))],
      [BROWSER_READ, async (args, context) => this.serialized(context, BROWSER_READ, (job, auth, scope) => this.read(job, auth, scope, args.maxChars as number))],
      [BROWSER_CLOSE, async (_args, context) => this.serialized(context, BROWSER_CLOSE, (job) => this.closeBot(job))],
    ]);
  }

  /**
   * Local operator takeover/stop for one bot: preempts in-flight work, including a browser still starting,
   * and resolves once its browser exited and the profile lock was released.
   */
  async takeover(botId: string): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const launch of [...this.starting.values()]) {
      if (launch.botId !== botId) continue;
      this.abortLaunch(launch, "takeover");
      pending.push(launch.promise.catch(() => undefined));
    }
    for (const slot of [...this.slots.values()]) if (slot.botId === botId) pending.push(this.endSlot(slot, "takeover"));
    await Promise.all(pending);
    await Promise.all([...this.teardowns]);
    if ([...this.quarantined.values()].includes(botId)) throw new DeviceError("unavailable", "browser processes not drained");
  }

  /** Status without URLs, titles, paths or profile contents. */
  status(): { sessions: Array<{ botId: string; generation: number; alive: boolean; blockedRequests: number }>; quarantined: number } {
    return {
      sessions: [...this.slots.values()].map((s) => ({ botId: s.botId, generation: s.lease.generation, alive: s.session.alive, blockedRequests: s.session.blockedRequests() })),
      quarantined: this.quarantined.size,
    };
  }
  toJSON(): object { return this.status(); }
  [inspect.custom](): object { return this.status(); }

  /**
   * Ends every session (daemon stop). Launches still starting are aborted and, if their browser comes up
   * anyway, closed. Resolves once every browser's processes are gone (forced after the close bound) and
   * locks were released; rejects (`unavailable`) when any bot is quarantined.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe();
    const launches = [...this.starting.values()];
    for (const launch of launches) this.abortLaunch(launch, "shutdown");
    for (const slot of [...this.slots.values()]) void this.endSlot(slot, "shutdown");
    await Promise.allSettled(launches.map((l) => l.promise));
    for (const slot of [...this.slots.values()]) void this.endSlot(slot, "shutdown");
    await Promise.all([...this.teardowns]);
    if (this.quarantined.size > 0) throw new DeviceError("unavailable", "browser processes not drained");
  }

  // ---- operations ------------------------------------------------------------------------------

  private async navigate(job: TrustedJobContext, auth: Authorization, scope: OperationScope, url: string): Promise<JsonValue> {
    const origin = new URL(url).origin;
    if (!this.policy.originAllowed(job.botId, origin)) throw new HandlerRefusal("origin_not_granted");
    const slot = await this.slotFor(job, auth, scope);
    scope.link(slot.ended.signal, () => slot.endReason ?? "session_ended");
    this.fence(auth, slot, scope);
    let result;
    try {
      result = await untilAborted(slot.session.navigate(url, scope.signal), scope.signal);
    } catch (error) {
      // The navigation was handed to this bot's browser: whatever stopped it, the page may have loaded.
      throw new OutcomeUncertain(slot.endReason ?? scope.reason ?? (error instanceof BrowserDriverError ? `driver_${error.code}` : "interrupted"));
    }
    // Confirmed by the browser. If the grant or session changed meanwhile the navigation still happened,
    // but nothing about the page is released to the bot.
    const current = this.policy.isCurrent(auth) && slot.endReason === null && this.slots.get(slot.botKey) === slot;
    if (!current) return { outcome: result.outcome, url: null, withheld: this.policy.isCurrent(auth) ? (slot.endReason ?? "session_ended") : "revoked" };
    const finalOrigin = safeOrigin(result.url);
    return {
      outcome: result.outcome,
      // The final URL is reported only when it is on a granted origin; otherwise only that it was not.
      url: finalOrigin !== null && this.policy.originAllowed(job.botId, finalOrigin) ? result.url : null,
      blockedRequests: slot.session.blockedRequests(),
      session: { generation: slot.lease.generation },
    };
  }

  private async read(job: TrustedJobContext, auth: Authorization, scope: OperationScope, maxChars: number): Promise<JsonValue> {
    const slot = this.slots.get(botKeyOf(job));
    if (!slot || !slot.session.alive) throw new HandlerRefusal("no_session");
    scope.link(slot.ended.signal, () => slot.endReason ?? "session_ended");
    this.fence(auth, slot, scope);
    let page;
    try {
      page = await untilAborted(slot.session.read(scope.signal), scope.signal);
    } catch {
      // Reading has no effect on the page; nothing is released after an interruption.
      throw new HandlerRefusal(slot.endReason ?? scope.reason ?? "read_failed");
    }
    this.fence(auth, slot, scope);
    // `page.url` is the browser's own target metadata, not page script; it is re-checked against the grant as
    // it is now, so a page that moved off a granted origin (or an origin revoked meanwhile) releases nothing.
    const origin = safeOrigin(page.url);
    if (origin === null || !this.policy.originAllowed(job.botId, origin)) throw new HandlerRefusal("origin_not_granted");
    const text = boundText(page.text, maxChars, MAX_TEXT_BYTES);
    const title = boundText(page.title, MAX_TITLE_CHARS, 1024);
    const content: UntrustedText = { trust: "untrusted_external", source: "web", text: text.text, truncated: text.truncated || page.truncatedAtSource };
    return {
      url: page.url, origin,
      title: { trust: "untrusted_external", source: "web", text: title.text, truncated: title.truncated },
      content: content as unknown as JsonValue,
      session: { generation: slot.lease.generation },
    } as JsonValue;
  }

  private async closeBot(job: TrustedJobContext): Promise<JsonValue> {
    const slot = this.slots.get(botKeyOf(job));
    if (!slot) return { closed: false };
    const { forced, drained } = await this.endSlot(slot, "closed");
    // The browser was told to close but some of its processes may still run: not a confirmed close.
    if (!drained) throw new OutcomeUncertain("browser_undrained");
    // `forced`: not every process exited on its own within the bound and the group was killed. Profile
    // persistence is best effort either way.
    return { closed: true, forced, session: { generation: slot.lease.generation } };
  }

  // ---- sessions --------------------------------------------------------------------------------

  private serialized(context: HandlerContext, tool: string, run: (job: TrustedJobContext, auth: Authorization, scope: OperationScope) => Promise<JsonValue>): Promise<JsonValue> {
    const job = requireJob(context, tool);
    const auth = this.policy.authorize(job, tool);
    if (this.closed) throw new HandlerRefusal("capability_closed");
    const key = botKeyOf(job);
    if (this.quarantined.has(key)) throw new HandlerRefusal("browser_quarantined");
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(async () => {
      const scope = new OperationScope([{ signal: context.signal, reason: "daemon_stopping" }], job.deadlineAt, this.clock);
      try {
        if (scope.aborted) throw new HandlerRefusal(scope.reason!);
        if (!this.policy.isCurrent(auth)) throw new HandlerRefusal("revoked");
        return await run(job, auth, scope);
      } finally { scope.dispose(); }
    });
    const tail = next.then(() => undefined, () => undefined);
    this.queues.set(key, tail);
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key); });
    return next;
  }

  private async slotFor(job: TrustedJobContext, auth: Authorization, scope: OperationScope): Promise<Slot> {
    const key = botKeyOf(job);
    const existing = this.slots.get(key);
    if (existing && existing.session.alive && existing.endReason === null) return existing;
    if (existing) {
      await untilAborted(this.endSlot(existing, "crashed"), scope.signal).catch(() => undefined);
      this.admissible(auth, key, scope);
    }
    // A launch aborted for an earlier grant (revoked, then granted again) is never joined: wait until it
    // settled (its browser closed and the lock released), then start a new one under the current grant.
    const aborted = this.starting.get(key);
    if (aborted && aborted.endReason !== null) {
      await untilAborted(aborted.promise.then(() => undefined, () => undefined), scope.signal).catch(() => undefined);
      this.admissible(auth, key, scope);
    }
    let launch = this.starting.get(key);
    if (!launch) {
      const state: LaunchState = { botId: job.botId, botKey: key, ended: new AbortController(), endReason: null };
      const created: Launch = Object.assign(state, { promise: this.launch(state) });
      this.starting.set(key, created);
      const clear = (): void => { if (this.starting.get(key) === created) this.starting.delete(key); };
      created.promise.then(clear, clear);
      launch = created;
    }
    // The waiting operation stops with the launch: a revoked or taken-over start admits no navigation.
    const current = launch;
    scope.link(current.ended.signal, () => current.endReason ?? "session_ended");
    try {
      return await untilAborted(current.promise, scope.signal);
    } catch (error) {
      // Starting this bot's own browser is not the requested effect; nothing reached a site yet.
      if (scope.reason !== null) throw new HandlerRefusal(scope.reason);
      if (error instanceof HandlerRefusal) throw error;
      throw new HandlerRefusal("browser_unavailable");
    }
  }

  /** After a wait inside `slotFor`: still the same grant, not stopped, not quarantined, capability open. */
  private admissible(auth: Authorization, key: string, scope: OperationScope): void {
    if (scope.aborted) throw new HandlerRefusal(scope.reason!);
    if (!this.policy.isCurrent(auth)) throw new HandlerRefusal("revoked");
    if (this.closed) throw new HandlerRefusal("capability_closed");
    if (this.quarantined.has(key)) throw new HandlerRefusal("browser_quarantined");
    const pending = this.starting.get(key);
    if (pending && pending.endReason !== null) throw new HandlerRefusal(pending.endReason);
  }

  private abortLaunch(launch: LaunchState, reason: string): void {
    if (launch.endReason === null) launch.endReason = reason;
    launch.ended.abort();
  }

  private async launch(launch: LaunchState): Promise<Slot> {
    const { botId, botKey, ended } = launch;
    if (this.closed) throw new HandlerRefusal("capability_closed");
    if (this.quarantined.has(botKey)) throw new HandlerRefusal("browser_quarantined");
    const lease = this.profiles.acquire(botKey);
    let session: BrowserSession;
    try {
      session = await this.driver.launch({
        profileDir: lease.profileDir, homeDir: lease.homeDir, signal: ended.signal,
        allowRequest: (url) => {
          const origin = safeOrigin(url);
          return !ended.signal.aborted && origin !== null && this.policy.originAllowed(botId, origin);
        },
      });
    } catch (error) {
      // A failed start whose processes could not be shown gone keeps the lock: the bot is quarantined.
      if (error instanceof BrowserDriverError && error.code === "undrained") {
        this.quarantined.set(botKey, botId);
        throw new HandlerRefusal("browser_quarantined");
      }
      lease.release();
      throw new HandlerRefusal(launch.endReason ?? "browser_unavailable");
    }
    const slot: Slot = { botId, botKey, lease, session, ended, endReason: launch.endReason };
    // A driver that ignored the abort still returned a live browser: it is closed, never admitted.
    if (launch.endReason !== null || this.closed) {
      const reason = launch.endReason ?? "shutdown";
      slot.endReason = reason;
      await this.teardown(slot, reason);
      throw new HandlerRefusal(reason === "shutdown" ? "capability_closed" : reason);
    }
    this.slots.set(botKey, slot);
    // A browser that dies on its own ends the slot; the profile lock is released only after exit.
    void session.exited.then(() => { if (slot.endReason === null) void this.endSlot(slot, "crashed"); });
    return slot;
  }

  private endSlot(slot: Slot, reason: string): Promise<Teardown> {
    if (slot.endReason === null) slot.endReason = reason;
    slot.ended.abort();
    if (this.slots.get(slot.botKey) === slot) this.slots.delete(slot.botKey);
    return this.teardown(slot, reason);
  }
  /**
   * Graceful close. If the driver's close rejects, the browser is killed and `gone` (every process observed
   * gone) is awaited within the bound. The lock is released only once the processes are shown gone;
   * otherwise the bot is quarantined and the lock stays. Never rejects.
   */
  private teardown(slot: Slot, _reason: string): Promise<Teardown> {
    const done = (async (): Promise<Teardown> => {
      let forced: boolean;
      try {
        forced = (await slot.session.close(this.closeTimeoutMs)).forced;
      } catch {
        forced = true;
        slot.session.kill();
        if (!(await settlesWithin(slot.session.gone, this.closeTimeoutMs))) {
          this.quarantined.set(slot.botKey, slot.botId);
          return { forced, drained: false };
        }
      }
      slot.lease.release();
      return { forced, drained: true };
    })();
    this.teardowns.add(done);
    void done.finally(() => { this.teardowns.delete(done); });
    return done;
  }

  /** Fencing before the effect and after every await: same grant generation, same live slot, scope not aborted. */
  private fence(auth: Authorization, slot: Slot, scope: OperationScope): void {
    if (this.policy.isCurrent(auth) && slot.endReason === null && this.slots.get(slot.botKey) === slot && !scope.aborted) return;
    throw new HandlerRefusal(this.policy.isCurrent(auth) ? (slot.endReason ?? scope.reason ?? "session_ended") : "revoked");
  }
}

function safeOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch { return null; }
}
