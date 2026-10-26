/**
 * Credential material released for one upstream call. Lives only in trusted process memory, is handed to
 * the trusted adapter at call time and is never persisted, logged, returned or placed in a ToolRequest.
 */
export interface InjectedAuth {
  /** Headers the trusted adapter attaches upstream (e.g. Composio key or session.mcp.headers). */
  readonly headers: Readonly<Record<string, string>>;
}

export interface CredentialBroker {
  /**
   * Releases material for `ref` only when `host` is on that credential's network allowlist; otherwise null.
   * Implementations must not throw with secret content.
   */
  acquire(ref: string, host: string): InjectedAuth | null;
  /**
   * Every non-empty secret value currently held, however short. The gateway refuses call arguments that
   * contain one (or a derived form, see secrets.ts) and scrubs adapter output with them.
   */
  secretValues(): readonly string[];
}

interface Entry { headers: Readonly<Record<string, string>>; allowedHosts: ReadonlySet<string> }

/**
 * In-memory broker for synthetic credentials (tests and local development). Real backends (1Password,
 * Composio service) implement the same interface. There is intentionally no method that lists or reads
 * a credential back outside `acquire`.
 */
export class SyntheticCredentialBroker implements CredentialBroker {
  private readonly entries = new Map<string, Entry>();

  put(ref: string, credential: { headers: Record<string, string>; allowedHosts: string[] }): void {
    // An empty value could never be recognised (and so never refused or scrubbed); refuse it up front.
    if (Object.values(credential.headers).some((v) => typeof v !== "string" || v.length === 0)) throw new Error("credential header values must be non-empty strings");
    this.entries.set(ref, {
      headers: Object.freeze({ ...credential.headers }),
      allowedHosts: new Set(credential.allowedHosts),
    });
  }
  revoke(ref: string): void { this.entries.delete(ref); }
  acquire(ref: string, host: string): InjectedAuth | null {
    const entry = this.entries.get(ref);
    if (!entry || !entry.allowedHosts.has(host)) return null;
    return Object.freeze({ headers: entry.headers });
  }
  secretValues(): readonly string[] {
    return [...this.entries.values()].flatMap((entry) => Object.values(entry.headers));
  }
}
