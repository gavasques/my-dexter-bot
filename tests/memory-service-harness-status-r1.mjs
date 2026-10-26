import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { HostServices } from '../packages/cli/dist/host-services.js';
import { HARNESS_OPERATION_DESTINATION } from '../packages/cli/dist/harness-operation-surface.js';

function mcp(server) {
  const child = spawn(server.command, [...server.args], { stdio: 'pipe' });
  let sequence = 0, buffer = '';
  const replies = new Map();
  child.stderr.resume();
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => {
      for (const waiter of replies.values()) waiter.reject(Error('Synthetic MCP closed'));
      replies.clear(); resolve();
    });
  });
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), row = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      replies.get(row.id)?.resolve(row); replies.delete(row.id);
    }
  });
  return {
    notify(method) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); },
    rpc(method, params = {}) {
      const id = ++sequence;
      const reply = new Promise((resolve, reject) => replies.set(id, { resolve, reject }));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return reply;
    },
    async close() { child.stdin.end(); await exited; },
  };
}

test('MemoryService diagnostic and progressive manual are readable through the actual host MCP wrapper without custody or backend IO', { timeout: 15000 }, async t => {
  const root = realpathSync(mkdtempSync('/private/tmp/dexter-memory-status-r1-'));
  let custody = 0, network = 0, calls = 0, ownBot, failure;
  const services = new HostServices({
    dataDir: join(root, 'host'), enableMcp: true, enableEngines: true,
    engineCommands: { codex: '/usr/bin/false' },
    engineCatalog: () => [{ id: 'codex', available: true, defaultModel: 'synthetic', models: [{ id: 'synthetic', reasoningEfforts: [], speeds: [] }], reasoningEfforts: [], speeds: [] }],
    memoryService: { backend: { origin: 'http://127.0.0.1:1', credential: () => { custody++; throw Error('Unexpected custody'); }, fetch: async () => { network++; throw Error('Unexpected network'); } } },
    makeDriver(id, options) {
      return { id, capabilities: { resume: true, interrupt: true, fork: false, steer: false },
        status: async () => ({ engine: id, installed: true, authentication: 'unverified', billing: 'unknown' }),
        open: async threadId => ({ threadId, nativeCursor: 'synthetic-status' }),
        async *turn(session, turnId) {
          assert.ok(options.localMcpServer); calls++;
          const client = mcp(options.localMcpServer);
          const alias = name => `dx_${createHash('sha256').update(`dexter.harness.${name}\0${HARNESS_OPERATION_DESTINATION}`).digest('hex').slice(0, 24)}`;
          try {
            await client.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-memory-status', version: '1' } });
            client.notify('notifications/initialized');
            const listed = await client.rpc('tools/list');
            assert.ok(listed.result, JSON.stringify(listed));
            const tools = listed.result.tools;
            assert.ok(tools.some(tool => tool.name === alias('status')));
            const status = (await client.rpc('tools/call', { name: alias('status'), arguments: { callId: 'own-status', input: {} } })).result.structuredContent;
            assert.equal(status.status, 'succeeded'); assert.equal(status.result.bot.id, ownBot.id);
            assert.deepEqual(status.result.memoryService, services.memoryService.diagnostic());
            assert.equal(status.result.memoryService.state, 'configured_unverified');
            assert.equal(status.result.memoryService.semanticRecall, 'unproven');
            assert.equal(status.result.memoryService.automaticCapture, false);
            assert.equal(status.result.memoryService.teamRecall, 'not_implemented');
            const manual = (await client.rpc('tools/call', { name: alias('configuration'), arguments: { callId: 'memory-manual', input: { page: 'memory-service' } } })).result.structuredContent;
            assert.equal(manual.status, 'succeeded');
            assert.equal(manual.result.id, 'memory-service');
            assert.equal(manual.result.fields.length, 4);
            assert.equal(JSON.stringify(manual).includes('Unexpected custody'), false);
            const forged = await client.rpc('tools/call', { name: alias('status'), arguments: { callId: 'forged-status', input: { botId: 'foreign' } } });
            assert.ok(forged.error || forged.result.isError);
            assert.equal(custody, 0); assert.equal(network, 0);
          } catch (error) { failure = error; throw error; }
          finally { await client.close(); }
          yield { type: 'turn.completed', threadId: session.threadId, turnId, usage: {} };
        }, respondToTool: async () => {}, interrupt: async () => {}, close: async () => {} };
    },
  });
  t.after(async () => { await services.shutdown(); rmSync(root, { recursive: true, force: true }); });
  ownBot = services.store.createBot({ name: 'Synthetic diagnostic reader', profileId: 'synthetic', engine: 'codex' });
  services.store.createBot({ name: 'Synthetic foreign bot', profileId: 'foreign', engine: 'codex' });
  const thread = services.store.createThread(ownBot.id);
  const { turn } = services.runtime.startTurn(thread.id, { clientRequestId: 'status-turn', content: 'Synthetic host diagnostic' });
  await services.runtime.waitForTurn(turn.id);
  if (failure) throw failure;
  assert.equal(services.store.getTurn(turn.id).state, 'completed'); assert.equal(calls, 1);
  assert.equal(custody, 0); assert.equal(network, 0);
});
