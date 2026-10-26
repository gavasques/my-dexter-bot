import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultEngineSelection } from '@dexter/contracts';
import { AntigravityAcpDriver, GrokAcpDriver, EngineError, type EngineDriver, type EngineEvent } from '@dexter/engines';
const fixture = fileURLToPath(new URL('./fixtures/acp-protocol.js', import.meta.url));
const collect = async (stream: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> => { const events: EngineEvent[] = []; for await (const event of stream) events.push(event); return events; };
function options(t: { after(callback: () => void | Promise<void>): void }, mode = 'normal') {
  const home = mkdtempSync(join(tmpdir(), 'dexter-acp-test-')); chmodSync(home, 0o700);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { command: process.execPath, prefixArgs: [fixture], env: { HOME: home, DEXTER_FIXTURE_MODE: mode }, requestTimeoutMs: 3000, turnTimeoutMs: 5000, killGraceMs: 20 };
}
async function turn(driver: EngineDriver): Promise<EngineEvent[]> {
  const session = await driver.open('thread');
  try { return await collect(driver.turn(session, 'turn', 'Synthetic text only', new AbortController().signal)); }
  finally { await driver.close(session); }
}
test('Grok ACP streams public text and bounded usage without native credentials; profile is private', async t => {
  const driver = new GrokAcpDriver(options(t));
  assert.deepEqual(await driver.status(), { engine: 'grok', installed: true, version: '1.0.50', authentication: 'unknown', billing: 'subscription' });
  const catalog = await driver.catalog(); assert.equal(catalog.available, true); assert.equal(catalog.defaultModel, 'grok-fixture');
  const events = await turn(driver);
  assert.deepEqual(events.map(event => event.type), ['text.delta', 'turn.completed']);
  assert.equal(events[0]?.type === 'text.delta' && JSON.parse(events[0].text).homePrivate, process.platform === 'darwin');
  const terminal = events.at(-1); assert.deepEqual(terminal?.type === 'turn.completed' && terminal.usage, { inputTokens: 2, outputTokens: 3 });
  assert(!JSON.stringify(events).includes('fixture-sensitive-value'));
  assert.equal(driver.capabilities.resume, false); assert.equal(driver.capabilities.supportsImages, false);
});
test('Grok ACP allows advertised effort, pins model in profile, and rejects speed/model-profile rebuilding', async t => {
  const driver = new GrokAcpDriver(options(t)); const chosen = { ...defaultEngineSelection('grok'), model: 'grok-fixture', reasoningEffort: 'high' };
  const session = await driver.open('thread', undefined, { selection: chosen });
  try {
    const events = await collect(driver.turn(session, 'first', 'Synthetic', new AbortController().signal, chosen));
    assert.equal(events[0]?.type === 'text.delta' && JSON.parse(events[0].text).effort, 'high');
    const rejected = await collect(driver.turn(session, 'second', 'Synthetic', new AbortController().signal, { ...chosen, model: 'grok-other' }));
    assert.equal(rejected.at(-1)?.type, 'turn.failed');
    const terminal = rejected.at(-1); assert.equal(terminal?.type === 'turn.failed' && terminal.code, 'unsupported');
  } finally { await driver.close(session); }
  await assert.rejects(driver.open('thread', undefined, { selection: { ...chosen, speed: 'fast' } }), (error: unknown) => error instanceof EngineError && error.code === 'unsupported');
  await assert.rejects(driver.open('thread', 'native-fixture-session'), (error: unknown) => error instanceof EngineError && error.code === 'unsupported');
});
test('Grok ACP native filesystem, terminal and non-gateway permission requests are refused', async t => {
  const events = await turn(new GrokAcpDriver(options(t, 'native-client-deny')));
  assert.equal(events.at(-1)?.type, 'turn.completed');
});
for (const mode of ['unsafe-tool', 'bad-file-input', 'provider-error']) {
  test(`Grok ACP ${mode} is one redacted terminal failure and drains the owned child`, async t => {
    const events = await turn(new GrokAcpDriver(options(t, mode)));
    assert.equal(events.at(-1)?.type, 'turn.failed'); assert.equal(events.filter(event => event.type.startsWith('turn.')).length, 1);
    assert(!JSON.stringify(events).includes('fixture-sensitive-value'));
  });
}
test('Grok ACP rejects unverified profile versions and native ambient MCPs before any prompt', async t => {
  for (const mode of ['unverified-version', 'extra-server']) {
    const driver = new GrokAcpDriver(options(t, mode));
    await assert.rejects(driver.open('thread'), (error: unknown) => error instanceof EngineError && error.code === 'unsupported');
  }
  const driver = new GrokAcpDriver(options(t, 'unauthenticated'));
  await assert.rejects(driver.open('thread'), (error: unknown) => error instanceof EngineError && error.code === 'authentication_required');
});
test('Grok ACP interrupt waits for owned process-group cleanup and poisons the old session', async t => {
  const driver = new GrokAcpDriver(options(t, 'ignore-term')); const session = await driver.open('thread'); const abort = new AbortController();
  const iterator = driver.turn(session, 'first', 'Synthetic', abort.signal)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, 'text.delta');
  await assert.rejects(collect(driver.turn(session, 'other', 'Synthetic', new AbortController().signal)), (error: unknown) => error instanceof EngineError && error.code === 'busy');
  abort.abort(); assert.equal((await iterator.next()).value?.type, 'turn.interrupted'); await iterator.return?.();
  await assert.rejects(collect(driver.turn(session, 'retry', 'Synthetic', new AbortController().signal)), (error: unknown) => error instanceof EngineError && error.code === 'session_uncertain');
  await driver.close(session);
});
test('Antigravity discovers its actual ACP runtime and keeps unsupported native admission unavailable', async t => {
  const opts = options(t, 'antigravity'); const helper = join(opts.env.HOME, 'localharness_external'); writeFileSync(helper, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const driver = new AntigravityAcpDriver({ ...opts, harnessPath: helper });
  assert.deepEqual(await driver.status(), { engine: 'antigravity', installed: true, version: '1.3.0', authentication: 'unknown', billing: 'subscription' });
  const catalog = await driver.catalog(); assert.equal(catalog.available, false); assert.equal(catalog.installed, true); assert.match(catalog.unavailableReason ?? '', /Dexter-only tool registry/);
  await assert.rejects(driver.open('thread'), (error: unknown) => error instanceof EngineError && error.code === 'unsupported');
  assert.equal(driver.capabilities.resume, false); assert.equal(driver.capabilities.supportsImages, false);
});
