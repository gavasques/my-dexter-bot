import { validateNativeMcpServer, gatewayReceiptEvidence, isDexterGatewayToolName, LOCAL_MCP_CLIENT_TIMEOUT_MS, type NativeMcpServer } from './mcp-options.js';
import { randomUUID } from 'node:crypto';
import type { EngineCatalogEntry, EngineSelection, JsonValue } from '@dexter/contracts';
import type { EngineDriver, EngineEvent, EngineImageInput, EngineOpenOptions, EngineSession, EngineStatus } from './index.js';
import { checkedImageInputs } from './image-input.js';
import { validateSelection } from './selection.js';
import { CLAUDE_CATALOG_SOURCE, claudeModelCatalog } from './claude-model-catalog.js';
import { AsyncQueue, codeOf, EngineError, JsonProcess, object, probe, type DriverOptions } from './process.js';

export interface ClaudeDriverOptions extends DriverOptions {
  /** A host-owned local MCP config. Never place upstream connection headers here. */
  mcpConfig?: string;
  localMcpServer?: NativeMcpServer;
  permissionPromptTool?: string;
  /** Only host-gateway MCP tools should be preapproved; built-in tools stay disabled. */
  allowedMcpTools?: readonly string[];
}
interface State { session: EngineSession; resumed: boolean; selection?: EngineSelection; uncertain?: boolean; active?: { turnId: string; process: JsonProcess; queue: AsyncQueue<EngineEvent>; finish: (event: EngineEvent) => void } }
export class ClaudeCliDriver implements EngineDriver {
  readonly id = 'claude' as const;
  readonly capabilities = { resume: true, interrupt: true, fork: false, steer: false, supportsImages:true } as const;
  private states = new Map<EngineSession, State>();
  constructor(private readonly options: ClaudeDriverOptions = {}) {
    if (options.localMcpServer) {
      this.options = { ...options, localMcpServer: validateNativeMcpServer(options.localMcpServer), allowedMcpTools: Object.freeze([...(options.allowedMcpTools ?? [])]) };
      if (this.options.mcpConfig || this.options.permissionPromptTool || this.options.allowedMcpTools?.some(name => !isDexterGatewayToolName(name))) throw new EngineError('protocol_error');
    }
    if (this.options.allowedMcpTools?.some(name => !/^mcp__[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+$/.test(name))) throw new EngineError('protocol_error');
    if (this.options.allowedMcpTools?.length && !this.options.mcpConfig && !this.options.localMcpServer) throw new EngineError('protocol_error');
  }
  private get command(): string { return this.options.command ?? 'claude'; }
  async status(): Promise<EngineStatus> {
    const base: EngineStatus = { engine: this.id, installed: false, version: null, authentication: 'unknown', billing: 'subscription' };
    try {
      const version = await probe(this.options, this.command, ['--version']);
      if (version.exitCode !== 0) return base;
      base.installed = true; base.version = version.text.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
      const auth = await probe(this.options, this.command, ['auth', 'status', '--json']);
      const value = object(JSON.parse(auth.text));
      base.authentication = value.loggedIn === true && value.authMethod === 'claude.ai' ? 'authenticated' : 'required';
    } catch { /* Diagnostics do not return provider output, accounts or secrets. */ }
    return base;
  }
  /** Versioned public compatibility catalog plus installed help; no account/config/inference request. */
  async catalog(): Promise<EngineCatalogEntry> {
    const entry: EngineCatalogEntry = { id: this.id, providerID: 'anthropic', providerLabel: 'Anthropic', catalogSource: CLAUDE_CATALOG_SOURCE, available: false, installed: false, adapterSupported: true, models: [], defaultModel: null, reasoningEfforts: [], speeds: [] };
    try {
      const version = await probe(this.options, this.command, ['--version']);
      if (version.exitCode !== 0) return entry;
      entry.installed = true;
      const parsedVersion = version.text.match(/\d+\.\d+\.\d+/)?.[0];
      if (parsedVersion) entry.version = parsedVersion;
      const help = await probe(this.options, this.command, ['--help']);
      if (help.exitCode !== 0) throw new EngineError('engine_unavailable');
      // Continuation lines belong to the preceding flag. Never harvest names from examples elsewhere.
      const option = (flag: string): string => {
        const start = help.text.indexOf(flag);
        if (start < 0) return '';
        return help.text.slice(start).split(/\n\s*(?:--[a-z]|-[a-z],)/)[0] ?? '';
      };
      const modelHelp = option('--model <');
      const aliases = [...modelHelp.matchAll(/'([a-zA-Z0-9_.-]{1,128})'/g)].map(match => match[1]!);
      const effortHelp = option('--effort <');
      const effortList = effortHelp.match(/\(([a-zA-Z0-9_, -]+)\)/)?.[1];
      // Ultracode is a workflow setting, even when accepted by --effort; it is not a model effort.
      const efforts = effortList ? [...new Set(effortList.split(',').map(value => value.trim()).filter(value => ['low', 'medium', 'high', 'xhigh', 'max'].includes(value)))] : [];
      entry.reasoningEfforts = efforts;
      entry.models = claudeModelCatalog(parsedVersion, [...new Set(aliases)], efforts, modelHelp.length > 0);
      entry.available = true;
    } catch { entry.unavailableReason = entry.installed ? 'CLI options unavailable. Retry discovery.' : 'CLI not installed.'; }
    return entry;
  }
  async open(threadId: string, nativeCursor?: string, options?: EngineOpenOptions): Promise<EngineSession> {
    validateSelection(this.id, options?.selection);
    if (options?.selection?.speed !== undefined && options.selection.speed !== null) throw new EngineError('unsupported');
    if (nativeCursor !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeCursor)) throw new EngineError('protocol_error');
    const status = await this.status();
    if (!status.installed) throw new EngineError('not_installed');
    if (status.authentication === 'unknown') throw new EngineError('engine_unavailable');
    if (status.authentication !== 'authenticated') throw new EngineError('authentication_required');
    const session = { threadId, nativeCursor: nativeCursor ?? randomUUID() };
    this.states.set(session, { session, resumed: nativeCursor !== undefined, ...(options?.selection ? { selection: { ...options.selection } } : {}) }); return session;
  }
  private state(session: EngineSession): State {
    const state = this.states.get(session); if (!state) throw new EngineError('session_closed'); if (state.uncertain) throw new EngineError('session_uncertain'); return state;
  }
  async *turn(session: EngineSession, turnId: string, input: string, signal: AbortSignal, selection?: EngineSelection, images:readonly EngineImageInput[]=[]): AsyncIterable<EngineEvent> {
    validateSelection(this.id, selection);
    const state = this.state(session);
    const effectiveSelection = selection ?? state.selection;
    if (effectiveSelection?.speed !== undefined && effectiveSelection.speed !== null) throw new EngineError('unsupported');
    if (state.active) throw new EngineError('busy');
    const attached=checkedImageInputs(session.threadId,images);
    const content=attached.length ? [{type:'text',text:input},...attached.map(({data})=>({type:'image',source:{type:'base64',media_type:'image/png',data:data.toString('base64')}}))] : input;
    const identity = { threadId: session.threadId, turnId };
    if (signal.aborted) { yield { type: 'turn.interrupted', ...identity }; return; }
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--tools', '', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--setting-sources', '', '--settings', JSON.stringify({ disableClaudeAiConnectors: true, disableAllHooks: true, autoMemoryEnabled: false, claudeMdExcludes: ['**'], enabledPlugins: {}, pluginConfigs: { 'cc-plugin-agents-md@builtin': { options: { instructionFiles: 'managed-only' } } } }), '--disable-slash-commands', '--no-chrome'];
    const model = effectiveSelection ? effectiveSelection.model : this.options.model;
    if (model) args.push('--model', model);
    if (effectiveSelection?.reasoningEffort) args.push('--effort', effectiveSelection.reasoningEffort);
    if (this.options.localMcpServer) args.push('--mcp-config', JSON.stringify({ mcpServers: { dexter_gateway: { type: 'stdio', ...this.options.localMcpServer, timeout:LOCAL_MCP_CLIENT_TIMEOUT_MS } } }));
    if (this.options.mcpConfig) args.push('--mcp-config', this.options.mcpConfig);
    if (this.options.allowedMcpTools?.length) args.push('--allowedTools', this.options.allowedMcpTools.join(','));
    if (this.options.permissionPromptTool) args.push('--permission-prompt-tool', this.options.permissionPromptTool);
    args.push(state.resumed ? '--resume' : '--session-id', session.nativeCursor);
    const child = new JsonProcess(this.command, args, this.options);
    const queue = new AsyncQueue<EngineEvent>(); let settled = false; let streamed = false; let resultObserved = false; let inputSent = false; let localMcpInitialized = false;
    const finish = (event: EngineEvent): void => {
      if (settled) return;
      settled = true;
      if (inputSent && !resultObserved) state.uncertain = true;
      queue.pushFinal(event, { type: 'turn.failed', ...identity, code: 'protocol_error' });
      queue.end();
      // A successful result precedes CLI persistence/exit. Give it a bounded natural exit before TERM.
      void child.stop({ allowNaturalExit: event.type === 'turn.completed' });
    };
    state.active = { turnId, process: child, queue, finish };
    child.onFailure = error => finish({ type: 'turn.failed', ...identity, code: error.code });
    child.onMessage = message => {
      if (settled || message.parent_tool_use_id) return;
      if (message.type === 'system' && message.subtype === 'init') {
        if (this.options.localMcpServer && (!Array.isArray(message.mcp_servers) || message.mcp_servers.length !== 1 || object(message.mcp_servers[0]).name !== 'dexter_gateway' || object(message.mcp_servers[0]).status !== 'connected' || (Array.isArray(message.mcp_server_errors) && message.mcp_server_errors.length > 0))) throw new EngineError('protocol_error');
        if (message.session_id !== session.nativeCursor) throw new EngineError('protocol_error');
        localMcpInitialized = true;
      }
      if (this.options.localMcpServer && !localMcpInitialized && ['stream_event', 'assistant', 'user', 'result'].includes(String(message.type))) throw new EngineError('protocol_error');
      if (message.type === 'stream_event') {
        const delta = object(object(message.event).delta);
        if (delta.type === 'text_delta' && typeof delta.text === 'string') { streamed = true; queue.push({ type: 'text.delta', ...identity, text: delta.text }); }
      }
      if(this.options.localMcpServer && message.type==='user' && message.session_id===session.nativeCursor){
        const blocks=object(message.message).content;
        if(Array.isArray(blocks))for(const block of blocks.slice(0,32)){
          const result=object(block);if(result.type!=='tool_result' || typeof result.tool_use_id!=='string')continue;
          for(const receipt of gatewayReceiptEvidence(result.content))queue.push({type:'tool.result.observed',...identity,...receipt});
        }
      }
      if (message.type === 'assistant' && typeof message.error === 'string') {
        const code = message.error === 'authentication_failed' ? 'authentication_required' : message.error === 'rate_limit' ? 'rate_limited' : message.error === 'billing_error' ? 'usage_limit' : 'engine_failed';
        finish({ type: 'turn.failed', ...identity, code });
      }
      if (message.type === 'result') {
        if (this.options.localMcpServer && !localMcpInitialized) throw new EngineError('protocol_error');
        resultObserved = true; state.resumed = true;
        if (message.is_error === true || message.subtype !== 'success') { finish({ type: 'turn.failed', ...identity, code: 'engine_failed' }); return; }
        if (!streamed && typeof message.result === 'string' && message.result) queue.push({ type: 'text.delta', ...identity, text: message.result });
        const usage = object(message.usage);
        const safeUsage: Record<string, number> = {};
        for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) if (typeof usage[key] === 'number') safeUsage[key] = usage[key];
        finish({ type: 'turn.completed', ...identity, usage: safeUsage });
      }
    };
    const abort = (): void => finish({ type: 'turn.interrupted', ...identity });
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => finish({ type: 'turn.failed', ...identity, code: 'timeout' }), this.options.turnTimeoutMs ?? 300000);
    try {
      if (signal.aborted) abort();
      else { inputSent = true; child.send({ type: 'user', message: { role: 'user', content }, session_id: session.nativeCursor, parent_tool_use_id: null }); child.child.stdin.end(); }
      for (;;) { const event = await queue.next(); if (!event) break; yield event; }
    } catch (error) { if (!settled) yield { type: 'turn.failed', ...identity, code: codeOf(error) }; }
    finally { if (inputSent && !resultObserved) state.uncertain = true; clearTimeout(timer); signal.removeEventListener('abort', abort); await child.stop(); delete state.active; }
  }
  async respondToTool(_session: EngineSession, _turnId: string, _requestId: string, _result: JsonValue): Promise<void> { throw new EngineError('unsupported'); }
  async interrupt(session: EngineSession, turnId: string): Promise<void> {
    const state = this.states.get(session); if (!state) throw new EngineError('session_closed'); if (state.active?.turnId !== turnId) return;
    state.active.finish({ type: 'turn.interrupted', threadId: session.threadId, turnId }); await state.active.process.stop();
  }
  async close(session: EngineSession): Promise<void> { const state = this.states.get(session); if (!state) return; if (state.active) await this.interrupt(session, state.active.turnId); this.states.delete(session); }
}
