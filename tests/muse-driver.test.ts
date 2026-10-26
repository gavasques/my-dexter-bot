import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { MuseMspDriver, EngineError, type EngineEvent, type EngineImageInput } from '@dexter/engines';

const fixture = fileURLToPath(new URL('./fixtures/muse-protocol.js', import.meta.url));
const gateway = fileURLToPath(new URL('./fixtures/muse-gateway.js', import.meta.url));
const profiles: string[] = [];
function testProfile(): string { const root = realpathSync(mkdtempSync('/tmp/dx-muse-')); profiles.push(root); return join(root, 'profile'); }
test.after(() => { for (const root of profiles) rmSync(root, { recursive: true, force: true }); });
function driver(mode = 'normal'): MuseMspDriver { return new MuseMspDriver({ command: process.execPath, prefixArgs: [fixture], authConfigDirectory: testProfile(), env: { DEXTER_FIXTURE_MODE: mode, MUSE_API_KEY: 'must-not-inherit' }, requestTimeoutMs: 3000, turnTimeoutMs: 5000, killGraceMs: 20 }); }
async function collect(values: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> { const result: EngineEvent[] = []; for await (const value of values) result.push(value); return result; }
test('Muse MSP: public catalog and ephemeral continuity, strict model/effort selection', async () => {
  const muse = driver();
  assert.deepEqual(await muse.status(), { engine: 'muse', installed: true, version: '1.4.4', authentication: 'unknown', billing: 'subscription' });
  const catalog = await muse.catalog(); assert.equal(catalog.available, true); assert.equal(catalog.models[0]?.id, 'muse-synthetic-1'); assert.deepEqual(catalog.speeds, []); assert.deepEqual(catalog.models[0]?.reasoningEfforts, ['low', 'high', 'max', 'ultra']);
  const session = await muse.open('thread-muse');
  try {
    const first = await collect(muse.turn(session, 'turn-first', 'synthetic', new AbortController().signal));
    assert.deepEqual(first.map(item => item.type), ['text.delta', 'turn.completed']); assert.equal(first[0]?.type === 'text.delta' && first[0].text, 'Olá Muse');
    const second = await collect(muse.turn(session, 'turn-second', 'assert:model-effort', new AbortController().signal, { engine: 'muse', model: 'muse-synthetic-2', reasoningEffort: 'medium', speed: null }));
    assert.equal(second.at(-1)?.type, 'turn.completed');
    const third = await collect(muse.turn(session, 'turn-third', 'assert:default-effort', new AbortController().signal, { engine: 'muse', model: null, reasoningEffort: 'max', speed: null }));
    assert.equal(third.at(-1)?.type, 'turn.completed');
    for (const selection of [{ engine: 'muse' as const, model: 'unknown', reasoningEffort: null, speed: null }, { engine: 'muse' as const, model: 'muse-synthetic-2', reasoningEffort: 'ultra', speed: null }, { engine: 'muse' as const, model: 'muse-synthetic-1', reasoningEffort: null, speed: 'fast' }]) await assert.rejects(collect(muse.turn(session, 'invalid', 'synthetic', new AbortController().signal, selection)), (error: unknown) => error instanceof EngineError && error.code === 'unsupported');
  } finally { await muse.close(session); }
  assert.equal(muse.capabilities.resume, false);
  await assert.rejects(muse.open('thread-muse', session.nativeCursor), (error: unknown) => error instanceof EngineError && error.code === 'unsupported');
});
test('Muse MSP: checked PNG bytes are real input parts', async () => {
  const muse = driver(), session = await muse.open('thread-image');
  const data = Buffer.from('synthetic-image');
  const image: EngineImageInput = { id: '019f00ff-0000-7000-8000-000000000009', threadId: 'thread-image', mediaType: 'image/png', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), width: 1, height: 1, createdAt: Date.parse('2026-10-11T00:00:00.000Z'), data };
  try { const events = await collect(muse.turn(session, 'turn-image', 'assert:image', new AbortController().signal, undefined, [image])); assert.equal(events.at(-1)?.type, 'turn.completed'); }
  finally { await muse.close(session); }
});
for (const mode of ['gateway', 'gateway-deny']) test(`Muse MSP: ${mode} crosses the owned MCP bridge and retains host decision`, async () => {
  const lab = mkdtempSync('/tmp/dx-muse-'), receipt = join(lab, 'receipt.json');
  const muse = new MuseMspDriver({ command: process.execPath, prefixArgs: [fixture], authConfigDirectory: testProfile(), env: { DEXTER_FIXTURE_MODE: mode }, localMcpServer: { command: process.execPath, args: [gateway, receipt] }, allowedMcpTools: ['mcp__dexter_gateway__dx_0123456789abcdef01234567'], requestTimeoutMs: 3000, turnTimeoutMs: 5000, killGraceMs: 20 });
  const session = await muse.open('thread-gateway');
  try {
    const events = await collect(muse.turn(session, 'gateway-turn', 'synthetic action', new AbortController().signal));
    assert.equal(events.at(-1)?.type, 'turn.completed'); assert.equal(events[0]?.type === 'text.delta' && events[0].text, mode === 'gateway' ? 'Ação concluída pelo host' : 'Ação negada pelo host');
    assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), { tool: 'dx_0123456789abcdef01234567', text: mode === 'gateway' ? 'synthetic-action' : 'deny-synthetic-action', approved: mode === 'gateway' });
  } finally { await muse.close(session); rmSync(lab, { recursive: true, force: true }); }
});
test('Muse MSP: native approvals are denied once and do not acquire host permission', async () => {
  const muse = driver('native-approval'), session = await muse.open('thread-native');
  try { const events = await collect(muse.turn(session, 'native-turn', 'synthetic', new AbortController().signal)); assert.equal(events.at(-1)?.type, 'turn.completed'); assert.equal(events[0]?.type === 'text.delta' && events[0].text, 'Ferramenta nativa recusada'); }
  finally { await muse.close(session); }
});
for (const [mode, code] of [['provider-error', 'authentication_required'], ['gap', 'protocol_error'], ['native-tool', 'protocol_error']]) test(`Muse MSP: ${mode} fails with a redacted single terminal`, async () => {
  const muse = driver(mode), session = await muse.open('thread-failure');
  try { const events = await collect(muse.turn(session, 'failure-turn', 'synthetic', new AbortController().signal)); assert.equal(events.filter(item => item.type.startsWith('turn.')).length, 1); assert.deepEqual(events.at(-1), { type: 'turn.failed', threadId: 'thread-failure', turnId: 'failure-turn', code }); assert(!JSON.stringify(events).includes('fixture-private-error')); }
  finally { await muse.close(session); }
});
test('Muse MSP: schema drift is refused before any session or inference', async () => { await assert.rejects(driver('schema-drift').open('thread-drift'), (error: unknown) => error instanceof EngineError && error.code === 'unsupported'); });
test('Muse MSP: stop drains the owned process before settling and invalidates continuation', async () => {
  const muse = driver('cancel'), session = await muse.open('thread-cancel'); const controller = new AbortController();
  const stream = muse.turn(session, 'cancel-turn', 'synthetic', controller.signal)[Symbol.asyncIterator]();
  assert.equal((await stream.next()).value?.type, 'text.delta');
  await muse.interrupt(session, 'cancel-turn');
  assert.equal((await stream.next()).value?.type, 'turn.interrupted'); assert.equal((await stream.next()).done, true);
  await assert.rejects(collect(muse.turn(session, 'again', 'synthetic', new AbortController().signal)), (error: unknown) => error instanceof EngineError && error.code === 'session_uncertain'); await muse.close(session);
});
