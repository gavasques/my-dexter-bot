import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as nextTick } from 'node:timers/promises';
import { HarnessOperationSurface, HARNESS_OPERATION_DESTINATION } from '../packages/cli/dist/harness-operation-surface.js';
import { HostServices } from '../packages/cli/dist/host-services.js';
import { GrokAcpDriver, MuseMspDriver, AntigravityAcpDriver, discoverEngineCatalog } from '@dexter/engines';
import * as contracts from '@dexter/contracts';
const { EngineMcpAttachmentSchema, readEngineCatalogDiagnostics } = contracts;
import { SyntheticCredentialBroker } from '@dexter/gateway';

const pre = process.env.DEXTER_FUNCTIONAL_PHASE === 'pre';
const alias = (name, destination) => 'mcp__dexter_gateway__dx_' + createHash('sha256').update(name + '\0' + destination).digest('hex').slice(0, 24);
const metadata = resolve('tests/fixtures/engines-functional-catalog-r1.mjs');
async function until(check, why) { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw Error('Fixture deadline: ' + why); await new Promise(done => setTimeout(done, 5)); } }
async function idle(host) { await until(() => !Object.values(host.runtime.status().pending).some(Boolean) && host.runtime.status().openSessions === 0, 'owned driver/lease drain'); }
function ownLab(t) { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dx-engines-functional-'))); mkdirSync(join(dir, 'home'), { mode: 0o700 }); return dir; }
function native(engine, dir, options = {}, mode = engine === 'grok' ? 'grok-gateway-host' : 'gateway-host', catalog = false) {
  const common = { ...options, command: process.execPath, prefixArgs: catalog ? [metadata, engine === 'muse' ? 'msp' : engine] : [resolve('.functional-fixtures', engine === 'grok' ? 'acp-protocol.mjs' : 'muse-protocol.mjs')],
    cwd: options.cwd ?? dir, env: { HOME: join(dir, 'home'), TMPDIR: tmpdir(), DEXTER_FIXTURE_MODE: mode }, requestTimeoutMs: 2000, turnTimeoutMs: 8000, killGraceMs: 20 };
  return engine === 'grok' ? new GrokAcpDriver({ ...common, profileHome: join(dir, 'grok-profile') })
    : new MuseMspDriver({ ...common, authConfigDirectory: join(dir, 'muse-profile') });
}

test('catalog stages remain account-unknown, metadata-only, closed and empty/unknown fail closed', { timeout: 20000 }, async t => {
  const dir = ownLab(t); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const engine of ['grok', 'muse']) {
    const available = await native(engine, dir, {}, 'normal', true).catalog();
    assert.equal(available.available, true); assert.equal(available.models.length, 1);
    assert.deepEqual(available.models[0].speeds, []); assert.deepEqual(available.speeds, []);
    const diagnostic = readEngineCatalogDiagnostics(available.diagnostics);
    assert.equal(diagnostic.initialization, 'validated'); assert.equal(diagnostic.catalog, 'validated');
    assert.equal(diagnostic.authentication, 'unknown'); assert.equal(diagnostic.nativeMcpAttached, 'not_checked');
    assert.equal(diagnostic.speed, 'unsupported'); assert.equal(diagnostic.audio, 'unsupported');
    assert.equal(readEngineCatalogDiagnostics({ ...diagnostic, nativeMcpAttached: 'validated' }), null);
    assert.equal(readEngineCatalogDiagnostics({ ...diagnostic, stderr: 'fixture-private-stderr' }), null);
    const empty = await native(engine, dir, {}, 'empty', true).catalog();
    assert.equal(empty.available, false); assert.deepEqual(empty.models, []);
    assert.equal(empty.diagnostics.initialization, 'validated'); assert.equal(empty.diagnostics.code, 'catalog_unavailable');
    await assert.rejects(native(engine, dir, {}, 'empty', true).open('synthetic-empty'), error => error.code === 'unsupported');
    const auth = await native(engine, dir, {}, 'auth', true).catalog();
    assert.equal(auth.available, false); assert.equal(auth.diagnostics.authentication, 'required');
    assert.equal(auth.diagnostics.code, 'authentication_required'); assert.equal(auth.diagnostics.nativeMcpAttached, 'not_checked');
    for (const value of [available, empty, auth]) assert.doesNotMatch(JSON.stringify(value), /fixture-private-(?:value|stderr|cursor)/);
  }
  const detected = (await discoverEngineCatalog({ commands: { grok: process.execPath }, home: dir, path: '', probeVersions: true, requestTimeoutMs: 1000 })).find(entry => entry.id === 'grok');
  assert.equal(detected.installed, true); assert.equal(detected.available, false);
  assert.equal(detected.diagnostics.initialization, 'failed'); assert.equal(detected.diagnostics.authentication, 'unknown');
  const unknown = await native('grok', dir, {}, 'unknown-default', true).catalog();
  assert.equal(unknown.available, false); assert.deepEqual(unknown.models, []); assert.equal(unknown.diagnostics.code, 'protocol_error');
  const helper = join(dir, 'synthetic-companion'); writeFileSync(helper, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const blocked = new AntigravityAcpDriver({ command: process.execPath, prefixArgs: [metadata, 'antigravity'], cwd: dir,
    env: { HOME: join(dir, 'home') }, profileHome: join(dir, 'antigravity-profile'), harnessPath: helper, requestTimeoutMs: 1000, killGraceMs: 20 });
  const entry = await blocked.catalog();
  assert.equal(entry.available, false); assert.equal(entry.diagnostics.initialization, 'validated');
  assert.equal(entry.diagnostics.transport, 'admission_blocked'); assert.deepEqual(entry.models, []);
  await assert.rejects(blocked.open('synthetic-thread'), error => error.code === 'unsupported');
});

const manifest = { name: 'slack.send', toolkit: 'slack', upstreamSlug: 'SLACK_SEND', version: 'v1', description: 'Synthetic effect',
  upstreamHost: 'functional.example.test', effect: 'write', destinationArgument: 'channel',
  inputSchema: { type: 'object', additionalProperties: false, required: ['channel'], properties: { channel: { type: 'string', maxLength: 12, enum: ['C-ops'] } } } };
async function setup(t, dir, settings = {}) {
  const catalog = await Promise.all(['grok', 'muse'].map(engine => native(engine, dir, {}, 'normal', true).catalog()));
  const broker = new SyntheticCredentialBroker(); broker.put('synthetic', { headers: { authorization: 'synthetic-credential' }, allowedHosts: [manifest.upstreamHost] });
  const observations = [], issued = [], effects = [], catalogs = new Map(), readPorts = new Map(), modes = { grok: 'grok-gateway-host', muse: 'gateway-host' };
  const originalList = HarnessOperationSurface.prototype.listTools;
  HarnessOperationSurface.prototype.listTools = function(token) {
    const views = originalList.call(this, token), cap = issued.find(value => value.token === token);
    if (cap) { catalogs.set(cap.scope.turnId, views.map(view => alias(view.name, view.connectionId))); readPorts.set(cap.scope.turnId, { surface: this, token }); }
    return views;
  };
  t.after(() => { HarnessOperationSurface.prototype.listTools = originalList; });
  const open = () => {
    const host = new HostServices({ dataDir: join(dir, 'host'), enableEngines: true, enableMcp: true, engineCommands: { grok: process.execPath, muse: process.execPath },
      engineCatalog: () => catalog, upstream: { broker, adapter: { async execute(call) { effects.push(call); if (settings.uncertain) throw Error('synthetic ambiguous effect'); return { synthetic: true }; } } },
      makeDriver(engine, options) {
        const driver = native(engine, dir, options, modes[engine]);
        if (!options.localMcpServer) return driver;
        const row = { engine, options, cursors: [], inputs: [], events: [], closes: 0, selections: [] }; observations.push(row);
        const originalOpen = driver.open.bind(driver), turn = driver.turn.bind(driver), close = driver.close.bind(driver);
        driver.open = async (...args) => { row.cursors.push(args[1]); row.selections.push(args[2].selection); return originalOpen(...args); };
        driver.turn = async function* (...args) { row.inputs.push(args[2]); for await (const event of turn(...args)) { row.events.push(event); yield event; } };
        driver.close = async session => { await close(session); row.closes++; };
        return driver;
      } });
    host.gateway.registerTool(manifest);
    const issue = host.gateway.issueCapability.bind(host.gateway);
    host.gateway.issueCapability = input => { const cap = issue(input); issued.push({ ...cap, gateway: host.gateway }); return cap; };
    return host;
  };
  let host = open(); t.after(async () => { if (host) await host.shutdown({ graceMs: 3000 }); rmSync(dir, { recursive: true, force: true }); });
  return { get host() { return host; }, open() { host = open(); return host; }, observations, issued, effects, modes, catalog, catalogs, readPorts };
}
function connect(host, bot) {
  const connection = host.gateway.connectAccount({ profileId: 'work', toolkit: 'slack', label: 'Synthetic', upstreamAccountRef: 'synthetic', credentialRef: 'synthetic', allowedHosts: [manifest.upstreamHost] });
  host.store.setGrant({ botId: bot.id, tool: manifest.name, destination: connection.id, policy: 'ask' }); return connection;
}
function final(host, turn, observation) {
  const events = host.store.listTurnEvents({ turnId: turn.id });
  assert.equal(events.filter(event => ['turn.completed', 'turn.interrupted', 'turn.failed', 'turn.unknown'].includes(event.kind)).length, 1);
  assert.ok(events.every(event => event.turnId === turn.id && event.threadId === turn.threadId));
  assert.deepEqual(observation.events.map(event => [event.type, event.turnId, event.threadId]), observation.events.map(event => [event.type, turn.id, turn.threadId]));
  assert.equal(observation.events.filter(event => event.type.startsWith('turn.')).length, 1);
  if (!pre) {
    const diagnostics = events.filter(event => event.data?.kind === 'engine_mcp_attachment');
    assert.equal(diagnostics.length, 1); const { kind, ...value } = diagnostics[0].data;
    assert.ok(EngineMcpAttachmentSchema.safeParse(value).success);
    assert.equal(value.engine, turn.engine); assert.equal(value.state, turn.engine === 'grok' ? 'validated' : 'unverified');
    assert.doesNotMatch(JSON.stringify(value), /cursor|token|stderr|socket|profile|path/i);
  }
  assert.equal(observation.closes, 1); assert.deepEqual(observation.cursors, [undefined]);
  assert.equal(existsSync(dirname(observation.options.localMcpServer.args[1])), false);
  if (turn.state === 'completed' && turn.outputMessageId !== null) {
    const text = events.filter(event => event.kind === 'text.delta').map(event => event.text).join('');
    assert.equal(host.store.listMessages(turn.threadId).find(message => message.id === turn.outputMessageId).content, text);
  }
}

test('journey: normal HostServices Grok → Muse → Grok preserves own context, idle CAS, grants and exact turn leases', { timeout: 30000 }, async t => {
  const dir = ownLab(t), state = await setup(t, dir), host = state.host, store = host.store, runtime = host.runtime;
  const bot = await runtime.createBot({ name: 'Synthetic continuity', profileId: 'work', engine: 'grok' }), thread = runtime.createThread(bot.id);
  const foreign = store.createBot({ name: 'Synthetic private bot', profileId: 'work', engine: 'muse' }), foreignThread = store.createThread(foreign.id);
  store.appendMessage(foreignThread.id, { clientMessageId: 'foreign', content: 'foreign-private-history-marker' });
  const documents = host.botDocumentsHttp.compareAndSet(bot.id, { expectedRevision: 0, soul: 'own-soul-marker', user: 'own-user-marker', memory: 'own-memory-marker' });
  host.botDocumentsHttp.compareAndSet(foreign.id, { expectedRevision: 0, soul: '', user: '', memory: 'foreign-private-memory-marker' });
  host.skillsHttp.registerSkill('own-skill', '1.0.0', 'own-selected-skill-marker');
  host.skillsHttp.setSkillActivation('own-skill', { scope: { kind: 'bot', botId: bot.id }, expected: null, version: '1.0.0' });
  const connection = connect(host, bot); store.setGrant({ botId: foreign.id, tool: 'slack.foreign', destination: 'foreign-destination', policy: 'ask' });
  for (let i = 0; i < 15; i++) store.appendMessage(thread.id, { clientMessageId: 'history-' + i, content: 'bounded-own-history-' + i + ' ' + 'x'.repeat(2200) });
  store.appendMessage(thread.id, { clientMessageId: 'sensitive', content: 'api_key=synthetic-sensitive-history' });
  const grants = store.getGrant(bot.id, manifest.name, connection.id), identity = { botId: bot.id, threadId: thread.id, documents };
  for (const [i, engine, decision] of [[0, 'grok', 'allow'], [1, 'muse', 'deny'], [2, 'grok', 'deny']]) {
    if (i) {
      const revision = store.getThreadEngineSelection(thread.id).revision;
      const selection = { engine, model: engine === 'grok' ? 'grok-fixture' : 'muse-synthetic-1', reasoningEffort: engine === 'grok' ? 'high' : 'max', speed: null };
      await assert.rejects(runtime.patchThreadEngineSelection(thread.id, { expectedRevision: revision + 1, selection }), error => error.code === 'conflict');
      if (!pre) await assert.rejects(runtime.patchThreadEngineSelection(thread.id, { expectedRevision: revision, selection: { ...selection, speed: 'fast' } }), error => error.code === 'invalid_input');
      await runtime.patchThreadEngineSelection(thread.id, { expectedRevision: revision, selection });
      assert.equal(store.getThreadSession(thread.id), null); assert.equal(store.getThreadEngineSelection(thread.id).handoffStatus, 'ready');
      assert.deepEqual(host.botDocumentsHttp.read(bot.id), identity.documents); assert.deepEqual(store.getGrant(bot.id, manifest.name, connection.id), grants);
      assert.equal(store.getThread(thread.id).botId, identity.botId);
    }
    const input = { clientRequestId: 'journey-' + i, content: 'Synthetic current request ' + i };
    const bindingsBefore = state.observations.length;
    const started = runtime.startTurn(thread.id, input);
    await until(() => store.listActions().some(action => action.request.threadId === thread.id && action.state === 'awaiting_approval'), 'owner decision');
    const action = store.listActions().find(action => action.request.threadId === thread.id && action.state === 'awaiting_approval');
    await assert.rejects(runtime.patchThreadEngineSelection(thread.id, { expectedRevision: store.getThreadEngineSelection(thread.id).revision, selection: { engine, model: null, reasoningEffort: null, speed: null } }), error => error.code === 'conflict');
    assert.equal(action.request.botId, bot.id); assert.equal(action.request.threadId, thread.id);
    const readPort = state.readPorts.get(started.turn.id);
    const projection = await readPort.surface.call(readPort.token, { tool: 'dexter.harness.models', connectionId: HARNESS_OPERATION_DESTINATION, callId: 'models-current', arguments: {} });
    assert.equal(projection.status, 'succeeded');
    if (!pre) for (const entry of projection.result.items) { assert.equal(entry.diagnostics.nativeMcpAttached, 'not_checked'); assert.equal(entry.diagnostics.authentication, 'unknown'); }
    runtime.decideAction(action.id, { decision, requestHash: action.requestHash });
    const done = await runtime.waitForTurn(started.turn.id, 8000); assert.equal(done.state, 'completed'); await idle(host);
    const ownRows = state.observations.slice(bindingsBefore);
    const row = ownRows.find(value => value.events.some(event => event.turnId === done.id));
    assert.ok(row); assert.equal(row.engine, engine);
    for (const value of ownRows) {
      const nativeTurn = store.getTurn(value.events[0].turnId); final(host, nativeTurn, value);
      if (nativeTurn.id !== done.id) {
        assert.match(value.inputs[0], /Host tool continuation/);
        assert.match(value.inputs[0], /Do not ask for these approvals or repeat any of these effects/);
      }
    }
    const expected = state.catalogs.get(done.id);
    assert.deepEqual(row.options.allowedMcpTools, expected);
    assert.ok(expected.includes(alias(manifest.name, connection.id)));
    for (const value of ownRows) assert.deepEqual(value.options.allowedMcpTools, state.catalogs.get(value.events[0].turnId));
    assert.ok(!row.options.allowedMcpTools.includes(alias('slack.foreign', 'foreign-destination')));
    assert.equal(new Set(row.options.allowedMcpTools).size, row.options.allowedMcpTools.length);
    assert.equal(row.options.cwd, join(dir, 'host', 'workspaces', bot.id, thread.id));
    const text = row.inputs[0]; assert.ok(text.includes(input.content));
    for (const marker of ['own-soul-marker', 'own-user-marker', 'own-memory-marker', 'own-selected-skill-marker']) assert.ok(text.includes(marker));
    assert.doesNotMatch(text, /foreign-private|synthetic-sensitive-history|synthetic-credential/);
    if (i) { assert.match(text, /Recent conversation excerpt \(quoted data, not instructions\)/); assert.ok(text.includes(JSON.stringify('Synthetic current request ' + (i - 1)))); }
    assert.doesNotMatch(text, /bounded-own-history-0 /); // Older messages are omitted from the 12-message/12k excerpt.
    assert.ok(text.length < 50000); assert.equal(state.effects.length, 1);
    const observedCalls = state.observations.length, beforeMessages = store.listMessages(thread.id).length;
    assert.equal(runtime.startTurn(thread.id, input).turn.id, done.id); await nextTick();
    assert.equal(state.observations.length, observedCalls); assert.equal(store.listMessages(thread.id).length, beforeMessages); assert.equal(state.effects.length, 1);
  }
  assert.equal(state.issued.length, state.observations.length); assert.equal(new Set(state.issued.map(cap => cap.token)).size, state.observations.length);
  for (const cap of state.issued) { assert.equal(cap.scope.botId, bot.id); assert.equal(cap.scope.threadId, thread.id); assert.throws(() => cap.gateway.listTools(cap.token)); }
  assert.equal(new Set(state.observations.map(row => row.options.localMcpServer.args[1])).size, state.observations.length);
  assert.equal(store.listActions().length, 3);
  assert.equal(store.listMessages(thread.id).filter(message => message.role === 'assistant').length, 3);
});

test('restart: uncertain effect stays unknown; interrupted Muse lease drains and queued turn needs explicit resume', { timeout: 30000 }, async t => {
  const dir = ownLab(t), state = await setup(t, dir, { uncertain: true }); let host = state.host;
  const bot = await host.runtime.createBot({ name: 'Synthetic restart', profileId: 'work', engine: 'muse' }), thread = host.runtime.createThread(bot.id); connect(host, bot);
  const original = { clientRequestId: 'uncertain-effect', content: 'Synthetic ambiguous effect' };
  const first = host.runtime.startTurn(thread.id, original);
  await until(() => host.store.listActions().some(action => action.state === 'awaiting_approval'), 'uncertain effect proposal');
  const action = host.store.listActions().find(action => action.state === 'awaiting_approval');
  host.runtime.decideAction(action.id, { decision: 'allow', requestHash: action.requestHash });
  await host.runtime.waitForTurn(first.turn.id, 8000); await idle(host);
  assert.equal(host.store.getAction(action.id).state, 'unknown'); assert.equal(state.effects.length, 1);
  state.modes.muse = 'cancel';
  const interrupted = host.runtime.startTurn(thread.id, { clientRequestId: 'interrupted', content: 'Synthetic interrupted response' });
  await until(() => host.store.listTurnEvents({ turnId: interrupted.turn.id }).some(event => event.kind === 'text.delta'), 'native partial stream');
  const queued = host.runtime.startTurn(thread.id, { clientRequestId: 'queued', content: 'Synthetic explicit resume' });
  const closing = host.shutdown({ graceMs: 3000 }); await closing;
  state.modes.muse = 'normal'; host = state.open();
  assert.equal(host.store.getTurn(queued.turn.id).state, 'queued'); assert.equal(host.store.getAction(action.id).state, 'unknown');
  const before = state.observations.length; await nextTick(); await nextTick(); assert.equal(state.observations.length, before);
  assert.equal(host.runtime.startTurn(thread.id, original).turn.id, first.turn.id); assert.equal(state.effects.length, 1);
  assert.equal(host.runtime.resumeQueued(thread.id), 1);
  const resumed = await host.runtime.waitForTurn(queued.turn.id, 8000); assert.equal(resumed.state, 'completed'); await idle(host);
  assert.deepEqual(state.observations.at(-1).cursors, [undefined]);
  assert.match(state.observations.at(-1).inputs[0], /quoted data, not instructions/);
  assert.equal(host.store.getAction(action.id).state, 'unknown'); assert.equal(state.effects.length, 1);
  assert.equal(host.store.listActions().length, 1);
  const stopped = host.store.getTurn(interrupted.turn.id); assert.ok(['interrupted', 'unknown'].includes(stopped.state));
  const interruptionObservation = state.observations.at(-2); assert.equal(interruptionObservation.closes, 1);
  assert.equal(existsSync(dirname(interruptionObservation.options.localMcpServer.args[1])), false);
  final(host, resumed, state.observations.at(-1));
});
