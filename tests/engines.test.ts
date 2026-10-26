import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ClaudeCliDriver, CodexAppServerDriver, EngineError, type DriverOptions, type EngineDriver, type EngineEvent } from '@dexter/engines';
const fixture = fileURLToPath(new URL('./fixtures/engine-protocol.js', import.meta.url));
function options(mode = 'normal'): DriverOptions {
  return { command: process.execPath, prefixArgs: [fixture], env: { DEXTER_FIXTURE_MODE: mode }, requestTimeoutMs: 10000, turnTimeoutMs: 20000, killGraceMs: 20 };
}
async function fromAsync<T>(input: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of input) values.push(value); return values; }
const constructors = [ClaudeCliDriver, CodexAppServerDriver];
async function collect(driver: EngineDriver, mode = 'turn'): Promise<EngineEvent[]> {
  const session = await driver.open('thread');
  try { return await fromAsync(driver.turn(session, mode, 'hello', new AbortController().signal)); }
  finally { await driver.close(session); }
}
for (const Driver of constructors) {
  test(`${Driver.name}: official diagnostics project only public fields and reject API-key auth`, async () => {
    const driver = new Driver(options());
    assert.deepEqual(await driver.status(), { engine: driver.id, installed: true, version: '1.2.3', authentication: 'authenticated', billing: 'subscription' });
    for (const mode of ['unauthenticated', 'api-key']) {
      const rejected = new Driver(options(mode));
      assert.equal((await rejected.status()).authentication, 'required');
      await assert.rejects(rejected.open('thread'), (error: unknown) => error instanceof EngineError && error.code === 'authentication_required');
    }
  });
  test(`${Driver.name}: streams one text sequence, maps local identity and resumes`, async () => {
    const driver = new Driver(options()); const session = await driver.open('thread');
    const first = await fromAsync(driver.turn(session, 'turn', 'fixture:new', new AbortController().signal));
    assert.deepEqual(first.map(event => event.type), ['text.delta', 'turn.completed']);
    assert.equal(first[0]?.type === 'text.delta' && first[0].text, 'Olá');
    assert(first.every(event => event.threadId === 'thread' && event.turnId === 'turn'));
    assert(!JSON.stringify(first).includes('fixture-sensitive-value'));
    const nativeCursor = session.nativeCursor; await driver.close(session);
    const resumed = await driver.open('thread', nativeCursor);
    const events = await fromAsync(driver.turn(resumed, 'second', 'fixture:resume', new AbortController().signal));
    assert.equal(events.at(-1)?.type, 'turn.completed'); await driver.close(resumed);
    await assert.rejects(fromAsync(driver.turn(resumed, 'closed', 'hello', new AbortController().signal)), (error: unknown) => error instanceof EngineError && error.code === 'session_closed');
  });
  for (const mode of ['malformed', 'exit', 'provider-error']) {
    test(`${Driver.name}: ${mode} becomes one safe terminal failure`, async () => {
      const events = await collect(new Driver(options(mode)));
      assert.equal(events.at(-1)?.type, 'turn.failed');
      assert.equal(events.filter(event => event.type.startsWith('turn.')).length, 1);
      assert(!JSON.stringify(events).includes('fixture-sensitive-value'));
    });
  }
  test(`${Driver.name}: cancellation and busy state do not leak a hanging child`, async () => {
    const driver = new Driver(options('ignore-term')); const session = await driver.open('thread'); const abort = new AbortController();
    const stream = driver.turn(session, 'turn', 'hello', abort.signal); const iterator = stream[Symbol.asyncIterator]();
    const waiting = iterator.next();
    await new Promise(resolve => setTimeout(resolve, 50));
    await assert.rejects(fromAsync(driver.turn(session, 'other', 'hello', new AbortController().signal)), (error: unknown) => error instanceof EngineError && error.code === 'busy');
    abort.abort(); assert.equal((await waiting).value?.type, 'turn.interrupted');
    await iterator.return?.(); await driver.close(session);
  });
  test(`${Driver.name}: already aborted turn never starts inference`, async () => {
    const driver = new Driver(options()); const session = await driver.open('thread'); const abort = new AbortController(); abort.abort();
    const events = await fromAsync(driver.turn(session, 'turn', 'hello', abort.signal));
    assert.deepEqual(events, [{ type: 'turn.interrupted', threadId: 'thread', turnId: 'turn' }]); await driver.close(session);
  });
  test(`${Driver.name}: timeouts terminate the session without hanging`, async () => {
    const driver = new Driver({ ...options('ignore-term'), turnTimeoutMs: 100 });
    const events = await collect(driver);
    assert.equal(events.at(-1)?.type, 'turn.failed');
    const terminal = events.at(-1); assert.equal(terminal?.type === 'turn.failed' && terminal.code, 'timeout');
  });
}
test('ClaudeCliDriver: final response fallback avoids missing text when partial deltas are unavailable', async () => {
  const events = await collect(new ClaudeCliDriver(options('fallback')));
  assert.equal(events[0]?.type === 'text.delta' && events[0].text, 'Olá');
});
test('Claude: inconclusive native auth diagnostics do not ask the user to authenticate again', async () => {
  const driver = new ClaudeCliDriver(options('auth-unknown'));
  assert.equal((await driver.status()).authentication, 'unknown');
  await assert.rejects(driver.open('thread'), (error: unknown) => error instanceof EngineError && error.code === 'engine_unavailable');
});
test('ClaudeCliDriver: bounded line decoder rejects oversized output', async () => {
  const events = await collect(new ClaudeCliDriver(options('oversize')));
  assert.equal(events.at(-1)?.type, 'turn.failed');
});
test('CodexAppServerDriver: a missing start response times out without orphaning the child', { timeout: 10000 }, async () => {
  let opened = false;
  // RPC timers are read at dispatch. Keep startup generous, then exercise only the missing turn/start reply.
  const driver = new CodexAppServerDriver({ ...options('start-hang'), get requestTimeoutMs() { return opened ? 500 : 10000; } });
  const session = await driver.open('thread');
  assert.equal(session.nativeCursor, 'native-thread'); opened = true;
  try {
    const events = await fromAsync(driver.turn(session, 'missing-start', 'hello', new AbortController().signal));
    assert.deepEqual(events, [{ type: 'turn.failed', threadId: 'thread', turnId: 'missing-start', code: 'timeout' }]);
  } finally { await driver.close(session); }
  await assert.rejects(fromAsync(driver.turn(session, 'closed', 'hello', new AbortController().signal)), (error: unknown) => error instanceof EngineError && error.code === 'session_closed');
});
test('drivers: missing installation is distinct from login required', async () => {
  for (const Driver of constructors) {
    const driver = new Driver({ command: '/nonexistent/dexter-fixture-engine', requestTimeoutMs: 100 });
    assert.equal((await driver.status()).installed, false);
    await assert.rejects(driver.open('thread'), (error: unknown) => error instanceof EngineError && error.code === 'not_installed');
  }
});

test('Claude: init does not prove persistence; abort requires explicit re-opening without replay', async () => {
  const driver = new ClaudeCliDriver(options('init-abort')); const session = await driver.open('thread'); const abort = new AbortController();
  const iterator = driver.turn(session, 'first', 'hello', abort.signal)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, 'text.delta'); abort.abort();
  assert.equal((await iterator.next()).value?.type, 'turn.interrupted'); await iterator.return?.();
  await assert.rejects(fromAsync(driver.turn(session, 'second', 'retry', new AbortController().signal)), (error: unknown) => error instanceof EngineError && error.code === 'session_uncertain');
  await driver.close(session);
});
test('Claude: ambient credentials, API routing and third-party secrets are absent from the child env', async () => {
  const driver = new ClaudeCliDriver({ ...options('env'), env: { DEXTER_FIXTURE_MODE: 'env', ANTHROPIC_BASE_URL: 'https://invalid.test', ANTHROPIC_API_KEY: 'never-share', CLAUDE_CODE_USE_BEDROCK: '1', AWS_SECRET_ACCESS_KEY: 'never-share', COMPOSIO_API_KEY: 'never-share', OPENAI_BASE_URL: 'https://invalid.test', HTTP_PROXY: 'https://invalid.test' } });
  const events = await collect(driver); const text = events.find(event => event.type === 'text.delta');
  assert(text?.type === 'text.delta'); const keys = (JSON.parse(text.text) as { keys: string[] }).keys;
  for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'AWS_SECRET_ACCESS_KEY', 'COMPOSIO_API_KEY', 'OPENAI_BASE_URL', 'HTTP_PROXY']) assert(!keys.includes(key));
  assert(keys.includes('HOME')); assert(keys.includes('PATH'));
});
test('Codex: delayed events from cancelled A never become B, including B deltas before the start response', async () => {
  const driver = new CodexAppServerDriver(options('stale')); const session = await driver.open('thread'); const abort = new AbortController();
  const iterator = driver.turn(session, 'A', 'first', abort.signal)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, 'text.delta'); abort.abort();
  assert.equal((await iterator.next()).value?.type, 'turn.interrupted'); await iterator.return?.();
  const events = await fromAsync(driver.turn(session, 'B', 'second', new AbortController().signal));
  assert.deepEqual(events, [{ type: 'text.delta', threadId: 'thread', turnId: 'B', text: 'B' }, { type: 'turn.completed', threadId: 'thread', turnId: 'B', usage: {} }]);
  await driver.close(session);
});
test('Codex: all native approval variants receive protocol-valid denials', async () => {
  const events = await collect(new CodexAppServerDriver(options('approvals'))); const text = events.find(event => event.type === 'text.delta'); assert(text?.type === 'text.delta');
  assert.deepEqual(JSON.parse(text.text), { '100': { action: 'decline', content: null, _meta: null }, '101': { permissions: {}, scope: 'turn', strictAutoReview: true }, '102': { decision: 'abort' }, '103': { decision: 'abort' }, '104': { decision: 'decline' } });
});
test('Claude: UTF-8 byte limit rejects a short-in-codepoints oversized line', async () => {
  const events = await collect(new ClaudeCliDriver(options('oversize-utf8'))); const last = events.at(-1);
  assert(last?.type === 'turn.failed'); assert.equal(last.code, 'protocol_error');
});
test('Claude: Unix process-group cancellation kills a SIGTERM-resistant descendant', { skip: process.platform === 'win32' }, async () => {
  const driver = new ClaudeCliDriver(options('tree')); const session = await driver.open('thread'); const abort = new AbortController(); const iterator = driver.turn(session, 'tree', 'hello', abort.signal)[Symbol.asyncIterator]();
  const first = (await iterator.next()).value; assert(first?.type === 'text.delta'); const pid = Number(first.text); assert(Number.isInteger(pid));
  abort.abort(); await iterator.next(); await iterator.return?.(); await driver.close(session);
  let alive = true; for (let i = 0; i < 20; i++) { try { process.kill(pid, 0); } catch { alive = false; break; } await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(alive, false);
});
test('Codex: custom inference routing is refused despite a ChatGPT account', async () => {
  const driver = new CodexAppServerDriver(options('custom-route'));
  await assert.rejects(driver.open('thread'), (error: unknown) => error instanceof EngineError && error.code === 'subscription_required');
});

for (const mode of ['openai-route', 'thread-store-route', ...['base_url', 'http_headers', 'env_http_headers', 'env_key', 'experimental_bearer_token', 'requires_openai_auth'].map(key => `provider:${key}`)]) {
  test(`Codex: ${mode} cannot route native subscription requests through ambient configuration`, async () => {
    const driver = new CodexAppServerDriver(options(mode));
    await assert.rejects(driver.open('thread'), (error: unknown) => error instanceof EngineError && error.code === 'subscription_required');
  });
}
for (const key of ['instructions', 'developer_instructions', 'compact_prompt', 'model_instructions_file']) {
  test(`Codex: unexpected ${key} after configuration isolation is refused before starting a conversation`, async () => {
    const driver = new CodexAppServerDriver(options(`instructions:${key}`));
    await assert.rejects(driver.open('thread'), (error: unknown) => error instanceof EngineError && error.code === 'protocol_error');
  });
}
for (const mode of ['instruction-source', 'bad-instruction-source']) {
  test(`Codex: ${mode} in the protocol response is refused on start and resume`, async () => {
    for (const cursor of [undefined, 'native-thread']) {
      const driver = new CodexAppServerDriver(options(mode));
      await assert.rejects(driver.open('thread', cursor), (error: unknown) => error instanceof EngineError && error.code === 'protocol_error');
    }
  });
}
test('Codex: metadata-only resume avoids hydrating history larger than the line bound', async () => {
  const driver = new CodexAppServerDriver(options());
  const session = await driver.open('thread', 'native-thread');
  try {
    const events = await fromAsync(driver.turn(session, 'resumed', 'hello', new AbortController().signal));
    assert.deepEqual(events.map(event => event.type), ['text.delta', 'turn.completed']);
  } finally { await driver.close(session); }
});
test('Codex: child environment carries OS authentication discovery without ambient credentials or routing', async () => {
  const driver = new CodexAppServerDriver({ ...options('env'), env: {
    DEXTER_FIXTURE_MODE: 'env', OPENAI_API_KEY: 'fixture-only', OPENAI_BASE_URL: 'https://invalid.test',
    CODEX_HOME: '/fixture/alternate', HTTP_PROXY: 'https://invalid.test', HTTPS_PROXY: 'https://invalid.test',
    COMPOSIO_API_KEY: 'fixture-only', ANTHROPIC_API_KEY: 'fixture-only',
  } });
  const events = await collect(driver);
  const text = events.find(event => event.type === 'text.delta'); assert(text?.type === 'text.delta');
  const keys = (JSON.parse(text.text) as { keys: string[] }).keys;
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'COMPOSIO_API_KEY', 'ANTHROPIC_API_KEY']) assert(!keys.includes(key));
  assert(keys.includes('HOME')); assert(keys.includes('PATH'));
});
test('Claude: a result is allowed to flush persistence and exit naturally before process cleanup', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'dexter-flush-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const events = await collect(new ClaudeCliDriver({ ...options('result-flush'), cwd, killGraceMs: 200 }));
  assert.equal(events.at(-1)?.type, 'turn.completed');
  assert.equal(readFileSync(join(cwd, 'flush-complete'), 'utf8'), 'persisted');
});
test('Claude: successful natural leader exit still cleans its SIGTERM-resistant descendant', { skip: process.platform === 'win32' }, async () => {
  const driver = new ClaudeCliDriver({ ...options('tree-success'), killGraceMs: 100 });
  const events = await collect(driver);
  assert.equal(events.at(-1)?.type, 'turn.completed');
  const first = events[0]; assert(first?.type === 'text.delta');
  const pid = Number(first.text); assert(Number.isInteger(pid));
  let alive = true;
  for (let i = 0; i < 30; i++) {
    try { process.kill(pid, 0); } catch { alive = false; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(alive, false);
});
for (const mode of ['queue-full', 'queue-overflow']) {
  test(`Claude: ${mode} preserves accepted deltas and never completes after overflow`, { timeout: 30000 }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dexter-queue-handshake-'));
    const driver = new ClaudeCliDriver({ ...options(mode), cwd });
    const session = await driver.open('thread');
    const iterator = driver.turn(session, 'buffered', 'hello', new AbortController().signal)[Symbol.asyncIterator]();
    try {
      const first = await iterator.next(); assert(first.value?.type === 'text.delta');
      // Fixture pauses after delta 0. Observe the real decoder's terminal/failure callbacks,
      // after the driver handles them, before asking the iterator for any buffered delta.
      // This test-only structural view installs observers, without changing queue/driver behavior.
      const state = (driver as unknown as { states: Map<typeof session, { active?: { process: {
        onMessage: (message: Record<string, unknown>) => void;
        onFailure: (error: EngineError) => void;
      } } }> }).states.get(session);
      assert.ok(state?.active);
      const child = state.active.process;
      const processed = new Promise<'result' | 'failure'>((done, reject) => {
        const timer = setTimeout(() => reject(new Error('Fixture decoder did not confirm producer output')), 10000);
        const confirm = (value: 'result' | 'failure') => { clearTimeout(timer); done(value); };
        const onMessage = child.onMessage, onFailure = child.onFailure;
        child.onMessage = message => { onMessage(message); if (message.type === 'result') confirm('result'); };
        child.onFailure = error => { onFailure(error); confirm('failure'); };
      });
      writeFileSync(join(cwd, 'release-buffer'), 'synthetic release');
      assert.equal(await processed, mode === 'queue-full' ? 'result' : 'failure');
      const events: EngineEvent[] = [first.value];
      for (;;) { const next = await iterator.next(); if (next.done) break; events.push(next.value); }
      const deltas = events.filter(event => event.type === 'text.delta');
      assert.equal(deltas.length, 4097, 'every accepted delta survives terminal delivery');
      assert(deltas.every((event, index) => event.type === 'text.delta' && event.text === String(index)));
      const terminal = events.at(-1);
      if (mode === 'queue-full') assert.equal(terminal?.type, 'turn.completed');
      else { assert(terminal?.type === 'turn.failed'); assert.equal(terminal.code, 'protocol_error'); }
      assert.equal(events.filter(event => event.type.startsWith('turn.')).length, 1);
    } finally { await iterator.return?.(); await driver.close(session); rmSync(cwd, { recursive: true, force: true }); }
  });
}
test('queue: an unserializable terminal cannot strand its waiting consumer', async () => {
  const { AsyncQueue } = await import(pathToFileURL(resolve('packages/engines/dist/process.js')).href);
  const queue = new AsyncQueue();
  const waiting: Promise<unknown> = queue.next();
  const circular: { self?: unknown } = {}; circular.self = circular;
  queue.pushFinal(circular, { type: 'turn.failed', code: 'protocol_error' });
  queue.end();
  assert.deepEqual(await waiting, { type: 'turn.failed', code: 'protocol_error' });
  assert.equal(await queue.next(), undefined);
});
test('process: missing executable never signals the caller through an invalid spawn handle', { timeout: 5_000 }, async () => {
  const processModule = pathToFileURL(resolve('packages/engines/dist/process.js')).href;
  const source = `import { JsonProcess } from ${JSON.stringify(processModule)};
    const child = new JsonProcess('/nonexistent/dexter-fixture-engine', [], { killGraceMs: 10 });
    await child.stop(); await child.done;
    process.stdout.write('safe-missing-executable');`;
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolveResult, reject) => {
    // A broken kill(-0) must only kill this isolated worker, never the test runner's group.
    const worker = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'pipe', 'ignore'], shell: false, detached: process.platform !== 'win32' });
    let output = '';
    worker.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    worker.once('error', reject);
    worker.once('exit', (code, signal) => resolveResult({ code, signal, output }));
  });
  assert.deepEqual(result, { code: 0, signal: null, output: 'safe-missing-executable' });
});
for (const [provider, cases] of [
  ['claude', [['authentication_failed', 'authentication_required'], ['rate_limit', 'rate_limited'], ['billing_error', 'usage_limit'], ['fixture-sensitive-value', 'engine_failed']]],
  ['codex', [['unauthorized', 'authentication_required'], ['usageLimitExceeded', 'usage_limit'], ['sessionBudgetExceeded', 'usage_limit'], ['rateLimitExceeded', 'rate_limited'], ['serverOverloaded', 'engine_unavailable'], ['flexUnavailable', 'engine_unavailable'], ['contextWindowExceeded', 'context_limit'], ['fixture-sensitive-value', 'engine_failed']]],
] as const) {
  test(`${provider}: provider failures map to fixed public codes without their messages`, async () => {
    for (const [raw, expected] of cases) {
      const Driver = provider === 'claude' ? ClaudeCliDriver : CodexAppServerDriver;
      const events = await collect(new Driver(options(`${provider}-error:${raw}`)));
      const terminal = events.at(-1); assert(terminal?.type === 'turn.failed');
      assert.equal(terminal.code, expected);
      assert(!JSON.stringify(events).includes('fixture-sensitive-value'));
    }
  });
}
