import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { types } from "node:util";
import type { EngineId } from "@dexter/contracts";
import { HostError } from "@dexter/hub";
import { discoverNativeEngineFiles, type EngineDiscoveryOptions } from "@dexter/engines";

/**
 * Operator-selected native engine executables (startup/CLI configuration only, never HTTP or engine arguments).
 * A provided map selects EXACTLY its keys; absent keeps the legacy both-engines, PATH-named registration.
 */
export type EngineCommands = Readonly<Partial<Record<EngineId, string>>>;
export const ENGINE_IDS: readonly EngineId[] = Object.freeze(["claude", "codex", "grok", "muse", "antigravity"]);
const MAX_COMMAND_LENGTH = 1024;

const refuse = (message: string): never => { throw new HostError("invalid_input", message); };
const shape = (): never => refuse("Invalid engine command configuration.");
const path = (): never => refuse("Engine command must be an absolute path to an executable regular file.");

/** Lexical check only (no filesystem): absolute, normalized, bounded, no NUL/control characters. */
export function isCanonicalCommandPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 1 && value.length <= MAX_COMMAND_LENGTH && !/[\u0000-\u001f\u007f]/.test(value)
    && isAbsolute(value) && resolve(value) === value;
}

/**
 * Data-only snapshot of a plain non-proxy map (no trap, getter or hook runs), then stat/lstat/access/realpath of each
 * supplied command only (no contents read, nothing executed). Captures the resolved absolute path of a regular
 * executable file. A replaced inode/filename before spawn, and wrapper interpreters, remain outside this check.
 */
export function snapshotEngineCommands(value: unknown): EngineCommands {
  if (value === null || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) return shape();
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) shape();
  const out: Partial<Record<EngineId, string>> = {};
  const keys = Reflect.ownKeys(value);
  if (keys.length === 0) shape();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !(ENGINE_IDS as readonly string[]).includes(key) || !("value" in descriptor) || !descriptor.enumerable) return shape();
    const raw: unknown = descriptor.value;
    if (!isCanonicalCommandPath(raw)) return path();
    let real: string;
    try {
      lstatSync(raw);
      real = realpathSync(raw);
      if (!isCanonicalCommandPath(real) || !statSync(real).isFile()) throw new Error();
      accessSync(real, constants.X_OK);
    } catch { return path(); }
    out[key as EngineId] = real;
  }
  return Object.freeze(out);
}

/** Startup auto-discovery resolves exact executable paths; explicit maps never fall back. */
export function discoverEngineCommands(options: Omit<EngineDiscoveryOptions, "commands"> = {}): EngineCommands {
  const found = discoverNativeEngineFiles(options);
  const out: Partial<Record<EngineId, string>> = {};
  for (const entry of found) {
    if (entry.selected && entry.command && (ENGINE_IDS as readonly string[]).includes(entry.id)) out[entry.id as EngineId] = entry.command;
  }
  return Object.keys(out).length ? snapshotEngineCommands(out) : Object.freeze(out);
}
