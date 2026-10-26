import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, resolve } from "node:path";

export const OPENVIKING_SUPERVISOR_UPSTREAM_PIN = "92285e5b373ef927021544597b65e56bc9d0d5c8";
export type OpenVikingSupervisorState = "starting" | "ready" | "degraded" | "recovering" | "blocked_configuration" | "stopped";
export type OpenVikingSupervisorReason = "none" | "configuration_missing" | "runtime_not_admitted" | "origin_occupied" | "probe_unavailable" | "readiness_unproven" | "configuration_blocked" | "process_exit" | "spawn_failed" | "restart_budget_exhausted" | "shutdown_deadline" | "drain_unconfirmed";

/** Supplied only by host custody/package admission, never by an engine or tool input.
 * Version is a host attestation; SHA verification does not infer a version from --version/HTTP.
 * No flags, config, credentials or environment variables are invented or inherited here. */
export interface OpenVikingAdmittedCommand {
  readonly admission: "host_admitted_loopback_api_key";
  readonly upstreamPin: typeof OPENVIKING_SUPERVISOR_UPSTREAM_PIN;
  readonly expectedVersion: string;
  readonly attestedVersion: string;
  readonly executable: string;
  readonly executableSha256: string;
  readonly args: readonly string[];
  readonly publicInputPins: readonly Readonly<{ path: string; sha256: string }>[];
  readonly environment: Readonly<Record<string, string>>;
  readonly dataDir: string;
  readonly configDir: string;
}
export type OpenVikingSupervisorConfiguration =
  | Readonly<{ mode: "unconfigured" }>
  | Readonly<{ mode: "owned"; origin: string; command: OpenVikingAdmittedCommand }>
  | Readonly<{ mode: "external"; origin: string }>;

/** M03 status() proves authenticated identity only. The host must add separately observed
 * account/ACL/embedding/content/index facts. Echoing generation is not process attribution. */
export interface OpenVikingSupervisorReadiness {
  readonly generation: number;
  readonly httpAuthenticated: boolean;
  readonly identityMatched: boolean;
  readonly configuration: "admitted" | "blocked";
  readonly accountUsersVerified: boolean;
  readonly aclVerified: boolean;
  readonly embeddingUsable: boolean;
  readonly contentReadWriteConfirmed: boolean;
  readonly indexCurrent: boolean;
  readonly ownedGenerationVerified: boolean;
}
export interface OpenVikingSupervisorProbeInput {
  readonly origin: string;
  readonly generation: number;
  readonly ownedPid: number | null;
  readonly signal: AbortSignal;
}
export interface OpenVikingOwnedProcess {
  readonly pid: number | null;
  readonly exited: Promise<void>;
  alive(): boolean;
  /** Only the handle returned by this instance's spawn. No PID/port lookup or process group. */
  signal(signal: "SIGTERM" | "SIGKILL"): void;
}
export interface OpenVikingSupervisorSnapshot {
  readonly state: OpenVikingSupervisorState;
  readonly reason: OpenVikingSupervisorReason;
  readonly generation: number;
  readonly process: Readonly<{ owned: boolean; pid: number | null; alive: boolean | null }>;
  readonly runtime: Readonly<{ sha256Verified: boolean; versionAttested: boolean }>;
  readonly readiness: Readonly<Omit<OpenVikingSupervisorReadiness, "generation" | "configuration">>;
  readonly restarts: number;
  readonly circuitOpen: boolean;
  readonly nextRestartDelayMs: number | null;
  readonly drainConfirmed: boolean | null;
}
export interface OpenVikingSupervisorOptions {
  readonly probeIntervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly admissionTimeoutMs?: number;
  readonly maxRestarts?: number;
  readonly restartBaseMs?: number;
  readonly restartMaxMs?: number;
  readonly restartJitterFraction?: number;
  readonly failedProbeRestartThreshold?: number;
  readonly shutdownDeadlineMs?: number;
}
export interface OpenVikingSupervisorPorts {
  readonly probe: (input: OpenVikingSupervisorProbeInput) => Promise<OpenVikingSupervisorReadiness>;
  /** Drains ONLY this host's jobs, not the external backend or another supervisor. */
  readonly drain?: (input: Readonly<{ generation: number; signal: AbortSignal }>) => Promise<void>;
  readonly onSnapshot?: (snapshot: OpenVikingSupervisorSnapshot) => void;
  readonly spawn?: (command: OpenVikingAdmittedCommand) => OpenVikingOwnedProcess;
  readonly verifyRuntime?: (command: OpenVikingAdmittedCommand, signal: AbortSignal) => Promise<boolean>;
  readonly originAvailable?: (origin: string, signal: AbortSignal) => Promise<boolean>;
  readonly random?: () => number;
}
type Bound<T> = Readonly<{ kind: "ok"; value: T }> | Readonly<{ kind: "failed" | "timeout" | "aborted" }>;
interface OwnedGeneration { readonly generation: number; readonly handle: OpenVikingOwnedProcess; readonly controller: AbortController; termination: Promise<boolean> | null; }
const emptyReadiness = (): Readonly<Omit<OpenVikingSupervisorReadiness, "generation" | "configuration">> => Object.freeze({ httpAuthenticated: false, identityMatched: false, accountUsersVerified: false, aclVerified: false, embeddingUsable: false, contentReadWriteConfirmed: false, indexCurrent: false, ownedGenerationVerified: false });
const numberOption = (value: number | undefined, fallback: number, minimum: number, maximum: number) => {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < minimum || result > maximum) throw new TypeError("Invalid supervisor timing or restart bound.");
  return result;
};
function loopbackOrigin(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname) && Boolean(url.port) && url.origin === value && !url.username && !url.password; } catch { return false; }
}
function frozenConfiguration(input: OpenVikingSupervisorConfiguration): OpenVikingSupervisorConfiguration {
  if (input.mode !== "owned") return Object.freeze({ ...input });
  return Object.freeze({ ...input, command: Object.freeze({ ...input.command, args: Object.freeze([...input.command.args]), publicInputPins: Object.freeze(input.command.publicInputPins.map(pin => Object.freeze({ ...pin }))), environment: Object.freeze({ ...input.command.environment }) }) });
}
async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent: AbortSignal): Promise<Bound<T>> {
  if (parent.aborted) return { kind: "aborted" };
  const local = new AbortController();
  return new Promise(resolveResult => {
    let finished = false;
    const finish = (result: Bound<T>) => { if (finished) return; finished = true; clearTimeout(timer); parent.removeEventListener("abort", abort); local.abort(); resolveResult(result); };
    const abort = () => finish({ kind: "aborted" });
    const timer = setTimeout(() => finish({ kind: "timeout" }), Math.max(0, timeoutMs));
    parent.addEventListener("abort", abort, { once: true });
    // Attach both handlers even if a port ignores abort; late results/errors have no lifecycle authority.
    Promise.resolve().then(() => { if (local.signal.aborted) throw new Error("Cancelled supervisor operation."); return operation(local.signal); }).then(value => finish({ kind: "ok", value }), () => finish({ kind: "failed" }));
  });
}
async function privateDirectory(dir: string): Promise<boolean> {
  if (!isAbsolute(dir) || await realpath(dir) !== resolve(dir)) return false;
  const info = await lstat(dir);
  return info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && (typeof process.getuid !== "function" || info.uid === process.getuid());
}
async function verifyFile(file: string, sha256: string, signal: AbortSignal): Promise<boolean> {
  if (!isAbsolute(file) || !/^[a-f0-9]{64}$/.test(sha256) || signal.aborted) return false;
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0) return false;
  return createHash("sha256").update(await readFile(file, { signal })).digest("hex") === sha256;
}
/** Concrete verifier for existing files only: no download, chmod, install, version command or config read. */
export async function verifyOpenVikingAdmittedCommand(command: OpenVikingAdmittedCommand, signal: AbortSignal): Promise<boolean> {
  try {
    if (command.admission !== "host_admitted_loopback_api_key" || command.upstreamPin !== OPENVIKING_SUPERVISOR_UPSTREAM_PIN || !command.expectedVersion || command.expectedVersion.length > 128 || command.attestedVersion !== command.expectedVersion || command.args.length > 128 || command.args.some(arg => typeof arg !== "string" || arg.includes("\0") || arg.length > 8192)) return false;
    if (!await privateDirectory(command.dataDir) || !await privateDirectory(command.configDir) || command.environment["HOME"] !== command.dataDir || command.environment["XDG_CONFIG_HOME"] !== command.configDir || !command.environment["TMPDIR"] || !await privateDirectory(command.environment["TMPDIR"])) return false;
    if (command.publicInputPins.length > 128 || Object.keys(command.environment).length > 64 || Object.entries(command.environment).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0") || value.length > 8192)) return false;
    if (!await verifyFile(command.executable, command.executableSha256, signal) || ((await lstat(command.executable)).mode & 0o111) === 0) return false;
    for (const pin of command.publicInputPins) if (!await verifyFile(pin.path, pin.sha256, signal)) return false;
    return !signal.aborted;
  } catch { return false; }
}
function spawnOwned(command: OpenVikingAdmittedCommand): OpenVikingOwnedProcess {
  const child = spawn(command.executable, [...command.args], { cwd: command.dataDir, env: { ...command.environment }, shell: false, detached: false, stdio: "ignore" });
  let alive = true;
  const exited = new Promise<void>(done => { const finish = () => { if (!alive) return; alive = false; done(); }; child.once("error", finish); child.once("exit", finish); });
  return Object.freeze({ pid: child.pid ?? null, exited, alive: () => alive, signal: (signal: "SIGTERM" | "SIGKILL") => { if (alive && child.exitCode === null && child.signalCode === null) child.kill(signal); } });
}
/** An occupied origin is refused, never cleared. The bind check is not an OS isolation proof. */
function originAvailable(origin: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  const url = new URL(origin), server = createServer();
  return new Promise(done => {
    let finished = false;
    const finish = (ok: boolean) => { if (finished) return; finished = true; signal.removeEventListener("abort", abort); if (server.listening) server.close(() => done(ok)); else done(ok); };
    const abort = () => finish(false);
    signal.addEventListener("abort", abort, { once: true });
    server.once("error", () => finish(false));
    server.once("listening", () => { if (finished) server.close(); else finish(true); });
    server.listen({ host: url.hostname === "[::1]" ? "::1" : url.hostname, port: Number(url.port), exclusive: true });
  });
}

/** Owned child lifecycle only. Call start explicitly; closing a UI is not inferred as host shutdown.
 * onSnapshot may persist sanitized facts in the host's existing journal. No second writer/store here.
 * This class does not prove Python/Rust packaging, embeddings, backup consistency or sandboxing. */
export class OpenVikingSupervisor {
  readonly #configuration: OpenVikingSupervisorConfiguration;
  readonly #ports: OpenVikingSupervisorPorts;
  readonly #options: Required<OpenVikingSupervisorOptions>;
  #state: OpenVikingSupervisorState = "stopped";
  #reason: OpenVikingSupervisorReason = "none";
  #readiness = emptyReadiness();
  #generation = 0;
  #epoch = 0;
  #desired = false;
  #owned: OwnedGeneration | null = null;
  #controller: AbortController | null = null;
  #runPromise: Promise<void> | null = null;
  #first: Promise<OpenVikingSupervisorSnapshot> | null = null;
  #firstDone: (() => void) | null = null;
  #stopPromise: Promise<Readonly<{ complete: boolean; snapshot: OpenVikingSupervisorSnapshot }>> | null = null;
  #restarts = 0;
  #circuitOpen = false;
  #nextDelay: number | null = null;
  #runtimeVerified = false;
  #drainConfirmed: boolean | null = null;

  constructor(configuration: OpenVikingSupervisorConfiguration, ports: OpenVikingSupervisorPorts, options: OpenVikingSupervisorOptions = {}) {
    this.#configuration = frozenConfiguration(configuration); this.#ports = Object.freeze({ ...ports });
    this.#options = Object.freeze({ probeIntervalMs: numberOption(options.probeIntervalMs, 5_000, 1, 3_600_000), probeTimeoutMs: numberOption(options.probeTimeoutMs, 10_000, 1, 300_000), admissionTimeoutMs: numberOption(options.admissionTimeoutMs, 10_000, 1, 300_000), maxRestarts: numberOption(options.maxRestarts, 3, 0, 20), restartBaseMs: numberOption(options.restartBaseMs, 500, 1, 300_000), restartMaxMs: numberOption(options.restartMaxMs, 30_000, 1, 3_600_000), restartJitterFraction: numberOption(options.restartJitterFraction, 0.2, 0, 1), failedProbeRestartThreshold: numberOption(options.failedProbeRestartThreshold, 3, 1, 100), shutdownDeadlineMs: numberOption(options.shutdownDeadlineMs, 5_000, 1, 300_000) });
    if (!Number.isInteger(this.#options.maxRestarts) || !Number.isInteger(this.#options.failedProbeRestartThreshold)) throw new TypeError("Restart bounds must be integers.");
  }
  snapshot(): OpenVikingSupervisorSnapshot {
    return Object.freeze({ state: this.#state, reason: this.#reason, generation: this.#generation, process: Object.freeze({ owned: Boolean(this.#owned), pid: this.#owned?.handle.pid ?? null, alive: this.#configuration.mode === "external" ? null : this.#owned?.handle.alive() ?? false }), runtime: Object.freeze({ sha256Verified: this.#runtimeVerified, versionAttested: this.#runtimeVerified }), readiness: this.#readiness, restarts: this.#restarts, circuitOpen: this.#circuitOpen, nextRestartDelayMs: this.#nextDelay, drainConfirmed: this.#drainConfirmed });
  }
  #publish(state: OpenVikingSupervisorState, reason: OpenVikingSupervisorReason): void {
    this.#state = state; this.#reason = reason;
    try { this.#ports.onSnapshot?.(this.snapshot()); } catch { /* Observability cannot grant authority or break cleanup. */ }
    this.#firstDone?.(); this.#firstDone = null;
  }
  /** Circuit reset requires a fresh explicit host start after stop. It never resets itself on timer. */
  start(options: Readonly<{ resetCircuit?: boolean }> = {}): Promise<OpenVikingSupervisorSnapshot> {
    if (this.#stopPromise) return Promise.resolve(this.snapshot());
    if (this.#desired) return this.#first ?? Promise.resolve(this.snapshot());
    if (this.#owned?.handle.alive()) return Promise.resolve(this.snapshot());
    if (this.#circuitOpen && !options.resetCircuit) return Promise.resolve(this.snapshot());
    if (options.resetCircuit) { this.#circuitOpen = false; this.#restarts = 0; }
    this.#desired = true; this.#readiness = emptyReadiness(); this.#drainConfirmed = null;
    const epoch = ++this.#epoch, controller = new AbortController(); this.#controller = controller;
    this.#first = new Promise(done => { this.#firstDone = () => done(this.snapshot()); });
    this.#state = "starting"; this.#reason = "none";
    this.#runPromise = this.#run(epoch, controller.signal).catch(() => { if (this.#current(epoch, controller.signal)) this.#publish("degraded", "probe_unavailable"); }).finally(() => { this.#firstDone?.(); this.#firstDone = null; });
    return this.#first;
  }
  #current(epoch: number, signal: AbortSignal): boolean { return this.#desired && this.#epoch === epoch && !signal.aborted; }
  async #pause(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>(done => { const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); done(); }; const timer = setTimeout(finish, ms); signal.addEventListener("abort", finish, { once: true }); });
  }
  async #run(epoch: number, signal: AbortSignal): Promise<void> {
    const config = this.#configuration;
    if (config.mode === "unconfigured" || !loopbackOrigin(config.origin) || typeof this.#ports.probe !== "function") { this.#desired = false; this.#publish("blocked_configuration", "configuration_missing"); return; }
    while (this.#current(epoch, signal)) {
      let owned: OwnedGeneration | null = null;
      if (config.mode === "owned") {
        const admitted = await bounded(s => (this.#ports.verifyRuntime ?? verifyOpenVikingAdmittedCommand)(config.command, s), this.#options.admissionTimeoutMs, signal);
        if (!this.#current(epoch, signal)) return;
        if (admitted.kind !== "ok" || !admitted.value) { this.#desired = false; this.#publish("blocked_configuration", "runtime_not_admitted"); return; }
        this.#runtimeVerified = true;
        const available = await bounded(s => (this.#ports.originAvailable ?? originAvailable)(config.origin, s), this.#options.admissionTimeoutMs, signal);
        if (!this.#current(epoch, signal)) return;
        if (available.kind !== "ok" || !available.value) { this.#desired = false; this.#publish("blocked_configuration", "origin_occupied"); return; }
        try {
          const handle = (this.#ports.spawn ?? spawnOwned)(config.command);
          owned = { generation: ++this.#generation, handle, controller: new AbortController(), termination: null }; this.#owned = owned;
          void handle.exited.then(() => owned?.controller.abort(), () => owned?.controller.abort());
          if (!this.#current(epoch, signal)) { await this.#terminate(owned, Date.now() + this.#options.shutdownDeadlineMs); return; }
        } catch { if (!await this.#restart(epoch, signal, "spawn_failed")) return; continue; }
      } else { this.#generation++; }
      let failedProbes = 0, restartReason: OpenVikingSupervisorReason = "process_exit";
      const generation = this.#generation;
      while (this.#current(epoch, signal) && (!owned || owned.handle.alive())) {
        const combined = owned ? AbortSignal.any([signal, owned.controller.signal]) : signal;
        const probe = await bounded(s => this.#ports.probe({ origin: config.origin, generation, ownedPid: owned?.handle.pid ?? null, signal: s }), this.#options.probeTimeoutMs, combined);
        if (!this.#current(epoch, signal)) break;
        if (owned && (!owned.handle.alive() || owned.controller.signal.aborted)) break;
        if (probe.kind === "ok" && probe.value.generation === generation) {
          const facts = probe.value;
          this.#readiness = Object.freeze({ httpAuthenticated: facts.httpAuthenticated === true, identityMatched: facts.identityMatched === true, accountUsersVerified: facts.accountUsersVerified === true, aclVerified: facts.aclVerified === true, embeddingUsable: facts.embeddingUsable === true, contentReadWriteConfirmed: facts.contentReadWriteConfirmed === true, indexCurrent: facts.indexCurrent === true, ownedGenerationVerified: Boolean(owned) && facts.ownedGenerationVerified === true });
          if (facts.configuration !== "admitted") { this.#desired = false; if (owned) await this.#terminate(owned, Date.now() + this.#options.shutdownDeadlineMs); this.#publish("blocked_configuration", "configuration_blocked"); return; }
          failedProbes = this.#readiness.httpAuthenticated && this.#readiness.identityMatched ? 0 : failedProbes + 1;
          const ready = Object.entries(this.#readiness).every(([key, value]) => key === "ownedGenerationVerified" && !owned || value);
          this.#publish(ready ? "ready" : "degraded", ready ? "none" : "readiness_unproven");
        } else { failedProbes++; this.#readiness = emptyReadiness(); this.#publish("degraded", "probe_unavailable"); }
        if (owned && failedProbes >= this.#options.failedProbeRestartThreshold) { restartReason = "probe_unavailable"; break; }
        await this.#pause(this.#options.probeIntervalMs, combined);
      }
      this.#readiness = emptyReadiness();
      if (!this.#current(epoch, signal)) return;
      if (owned && !await this.#terminate(owned, Date.now() + this.#options.shutdownDeadlineMs)) { this.#desired = false; this.#publish("degraded", "shutdown_deadline"); return; }
      if (this.#owned === owned) this.#owned = null;
      if (!await this.#restart(epoch, signal, restartReason)) return;
    }
  }
  async #restart(epoch: number, signal: AbortSignal, reason: OpenVikingSupervisorReason): Promise<boolean> {
    if (!this.#current(epoch, signal)) return false;
    if (this.#restarts >= this.#options.maxRestarts) { this.#circuitOpen = true; this.#desired = false; this.#nextDelay = null; this.#publish("degraded", "restart_budget_exhausted"); return false; }
    const random = this.#ports.random?.() ?? Math.random(), unit = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0.5;
    const base = Math.min(this.#options.restartMaxMs, this.#options.restartBaseMs * 2 ** this.#restarts);
    this.#nextDelay = Math.max(1, Math.min(this.#options.restartMaxMs, Math.round(base * (1 + this.#options.restartJitterFraction * (2 * unit - 1)))));
    this.#restarts++; this.#publish("recovering", reason);
    await this.#pause(this.#nextDelay, signal); this.#nextDelay = null;
    return this.#current(epoch, signal);
  }
  #terminate(owned: OwnedGeneration, deadline: number): Promise<boolean> {
    if (owned.termination) return owned.termination;
    owned.controller.abort();
    owned.termination = (async () => {
      if (!owned.handle.alive()) return true;
      const grace = Math.max(0, deadline - Date.now()), killMargin = Math.min(100, Math.max(1, Math.floor(grace / 4)));
      try { owned.handle.signal("SIGTERM"); } catch { /* Preserve handle and uncertainty; never use a port/PID fallback. */ }
      const never = new AbortController();
      const term = await bounded(() => owned.handle.exited, Math.max(0, grace - killMargin), never.signal);
      if (term.kind === "ok" || !owned.handle.alive()) return true;
      try { if (owned.handle.alive()) owned.handle.signal("SIGKILL"); } catch { /* No inferred rollback. */ }
      await bounded(() => owned.handle.exited, Math.max(0, deadline - Date.now()), never.signal);
      return !owned.handle.alive();
    })(); return owned.termination;
  }
  /** Invalidate before awaiting drain. Retained/late probes and timers cannot spawn again.
   * An unconfirmed own termination retains its handle and reports degraded, never 'stopped'. */
  stop(): Promise<Readonly<{ complete: boolean; snapshot: OpenVikingSupervisorSnapshot }>> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#desired = false; this.#epoch++; this.#controller?.abort(); this.#readiness = emptyReadiness(); this.#nextDelay = null;
    const deadline = Date.now() + this.#options.shutdownDeadlineMs, generation = this.#generation;
    this.#stopPromise = (async () => {
      if (this.#ports.drain) {
        const local = new AbortController();
        const result = await bounded(s => this.#ports.drain!({ generation, signal: s }), Math.max(0, Math.floor((deadline - Date.now()) / 3)), local.signal);
        this.#drainConfirmed = result.kind === "ok";
      }
      const owned = this.#owned;
      const terminated = owned ? await this.#terminate(owned, deadline) : true;
      const remaining = Math.max(0, deadline - Date.now()), local = new AbortController();
      if (this.#runPromise) await bounded(() => this.#runPromise!, remaining, local.signal);
      const alive = this.#owned?.handle.alive() ?? false;
      if (!alive) this.#owned = null;
      const complete = terminated && !alive && this.#drainConfirmed !== false;
      this.#publish(alive ? "degraded" : "stopped", alive ? "shutdown_deadline" : this.#drainConfirmed === false ? "drain_unconfirmed" : "none");
      return Object.freeze({ complete, snapshot: this.snapshot() });
    })().finally(() => { this.#stopPromise = null; });
    return this.#stopPromise;
  }
}
