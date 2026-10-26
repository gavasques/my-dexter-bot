import { createInterface } from 'node:readline';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.DEXTER_FIXTURE_MODE ?? 'normal';
if (process.argv.includes('--version')) { console.log('Muse Code 1.4.4 (1.4.4-R5419.1)'); process.exit(0); }
function check(condition: unknown): asserts condition { if (!condition) { process.stderr.write('fixture-private-error\n'); process.exit(2); } }
const args = process.argv.slice(2);
check(args[0] === 'serve' && args.includes('--no-session-log') && args.includes('--disable-shell') && args.includes('--disable-write') && !args.includes('--disable-sandbox') && !args.includes('--trust-workspace'));
check(process.env.MUSE_NO_AUTO_UPDATE === '1' && !process.env.MUSE_API_KEY && !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY);
const overrides = new Map<string, unknown>();
for (let i = 0; i < args.length; i++) if (args[i] === '-c') { const value = args[++i]!; const split = value.indexOf('='); overrides.set(value.slice(0, split), JSON.parse(value.slice(split + 1))); }
check(Array.isArray(overrides.get('run.toolset')) && overrides.get('local_session_messaging.enabled') === false && overrides.get('context.foreign_personal_rules') === false && overrides.get('context.foreign_personal_skills') === false);
check(JSON.stringify(overrides.get('hooks')) === '{}' && overrides.get('managed_hooks_path') === null && overrides.get('managed_plugins_path') === null && overrides.get('managed_skills_path') === null && JSON.stringify(overrides.get('run.reminder_roster')) === '[]');
const settings = JSON.parse(readFileSync(join(process.env.XDG_CONFIG_HOME!, 'muse', 'settings.json'), 'utf8')) as Record<string, unknown>;
check(JSON.stringify(settings) === '{"schema_version":1,"mcpServers":{},"hooks":{}}');
const sessionID = '019f00ff-0000-7000-8000-000000000001', itemID = '019f00ff-0000-7000-8000-000000000002';
let turnID = '', receiptCount = 0, approvalCount = 0, selectedModel = 'muse-synthetic-1';
let server: { command: string; args: string[] } | undefined;
let gateway: ChildProcessWithoutNullStreams | undefined;
let sequence = 0;
function send(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
const result = (id: unknown, value: unknown): void => send({ jsonrpc: '2.0', id, result: value });
const notify = (method: string, params: object): void => send({ jsonrpc: '2.0', method, params: { sessionId: sessionID, viewCursor: `synthetic-${++sequence}`, ...params } });
function completed(text = 'Olá Muse'): void {
  notify('item/started', { item: { itemId: itemID, kind: 'agentMessage', status: 'inProgress', revision: 1, turnId: turnID, text: '' } });
  notify('item/delta', { itemId: itemID, delta: text });
  notify('item/completed', { item: { itemId: itemID, kind: 'agentMessage', status: 'completed', revision: 2, turnId: turnID, text } });
  notify('turn/completed', { turnId: turnID, terminal: 'completed', usage: { inputTokens: 3, outputTokens: 2 } });
}
async function callGateway(): Promise<string> {
  check(server); gateway = spawn(server.command, server.args, { stdio: 'pipe', shell: false, env: { HOME: process.env.HOME!, PATH: process.env.PATH! } });
  gateway.stderr.resume(); let id = 0;
  const waiting = new Map<number, (value: Record<string, unknown>) => void>();
  createInterface({ input: gateway.stdout }).on('line', line => { const value = JSON.parse(line) as Record<string, unknown>; if (typeof value.id === 'number') { waiting.get(value.id)?.(value); waiting.delete(value.id); } });
  const request = (method: string, params: object): Promise<Record<string, unknown>> => new Promise(resolve => { const n = ++id; waiting.set(n, resolve); gateway!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); });
  await request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'muse_fixture', version: '1' }, capabilities: {} });
  gateway.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const tools = await request('tools/list', {}); const list = (tools.result as { tools: { name: string }[] }).tools;
  const tool = list[0]; check(tool && typeof tool.name === 'string');
  if (mode === 'gateway-host') {
    check(/^dx_[0-9a-f]{24}$/.test(tool.name));
    const configured = overrides.get('run.toolset') as string[];
    check(configured.includes(`mcp__dexter_gateway__${tool.name}`));
    const args = { callId: 'msp-host-receipt', input: { channel: 'C-ops' } };
    const deadline = Date.now() + 5000; let approvalPendingObserved = false;
    for (;;) {
      const remaining = deadline - Date.now(); check(remaining > 0);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let output: Record<string, unknown>;
      try {
        output = await Promise.race([request('tools/call', { name: tool.name, arguments: args }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('fixture timeout')), remaining); })]);
      } finally { clearTimeout(timer); }
      const body = output.result as { content?: { type: string; text?: string }[] } | undefined;
      const content = body?.content?.find(value => value.type === 'text'); check(typeof content?.text === 'string');
      const outcome = JSON.parse(content.text) as { status?: string };
      check(typeof outcome.status === 'string' && outcome.status !== 'unknown');
      if (outcome.status !== 'awaiting_approval') {
        check(['succeeded', 'denied', 'blocked'].includes(outcome.status));
        return JSON.stringify({ status: outcome.status, approvalPendingObserved });
      }
      approvalPendingObserved = true;
      await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(0, deadline - Date.now()))));
    }
  }
  check(tool.name === 'dx_0123456789abcdef01234567');
  const output = await request('tools/call', { name: tool.name, arguments: { text: mode === 'gateway-deny' ? 'deny-synthetic-action' : 'synthetic-action' } });
  return (output.result as { isError?: boolean }).isError ? 'Ação negada pelo host' : 'Ação concluída pelo host';
}
createInterface({ input: process.stdin }).on('line', line => {
  void (async () => {
    const value = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
    const params = value.params ?? {};
    if (!value.method) { if (value.id === 9000) receiptCount++; return; }
    if (value.method === 'initialized') return;
    if (value.method === 'initialize') {
      const requested = (params.capabilities as { requestedCapabilities: string[] }).requestedCapabilities;
      check(!requested.includes('userShell'));
      result(value.id, { schema: { version: 1, fingerprint: mode === 'schema-drift' ? 'sha256:unknown' : 'sha256:7c94f153c41659cb3f1bd3c3e04438be254644cb2a97d65d48edc7449b74858a' }, serverInfo: { name: 'Muse Code', version: '1.4.4' }, sessionDurability: 'ephemeral', grantedCapabilities: requested });
    } else if (value.method === 'model/list') result(value.id, { providerId: 'meta', source: 'fixture', models: [{ modelId: 'muse-synthetic-1', providerId: 'meta', displayLabel: 'Synthetic Muse 1', isDefault: true, variants: ['low', 'high', 'max', 'ultra'] }, { modelId: 'muse-synthetic-2', providerId: 'meta', displayLabel: 'Synthetic Muse 2', isDefault: false, variants: ['none', 'medium'] }] });
    else if (value.method === 'session/start') {
      check(params.providerId === 'meta' && params.approvalMode === 'promptUnmatched' && params.workspaceRoot === process.cwd());
      selectedModel = typeof params.modelId === 'string' ? params.modelId : selectedModel;
      if (params.config) { const config = params.config as { mcpServers: { dexter_gateway: { transport: string; mode: string; command: string; args: string[] } } }; const spec = config.mcpServers.dexter_gateway; check(Object.keys(config.mcpServers).length === 1 && spec.transport === 'stdio' && spec.mode === 'required'); server = spec; }
      result(value.id, { session: { sessionId: sessionID, status: 'idle', activeTurnId: null, providerId: 'meta', modelId: selectedModel, approvalMode: { mode: 'promptUnmatched' } }, viewCursor: 'synthetic-0' });
    } else if (value.method === 'session/setModel') { const model = params.model as { providerId: string; modelId: string }; check(model.providerId === 'meta'); selectedModel = model.modelId; result(value.id, { commandId: params.commandId, status: 'accepted' }); }
    else if (value.method === 'turn/start') {
      if (mode === 'gateway-host') { receiptCount = 0; approvalCount = 0; }
      turnID = params.commandId as string; check(/^[a-f0-9-]{14}7[a-f0-9-]+$/.test(turnID)); check(params.sessionId === sessionID && params.ifBusy === 'queue');
      const content = params.input as { type: string; text?: string; base64Data?: string; mediaType?: string }[];
      check(Array.isArray(content)); const text = content[0]; check(text?.type === 'text');
      if (text.text === 'assert:model-effort') check(selectedModel === 'muse-synthetic-2' && params.reasoningEffort === 'medium');
      if (text.text === 'assert:default-effort') check(selectedModel === 'muse-synthetic-1' && params.reasoningEffort === 'max');
      if (text.text === 'assert:image') { const image = content[1]; check(image?.type === 'image' && image.mediaType === 'image/png' && image.base64Data === Buffer.from('synthetic-image').toString('base64')); }
      if (mode === 'provider-error') { result(value.id, { commandId: turnID, disposition: 'started', startedNewTurn: true, status: 'accepted', turnId: turnID }); notify('turn/completed', { turnId: turnID, terminal: 'failed', error: { kind: 'authRequired', message: 'fixture-private-error', retryable: false } }); return; }
      if (mode === 'gap') { result(value.id, { commandId: turnID, disposition: 'started', startedNewTurn: true, status: 'accepted', turnId: turnID }); notify('view/gap', { after: '0', next: '2' }); return; }
      if (mode === 'native-tool') { result(value.id, { commandId: turnID, disposition: 'started', startedNewTurn: true, status: 'accepted', turnId: turnID }); notify('item/started', { item: { itemId: itemID, kind: 'toolCall', tool: 'bash', turnId: turnID, revision: 1, status: 'inProgress' } }); return; }
      if (mode === 'cancel') { result(value.id, { commandId: turnID, disposition: 'started', startedNewTurn: true, status: 'accepted', turnId: turnID }); notify('item/started', { item: { itemId: itemID, kind: 'agentMessage', status: 'inProgress', revision: 1, turnId: turnID, text: '' } }); notify('item/delta', { itemId: itemID, delta: 'starting' }); return; }
      if (mode === 'gateway' || mode === 'gateway-deny' || mode === 'gateway-host' || mode === 'native-approval') {
        const configured = overrides.get('run.toolset') as string[];
        const tool = mode === 'native-approval' ? 'bash' : mode === 'gateway-host' ? configured.find(name => /^mcp__dexter_gateway__dx_[a-f0-9]{24}$/.test(name)) : 'mcp__dexter_gateway__dx_0123456789abcdef01234567';
        check(typeof tool === 'string');
        const approval = { sessionId: sessionID, turnId: turnID, approvalId: 'approval-synthetic', currentRequirementId: { approvalId: 'approval-synthetic', sourceIndex: 0 }, toolName: tool, subject: { kind: 'tool', toolName: tool }, availableChoices: [{ choiceId: 'allow-once', decision: 'approved', scope: 'once' }, { choiceId: 'deny-once', decision: 'denied', scope: 'once' }] };
        send({ jsonrpc: '2.0', id: 9000, method: 'approval/request', params: approval }); notify('approval/requested', approval);
        result(value.id, { commandId: turnID, disposition: 'started', startedNewTurn: true, status: 'accepted', turnId: turnID }); return;
      }
      // Push can precede the turn/start acknowledgement. Full item replay must not double text.
      completed(); result(value.id, { commandId: turnID, disposition: 'started', startedNewTurn: true, status: 'accepted', turnId: turnID });
    } else if (value.method === 'approval/decide') {
      approvalCount++; check(approvalCount === 1 && receiptCount === 1 && params.sessionId === sessionID);
      check(params.choiceId === (mode === 'native-approval' ? 'deny-once' : 'allow-once')); result(value.id, { status: 'accepted', terminal: true });
      completed(mode === 'native-approval' ? 'Ferramenta nativa recusada' : await callGateway());
    } else if (value.method === 'turn/interrupt') { check(params.turnId === turnID && params.sessionId === sessionID); result(value.id, { commandId: params.commandId, turnId: turnID }); notify('turn/completed', { turnId: turnID, terminal: 'cancelled' }); }
    else send({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'fixture-private-error', data: { kind: 'methodNotFound' } } });
  })().catch(() => { process.stderr.write('fixture-private-error\n'); process.exit(2); });
});
