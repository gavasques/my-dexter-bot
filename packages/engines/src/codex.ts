import { validateNativeMcpServer, gatewayReceiptEvidence, LOCAL_MCP_CLIENT_TIMEOUT_MS, type NativeMcpServer } from './mcp-options.js';
import type { EngineCatalogEntry, EngineCatalogModel, EngineSelection, JsonValue, NativeVoiceProviderEvent } from '@dexter/contracts';
import type { EngineDriver, EngineEvent, EngineImageInput, EngineOpenOptions, EngineSession, EngineStatus } from './index.js';
import { checkedImageInputs, checkedLocalImagePath } from './image-input.js';
import { validateSelection } from './selection.js';
import { AsyncQueue, codeOf, EngineError, JsonProcess, object, probe, type DriverOptions } from './process.js';

export interface CodexDriverOptions extends DriverOptions { localMcpServer?: NativeMcpServer; experimentalApi?:boolean }
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function assertSubscriptionConfig(config: Record<string, unknown>): void {
      const provider = object(object(config.model_providers).openai);
      if ((provider.base_url !== undefined && provider.base_url !== null && !['https://api.openai.com/v1', 'https://chatgpt.com/backend-api/codex'].includes(String(provider.base_url).replace(/\/+$/, ''))) || ['http_headers', 'env_http_headers'].some(key => Object.keys(object(provider[key])).length > 0) || ['env_key', 'experimental_bearer_token'].some(key => provider[key] !== undefined && provider[key] !== null) || provider.requires_openai_auth === false || (config.chatgpt_base_url !== undefined && config.chatgpt_base_url !== null && !['https://chatgpt.com/backend-api', 'https://chatgpt.com/backend-api/codex'].includes(String(config.chatgpt_base_url).replace(/\/+$/, '')))) throw new EngineError('subscription_required');
      if ((config.openai_base_url !== undefined && config.openai_base_url !== null && !['https://api.openai.com/v1', 'https://chatgpt.com/backend-api/codex'].includes(String(config.openai_base_url).replace(/\/+$/, ''))) || (config.experimental_thread_store_endpoint !== undefined && config.experimental_thread_store_endpoint !== null)) throw new EngineError('subscription_required');
}
class RpcClient {
  readonly process: JsonProcess;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: EngineError) => void; timer: ReturnType<typeof setTimeout> }>();
  private failure: EngineError | undefined;
  onNotification: (method: string, params: Record<string, unknown>) => void = () => {};
  onFailure: (error: EngineError) => void = () => {};
  constructor(private readonly options: DriverOptions, overrides: string[] = []) {
    this.process = new JsonProcess(options.command ?? 'codex', ['app-server', '--listen', 'stdio://', '-c', 'developer_instructions=""', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0', '-c', 'features.memories=false', '-c', 'memories.use_memories=false', '-c', 'memories.generate_memories=false', '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.remote_plugin=false', '-c', 'features.skip_host_skill_discovery=true', '-c', 'skills.include_instructions=false', '-c', 'notify=[]', ...['shell_tool', 'unified_exec', 'code_mode', 'computer_use', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser'].flatMap(name => ['-c', `features.${name}=false`]), ...['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Interrupt'].flatMap(name => ['-c', `hooks.${name}=[]`]), ...overrides.flatMap(value => ['-c', value])], options);
    this.process.onFailure = error => this.fail(error);
    this.process.onMessage = message => {
      if (typeof message.method === 'string') {
        if (message.id !== undefined) this.deny(message.id, message.method);
        else this.onNotification(message.method, object(message.params));
        return;
      }
      if (typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new EngineError('engine_failed'));
      else if (message.result === undefined) pending.reject(new EngineError('protocol_error'));
      else pending.resolve(object(message.result));
    };
  }
  /** Native approvals are fail-closed until the host's approval broker owns them. */
  private deny(id: unknown, method: string): void {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') this.process.send({ id, result: { decision: 'decline' } });
    else if (method === 'mcpServer/elicitation/request') this.process.send({ id, result: { action: 'decline', content: null, _meta: null } });
    else if (method === 'item/permissions/requestApproval') this.process.send({ id, result: { permissions: {}, scope: 'turn', strictAutoReview: true } });
    else if (method === 'applyPatchApproval' || method === 'execCommandApproval') this.process.send({ id, result: { decision: 'abort' } });
    else if (method === 'item/tool/call') this.process.send({ id, result: { contentItems: [], success: false } });
    else if (method === 'item/tool/requestUserInput') this.process.send({ id, result: { answers: {} } });
    else this.process.send({ id, error: { code: -32601, message: 'Unsupported client request' } });
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
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new EngineError('timeout'));
        this.fail(new EngineError('timeout')); void this.process.stop();
      }, this.options.requestTimeoutMs ?? 10000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.process.send({ id, method, params }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new EngineError('process_exited')); }
    });
  }
  async initialize(experimentalApi=false): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'dexter_bot', title: 'Dexter Bot', version: '0.0.1' }, capabilities: experimentalApi?{experimentalApi:true,explicitGatewayOauth:true}:null });
    this.process.send({ method: 'initialized' });
  }
  async authenticated(): Promise<boolean> {
    const result = await this.request('account/read', { refreshToken: false });
    return object(result.account).type === 'chatgpt';
  }
  async stop(): Promise<void> { this.fail(new EngineError('session_closed')); await this.process.stop(); }
}
interface Active {
  turnId: string;
  nativeTurnId?: string;
  buffered: { method: string; params: Record<string, unknown> }[];
  bufferedBytes: number;
  queue: AsyncQueue<EngineEvent>;
  finish: (event: EngineEvent) => void;
}
interface State { session: EngineSession; client: RpcClient; selection?: EngineSelection; active?: Active; failed?: EngineError; voice?: (event:NativeVoiceProviderEvent)=>void }
export class CodexAppServerDriver implements EngineDriver {
  readonly id = 'codex' as const;
  readonly capabilities = { resume: true, interrupt: true, fork: false, steer: false, supportsImages:true } as const;
  private states = new Map<EngineSession, State>();
  constructor(private readonly options: CodexDriverOptions = {}) {
    if (options.localMcpServer) this.options = { ...options, localMcpServer: validateNativeMcpServer(options.localMcpServer) };
  }
  async status(): Promise<EngineStatus> {
    const base: EngineStatus = { engine: this.id, installed: false, version: null, authentication: 'unknown', billing: 'subscription' };
    let client: RpcClient | undefined;
    try {
      const version = await probe(this.options, this.options.command ?? 'codex', ['--version']);
      if (version.exitCode !== 0) return base;
      base.installed = true; base.version = version.text.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
      client = new RpcClient(this.options); await client.initialize();
      base.authentication = await client.authenticated() ? 'authenticated' : 'required';
    } catch { /* No raw process output or account identity in diagnostics. */ }
    finally { await client?.stop(); }
    return base;
  }
  /** Catalog discovery does not read account identity/config or start an inference/thread. */
  async catalog(): Promise<EngineCatalogEntry> {
    const entry: EngineCatalogEntry = { id: this.id, available: false, installed: false, adapterSupported: true, models: [], defaultModel: null, reasoningEfforts: [], speeds: [] };
    let client: RpcClient | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const version = await probe(this.options, this.options.command ?? 'codex', ['--version']);
      if (version.exitCode !== 0) return entry;
      entry.installed = true;
      const parsedVersion = version.text.match(/\d+\.\d+\.\d+/)?.[0];
      if (parsedVersion) entry.version = parsedVersion;
      client = new RpcClient({ ...this.options, requestTimeoutMs: Math.min(this.options.requestTimeoutMs ?? 5000, 5000) });
      deadline = setTimeout(() => { void client?.stop(); }, 5000);
      await client.initialize();
      let cursor: string | null = null;
      const seen = new Set<string>();
      for (let page = 0; page < 4; page++) {
        const response = await client.request('model/list', { limit: 25, includeHidden: false, cursor });
        if (!Array.isArray(response.data)) throw new EngineError('protocol_error');
        for (const raw of response.data.slice(0, 25)) {
          const model = object(raw);
          const id = model.model;
          if (model.hidden === true || typeof id !== 'string' || !id || id.length > 128 || /[\u0000-\u001f\u007f]/.test(id) || seen.has(id)) continue;
          seen.add(id);
          const values = (items: unknown[], key: string): string[] => [...new Set(items.map(item => object(item)[key]).filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value)))];
          const item: EngineCatalogModel = { id, reasoningEfforts: values(Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [], 'reasoningEffort'), speeds: values(Array.isArray(model.serviceTiers) ? model.serviceTiers : [], 'id') };
          if (typeof model.displayName === 'string' && model.displayName.length <= 256 && !/[\u0000-\u001f\u007f]/.test(model.displayName)) item.label = model.displayName;
          entry.models.push(item);
          if (model.isDefault === true) { entry.defaultModel = id; entry.reasoningEfforts = item.reasoningEfforts; entry.speeds = item.speeds; }
        }
        if (response.nextCursor === undefined || response.nextCursor === null) break;
        if (typeof response.nextCursor !== 'string' || response.nextCursor.length > 4096 || response.nextCursor === cursor) throw new EngineError('protocol_error');
        cursor = response.nextCursor;
      }
      entry.available = true;
    } catch { entry.models = []; entry.defaultModel = null; entry.reasoningEfforts = []; entry.speeds = []; entry.unavailableReason = entry.installed ? 'Model catalog unavailable. Retry discovery.' : 'CLI not installed.'; }
    finally { clearTimeout(deadline); await client?.stop(); }
    return entry;
  }
  async open(threadId: string, nativeCursor?: string, options?: EngineOpenOptions): Promise<EngineSession> {
    validateSelection(this.id, options?.selection);
    if (nativeCursor !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(nativeCursor)) throw new EngineError('protocol_error');
    let client = new RpcClient(this.options);
    try {
      await client.initialize(this.options.experimentalApi);
      if (!await client.authenticated()) throw new EngineError('authentication_required');
      // Empty TOML tables merge, so disable every inherited server by name before starting a thread.
      // Only names are projected; credentials/configuration values never enter requests or diagnostics.
      const configuration = await client.request('config/read', { includeLayers: false, cwd: this.options.cwd ?? process.cwd() });
      const config = object(configuration.config);
      assertSubscriptionConfig(config);
      // Clear ambient developer instructions for this process only; verify the effective config.
      // Other prompt overrides remain refused without reading referenced file contents.
      if (['instructions', 'developer_instructions', 'compact_prompt', 'model_instructions_file'].some(key => config[key] !== undefined && config[key] !== null && config[key] !== '')) throw new EngineError('protocol_error');
      const servers = object(config.mcp_servers);
      const disabledServers = Object.fromEntries(Object.keys(servers).map(name => [name, { enabled: false }]));
      if (this.options.localMcpServer) {
        // Refuse an inherited same-name table: merging could retain credentials or transport keys.
        if (Object.hasOwn(servers, 'dexter_gateway')) throw new EngineError('protocol_error');
        const trusted = { ...this.options.localMcpServer, enabled: true, required: true, tool_timeout_sec:LOCAL_MCP_CLIENT_TIMEOUT_MS/1000 };
        Object.assign(disabledServers, { dexter_gateway: trusted });
        await client.stop();
        client = new RpcClient(this.options, [`mcp_servers=${toml(disabledServers)}`]);
        await client.initialize(this.options.experimentalApi);
        if (!await client.authenticated()) throw new EngineError('authentication_required');
        const effective = object((await client.request('config/read', { includeLayers: false, cwd: this.options.cwd ?? process.cwd() })).config);
        assertSubscriptionConfig(effective);
        const features = object(effective.features), memories = object(effective.memories);
        if (effective.web_search !== 'disabled' || effective.project_doc_max_bytes !== 0 || ['apps', 'plugins', 'remote_plugin', 'memories', 'shell_tool', 'unified_exec', 'code_mode', 'computer_use', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser'].some(key => features[key] !== false) || memories.use_memories !== false || memories.generate_memories !== false) throw new EngineError('protocol_error');
        const effectiveServers = object(effective.mcp_servers);
        const local = object(effectiveServers.dexter_gateway);
        if (local.command !== trusted.command || JSON.stringify(local.args) !== JSON.stringify(trusted.args) || local.enabled !== true || local.required !== true || local.tool_timeout_sec!==trusted.tool_timeout_sec || Object.entries(effectiveServers).some(([name, server]) => name !== 'dexter_gateway' && object(server).enabled !== false) || Object.entries(local).some(([key, value]) => key === 'environment_id' ? value !== 'local' && value !== null : !['command', 'args', 'enabled', 'required', 'tool_timeout_sec'].includes(key) && value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0) && !(value && typeof value === 'object' && Object.keys(value).length === 0)) || ['instructions', 'developer_instructions', 'compact_prompt', 'model_instructions_file'].some(key => effective[key] !== undefined && effective[key] !== null && effective[key] !== '')) throw new EngineError('protocol_error');
      }
      const params = {
        ...(nativeCursor === undefined ? {} : { threadId: nativeCursor, excludeTurns: true }),
        cwd: this.options.cwd ?? process.cwd(),
        approvalPolicy: 'untrusted', sandbox: 'read-only', modelProvider: 'openai', config: { developer_instructions: '', mcp_servers: disabledServers, web_search: 'disabled', project_doc_max_bytes: 0, features: { apps: false, plugins: false, remote_plugin: false, memories: false }, memories: { use_memories: false, generate_memories: false } },
        ...(options?.selection ? { model: options.selection.model, serviceTier: options.selection.speed } : this.options.model === undefined ? {} : { model: this.options.model }),
      };
      const result = await client.request(nativeCursor === undefined ? 'thread/start' : 'thread/resume', params);
      // Protocol v0.160.1 reports this on the response, not inside thread. Missing means default [].
      if (result.instructionSources !== undefined && (!Array.isArray(result.instructionSources) || result.instructionSources.length !== 0)) throw new EngineError('protocol_error');
      const nativeId = object(result.thread).id;
      if (typeof nativeId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(nativeId)) throw new EngineError('protocol_error');
      const session = { threadId, nativeCursor: nativeId }; const state: State = { session, client, ...(options?.selection ? { selection: { ...options.selection } } : {}) };
      client.onFailure = error => {
        state.failed = error;
        state.voice?.({kind:'failed',code:error.code==='authentication_required'?'auth_needed':error.code==='timeout'?'timeout':'provider_failed'});
        state.active?.finish({ type: 'turn.failed', threadId, turnId: state.active.turnId, code: error.code });
      };
      client.onNotification = (method, params) => this.notification(state, method, params);
      this.states.set(session, state); return session;
    } catch (error) { await client.stop(); throw error; }
  }
  private state(session: EngineSession): State {
    const state = this.states.get(session); if (!state) throw new EngineError('session_closed');
    if (state.failed) throw state.failed; return state;
  }
  private notification(state: State, method: string, params: Record<string, unknown>): void {
    if(state.voice&&params.threadId===state.session.nativeCursor) {
      // The media process has no native MCP grant. Any backing realtime turn is interrupted;
      // spoken handoffs are admitted as canonical Host turns by NativeVoiceRuntime instead.
      if(method==='turn/started') {
        const id=object(params.turn).id;
        if(typeof id==='string')void state.client.request('turn/interrupt',{threadId:state.session.nativeCursor,turnId:id}).catch(()=>state.client.stop());
        return;
      }
      if(method==='thread/realtime/sdp'&&typeof params.sdp==='string')state.voice({kind:'sdp',sdp:params.sdp});
      else if(method==='thread/realtime/started') {
        if(params.version!=='v3')state.voice({kind:'failed',code:'protocol_error'});else state.voice({kind:'started'});
      }else if(method==='thread/realtime/transcript/done'&&typeof params.text==='string'&&(params.role==='user'||params.role==='assistant'))state.voice({kind:'transcript',role:params.role,text:params.text});
      else if(method==='thread/realtime/itemAdded'&&typeof object(params.item).handoff_id==='string')state.voice({kind:'handoff',handoffId:String(object(params.item).handoff_id),...(typeof object(params.item).input_transcript==='string'?{text:String(object(params.item).input_transcript)}:{})});
      else if(method==='thread/realtime/error') {
        const message=typeof params.message==='string'?params.message.slice(0,8192).toLowerCase():'';
        const code=/unauthorized|authentication|login|sign.in/.test(message)?'auth_needed':/unsupported.model|model.not|model.*not.*support/.test(message)?'model_unsupported':'provider_failed';
        state.voice({kind:'failed',code});
      }else if(method==='thread/realtime/closed')state.voice({kind:'closed'});
      return;
    }
    const active = state.active; if (!active || params.threadId !== state.session.nativeCursor) return;
    const identity = { threadId: state.session.threadId, turnId: active.turnId };
    if (method !== 'item/agentMessage/delta' && method !== 'turn/completed' && method!=='item/completed') return;
    const nativeTurnId = method === 'turn/completed' ? object(params.turn).id : params.turnId;
    if (typeof nativeTurnId !== 'string') return;
    if (active.nativeTurnId === undefined) {
      const bytes = Buffer.byteLength(JSON.stringify(params));
      if (active.buffered.length >= 1024 || active.bufferedBytes + bytes > 2 * 1024 * 1024) throw new EngineError('protocol_error');
      active.buffered.push({ method, params }); active.bufferedBytes += bytes;
      return;
    }
    if (nativeTurnId !== active.nativeTurnId) return;
    if(method==='item/completed'){
      const item=object(params.item);
      if(this.options.localMcpServer && item.type==='mcpToolCall' && item.server==='dexter_gateway' && item.status==='completed')
        for(const receipt of gatewayReceiptEvidence(item.result))active.queue.push({type:'tool.result.observed',...identity,...receipt});
      return;
    }
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') active.queue.push({ type: 'text.delta', ...identity, text: params.delta });
    if (method === 'turn/completed') {
      const turn = object(params.turn);
      if (active.nativeTurnId !== undefined && turn.id !== active.nativeTurnId) return;
      if (turn.status === 'completed') active.finish({ type: 'turn.completed', ...identity, usage: {} });
      else if (turn.status === 'interrupted') active.finish({ type: 'turn.interrupted', ...identity });
      else {
        const info = object(turn.error).codexErrorInfo;
        const code = info === 'unauthorized' ? 'authentication_required' : info === 'usageLimitExceeded' || info === 'sessionBudgetExceeded' ? 'usage_limit' : info === 'rateLimitExceeded' ? 'rate_limited' : info === 'serverOverloaded' || info === 'flexUnavailable' ? 'engine_unavailable' : info === 'contextWindowExceeded' ? 'context_limit' : 'engine_failed';
        active.finish({ type: 'turn.failed', ...identity, code });
      }
    }
  }
  async *turn(session: EngineSession, turnId: string, input: string, signal: AbortSignal, selection?: EngineSelection, images:readonly EngineImageInput[]=[]): AsyncIterable<EngineEvent> {
    validateSelection(this.id, selection);
    const state = this.state(session); if (state.active) throw new EngineError('busy');
    const effectiveSelection = selection ?? state.selection;
    const attached=checkedImageInputs(session.threadId,images).map(({image})=>({type:'localImage',path:checkedLocalImagePath(image)}));
    const identity = { threadId: session.threadId, turnId };
    if (signal.aborted) { yield { type: 'turn.interrupted', ...identity }; return; }
    const queue = new AsyncQueue<EngineEvent>(); let settled = false;
    const finish = (event: EngineEvent): void => { if (settled) return; settled = true; queue.pushFinal(event, { type: 'turn.failed', ...identity, code: 'protocol_error' }); queue.end(); };
    const active: Active = { turnId, queue, finish, buffered: [], bufferedBytes: 0 }; state.active = active;
    const abort = (): void => { void this.cancel(state, active); };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      finish({ type: 'turn.failed', ...identity, code: 'timeout' });
      void state.client.stop();
    }, this.options.turnTimeoutMs ?? 300000);
    try {
      // Notifications may precede the start response, so subscribe before dispatch.
      const starting = state.client.request('turn/start', { threadId: session.nativeCursor, input: [{ type: 'text', text: input },...attached], approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly' }, ...(effectiveSelection ? { model: effectiveSelection.model, effort: effectiveSelection.reasoningEffort, serviceTier: effectiveSelection.speed } : {}) });
      void starting.then(result => {
        const id = object(result.turn).id;
        if (typeof id !== 'string') { finish({ type: 'turn.failed', ...identity, code: 'protocol_error' }); void state.client.stop(); return; }
        active.nativeTurnId = id;
        try { for (const event of active.buffered) this.notification(state, event.method, event.params); }
        catch { finish({ type: 'turn.failed', ...identity, code: 'protocol_error' }); void state.client.stop(); }
        active.buffered = []; active.bufferedBytes = 0;
        if (signal.aborted && !settled) void this.cancel(state, active);
      }, error => finish({ type: 'turn.failed', ...identity, code: codeOf(error) }));
      if (signal.aborted) abort();
      for (;;) { const event = await queue.next(); if (!event) break; yield event; }
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (!settled) await this.cancel(state, active);
      if (state.active === active) delete state.active;
    }
  }
  private async cancel(state: State, active: Active): Promise<void> {
    const identity = { threadId: state.session.threadId, turnId: active.turnId };
    // If start has no native turn id yet, teardown prevents an orphan inference.
    if (active.nativeTurnId === undefined) { active.finish({ type: 'turn.interrupted', ...identity }); await state.client.stop(); return; }
    try { await state.client.request('turn/interrupt', { threadId: state.session.nativeCursor, turnId: active.nativeTurnId }); }
    catch { await state.client.stop(); }
    active.finish({ type: 'turn.interrupted', ...identity });
  }
  async respondToTool(_session: EngineSession, _turnId: string, _requestId: string, _result: JsonValue): Promise<void> { throw new EngineError('unsupported'); }
  async startRealtime(session:EngineSession,input:{sdpOffer:string;voice?:string;initialItems:{role:'user'|'assistant';text:string}[]},emit:(event:NativeVoiceProviderEvent)=>void):Promise<void> {
    if(this.options.experimentalApi!==true||this.options.localMcpServer)throw new EngineError('unsupported');
    const state=this.state(session);if(state.active||state.voice)throw new EngineError('busy');state.voice=emit;
    await state.client.request('thread/realtime/start',{threadId:session.nativeCursor,outputModality:'audio',version:'v3',clientManagedHandoffs:true,
      transport:{type:'webrtc',sdp:input.sdpOffer},...(input.voice?{voice:input.voice}:{}),initialItems:input.initialItems,
      includeStartupContext:false,flushTranscriptTailOnSessionEnd:false,
      realtimeStartInstructions:'Dexter private voice frontend. Spoken requests are handled by the canonical Dexter host turn, with the host MCP grants and exact owner approvals. Never execute native tools or create delegated actions here. Wait for explicit host appendSpeech for the final answer.',
      realtimeEndInstructions:'The call ended. No further native work is authorized.'});
  }
  async appendRealtime(session:EngineSession,text:string,speech:boolean):Promise<void> {
    const state=this.state(session);if(!state.voice)throw new EngineError('session_closed');
    await state.client.request(speech?'thread/realtime/appendSpeech':'thread/realtime/appendText',{threadId:session.nativeCursor,text});
  }
  async stopRealtime(session:EngineSession):Promise<void> {
    const state=this.states.get(session);if(!state?.voice)return;
    delete state.voice;await state.client.request('thread/realtime/stop',{threadId:session.nativeCursor});
  }
  async interrupt(session: EngineSession, turnId: string): Promise<void> {
    const state = this.state(session); if (state.active?.turnId === turnId) await this.cancel(state, state.active);
  }
  async close(session: EngineSession): Promise<void> {
    const state = this.states.get(session); if (!state) return;
    if (state.active) await this.cancel(state, state.active);
    this.states.delete(session); await state.client.stop();
  }
}
