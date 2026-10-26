import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize, parse } from "node:path";
import { TextDecoder } from "node:util";
import { DeviceError } from "../../errors.js";
import { HandlerRefusal } from "../../handlers.js";
import { FILE_APPEND, FILE_READ } from "../../operations.js";
import { exact, wireId } from "../../wire.js";

export interface SelectedFileGrant {
  name: string; path: string; operations: string[];
  identity: { device: string; inode: string }; fence: string;
}
export interface SelectedFilesPolicyConfig {
  version: 1; installationId: string; bots: { botId: string; files: SelectedFileGrant[] }[];
}
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;
const ALIAS = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function refuse(): never { throw new DeviceError("forbidden", "selected files policy refused"); }

/** No filesystem discovery: inspect only this explicitly selected path and its ancestors. */
export function selectedFilePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || !isAbsolute(value) || normalize(value) !== value || /[\u0000-\u001f\u007f]/u.test(value)) refuse();
  const path = value as string;
  let at = dirname(path);
  while (true) {
    const stat = lstatSync(at);
    if (!stat.isDirectory() || stat.isSymbolicLink()) refuse();
    if (at === parse(at).root) break;
    at = dirname(at);
  }
  return path;
}
export function parseSelectedFilesPolicy(value: unknown, installationId: string): SelectedFilesPolicyConfig {
  const v = exact(value, ["version", "installationId", "bots"]);
  if (v.version !== 1 || wireId(v.installationId) !== installationId || !Array.isArray(v.bots) || v.bots.length > 64) refuse();
  const seen = new Set<string>(); let count = 0;
  const bots = v.bots.map(raw => {
    const b = exact(raw, ["botId", "files"]), botId = wireId(b.botId);
    if (seen.has(botId) || !Array.isArray(b.files) || b.files.length > 8) refuse();
    seen.add(botId); const aliases = new Set<string>();
    const files = b.files.map(rawFile => {
      const f = exact(rawFile, ["name", "path", "operations", "identity", "fence"]), identity = exact(f.identity, ["device", "inode"]);
      if (typeof f.name !== "string" || !ALIAS.test(f.name) || aliases.has(f.name) || ++count > 128
        || !Array.isArray(f.operations) || f.operations.length < 1 || f.operations.length > 2
        || new Set(f.operations).size !== f.operations.length || f.operations.some(op => op !== FILE_READ && op !== FILE_APPEND)
        || typeof identity.device !== "string" || !DECIMAL.test(identity.device) || typeof identity.inode !== "string" || !DECIMAL.test(identity.inode)
        || typeof f.fence !== "string" || !/^[0-9a-f]{32}$/.test(f.fence)) refuse();
      aliases.add(f.name as string);
      return { name: f.name as string, path: selectedFilePath(f.path), operations: [...f.operations] as string[],
        identity: { device: identity.device as string, inode: identity.inode as string }, fence: f.fence as string };
    });
    return { botId, files };
  });
  return { version: 1, installationId, bots };
}
/** Duplicate JSON keys, including escaped aliases, never select a second interpretation. */
function json(text: string): unknown {
  const value: unknown = JSON.parse(text), stack: ({ keys: Set<string>; key: boolean } | null)[] = [];
  for (const token of text.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/gu) ?? []) {
    const top = stack.at(-1);
    if (token === "{") stack.push({ keys: new Set(), key: true }); else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop(); else if (token === ":" && top) top.key = false;
    else if (token === "," && top) top.key = true;
    else if (top?.key && token.startsWith('"')) { const key = JSON.parse(token) as string; if (top.keys.has(key)) refuse(); top.keys.add(key); }
  }
  return value;
}
function policyBytes(path: string): Buffer {
  selectedFilePath(path);
  const parent = lstatSync(dirname(path));
  if (parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700 || realpathSync(path) !== path) refuse();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd), named = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600
      || stat.size < 1 || stat.size > 1024 * 1024 || named.dev !== stat.dev || named.ino !== stat.ino) refuse();
    const bytes = Buffer.alloc(stat.size + 1); let n = 0;
    while (n < bytes.length) { const got = readSync(fd, bytes, n, bytes.length - n, null); if (!got) break; n += got; }
    const after = fstatSync(fd), final = lstatSync(path);
    if (n !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
      || final.dev !== stat.dev || final.ino !== stat.ino || final.isSymbolicLink()) refuse();
    return bytes.subarray(0, n);
  } finally { closeSync(fd); }
}
/** Frozen startup authority. Editing/replacing/removing this file fences all operations until restart. */
export class SelectedFilesPolicy {
  readonly #config: SelectedFilesPolicyConfig;
  readonly #digest: string;
  #quarantined = false;
  private constructor(readonly policyPath: string, readonly installationId: string, bytes: Buffer) {
    this.#config = parseSelectedFilesPolicy(json(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), installationId);
    this.#digest = createHash("sha256").update(bytes).digest("hex");
  }
  static load(path: string, installationId: string): SelectedFilesPolicy {
    try { return new SelectedFilesPolicy(path, wireId(installationId), policyBytes(path)); }
    catch { throw new DeviceError("forbidden", "selected files policy refused"); }
  }
  current(): boolean {
    if (this.#quarantined) return false;
    try { if (createHash("sha256").update(policyBytes(this.policyPath)).digest("hex") === this.#digest) return true; } catch { /* deny */ }
    this.#quarantined = true;
    return false;
  }
  authorize(botId: string, name: string, tool: string): Readonly<SelectedFileGrant> {
    if (!this.current()) throw new HandlerRefusal("file_policy_changed");
    const grant = this.#config.bots.find(b => b.botId === botId)?.files.find(f => f.name === name && f.operations.includes(tool));
    if (!grant) throw new HandlerRefusal("file_not_granted");
    return structuredClone(grant);
  }
  toJSON(): object { return { kind: "selected-files-policy" }; }
}
