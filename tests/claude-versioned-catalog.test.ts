import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ClaudeCliDriver, discoverEngineCatalog, discoverNativeEngineFiles } from '@dexter/engines';

const fixture = fileURLToPath(new URL('./fixtures/claude-versioned-catalog.mjs', import.meta.url));
function catalog(mode: string) {
  return new ClaudeCliDriver({ command: process.execPath, prefixArgs: [fixture],
    env: { DEXTER_FIXTURE_MODE: mode }, requestTimeoutMs: 2000, killGraceMs: 20 }).catalog();
}

test('Claude official models augment partial help examples while respecting installed version and flags', { timeout: 15000 }, async () => {
  const current = await catalog('current');
  const official = current.models.filter(model => model.minCliVersion);
  assert.equal(current.available, true);
  assert.equal(current.defaultModel, null);
  assert.equal(current.providerID, 'anthropic');
  assert.equal(current.catalogSource, 'https://code.claude.com/docs/en/model-config');
  assert.deepEqual(official.map(model => model.id), ['claude-opus-5-5', 'claude-sonnet-5-5',
    'claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5']);
  assert(official.every(model => model.source?.startsWith('https://') && model.minCliVersion));
  assert(official.every(model => JSON.stringify(model.reasoningEfforts) === JSON.stringify(['low', 'medium', 'high', 'xhigh', 'max'])));
  assert(current.models.every(model => model.speeds.length === 0));
  assert.deepEqual(current.speeds, []);
  assert.deepEqual(current.models.filter(model => model.source === 'installed_cli_help').map(model => model.id), ['opus', 'sonnet', 'fable']);

  const beforeHaiku = await catalog('beforeHaiku');
  assert(!beforeHaiku.models.some(model => model.id === 'claude-haiku-5-5'));
  assert(beforeHaiku.models.some(model => model.id === 'claude-opus-5-5'));
  const older = await catalog('older');
  assert.deepEqual(older.models.filter(model => model.minCliVersion).map(model => model.id), ['claude-sonnet-5', 'claude-fable-5']);
  assert.deepEqual((await catalog('unknown')).models.map(model => model.id), ['opus', 'sonnet', 'fable']);
  assert((await catalog('noEffort')).models.every(model => model.reasoningEfforts.length === 0));
  assert((await catalog('limitedEffort')).models.every(model => JSON.stringify(model.reasoningEfforts) === JSON.stringify(['low', 'high'])));
  assert.deepEqual((await catalog('noModel')).models, []);
});

test('known harness installation directories remain metadata only and preserve explicit exclusion', { timeout: 5000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'dexter-known-harness-dirs-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const installed = { codex: '.npm-global/bin/codex', claude: '.claude/local/claude',
    grok: '.grok/bin/grok', muse: '.volta/bin/muse', antigravity: '.local/share/mise/shims/agy' };
  for (const relative of Object.values(installed)) {
    const path = join(home, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '#!/bin/sh\nprintf executed > "$0.executed"\n', { mode: 0o755 });
  }
  const options = { home, path: '', commands: {}, probeVersions: false };
  const files = discoverNativeEngineFiles(options);
  for (const entry of files) {
    assert.equal(entry.command, realpathSync(join(home, installed[entry.id as keyof typeof installed])));
    assert.equal(entry.installed, true);
    assert.equal(entry.selected, false);
    assert.equal(existsSync(`${entry.command}.executed`), false);
  }
  const entries = await discoverEngineCatalog(options);
  assert(entries.every(entry => entry.installed && !entry.available && entry.models.length === 0));
  assert.deepEqual(entries.map(entry => entry.providerID), ['openai', 'anthropic', 'xai', 'meta', 'google']);
  assert(entries.filter(entry => ['grok', 'muse', 'antigravity'].includes(entry.id)).every(entry => !entry.adapterSupported));
  for (const relative of Object.values(installed)) assert.equal(existsSync(`${join(home, relative)}.executed`), false);
});
