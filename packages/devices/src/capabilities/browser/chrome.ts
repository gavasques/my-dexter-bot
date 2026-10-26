import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { DeviceError } from "../../errors.js";
import { settlesWithin } from "../context.js";
import { CdpError, CdpPipe, type CdpEvent } from "./cdp-pipe.js";
import { EgressProxy } from "./egress-proxy.js";
import { BrowserDriverError, type BrowserDriver, type BrowserLaunch, type BrowserSession, type NavigateResult, type PageSnapshot } from "./driver.js";

/** Maximum characters of page text taken inside the page before it crosses the pipe. */
export const SOURCE_TEXT_LIMIT = 32_768;
/**
 * Attempts to read the owned target's URL (`Target.getTargetInfo`, metadata only). The read is repeated
 * when Chromium answers with an error or with an empty URL; only this read is retried, never the navigation
 * or any other effect.
 */
export const TARGET_URL_ATTEMPTS = 3;
/** Poll interval bounds while waiting for the browser's process group to be gone (evidence, not a timer). */
const GROUP_POLL_MIN_MS = 10;
const GROUP_POLL_MAX_MS = 250;
/**
 * The only script the driver ever evaluates. It is a constant of this module: no part of it comes from a
 * job, a page or configuration, and it only reads title, location and visible text. The `url` it reports
 * is page-controlled and is ignored: the URL of a snapshot is the browser's own target metadata.
 */
export const READ_EXPRESSION = `(() => { const b = document.body; const t = b ? String(b.innerText) : "";
return { title: String(document.title).slice(0, 512), url: String(location.href).slice(0, 4096), text: t.slice(0, ${SOURCE_TEXT_LIMIT}), more: t.length > ${SOURCE_TEXT_LIMIT} }; })()`;

/** Fixed browser flags. Nothing here is configurable by a job; the profile is the bot's own directory. */
export function chromeArguments(profileDir: string, proxyPort: number): string[] {
  const args = [
    "--remote-debugging-pipe", `--user-data-dir=${profileDir}`, "--headless", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions", "--disable-default-apps",
    "--disable-domain-reliability", "--disable-client-side-phishing-detection", "--metrics-recording-only", "--no-service-autorun",
    // Credentials stay out of the login Keychain: Keychain secrets are not part of this capability.
    "--use-mock-keychain", "--password-store=basic", "--deny-permission-prompts", "--mute-audio",
    "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication",
    // All traffic, loopback included, goes through this session's egress filter; no direct connections.
    `--proxy-server=http://127.0.0.1:${proxyPort}`, "--proxy-bypass-list=<-loopback>",
    // WebRTC may not use UDP outside the proxy, i.e. not at all.
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];
  args.push("about:blank");
  return args;
}

/** `loopback_only` (lab/proof): the egress filter also refuses every non-loopback upstream, granted or not. */
export type ChromeNetworkIsolation = "none" | "loopback_only";
export interface ChromeDriverOptions {
  /** Absolute path of a Chromium-family executable chosen by the operator (trusted configuration). */
  executable: string;
  networkIsolation?: ChromeNetworkIsolation;
  launchTimeoutMs?: number;
  commandTimeoutMs?: number;
}

/**
 * Launches a dedicated Chromium process per bot session, with that bot's profile as `--user-data-dir`
 * and the DevTools protocol only on the spawned process's pipe (`--remote-debugging-pipe`): no port, no
 * attachment to an existing browser or profile. Every target (page, popup, frame, worker) is
 * auto-attached paused, request interception is enabled on it before it runs, and each request is
 * checked against the bot's grant. Popups and extra pages are closed. Downloads and dialogs are refused.
 * If any of that cannot be set up the browser is killed (fail closed).
 */
export class ChromePipeDriver implements BrowserDriver {
  readonly kind = "chrome-pipe";
  private readonly executable: string;
  private readonly networkIsolation: ChromeNetworkIsolation;
  private readonly launchTimeoutMs: number;
  private readonly commandTimeoutMs: number;

  constructor(options: ChromeDriverOptions) {
    if (!isAbsolute(options.executable)) throw new DeviceError("invalid_input", "browser executable must be absolute");
    let stat;
    try { stat = lstatSync(options.executable); } catch { throw new DeviceError("not_found", "browser executable not found"); }
    // A regular file, executable, not writable by group/other, never a symlink that could be repointed.
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) {
      throw new DeviceError("forbidden", "browser executable refused");
    }
    this.executable = options.executable;
    this.networkIsolation = options.networkIsolation ?? "none";
    this.launchTimeoutMs = options.launchTimeoutMs ?? 20_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15_000;
  }
  toJSON(): object { return { kind: this.kind, networkIsolation: this.networkIsolation }; }

  async launch(input: BrowserLaunch): Promise<BrowserSession> {
    if (input.signal.aborted) throw new BrowserDriverError("aborted");
    let proxy: EgressProxy;
    try { proxy = await EgressProxy.start({ allow: input.allowRequest, loopbackOnly: this.networkIsolation === "loopback_only" }); } catch { throw new BrowserDriverError("launch_failed"); }
    let child: ChildProcess;
    try {
      // Own process group (pgid = browser pid): every helper the browser starts (renderer, GPU, network
      // service, crashpad) inherits it, so the session can tell when all of them are gone and signal
      // exactly them, never another browser.
      child = spawn(this.executable, chromeArguments(input.profileDir, proxy.port), {
        cwd: input.homeDir, env: { HOME: input.homeDir }, shell: false, windowsHide: true, detached: true,
        stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      });
    } catch { await proxy.close(); throw new BrowserDriverError("launch_failed"); }
    const session = new ChromeSession(child, input.allowRequest, this.commandTimeoutMs, proxy);
    const launchSignal = AbortSignal.any([input.signal, AbortSignal.timeout(this.launchTimeoutMs)]);
    try {
      await session.initialize(launchSignal);
      return session;
    } catch {
      session.kill();
      if (!(await settlesWithin(session.gone, this.launchTimeoutMs))) throw new BrowserDriverError("undrained");
      throw new BrowserDriverError(input.signal.aborted ? "aborted" : "launch_failed");
    }
  }
}

class ChromeSession implements BrowserSession {
  readonly exited: Promise<void>;
  readonly gone: Promise<void>;
  readonly pid: number | null;
  #groupGone = false;
  #closeResult: Promise<{ forced: boolean }> | null = null;
  #alive = true;
  #blocked = 0;
  #closing = false;
  #ownedTargetId: string | null = null;
  #ownedSession: string | null = null;
  readonly #pipe: CdpPipe;
  readonly #ownedReady: Promise<string>;
  #resolveOwnedTarget!: (targetId: string) => void;
  #resolveOwnedSession!: (sessionId: string) => void;
  readonly #ownedTargetKnown: Promise<string>;

  constructor(private readonly child: ChildProcess, private readonly allowRequest: (url: string) => boolean, private readonly commandTimeoutMs: number,
    private readonly proxy: EgressProxy) {
    this.pid = child.pid ?? null;
    // The session is over only when the browser exited and its egress filter closed.
    this.exited = new Promise<void>((resolve) => {
      child.once("exit", () => { resolve(); });
      child.once("error", () => { resolve(); });
    }).then(async () => { this.#alive = false; await proxy.close(); });
    // Gone only when the process group is observed empty after the browser itself exited.
    this.gone = this.exited.then(() => this.waitGroupGone());
    this.#pipe = new CdpPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
    // An unexpected disconnect kills the group; during a requested close the pipe ends with the browser and
    // its helpers (e.g. the network service writing cookies) must be left to finish and exit on their own.
    this.#pipe.onClose(() => { if (!this.#closing) this.kill(); });
    this.#ownedTargetKnown = new Promise((resolve) => { this.#resolveOwnedTarget = resolve; });
    this.#ownedReady = new Promise((resolve) => { this.#resolveOwnedSession = resolve; });
    this.#pipe.onEvent((event) => { this.onEvent(event); });
  }

  get alive(): boolean { return this.#alive && !this.#pipe.closed; }
  blockedRequests(): number { return this.#blocked + this.proxy.blocked; }

  async initialize(signal: AbortSignal): Promise<void> {
    await this.command("Browser.getVersion", {}, null, signal);
    await this.command("Browser.setDownloadBehavior", { behavior: "deny" }, null, signal);
    await this.command("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, null, signal);
    const created = await this.command("Target.createTarget", { url: "about:blank" }, null, signal);
    if (typeof created.targetId !== "string") throw new BrowserDriverError("protocol");
    this.#ownedTargetId = created.targetId;
    this.#resolveOwnedTarget(created.targetId);
    const sessionId = await raceSignal(this.#ownedReady, signal);
    this.#ownedSession = sessionId;
  }

  /**
   * Only the `load` lifecycle event of this navigation's own loader (frame and loader id from the
   * `Page.navigate` answer) confirms it. A refused navigation leaves an error page whose own load event can
   * arrive after the next `Page.navigate` was sent; matching the loader keeps that from counting.
   */
  async navigate(url: string, signal: AbortSignal): Promise<NavigateResult> {
    const sessionId = this.requireOwned();
    const loaders = new Map<string, { loaded: boolean; url: string | null }>();
    let wake: () => void = () => { /* set once the loader is known */ };
    const entry = (frameId: string, loaderId: string): { loaded: boolean; url: string | null } => {
      const key = `${frameId}\0${loaderId}`;
      let found = loaders.get(key);
      if (!found) { found = { loaded: false, url: null }; loaders.set(key, found); }
      return found;
    };
    const off = this.#pipe.onEvent((event) => {
      if (event.sessionId !== sessionId) return;
      const p = event.params;
      if (event.method === "Page.lifecycleEvent" && p.name === "load" && typeof p.frameId === "string" && typeof p.loaderId === "string") {
        entry(p.frameId, p.loaderId).loaded = true;
        wake();
      } else if (event.method === "Page.frameNavigated") {
        const frame = p.frame as { id?: unknown; parentId?: unknown; loaderId?: unknown; url?: unknown } | undefined;
        if (frame && frame.parentId === undefined && typeof frame.id === "string" && typeof frame.loaderId === "string" && typeof frame.url === "string") {
          entry(frame.id, frame.loaderId).url = frame.url;
        }
      }
    });
    try {
      const result = await this.command("Page.navigate", { url }, sessionId, signal);
      if (typeof result.errorText === "string" && result.errorText !== "") {
        // Refused before anything loaded; the URL is informative only.
        const url = await this.currentUrl(signal, null).catch(() => "");
        return { url, outcome: result.errorText.includes("BLOCKED_BY_CLIENT") ? "blocked" : "failed" };
      }
      let committed: string | null = null;
      if (typeof result.loaderId === "string" && typeof result.frameId === "string") {
        const own = entry(result.frameId, result.loaderId);
        await raceSignal(new Promise<void>((resolve) => {
          if (own.loaded) { resolve(); return; }
          wake = () => { if (own.loaded) resolve(); };
        }), signal);
        committed = own.url;
      } else if (typeof result.loaderId === "string") {
        throw new BrowserDriverError("protocol");
      }
      // The load is confirmed; an unreadable URL does not make it uncertain, it is just not reported.
      return { url: await this.currentUrl(signal, committed), outcome: "loaded" };
    } finally { off(); }
  }

  async read(signal: AbortSignal): Promise<PageSnapshot> {
    const sessionId = this.requireOwned();
    const out = await this.command("Runtime.evaluate", { expression: READ_EXPRESSION, returnByValue: true, awaitPromise: false }, sessionId, signal);
    const remote = out.result as { value?: unknown } | undefined;
    const value = remote?.value as Record<string, unknown> | undefined;
    if (out.exceptionDetails !== undefined || !value || typeof value.title !== "string" || typeof value.text !== "string") {
      throw new BrowserDriverError("protocol");
    }
    // Read after the text: if the page moved meanwhile, the origin checked by the capability is the newer one.
    const url = await this.currentUrl(signal, null);
    if (url === "") throw new BrowserDriverError("protocol");
    return { title: value.title, url, text: value.text, truncatedAtSource: value.more === true };
  }

  /**
   * Resolves only once every process of the browser's group is observed gone: `forced: false` when they all
   * exited after `Browser.close` within the bound, `forced: true` when the group had to be killed. Rejects
   * `undrained` when processes are still there after the kill and a second bound. Repeated calls share one close.
   */
  close(timeoutMs: number): Promise<{ forced: boolean }> {
    this.#closeResult ??= this.closeOnce(timeoutMs);
    return this.#closeResult;
  }
  private async closeOnce(timeoutMs: number): Promise<{ forced: boolean }> {
    if (this.#alive) {
      // Targets detach during a graceful close; that must not turn into a kill before the profile is flushed.
      this.#closing = true;
      this.#pipe.send("Browser.close").catch(() => { /* exit is what counts */ });
    }
    // Helpers (e.g. the network service writing cookies) may still run after the browser process exited.
    if (await settlesWithin(this.gone, timeoutMs)) { this.#pipe.close(); return { forced: false }; }
    this.kill();
    if (await settlesWithin(this.gone, timeoutMs)) return { forced: true };
    throw new BrowserDriverError("undrained");
  }
  /** SIGKILL to the browser's own process group (only while it is not yet observed gone). */
  kill(): void {
    this.#pipe.close();
    if (this.#groupGone) return;
    if (this.pid !== null) {
      try { process.kill(-this.pid, "SIGKILL"); return; } catch { /* group already empty, or no group: fall back */ }
    }
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try { this.child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }
  /**
   * Polls `kill(-pgid, 0)` until the group is empty (ESRCH). The group id cannot be reused by a new process
   * while any member of the group exists, so this never confuses another process for ours. Helpers that left
   * the group on their own (Chromium's do not) are outside this evidence.
   */
  private async waitGroupGone(): Promise<void> {
    if (this.pid === null) { this.#groupGone = true; return; }
    let delay = GROUP_POLL_MIN_MS;
    while (groupExists(this.pid)) {
      await new Promise<void>((resolve) => { setTimeout(resolve, delay); });
      delay = Math.min(delay * 2, GROUP_POLL_MAX_MS);
    }
    this.#groupGone = true;
  }

  private requireOwned(): string {
    if (!this.alive || this.#ownedSession === null) throw new BrowserDriverError("closed");
    return this.#ownedSession;
  }
  /**
   * The owned target's current URL from the browser's own metadata, never from page script:
   * `Target.getTargetInfo`, repeated a bounded number of times while it errs or answers an empty URL (read
   * only). If it stays unreadable, `committed` (the URL Chromium reported in `Page.frameNavigated` for the
   * navigation that just loaded) is used; otherwise "". Abort, timeout and a closed pipe propagate.
   */
  private async currentUrl(signal: AbortSignal, committed: string | null): Promise<string> {
    const targetId = this.#ownedTargetId;
    if (targetId === null) return committed ?? "";
    for (let attempt = 1; attempt <= TARGET_URL_ATTEMPTS; attempt++) {
      let info: Record<string, unknown>;
      try {
        info = await this.command("Target.getTargetInfo", { targetId }, null, signal);
      } catch (error) {
        if (error instanceof BrowserDriverError && error.code === "protocol") continue;
        throw error;
      }
      const target = info.targetInfo as { targetId?: unknown; url?: unknown } | undefined;
      if (!target || target.targetId !== targetId || typeof target.url !== "string") break;
      if (target.url !== "") return target.url;
    }
    return committed ?? "";
  }
  private async command(method: string, params: Record<string, unknown>, sessionId: string | null, signal: AbortSignal): Promise<Record<string, unknown>> {
    const scoped = AbortSignal.any([signal, AbortSignal.timeout(this.commandTimeoutMs)]);
    try {
      return await this.#pipe.send(method, params, sessionId, scoped);
    } catch (error) {
      if (error instanceof CdpError) {
        if (error.code === "aborted") throw new BrowserDriverError(signal.aborted ? "aborted" : "timeout");
        if (error.code === "closed") throw new BrowserDriverError("closed");
      }
      throw new BrowserDriverError("protocol");
    }
  }

  private onEvent(event: CdpEvent): void {
    switch (event.method) {
      case "Target.attachedToTarget": void this.onAttached(event); return;
      case "Fetch.requestPaused": void this.onRequest(event); return;
      case "Page.javascriptDialogOpening":
        if (event.sessionId) this.#pipe.send("Page.handleJavaScriptDialog", { accept: false }, event.sessionId).catch(() => { this.kill(); });
        return;
      case "Target.detachedFromTarget":
        if (event.params.sessionId === this.#ownedSession && !this.#closing) this.kill();
        return;
      default: return;
    }
  }

  /** Every new target starts paused; interception is on before it may run, otherwise the browser dies. */
  private async onAttached(event: CdpEvent): Promise<void> {
    const sessionId = event.params.sessionId;
    const info = event.params.targetInfo as { targetId?: unknown; type?: unknown } | undefined;
    if (typeof sessionId !== "string" || !info || typeof info.targetId !== "string" || typeof info.type !== "string") { this.kill(); return; }
    const signal = AbortSignal.timeout(this.commandTimeoutMs);
    try {
      await this.#pipe.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId, signal);
      if (info.type === "page" || info.type === "iframe") {
        await this.#pipe.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId, signal);
      }
      if (info.type === "page") {
        const owned = await raceSignal(this.#ownedTargetKnown, signal);
        this.#ownedTargetId = owned;
        if (info.targetId !== owned) {
          // The initial blank page and popups are closed. A popup can share its opener's renderer, so it is
          // resumed first (its requests are already filtered) to not stall the opener.
          await this.#pipe.send("Runtime.runIfWaitingForDebugger", {}, sessionId, signal);
          await this.#pipe.send("Target.closeTarget", { targetId: info.targetId }, null, signal);
          return;
        }
        await this.#pipe.send("Page.enable", {}, sessionId, signal);
        await this.#pipe.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId, signal);
        await this.#pipe.send("Runtime.runIfWaitingForDebugger", {}, sessionId, signal);
        this.#resolveOwnedSession(sessionId);
        return;
      }
      await this.#pipe.send("Runtime.runIfWaitingForDebugger", {}, sessionId, signal);
    } catch (error) {
      // A target is resumed only after interception is on. If Chrome rejected a step for a target that is
      // not ours (it went away, e.g. a closed popup), it stays paused or gone. Anything else fails closed.
      if (!(error instanceof CdpError && error.code === "remote") || info.targetId === this.#ownedTargetId) this.kill();
    }
  }

  private async onRequest(event: CdpEvent): Promise<void> {
    const requestId = event.params.requestId;
    const request = event.params.request as { url?: unknown } | undefined;
    if (typeof requestId !== "string" || !event.sessionId) { this.kill(); return; }
    let allowed = false;
    try { allowed = typeof request?.url === "string" && this.allowRequest(request.url); } catch { allowed = false; }
    if (!allowed) this.#blocked += 1;
    try {
      await this.#pipe.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
        allowed ? { requestId } : { requestId, errorReason: "BlockedByClient" }, event.sessionId, AbortSignal.timeout(this.commandTimeoutMs));
    } catch (error) {
      // A paused request only proceeds on an explicit continue. A command Chrome rejected (the target or
      // request is gone, e.g. a closed popup) leaves nothing running; only an unanswered one is ambiguous.
      if (!(error instanceof CdpError && error.code === "remote")) this.kill();
    }
  }
}

function groupExists(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new BrowserDriverError("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(new BrowserDriverError("aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); }, (e: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(e instanceof Error ? e : new BrowserDriverError("protocol"));
    });
  });
}
