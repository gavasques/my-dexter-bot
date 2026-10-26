import { isAbsolute, resolve } from 'node:path';
import { lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import type { EngineCatalogEntry, EngineCatalogModel, EngineId, EngineSelection, JsonValue } from '@dexter/contracts';
import type { EngineDriver, EngineEvent, EngineImageInput, EngineOpenOptions, EngineSession, EngineStatus } from './index.js';
import { checkedImageInputs } from './image-input.js';
import { validateNativeMcpServer, isDexterGatewayToolName, type NativeMcpServer } from './mcp-options.js';
import { AsyncQueue, codeOf, EngineError, JsonProcess, object, probe, type DriverOptions, type TrustedRuntimeEnvironment } from './process.js';
import { nativeCatalogDiagnostics, catalogFailure } from './diagnostics.js';
import type { EngineMcpAttachment } from '@dexter/contracts';
import { validateSelection } from './selection.js';

export interface AcpDriverOptions extends DriverOptions {
  /** Only the capability-bound host lease may supply this local transport. */
  localMcpServer?: NativeMcpServer;
  allowedMcpTools?: readonly string[];
  /** Host-owned observer; no native payloads or paths. */
  observeMcpAttachment?: (evidence: EngineMcpAttachment) => void;
}
/** Private provider config/auth root; no personal credentials are inspected or copied. This is not an OS sandbox. */
export function privateAcpHome(engine: string, options: DriverOptions, supplied?: string): string {
  const home = options.env?.HOME ?? homedir();
  const path = supplied ?? resolve(home, ...(process.platform === 'darwin' ? ['Library', 'Application Support', 'Dexter Engine Profiles'] : ['.local', 'share', 'dexter', 'engine-profiles']), engine);
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)) throw new EngineError('protocol_error');
  try { mkdirSync(path, { recursive: true, mode: 0o700 }); const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) throw new Error(); }
  catch { throw new EngineError('engine_unavailable'); }
  return path;
}
interface Pending { resolve: (value: Record<string, unknown>) => void; reject: (error: EngineError) => void; timer: ReturnType<typeof setTimeout> }
/** ACP v1 JSON-RPC. Raw diagnostic/error payloads are intentionally never projected. */
export class AcpRpcClient {
  readonly process: JsonProcess;
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  private failure?: EngineError;
  onNotification: (method: string, params: Record<string, unknown>) => void = () => {};
  onPermission: (params: Record<string, unknown>) => boolean = () => false;
  onExtensionRequest: (method: string, params: Record<string, unknown>) => Record<string, unknown> | undefined = () => undefined;
  onFailure: (error: EngineError) => void = () => {};
  constructor(command: string, args: readonly string[], private readonly options: DriverOptions, runtime: TrustedRuntimeEnvironment) {
    this.process = new JsonProcess(command, args, options, runtime);
    this.process.onFailure = error => this.fail(error);
    this.process.onMessage = message => {
      if (message.jsonrpc !== '2.0') { this.fail(new EngineError('protocol_error')); void this.process.stop(); return; }
      if (typeof message.method === 'string') {
        if (message.id !== undefined) this.answer(message.id, message.method, object(message.params));
        else this.onNotification(message.method, object(message.params));
        return;
      }
      if (typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error !== undefined) {
        const error = object(message.error);
        // ACP's dedicated authentication-required code; the message/data may contain credentials.
        pending.reject(new EngineError(error.code === -32000 ? 'authentication_required' : error.code === -32601 ? 'unsupported' : 'engine_failed'));
      } else if (message.result === null || typeof message.result !== 'object' || Array.isArray(message.result)) pending.reject(new EngineError('protocol_error'));
      else pending.resolve(object(message.result));
    };
  }
  private answer(id: unknown, method: string, params: Record<string, unknown>): void {
    if (!(typeof id === 'string' && id.length <= 128) && !(typeof id === 'number' && Number.isSafeInteger(id))) throw new EngineError('protocol_error');
    if (method === 'session/request_permission') {
      const allowed = this.onPermission(params);
      const candidates = Array.isArray(params.options) ? params.options.slice(0, 32) : [];
      const selected = candidates.map(object).find(option => option.kind === (allowed ? 'allow_once' : 'reject_once') && acpIdentifier(option.optionId));
      this.process.send({ jsonrpc: '2.0', id, result: { outcome: selected ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' } } });
      return;
    }
    const extension = this.onExtensionRequest(method, params);
    if (extension !== undefined) { this.process.send({ jsonrpc: '2.0', id, result: extension }); return; }
    // Client-owned fs/terminal capabilities are explicitly refused. Never execute them locally.
    this.process.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Dexter requires its capability-bound tools.' } });
  }
  private fail(error: EngineError): void {
    if (this.failure) return; this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.onFailure(error);
  }
  request(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs ?? 10000): Promise<Record<string, unknown>> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new EngineError('timeout')); this.fail(new EngineError('timeout')); void this.process.stop();
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      try { this.process.send({ jsonrpc: '2.0', id, method, params }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new EngineError('process_exited')); }
    });
  }
  notify(method: string, params: unknown): void { this.process.send({ jsonrpc: '2.0', method, params }); }
  async initialize(): Promise<Record<string, unknown>> {
    const result = await this.request('initialize', { protocolVersion: 1,
      clientInfo: { name: 'dexter_bot', title: 'Dexter Bot', version: '0.0.1' },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
    if (result.protocolVersion !== 1) throw new EngineError('unsupported');
    return result;
  }
  async stop(): Promise<void> { this.fail(new EngineError('session_closed')); await this.process.stop(); }
}

export function acpIdentifier(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value); }
interface ConfigOption { id: string; category: string; currentValue: string; options: { value: string; name?: string }[] }
function configOptions(raw: unknown): ConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const out: ConfigOption[] = [];
  for (const input of raw.slice(0, 64)) {
    const option = object(input);
    if (option.type !== 'select' || !acpIdentifier(option.id) || !acpIdentifier(option.currentValue) || !Array.isArray(option.options)) continue;
    const items = option.options.flatMap(value => Array.isArray(object(value).options) ? object(value).options as unknown[] : [value]).slice(0, 100);
    const values = items.map(object).filter(item => acpIdentifier(item.value)).map(item => ({ value: item.value as string, ...(typeof item.name === 'string' && item.name.length <= 256 && !/[\u0000-\u001f\u007f]/.test(item.name) ? { name: item.name } : {}) }));
    if (!values.some(value => value.value === option.currentValue)) throw new EngineError('protocol_error');
    out.push({ id: option.id, category: typeof option.category === 'string' ? option.category : '', currentValue: option.currentValue, options: values });
  }
  return out;
}
export function acpCatalogModels(raw: unknown): { models: EngineCatalogModel[]; defaultModel: string | null } {
  const state = object(raw); const configs = configOptions(state.configOptions);
  const modelConfig = configs.find(option => option.category === 'model' || option.id === 'model');
  const effort = configs.find(option => option.category === 'thought_level' || ['reasoning_effort', 'effort', 'thought_level'].includes(option.id));
  const speed = configs.find(option => ['speed', 'service_tier'].includes(option.id));
  const options = modelConfig?.options ?? (Array.isArray(state.availableModels) ? state.availableModels.slice(0, 100).map(object).filter(item => acpIdentifier(item.modelId)).map(item => ({ value: item.modelId as string, ...(typeof item.name === 'string' && item.name.length <= 256 ? { name: item.name } : {}) })) : []);
  return { models: options.map(item => ({ id: item.value, ...(item.name ? { label: item.name } : {}), reasoningEfforts: effort?.options.map(value => value.value) ?? [], speeds: speed?.options.map(value => value.value) ?? [] })), defaultModel: modelConfig?.currentValue ?? (acpIdentifier(state.currentModelId) ? state.currentModelId : null) };
}
export interface AcpProvider {
  id: EngineId; command: string; providerID: string; providerLabel: string;
  args(selection?: EngineSelection): readonly string[];
  runtime: TrustedRuntimeEnvironment;
  beforeLaunch?(): void;
  /** Some packaged ACP executables implement initialize, not a CLI --version. */
  statusViaInitialize?: boolean;
  /** A verified provider limitation must keep execution unavailable, even when initialize succeeds. */
  admissionBlockedReason?: string;
  allowResume?: (options: AcpDriverOptions) => boolean;
  fixedModelProfile?: boolean;
  validateInitialize(result: Record<string, unknown>): void;
  sessionParameters(selection: EngineSelection | undefined, resumed: boolean, options: AcpDriverOptions): Record<string, unknown>;
  catalogState(result: Record<string, unknown>): Record<string, unknown>;
  configure(client: AcpRpcClient, sessionId: string, initialized: Record<string, unknown>, sessionState: Record<string, unknown>, selection: EngineSelection | undefined, options: AcpDriverOptions): Promise<void>;
  verifyTurn?(client: AcpRpcClient, sessionId: string, options: AcpDriverOptions): Promise<void>;
  nativeToolAllowed?(update: Record<string, unknown>, options: AcpDriverOptions): boolean;
  permissionAllowed?(toolCall: Record<string, unknown>, options: AcpDriverOptions): boolean;
  extensionRequest?(method: string, params: Record<string, unknown>, sessionId: string, options: AcpDriverOptions): Record<string, unknown> | undefined;
}
interface Active { turnId: string; queue: AsyncQueue<EngineEvent>; finish: (event: EngineEvent) => void; stopping?: Promise<void> }
interface State { session: EngineSession; client: AcpRpcClient; initialized: Record<string, unknown>; sessionState: Record<string, unknown>; defaults: ConfigOption[]; selection?: EngineSelection; active?: Active; failed?: EngineError }

/** ACP tools execute through the real host MCP lease; native terminal/fs never receive client grants. */
export class AcpEngineDriver implements EngineDriver {
  readonly id: EngineId;
  readonly capabilities = { resume: false, interrupt: true, fork: false, steer: false, supportsImages: false };
  private readonly states = new Map<EngineSession, State>();
  protected readonly options: AcpDriverOptions;
  constructor(protected readonly provider: AcpProvider, supplied: AcpDriverOptions = {}) {
    this.id = provider.id;
    const aliases = Object.freeze([...(supplied.allowedMcpTools ?? [])]);
    if (aliases.length > 256 || new Set(aliases).size !== aliases.length || aliases.some(name => !isDexterGatewayToolName(name)) || aliases.length && !supplied.localMcpServer) throw new EngineError('protocol_error');
    const cwd = supplied.cwd ?? process.cwd();
    if (!isAbsolute(cwd) || resolve(cwd) !== cwd || /[\u0000-\u001f\u007f]/.test(cwd)) throw new EngineError('protocol_error');
    this.options = { ...supplied, cwd, allowedMcpTools: aliases, ...(supplied.localMcpServer ? { localMcpServer: validateNativeMcpServer(supplied.localMcpServer) } : {}) };
  }
  private createClient(selection?: EngineSelection): AcpRpcClient { this.provider.beforeLaunch?.(); return new AcpRpcClient(this.options.command ?? this.provider.command, this.provider.args(selection), this.options, this.provider.runtime); }
  async status(): Promise<EngineStatus> {
    const result: EngineStatus = { engine: this.id, installed: false, version: null, authentication: 'unknown', billing: 'subscription' };
    if (this.provider.statusViaInitialize) {
      let client: AcpRpcClient | undefined;
      try { client = this.createClient(); const initialized = await client.initialize(); this.provider.validateInitialize(initialized); result.installed = true; const version = object(initialized.agentInfo).version; result.version = typeof version === 'string' ? version.match(/\d+\.\d+\.\d+/)?.[0] ?? null : null; }
      catch { /* Metadata probe cannot prove login. */ } finally { await client?.stop(); }
      return result;
    }
    try { const version = await probe(this.options, this.options.command ?? this.provider.command, ['--version'], this.provider.runtime); if (version.exitCode === 0) { result.installed = true; result.version = version.text.match(/\d+\.\d+\.\d+/)?.[0] ?? null; } } catch { /* Safe metadata only; no account/authfile probe. */ }
    return result;
  }
  async catalog(): Promise<EngineCatalogEntry> {
    const diagnostics = nativeCatalogDiagnostics('acp', !!this.provider.admissionBlockedReason);
    const result: EngineCatalogEntry = { id: this.id, providerID: this.provider.providerID, providerLabel: this.provider.providerLabel, catalogSource: 'native_acp_initialize', diagnostics, installed: false, adapterSupported: true, available: false, models: [], defaultModel: null, reasoningEfforts: [], speeds: [] };
    let client: AcpRpcClient | undefined;
    try {
      if (!this.provider.statusViaInitialize) {
        const status = await this.status(); result.installed = status.installed; if (status.version) result.version = status.version;
        if (!status.installed) { diagnostics.code = 'not_installed'; return { ...result, unavailableReason: 'Official ACP runtime not installed.' }; }
      }
      client = this.createClient(); const initialized = await client.initialize(); this.provider.validateInitialize(initialized);
      diagnostics.initialization = 'validated';
      result.installed = true; const version = object(initialized.agentInfo).version ?? object(initialized._meta).agentVersion; if (typeof version === 'string') { const publicVersion = version.match(/\b\d+\.\d+\.\d+\b/)?.[0]; if (publicVersion) result.version = publicVersion; }
      const catalog = acpCatalogModels(this.provider.catalogState(initialized)); result.models = catalog.models; result.defaultModel = catalog.defaultModel;
      const defaultModel = result.models.find(model => model.id === result.defaultModel); result.reasoningEfforts = defaultModel?.reasoningEfforts ?? []; result.speeds = defaultModel?.speeds ?? [];
      // These consumer adapters do not implement speed; a catalog cannot advertise a choice the driver refuses.
      result.speeds = []; for (const model of result.models) model.speeds = [];
      if (this.provider.admissionBlockedReason) { diagnostics.code = 'admission_blocked'; return { ...result, available: false, models: [], defaultModel: null, reasoningEfforts: [], unavailableReason: this.provider.admissionBlockedReason }; }
      if (!result.models.length) { diagnostics.catalog = 'failed'; diagnostics.code = 'catalog_unavailable'; result.unavailableReason = 'Official ACP model catalog is empty.'; return result; }
      if (new Set(result.models.map(model => model.id)).size !== result.models.length || result.defaultModel !== null && !result.models.some(model => model.id === result.defaultModel)) throw new EngineError('protocol_error');
      diagnostics.catalog = 'validated'; diagnostics.code = 'capabilities_validated'; result.available = true;
    } catch (error) { catalogFailure(diagnostics, error); result.models = []; result.defaultModel = null; result.reasoningEfforts = []; result.speeds = []; result.unavailableReason = 'Official ACP capabilities unavailable; retry discovery.'; }
    finally { await client?.stop(); }
    return result;
  }
  async open(threadId: string, nativeCursor?: string, options?: EngineOpenOptions): Promise<EngineSession> {
    validateSelection(this.id, options?.selection);
    if (this.provider.admissionBlockedReason) throw new EngineError('unsupported');
    if (nativeCursor !== undefined && !acpIdentifier(nativeCursor)) throw new EngineError('protocol_error');
    const client = this.createClient(options?.selection);
    try {
      const initialized = await client.initialize(); this.provider.validateInitialize(initialized);
      const catalog = acpCatalogModels(this.provider.catalogState(initialized));
      if (!catalog.models.length) throw new EngineError('unsupported');
      if (new Set(catalog.models.map(model => model.id)).size !== catalog.models.length || catalog.defaultModel !== null && !catalog.models.some(model => model.id === catalog.defaultModel)) throw new EngineError('protocol_error');
      const capabilities = object(initialized.agentCapabilities); const extensions = object(capabilities.sessionCapabilities);
      this.capabilities.resume = (this.provider.allowResume?.(this.options) ?? true) && (capabilities.loadSession === true || extensions.resume !== undefined && extensions.resume !== null);
      this.capabilities.supportsImages = object(capabilities.promptCapabilities).image === true;
      if (nativeCursor !== undefined && !this.capabilities.resume) throw new EngineError('unsupported');
      const transport = this.options.localMcpServer;
      const base = { cwd: this.options.cwd!, mcpServers: transport ? [{ name: 'dexter_gateway', command: transport.command, args: [...transport.args], env: [] }] : [], ...this.provider.sessionParameters(options?.selection, nativeCursor !== undefined, this.options) };
      const method = nativeCursor === undefined ? 'session/new' : extensions.resume !== undefined && extensions.resume !== null ? 'session/resume' : 'session/load';
      const sessionState = await client.request(method, { ...base, ...(nativeCursor === undefined ? {} : { sessionId: nativeCursor }) });
      const cursor = nativeCursor ?? sessionState.sessionId;
      if (!acpIdentifier(cursor) || nativeCursor !== undefined && sessionState.sessionId !== undefined && sessionState.sessionId !== nativeCursor) throw new EngineError('protocol_error');
      const session = { threadId, nativeCursor: cursor };
      const state: State = { session, client, initialized, sessionState, defaults: configOptions(sessionState.configOptions), ...(options?.selection ? { selection: options.selection } : {}) };
      client.onNotification = (name, params) => this.notification(state, name, params);
      client.onPermission = params => this.permission(state, params);
      client.onExtensionRequest = (method, params) => this.provider.extensionRequest?.(method, params, state.active ? cursor : '', this.options);
      client.onFailure = error => {
        if (state.failed?.code === 'session_uncertain') return;
        if (state.active) void this.stopActive(state, { type: 'turn.failed', threadId, turnId: state.active.turnId, code: error.code });
        else state.failed = error;
      };
      await this.provider.configure(client, cursor, initialized, sessionState, options?.selection, this.options);
      state.defaults = configOptions(sessionState.configOptions);
      await this.select(state, options?.selection); this.states.set(session, state); return session;
    } catch (error) { await client.stop(); throw error; }
  }
  private permission(state: State, params: Record<string, unknown>): boolean {
    if (!state.active || params.sessionId !== state.session.nativeCursor) return false;
    const name = object(params.toolCall).name;
    // An exact advertised gateway alias is eligible for one native transport call only.
    // The gateway still applies the bot's grant, approval, revision and receipt itself.
    return typeof name === 'string' && this.options.allowedMcpTools!.includes(name) || this.provider.permissionAllowed?.(object(params.toolCall), this.options) === true;
  }
  private notification(state: State, method: string, params: Record<string, unknown>): void {
    if (method !== 'session/update' || params.sessionId !== state.session.nativeCursor || !state.active) return;
    const update = object(params.update); const active = state.active;
    if (update.sessionUpdate === 'agent_message_chunk') {
      const content = object(update.content);
      if (content.type !== 'text' || typeof content.text !== 'string') { void this.stopActive(state, { type: 'turn.failed', threadId: state.session.threadId, turnId: active.turnId, code: 'unsupported' }); return; }
      try { active.queue.push({ type: 'text.delta', threadId: state.session.threadId, turnId: active.turnId, text: content.text }); }
      catch { void this.stopActive(state, { type: 'turn.failed', threadId: state.session.threadId, turnId: active.turnId, code: 'protocol_error' }); }
    } else if (update.sessionUpdate === 'config_option_update') {
      state.sessionState = { ...state.sessionState, configOptions: update.configOptions };
    } else if (update.sessionUpdate === 'tool_call') {
      const name = update.name;
      const knownGateway = typeof name === 'string' && this.options.allowedMcpTools!.includes(name);
      if (!knownGateway && !this.provider.nativeToolAllowed?.(update, this.options)) void this.stopActive(state, { type: 'turn.failed', threadId: state.session.threadId, turnId: active.turnId, code: 'unsupported' });
    }
  }
  private async select(state: State, selection?: EngineSelection): Promise<void> {
    if (!selection) return;
    validateSelection(this.id, selection);
    let options = configOptions(state.sessionState.configOptions);
    const wanted: [string, string | null][] = [['model', selection.model], ['effort', selection.reasoningEffort], ['speed', selection.speed]];
    for (const [kind, value] of wanted) {
      const matches = (option: ConfigOption): boolean => kind === 'model' ? option.category === 'model' || option.id === 'model' : kind === 'effort' ? option.category === 'thought_level' || ['reasoning_effort', 'effort', 'thought_level'].includes(option.id) : ['speed', 'service_tier'].includes(option.id);
      const config = options.find(matches);
      if (!config) {
        if (value !== null) {
          // Legacy model state is accepted only if the provider established that same model safely.
          if (kind !== 'model' || object(state.sessionState.models).currentModelId !== value) throw new EngineError('unsupported');
        }
        continue;
      }
      const target = value ?? state.defaults.find(matches)?.currentValue;
      if (target === undefined || !config.options.some(option => option.value === target)) throw new EngineError('unsupported');
      if (config.currentValue === target) continue;
      // Grok's model switch may rebuild its tool profile. Re-open using the host's context handoff instead.
      if (kind === 'model' && this.provider.fixedModelProfile) throw new EngineError('unsupported');
      const response = await state.client.request('session/set_config_option', { sessionId: state.session.nativeCursor, configId: config.id, value: target });
      options = configOptions(response.configOptions); if (!options.some(option => option.id === config.id && option.currentValue === target)) throw new EngineError('protocol_error');
      state.sessionState = { ...state.sessionState, configOptions: response.configOptions };
    }
  }
  async *turn(session: EngineSession, turnId: string, input: string, signal: AbortSignal, selection?: EngineSelection, images: readonly EngineImageInput[] = []): AsyncIterable<EngineEvent> {
    const state = this.states.get(session); if (!state) throw new EngineError('session_closed'); if (state.active) throw new EngineError('busy'); if (state.failed) throw new EngineError('session_uncertain');
    validateSelection(this.id, selection); if (signal.aborted) { yield { type: 'turn.interrupted', threadId: session.threadId, turnId }; return; }
    if (images.length && !this.capabilities.supportsImages) throw new EngineError('unsupported');
    const payload = [{ type: 'text', text: input }, ...checkedImageInputs(session.threadId, images).map(({ image, data }) => ({ type: 'image', mimeType: image.mediaType, data: data.toString('base64') }))];
    if (Buffer.byteLength(JSON.stringify(payload)) > 2 * 1024 * 1024) throw new EngineError('protocol_error');
    const queue = new AsyncQueue<EngineEvent>(); let finished = false;
    const active: Active = { turnId, queue, finish: event => { if (finished) return; finished = true; queue.pushFinal(event, { type: 'turn.failed', threadId: session.threadId, turnId, code: 'protocol_error' }); queue.end(); } };
    state.active = active;
    const abort = (): void => { void this.stopActive(state, { type: 'turn.interrupted', threadId: session.threadId, turnId }); };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { void this.stopActive(state, { type: 'turn.failed', threadId: session.threadId, turnId, code: 'timeout' }); }, this.options.turnTimeoutMs ?? 300000);
    void (async () => {
      try {
        await this.select(state, selection ?? state.selection);
        await this.provider.verifyTurn?.(state.client, session.nativeCursor, this.options);
        if (signal.aborted || finished || active.stopping) return;
        const result = await state.client.request('session/prompt', { sessionId: session.nativeCursor, prompt: payload }, this.options.turnTimeoutMs ?? 300000);
        if (finished || active.stopping) return;
        if (result.stopReason === 'cancelled') active.finish({ type: 'turn.interrupted', threadId: session.threadId, turnId });
        else if (result.stopReason === 'end_turn' || result.stopReason === 'max_tokens' || result.stopReason === 'refusal') active.finish({ type: 'turn.completed', threadId: session.threadId, turnId, usage: safeUsage(result.usage) });
        else active.finish({ type: 'turn.failed', threadId: session.threadId, turnId, code: 'engine_failed' });
      } catch (error) { if (!finished && !active.stopping) await this.stopActive(state, { type: 'turn.failed', threadId: session.threadId, turnId, code: codeOf(error) }); }
    })();
    try { let event: EngineEvent | undefined; while ((event = await queue.next()) !== undefined) yield event; }
    finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (!finished) await this.stopActive(state, { type: 'turn.interrupted', threadId: session.threadId, turnId });
      await active.stopping; if (state.active === active) delete state.active;
    }
  }
  private stopActive(state: State, event: EngineEvent): Promise<void> {
    const active = state.active; if (!active) return Promise.resolve(); if (active.stopping) return active.stopping;
    state.failed = new EngineError('session_uncertain');
    active.stopping = (async () => { try { state.client.notify('session/cancel', { sessionId: state.session.nativeCursor }); } catch { /* A closed pipe cannot cancel. */ } await state.client.stop(); active.finish(event); })();
    return active.stopping;
  }
  async respondToTool(_session: EngineSession, _turnId: string, _requestId: string, _result: JsonValue): Promise<void> { throw new EngineError('unsupported'); }
  async interrupt(session: EngineSession, turnId: string): Promise<void> { const state = this.states.get(session); if (state?.active?.turnId === turnId) await this.stopActive(state, { type: 'turn.interrupted', threadId: session.threadId, turnId }); }
  async close(session: EngineSession): Promise<void> {
    const state = this.states.get(session); if (!state) return;
    if (state.active) await this.interrupt(session, state.active.turnId);
    const close = object(object(state.initialized.agentCapabilities).sessionCapabilities).close;
    if (!state.failed && close !== undefined && close !== null) { try { await state.client.request('session/close', { sessionId: session.nativeCursor }); } catch { /* Process group cleanup remains required. */ } }
    await state.client.stop(); this.states.delete(session);
  }
}
function safeUsage(raw: unknown): JsonValue {
  const usage = object(raw); const out: Record<string, number> = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedReadTokens', 'thoughtTokens']) if (typeof usage[key] === 'number' && Number.isSafeInteger(usage[key]) && usage[key] >= 0) out[key] = usage[key];
  return out;
}
