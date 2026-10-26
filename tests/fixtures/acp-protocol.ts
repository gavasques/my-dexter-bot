import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

const mode = process.env.DEXTER_FIXTURE_MODE ?? 'normal';
const antigravity = mode.startsWith('antigravity');
const argv = process.argv.slice(2);
const valueAfter = (flag: string): string | undefined => argv.indexOf(flag) < 0 ? undefined : argv[argv.indexOf(flag) + 1];
if (argv.includes('--version')) { process.stdout.write('grok 1.0.50\n'); process.exit(0); }
const send = (message: unknown): void => { process.stdout.write(JSON.stringify(message) + '\n'); };
const result = (id: unknown, response: unknown): void => send({ jsonrpc: '2.0', id, result: response });
const error = (id: unknown, code: number): void => send({ jsonrpc: '2.0', id, error: { code, message: 'fixture-sensitive-value' } });
const update = (data: Record<string, unknown>): void => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-fixture-session', update: data } });
const text = (content: string): void => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: content } });
type Message = { id?: number | string; method?: string; params?: Record<string, any>; result?: any; error?: { code?: number } };
let child: ChildProcessWithoutNullStreams | undefined;
let childSequence = 0, reverseSequence = 0;
const childPending = new Map<number, { resolve: (value: Record<string, any>) => void; reject: (error: Error) => void }>();
const reversePending = new Map<string, { resolve: (value: Message) => void; reject: (error: Error) => void }>();
let tools: { name: string }[] = [];
let configured = false, prompts = 0;
const model = valueAfter('-m') ?? 'grok-fixture';
const effort = valueAfter('--reasoning-effort') ?? 'medium';
let currentEffort = effort;
const configs = (): unknown[] => [
  { id: 'model', type: 'select', category: 'model', currentValue: model, options: ['grok-fixture', 'grok-other'].map(value => ({ value, name: value })) },
  { id: 'reasoning_effort', type: 'select', category: 'thought_level', currentValue: currentEffort, options: ['low', 'medium', 'high'].map(value => ({ value, name: value })) },
];
function childRpc(method: string, params: unknown = {}): Promise<Record<string, any>> {
  if (!child) return Promise.reject(new Error('fixture MCP not mounted'));
  const id = ++childSequence;
  return new Promise((resolveReply, reject) => {
    childPending.set(id, { resolve: resolveReply, reject });
    child!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function reverse(method: string, params: unknown): Promise<Message> {
  const id = `fixture-reverse-${++reverseSequence}`;
  return new Promise((resolveReply, reject) => { reversePending.set(id, { resolve: resolveReply, reject }); send({ jsonrpc: '2.0', id, method, params }); });
}
async function mount(server: Record<string, any>): Promise<void> {
  if (server.name !== 'dexter_gateway' || typeof server.command !== 'string' || !Array.isArray(server.args) || !Array.isArray(server.env) || server.env.length) throw new Error('fixture unsafe MCP config');
  child = spawn(server.command, server.args, { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: 'pipe', shell: false });
  child.stderr.resume();
  child.on('error', () => { for (const waiter of childPending.values()) waiter.reject(new Error('fixture MCP exited')); childPending.clear(); });
  child.once('close', () => { for (const waiter of childPending.values()) waiter.reject(new Error('fixture MCP closed')); childPending.clear(); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (line.length > 2097152) { child!.kill('SIGKILL'); return; }
    const response: Message = JSON.parse(line);
    if (typeof response.id !== 'number') return;
    const waiter = childPending.get(response.id); if (!waiter) return; childPending.delete(response.id);
    if (response.error) waiter.reject(new Error('fixture MCP error')); else waiter.resolve(response.result ?? {});
  });
  await childRpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'dexter-acp-fixture', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const catalog = await childRpc('tools/list');
  if (!Array.isArray(catalog.tools)) throw new Error('fixture MCP bad catalog');
  tools = catalog.tools.map((tool: { name: string }) => ({ name: tool.name }));
}
function permission(call: Record<string, unknown>): Promise<Message> {
  return reverse('session/request_permission', { sessionId: 'native-fixture-session', toolCall: call, options: [
    { optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'deny', kind: 'reject_once', name: 'Reject once' }, { optionId: 'always', kind: 'allow_always', name: 'Allow always' },
  ] });
}
async function gatewayPrompt(id: unknown): Promise<void> {
  const target = tools[0]?.name; if (!target || !/^dx_[0-9a-f]{24}$/.test(target)) throw new Error('fixture MCP alias missing');
  const wireName = `dexter_gateway__${target}`;
  const toolCall = { toolCallId: 'gateway-fixture', title: 'use_tool', rawInput: { tool_name: wireName, tool_input: { callId: 'acp-host-receipt', input: { channel: 'C-ops' } } }, _meta: { 'x.ai/tool': { version: 1, name: 'use_tool' } } };
  update({ sessionUpdate: 'tool_call', ...toolCall, status: 'pending' });
  const gate = await reverse('_x.ai/hooks/run', { sessionId: 'native-fixture-session', hookCallbackId: 'dexter_host_tools', hookEventName: 'pre_tool_use', toolName: wireName, toolInput: toolCall.rawInput, toolInputTruncated: false });
  if (gate.result?.decision !== 'continue') throw new Error('fixture host gate denied');
  const admitted = await permission(toolCall);
  if (admitted.result?.outcome?.optionId !== 'once') throw new Error('fixture gateway was not allowed once');
  const args = { callId: 'acp-host-receipt', input: { channel: 'C-ops' } };
  let approvalPendingObserved = false; const deadline = Date.now() + 5000;
  for (;;) {
    const call = await childRpc('tools/call', { name: target, arguments: args });
    const state = call.structuredContent;
    if (state?.status === 'awaiting_approval') {
      approvalPendingObserved = true;
      if (Date.now() >= deadline) throw new Error('fixture approval timeout');
      await new Promise(resolveWait => setTimeout(resolveWait, 10)); continue;
    }
    if (state?.status !== 'succeeded' && state?.status !== 'denied') throw new Error('fixture unexpected host outcome');
    text(JSON.stringify({ status: state.status, approvalPendingObserved })); break;
  }
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'gateway-fixture', status: 'completed' });
  result(id, { stopReason: 'end_turn', usage: {} });
}
const input = createInterface({ input: process.stdin });
input.on('line', line => { void handle(JSON.parse(line) as Message).catch(() => { error(null, -32603); process.exitCode = 1; child?.kill('SIGTERM'); input.close(); }); });
async function handle(message: Message): Promise<void> {
  if (!message.method) {
    if (typeof message.id !== 'string') return;
    const waiter = reversePending.get(message.id); if (!waiter) return; reversePending.delete(message.id); waiter.resolve(message); return;
  }
  const { id, method } = message, params = message.params ?? {};
  if (method === 'initialize') {
    if (params.protocolVersion !== 1 || params.clientCapabilities?.fs?.readTextFile !== true || params.clientCapabilities?.terminal !== true) throw new Error('fixture bad client caps');
    result(id, { protocolVersion: 1, agentInfo: { name: antigravity ? 'antigravity-acp' : 'grok', version: antigravity ? '1.3.0' : '1.0.50' },
      agentCapabilities: { loadSession: true, promptCapabilities: { image: antigravity, embeddedContext: true }, sessionCapabilities: { resume: {}, close: {} },
        _meta: { 'x.ai/hooks': { blockingEvents: ['pre_tool_use', 'stop', 'subagent_stop'], decisions: ['deny', 'block'] } } },
      _meta: { grokShell: true, agentVersion: mode === 'unverified-version' ? '1.0.51' : '1.0.50', modelState: { currentModelId: 'grok-fixture', availableModels: [{ modelId: 'grok-fixture', name: 'Public fixture model' }] } } }); return;
  }
  if (method === 'session/new') {
    if (mode === 'unauthenticated') { error(id, -32000); return; }
    const p = params._meta?.agentProfile;
    if (!p || p.injectDefaultTools !== false || p.discoverSkills !== false || !Array.isArray(p.tools) || p.tools.length || !Array.isArray(params.mcpServers) || params.mcpServers.length > 1 || argv.includes('bypassPermissions') || argv.includes('always-approve')) throw new Error('fixture unsafe profile');
    const entries = p.toolConfig?.tools?.map((tool: { id: string }) => tool.id);
    if (params.mcpServers.length) { if (JSON.stringify(entries) !== JSON.stringify(['GrokBuild:search_tool', 'GrokBuild:use_tool']) && JSON.stringify(entries) !== JSON.stringify(['GrokBuild:read_file'])) throw new Error('fixture native tools enabled'); await mount(params.mcpServers[0]); }
    else if (JSON.stringify(entries) !== JSON.stringify(['GrokBuild:read_file']) || JSON.stringify(p.disallowedTools) !== JSON.stringify(['read_file'])) throw new Error('fixture empty profile not curated');
    if (p.model !== undefined && p.model !== model || !params._meta?.['x.ai/hooks']?.pre_tool_use?.length) throw new Error('fixture missing pin/hooks');
    configured = true; result(id, { sessionId: 'native-fixture-session', models: { currentModelId: model }, configOptions: configs() }); return;
  }
  if (method === '_x.ai/mcp/list') {
    const servers: unknown[] = child ? [{ name: 'dexter_gateway', type: 'stdio', command: '', args: [], env: [], session: { enabled: true, status: 'ready', tools: tools.map(tool => ({ ...tool, enabled: true })) } }] : [];
    if (mode === 'extra-server') servers.push({ name: 'ambient', type: 'stdio', session: { enabled: true, status: 'ready', tools: [] } });
    result(id, { sessionMcpResolved: true, servers }); return;
  }
  if (method === 'session/set_config_option') {
    if (params.configId !== 'reasoning_effort' || !['low', 'medium', 'high'].includes(params.value)) throw new Error('fixture unsupported setting');
    currentEffort = params.value; result(id, { configOptions: configs() }); return;
  }
  if (method === 'session/prompt') {
    if (!configured || !Array.isArray(params.prompt) || params.prompt.some((block: any) => block.type !== 'text')) throw new Error('fixture unexpected prompt');
    prompts++;
    if (mode === 'grok-gateway-host') { await gatewayPrompt(id); return; }
    if (mode === 'native-client-deny') {
      const fs = await reverse('fs/read_text_file', { sessionId: 'native-fixture-session', path: '/fixture/private' });
      const terminal = await reverse('terminal/create', { sessionId: 'native-fixture-session', command: 'fixture-command' });
      const denied = await permission({ toolCallId: 'native-fixture', title: 'run_terminal_cmd', rawInput: { command: 'fixture-command' } });
      if (fs.error?.code !== -32601 || terminal.error?.code !== -32601 || denied.result?.outcome?.optionId !== 'deny') throw new Error('fixture native admission bypass');
    }
    if (mode === 'provider-error') { error(id, -32603); return; }
    if (mode === 'unsafe-tool') { update({ sessionUpdate: 'tool_call', toolCallId: 'unsafe', title: 'run_terminal_cmd', rawInput: { command: 'fixture-command' } }); return; }
    if (mode === 'bad-file-input') { update({ sessionUpdate: 'tool_call', toolCallId: 'unsafe', title: 'use_tool', rawInput: { file: '/fixture/private' } }); return; }
    text(JSON.stringify({ prompts, effort: currentEffort, homePrivate: process.env.HOME?.includes('Dexter Engine Profiles') ?? false }));
    if (mode === 'ignore-term') return;
    result(id, { stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 3, providerAccount: 'fixture-sensitive-value' } }); return;
  }
  if (method === 'session/cancel') { return; }
  if (method === 'session/close') { child?.stdin.end(); result(id, {}); return; }
  error(id, -32601);
}
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
else process.on('SIGTERM', () => { child?.kill('SIGTERM'); process.exit(0); });
input.on('close', () => { child?.kill('SIGTERM'); for (const waiter of reversePending.values()) waiter.reject(new Error('fixture closed')); });
