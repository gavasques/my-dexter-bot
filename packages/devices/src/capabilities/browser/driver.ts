/** What the capability gives a driver to start one bot's browser. Paths are private and never returned. */
export interface BrowserLaunch {
  profileDir: string;
  homeDir: string;
  /**
   * Asked for every network request any target of this browser makes (pages, frames, workers, popups,
   * redirects). `false` blocks the request. It reads the bot's current grant, so a revocation applies
   * to the very next request.
   */
  allowRequest(url: string): boolean;
  signal: AbortSignal;
}
export type NavigateOutcome = "loaded" | "blocked" | "failed";
export interface NavigateResult { url: string; outcome: NavigateOutcome }
export interface PageSnapshot { url: string; title: string; text: string; truncatedAtSource: boolean }

/**
 * One running browser bound to one bot profile. Methods are the only surface: there is no raw protocol,
 * script, file or process access for callers. Rejections carry no page or browser text.
 */
export interface BrowserSession {
  readonly pid: number | null;
  /** Settles when the main browser process exited (closed, killed or crashed); helpers may still run. */
  readonly exited: Promise<void>;
  /** Settles only when every process this session started is observed gone (never inferred from time). */
  readonly gone: Promise<void>;
  readonly alive: boolean;
  navigate(url: string, signal: AbortSignal): Promise<NavigateResult>;
  read(signal: AbortSignal): Promise<PageSnapshot>;
  /** Requests blocked by `allowRequest` since launch. */
  blockedRequests(): number;
  /**
   * Graceful close, then a forced kill after `timeoutMs`. Resolves only once `gone` settled; `forced` is
   * true when the kill was needed. Rejects (`undrained`) when processes could not be shown gone.
   */
  close(timeoutMs: number): Promise<{ forced: boolean }>;
  /** Kills every process of the session (best effort; `gone` is the evidence). */
  kill(): void;
}
export interface BrowserDriver {
  readonly kind: string;
  launch(input: BrowserLaunch): Promise<BrowserSession>;
}

export class BrowserDriverError extends Error {
  constructor(readonly code: "launch_failed" | "closed" | "timeout" | "aborted" | "protocol" | "navigation_failed" | "undrained") {
    super(code);
    this.name = "BrowserDriverError";
  }
}
