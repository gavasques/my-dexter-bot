import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { EngineId } from '@dexter/contracts';
import type { EngineDriver } from '@dexter/engines';
import { SyntheticCredentialBroker, gatewayToolAlias, projectMcpOutcome } from '@dexter/gateway';
import { buildHarnessGuideTurnInstructions, HARNESS_GUIDE_MAX_INSTRUCTION_CHARACTERS, readHarnessGuideTopic, readAppConfigurationGuidePage } from '@dexter/context';
import { HostServices } from '../packages/cli/src/host-services.js';

const engines: EngineId[] = ['claude', 'codex', 'grok', 'muse', 'antigravity'];
const memory = { origin: 'http://127.0.0.1:1', labLoopbackWithoutAuth: true, fetch: async () => { throw new Error('unexpected fixture IO'); } };
const status = (id: EngineId) => ({ engine: id, installed: true, version: 'synthetic', authentication: 'authenticated' as const, billing: 'subscription' as const });

for (const engine of engines) test(`R3-08 real HostServices/WorkspaceDriver/SDK ${engine} preserves textual resources and links`, { timeout: 30000 }, async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dx-r3-text-resource-')));
  const broker = new SyntheticCredentialBroker(); broker.put('fixture-ref', { headers: {}, allowedHosts: ['fixture.example.test'] });
  const result = { content: [
    { type: 'resource', resource: { uri: 'fixture://report', mimeType: 'text/plain', text: 'TEXT_RESOURCE_CANARY_Á' } },
    { type: 'resource_link', uri: 'https://fixture.example.test/report', name: 'Report', mimeType: 'text/plain' },
  ] };
  let effects = 0, observed = false, failure: unknown, connectionId = '';
  const services = new HostServices({ dataDir: dir, enableEngines: true, enableMcp: true,
    upstream: { broker, adapter: { async execute() { effects++; return structuredClone(result); } } },
    makeDriver(id, options): EngineDriver {
      const client = new Client({ name: 'r3-text-resource-fixture', version: '1' });
      return { id, capabilities: { resume: true, interrupt: true, fork: false, steer: false }, status: async () => status(id),
        async open(threadId) { assert(options.localMcpServer); await client.connect(new StdioClientTransport({ ...options.localMcpServer, args: [...options.localMcpServer.args], stderr: 'pipe' })); return { threadId, nativeCursor: randomUUID() }; },
        async *turn(session, turnId) {
          try {
            if (!observed) {
              const alias = gatewayToolAlias({ name: 'fixture.resources', connectionId });
              const response = await client.callTool({ name: 'dx_catalog_call', arguments: { alias, callId: 'same-read', input: {} } });
              const replay = await client.callTool({ name: 'dx_catalog_call', arguments: { alias, callId: 'same-read', input: {} } });
              assert.equal(response.isError, false); assert(JSON.stringify(response.content).includes('TEXT_RESOURCE_CANARY_Á'));
              assert(JSON.stringify(response.content).includes('https://fixture.example.test/report'));
              assert(!JSON.stringify(response).includes('driver_not_multimodal')); assert(!JSON.stringify(response).includes('mcp_result_budget'));
              const receipt = response.structuredContent as { actionId: string; status: string };
              assert.equal(receipt.status, 'succeeded'); assert.equal((replay.structuredContent as { actionId: string }).actionId, receipt.actionId);
              assert.deepEqual(services.store.getAction(receipt.actionId).result, result, 'canonical receipt remains original');
              assert.equal(effects, 1); observed = true;
            }
            yield { type: 'turn.completed', threadId: session.threadId, turnId, usage: null };
          } catch (error) { failure = error; throw error; }
        }, async respondToTool() {}, async interrupt() { await client.close(); }, async close() { await client.close(); },
      };
    },
  });
  t.after(async () => { await services.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const bot = services.store.createBot({ name: 'Synthetic resources', profileId: 'resources', engine });
  const tool = services.gateway!.registerTool({ name: 'fixture.resources', toolkit: 'fixture', upstreamSlug: 'RESOURCES', version: '1', description: 'Read synthetic resources', upstreamHost: 'fixture.example.test', effect: 'read', destinationArgument: null, destinationOrigins: null,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } });
  const account = services.gateway!.connectAccount({ profileId: bot.profileId, toolkit: 'fixture', label: 'Synthetic', upstreamAccountRef: 'synthetic', credentialRef: 'fixture-ref', allowedHosts: ['fixture.example.test'] });
  connectionId = account.id; services.store.setGrant({ botId: bot.id, tool: tool.manifest.name, destination: account.id, policy: 'allow' });
  const thread = services.store.createThread(bot.id), turn = services.runtime!.startTurn(thread.id, { clientRequestId: randomUUID(), content: 'Synthetic resource read' }).turn;
  assert.equal((await services.runtime!.waitForTurn(turn.id, 25000)).state, 'completed', String(failure)); assert(observed); assert.equal(effects, 1);
});

test('R3-08 text overflow remains bounded with same artifact/receipt and unsupported blob never leaks into preview', async () => {
  const original = { actionId: 'act_fixture', requestHash: 'a'.repeat(64), status: 'succeeded' as const, reason: null, result: { content: [
    { type: 'resource', resource: { text: 'TEXT_OVERFLOW_'.repeat(5000), mimeType: 'text/plain', uri: 'fixture://large' } },
    { type: 'resource', resource: { blob: 'BINARY_CANARY_'.repeat(5000) } },
  ] } };
  const before = JSON.stringify(original); let sinkCalls = 0;
  const projected = await projectMcpOutcome(original, { maxBytes: 4096, maxTokens: 1000, maxBlocks: 4, multimodal: false }, async input => { sinkCalls++; assert.deepEqual(input.content, original.result); return { artifactId: 'fixture_artifact' }; });
  assert.equal(sinkCalls, 1); assert.equal(JSON.stringify(original), before); assert.equal(projected.structuredContent.actionId, original.actionId);
  assert(Buffer.byteLength(JSON.stringify(projected)) <= 4096); assert(!JSON.stringify(projected).includes('BINARY_CANARY'));
  assert(JSON.stringify(projected).includes('fixture_artifact')); assert(JSON.stringify(projected).includes('TEXT_OVERFLOW'));
});

test('R3-15 real HostServices preserves all16 owner skills at32768 with separately bounded dependency advisory', { timeout: 30000 }, async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dx-r3-skill-boundary-'))); let captured = '', opens = 0;
  const services = new HostServices({ dataDir: dir, enableEngines: true, enableMcp: true, context: { memory, ownerExclusiveDeployment: true },
    makeDriver(id): EngineDriver { return { id, capabilities: { resume: true, interrupt: true, fork: false, steer: false }, status: async () => status(id),
      async open(threadId) { opens++; return { threadId, nativeCursor: randomUUID() }; },
      async *turn(session, turnId, input) { captured = input; yield { type: 'turn.completed', threadId: session.threadId, turnId, usage: null }; }, async respondToTool() {}, async interrupt() {}, async close() {}, }; },
  });
  t.after(async () => { await services.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const bot = services.store.createBot({ name: 'Synthetic skills', profileId: 'skills', engine: 'claude' }), thread = services.store.createThread(bot.id);
  const dependencyNames = Array.from({ length: 16 }, (_, n) => `mcp.fixture.${n.toString().padStart(2,'0')}.${'x'.repeat(50)}`);
  const bodies = Array.from({ length: 16 }, (_, n) => `---\ndexter_dependencies: ${JSON.stringify({ version: 1, requires_tools: dependencyNames })}\n---\nOWNER_SKILL_${n.toString().padStart(2,'0')}\n`);
  const wrapped = (body: string, n: number) => `BEGIN OWNER-SELECTED SKILL skill_${n.toString().padStart(2,'0')}@1.0.0 sha256=${'a'.repeat(64)}\n${body}\nEND OWNER-SELECTED SKILL skill_${n.toString().padStart(2,'0')}@1.0.0`;
  const initialLength = bodies.map(wrapped).join('\n\n').length;
  assert(initialLength < 32768); bodies[15] += 'x'.repeat(32768-initialLength);
  assert.equal(bodies.map(wrapped).join('\n\n').length, 32768);
  const pins = bodies.map((body, n) => services.context!.registerSkill(`skill_${n.toString().padStart(2,'0')}`, '1.0.0', body));
  for (const pin of pins) services.context!.activateSkill({ kind: 'global' }, pin);
  const turn = services.runtime!.startTurn(thread.id, { clientRequestId: randomUUID(), content: 'Synthetic skill boundary' }).turn;
  assert.equal((await services.runtime!.waitForTurn(turn.id,25000)).state, 'completed'); assert.equal(opens,1);
  for (let n = 0; n < 16; n++) assert(captured.includes(`OWNER_SKILL_${n.toString().padStart(2,'0')}`));
  const ownerBlock = captured.slice(captured.indexOf('BEGIN OWNER-SELECTED SKILL skill_00'), captured.indexOf('\nEND OWNER-SELECTED SKILLS'));
  assert.equal(ownerBlock.length,32768);
  const advisory = captured.slice(captured.indexOf('HOST SKILL DEPENDENCIES'), captured.indexOf('\n\nUSER TASK:'));
  assert(advisory.length <= 4096); assert(advisory.includes('omitted_budget')); assert(advisory.includes('guidance_only')); assert(!advisory.includes('"eligible":true'));
  assert(captured.indexOf('HOST SKILL DEPENDENCIES') > captured.indexOf('END OWNER-SELECTED SKILLS'));
  assert.equal(services.context!.status().activeCapabilities,0);
  const extra = services.context!.registerSkill('extra', '1.0.0', '# Extra'); services.context!.activateSkill({kind:'global'},extra);
  const rejected = services.runtime!.startTurn(thread.id, {clientRequestId:randomUUID(),content:'Exceeds16 owner skills'}).turn;
  assert.equal((await services.runtime!.waitForTurn(rejected.id,25000)).state,'failed'); assert.equal(opens,1,'existing16 limit still rejects before native open');
});

test('R3-13/14 progressive rules retain installation boundaries and conditional managed readiness', () => {
  const mcp = readHarnessGuideTopic('mcp').markdown;
  for (const phrase of ['scripts de instalação', 'configuração global do Codex/Claude', 'mova um servidor entre Mac/cloud', 'alternativas silenciosas', 'mcp-registration', 'mcp-authentication', 'bot-settings-mcp', 'Quando o serviço gerenciado do Dexter estiver configurado', 'unconfigured']) assert(mcp.includes(phrase),phrase);
  const setup = readAppConfigurationGuidePage('connection-setup');
  assert(setup.scope.includes('fora de delegação')); assert(setup.notes.join('\n').includes('irmãs tardias'));
  for (const [page, id] of [['connections','connections.inspector.technical'],['mcp-private-input','mcp.private-input.<inputId>.original']]) {
    const field = readAppConfigurationGuidePage(page!).fields.find(field=>field.id===id); assert(field,id);
    for (const key of ['purpose','scope','read','change','approval','result','recovery','availability'] as const) assert(field[key]);
    assert.equal(field.changeOperation,null);
  }
});

test('R3-13 maximum accepted guide state leaves at least256 instruction characters spare', () => {
  const units='\ud800'.repeat(161)+'"'.repeat(2)+'a'.repeat(157);
  const instructions = buildHarnessGuideTurnInstructions({ botId:'b'.repeat(128),threadId:'t'.repeat(128),turnId:'u'.repeat(128),
    selection:{engine:units.slice(0,64),model:units.slice(64,192),reasoningEffort:units.slice(192,256),speed:units.slice(256,320)},botFlags:{canSeeBots:false,canReceiveOrders:false,canSendActions:false,isMaster:false},
    features:{mcpToolsEnabled:false,harnessAdminToolsEnabled:false,nativeMcpConfigured:false,botDelegationEnabled:false,deviceToolsEnabled:false,externalMemoryConfigured:false} });
  assert(HARNESS_GUIDE_MAX_INSTRUCTION_CHARACTERS-instructions.length >=256, `${instructions.length}/${HARNESS_GUIDE_MAX_INSTRUCTION_CHARACTERS}`);
});
