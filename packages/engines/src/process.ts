import { spawn, type ChildProcessWithoutNullStreams, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { isAbsolute, resolve } from 'node:path';

export type EngineErrorCode = 'not_installed' | 'authentication_required' | 'subscription_required' | 'protocol_error' | 'process_exited' | 'timeout' | 'busy' | 'session_closed' | 'unsupported' | 'engine_failed' | 'usage_limit' | 'rate_limited' | 'engine_unavailable' | 'context_limit' | 'session_uncertain';
export class EngineError extends Error {
  constructor(readonly code: EngineErrorCode) { super(code); this.name = 'EngineError'; }
}
export interface DriverOptions {
  command?: string;
  /** Test harnesses can prefix a fixture path; arguments are never shell evaluated. */
  prefixArgs?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  killGraceMs?: number;
  model?: string;
}
/** Fixed driver policy and private runtime paths; never copied from ambient environment or HTTP. */
export interface TrustedRuntimeEnvironment {
  GROK_MANAGED_MCPS_ENABLED?: 'false'; GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED?: 'false'; GROK_AGENT?: 'grok-build';
  MUSE_NO_AUTO_UPDATE?: '1'; AGY_ACP_FORCE_FILE_STORAGE?: '1'; PYTHONUNBUFFERED?: '1'; BROWSER?: '/usr/bin/false';
  GEMINI_HOME?: string; ANTIGRAVITY_HARNESS_PATH?: string;
  XDG_CONFIG_HOME?: string; XDG_DATA_HOME?: string; XDG_CACHE_HOME?: string;
}
function runtimeEnvironment(value: TrustedRuntimeEnvironment): NodeJS.ProcessEnv {
  const fixed: Record<string,string> = { GROK_MANAGED_MCPS_ENABLED:'false', GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED:'false',
    GROK_AGENT:'grok-build', MUSE_NO_AUTO_UPDATE:'1', AGY_ACP_FORCE_FILE_STORAGE:'1', PYTHONUNBUFFERED:'1', BROWSER:'/usr/bin/false' };
  const paths = new Set(['GEMINI_HOME','ANTIGRAVITY_HARNESS_PATH','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME']);
  const out: NodeJS.ProcessEnv = {MUSE_NO_AUTO_UPDATE:'1'};
  for (const [key,item] of Object.entries(value)) {
    if (typeof item !== 'string' || (paths.has(key) ? !isAbsolute(item) || resolve(item)!==item || item.length>4096 || /[\u0000-\u001f\u007f]/.test(item) : fixed[key]!==item)) throw new EngineError('protocol_error');
    out[key]=item;
  }
  return out;
}
const ENV_ALLOWLIST = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'DEXTER_FIXTURE_MODE']);
/** Preserve OS discovery and native HOME/Keychain authentication, never ambient credentials/routing. */
export function optionsEnv(options: DriverOptions): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries({ ...process.env, ...options.env }).filter(([key, value]) => ENV_ALLOWLIST.has(key) && value !== undefined));
}
const PROCESS_GROUPS = process.platform !== 'win32';
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  // A failed spawn has no process handle to signal. Never invoke child.kill on that handle.
  if (child.pid === undefined) return;
  try { if (PROCESS_GROUPS) process.kill(-child.pid, signal); else child.kill(signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal); }
}
function treeAlive(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  if (!PROCESS_GROUPS) return child.exitCode === null && child.signalCode === null;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function codeOf(error: unknown): EngineErrorCode { return error instanceof EngineError ? error.code : 'engine_failed'; }

export class AsyncQueue<T> {
  private values: { value: T; bytes: number }[] = [];
  private bufferedBytes = 0;
  private waiter: ((value: T | undefined) => void) | undefined;
  private ended = false;
  private overflowed = false;
  private terminal: T | undefined;
  push(value: T): void {
    if (this.ended) return;
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(value); }
    else {
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (this.values.length >= 4096 || this.bufferedBytes + bytes > 8 * 1024 * 1024) { this.overflowed = true; throw new EngineError('protocol_error'); }
      this.values.push({ value, bytes }); this.bufferedBytes += bytes;
    }
  }
  pushFinal(value: T, failure: T): void {
    if (this.ended) return;
    // A separate terminal slot preserves every accepted delta. Overflow can never claim success.
    let final = failure;
    try { if (!this.overflowed && Buffer.byteLength(JSON.stringify(value)) <= 8 * 1024 * 1024) final = value; } catch { /* fixed failure remains */ }
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(final); }
    else this.terminal = final;
  }
  end(): void { this.ended = true; this.waiter?.(undefined); this.waiter = undefined; }
  async next(): Promise<T | undefined> {
    if (this.values.length) { const next = this.values.shift()!; this.bufferedBytes -= next.bytes; return next.value; }
    if (this.terminal !== undefined) { const terminal = this.terminal; this.terminal = undefined; return terminal; }
    if (this.ended) return undefined;
    return new Promise(resolve => { this.waiter = resolve; });
  }
}

/** Bounded line decoding; raw stderr and provider errors never escape this boundary. */
export class JsonProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private stopped = false;
  private closed = false;
  private stopping: Promise<void> | undefined;
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  onMessage: (message: Record<string, unknown>) => void = () => {};
  onFailure: (error: EngineError) => void = () => {};
  constructor(command: string, args: readonly string[], readonly options: DriverOptions, runtime: TrustedRuntimeEnvironment = {}) {
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    this.child = spawn(command, [...(options.prefixArgs ?? []), ...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }), env: { ...optionsEnv(options), ...runtimeEnvironment(runtime), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, stdio: 'pipe', shell: false, detached: PROCESS_GROUPS,
    });
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.fail(new EngineError('process_exited')));
    this.child.once('error', (error: NodeJS.ErrnoException) => this.fail(new EngineError(error.code === 'ENOENT' ? 'not_installed' : 'process_exited')));
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += this.decoder.write(chunk);
      this.drain(false);
    });
    this.child.stdout.once('end', () => { this.buffer += this.decoder.end(); this.drain(true); });
    this.child.once('close', () => {
      this.closed = true;
      if (!this.stopped) this.onFailure(new EngineError('process_exited'));
      this.resolveDone();
    });
  }
  private drain(final: boolean): void {
    try {
      let boundary: number;
      while ((boundary = this.buffer.indexOf('\n')) >= 0) {
        if (Buffer.byteLength(this.buffer.slice(0, boundary)) > 2 * 1024 * 1024) throw new EngineError('protocol_error');
        const line = this.buffer.slice(0, boundary).trim(); this.buffer = this.buffer.slice(boundary + 1);
        if (line) this.deliver(line);
      }
      if (Buffer.byteLength(this.buffer) > 2 * 1024 * 1024) throw new EngineError('protocol_error');
      if (final && this.buffer.trim()) { this.deliver(this.buffer.trim()); this.buffer = ''; }
    } catch { this.fail(new EngineError('protocol_error')); }
  }
  private deliver(line: string): void {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') throw new EngineError('protocol_error');
    this.onMessage(object(parsed));
  }
  private fail(error: EngineError): void { if (this.stopped) return; this.onFailure(error); void this.stop(); }
  send(message: unknown): void {
    if (this.stopped || this.closed) throw new EngineError('process_exited');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  stop(options: { allowNaturalExit?: boolean } = {}): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.stopping = (async () => {
      const grace = this.options.killGraceMs ?? 500;
      if (options.allowNaturalExit && !this.closed) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([this.done, new Promise<void>(resolve => { timer = setTimeout(resolve, grace); })]); }
        finally { clearTimeout(timer); }
      }
      // Even a naturally exited leader may leave descendants in its process group.
      if (!treeAlive(this.child)) { await this.done; return; }
      killTree(this.child, 'SIGTERM');
      // Descendants can outlive the leader or close inherited pipes. Keep the escalation scheduled.
      await new Promise<void>(resolve => setTimeout(() => { killTree(this.child, 'SIGKILL'); resolve(); }, grace));
      await this.done;
    })();
    return this.stopping;
  }
}

export async function probe(options: DriverOptions, command: string, args: readonly string[], runtime: TrustedRuntimeEnvironment = {}): Promise<{ text: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...(options.prefixArgs ?? []), ...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }), env: { ...optionsEnv(options), ...runtimeEnvironment(runtime) }, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: PROCESS_GROUPS,
    });
    let text = ''; let timedOut = false;
    child.stdout.setEncoding('utf8'); child.stderr.resume();
    child.stdout.on('data', (chunk: string) => { text += chunk; if (text.length > 65536) { text = ''; killTree(child, 'SIGKILL'); } });
    const timer = setTimeout(() => { timedOut = true; killTree(child, 'SIGKILL'); }, options.requestTimeoutMs ?? 10000);
    child.once('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); reject(new EngineError(error.code === 'ENOENT' ? 'not_installed' : 'process_exited')); });
    child.once('close', exitCode => { clearTimeout(timer); if (timedOut) reject(new EngineError('timeout')); else resolve({ text, exitCode }); });
  });
}
