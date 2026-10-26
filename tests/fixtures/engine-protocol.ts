import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const mode = process.env.DEXTER_FIXTURE_MODE ?? 'normal';
const send = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
if (argv.includes('--version')) { console.log('fixture 1.2.3'); process.exit(0); }
if (argv.includes('auth')) { console.log(mode === 'auth-unknown' ? 'fixture-invalid-diagnostics' : JSON.stringify({ loggedIn: mode !== 'unauthenticated', authMethod: mode === 'api-key' ? 'api_key' : 'claude.ai', ignored_secret: 'fixture-sensitive-value' })); process.exit(0); }
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
const heartbeat = setInterval(() => {}, 1000);
const rl = createInterface({ input: process.stdin });
let cursor = argv[argv.indexOf('--session-id') + 1] ?? argv[argv.indexOf('--resume') + 1];
if (argv.includes('-p')) cursor = argv[argv.indexOf(argv.includes('--session-id') ? '--session-id' : '--resume') + 1];
const nativeThreadId = 'native-thread';
let turnSequence = 0;
let nativeTurnId = '';
const approvalAnswers: Record<string, unknown> = {};
rl.on('line', line => {
  const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; message?: { content: string } };
  if (argv.includes('-p')) {
    if (argv[argv.indexOf('--setting-sources') + 1] !== '' || !argv.includes('--disable-slash-commands') || !argv.includes('--no-chrome') || argv[argv.indexOf('--tools') + 1] !== '' || !argv.includes('--strict-mcp-config') || argv[argv.indexOf('--permission-mode') + 1] !== 'dontAsk') { process.exit(2); }
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '{}') as Record<string, unknown>;
    if (settings.disableAllHooks !== true || settings.autoMemoryEnabled !== false || JSON.stringify(settings.claudeMdExcludes) !== '["**"]') process.exit(2);
    const plugins = settings.pluginConfigs as Record<string, { options?: { instructionFiles?: string } }> | undefined;
    if (plugins?.['cc-plugin-agents-md@builtin']?.options?.instructionFiles !== 'managed-only') process.exit(2);
    if (msg.message?.content === 'fixture:new' && (!argv.includes('--session-id') || argv.includes('--resume'))) process.exit(2);
    if (msg.message?.content === 'fixture:resume' && (!argv.includes('--resume') || argv.includes('--session-id'))) process.exit(2);
    if (mode === 'env') { send({ type: 'result', subtype: 'success', result: JSON.stringify({ keys: Object.keys(process.env).sort() }), usage: {} }); return; }
    if (mode === 'malformed') { process.stdout.write('garbage fixture-sensitive-value\n'); return; }
    if (mode === 'oversize-utf8') { send({ type: 'stream_event', event: { delta: { type: 'text_delta', text: '€'.repeat(900000) } } }); return; }
    if (mode === 'oversize') { process.stdout.write('x'.repeat(3 * 1024 * 1024)); return; }
    if (mode === 'exit') { process.stderr.write('fixture-sensitive-value'); process.exit(2); }
    send({ type: 'system', subtype: 'init', session_id: cursor });
    if (mode === 'init-abort') { send({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'init' } } }); return; }
    if (mode === 'result-flush') {
      send({ type: 'result', subtype: 'success', result: 'persisted', usage: {} });
      setTimeout(() => { writeFileSync(join(process.cwd(), 'flush-complete'), 'persisted'); process.exit(0); }, 60);
      return;
    }
    if (mode === 'tree-success') {
      const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
      descendant.stdout.once('data', () => { send({ type: 'stream_event', event: { delta: { type: 'text_delta', text: String(descendant.pid) } } }); send({ type: 'result', subtype: 'success', usage: {} }); setTimeout(() => process.exit(0), 5); });
      return;
    }
    if (mode === 'queue-overflow' || mode === 'queue-full') {
      // Test releases the remaining producer burst only after consuming delta 0 and installing decoder observers.
      send({ type: 'stream_event', event: { delta: { type: 'text_delta', text: '0' } } });
      // Claude input is intentionally closed after one message; use only this fixture's private cwd.
      const release = setInterval(() => {
        if (!existsSync(join(process.cwd(), 'release-buffer'))) return;
        clearInterval(release);
        for (let i = 1; i < (mode === 'queue-full' ? 4097 : 5000); i++) send({ type: 'stream_event', event: { delta: { type: 'text_delta', text: String(i) } } });
        send({ type: 'result', subtype: 'success', usage: {} });
      }, 5);
      return;
    }
    if (mode.startsWith('claude-error:')) { send({ type: 'assistant', error: mode.slice('claude-error:'.length) }); return; }
    if (mode === 'tree') { const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore','pipe','ignore'] }); descendant.stdout.once('data', () => send({ type: 'stream_event', event: { delta: { type: 'text_delta', text: String(descendant.pid) } } })); return; }
    if (mode === 'hang' || mode === 'ignore-term') return;
    if (mode !== 'fallback') {
      send({ type: 'stream_event', parent_tool_use_id: 'subagent', event: { delta: { type: 'text_delta', text: 'ignored' } } });
      const chunk = `${JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Olá' } } })}\n`;
      const bytes = Buffer.from(chunk); const split = bytes.indexOf(Buffer.from('á')) + 1;
      process.stdout.write(bytes.subarray(0, split)); process.stdout.write(bytes.subarray(split));
    }
    send({ type: 'result', subtype: mode === 'provider-error' ? 'error_during_execution' : 'success', is_error: mode === 'provider-error', result: 'Olá', usage: { input_tokens: 2, output_tokens: 1, secret: 'fixture-sensitive-value' } });
    clearInterval(heartbeat);
    return;
  }
  if (!msg.method) { if (typeof msg.id === 'number' && msg.id >= 100) { approvalAnswers[String(msg.id)] = msg.result; if (Object.keys(approvalAnswers).length === 5) { send({ method: 'item/agentMessage/delta', params: { threadId: nativeThreadId, turnId: nativeTurnId, delta: JSON.stringify(approvalAnswers) } }); send({ method: 'turn/completed', params: { threadId: nativeThreadId, turn: { id: nativeTurnId, status: 'completed' } } }); } } return; }
  const reply = (result: unknown): void => send({ id: msg.id, result });
  if (msg.method === 'initialize') { reply({ userAgent: 'fixture' }); return; }
  if (msg.method === 'initialized') return;
  if (msg.method === 'config/read') {
    const config: Record<string, unknown> = { mcp_servers: { ambient: { command: 'never-start-this', env: { token: 'fixture-sensitive-value' } } }, chatgpt_base_url: 'https://chatgpt.com/backend-api/' };
    // Simulate a native user config with developer instructions and apply the process override.
    config.developer_instructions = argv.some((value, index) => value === 'developer_instructions=""' && argv[index - 1] === '-c') ? '' : 'fixture-personal-instruction';
    if (mode === 'custom-route') config.chatgpt_base_url = 'https://custom.fixture.test/backend-api';
    if (mode === 'openai-route') config.openai_base_url = 'https://custom.fixture.test/v1';
    if (mode === 'thread-store-route') config.experimental_thread_store_endpoint = 'https://custom.fixture.test/store';
    if (mode.startsWith('provider:')) {
      const key = mode.slice('provider:'.length);
      config.model_providers = { openai: { [key]: key === 'requires_openai_auth' ? false : key === 'base_url' ? 'https://custom.fixture.test/v1' : key.endsWith('headers') ? { custom: 'fixture-sensitive-value' } : 'fixture-sensitive-value' } };
    }
    if (mode.startsWith('instructions:')) config[mode.slice('instructions:'.length)] = 'fixture-personal-instruction';
    reply({ config }); return;
  }
  if (msg.method === 'account/read') { reply({ account: mode === 'unauthenticated' ? null : { type: mode === 'api-key' ? 'apiKey' : 'chatgpt', email: 'private@fixture.test' } }); return; }
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    const cfg = msg.params?.config as { mcp_servers?: Record<string, { enabled?: boolean }>; features?: Record<string, boolean>; memories?: Record<string, boolean>; project_doc_max_bytes?: number; web_search?: string; developer_instructions?: string } | undefined;
    const overrides = argv.filter((_, index) => argv[index - 1] === '-c');
    const required = ['developer_instructions=""', 'project_doc_max_bytes=0', 'features.memories=false', 'memories.use_memories=false', 'memories.generate_memories=false', 'features.skip_host_skill_discovery=true', 'skills.include_instructions=false', 'features.shell_tool=false', 'features.unified_exec=false', 'features.browser_use=false', 'notify=[]'];
    if (cfg?.developer_instructions !== '' || cfg?.mcp_servers?.ambient?.enabled !== false || cfg?.features?.memories !== false || cfg?.memories?.use_memories !== false || cfg?.memories?.generate_memories !== false || cfg?.project_doc_max_bytes !== 0 || cfg?.web_search !== 'disabled' || msg.params?.approvalPolicy !== 'untrusted' || msg.params?.sandbox !== 'read-only' || msg.params?.modelProvider !== 'openai' || required.some(value => !overrides.includes(value))) { send({ id: msg.id, error: { code: -1 } }); return; }
    if (msg.method === 'thread/resume' && (msg.params?.threadId !== nativeThreadId || msg.params?.excludeTurns !== true)) {
      // Real history hydration can exceed the decoder bound. Metadata-only resume must avoid it.
      reply({ thread: { id: nativeThreadId, turns: [{ text: 'x'.repeat(3 * 1024 * 1024) }] } }); return;
    }
    reply({ thread: { id: nativeThreadId }, instructionSources: mode === 'instruction-source' ? ['/fixture/personal/AGENTS.md'] : mode === 'bad-instruction-source' ? null : [] }); return;
  }
  if (msg.method === 'turn/interrupt') {
    reply({}); if (mode !== 'stale') send({ method: 'turn/completed', params: { threadId: nativeThreadId, turn: { id: nativeTurnId, status: 'interrupted' } } }); return;
  }
  if (msg.method === 'turn/start') {
    if (msg.params?.approvalPolicy !== 'untrusted' || (msg.params?.sandboxPolicy as { type?: string })?.type !== 'readOnly') { send({ id: msg.id, error: { code: -1 } }); return; }
    if (mode === 'start-hang') return;
    if (mode === 'malformed') { process.stdout.write('garbage fixture-sensitive-value\n'); return; }
    if (mode === 'rpc-error') { send({ id: msg.id, error: { message: 'fixture-sensitive-value', code: -1 } }); return; }
    turnSequence++; nativeTurnId = `native-turn-${turnSequence}`;
    send({ method: 'turn/started', params: { threadId: nativeThreadId, turn: { id: nativeTurnId } } });
    if (mode === 'stale' && turnSequence === 2) {
      send({ method: 'item/agentMessage/delta', params: { threadId: nativeThreadId, turnId: 'native-turn-1', delta: 'STALE' } });
      send({ method: 'turn/completed', params: { threadId: nativeThreadId, turn: { id: 'native-turn-1', status: 'interrupted' } } });
      send({ method: 'item/agentMessage/delta', params: { threadId: nativeThreadId, turnId: nativeTurnId, delta: 'B' } });
      send({ method: 'turn/completed', params: { threadId: nativeThreadId, turn: { id: nativeTurnId, status: 'completed' } } });
      setTimeout(() => reply({ turn: { id: nativeTurnId } }), 50); return;
    }
    reply({ turn: { id: nativeTurnId } });
    if (mode === 'env') { send({ method: 'item/agentMessage/delta', params: { threadId: nativeThreadId, turnId: nativeTurnId, delta: JSON.stringify({ keys: Object.keys(process.env).sort() }) } }); send({ method: 'turn/completed', params: { threadId: nativeThreadId, turn: { id: nativeTurnId, status: 'completed' } } }); return; }
    if (mode.startsWith('codex-error:')) { send({ method: 'turn/completed', params: { threadId: nativeThreadId, turn: { id: nativeTurnId, status: 'failed', error: { codexErrorInfo: mode.slice('codex-error:'.length), message: 'fixture-sensitive-value' } } } }); return; }
    if (mode === 'stale') { send({ method: 'item/agentMessage/delta', params: { threadId: nativeThreadId, turnId: nativeTurnId, delta: 'A' } }); return; }
    if (mode === 'approvals') { ['mcpServer/elicitation/request', 'item/permissions/requestApproval', 'applyPatchApproval', 'execCommandApproval', 'item/commandExecution/requestApproval'].forEach((method, index) => send({ id: 100 + index, method, params: {} })); return; }
    if (mode === 'exit') { process.stderr.write('fixture-sensitive-value'); process.exit(2); }
    if (mode === 'hang' || mode === 'ignore-term') return;
    send({ method: 'item/agentMessage/delta', params: { threadId: 'other-thread', turnId: nativeTurnId, delta: 'ignored' } });
    send({ method: 'item/agentMessage/delta', params: { threadId: nativeThreadId, turnId: 'other-turn', delta: 'ignored' } });
    send({ method: 'item/agentMessage/delta', params: { threadId: nativeThreadId, turnId: nativeTurnId, delta: 'Olá' } });
    send({ method: 'turn/completed', params: { threadId: nativeThreadId, turn: { id: nativeTurnId, status: mode === 'provider-error' ? 'failed' : 'completed', error: { message: 'fixture-sensitive-value' } } } });
  }
});
rl.on('close', () => { if (!argv.includes('-p')) { clearInterval(heartbeat); process.exit(0); } });
