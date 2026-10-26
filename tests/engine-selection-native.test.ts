import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { EngineSelection } from '@dexter/contracts';
import { ClaudeCliDriver, CodexAppServerDriver, EngineError, discoverEngineCatalog,
  discoverNativeEngineFiles, discoverNativeEngines, type DriverOptions, type EngineDriver } from '@dexter/engines';

const fixture = fileURLToPath(new URL('./fixtures/engine-selection-native.mjs', import.meta.url));
function options(mode = 'native-selection'): DriverOptions {
  return { command: process.execPath, prefixArgs: [fixture], env: { DEXTER_FIXTURE_MODE: mode },
    requestTimeoutMs: 3000, turnTimeoutMs: 5000, killGraceMs: 20 };
}
async function observation(driver: EngineDriver, session: Awaited<ReturnType<EngineDriver['open']>>, selection?: EngineSelection): Promise<unknown> {
  let text = '';
  let completed = false;
  for await (const event of driver.turn(session, 'synthetic-turn', 'synthetic question', new AbortController().signal, selection)) {
    if (event.type === 'text.delta') text += event.text;
    if (event.type === 'turn.completed') completed = true;
    assert.notEqual(event.type, 'turn.failed');
  }
  assert.equal(completed, true);
  return JSON.parse(text);
}

test('Codex catalog identifiers reach native thread/start and turn/start, including turn overrides', { timeout: 15000 }, async () => {
  const catalog = await new CodexAppServerDriver(options('catalog-only')).catalog();
  assert.equal(catalog.available, true);
  assert.deepEqual(catalog.models, [{ id: 'fixture-native-model', label: 'Synthetic Model',
    reasoningEfforts: ['deep', 'light'], speeds: ['fixture-priority', 'fixture-standard'] }]);
  assert.equal(catalog.defaultModel, 'fixture-native-model');
  assert.deepEqual(catalog.reasoningEfforts, ['deep', 'light']);
  assert.deepEqual(catalog.speeds, ['fixture-priority', 'fixture-standard']);
  const selected: EngineSelection = { engine: 'codex', model: catalog.models[0]!.id,
    reasoningEffort: catalog.models[0]!.reasoningEfforts[0]!, speed: catalog.models[0]!.speeds[0]! };
  const driver = new CodexAppServerDriver(options());
  const session = await driver.open('synthetic-thread', undefined, { selection: selected });
  try {
    assert.deepEqual(await observation(driver, session), {
      thread: { model: 'fixture-native-model', serviceTier: 'fixture-priority' },
      turn: { model: 'fixture-native-model', effort: 'deep', serviceTier: 'fixture-priority' },
    });
    assert.deepEqual(await observation(driver, session, { ...selected, reasoningEffort: 'light', speed: 'fixture-standard' }), {
      thread: { model: 'fixture-native-model', serviceTier: 'fixture-priority' },
      turn: { model: 'fixture-native-model', effort: 'light', serviceTier: 'fixture-standard' },
    });
  } finally { await driver.close(session); }
});

test('Claude help aliases and efforts reach native flags; unsupported speed fails and defaults omit overrides', { timeout: 15000 }, async () => {
  const driver = new ClaudeCliDriver(options());
  const catalog = await driver.catalog();
  assert.equal(catalog.available, true);
  assert.deepEqual(catalog.models.map(model => model.id), ['fixture-opus', 'fixture-sonnet']);
  assert.deepEqual(catalog.reasoningEfforts, ['low', 'high']);
  assert.deepEqual(catalog.speeds, []);
  assert(catalog.models.every(model => model.speeds.length === 0));
  const selected: EngineSelection = { engine: 'claude', model: catalog.models[1]!.id,
    reasoningEffort: catalog.models[1]!.reasoningEfforts[1]!, speed: null };
  const session = await driver.open('synthetic-thread', undefined, { selection: selected });
  try {
    assert.deepEqual(await observation(driver, session), {
      model: 'fixture-sonnet', effort: 'high', fast: false, speed: null, serviceTier: null,
    });
    await assert.rejects(observation(driver, session, { ...selected, speed: 'fast' }),
      (error: unknown) => error instanceof EngineError && error.code === 'unsupported');
    assert.deepEqual(await observation(driver, session, { engine: 'claude', model: null, reasoningEffort: null, speed: null }), {
      model: null, effort: null, fast: false, speed: null, serviceTier: null,
    });
  } finally { await driver.close(session); }
});

test('metadata discovery finds all five CLIs, respects exact explicit selection and never executes files', { timeout: 5000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dexter-native-metadata-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const names = ['codex', 'claude', 'grok', 'muse', 'agy'];
  for (const name of names) writeFileSync(join(dir, name), '#!/bin/sh\nprintf executed > "$0.executed"\n', { mode: 0o755 });
  const discovery = { path: dir, home: dir, directories: [] };
  const found = discoverNativeEngineFiles(discovery);
  assert.deepEqual(found.map(entry => entry.id), ['codex', 'claude', 'grok', 'muse', 'antigravity']);
  assert(found.every(entry => entry.installed));
  assert.deepEqual(found.filter(entry => entry.selected).map(entry => entry.id), ['codex', 'claude', 'grok', 'muse']);
  const explicit = await discoverNativeEngines({ ...discovery, commands: { codex: join(dir, 'codex') } });
  assert(explicit.every(entry => entry.installed));
  assert.deepEqual(explicit.filter(entry => entry.selected).map(entry => entry.id), ['codex']);
  assert.equal(explicit[0]!.command, realpathSync(join(dir, 'codex')));
  const excluded = await discoverEngineCatalog({ ...discovery, commands: {}, probeVersions: false });
  assert(excluded.every(entry => entry.installed && !entry.available && entry.models.length === 0));
  assert(excluded.every(entry => entry.adapterSupported));
  assert.match(excluded.find(entry => entry.id === 'antigravity')!.unavailableReason!, /ACP runtime/);
  for (const name of names) assert.equal(existsSync(join(dir, `${name}.executed`)), false);
});
