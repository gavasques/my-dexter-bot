import type { EngineSelection } from '@dexter/contracts';
import { AcpEngineDriver, type AcpDriverOptions, type AcpProvider, type AcpRpcClient, privateAcpHome } from './acp.js';
import { EngineError, object } from './process.js';

export interface GrokDriverOptions extends AcpDriverOptions { /** Host-owned private root. Sign in using the official CLI in this root; never copy a native account. */ profileHome?: string }
const GROK_VERSION = '1.0.50';
const HOOK_ID = 'dexter_host_tools';
const nativeName = (call: Record<string, unknown>): unknown => object(object(call._meta)['x.ai/tool']).name ?? call.name ?? call.title;
function gatewayName(value: unknown, options: AcpDriverOptions): boolean {
  if (typeof value !== 'string') return false;
  // Grok's registered MCP wire name is server__tool (not Claude's mcp__server__tool).
  return (options.allowedMcpTools ?? []).some(alias => value === alias || value === alias.slice(5));
}
function inlineGateway(call: Record<string, unknown>, options: AcpDriverOptions): boolean {
  const input = object(call.rawInput);
  return nativeName(call) === 'use_tool' && Object.keys(input).length === 2 && gatewayName(input.tool_name, options)
    && input.tool_input !== null && typeof input.tool_input === 'object' && !Array.isArray(input.tool_input);
}
function allowedCall(call: Record<string, unknown>, options: AcpDriverOptions): boolean {
  const name = nativeName(call);
  return gatewayName(name, options) || !!options.localMcpServer && (options.allowedMcpTools?.length ?? 0) > 0
    && (name === 'search_tool' || inlineGateway(call, options));
}
function profile(selection: EngineSelection | undefined, options: AcpDriverOptions): Record<string, unknown> {
  const hasTools = !!options.localMcpServer && (options.allowedMcpTools?.length ?? 0) > 0;
  return { name: 'dexter-host', description: 'Dexter capability-bound host tools only', injectDefaultTools: false, discoverSkills: false,
    toolConfig: { tools: hasTools ? [{ id: 'GrokBuild:search_tool', name_override: 'search_tool' }, { id: 'GrokBuild:use_tool', name_override: 'use_tool' }] : [{ id: 'GrokBuild:read_file', name_override: 'read_file' }] },
    tools: [], disallowedTools: hasTools ? [] : ['read_file'], ...(selection?.model ? { model: selection.model } : {}),
    promptBody: 'Use only the Dexter gateway tools supplied for this turn. Native terminal, filesystem, browser, subagent, hooks, schedules, and file-backed MCP invocation are not granted. Dexter decides each real action and its approval.' };
}
async function verifyMcp(client: AcpRpcClient, sessionId: string, options: AcpDriverOptions): Promise<void> {
  const deadline = Date.now() + Math.min(options.requestTimeoutMs ?? 10000, 10000);
  for (;;) {
    const reply = await client.request('_x.ai/mcp/list', { sessionId, cache: true }, Math.max(1, deadline - Date.now()));
    if (!Array.isArray(reply.servers) || reply.servers.length > 256) throw new EngineError('unsupported');
    let hostReady = false;
    for (const raw of reply.servers) {
      const server = object(raw), state = object(server.session);
      if (state.enabled === false) continue;
      if (state.enabled !== true || !options.localMcpServer || server.name !== 'dexter_gateway' || server.type !== 'stdio') throw new EngineError('unsupported');
      // Grok projects session-only mounts with command:'' and args:[], not their actual argv.
      // The trusted descriptor is supplied once by session/new; never claim this reply verifies argv.
      if (server.command !== '' && server.command !== options.localMcpServer.command || Array.isArray(server.args) && server.args.length > 0 && JSON.stringify(server.args) !== JSON.stringify(options.localMcpServer.args)
        || Array.isArray(server.env) && server.env.length > 0) throw new EngineError('unsupported');
      if (!Array.isArray(state.tools) || state.tools.length > 256) throw new EngineError('unsupported');
      const aliases = new Set<string>();
      for (const entry of state.tools) {
        const tool = object(entry); if (tool.enabled === false) continue;
        if (typeof tool.name !== 'string' || !gatewayName(`dexter_gateway__${tool.name}`, options) && !gatewayName(tool.name, options)) throw new EngineError('unsupported');
        const canonical = tool.name.startsWith('dx_') ? `mcp__dexter_gateway__${tool.name}` : tool.name.startsWith('dexter_gateway__') ? `mcp__${tool.name}` : tool.name;
        if (aliases.has(canonical)) throw new EngineError('protocol_error'); aliases.add(canonical);
      }
      hostReady = state.status === 'ready' && (options.allowedMcpTools ?? []).every(alias => aliases.has(alias));
    }
    if (reply.sessionMcpResolved === true) { if (options.localMcpServer && !hostReady) throw new EngineError('engine_unavailable'); return; }
    if (Date.now() >= deadline) throw new EngineError('timeout');
    await new Promise<void>(resolveWait => setTimeout(resolveWait, Math.min(50, Math.max(1, deadline - Date.now()))));
  }
}

/** Official Grok ACP, pinned to its verified inline-profile and blocking-hook contract. */
export class GrokAcpDriver extends AcpEngineDriver {
  constructor(supplied: GrokDriverOptions = {}) {
    const home = privateAcpHome('Grok', supplied, supplied.profileHome);
    const options: GrokDriverOptions = { ...supplied, env: Object.freeze({ ...supplied.env, HOME: home }) };
    const provider: AcpProvider = {
      id: 'grok', providerID: 'xai', providerLabel: 'Grok', command: 'grok',
      runtime: { GROK_MANAGED_MCPS_ENABLED: 'false', GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: 'false', GROK_AGENT: 'grok-build' },
      // Resuming can restore an older profile/lease; the host reinjects its own context into a fresh session.
      allowResume: () => false, fixedModelProfile: true,
      args: selection => {
        if (selection?.speed != null) throw new EngineError('unsupported');
        return ['--permission-mode', 'default', 'agent', '--no-leader', ...(selection?.model ? ['-m', selection.model] : []), ...(selection?.reasoningEffort ? ['--reasoning-effort', selection.reasoningEffort] : []), 'stdio'];
      },
      validateInitialize: result => {
        const meta = object(result._meta), capabilities = object(result.agentCapabilities), hooks = object(object(capabilities._meta)['x.ai/hooks']);
        if (meta.grokShell !== true || meta.agentVersion !== GROK_VERSION || !Array.isArray(hooks.blockingEvents) || !hooks.blockingEvents.includes('pre_tool_use') || !Array.isArray(hooks.decisions) || !hooks.decisions.includes('deny')) throw new EngineError('unsupported');
      },
      catalogState: result => object(object(result._meta).modelState),
      sessionParameters: (selection, _resumed, scoped) => ({ _meta: { agentProfile: profile(selection, scoped), 'x.ai/hooks': { pre_tool_use: [{ matcher: '*', hookCallbackIds: [HOOK_ID], timeout: 5 }] } } }),
      configure: async (client, sessionId, _initialized, state, selection, scoped) => {
        const models = object(state.models); if (selection?.model && models.currentModelId !== selection.model) throw new EngineError('unsupported');
        await verifyMcp(client, sessionId, scoped);
      },
      verifyTurn: async (client, sessionId, scoped) => {
        await verifyMcp(client, sessionId, scoped);
        if (scoped.localMcpServer) scoped.observeMcpAttachment?.({ engine: 'grok', state: 'validated', code: 'exact_session_registry' });
      },
      nativeToolAllowed: allowedCall, permissionAllowed: allowedCall,
      extensionRequest: (method, params, sessionId, scoped) => {
        if (method !== '_x.ai/hooks/run') return undefined;
        const matching = !!sessionId && params.sessionId === sessionId && params.hookCallbackId === HOOK_ID && params.hookEventName === 'pre_tool_use' && params.toolInputTruncated === false;
        const name = params.toolName;
        const allowed = matching && (gatewayName(name, scoped) || name === 'search_tool' && !!scoped.localMcpServer && (scoped.allowedMcpTools?.length ?? 0) > 0);
        return allowed ? { decision: 'continue' } : { decision: 'deny', systemMessage: 'Dexter requires its capability-bound host tool.' };
      },
    };
    super(provider, options);
  }
}
