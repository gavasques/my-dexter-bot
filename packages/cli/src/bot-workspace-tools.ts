import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  opendirSync, readSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { JsonValue } from "@dexter/contracts";
import { GatewayError } from "@dexter/gateway";
import { OutputFilesError, OutputFilesService, type OutputToolNamespace } from "./output-files.js";
import { isWellFormedText } from "./text-input.js";

export type BotTerminalRuntime = "bash" | "zsh" | "sh" | "bun";
export type BotCommandTool = "gh" | "python3";
export interface WorkspaceLocation { path?: string; limit?: number }
export interface WorkspaceWrite { path: string; text: string; expected_sha256?: string }
export interface WorkspaceRun { runtime: BotTerminalRuntime; command: string; cwd?: string; timeout_ms?: number }
export interface WorkspaceCliRun { tool: BotCommandTool; args: string[]; cwd?: string; timeout_ms?: number }
/**
 * Who is acting, from the capability (never an argument): the bot and its turn. The host resolves the namespace from the
 * turn: the bot's own output namespace, its team's namespace in a team turn, or none in a group turn.
 */
export interface WorkspaceOwner { botId: string; turnId: string | null }
/** A bare bot id (trusted host/owner callers) means that bot's own namespace with no turn binding. */
export type WorkspaceOwnerInput = string | WorkspaceOwner;
const ownerOf = (input: WorkspaceOwnerInput): WorkspaceOwner => typeof input === "string" ? { botId: input, turnId: null }
  : input && typeof input === "object" ? { botId: input.botId, turnId: input.turnId ?? null } : fail("invalid_input");
/** Host-derived audience of a turn for file tools. `pin` binds team identity/revision/coordinator into action pins. */
export type WorkspaceAudience = { kind: "bot" } | { kind: "team"; teamId: string; pin: string } | { kind: "none" };
/** Trusted facade only. The host derives the namespace and owns approval; no method is an owner HTTP router. */
export interface BotWorkspaceToolsPort {
  status(owner: WorkspaceOwnerInput): JsonValue;
  pin(owner: WorkspaceOwnerInput): string;
  filePin(owner: WorkspaceOwnerInput, input: { path: string }): JsonValue;
  list(owner: WorkspaceOwnerInput, input?: WorkspaceLocation): JsonValue;
  tree(owner: WorkspaceOwnerInput, input?: WorkspaceLocation & { maxDepth?: number }): JsonValue;
  read(owner: WorkspaceOwnerInput, input: { path: string }): JsonValue;
  search(owner: WorkspaceOwnerInput, input: WorkspaceLocation & { query: string }): JsonValue;
  write(owner: WorkspaceOwnerInput, input: WorkspaceWrite): JsonValue;
  run(owner: WorkspaceOwnerInput, input: WorkspaceRun, options?: { signal?: AbortSignal }): Promise<JsonValue>;
  cli(owner: WorkspaceOwnerInput, input: WorkspaceCliRun, options?: { signal?: AbortSignal }): Promise<JsonValue>;
}

const FILE_BYTES = 65_536, STDOUT_BYTES = 16_384, MAX_ENTRIES = 200, MAX_SCANNED = 1000, MAX_TIMEOUT = 30_000;
const BOUNDARY = { executionBoundary: "owner_os_permissions", cwdIsNotSandbox: true } as const;
const LIMITS = { fileBytes: FILE_BYTES, stdoutBytes: STDOUT_BYTES, entries: MAX_ENTRIES, scannedEntries: MAX_SCANNED,
  maxDepth: 8, commandCharacters: 8192, argumentCharacters: 8192, arguments: 64, timeoutMs: MAX_TIMEOUT };
const RUNTIMES: readonly BotTerminalRuntime[] = ["bash", "zsh", "sh", "bun"];
const COMMAND_TOOLS: readonly BotCommandTool[] = ["gh", "python3"];
const COMMAND_POLICY = { requiresRoot: false, privilegePolicy: "host_user_no_elevation", authentication: "not_checked",
  homePolicy: "isolated", inheritedCredentials: false } as const;
const SECRET_NAME = /^(?:\.env(?:\.|$)|\.ssh$|\.aws$|\.gnupg$|\.config$|\.git$|\.npmrc$|\.netrc$|\.git-credentials$|id_(?:rsa|ed25519|ecdsa)(?:\.|$))|(?:^|[._-])(?:credentials?|secrets?|tokens?|passwords?|auth|keychain)(?:[._-]|$)|\.(?:pem|p12|pfx|key)$/i;
const INTERNAL_NAME = /^\.dexter-write-/;
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const fail = (code: "invalid_input" | "forbidden" | "conflict" | "not_found" | "unavailable"): never => {
  throw new GatewayError(code, `Bot workspace operation refused: ${code}.`);
};
function guard<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof GatewayError) throw error;
    if (error instanceof OutputFilesError) return fail(error.code);
    // Host/Context refusals (team revalidation, audience) keep their meaning instead of becoming "unavailable".
    const hostCode = (error as { code?: unknown })?.code;
    if (hostCode === "forbidden" || hostCode === "tampered") return fail("forbidden");
    if (hostCode === "conflict" || hostCode === "host_locked") return fail("conflict");
    if (hostCode === "not_found") return fail("not_found");
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return fail("not_found");
    if (code === "EEXIST") return fail("conflict");
    if (code === "ELOOP" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") return fail("forbidden");
    return fail("unavailable");
  }
}
const optionalStat = (path: string): Stats | null => { try { return lstatSync(path); } catch (error) {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null; throw error;
} };
const identity = (stat: Stats): Record<string,string> => ({ device: String(stat.dev), inode: String(stat.ino),
  size: String(stat.size), modified: String(stat.mtimeMs), changed: String(stat.ctimeMs) });
const directoryIdentity = (stat: Stats): Record<string,string> => ({ device: String(stat.dev), inode: String(stat.ino) });
const sameIdentity = (a: Stats, b: Stats): boolean => JSON.stringify(identity(a)) === JSON.stringify(identity(b));
function limit(value: number | undefined, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) return fail("invalid_input"); return value;
}
function relativePath(value: string | undefined, file = false): string {
  const path = value ?? ".";
  if (typeof path !== "string" || !isWellFormedText(path) || path.length < 1 || path.length > 1024 || isAbsolute(path)
    || /[\\\u0000-\u001f\u007f]/.test(path)) return fail("invalid_input");
  if (path === ".") { if (file) return fail("invalid_input"); return path; }
  const parts = path.split("/");
  if (parts.some(part => part.length < 1 || part === "." || part === ".." || Buffer.byteLength(part) > 255)) return fail("invalid_input");
  if (parts.some(part => SECRET_NAME.test(part) || INTERNAL_NAME.test(part))) return fail("forbidden");
  return path;
}
function botKey(botId: string): string {
  if (typeof botId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(botId)) return fail("invalid_input"); return botId;
}
interface Workspace { path: string; stat: Stats | null; namespace: OutputToolNamespace; scope: "own_bot_workspace" | "team_workspace"; audiencePin: string | null }
interface Location { workspace: Workspace; path: string; relative: string; stat: Stats | null }
interface TextFile { text: string; sha256: string; stat: Stats }
type Entry = { path: string; name: string; type: "file" | "directory" | "blocked"; bytes?: number };
interface ScanBudget { remaining: number; truncated: boolean }
interface ExecutableBinary { id: BotTerminalRuntime | BotCommandTool; path: string | null; stat: Stats | null }
interface OwnedProcess { child: ChildProcess; done: Promise<JsonValue>; stop(reason: "cancelled" | "timeout" | "stdout_limit" | "closed"): void }

/**
 * Files are specialized, bounded operations beneath ONE output namespace (the bot's `Bots/<botId>`, or its team's
 * `Times/<teamId>` in a team turn), with no-follow and CAS checks. The namespace comes from the host's output-folder
 * ledger and the turn; a turn keeps the generation of its first file operation. Approved terminal processes start there
 * and intentionally retain the host user's OS permissions: cwd/env do NOT provide an OS sandbox, nor strong isolation
 * from another namespace against an arbitrary approved command. Engine-native working directories are not touched.
 */
export class BotWorkspaceTools implements BotWorkspaceToolsPort {
  readonly #dataDir: string;
  readonly #outputs: OutputFilesService;
  readonly #audience: (owner: WorkspaceOwner) => WorkspaceAudience;
  readonly #processes = new Set<OwnedProcess>();
  #closed = false;
  #closing: Promise<void> | null = null;
  /**
   * Pure construction: no directory creation, runtime probe, process, account or authentication read. Without `outputs`
   * (in-process fixtures only) the ledger is used unbound; the host always passes its own, bound to the canonical identity.
   */
  constructor(options: { dataDir: string; outputs?: OutputFilesService; audience?: (owner: WorkspaceOwner) => WorkspaceAudience }) {
    if (!options || typeof options.dataDir !== "string" || !isAbsolute(options.dataDir) || !isWellFormedText(options.dataDir)
      || /[\u0000-\u001f\u007f]/.test(options.dataDir)) fail("invalid_input");
    this.#dataDir = resolve(options.dataDir);
    this.#outputs = options.outputs ?? new OutputFilesService({ dataDir: this.#dataDir });
    this.#audience = options.audience ?? (() => ({ kind: "bot" }));
  }
  #admit(): void { if (this.#closed) fail("unavailable"); }
  #workspace(input: WorkspaceOwnerInput, create = false): Workspace {
    this.#admit();
    const owner = ownerOf(input), botId = botKey(owner.botId), audience = this.#audience({ botId, turnId: owner.turnId });
    if (audience.kind === "none") fail("forbidden");
    const namespace = this.#outputs.toolNamespace(audience.kind === "team" ? { kind: "team", id: audience.teamId, turnId: owner.turnId }
      : { kind: "bot", id: botId, turnId: owner.turnId }, create);
    const root = optionalStat(namespace.root);
    if (root && (!root.isDirectory() || root.isSymbolicLink() || realpathSync(namespace.root) !== namespace.root
      || namespace.rootIdentity && (String(root.dev) !== namespace.rootIdentity.device || String(root.ino) !== namespace.rootIdentity.inode))) fail("forbidden");
    const base = namespace.base;
    let baseStat = root ? optionalStat(base) : null;
    if (!baseStat && create) { mkdirSync(base,{mode:0o700}); baseStat = lstatSync(base); }
    if (baseStat && (!baseStat.isDirectory() || baseStat.isSymbolicLink() || realpathSync(base) !== base)) fail("forbidden");
    const path = namespace.path; let stat = baseStat ? optionalStat(path) : null;
    if (!stat && create) { mkdirSync(path,{mode:0o700}); stat = lstatSync(path); }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path)) fail("forbidden");
    return {path,stat,namespace,scope:namespace.kind === "team" ? "team_workspace" : "own_bot_workspace",audiencePin:audience.kind === "team" ? audience.pin : null};
  }
  #namespaceView(workspace: Workspace): JsonValue {
    return {kind:workspace.namespace.kind,generation:workspace.namespace.generation,relativePath:workspace.namespace.relative,layout:workspace.namespace.layout};
  }
  #location(owner: WorkspaceOwnerInput, value: string | undefined, createParents = false): Location {
    const relative = relativePath(value), workspace = this.#workspace(owner,createParents);
    if (relative === ".") return {workspace,path:workspace.path,relative,stat:workspace.stat};
    const parts = relative.split("/"); let current = workspace.path, missing = !workspace.stat;
    for (let index = 0; index < parts.length; index++) {
      current = join(current,parts[index]!);
      let stat = missing ? null : optionalStat(current);
      if (!stat && index < parts.length - 1 && createParents) { mkdirSync(current,{mode:0o700}); stat = lstatSync(current); }
      if (stat) {
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || stat.isFile() && stat.nlink !== 1) fail("forbidden");
        if (index < parts.length - 1 && !stat.isDirectory()) fail("forbidden");
        if (!realpathSync(current).startsWith(workspace.path + sep)) fail("forbidden");
      }
      if (!stat) missing = true;
      if (index === parts.length - 1) return {workspace,path:current,relative,stat};
    }
    return fail("invalid_input");
  }
  #checkDirectoryChain(workspace: Workspace, path: string): void {
    if (!workspace.stat || path !== workspace.path && !path.startsWith(workspace.path + sep)) return fail("forbidden");
    const root=lstatSync(workspace.path);
    if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(workspace.path)!==workspace.path
      || JSON.stringify(directoryIdentity(root))!==JSON.stringify(directoryIdentity(workspace.stat))) fail("conflict");
    const suffix=path.slice(workspace.path.length), parts=suffix.split(sep).filter(Boolean); let current=workspace.path;
    for(const part of parts){
      current=join(current,part);const stat=lstatSync(current);
      if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(current)!==current)fail("forbidden");
    }
  }
  #textFile(location: Location): TextFile {
    if (!location.stat) return fail("not_found");
    if (!location.stat.isFile() || location.stat.nlink !== 1 || location.stat.isSymbolicLink()) return fail("forbidden");
    this.#checkDirectoryChain(location.workspace,dirname(location.path));
    const descriptor = openSync(location.path,constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(descriptor);
      if (!before.isFile() || before.nlink !== 1 || !sameIdentity(location.stat,before)) fail("conflict");
      if (before.size > FILE_BYTES) fail("invalid_input");
      const bytes = Buffer.alloc(FILE_BYTES + 1); let size = 0;
      while (size < bytes.length) { const read = readSync(descriptor,bytes,size,bytes.length-size,null); if (!read) break; size += read; }
      if (size > FILE_BYTES) fail("invalid_input");
      const after = fstatSync(descriptor), current = optionalStat(location.path);
      if (!current || current.isSymbolicLink() || !sameIdentity(before,after) || !sameIdentity(after,current) || after.nlink !== 1) fail("conflict");
      this.#checkDirectoryChain(location.workspace,dirname(location.path));
      let text: string; try { text = new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,size)); } catch { return fail("invalid_input"); }
      if (text.includes("\0")) fail("invalid_input");
      return {text,sha256:hash(bytes.subarray(0,size)),stat:after};
    } finally { closeSync(descriptor); }
  }
  #findBinary(id: ExecutableBinary["id"], candidates: string[]): ExecutableBinary {
    for (const candidate of candidates) {
      try {
        const path = realpathSync(candidate), stat = lstatSync(path);
        if (!stat.isFile() || !(stat.mode & 0o111)) continue;
        accessSync(path,constants.X_OK); return {id,path,stat};
      } catch { /* Metadata-only discovery; absence never installs, logs in or invokes a command. */ }
    }
    return {id,path:null,stat:null};
  }
  #searchPaths(): string[] {
    return (process.env.PATH ?? "").split(sep === "/" ? ":" : ";").filter(isAbsolute).slice(0,32);
  }
  #binaries(): ExecutableBinary[] {
    const paths = this.#searchPaths();
    // Prefer Bun's own binary: a PATH alias may resolve to a multi-command launcher whose basename selects another CLI.
    const bunCandidates = [join(homedir(),".bun","bin","bun"),...paths.map(path=>join(path,"bun")),
      join(homedir(),".local","share","vite-plus","bin","bun")];
    return RUNTIMES.map(id => this.#findBinary(id,id === "bun" ? bunCandidates : [`/bin/${id}`]));
  }
  #commandBinaries(): ExecutableBinary[] {
    const paths = ["/opt/homebrew/bin","/usr/local/bin",...this.#searchPaths(),"/usr/bin","/bin"];
    return COMMAND_TOOLS.map(id=>this.#findBinary(id,[...new Set(paths)].map(path=>join(path,id))));
  }
  #executionPath(binary: ExecutableBinary): string {
    // Fixed system/Homebrew directories and metadata-detected command directories only. No parent env or shell startup is inherited.
    const directories = ["/opt/homebrew/bin","/usr/local/bin","/usr/bin","/bin","/usr/sbin","/sbin",
      ...this.#commandBinaries().filter(item=>item.path!==null).map(item=>dirname(item.path!)),
      ...(binary.path===null?[]:[dirname(binary.path)])];
    return [...new Set(directories)].join(":");
  }
  status(owner: WorkspaceOwnerInput): JsonValue { return guard(() => {
    const workspace = this.#workspace(owner);
    return {workspace:{path:".",exists:Boolean(workspace.stat)},outputNamespace:this.#namespaceView(workspace),runtimes:this.#binaries().map(binary=>({id:binary.id,
      available:Boolean(binary.path),commandLanguage:binary.id==="bun"?"javascript":"shell",verifiedBy:"executable_metadata_only"})),
      commandTools:this.#commandBinaries().map(binary=>({id:binary.id,available:Boolean(binary.path),
        verifiedBy:"executable_metadata_only",argumentMode:"literal_argv",...COMMAND_POLICY})),
      limits:LIMITS,fileToolsScope:workspace.scope,...BOUNDARY};
  }); }
  pin(owner: WorkspaceOwnerInput): string { return guard(() => {
    const workspace = this.#workspace(owner);
    return hash(JSON.stringify({workspacePath:workspace.path,workspace:workspace.stat?directoryIdentity(workspace.stat):null,
      outputNamespace:this.#namespaceView(workspace),rootIdentity:workspace.namespace.rootIdentity,audience:workspace.audiencePin,
      runtimes:this.#binaries().map(binary=>({id:binary.id,path:binary.path,identity:binary.stat?identity(binary.stat):null})),
      commandTools:this.#commandBinaries().map(binary=>({id:binary.id,path:binary.path,identity:binary.stat?identity(binary.stat):null})),
      commandPolicy:COMMAND_POLICY,limits:LIMITS,...BOUNDARY}));
  }); }
  filePin(owner: WorkspaceOwnerInput, input: { path: string }): JsonValue { return guard(() => {
    const path = relativePath(input.path,true), location = this.#location(owner,path);
    if (!location.stat) return {path,exists:false,sha256:null,identity:null};
    const file = this.#textFile(location); return {path,exists:true,sha256:file.sha256,identity:identity(file.stat)};
  }); }
  #entries(location: Location, maximum: number, budget: ScanBudget): Entry[] {
    if (!location.stat) return [];
    if (!location.stat.isDirectory()) return fail("invalid_input");
    this.#checkDirectoryChain(location.workspace,location.path);
    const entries: Entry[] = [], handle = opendirSync(location.path);
    try {
      while (true) {
        if (budget.remaining <= 0) { budget.truncated = true; break; }
        const entry = handle.readSync(); if (!entry) break; budget.remaining--;
        if (SECRET_NAME.test(entry.name) || INTERNAL_NAME.test(entry.name)) continue;
        const path = location.relative === "." ? entry.name : `${location.relative}/${entry.name}`;
        const stat = lstatSync(join(location.path,entry.name));
        const type = stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || stat.isFile() && stat.nlink !== 1
          ? "blocked" : stat.isDirectory() ? "directory" : "file";
        entries.push({path,name:entry.name,type,...(type==="file"?{bytes:stat.size}:{})});
        if (entries.length > maximum) { entries.pop(); budget.truncated = true; break; }
      }
      const after = lstatSync(location.path);
      if (after.isSymbolicLink() || JSON.stringify(directoryIdentity(after)) !== JSON.stringify(directoryIdentity(location.stat))) fail("conflict");
      this.#checkDirectoryChain(location.workspace,location.path);
      return entries.sort((a,b)=>a.path.localeCompare(b.path));
    } finally { handle.closeSync(); }
  }
  list(owner: WorkspaceOwnerInput, input: WorkspaceLocation = {}): JsonValue { return guard(() => {
    const location = this.#location(owner,input.path), maximum = limit(input.limit,MAX_ENTRIES,100), budget = {remaining:MAX_SCANNED,truncated:false};
    return {path:location.relative,exists:Boolean(location.stat),entries:this.#entries(location,maximum,budget),truncated:budget.truncated};
  }); }
  #walk(owner: WorkspaceOwnerInput, path: string, depth: number, maximum: number): { entries: Entry[]; truncated: boolean } {
    const entries: Entry[] = [], budget = {remaining:MAX_SCANNED,truncated:false};
    const visit = (relative: string, level: number): void => {
      const remaining = maximum - entries.length;
      if (remaining <= 0) { budget.truncated = true; return; }
      const children = this.#entries(this.#location(owner,relative),remaining,budget);
      for (const child of children) {
        if (entries.length >= maximum) { budget.truncated = true; return; }
        entries.push(child);
        if (child.type === "directory" && level < depth) visit(child.path,level+1);
      }
    };
    visit(path,1); return {entries,truncated:budget.truncated};
  }
  tree(owner: WorkspaceOwnerInput, input: WorkspaceLocation & { maxDepth?: number } = {}): JsonValue { return guard(() => {
    const path = relativePath(input.path), depth = limit(input.maxDepth,8,3), maximum = limit(input.limit,MAX_ENTRIES,100);
    const walked = this.#walk(owner,path,depth,maximum); return {path,maxDepth:depth,...walked};
  }); }
  read(owner: WorkspaceOwnerInput, input: { path: string }): JsonValue { return guard(() => {
    const path = relativePath(input.path,true), file = this.#textFile(this.#location(owner,path));
    return {path,text:file.text,sha256:file.sha256,bytes:file.stat.size};
  }); }
  search(owner: WorkspaceOwnerInput, input: WorkspaceLocation & { query: string }): JsonValue { return guard(() => {
    if (typeof input.query !== "string" || !isWellFormedText(input.query) || input.query.length < 1 || input.query.length > 2000 || input.query.includes("\0")) fail("invalid_input");
    const path = relativePath(input.path), maximum = limit(input.limit,MAX_ENTRIES,100), location = this.#location(owner,path);
    const walked = location.stat?.isFile() ? {entries:[{path,name:path,type:"file" as const}],truncated:false} : this.#walk(owner,path,8,MAX_ENTRIES);
    const matches: Array<{path:string;line:number;text:string}> = []; let scannedFiles = 0, truncated = walked.truncated;
    for (const entry of walked.entries) {
      if (entry.type !== "file") continue;
      let file: TextFile;
      try { file = this.#textFile(this.#location(owner,entry.path)); }
      catch (error) { if (error instanceof GatewayError && error.code === "invalid_input") continue; throw error; }
      scannedFiles++; const lines = file.text.split("\n");
      for (let index=0;index<lines.length;index++) if (lines[index]!.includes(input.query)) {
        if (matches.length === maximum) { truncated=true; break; }
        matches.push({path:entry.path,line:index+1,text:lines[index]!.slice(0,512)});
      }
      if (matches.length === maximum) { truncated=true; break; }
    }
    return {path,query:input.query,matches,scannedFiles,truncated};
  }); }
  write(owner: WorkspaceOwnerInput, input: WorkspaceWrite): JsonValue { return guard(() => {
    const path = relativePath(input.path,true);
    if (typeof input.text !== "string" || !isWellFormedText(input.text) || input.text.includes("\0") || Buffer.byteLength(input.text) > FILE_BYTES
      || input.expected_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.expected_sha256)) fail("invalid_input");
    const location = this.#location(owner,path,true), existing = location.stat ? this.#textFile(location) : null;
    if (existing ? input.expected_sha256 !== existing.sha256 : input.expected_sha256 !== undefined) fail("conflict");
    const parent = dirname(location.path), parentBefore = lstatSync(parent), temporary = join(parent,`.dexter-write-${randomUUID()}.tmp`);
    this.#checkDirectoryChain(location.workspace,parent);
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporary,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
      writeFileSync(descriptor,input.text,{encoding:"utf8"}); fsyncSync(descriptor); closeSync(descriptor); descriptor=null;
      const checked = this.#location(owner,path), parentAfter = lstatSync(parent);
      if (JSON.stringify(directoryIdentity(parentBefore)) !== JSON.stringify(directoryIdentity(parentAfter))) fail("conflict");
      this.#checkDirectoryChain(location.workspace,parent);
      if (existing) {
        if (!checked.stat) fail("conflict"); const current = this.#textFile(checked);
        if (!sameIdentity(existing.stat,current.stat) || current.sha256 !== input.expected_sha256) fail("conflict");
        renameSync(temporary,location.path);
      } else {
        // link is atomic create-only; an intervening file/symlink cannot be overwritten by rename.
        linkSync(temporary,location.path); unlinkSync(temporary);
      }
      const stored = this.#textFile(this.#location(owner,path));
      return {path,sha256:stored.sha256,bytes:stored.stat.size,created:existing===null,fileToolsScope:location.workspace.scope,
        outputNamespace:this.#namespaceView(location.workspace)};
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      try { unlinkSync(temporary); } catch { /* Only this operation's random temporary name is removed. */ }
    }
  }); }
  async run(owner: WorkspaceOwnerInput, input: WorkspaceRun, options: { signal?: AbortSignal } = {}): Promise<JsonValue> {
    const binary = guard(() => {
      this.#admit();
      if (!RUNTIMES.includes(input.runtime) || typeof input.command !== "string" || !isWellFormedText(input.command)
        || input.command.length < 1 || input.command.length > 8192 || input.command.includes("\0")) fail("invalid_input");
      return this.#binaries().find(item=>item.id===input.runtime)!;
    });
    const args = input.runtime === "bash" ? ["--noprofile","--norc","-c",input.command] : input.runtime === "zsh" ? ["-f","-c",input.command]
      : input.runtime === "sh" ? ["-c",input.command] : ["-e",input.command];
    return this.#invoke(owner,binary,args,input.cwd,input.timeout_ms,{runtime:input.runtime},options);
  }
  async cli(owner: WorkspaceOwnerInput, input: WorkspaceCliRun, options: { signal?: AbortSignal } = {}): Promise<JsonValue> {
    const binary = guard(() => {
      this.#admit();
      if (!COMMAND_TOOLS.includes(input.tool) || !Array.isArray(input.args) || input.args.length > LIMITS.arguments
        || input.args.some(arg=>typeof arg!=="string" || !isWellFormedText(arg) || arg.includes("\0") || arg.length > LIMITS.argumentCharacters)
        || input.args.reduce((size,arg)=>size+arg.length,0)>LIMITS.argumentCharacters) fail("invalid_input");
      return this.#commandBinaries().find(item=>item.id===input.tool)!;
    });
    // Direct argv, never a shell command string. This does not infer login or read/copy the official CLI's credentials.
    return this.#invoke(owner,binary,[...input.args],input.cwd,input.timeout_ms,{tool:input.tool,argumentMode:"literal_argv",...COMMAND_POLICY},options);
  }
  async #invoke(owner: WorkspaceOwnerInput, binary: ExecutableBinary, args: string[], cwdInput: string | undefined, timeoutInput: number | undefined,
    receiptIdentity: Record<string,JsonValue>, options: { signal?: AbortSignal }): Promise<JsonValue> {
    const prepared = guard(() => {
      this.#admit();
      const timeout = limit(timeoutInput,MAX_TIMEOUT,10_000), cwd = relativePath(cwdInput);
      if (!binary.path || !binary.stat) fail("unavailable");
      if (options.signal?.aborted) fail("unavailable");
      this.#workspace(owner,true); const location = this.#location(owner,cwd);
      if (!location.stat?.isDirectory()) fail("not_found");
      // Disposable HOME/TMPDIR remove startup/config inheritance. They are not an OS access boundary.
      const data = realpathSync(this.#dataDir), base = join(data,"bot-terminal-private");
      if (!existsSync(base)) mkdirSync(base,{mode:0o700});
      const baseStat = lstatSync(base); if (!baseStat.isDirectory() || baseStat.isSymbolicLink() || realpathSync(base)!==base) fail("forbidden");
      const privateDir = join(base,randomUUID()); mkdirSync(privateDir,{mode:0o700});
      const home = join(privateDir,"home"), temporary = join(privateDir,"tmp"); mkdirSync(home,{mode:0o700}); mkdirSync(temporary,{mode:0o700});
      return {binary,location,timeout,privateDir,privateIdentity:directoryIdentity(lstatSync(privateDir)),home,temporary,path:this.#executionPath(binary)};
    });
    const environment: NodeJS.ProcessEnv = {PATH:prepared.path,HOME:prepared.home,TMPDIR:prepared.temporary,ZDOTDIR:prepared.home,
      LANG:"C",LC_ALL:"C",TERM:"dumb"};
    const cleanup = ():void => {
      try {
        const current=lstatSync(prepared.privateDir);
        if(current.isDirectory()&&!current.isSymbolicLink()&&JSON.stringify(directoryIdentity(current))===JSON.stringify(prepared.privateIdentity))
          rmSync(prepared.privateDir,{recursive:true,force:true});
      } catch { /* Only this invocation's disposable directory is eligible for cleanup. */ }
    };
    let child: ChildProcess;
    try {
      this.#checkDirectoryChain(prepared.location.workspace,prepared.location.path);
      if(JSON.stringify(directoryIdentity(lstatSync(prepared.location.path)))!==JSON.stringify(directoryIdentity(prepared.location.stat!)))fail("conflict");
      child=spawn(prepared.binary.path!,args,{cwd:prepared.location.path,env:environment,detached:true,stdio:["ignore","pipe","ignore"]});
    }
    catch { cleanup();return {...receiptIdentity,cwd:prepared.location.relative,termination:"spawn_failed",exitCode:null,signal:null,stdout:"",stdoutTruncated:false,stderrDiscarded:true,...BOUNDARY}; }
    let finish!: (result: JsonValue) => void;
    const done = new Promise<JsonValue>(resolveDone=>{finish=resolveDone;});
    const chunks: Buffer[] = []; let bytes=0,truncated=false,spawnFailed=false,spawnErrorCode:string|null=null,reason:"cancelled"|"timeout"|"stdout_limit"|"closed"|null=null;
    let killTimer: ReturnType<typeof setTimeout> | null=null;
    // This process was spawned detached by us; negative PID only addresses its own process group.
    const killGroup = (signal: NodeJS.Signals): void => { if (child.pid) try { process.kill(-child.pid,signal); } catch { /* Already gone; never target another PID. */ } };
    const stop: OwnedProcess["stop"] = why => {
      if (!reason) reason=why;
      killGroup("SIGTERM");
      if (!killTimer) killTimer=setTimeout(()=>killGroup("SIGKILL"),200);
    };
    const record: OwnedProcess={child,done,stop}; this.#processes.add(record);
    const timer=setTimeout(()=>stop("timeout"),prepared.timeout), abort=():void=>stop("cancelled");
    options.signal?.addEventListener("abort",abort,{once:true}); if (options.signal?.aborted) abort();
    child.stdout?.on("data",(chunk:Buffer)=>{
      const available=STDOUT_BYTES-bytes;
      if (available>0) { const part=chunk.subarray(0,available);chunks.push(Buffer.from(part));bytes+=part.length; }
      // Truncate the projection and drain excess bytes without killing an admitted effect.
      if (chunk.length>available) truncated=true;
    });
    child.on("error",error=>{
      if(child.pid!==undefined){stop("cancelled");return;}
      spawnFailed=true;const code=(error as NodeJS.ErrnoException).code;
      if(code && ["ENOENT","EACCES","ENOEXEC","EAGAIN","EMFILE","ENFILE"].includes(code))spawnErrorCode=code;});
    child.on("close",(exitCode,signal)=>{
      clearTimeout(timer);if(killTimer)clearTimeout(killTimer);options.signal?.removeEventListener("abort",abort);this.#processes.delete(record);
      // Descendants retaining a inherited pipe must not outlive an approved bounded session.
      killGroup("SIGKILL");
      cleanup();
      const decoded=Buffer.concat(chunks).toString("utf8"), encoded=Buffer.from(decoded,"utf8");
      if(encoded.length>STDOUT_BYTES)truncated=true;
      const stdout=new TextDecoder("utf-8",{ignoreBOM:true}).decode(encoded.subarray(0,STDOUT_BYTES),{stream:true});
      finish({...receiptIdentity,cwd:prepared.location.relative,termination:spawnFailed?"spawn_failed":reason??"completed",
        exitCode,signal,stdout,stdoutTruncated:truncated,stderrDiscarded:true,...(spawnFailed?{spawnErrorCode}:{}),...BOUNDARY});
    });
    return done;
  }
  /** Closes admission and drains only foreground process groups created by this instance. */
  close(): Promise<void> {
    this.#closed=true;
    for(const record of this.#processes)record.stop("closed");
    return this.#closing??=Promise.allSettled([...this.#processes].map(record=>record.done)).then(()=>undefined);
  }
}
