import { checkOpRef, type SecretReader } from "../onepassword.js";
import type { McpServerDefinition, McpValue } from "./definition.js";
import { MCP_ID } from "./definition.js";
import { McpConnectorError } from "./errors.js";
import type { McpCredential } from "./session.js";

/**
 * Trusted custody of the secret values a `broker` server's definition references. The definition names only slot
 * keys; custody maps (server id, slot key) to a value by a fixed convention, so no reference or value is ever stored
 * by the manager. Reads happen only on an explicit owner action (unlock/discover), never when listing or restoring.
 *
 * Implementations: 1Password (`onePasswordMcpCustody`, Mac). The future VPS custody is an encrypted file unlocked
 * with the operator's password (decided by the owner); it implements this same interface. There is no plaintext
 * file custody and no fallback to environment variables, authfiles or the owner's personal configs.
 */
export interface McpSecretCustody {
  /** Fixed label shown to the owner (`1password`, `operator_sealed`...). Never a path, vault content or value. */
  readonly kind: string;
  /** Reads one slot. Must reject with a fixed error and never with a value or a reference in the message. */
  read(serverId: string, key: string, signal: AbortSignal): Promise<string>;
}

const VAULT = /^[A-Za-z0-9_.-](?:[A-Za-z0-9 _.-]{0,126}[A-Za-z0-9_.-])?$/;

/**
 * 1Password custody: slot `<key>` of server `<id>` is the field `<key>` of the item `mcp-<id>` in the configured vault
 * (`op://<vault>/mcp-<id>/<key>`). The reader is the existing `OpCliSecretReader` (absolute `op` path, closed env,
 * bounded output, process group killed) or any trusted `SecretReader`. The vault is trusted host configuration.
 */
export function onePasswordMcpCustody(options: { reader: SecretReader; vault: string }): McpSecretCustody {
  if (typeof options?.reader?.read !== "function" || typeof options.vault !== "string" || !VAULT.test(options.vault)) {
    throw new McpConnectorError("custody_unavailable");
  }
  const { reader, vault } = options;
  return Object.freeze({
    kind: "1password",
    read: async (serverId: string, key: string, signal: AbortSignal): Promise<string> => {
      if (!MCP_ID.test(serverId) || !SLOT_KEY.test(key)) throw new McpConnectorError("credential_refused");
      let ref: string;
      try { ref = checkOpRef(`op://${vault}/mcp-${serverId}/${key}`); } catch { throw new McpConnectorError("credential_refused"); }
      try { return await reader.read(ref, signal); } catch {
        // The reader's own error is a fixed connector code; it is still replaced so nothing of the ref leaves here.
        throw new McpConnectorError(signal.aborted ? "aborted" : "custody_unavailable");
      }
    },
  });
}

const SLOT_KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
/** One header line / env value; no control characters. */
const VALUE = /^[^\u0000-\u001f\u007f]{1,8192}$/;
const DEFAULT_TTL_MS = 60 * 60_000;
const MAX_TTL_MS = 12 * 60 * 60_000;

/** Secret slot keys of a definition (stdio env or HTTP headers), with the prefixes the session adds. */
export function secretSlotsOf(definition: McpServerDefinition): { key: string; prefixes: string[] }[] {
  const t = definition.transport;
  const values: McpValue[] = Object.values(t.type === "stdio" ? t.env : t.headers);
  const slots = new Map<string, Set<string>>();
  for (const value of values) {
    if (value.kind !== "secret") continue;
    const prefixes = slots.get(value.key) ?? new Set<string>();
    if (value.prefix) prefixes.add(value.prefix);
    slots.set(value.key, prefixes);
  }
  return [...slots].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, prefixes]) => ({ key, prefixes: [...prefixes] }));
}

export interface McpVaultStatus { state: "locked" | "unlocked" | "expired"; expiresAt: number | null }
interface Unlocked { values: Readonly<Record<string, string>>; prefixes: readonly string[]; expiresAt: number }

/**
 * In-memory holder of unlocked broker values, per server. All slots of a server are read together (all or nothing),
 * kept only in process memory for a bounded TTL, never written anywhere, and dropped on lock, removal, close or a
 * failed refresh. `credential()` is synchronous and fails closed (null) when locked or expired, so the gateway's
 * grant check and dispatch never straddle an asynchronous read. A lock/clear during a read discards that read.
 */
export class McpBrokerVault {
  readonly #custody: McpSecretCustody;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #unlocked = new Map<string, Unlocked>();
  readonly #generation = new Map<string, number>();
  readonly #inflight = new Map<string, Promise<void>>();

  constructor(options: { custody: McpSecretCustody; ttlMs?: number; now?: () => number }) {
    if (typeof options?.custody?.read !== "function" || typeof options.custody.kind !== "string") throw new McpConnectorError("custody_unavailable");
    const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_TTL_MS) throw new McpConnectorError("invalid_definition", "ttlMs");
    this.#custody = options.custody;
    this.#ttlMs = ttl;
    this.#now = options.now ?? Date.now;
  }

  get kind(): string { return this.#custody.kind; }

  /** Reads every secret slot of the definition from custody. Concurrent unlocks of one server share one read. */
  unlock(definition: McpServerDefinition, signal: AbortSignal): Promise<void> {
    const id = definition.id;
    const running = this.#inflight.get(id);
    if (running) return running;
    const generation = this.#generation.get(id) ?? 0;
    const task: Promise<void> = Promise.resolve().then(async () => {
      const slots = secretSlotsOf(definition);
      if (slots.length === 0) throw new McpConnectorError("credential_refused");
      const values: Record<string, string> = {};
      try {
        for (const slot of slots) {
          if (signal.aborted) throw new McpConnectorError("aborted");
          let value: string;
          try { value = await this.#custody.read(id, slot.key, signal); } catch (error) {
            throw error instanceof McpConnectorError ? error : new McpConnectorError("custody_unavailable");
          }
          if (typeof value !== "string" || !VALUE.test(value) || slot.prefixes.some((p) => !VALUE.test(`${p}${value}`))) throw new McpConnectorError("credential_refused");
          values[slot.key] = value;
        }
      } catch (error) {
        // Fail closed: a failed refresh drops the previous values too.
        if ((this.#generation.get(id) ?? 0) === generation) this.#unlocked.delete(id);
        throw error;
      } finally {
        if (this.#inflight.get(id) === task) this.#inflight.delete(id);
      }
      // Locked, removed or closed while reading: the values are discarded, never kept.
      if ((this.#generation.get(id) ?? 0) !== generation) throw new McpConnectorError("credential_locked");
      const prefixes = slots.flatMap((s) => s.prefixes.map((p) => `${p}${values[s.key]}`));
      this.#unlocked.set(id, Object.freeze({ values: Object.freeze(values), prefixes: Object.freeze(prefixes), expiresAt: this.#now() + this.#ttlMs }));
    });
    this.#inflight.set(id, task);
    return task;
  }

  /** Values for the session (slot key -> value), or null when locked/expired. */
  credential(id: string): McpCredential | null {
    const entry = this.#unlocked.get(id);
    if (!entry) return null;
    if (this.#now() >= entry.expiresAt) { this.#unlocked.delete(id); return null; }
    return entry.values;
  }

  status(id: string): McpVaultStatus {
    const entry = this.#unlocked.get(id);
    if (!entry) return { state: "locked", expiresAt: null };
    return this.#now() >= entry.expiresAt ? { state: "expired", expiresAt: entry.expiresAt } : { state: "unlocked", expiresAt: entry.expiresAt };
  }

  lock(id: string): void {
    this.#generation.set(id, (this.#generation.get(id) ?? 0) + 1);
    this.#inflight.delete(id);
    this.#unlocked.delete(id);
  }
  clear(): void { for (const id of new Set([...this.#unlocked.keys(), ...this.#inflight.keys()])) this.lock(id); }

  /** Every held value and its prefixed header form, for the gateway's argument refusal and output scrubbing. */
  secretValues(): string[] {
    return [...this.#unlocked.values()].flatMap((e) => [...Object.values(e.values), ...e.prefixes]);
  }
}
