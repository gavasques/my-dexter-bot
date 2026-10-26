import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client, type McpSubscription } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { EngineDriver, EngineEvent } from '@dexter/engines';
import { MCP_AUTHORIZED_INVENTORY_LIMIT, MCP_MODERN_VERSION, SyntheticCredentialBroker, estimateCatalogTokens, gatewayToolAlias, type ToolView } from '@dexter/gateway';
import { generateSyntheticIdentity } from '@dexter/devices';
import { HostServices } from '../packages/cli/src/host-services.js';
import { MemoryServiceTurnSurface } from '../packages/cli/src/memory-service-turn-surface.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const until = async (predicate: () => boolean, ms = 5000) => { const deadline = performance.now() + ms; while (!predicate()) { if (performance.now() >= deadline) throw Error('Synthetic catalog deadline'); await sleep(10); } };

test('R3-09 real composed operational ceiling: bounded metadata polling, deferred revocation, canonical replay and Stop', { timeout: 120_000 }, async t => {
  assert.equal(MCP_AUTHORIZED_INVENTORY_LIMIT, 2048);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dx-catalog-r3-')));
  const broker = new SyntheticCredentialBroker(); broker.put('synthetic-ref', { headers: {}, allowedHosts: ['perf.example.test'] });
  const clients = new Set<Client>(), subscriptions: McpSubscription[] = [];
  let views: ToolView[] = [], scans = 0, calibrating = true, firstParty = 0, effects = 0, completed = false;
  let failure: unknown, services: HostServices, currentTurn = '', measuredStart = 0, emissionMs = 0, notices = 0;
  let release = () => {};
  const originalList = MemoryServiceTurnSurface.prototype.listTools;
  MemoryServiceTurnSurface.prototype.listTools = function (token) { const result = originalList.call(this, token); views = result; scans++; return result; };
  const schema = { type: 'object', additionalProperties: false, required: [], properties: { text: { type: 'string', maxLength: 128 } } };
  services = new HostServices({ dataDir: join(dir, 'host'), enableEngines: true, enableMcp: true, enableDeviceTools: true,
    enableAgenda: true, enableBotDelegation: true, enableGroups: true, nativeMcp: { runsOn: 'owner_mac' },
    devices: { identity: generateSyntheticIdentity(join(dir, 'identity'), 'catalog'), pollWaitMs: 50, receiptTimeoutMs: 3000 },
    upstream: { broker, adapter: { async execute(call) { assert.equal(call.scope.botId, bot.id); assert.equal(call.scope.threadId, thread.id); assert.equal(call.scope.turnId, currentTurn); effects++; return { synthetic: true }; } } },
    makeDriver: (engine, options): EngineDriver => {
      const client = new Client({ name: 'synthetic-real-catalog-ceiling', version: '1' }, { capabilities: {}, versionNegotiation: { mode: { pin: MCP_MODERN_VERSION } } });
      return { id: engine, capabilities: { resume: true, interrupt: true, fork: false, steer: false },
        status: async () => ({ engine, installed: true, version: 'synthetic', authentication: 'authenticated', billing: 'subscription' }),
        async open(threadId) { assert(options.localMcpServer); assert(options.cwd?.startsWith(join(dir, 'host', 'workspaces')));
          if (!calibrating) emissionMs = performance.now() - measuredStart;
          clients.add(client); await client.connect(new StdioClientTransport({ ...options.localMcpServer, args: [...options.localMcpServer.args], stderr: 'pipe' }));
          return { threadId, nativeCursor: randomUUID() };
        },
        async *turn(session, turnId, _input, signal): AsyncIterable<EngineEvent> {
          if (calibrating) { await client.listTools(); firstParty = views.length; yield { type: 'turn.completed', threadId: session.threadId, turnId, usage: null }; return; }
          try {
            currentTurn = turnId;
            const latencies: number[] = [];
            let direct = new Set<string>();
            for (let i = 0; i < 3; i++) { const start = performance.now(), listed = (await client.listTools()).tools;
              latencies.push(performance.now() - start); assert(listed.length <= 128); assert(estimateCatalogTokens(listed) <= 16_000);
              direct = new Set(listed.map(tool => tool.name)); assert.equal(views.length, MCP_AUTHORIZED_INVENTORY_LIMIT);
            }
            const target = views.find(view => view.name.startsWith('perf.') && !direct.has(gatewayToolAlias(view)))!; assert(target);
            const alias = gatewayToolAlias(target), query = `${target.name} ${target.connectionLabel}`;
            const found = await client.callTool({ name: 'dx_catalog_search', arguments: { query, limit: 1 } });
            assert.equal((found.structuredContent as any).tools[0].alias, alias);
            const described = await client.callTool({ name: 'dx_catalog_describe', arguments: { alias } });
            assert.deepEqual((described.structuredContent as any).inputSchema.properties.input, schema);
            const request = { alias, callId: 'one-canonical-effect', input: { text: 'synthetic' } };
            const first = await client.callTool({ name: 'dx_catalog_call', arguments: request }), replay = await client.callTool({ name: 'dx_catalog_call', arguments: request });
            assert.equal(first.isError, false); assert.equal((first.structuredContent as any).actionId, (replay.structuredContent as any).actionId); assert.equal(effects, 1);
            client.setNotificationHandler('notifications/tools/list_changed', () => { notices++; });
            const before = scans;
            for (let i = 0; i < 8; i++) subscriptions.push(await client.listen({ toolsListChanged: true }));
            await sleep(2200);
            assert(scans - before <= 5, 'eight subscriptions share at most one current-inventory scan per second, not one each');
            await assert.rejects(client.callTool({ name: 'dx_catalog_call', arguments: { alias, callId: 'no-slot', input: { text: 'no slot' } } })); assert.equal(effects, 1);
            // This binding is DEFERRED. A direct-only fingerprint would miss its revocation entirely.
            const revokeAt = performance.now(); services.store.setGrant({ botId: bot.id, tool: target.name, destination: target.connectionId, policy: 'deny' });
            await until(() => notices >= 8); const revocationMs = performance.now() - revokeAt;
            await subscriptions[0]!.close(); await subscriptions[0]!.closed; await sleep(25);
            await assert.rejects(client.callTool({ name: 'dx_catalog_describe', arguments: { alias } }));
            const denied = await client.callTool({ name: alias, arguments: { callId: 'revoked-cached-alias', input: { text: 'after revoke' } } });
            assert.equal(denied.isError, true); assert.equal(effects, 1);
            const stopAt = performance.now(); services.runtime!.cancelTurn(turnId); completed = true;
            t.diagnostic(JSON.stringify({ rawInventory: MCP_AUTHORIZED_INVENTORY_LIMIT, firstParty, selectedBindings: MCP_AUTHORIZED_INVENTORY_LIMIT - firstParty,
              emissionMs, listMs: latencies, subscriptionScans: scans - before, revocationMs, stopDispatchMs: performance.now() - stopAt, effects }));
            if (!signal.aborted) await new Promise<void>(done => { release = done; signal.addEventListener('abort', () => done(), { once: true }); });
            yield { type: 'turn.interrupted', threadId: session.threadId, turnId };
          } catch (error) { failure = error; throw error; }
        }, async interrupt() { release(); await client.close(); }, async close() { await client.close(); }, async respondToTool() {},
      };
    },
  });
  t.after(async () => { release(); await Promise.allSettled(subscriptions.map(subscription => subscription.close())); await Promise.allSettled([...clients].map(client => client.close()));
    try { await services.shutdown({ graceMs: 10_000 }); } finally { MemoryServiceTurnSurface.prototype.listTools = originalList; rmSync(dir, { recursive: true, force: true }); }
  });
  const bot = services.store.createBot({ name: 'Synthetic bounded catalog', profileId: 'perf', engine: 'claude' });
  services.store.patchBot(bot.id, { expectedRevision: 0, isMaster: true, canSeeBots: true, canSendActions: true }); const thread = services.store.createThread(bot.id);
  const calibration = services.runtime!.startTurn(thread.id, { clientRequestId: randomUUID(), content: 'Synthetic first-party calibration' }).turn;
  assert.equal((await services.runtime!.waitForTurn(calibration.id)).state, 'completed'); assert(firstParty > 58, 'all optional decorator chains participate');
  const tools = Array.from({ length: 128 }, (_, i) => services.gateway!.registerTool({ name: `perf.tool_${String(i).padStart(4, '0')}`, toolkit: 'perf', upstreamSlug: `PERF_TOOL_${i}`,
    version: 'v1', description: 'Read one synthetic bounded entry. ' + 'metadata '.repeat(24), upstreamHost: 'perf.example.test', effect: 'read', destinationArgument: null, destinationOrigins: null, inputSchema: schema }));
  let remaining = MCP_AUTHORIZED_INVENTORY_LIMIT - firstParty, account = 0;
  while (remaining > 0) {
    const connection = services.gateway!.connectAccount({ profileId: bot.profileId, toolkit: 'perf', label: `Account${String(account++).padStart(3, '0')}`,
      upstreamAccountRef: `synthetic_account_${account}`, credentialRef: 'synthetic-ref', allowedHosts: ['perf.example.test'] });
    const selected = tools.slice(0, Math.min(remaining, tools.length));
    services.store.applyGrantBatch({ operationId: randomUUID(), grants: selected.map(tool => ({ botId: bot.id, tool: tool.manifest.name, destination: connection.id, expectedRevision: 0, policy: 'allow', expiresAt: null })) });
    remaining -= selected.length;
  }
  await sleep(20); calibrating = false; measuredStart = performance.now();
  const turn = services.runtime!.startTurn(thread.id, { clientRequestId: randomUUID(), content: 'Synthetic real composed catalog ceiling' }).turn;
  assert.equal((await services.runtime!.waitForTurn(turn.id, 90_000)).state, 'interrupted', String(failure)); assert(completed, String(failure));
  assert.equal(effects, 1); assert.equal(services.store.listActions().length, 1); assert.equal(services.store.listActions()[0]!.state, 'succeeded');
});
