import { mcpDirectoryClient } from './fixtures/mcp-directory-client.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [{ HostServices }, { AutomationTurnSurface, AUTOMATION_DESTINATION }] = await Promise.all([
  import(pathToFileURL(resolve('packages/cli/dist/host-services.js')).href),
  import(pathToFileURL(resolve('packages/cli/dist/automation-surface.js')).href),
]);
// Synthetic stores/drivers only: no CLI inference, remote endpoint, credential or personal account is used.
const refused = error => ['invalid_input', 'forbidden', 'conflict', 'unauthorized', 'unavailable'].includes(error.code);
const synthetic = (id, onTurn, onClose) => ({ id, capabilities: { resume: true, interrupt: true, fork: false, steer: false },
  status: async () => ({ engine: id, installed: true, authentication: 'unverified', billing: 'unknown' }),
  open: async threadId => ({ threadId, nativeCursor: 'synthetic-only' }),
  async *turn(session, turnId) { await onTurn?.(session, turnId); yield { type: 'turn.completed', threadId: session.threadId, turnId, usage: {} }; },
  respondToTool: async () => {}, interrupt: async () => {}, close: async () => { await onClose?.(); },
});
function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dexter-automations-harness-'))); chmodSync(root, 0o700);
  let turns = 0;
  const services = new HostServices({ dataDir: root, enableEngines: true, enableMcp: true, enableAgenda: true,
    makeDriver(engine, settings) { return synthetic(engine, async (session, turnId) => { turns++; await options.onTurn?.({ session, turnId, nativeMcpServer: settings.localMcpServer, services }); }, options.onClose); },
  });
  const surfaces = [], liveTurns = [];
  const bot = name => services.store.createBot({ name, profileId: 'synthetic-only', engine: 'codex' });
  const surface = (overrides = {}) => {
    const value = new AutomationTurnSurface({ store: services.store, base: services.gateway, port: () => services.automationsHttp, ...overrides }); surfaces.push(value); return value;
  };
  const live = (actor, thread = services.store.createThread(actor.id), tools = surface()) => {
    const { turn } = services.store.createTurn(thread.id, { clientRequestId: randomUUID(), content: 'Synthetic automation setup' });
    assert.equal(services.store.claimNextTurn(thread.id).id, turn.id); liveTurns.push(turn);
    return { thread, turn, surface: tools, token: tools.issueCapability({ turnId: turn.id }).token };
  };
  const call = (actor, name, callId, args = {}) => actor.surface.call(actor.token, { connectionId: AUTOMATION_DESTINATION, tool: 'dexter.automations.' + name, callId, arguments: args });
  const approve = async (actor, name, id, args) => {
    const pending = await call(actor, name, id, args); assert.equal(pending.status, 'awaiting_approval');
    services.store.decideAction(pending.actionId, { requestHash: pending.requestHash, decision: 'allow' }); return call(actor, name, id, args);
  };
  const createOwner = (actor, thread, title = 'Owner fixture') => services.automationsHttp.create({ hostId: services.store.hostId, clientRequestId: randomUUID(), expectedRevision: 0,
    botId: actor.id, threadId: thread.id, title, content: 'Synthetic task', when: { kind: 'interval', everyMs: 60_000, firstAt: services.store.now() + 3_600_000 } }).schedule;
  t.after(async () => {
    for (const value of surfaces) await value.close();
    for (const turn of liveTurns) if (services.store.getTurn(turn.id).state === 'running') services.store.finishTurn(turn.id, 'completed', null);
    await services.shutdown({ graceMs: 3000 }); rmSync(root, { recursive: true, force: true });
  });
  return { root, services, surface, live, bot, call, approve, createOwner, get turns() { return turns; } };
}
const proposal = f => ({ title: 'Synthetic reminder', content: 'Summarize this synthetic conversation.', kind: 'interval', every_ms: 60_000, first_at: f.services.store.now() + 3_600_000 });

test('automation harness: owner exact deny/allow, durable create replay, CAS, pause and immediate-run receipt', async t => {
  const f = fixture(t), actor = f.bot('Scheduler'), live = f.live(actor), args = proposal(f);
  const views = live.surface.listTools(live.token).filter(tool => tool.connectionId === AUTOMATION_DESTINATION);
  assert.deepEqual(views.map(tool => tool.name), ['list', 'preview', 'create', 'update', 'state', 'run', 'history'].map(name => 'dexter.automations.' + name));
  assert.ok(views.every(tool => tool.effect === 'read' || tool.requiresApproval));
  const preview = await f.call(live, 'preview', 'preview', { kind: 'cron', cron: '0 9 * * 1-5', time_zone: 'America/Sao_Paulo', count: 3 });
  assert.equal(preview.result.dates.length, 3); assert.equal(f.services.automationsHttp.list({ hostId: f.services.store.hostId }).items.length, 0);
  const denied = await f.call(live, 'create', 'deny', args);
  assert.throws(() => f.services.store.decideAction(denied.actionId, { requestHash: '0'.repeat(64), decision: 'allow' }));
  f.services.store.decideAction(denied.actionId, { requestHash: denied.requestHash, decision: 'deny' });
  assert.equal((await f.call(live, 'create', 'deny', args)).status, 'denied');
  const created = await f.approve(live, 'create', 'create', args); assert.equal(created.status, 'succeeded');
  const row = created.result.schedule;
  assert.equal(row.botId, actor.id); assert.equal(row.threadId, live.thread.id); assert.equal(row.revision, 1);
  assert.equal((await f.call(live, 'create', 'create', args)).actionId, created.actionId);
  assert.equal(f.services.automationsHttp.list({ hostId: f.services.store.hostId }).items.length, 1);
  await assert.rejects(f.call(live, 'create', 'create', { ...args, title: 'Changed input' }), error => error.code === 'conflict');
  const edit = { schedule_id: row.id, expectedRevision: row.revision, ...args, title: 'Updated reminder' };
  const stale = await f.call(live, 'update', 'stale', edit);
  f.services.store.decideAction(stale.actionId, { requestHash: stale.requestHash, decision: 'allow' });
  const pausedOwner = f.services.automationsHttp.state(row.id, { hostId: f.services.store.hostId, clientRequestId: randomUUID(), expectedRevision: row.revision, state: 'disabled' }).schedule;
  assert.equal((await f.call(live, 'update', 'stale', edit)).status, 'blocked');
  assert.equal(f.services.automationsHttp.get(row.id).title, args.title);
  const resumed = await f.approve(live, 'state', 'resume', { schedule_id: row.id, expectedRevision: pausedOwner.revision, state: 'active' });
  assert.equal(resumed.status, 'succeeded'); assert.equal(resumed.result.toolPermissionsChanged, false);
  const ran = await f.approve(live, 'run', 'run-now', { schedule_id: row.id, expectedRevision: resumed.result.schedule.revision });
  assert.equal(ran.status, 'succeeded'); assert.equal(ran.result.executionConfirmed, false);
  assert.equal(ran.result.schedule.nextAt, row.nextAt); assert.equal((await f.call(live, 'run', 'run-now', { schedule_id: row.id, expectedRevision: resumed.result.schedule.revision })).actionId, ran.actionId);
  const history = await f.call(live, 'history', 'history', { schedule_id: row.id });
  assert.equal(history.result.items.length, 1); assert.ok(['prepared', 'accepted'].includes(history.result.items[0].state));
  const paused = await f.approve(live, 'state', 'pause', { schedule_id: row.id, expectedRevision: resumed.result.schedule.revision, state: 'disabled' });
  assert.equal(paused.status, 'succeeded'); assert.equal(paused.result.acceptedTurnsCancelled, false);
  assert.equal(paused.result.schedule.state, 'disabled'); assert.equal(f.turns, 0, 'manual current turn blocks another inference; run receipt is not an answer');
});

test('automation harness: same-owner bots, private conversations and team conversations stay separate, with own cursors only', async t => {
  const f = fixture(t), actor = f.bot('Master fixture'), other = f.bot('Other specialist');
  const privateThread = f.services.store.createThread(actor.id), otherPrivate = f.services.store.createThread(actor.id), otherThread = f.services.store.createThread(other.id);
  const own = f.createOwner(actor, privateThread, 'Own private task'), foreignPrivate = f.createOwner(actor, otherPrivate, 'Foreign private task'), foreignBot = f.createOwner(other, otherThread, 'Foreign bot task');
  const team = f.services.teamsHttp.create({ expectedHostID: f.services.store.hostId, clientRequestId: randomUUID(), name: 'Synthetic team', coordinatorBotId: actor.id, botIds: [actor.id, other.id] });
  const teamThread = f.services.store.createThread(actor.id, 'thr_team_' + randomUUID()), otherTeamThread = f.services.store.createThread(actor.id, 'thr_team_' + randomUUID());
  f.services.teamsHttp.bindThread(team.id, teamThread.id, team.revision, randomUUID()); f.services.teamsHttp.bindThread(team.id, otherTeamThread.id, team.revision, randomUUID());
  const ownTeam = f.createOwner(actor, teamThread, 'Own team task'), foreignTeam = f.createOwner(actor, otherTeamThread, 'Foreign team conversation');
  const live = f.live(actor, privateThread), teamLive = f.live(actor, teamThread);
  assert.deepEqual((await f.call(live, 'list', 'private-list')).result.items.map(item => item.id), [own.id]);
  assert.deepEqual((await f.call(teamLive, 'list', 'team-list')).result.items.map(item => item.id), [ownTeam.id]);
  const ownNext = f.createOwner(actor, privateThread, 'Second own task'), page = await f.call(live, 'list', 'page', { limit: 1 });
  assert.equal(page.result.items.length, 1); assert.ok(page.result.nextCursor);
  const next = await f.call(live, 'list', 'next-page', { limit: 1, after_created_at: page.result.nextCursor.createdAt, after_id: page.result.nextCursor.id });
  assert.equal(next.result.items.length, 1); assert.deepEqual(new Set([...page.result.items, ...next.result.items].map(item => item.id)), new Set([own.id, ownNext.id]));
  for (const target of [foreignPrivate, foreignBot, foreignTeam, ownTeam]) {
    await assert.rejects(f.call(live, 'history', 'foreign-' + target.id, { schedule_id: target.id }), refused);
    await assert.rejects(f.call(live, 'state', 'state-' + target.id, { schedule_id: target.id, expectedRevision: target.revision, state: 'disabled' }), refused);
    await assert.rejects(f.call(live, 'list', 'cursor-' + target.id, { after_created_at: target.createdAt, after_id: target.id }), refused);
  }
  await assert.rejects(f.call(live, 'create', 'injected-identity', { ...proposal(f), botId: other.id }), refused);
  await assert.rejects(f.call(live, 'create', 'secret', { ...proposal(f), content: 'api_key=synthetic_secret_not_a_real_key' }), refused);
  await assert.rejects(f.call(live, 'preview', 'extra-recurrence', { kind: 'once', at: own.nextAt, cron: '0 9 * * *' }), refused);
  for (const policy of ['deny', 'allow']) {
    f.services.store.setGrant({ botId: actor.id, tool: 'dexter.automations.create', destination: AUTOMATION_DESTINATION, policy });
    assert.ok(!live.surface.listTools(live.token).some(tool => tool.name === 'dexter.automations.create'));
    await assert.rejects(f.call(live, 'create', 'grant-' + policy, proposal(f)), refused);
    assert.equal(f.services.store.getGrant(actor.id, 'dexter.automations.create', AUTOMATION_DESTINATION).policy, policy);
  }
});

test('automation harness: effect before lost receipt stays unknown and same-call replay never creates another schedule', async t => {
  const f = fixture(t), actor = f.bot('Uncertain fixture'), original = f.services.automationsHttp; let creates = 0;
  const port = { ...original, create(input) { creates++; original.create(input); throw new Error('Synthetic receipt lost after commit.'); } };
  const tools = f.surface({ port: () => port }), live = f.live(actor, undefined, tools), args = proposal(f);
  const unknown = await f.approve(live, 'create', 'uncertain', args); assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.reason, 'executor_error'); assert.equal(creates, 1);
  assert.equal((await f.call(live, 'create', 'uncertain', args)).actionId, unknown.actionId); assert.equal(creates, 1);
  tools.revokeCapability(live.token);
  const fresh = f.surface(), replay = { ...live, surface: fresh, token: fresh.issueCapability({ turnId: live.turn.id }).token };
  assert.equal((await f.call(replay, 'create', 'uncertain', args)).status, 'unknown');
  assert.equal((await f.call(replay, 'list', 'reconcile')).result.items.length, 1);
  assert.equal(original.list({ hostId: f.services.store.hostId }).items.length, 1); assert.equal(f.turns, 0);
});

test('automation harness: revoked capabilities abort/drain borrowed tools without closing base; profile/turn changes invalidate scope', async t => {
  const f = fixture(t), actor = f.bot('Lifecycle fixture'); let release, received, aborted = false, baseRevoked = 0;
  const held = new Promise(done => { release = done; });
  const base = { issueCapability: input => f.services.gateway.issueCapability(input),
    listTools: token => [...f.services.gateway.listTools(token), { name: 'synthetic.echo', connectionId: 'synthetic-delegation', connectionLabel: 'Synthetic', description: 'Synthetic borrowed tool', effect: 'read', requiresApproval: false, inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
    async call(token, input, { signal }) { received = input; signal.addEventListener('abort', () => { aborted = true; release(); }, { once: true }); await held;
      return { actionId: 'synthetic', status: 'succeeded', requestHash: '0'.repeat(64), reason: null, result: null }; },
    revokeCapability(token) { baseRevoked++; f.services.gateway.revokeCapability(token); },
  };
  const tools = f.surface({ base }), live = f.live(actor, undefined, tools);
  const raw = { connectionId: 'synthetic-delegation', tool: 'synthetic.echo', callId: 'borrowed', arguments: {} }, call = tools.call(live.token, raw);
  tools.revokeCapability(live.token); await assert.rejects(call, refused); await tools.drain();
  assert.equal(received, raw); assert.equal(aborted, true); assert.equal(baseRevoked, 1);
  const active = f.live(actor), args = proposal(f), pending = await f.call(active, 'create', 'turn-ended', args);
  f.services.store.decideAction(pending.actionId, { requestHash: pending.requestHash, decision: 'allow' });
  f.services.store.finishTurn(active.turn.id, 'completed', null);
  await assert.rejects(f.call(active, 'create', 'turn-ended', args), refused);
  assert.equal(f.services.automationsHttp.list({ hostId: f.services.store.hostId }).items.length, 0);
  tools.stopAdmission(); await tools.close(); await tools.close();
  assert.throws(() => tools.issueCapability({ turnId: live.turn.id }), refused);
});

function socketRpc(path) {
  const socket = createConnection(path); let sequence = 0, buffer = ''; const pending = new Map();
  const ready = new Promise((done, reject) => { socket.once('connect', done); socket.once('error', reject); });
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 2_097_152) { socket.destroy(); return; }
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const waiting = pending.get(message.id);
      if (waiting) { pending.delete(message.id); clearTimeout(waiting.timer); message.error ? waiting.reject(new Error('Synthetic RPC refused.')) : waiting.done(message.result); }
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => { for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error('Synthetic RPC closed.')); } pending.clear(); });
  const rpc = async (method, params = {}) => {
    await ready; const id = ++sequence;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Synthetic RPC deadline.')); }, 5000);
      pending.set(id, { done, reject, timer }); socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  return { rpc, async initialize() { await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'SyntheticAutomations', version: '1' } }); socket.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); }, close: () => socket.destroy() };
}

test('automation harness: HostServices composed native turn receives the real scoped tools and uses canonical preview', async t => {
  const observed = []; let client;
  const f = fixture(t, { async onTurn({ nativeMcpServer }) {
    assert.ok(nativeMcpServer); client = socketRpc(nativeMcpServer.args[1]); await client.initialize();
    const directory = mcpDirectoryClient(client.rpc);
    for (const name of ['list','preview','create','update','state','run','history']) observed.push((await directory.find('dexter.automations.'+name)).title);
    const selected = await directory.find('dexter.automations.preview');
    const response = await directory.call(selected, 'native-preview', { kind: 'interval', every_ms: 60_000, first_at: 1, count: 2 });
    assert.equal(response.isError, false); const preview = response.structuredContent;
    assert.equal(preview.status, 'succeeded'); assert.equal(preview.result.dates.length, 2);
  }, onClose: () => client?.close() });
  const actor = f.bot('Integrated fixture'), thread = f.services.store.createThread(actor.id);
  const result = f.services.runtime.startTurn(thread.id, { clientRequestId: 'synthetic-composition', content: 'Only list and preview synthetic automations.' });
  await f.services.runtime.waitForTurn(result.turn.id);
  assert.equal(f.services.store.getTurn(result.turn.id).state, 'completed'); assert.equal(f.turns, 1);
  assert.ok(observed.some(title => title.startsWith('dexter.automations.create'))); assert.ok(observed.some(title => title.startsWith('dexter.automations.history')));
  assert.equal(f.services.automationsHttp.list({ hostId: f.services.store.hostId }).items.length, 0);
});
