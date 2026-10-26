import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { EngineCatalogEntry, EngineCatalogModel, EngineSelection, JsonValue } from '@dexter/contracts';
import type { EngineDriver, EngineEvent, EngineImageInput, EngineOpenOptions, EngineSession, EngineStatus } from './index.js';
import { checkedImageInputs } from './image-input.js';
import { validateNativeMcpServer, isDexterGatewayToolName, type NativeMcpServer } from './mcp-options.js';
import { AsyncQueue, codeOf, EngineError, JsonProcess, object, probe, type DriverOptions, type EngineErrorCode, type TrustedRuntimeEnvironment } from './process.js';
import { nativeCatalogDiagnostics, catalogFailure } from './diagnostics.js';
import type { EngineMcpAttachment } from '@dexter/contracts';
import { validateSelection } from './selection.js';

/** Offline schema exported by Muse Code 1.4.4-R5419.1; unknown contracts fail closed. */
export const MUSE_MSP_SCHEMA_FINGERPRINT = 'sha256:7c94f153c41659cb3f1bd3c3e04438be254644cb2a97d65d48edc7449b74858a';
export interface MuseDriverOptions extends DriverOptions {
  localMcpServer?: NativeMcpServer;
  /** Exact host-gateway tools only. These names grant no upstream authority. */
  allowedMcpTools?: readonly string[];
  observeMcpAttachment?: (evidence: EngineMcpAttachment) => void;
  /** Trusted, owner-only CLI profile outside Dexter snapshots; auth is CLI-owned. */
  authConfigDirectory?: string;
}
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safeID = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
function uuidV7(): string {
  const bytes = randomBytes(16); bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 15) | 0x70; bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function mspError(value: unknown): EngineError {
  const error = object(value), kind = object(error.data).kind;
  const code: EngineErrorCode = kind === 'authRequired' ? 'authentication_required'
    : kind === 'invalidParams' || kind === 'parseError' || kind === 'invalidRequest' ? 'protocol_error'
    : kind === 'methodNotFound' || kind === 'capabilityRequired' || kind === 'experimentalRequired' ? 'unsupported'
    : kind === 'overloaded' || kind === 'backpressured' ? 'engine_unavailable' : 'engine_failed';
  // Provider messages and reasons are deliberately discarded.
  return new EngineError(code);
}
interface PrivateRuntime { root: string; env: TrustedRuntimeEnvironment; workspace: string }
function profileDirectory(options: MuseDriverOptions): string {
  const home = options.env?.HOME ?? homedir();
  const path = options.authConfigDirectory ?? (process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Dexter Engine Profiles', 'Muse')
    : join(home, '.local', 'share', 'dexter', 'engine-profiles', 'muse'));
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)) throw new EngineError('protocol_error');
  return path;
}
async function ensureProfile(config: string): Promise<void> {
  // Reject symlinks before creating descendants, including an ancestor alias.
  let ancestor = '/';
  for (const part of join(config, 'muse').split('/').filter(Boolean)) {
    ancestor = join(ancestor, part);
    try { const stat = await lstat(ancestor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new EngineError('protocol_error'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(ancestor, { mode: 0o700 });
    }
  }
  const uid = process.getuid?.();
  for (const path of [config, join(config, 'muse')]) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0 || await realpath(path) !== path) throw new EngineError('protocol_error');
    await chmod(path, 0o700);
  }
  const settings = join(config, 'muse', 'settings.json');
  try {
    const stat = await lstat(settings);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0) throw new EngineError('protocol_error');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(config, 'muse', `.dexter-settings-${randomBytes(12).toString('hex')}.json`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ schema_version: 1, mcpServers: {}, hooks: {} })); }
    finally { await file.close(); }
    await rename(temporary, settings);
  } finally { await rm(temporary, { force: true }); }
}
async function privateRuntime(options: MuseDriverOptions): Promise<PrivateRuntime> {
  // macOS exposes /var and /tmp aliases while native cwd resolves to /private/….
  // The session workspace identity must use the same physical path as the child.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dexter-muse-runtime-'))); await chmod(root, 0o700);
  try {
    const config = profileDirectory(options), data = join(root, 'data'), cache = join(root, 'cache'), workspace = join(root, 'workspace');
    await ensureProfile(config);
    for (const dir of [data, cache, workspace]) await mkdir(dir, { recursive: true, mode: 0o700 });
    // Never read/copy/symlink the user's settings, credentials, plugins, trust or sessions.
    // Only our exact settings are written. The official CLI may retain auth in this
    // separate stable profile (including file fallback); Dexter never opens auth.
    return { root, workspace, env: { MUSE_NO_AUTO_UPDATE: '1', XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_CACHE_HOME: cache } };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error instanceof EngineError ? error : new EngineError('engine_unavailable'); }
}
class MspClient {
  readonly process: JsonProcess;
  private sequence = 0;
  private failure?: EngineError;
  private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: EngineError) => void; timer: ReturnType<typeof setTimeout> }>();
  onNotification: (method: string, params: Record<string, unknown>) => void = () => {};
  onRequest: (id: string | number, method: string, params: Record<string, unknown>) => void = () => {};
  onFailure: (error: EngineError) => void = () => {};
  constructor(private readonly options: MuseDriverOptions, runtime: PrivateRuntime) {
    const tools = options.allowedMcpTools ?? [];
    const overrides = [
      `run.toolset=${JSON.stringify(tools)}`, 'run.reminder_roster=[]', 'run.system_prompt=null', 'run.developer_prompt=null',
      'hooks={}', 'managed_hooks_path=null', 'managed_plugins_path=null', 'managed_skills_path=null',
      'context.foreign_personal_rules=false', 'context.foreign_personal_skills=false', 'local_session_messaging.enabled=false',
      'telemetry.enabled=false', 'feature_config.enabled=false',
    ];
    this.process = new JsonProcess(options.command ?? 'muse', ['serve', '--provider', 'meta', '--no-session-log', '--disable-shell', '--disable-write', ...overrides.flatMap(value => ['-c', value])], { ...options, cwd: runtime.workspace }, runtime.env);
    this.process.onFailure = error => this.fail(error);
    this.process.onMessage = message => {
      if (message.jsonrpc !== '2.0') throw new EngineError('protocol_error');
      if (typeof message.method === 'string') {
        const params = object(message.params);
        if (message.id !== undefined) {
          if (typeof message.id !== 'string' && typeof message.id !== 'number') throw new EngineError('protocol_error');
          this.onRequest(message.id, message.method, params);
        } else this.onNotification(message.method, params);
        return;
      }
      if (typeof message.id !== 'number') throw new EngineError('protocol_error');
      const pending = this.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(mspError(message.error));
      else if (message.result === null || Array.isArray(message.result) || typeof message.result !== 'object') pending.reject(new EngineError('protocol_error'));
      else pending.resolve(object(message.result));
    };
    this.onRequest = (id) => this.error(id);
  }
  private fail(error: EngineError): void {
    if (this.failure) return; this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.onFailure(error);
  }
  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new EngineError('timeout')); this.fail(new EngineError('timeout')); void this.process.stop(); }, this.options.requestTimeoutMs ?? 10000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.process.send({ jsonrpc: '2.0', id, method, params }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new EngineError('process_exited')); }
    });
  }
  receipt(id: string | number): void { this.process.send({ jsonrpc: '2.0', id, result: {} }); }
  error(id: string | number): void { this.process.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported client request' } }); }
  async initialize(mcp: boolean): Promise<void> {
    const result = await this.request('initialize', { clientInfo: { name: 'dexter_bot', title: 'Dexter Bot', version: '0.0.1' }, capabilities: { requestedCapabilities: mcp ? ['sessionMcp'] : [], userInputDialogs: false } });
    const schema = object(result.schema);
    if (schema.version !== 1 || schema.fingerprint !== MUSE_MSP_SCHEMA_FINGERPRINT || result.sessionDurability !== 'ephemeral' || !Array.isArray(result.grantedCapabilities) || result.grantedCapabilities.some(value => value !== 'sessionMcp') || (mcp && !result.grantedCapabilities.includes('sessionMcp'))) throw new EngineError('unsupported');
    this.process.send({ jsonrpc: '2.0', method: 'initialized' });
  }
  async stop(): Promise<void> { this.fail(new EngineError('session_closed')); await this.process.stop(); }
}
interface ItemState { text: string; revision: number; completed: boolean }
interface Active {
  turnId: string; nativeTurnId?: string; queue: AsyncQueue<EngineEvent>; finish: (event: EngineEvent) => void;
  buffered: { method: string; params: Record<string, unknown> }[]; bufferedBytes: number;
  items: Map<string, ItemState>; approvals: Set<string>; settled: boolean; cancellation?: Promise<void>;
}
interface State { session: EngineSession; client: MspClient; runtime: PrivateRuntime; models: EngineCatalogModel[]; defaultModel: string | null; currentModel?: string; selection?: EngineSelection; active?: Active; failed?: EngineError }

/** MSP sessions are memory-only: same-process continuity, no durable native resume claim. */
export class MuseMspDriver implements EngineDriver {
  readonly id = 'muse' as const;
  readonly capabilities = { resume: false, interrupt: true, fork: false, steer: false, supportsImages: true } as const;
  private states = new Map<EngineSession, State>();
  constructor(private readonly options: MuseDriverOptions = {}) {
    const tools = Object.freeze([...(options.allowedMcpTools ?? [])]);
    if (tools.length > 128 || new Set(tools).size !== tools.length || tools.some(name => !isDexterGatewayToolName(name)) || (tools.length > 0 && !options.localMcpServer)) throw new EngineError('protocol_error');
    this.options = { ...options, allowedMcpTools: tools, ...(options.localMcpServer ? { localMcpServer: validateNativeMcpServer(options.localMcpServer) } : {}) };
    profileDirectory(this.options);
  }
  async status(): Promise<EngineStatus> {
    const result: EngineStatus = { engine: this.id, installed: false, version: null, authentication: 'unknown', billing: 'subscription' };
    let runtime: PrivateRuntime | undefined;
    try { runtime = await privateRuntime(this.options); const version = await probe(this.options, this.options.command ?? 'muse', ['--version'], runtime.env); if (version.exitCode === 0) { result.installed = true; result.version = version.text.match(/\d+\.\d+\.\d+(?:-R\d+\.\d+)?/)?.[0] ?? null; } } catch { /* No credential/account probe. */ }
    finally { if (runtime) await rm(runtime.root, { recursive: true, force: true }); }
    return result;
  }
  private async models(client: MspClient): Promise<{ models: EngineCatalogModel[]; defaultModel: string | null }> {
    const result = await client.request('model/list', {});
    if (result.providerId !== 'meta' || !Array.isArray(result.models) || result.models.length > 100) throw new EngineError('protocol_error');
    const models: EngineCatalogModel[] = [], seen = new Set<string>(); let defaultModel: string | null = null;
    for (const value of result.models) {
      const row = object(value);
      if (!safeID(row.modelId) || row.providerId !== 'meta' || seen.has(row.modelId)) throw new EngineError('protocol_error');
      seen.add(row.modelId);
      const efforts = Array.isArray(row.variants) ? row.variants : [];
      if (efforts.length > 8 || efforts.some(item => typeof item !== 'string' || !EFFORTS.has(item))) throw new EngineError('protocol_error');
      const model: EngineCatalogModel = { id: row.modelId, reasoningEfforts: [...new Set(efforts as string[])], speeds: [] };
      if (typeof row.displayLabel === 'string' && row.displayLabel.length <= 256 && !/[\u0000-\u001f\u007f]/.test(row.displayLabel)) model.label = row.displayLabel;
      models.push(model); if (row.isDefault === true) defaultModel = row.modelId;
    }
    return { models, defaultModel };
  }
  async catalog(): Promise<EngineCatalogEntry> {
    const diagnostics = nativeCatalogDiagnostics('msp');
    const entry: EngineCatalogEntry = { id: this.id, providerID: 'meta', providerLabel: 'Meta', catalogSource: 'installed-muse-msp-model-list-v1', diagnostics, available: false, installed: false, adapterSupported: true, models: [], defaultModel: null, reasoningEfforts: [], speeds: [] };
    let client: MspClient | undefined, runtime: PrivateRuntime | undefined;
    try {
      const status = await this.status(); entry.installed = status.installed; if (status.version) entry.version = status.version;
      if (!status.installed) { diagnostics.code = 'not_installed'; entry.unavailableReason = 'CLI not installed.'; return entry; }
      runtime = await privateRuntime(this.options); client = new MspClient({ ...this.options, allowedMcpTools: [] }, runtime); await client.initialize(false); diagnostics.initialization = 'validated';
      const catalog = await this.models(client); entry.models = catalog.models; entry.defaultModel = catalog.defaultModel;
      entry.reasoningEfforts = catalog.models.find(model => model.id === catalog.defaultModel)?.reasoningEfforts ?? [];
      if (!entry.models.length) { diagnostics.catalog = 'failed'; diagnostics.code = 'catalog_unavailable'; entry.unavailableReason = 'MSP model catalog is empty.'; return entry; }
      diagnostics.catalog = 'validated'; diagnostics.code = 'capabilities_validated'; entry.available = true;
    } catch (error) { catalogFailure(diagnostics, error); entry.models = []; entry.defaultModel = null; entry.reasoningEfforts = []; entry.unavailableReason = entry.installed ? 'MSP catalog unavailable in the private runtime. Retry discovery.' : 'CLI not installed.'; }
    finally { await client?.stop(); if (runtime) await rm(runtime.root, { recursive: true, force: true }); }
    return entry;
  }
  private assertSelection(selection: EngineSelection | undefined, models: EngineCatalogModel[], defaultModel: string | null): void {
    validateSelection(this.id, selection);
    if (selection?.speed !== undefined && selection.speed !== null) throw new EngineError('unsupported');
    const modelID = selection?.model ?? this.options.model ?? defaultModel;
    const model = modelID ? models.find(row => row.id === modelID) : undefined;
    if (modelID && !model) throw new EngineError('unsupported');
    if (selection?.reasoningEffort && (!EFFORTS.has(selection.reasoningEffort) || !(model?.reasoningEfforts.includes(selection.reasoningEffort)))) throw new EngineError('unsupported');
  }
  async open(threadId: string, nativeCursor?: string, options?: EngineOpenOptions): Promise<EngineSession> {
    validateSelection(this.id, options?.selection); if (nativeCursor !== undefined) throw new EngineError('unsupported');
    const runtime = await privateRuntime(this.options); let client: MspClient | undefined;
    try {
      client = new MspClient(this.options, runtime); await client.initialize(Boolean(this.options.localMcpServer));
      const catalog = await this.models(client); if (!catalog.models.length) throw new EngineError('unsupported'); this.assertSelection(options?.selection, catalog.models, catalog.defaultModel);
      const modelID = options?.selection?.model ?? this.options.model ?? catalog.defaultModel;
      const result = await client.request('session/start', { commandId: uuidV7(), workspaceRoot: runtime.workspace, providerId: 'meta', approvalMode: 'promptUnmatched', ...(modelID ? { modelId: modelID } : {}), ...(this.options.localMcpServer ? { config: { mcpServers: { dexter_gateway: { transport: 'stdio', mode: 'required', framing: 'lineDelimitedJson', ...this.options.localMcpServer } } } } : {}) });
      const value = object(result.session);
      if (typeof value.sessionId !== 'string' || !UUID.test(value.sessionId) || value.providerId !== 'meta' || value.status !== 'idle' || value.activeTurnId !== null || object(value.approvalMode).mode !== 'promptUnmatched' || (modelID && value.modelId !== modelID)) throw new EngineError('protocol_error');
      const session: EngineSession = { threadId, nativeCursor: value.sessionId };
      const state: State = { session, client, runtime, models: catalog.models, defaultModel: catalog.defaultModel, ...(modelID ? { currentModel: modelID } : {}), ...(options?.selection ? { selection: { ...options.selection } } : {}) };
      client.onFailure = error => { state.failed = error; state.active?.finish({ type: 'turn.failed', threadId, turnId: state.active.turnId, code: error.code }); };
      client.onNotification = (method, params) => this.notification(state, method, params);
      client.onRequest = (id, method, params) => {
        if (method === 'approval/request' && params.sessionId === session.nativeCursor) { client!.receipt(id); this.notification(state, 'approval/requested', params); }
        else { client!.error(id); if (method === 'userInput/request') this.failState(state, 'unsupported'); }
      };
      // Required config accepted is weaker than a verified merged MCP registry. Do not claim attachment.
      if (this.options.localMcpServer) this.options.observeMcpAttachment?.({ engine: 'muse', state: 'unverified', code: 'required_session_configuration' });
      this.states.set(session, state); return session;
    } catch (error) { await client?.stop(); await rm(runtime.root, { recursive: true, force: true }); throw error; }
  }
  private failState(state: State, code: EngineErrorCode): void {
    state.failed = new EngineError(code);
    state.active?.finish({ type: 'turn.failed', threadId: state.session.threadId, turnId: state.active.turnId, code });
    void state.client.stop();
  }
  private notification(state: State, method: string, params: Record<string, unknown>): void {
    const active = state.active; if (!active || active.settled || params.sessionId !== state.session.nativeCursor) return;
    if (method === 'view/gap') { this.failState(state, 'protocol_error'); return; }
    if (!['item/started', 'item/updated', 'item/completed', 'item/delta', 'turn/completed', 'approval/requested', 'approval/updated'].includes(method)) return;
    if (!active.nativeTurnId) {
      const bytes = Buffer.byteLength(JSON.stringify(params));
      if (active.buffered.length >= 1024 || active.bufferedBytes + bytes > 2 * 1024 * 1024) throw new EngineError('protocol_error');
      active.buffered.push({ method, params }); active.bufferedBytes += bytes; return;
    }
    const identity = { threadId: state.session.threadId, turnId: active.turnId };
    if (method === 'approval/requested' || method === 'approval/updated') {
      if (params.turnId !== active.nativeTurnId) return;
      void this.approval(state, active, params).catch(() => this.failState(state, 'protocol_error')); return;
    }
    if (method === 'turn/completed') {
      if (params.turnId !== active.nativeTurnId) return;
      if (active.cancellation) return; // The owned process group must drain before stop is reported.
      if (params.terminal === 'completed') {
        const usage: Record<string, number> = {};
        for (const key of ['inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']) { const value = object(params.usage)[key]; if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) usage[key] = value; }
        active.finish({ type: 'turn.completed', ...identity, usage });
      } else if (params.terminal === 'cancelled') active.finish({ type: 'turn.interrupted', ...identity });
      else { const kind = object(params.error).kind; active.finish({ type: 'turn.failed', ...identity, code: kind === 'authRequired' ? 'authentication_required' : kind === 'configError' || kind === 'environmentError' ? 'engine_unavailable' : 'engine_failed' }); }
      return;
    }
    if (method === 'item/delta') {
      if (params.field !== undefined && params.field !== 'text') return;
      if (!safeID(params.itemId) || typeof params.delta !== 'string') throw new EngineError('protocol_error');
      const item = active.items.get(params.itemId); if (!item || item.completed) return;
      if (Buffer.byteLength(item.text + params.delta) > 2 * 1024 * 1024) throw new EngineError('protocol_error');
      item.text += params.delta; if (params.delta) active.queue.push({ type: 'text.delta', ...identity, text: params.delta }); return;
    }
    const item = object(params.item); if (item.turnId !== active.nativeTurnId) return;
    if (item.kind === 'toolCall') {
      if (typeof item.tool !== 'string' || !this.options.allowedMcpTools?.includes(item.tool)) this.failState(state, 'protocol_error');
      return;
    }
    if (item.kind === 'subagent' || item.kind === 'userShell' || item.kind === 'workflow') { this.failState(state, 'protocol_error'); return; }
    if (item.kind !== 'agentMessage') return;
    if (!safeID(item.itemId) || typeof item.revision !== 'number' || !Number.isSafeInteger(item.revision) || item.revision < 1) throw new EngineError('protocol_error');
    let folded = active.items.get(item.itemId);
    if (!folded) { if (active.items.size >= 256) throw new EngineError('protocol_error'); folded = { text: '', revision: 0, completed: false }; active.items.set(item.itemId, folded); }
    if (item.revision <= folded.revision) return;
    folded.revision = item.revision;
    if (typeof item.text === 'string') {
      if (Buffer.byteLength(item.text) > 2 * 1024 * 1024 || !item.text.startsWith(folded.text)) throw new EngineError('protocol_error');
      const delta = item.text.slice(folded.text.length); folded.text = item.text;
      if (delta) active.queue.push({ type: 'text.delta', ...identity, text: delta });
    }
    if (method === 'item/completed') folded.completed = true;
  }
  private async approval(state: State, active: Active, params: Record<string, unknown>): Promise<void> {
    const requirement = object(params.currentRequirementId), subject = object(params.subject);
    if (!safeID(params.approvalId) || requirement.approvalId !== params.approvalId || !Number.isSafeInteger(requirement.sourceIndex) || Number(requirement.sourceIndex) < 0 || !Array.isArray(params.availableChoices)) throw new EngineError('protocol_error');
    const key = `${params.approvalId}:${requirement.sourceIndex}`; if (active.approvals.has(key)) return;
    if (active.approvals.size >= 1024) throw new EngineError('protocol_error'); active.approvals.add(key);
    const gateway = typeof params.toolName === 'string' && this.options.allowedMcpTools?.includes(params.toolName) && subject.kind === 'tool' && subject.toolName === params.toolName && params.subagentOrigin === undefined && params.protectedWrite !== true;
    const choice = params.availableChoices.map(object).find(value => safeID(value.choiceId) && value.scope === 'once' && value.decision === (gateway ? 'approved' : 'denied'));
    if (!choice) throw new EngineError('protocol_error');
    // Only the Dexter-owned transport is allowed once. Its broker still checks bot grants,
    // exact action approval, revision and replay. Native shell/file/network approvals are denied.
    await state.client.request('approval/decide', { commandId: uuidV7(), sessionId: state.session.nativeCursor, approvalId: params.approvalId, requirementId: { approvalId: requirement.approvalId, sourceIndex: requirement.sourceIndex }, choiceId: choice.choiceId });
  }
  private state(session: EngineSession): State { const state = this.states.get(session); if (!state) throw new EngineError('session_closed'); if (state.failed) throw state.failed; return state; }
  async *turn(session: EngineSession, turnId: string, input: string, signal: AbortSignal, selection?: EngineSelection, images: readonly EngineImageInput[] = []): AsyncIterable<EngineEvent> {
    const state = this.state(session); if (state.active) throw new EngineError('busy');
    const effective = selection ?? state.selection; this.assertSelection(effective, state.models, state.defaultModel);
    const content = [{ type: 'text', text: input }, ...checkedImageInputs(session.threadId, images).map(({ image, data }) => ({ type: 'image', mediaType: image.mediaType, base64Data: data.toString('base64'), width: image.width, height: image.height }))];
    if (Buffer.byteLength(JSON.stringify(content)) > 1500000) throw new EngineError('unsupported');
    const identity = { threadId: session.threadId, turnId }; if (signal.aborted) { yield { type: 'turn.interrupted', ...identity }; return; }
    const queue = new AsyncQueue<EngineEvent>();
    const active: Active = { turnId, queue, buffered: [], bufferedBytes: 0, items: new Map(), approvals: new Set(), settled: false, finish: event => { if (active.settled) return; active.settled = true; queue.pushFinal(event, { type: 'turn.failed', ...identity, code: 'protocol_error' }); queue.end(); } };
    state.active = active;
    const abort = (): void => { void this.cancel(state, active); };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => this.failState(state, 'timeout'), this.options.turnTimeoutMs ?? 300000);
    try {
      const modelID = effective?.model ?? this.options.model ?? state.defaultModel;
      if (modelID && modelID !== state.currentModel) {
        await state.client.request('session/setModel', { commandId: uuidV7(), sessionId: session.nativeCursor, model: { modelId: modelID, providerId: 'meta' } });
        state.currentModel = modelID;
      }
      if (signal.aborted || active.settled) abort();
      else {
        const started = await state.client.request('turn/start', { commandId: uuidV7(), sessionId: session.nativeCursor, input: content, ifBusy: 'queue', ...(effective?.reasoningEffort ? { reasoningEffort: effective.reasoningEffort } : {}) });
        if (typeof started.turnId !== 'string' || !UUID.test(started.turnId) || started.disposition !== 'started' || started.startedNewTurn !== true) throw new EngineError('protocol_error');
        active.nativeTurnId = started.turnId;
        const buffered = active.buffered.splice(0); active.bufferedBytes = 0;
        for (const event of buffered) this.notification(state, event.method, event.params);
        if (signal.aborted) abort();
      }
      for (;;) { const event = await queue.next(); if (!event) break; yield event; }
    } catch (error) {
      if (signal.aborted || active.cancellation) await this.cancel(state, active);
      else if (!active.settled) this.failState(state, codeOf(error));
      for (;;) { const event = await queue.next(); if (!event) break; yield event; }
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (!active.settled) await this.cancel(state, active);
      if (active.cancellation) await active.cancellation;
      delete state.active;
    }
  }
  private cancel(state: State, active: Active): Promise<void> {
    if (active.cancellation) return active.cancellation;
    active.cancellation = (async () => {
      if (active.settled) return;
      // Killing this owned host also drains its MCP child process group. An ack alone
      // is never called a confirmed stop; cancelled sessions cannot be reused.
      try { if (active.nativeTurnId) await state.client.request('turn/interrupt', { commandId: uuidV7(), sessionId: state.session.nativeCursor, turnId: active.nativeTurnId }); } catch { /* Owned process stop remains authoritative. */ }
      state.failed = new EngineError('session_uncertain');
      state.client.onFailure = () => {}; await state.client.stop();
      active.finish({ type: 'turn.interrupted', threadId: state.session.threadId, turnId: active.turnId });
    })(); return active.cancellation;
  }
  async interrupt(session: EngineSession, turnId: string): Promise<void> { const state = this.states.get(session); if (!state) throw new EngineError('session_closed'); if (state.active?.turnId === turnId) await this.cancel(state, state.active); }
  async respondToTool(_session: EngineSession, _turnId: string, _requestId: string, _result: JsonValue): Promise<void> { throw new EngineError('unsupported'); }
  async close(session: EngineSession): Promise<void> {
    const state = this.states.get(session); if (!state) return;
    try { if (state.active) await this.cancel(state, state.active); await state.client.stop(); }
    finally { this.states.delete(session); await rm(state.runtime.root, { recursive: true, force: true }); }
  }
}
