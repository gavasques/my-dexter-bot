import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostApp } from '../packages/hub/dist/http.js';
import { HostStore } from '../packages/hub/dist/index.js';
import { ContextHost, MemoryRoutineRunner, MemoryRoutineSurface } from '../packages/context/dist/index.js';
import { HostServices } from '../packages/cli/dist/host-services.js';
import { HarnessOperationSurface, HARNESS_OPERATION_DESTINATION } from '../packages/cli/dist/harness-operation-surface.js';

const forbidden = error => error?.code === 'forbidden';
function fixture(t, search) {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'dexter-memory-audience-')));
  const store = new HostStore({ dataDir });
  const hits = [];
  const context = new ContextHost(store, { implementation: 'fixture', targetVersion: '2.5.2', search: search ?? (async () => hits) });
  const bot = store.createBot({ name: 'Synthetic A', profileId: 'synthetic', engine: 'claude' });
  const other = store.createBot({ name: 'Synthetic B', profileId: 'synthetic-b', engine: 'claude' });
  const team = name => context.createTeamWorkspace({ expectedHostID: store.hostId, clientRequestId: randomUUID(),
    name, botIds: [bot.id], coordinatorBotId: bot.id, rules: `RULE_${name}`, memory: `CORE_${name}` });
  const x = team('X'), y = team('Y');
  const thread = (team = null) => {
    const value = store.createThread(bot.id);
    if (team) context.bindTeamThread(team.id, value.id, team.revision, randomUUID());
    return value;
  };
  const running = (team = null) => {
    const value = thread(team), turn = store.createTurn(value.id, { clientRequestId: 'input', content: 'synthetic' }).turn;
    store.claimNextTurn(value.id);
    return { thread: value, turn, token: context.issue(turn.id) };
  };
  const page = (scope, markdown) => {
    const value = context.createMemory({ scope, markdown, locale: 'pt-BR', classification: 'context', origin: 'synthetic' });
    hits.push(value.service); return value;
  };
  t.after(() => { context.close(); store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { store, context, bot, other, x, y, running, thread, page, hits };
}

test('private recall excludes both teams despite membership and an overbroad adapter', async t => {
  const f = fixture(t), { bot, other, x, y, page, context } = f;
  const global = page({ kind: 'global' }, 'OWNER_SHARED');
  const own = page({ kind: 'bot', botId: bot.id }, 'PRIVATE_A');
  page({ kind: 'bot', botId: other.id }, 'PRIVATE_B');
  const secret = page({ kind: 'confidential', botId: bot.id }, 'EXPLICIT_COMPARTMENT');
  page({ kind: 'team', teamId: x.id }, 'TEAM_X'); page({ kind: 'team', teamId: y.id }, 'TEAM_Y');
  const { token } = f.running();
  assert.equal(context.memoryServiceAuthority(token).audience, 'private');
  assert.equal(context.memoryServiceAuthority(token).privateRecallAllowed, true);
  assert.deepEqual((await context.recall(token, { query: 'memória', locale: 'pt-BR' })).map(p => p.id), [global.id, own.id]);
  assert.deepEqual((await context.recall(token, { query: 'memória', locale: 'pt-BR', includeConfidential: true })).map(p => p.id), [global.id, own.id, secret.id]);
  const skill = context.registerSkill('procedure', '1.0.0', 'PRIVATE_PROCEDURE');
  const teamSkill = context.registerSkill('team-procedure', '1.0.0', 'TEAM_PROCEDURE');
  context.activateSkill({ kind: 'bot', botId: bot.id }, skill);
  context.activateSkill({ kind: 'team', teamId: x.id }, teamSkill);
  assert.deepEqual(context.skills(token).map(s => s.id), ['procedure']);
});

test('team recall/skills exclude owner-global, private documents, artifacts and other teams', async t => {
  const f = fixture(t), { context, bot, x, y, page } = f;
  page({ kind: 'global' }, 'OWNER_SHARED'); page({ kind: 'bot', botId: bot.id }, 'PRIVATE');
  page({ kind: 'confidential', botId: bot.id }, 'CONFIDENTIAL');
  const allowed = page({ kind: 'team', teamId: x.id }, 'TEAM_X'); page({ kind: 'team', teamId: y.id }, 'TEAM_Y');
  const privateTurn = f.running(), artifact = context.createArtifact(privateTurn.token, 'PRIVATE_ARTIFACT', 'synthetic');
  for (const [name, scope] of [['global', { kind: 'global' }], ['private', { kind: 'bot', botId: bot.id }],
    ['x', { kind: 'team', teamId: x.id }], ['y', { kind: 'team', teamId: y.id }]]) {
    context.activateSkill(scope, context.registerSkill(`skill-${name}`, '1.0.0', `SKILL_${name}`));
  }
  const shared = f.running(x);
  assert.equal(context.memoryServiceAuthority(shared.token).audience, 'team');
  assert.equal(context.memoryServiceAuthority(shared.token).privateRecallAllowed, false);
  assert.deepEqual((await context.recall(shared.token, { query: 'memória', locale: 'pt-BR', includeConfidential: true })).map(p => p.id), [allowed.id]);
  assert.deepEqual(context.skills(shared.token).map(s => s.id), ['skill-x']);
  assert.throws(() => context.botDocuments(shared.token), forbidden);
  assert.throws(() => context.artifact(shared.token, artifact.id), forbidden);
  assert.throws(() => context.createArtifact(shared.token, 'new', 'synthetic'), forbidden);
});

test('a revoked team result is rejected after the asynchronous search', async t => {
  const deferred = Promise.withResolvers();
  const f = fixture(t, async () => deferred.promise), active = f.running(f.x);
  const page = f.page({ kind: 'team', teamId: f.x.id }, 'SHARED_RESULT');
  const pending = f.context.recall(active.token, { query: 'memória', locale: 'pt-BR' });
  f.context.setMember(f.x.id, f.store.ownerId, false);
  f.context.setMember(f.x.id, f.store.ownerId, true);
  deferred.resolve([page.service]);
  await assert.rejects(pending, forbidden);
});

test('binding cannot implicitly publish existing private conversation history', t => {
  const f = fixture(t), privateTurn = f.running();
  f.store.finishTurn(privateTurn.turn.id, 'completed', null);
  assert.throws(() => f.context.bindTeamThread(f.x.id, privateTurn.thread.id, f.x.revision, randomUUID()), forbidden);
  assert.equal(f.context.teamForThread(privateTurn.thread.id), null);
});

test('team capabilities cannot recover private documents/history through harness or routine tools', async t => {
  const f = fixture(t), active = f.running(f.x), { store, context, bot } = f;
  context.compareAndSetBotDocuments(bot.id, { expectedRevision: 0, soul: 'PRIVATE_SOUL', user: 'PRIVATE_USER', memory: 'PRIVATE_MEMORY' });
  const token = randomBytes(32).toString('base64url');
  const scope = { turnId: active.turn.id, threadId: active.thread.id, botId: bot.id, profileId: bot.profileId,
    installationId: store.hostId, ownerId: store.ownerId, expiresAt: store.now() + 60_000 };
  const base = { issueCapability: () => ({ token, scope }), listTools: () => [], call: async () => { throw Error('unexpected base call'); }, revokeCapability() {} };
  const surface = new HarnessOperationSurface({ store, base, catalog: {}, runtime: () => {}, effectiveSkills: () => [],
    documents: () => ({ read: id => context.readBotDocuments(id) }), privateMemoryTurn: id => context.isPrivateMemoryTurn(id) });
  const routines = new MemoryRoutineSurface(store, surface, context.memoryRoutines, new MemoryRoutineRunner(context.memoryRoutines));
  routines.issueCapability({ turnId: active.turn.id });
  const names = routines.listTools(token).map(t => t.name);
  assert.ok(!names.some(name => /documents\.|memory\.(?:history|read_revision|receipt|append|restore)/.test(name)));
  assert.ok(!names.some(name => name.startsWith('dexter.memory.')));
  await assert.rejects(surface.call(token, { tool: 'dexter.harness.documents.read', connectionId: HARNESS_OPERATION_DESTINATION, callId: 'read', arguments: {} }), forbidden);
  await assert.rejects(routines.call(token, { tool: 'dexter.memory.jobs.list', connectionId: 'dexter-memory-routines', callId: 'read', arguments: {} }), forbidden);
  store.setGrant({ botId: bot.id, tool: 'dexter.harness.documents.update', destination: HARNESS_OPERATION_DESTINATION, policy: 'ask' });
  const legacy = store.requestAction({ botId: bot.id, threadId: active.thread.id, tool: 'dexter.harness.documents.update',
    destination: HARNESS_OPERATION_DESTINATION, idempotencyKey: 'old-team-doc-action', arguments: { input: { document: 'MEMORY', markdown: 'PRIVATE_LEGACY_ACTION' } } });
  await assert.rejects(surface.call(token, { tool: 'dexter.harness.actions.read', connectionId: HARNESS_OPERATION_DESTINATION,
    callId: 'legacy-action', arguments: { action_id: legacy.id } }), forbidden);
  routines.revokeCapability(token);
});

test('HostServices composes team public context only and opens fresh team sessions', { timeout: 10_000 }, async t => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'dexter-team-composer-')));
  const inputs = [], opens = [];
  const services = new HostServices({ dataDir, enableEngines: true, makeDriver: engine => ({ id: engine,
    capabilities: { resume: true, interrupt: true, fork: false, steer: false }, status: async () => ({ engine, state: 'ready' }),
    async open(threadId, cursor) { opens.push({ threadId, cursor }); return { threadId, nativeCursor: 'synthetic-previous-cursor' }; },
    async *turn(session, turnId, input) { inputs.push({ threadId: session.threadId, input });
      yield { type: 'text.delta', threadId: session.threadId, turnId, text: 'synthetic response' };
      yield { type: 'turn.completed', threadId: session.threadId, turnId, usage: {} }; },
    respondToTool: async () => {}, interrupt: async () => {}, close: async () => {} }) });
  t.after(async () => { await services.shutdown(); rmSync(dataDir, { recursive: true, force: true }); });
  const bot = services.store.createBot({ name: 'Public bot', profileId: 'synthetic', engine: 'claude' });
  services.store.patchBot(bot.id, { expectedRevision: bot.revision, roleDescription: 'PUBLIC_ROLE' });
  services.context.compareAndSetBotDocuments(bot.id, { expectedRevision: 0, soul: 'PRIVATE_SOUL', user: 'PRIVATE_USER', memory: 'PRIVATE_MEMORY' });
  const team = services.teamsHttp.create({ expectedHostID: services.store.hostId, clientRequestId: randomUUID(), name: 'X', botIds: [bot.id],
    coordinatorBotId: bot.id, rules: 'PUBLIC_TEAM_RULES', memory: 'PUBLIC_TEAM_MEMORY' });
  const privateThread = services.store.createThread(bot.id), sharedThread = services.store.createThread(bot.id);
  services.teamsHttp.bindThread(team.id, sharedThread.id, team.revision, randomUUID());
  const run = async (thread, request) => {
    const { turn } = services.runtime.startTurn(thread.id, { clientRequestId: request, content: 'Synthetic task' });
    assert.equal((await services.runtime.waitForTurn(turn.id, 5000)).state, 'completed');
  };
  await run(privateThread, 'private'); await run(sharedThread, 'shared'); await run(sharedThread, 'shared-next');
  assert.ok(inputs[0].input.includes('PRIVATE_USER'));
  for (const value of inputs.slice(1)) {
    assert.ok(value.input.includes('PUBLIC_ROLE') && value.input.includes('PUBLIC_TEAM_MEMORY'));
    assert.ok(!value.input.includes('PRIVATE_SOUL') && !value.input.includes('PRIVATE_USER') && !value.input.includes('PRIVATE_MEMORY'));
  }
  assert.ok(opens.filter(o => o.threadId === sharedThread.id).every(o => o.cursor === undefined));
  assert.equal(services.context.memoryRoutines.beginCapture(services.store.listTurns(sharedThread.id).at(-1).id), null);
});

test('Live Voice team context omits private documents while private context retains them', async t => {
  const f = fixture(t), privateThread = f.thread(), sharedThread = f.thread(f.x);
  f.context.compareAndSetBotDocuments(f.bot.id, { expectedRevision: 0, soul: 'PRIVATE_SOUL', user: 'PRIVATE_USER', memory: 'PRIVATE_MEMORY' });
  const voice = f.store.getLiveVoiceSettings();
  f.store.patchLiveVoiceSettings({ expectedHostID: f.store.hostId, expectedRevision: voice.revision, enabled: true, defaultVoice: voice.defaultVoice });
  const app = createHostApp(f.store, { botDocuments: { read: id => f.context.readBotDocuments(id) }, teams: {
    threadTeam: id => f.context.teamForThread(id) } });
  const read = async thread => { const r = await app.request(`http://127.0.0.1/v1/threads/${thread.id}/voice/context`); assert.equal(r.status, 200); return r.json(); };
  assert.equal((await read(privateThread)).documents.user, 'PRIVATE_USER');
  const shared = await read(sharedThread);
  assert.equal(shared.documents, undefined); assert.ok(!JSON.stringify(shared).includes('PRIVATE_'));
});
