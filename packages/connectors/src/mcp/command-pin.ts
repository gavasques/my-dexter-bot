import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { McpStdioTransport } from "./definition.js";
import { McpConnectorError } from "./errors.js";
export interface McpStdioCommandPin { realPath: string; sha256: string; invocationHash: string; sizeBytes?: number }
/** Owner-facing evidence only: no literal argv, environment, credential slots or script source. */
export interface McpStdioCommandDigest { readonly path: string; readonly sha256: string; readonly argsHash: string; readonly sizeBytes: number | null }
export interface McpStdioCommandStatus {
  readonly reviewed: McpStdioCommandDigest | null;
  readonly current: McpStdioCommandDigest | null;
  readonly state: "unreviewed" | "unchanged" | "changed" | "unavailable" | "not_stdio";
}
export function mcpStdioCommandDigest(pin: McpStdioCommandPin): McpStdioCommandDigest {
  return Object.freeze({ path: pin.realPath, sha256: pin.sha256, argsHash: pin.invocationHash, sizeBytes: pin.sizeBytes ?? null });
}
const changed = (): never => { throw new McpConnectorError("command_changed", null, null, { phase: "pre_dispatch", effect: "none" }); };
/** Owner review pins the local executable AND literal argv/env slot names; this is not an OS sandbox/signature. */
export function pinMcpStdioCommand(t: McpStdioTransport): McpStdioCommandPin {
  const candidates = isAbsolute(t.command) ? [t.command] : t.searchPath.map((p) => join(p,t.command));
  let realPath: string | undefined;
  for (const candidate of candidates) {
    try { accessSync(candidate,constants.X_OK); realPath = realpathSync(candidate); break; } catch { /* explicit PATH only */ }
  }
  if (!realPath) return changed();
  const stat = lstatSync(realPath);
  if (!stat.isFile() || stat.size > 256 * 1024 * 1024 || stat.mode & 0o002) return changed();
  const bytes = readFileSync(realPath);
  const after = lstatSync(realPath);
  if (stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) return changed();
  const codeFiles:{path:string;sha256:string}[]=[];
  for(const argument of t.args) {
    if(argument.startsWith("-")||! /\.(?:[cm]?js|ts|py|sh|bash|zsh|rb|pl)$/i.test(argument))continue;
    const candidate=isAbsolute(argument)?argument:t.cwd?resolve(t.cwd,argument):null;
    if(!candidate||!existsSync(candidate))continue;
    const path=realpathSync(candidate),codeStat=lstatSync(path);
    if(!codeStat.isFile()||codeStat.size>8*1024*1024||codeStat.mode&0o002)return changed();
    codeFiles.push({path,sha256:createHash("sha256").update(readFileSync(path)).digest("hex")});
  }
  return Object.freeze({ realPath, sizeBytes: stat.size, sha256: createHash("sha256").update(bytes).digest("hex"),
    invocationHash: createHash("sha256").update(JSON.stringify({ args: t.args, cwd: t.cwd, env: t.env, searchPath: t.searchPath,codeFiles })).digest("hex") });
}
export function verifyMcpStdioCommand(t: McpStdioTransport, pin: McpStdioCommandPin): string {
  const current = pinMcpStdioCommand(t);
  if (current.realPath !== pin.realPath || current.sha256 !== pin.sha256 || current.invocationHash !== pin.invocationHash) return changed();
  return current.realPath;
}
