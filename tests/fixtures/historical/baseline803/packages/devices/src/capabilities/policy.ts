import { randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { DeviceError } from "../errors.js";
import { privateFile } from "../files.js";
import { HandlerRefusal, type TrustedJobContext } from "../handlers.js";
import { BROWSER_CLOSE, BROWSER_NAVIGATE, BROWSER_READ, CUA_CONTROL, CUA_OBSERVE, CUA_STATUS } from "../operations.js";
import { exact, wireId } from "../wire.js";

/** Operations a local capability grant may name. File, probe and anything undeclared are not grantable here. */
export const LOCAL_CAPABILITY_OPERATIONS: readonly string[] = Object.freeze([BROWSER_NAVIGATE, BROWSER_READ, BROWSER_CLOSE, CUA_OBSERVE, CUA_CONTROL, CUA_STATUS]);
export const POLICY_VERSION = 1;
const MAX_BOTS = 64;
const MAX_ORIGINS = 32;
const MAX_CUA_SECONDS = 15 * 60;
const LABEL = /^[\p{L}\p{N} ._-]{1,48}$/u;

export interface LocalBotGrant {
  botId: string;
  /** Operator-chosen display name used by the local consent UI; never taken from a job. */
  label: string;
  operations: string[];
  /** Exact origins (`https://host[:port]`) this bot's browser may load. Empty means no browsing. */
  browserOrigins: string[];
  /** Upper bound of one consented CUA session. 0 means CUA is not grantable for this bot. */
  cuaMaxSessionSeconds: number;
}
export interface LocalCapabilityConfig { version: number; bots: LocalBotGrant[] }

/**
 * A policy change could not be written to the policy file. The change is not durable and is not reported as
 * done; the policy instance is quarantined instead (see `LocalCapabilityPolicy.quarantined`).
 */
export class PolicyPersistenceError extends DeviceError {
  constructor() {
    super("unavailable", "local policy not persisted");
    this.name = "PolicyPersistenceError";
  }
}

/** A grant observed at a point in time. `isCurrent` tells whether it still holds unchanged. */
export interface Authorization { readonly botId: string; readonly tool: string; readonly generation: number; readonly grant: Readonly<LocalBotGrant> }

export function normalizeOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 256) throw new DeviceError("invalid_input", "invalid origin");
  let url: URL;
  try { url = new URL(value); } catch { throw new DeviceError("invalid_input", "invalid origin"); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "") || url.hostname === "" || url.hostname.includes("*")) {
    throw new DeviceError("invalid_input", "invalid origin");
  }
  return url.origin;
}

export function parseLocalCapabilityConfig(value: unknown): LocalCapabilityConfig {
  const v = exact(value, ["version", "bots"]);
  if (v.version !== POLICY_VERSION) throw new DeviceError("invalid_input", "unsupported policy version");
  if (!Array.isArray(v.bots) || v.bots.length > MAX_BOTS) throw new DeviceError("invalid_input", "invalid bots");
  const seen = new Set<string>();
  const bots = v.bots.map((raw): LocalBotGrant => {
    const b = exact(raw, ["botId", "label", "operations", "browserOrigins", "cuaMaxSessionSeconds"]);
    const botId = wireId(b.botId);
    if (seen.has(botId)) throw new DeviceError("invalid_input", "duplicate bot");
    seen.add(botId);
    if (typeof b.label !== "string" || !LABEL.test(b.label)) throw new DeviceError("invalid_input", "invalid label");
    if (!Array.isArray(b.operations) || b.operations.length > LOCAL_CAPABILITY_OPERATIONS.length) throw new DeviceError("invalid_input", "invalid operations");
    const operations = new Set<string>();
    for (const op of b.operations) {
      if (typeof op !== "string" || !LOCAL_CAPABILITY_OPERATIONS.includes(op) || operations.has(op)) throw new DeviceError("invalid_input", "invalid operations");
      operations.add(op);
    }
    if (!Array.isArray(b.browserOrigins) || b.browserOrigins.length > MAX_ORIGINS) throw new DeviceError("invalid_input", "invalid origins");
    const origins = [...new Set(b.browserOrigins.map(normalizeOrigin))].sort();
    const seconds = b.cuaMaxSessionSeconds;
    if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 0 || seconds > MAX_CUA_SECONDS) throw new DeviceError("invalid_input", "invalid cua bound");
    return { botId, label: b.label, operations: [...operations].sort(), browserOrigins: origins, cuaMaxSessionSeconds: seconds };
  });
  return { version: POLICY_VERSION, bots };
}

/**
 * Per-bot, per-operation grants decided by the operator on this Mac. They are a second gate after the
 * host's grant (bot/tool/device, approval and hash): the Mac never widens what the host allowed, and the
 * host cannot widen what the operator allowed here. Nothing is granted by default; an unknown bot or
 * operation is refused before any effect.
 *
 * Every change bumps a generation. Work that observed an older generation is fenced: an in-flight
 * operation re-checks after each await, and listeners close or end sessions of bots whose grant changed.
 * When loaded from a file, a change is written (fsync, atomic rename) before it applies, so a restart
 * cannot restore a revoked grant.
 *
 * If that write fails, nothing is reported as done: the change throws `PolicyPersistenceError` and this
 * instance is **quarantined** for the rest of its life. Every bot is notified (sessions end), and every
 * authorization, currency, origin and label check refuses. The file may still hold the previous policy, so
 * the operator must repair it before the next start; there is no automatic recovery or re-grant.
 */
export class LocalCapabilityPolicy {
  #config: LocalCapabilityConfig;
  #generations = new Map<string, number>();
  #counter = 0;
  #quarantined = false;
  readonly #listeners = new Set<(botIds: ReadonlySet<string>) => void>();

  constructor(config: LocalCapabilityConfig, private readonly path: string | null = null) {
    this.#config = parseLocalCapabilityConfig(config);
    for (const bot of this.#config.bots) this.#generations.set(bot.botId, ++this.#counter);
  }

  /** Reads a private (0600, owned, non-symlink) policy file. A missing file means no grants at all. */
  static load(path: string): LocalCapabilityPolicy {
    try { lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new LocalCapabilityPolicy({ version: POLICY_VERSION, bots: [] }, path);
      throw new DeviceError("unavailable", "policy unavailable");
    }
    privateFile(path);
    let value: unknown;
    try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new DeviceError("invalid_input", "policy unreadable"); }
    return new LocalCapabilityPolicy(parseLocalCapabilityConfig(value), path);
  }

  /** True after a failed write: no grant holds anymore in this process. */
  get quarantined(): boolean { return this.#quarantined; }

  /** The bot's grant for `tool`, or a refusal before any effect. The bot comes from the trusted job only. */
  authorize(job: TrustedJobContext, tool: string): Authorization {
    if (this.#quarantined) throw new HandlerRefusal("policy_quarantined");
    const grant = this.#config.bots.find((b) => b.botId === job.botId);
    if (!grant || !grant.operations.includes(tool)) throw new HandlerRefusal("not_granted");
    return Object.freeze({ botId: grant.botId, tool, generation: this.#generations.get(grant.botId)!, grant: Object.freeze(structuredClone(grant)) });
  }
  isCurrent(auth: Authorization): boolean {
    if (this.#quarantined) return false;
    const grant = this.#config.bots.find((b) => b.botId === auth.botId);
    return grant !== undefined && this.#generations.get(auth.botId) === auth.generation && grant.operations.includes(auth.tool);
  }
  /** Current grant generation of the bot, or null when it has no grant (or the policy is quarantined). */
  generation(botId: string): number | null {
    if (this.#quarantined) return null;
    return this.#generations.get(botId) ?? null;
  }
  /** Whether `origin` is granted to the bot right now (used for every request the browser makes). */
  originAllowed(botId: string, origin: string): boolean {
    if (this.#quarantined) return false;
    return this.#config.bots.find((b) => b.botId === botId)?.browserOrigins.includes(origin) ?? false;
  }
  /** A frozen copy of the bot's current grant, or null (no grant, or quarantined). */
  grantOf(botId: string): Readonly<LocalBotGrant> | null {
    if (this.#quarantined) return null;
    const grant = this.#config.bots.find((b) => b.botId === botId);
    return grant ? Object.freeze(structuredClone(grant)) : null;
  }
  labelOf(botId: string): string | null {
    if (this.#quarantined) return null;
    return this.#config.bots.find((b) => b.botId === botId)?.label ?? null;
  }

  /** Removes one operation, or every grant of the bot. Persisted before it takes effect in memory. */
  revoke(botId: string, tool?: string): void {
    const bots = this.#config.bots.flatMap((b) => {
      if (b.botId !== botId) return [b];
      if (tool === undefined) return [];
      return [{ ...b, operations: b.operations.filter((op) => op !== tool) }];
    });
    this.replace({ version: POLICY_VERSION, bots });
  }
  /** Replaces the whole policy (operator edit). Bots whose grant changed get a new generation. */
  replace(next: LocalCapabilityConfig): void {
    if (this.#quarantined) throw new PolicyPersistenceError();
    const config = parseLocalCapabilityConfig(next);
    if (this.path) {
      try { this.persist(config); } catch {
        this.quarantine();
        throw new PolicyPersistenceError();
      }
    }
    const changed = new Set<string>();
    const before = new Map(this.#config.bots.map((b) => [b.botId, JSON.stringify(b)]));
    for (const bot of config.bots) if (before.get(bot.botId) !== JSON.stringify(bot)) changed.add(bot.botId);
    for (const botId of before.keys()) if (!config.bots.some((b) => b.botId === botId)) changed.add(botId);
    this.#config = config;
    for (const botId of changed) {
      if (config.bots.some((b) => b.botId === botId)) this.#generations.set(botId, ++this.#counter);
      else this.#generations.delete(botId);
    }
    if (changed.size > 0) this.notify(changed);
  }
  onChange(listener: (botIds: ReadonlySet<string>) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  /** Bot ids and operation names only; no origins or labels leave through diagnostics. */
  toJSON(): object {
    return { quarantined: this.#quarantined, bots: this.#quarantined ? [] : this.#config.bots.map((b) => ({ botId: b.botId, operations: b.operations })) };
  }

  /** Permanent in this process: every grant stops holding and every bot's sessions are told to end. */
  private quarantine(): void {
    const all = new Set(this.#config.bots.map((b) => b.botId));
    this.#quarantined = true;
    this.#generations.clear();
    this.notify(all);
  }
  private notify(botIds: ReadonlySet<string>): void {
    // A throwing listener must not keep the others (session teardown) from running.
    for (const listener of [...this.#listeners]) { try { listener(botIds); } catch { /* listener's own failure */ } }
  }

  /** Writes a fresh private temp file (O_EXCL, no symlink follow), fsyncs it and renames it over the policy. */
  private persist(config: LocalCapabilityConfig): void {
    const path = this.path!;
    const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    let fd: number | null = null;
    let created = false;
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      writeSync(fd, JSON.stringify(config));
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temp, path);
      created = false;
      privateFile(path);
      syncDirectory(dirname(path));
    } catch (error) {
      if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
      // Only the temp file this call created is removed; nothing else at a guessed path is touched.
      if (created) { try { unlinkSync(temp); } catch { /* gone */ } }
      throw error;
    }
  }
}

function syncDirectory(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
