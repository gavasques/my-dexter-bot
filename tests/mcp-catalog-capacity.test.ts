import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { CompleteConnectionWorkflowSchema, type EngineId } from '@dexter/contracts';
import { BrowserUseKeyVault } from '@dexter/connectors';
import type { EngineDriver, EngineEvent, EngineSession } from '@dexter/engines';
import { GatewayError, GatewayMcpBridge, MCP_AUTHORIZED_INVENTORY_LIMIT, SyntheticCredentialBroker, estimateCatalogTokens,
  gatewayToolAlias, planCatalogExposure, type AdapterCall, type CapabilityScope, type GatewayCallResult, type ToolView, type TurnToolSurface } from '@dexter/gateway';
import { HostServices } from '../packages/cli/src/host-services.js';
import { CompositeTurnSurface } from '../packages/cli/src/turn-surface.js';
import { BrowserUseTurnSurface, BROWSER_USE_DESTINATION } from '../packages/cli/src/browser-use-surface.js';
import { AutomationTurnSurface } from '../packages/cli/src/automation-surface.js';
import { HarnessOperationSurface } from '../packages/cli/src/harness-operation-surface.js';
import { HostStore } from '@dexter/hub';

const inputSchema = { type: 'object', properties: {}, required: [], additionalProperties: false } as const;
const upstreamHost = 'capacity.example.test';
const manifest = (name: string) => ({ name, toolkit: 'capacity', upstreamSlug: name.replaceAll('.', '_').toUpperCase(), version: 'v1',
  description: `Read one synthetic entry ${name}`, upstreamHost, effect: 'read', destinationArgument: null, destinationOrigins: null,
  inputSchema: { ...inputSchema, required: [], properties: {} } });
interface SearchEntry { alias: string; title: string; account: string }
interface CatalogReceipt { actionId: string; status: string; result: unknown }
const engineBudgets: Record<EngineId, number> = { claude: 16_000, codex: 12_000, grok: 6_000, muse: 4_000, antigravity: 6_000 };

for (const engine of Object.keys(engineBudgets) as EngineId[]) test(`real HostServices ${engine}: 300 selected bindings retain a scoped deferred directory and unchanged budget`, { timeout: 45_000 }, async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `dx-capacity-${engine}-`)));
  const broker = new SyntheticCredentialBroker(); broker.put('capacity-ref', { headers: {}, allowedHosts: [upstreamHost] });
  let services: HostServices, opens = 0, failure: unknown;
  let accountId = '', deniedAlias = '', foreignAlias = '', lateAlias = '', deferredAlias = '', revokedAlias = '';
  const effects: Array<{ toolkit: string; slug: string; connectionId: string; account: string }> = [];
  const servicesOptions = { dataDir: dir, enableEngines: true, enableMcp: true, enableAgenda: true,
    upstream: { broker, adapter: { async execute(call: AdapterCall) { effects.push({ toolkit: call.toolkit, slug: call.upstreamSlug, connectionId: call.connectionId, account: call.upstreamAccountRef }); return { synthetic: true }; } } },
    makeDriver: (id: EngineId, options: Parameters<NonNullable<ConstructorParameters<typeof HostServices>[0]['makeDriver']>>[1]): EngineDriver => {
      const client = new Client({ name: 'synthetic-capacity-runtime', version: '1' });
      const search = async (query: string) => ((await client.callTool({ name: 'dx_catalog_search', arguments: { query, limit: 20 } })).structuredContent as { tools: SearchEntry[] }).tools;
      return { id, capabilities: { resume: true, interrupt: true, fork: false, steer: false },
        status: async () => ({ engine: id, installed: true, version: 'synthetic', authentication: 'authenticated', billing: 'subscription' }),
        async open(threadId): Promise<EngineSession> {
          opens++; assert(options.localMcpServer);
          await client.connect(new StdioClientTransport({ ...options.localMcpServer, args: [...options.localMcpServer.args], stderr: 'pipe' }));
          return { threadId, nativeCursor: randomUUID() };
        },
        async *turn(session, turnId): AsyncIterable<EngineEvent> {
          try {
            const listed = (await client.listTools()).tools;
            assert(listed.length <= 128, 'direct count stays at the existing lease limit');
            assert(estimateCatalogTokens(listed) <= engineBudgets[engine], 'same per-engine token budget');
            t.diagnostic(JSON.stringify({ engine, selectedBindings: 300, leaseOrdinal: opens, directDefinitions: listed.length,
              estimatedTokens: estimateCatalogTokens(listed), budget: engineBudgets[engine] }));
            for (const name of ['dexter.harness.guide', 'dexter.harness.configuration', 'dexter.harness.status']) {
              assert(listed.some(tool => tool.name === gatewayToolAlias({ name, connectionId: 'dexter-harness-owner-proposals' })), 'essential first-party recovery control stays direct');
            }
            assert.equal((await search('capacity.denied')).length, 0);
            assert.equal((await search('capacity.foreign')).length, 0);
            if (opens === 1) {
              const late = await search('capacity.late'); assert.equal(late.length, 0);
              const deferredName = Array.from({ length: 150 }, (_, i) => `capacity.read_${i.toString().padStart(3, '0')}`).find(name => !listed.some(tool => tool.name === gatewayToolAlias({ name, connectionId: accountId })))!;
              assert(deferredName, 'large inventory produces genuinely deferred bindings');
              deferredAlias = gatewayToolAlias({ name: deferredName, connectionId: accountId });
              assert((await search(deferredName)).some(tool => tool.alias === deferredAlias));
              const described = await client.callTool({ name: 'dx_catalog_describe', arguments: { alias: deferredAlias } });
              assert.equal(described.isError, false);
              assert.equal((described.structuredContent as { name: string }).name, deferredAlias);
              assert.deepEqual((described.structuredContent as { inputSchema: { properties: { input: unknown } } }).inputSchema.properties.input, inputSchema);
              const invalid = await client.callTool({ name: 'dx_catalog_call', arguments: { alias: deferredAlias, callId: 'invalid-schema', input: { unexpected: true } } });
              assert.equal(invalid.isError, true); assert.equal(effects.length, 0);
              const args = { alias: deferredAlias, callId: 'execute-once', input: {} };
              const first = await client.callTool({ name: 'dx_catalog_call', arguments: args });
              const replay = await client.callTool({ name: 'dx_catalog_call', arguments: args });
              assert.equal(first.isError, false); assert.equal(replay.isError, false);
              assert.equal((first.structuredContent as unknown as CatalogReceipt).status, 'succeeded');
              assert.equal((first.structuredContent as unknown as CatalogReceipt).actionId, (replay.structuredContent as unknown as CatalogReceipt).actionId);
              assert.equal(effects.length, 1); assert.deepEqual(effects[0], { toolkit: 'capacity', slug: deferredName.replaceAll('.', '_').toUpperCase(), connectionId: accountId, account: 'capacity_account_0' });
              services.store.setGrant({ botId: services.store.getTurn(turnId).botId, tool: 'capacity.late', destination: accountId, policy: 'allow' });
              assert.equal((await search('capacity.late')).length, 0, 'new grant does not enter this initial lease snapshot');
              for (const alias of [lateAlias, deniedAlias, foreignAlias]) await assert.rejects(client.callTool({ name: 'dx_catalog_call', arguments: { alias, callId: `forbidden-${alias}`, input: {} } }));
              revokedAlias = deferredAlias;
              services.store.setGrant({ botId: services.store.getTurn(turnId).botId, tool: deferredName, destination: accountId, policy: 'deny' });
              assert(!(await search(deferredName)).some(tool => tool.alias === revokedAlias), 'live revocation removes this account binding');
              await assert.rejects(client.callTool({ name: 'dx_catalog_call', arguments: { alias: revokedAlias, callId: 'revoked-new-call', input: {} } }));
              assert.equal((await client.callTool({ name: revokedAlias, arguments: { callId: 'revoked-cached-alias', input: {} } })).isError, true, 'a cached alias cannot authorize a new effect after revocation');
              assert.equal(effects.length, 1, 'negative probes create no second effect');
            } else {
              assert((await search('capacity.late')).some(tool => tool.alias === lateAlias), 'the next lease observes the authorized late grant');
              assert(!listed.some(tool => tool.name === revokedAlias));
            }
            yield { type: 'turn.completed', threadId: session.threadId, turnId, usage: null };
          } catch (error) { failure = error; throw error; }
        }, async close() { await client.close(); }, async interrupt() { await client.close(); }, async respondToTool() {},
      };
    },
  };
  services = new HostServices(servicesOptions);
  t.after(async () => { await services.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const bot = services.store.createBot({ name: 'Synthetic capacity', profileId: 'capacity', engine });
  const thread = services.store.createThread(bot.id);
  const gateway = services.gateway!;
  const tools = Array.from({ length: 150 }, (_, i) => gateway.registerTool(manifest(`capacity.read_${i.toString().padStart(3, '0')}`)));
  const accounts = [0, 1].map(i => gateway.connectAccount({ profileId: bot.profileId, toolkit: 'capacity', label: `Synthetic ${i}`, upstreamAccountRef: `capacity_account_${i}`, credentialRef: 'capacity-ref', allowedHosts: [upstreamHost] }));
  accountId = accounts[0]!.id;
  for (const account of accounts) for (const tool of tools) services.store.setGrant({ botId: bot.id, tool: tool.manifest.name, destination: account.id, policy: 'allow' });
  const request = { expectedHostID: services.store.hostId, clientRequestId: randomUUID(), expectedRevision: 1,
    selections: accounts.map(account => ({ connectionId: account.id, expectedRevision: account.revision, tools: tools.map(tool => ({ name: tool.manifest.name, manifestHash: tool.manifestHash })) })) };
  assert(CompleteConnectionWorkflowSchema.safeParse(request).success); assert(Buffer.byteLength(JSON.stringify(request)) < 65_536);
  gateway.registerTool(manifest('capacity.late')); lateAlias = gatewayToolAlias({ name: 'capacity.late', connectionId: accountId });
  gateway.registerTool(manifest('capacity.denied')); deniedAlias = gatewayToolAlias({ name: 'capacity.denied', connectionId: accountId });
  services.store.setGrant({ botId: bot.id, tool: 'capacity.denied', destination: accountId, policy: 'deny' });
  const foreignBot = services.store.createBot({ name: 'Synthetic foreign', profileId: 'foreign', engine });
  const foreignAccount = gateway.connectAccount({ profileId: foreignBot.profileId, toolkit: 'capacity', label: 'Synthetic foreign', upstreamAccountRef: 'foreign_account', credentialRef: 'capacity-ref', allowedHosts: [upstreamHost] });
  gateway.registerTool(manifest('capacity.foreign')); services.store.setGrant({ botId: foreignBot.id, tool: 'capacity.foreign', destination: foreignAccount.id, policy: 'allow' });
  foreignAlias = gatewayToolAlias({ name: 'capacity.foreign', connectionId: foreignAccount.id });
  for (const n of [1, 2]) {
    const turn = services.runtime!.startTurn(thread.id, { clientRequestId: randomUUID(), content: `Synthetic bounded capacity turn ${n}` }).turn;
    assert.equal((await services.runtime!.waitForTurn(turn.id, 30_000)).state, 'completed', String(failure));
  }
  assert(opens >= 2, 'both explicit turns opened; the canonical tool receipt may also schedule its normal generic continuation');
  assert.equal(effects.length, 1); assert.equal(services.store.listActions().length, 1);
});

const scope: CapabilityScope = { installationId: 'host_capacity', ownerId: 'owner_capacity', profileId: 'profile_capacity', botId: 'bot_capacity', threadId: 'thread_capacity', turnId: 'turn_capacity', expiresAt: 1_000_000 };
class SyntheticInventory implements TurnToolSurface {
  readonly tokens = new Set<string>(); calls = 0;
  constructor(readonly count: number, private readonly issuedScope = scope) {}
  issueCapability() { const token = randomBytes(32).toString('base64url'); this.tokens.add(token); return { token, scope: this.issuedScope }; }
  listTools(token: string): ToolView[] {
    if (!this.tokens.has(token)) throw new GatewayError('unauthorized', 'Expired synthetic capability');
    return Array.from({ length: this.count }, (_, i) => ({ name: `capacity.t${i}`, connectionId: 'capacity-account', connectionLabel: 'Synthetic capacity', description: 'Synthetic', effect: 'read', requiresApproval: false, inputSchema: { ...inputSchema, required: [], properties: {} } }));
  }
  async call(): Promise<GatewayCallResult> { this.calls++; throw new Error('No effect authorized by this limit probe'); }
  revokeCapability(token: string) { this.tokens.delete(token); }
}
const isCode = (code: string) => (error: unknown) => error instanceof GatewayError && error.code === code;

test('eligible inventory limit is separate from direct exposure and capability count; exact overflow fails closed', async () => {
  assert.equal(MCP_AUTHORIZED_INVENTORY_LIMIT, 2_048);
  const atLimit = new SyntheticInventory(MCP_AUTHORIZED_INVENTORY_LIMIT), allowed = new CompositeTurnSurface(atLimit);
  const cap = allowed.issueCapability({ turnId: scope.turnId });
  const views = allowed.listTools(cap.token); assert.equal(views.length, MCP_AUTHORIZED_INVENTORY_LIMIT);
  const planned = planCatalogExposure(views, { maxTools: 128, tokenBudget: 4_000 });
  assert(planned.direct.length + 3 <= 128); assert(planned.estimatedTokens <= 4_000); assert.equal(planned.direct.length + planned.deferred.length, views.length);
  allowed.revokeCapability(cap.token); assert.equal(atLimit.tokens.size, 0);
  const overLimit = new SyntheticInventory(MCP_AUTHORIZED_INVENTORY_LIMIT + 1), refused = new CompositeTurnSurface(overLimit);
  assert.throws(() => refused.issueCapability({ turnId: scope.turnId }), isCode('unavailable')); assert.equal(overLimit.tokens.size, 0);
  await assert.rejects(refused.call('A'.repeat(43), { connectionId: 'capacity-account' }), isCode('unauthorized')); assert.equal(overLimit.calls, 0);
  const plannerCap = overLimit.issueCapability();
  assert.throws(() => planCatalogExposure(overLimit.listTools(plannerCap.token)), /inventory limit/); overLimit.revokeCapability(plannerCap.token);
  const issued = overLimit.issueCapability();
  assert.throws(() => new GatewayMcpBridge({ gateway: overLimit, capability: issued.token, input: new PassThrough(), output: new PassThrough() }), /catalog limit/);
  assert.equal(overLimit.calls, 0); overLimit.revokeCapability(issued.token);
  assert.throws(() => new CompositeTurnSurface(atLimit, undefined, { maxCapabilities: 1025 }), isCode('invalid_input'));
  assert.throws(() => new CompositeTurnSurface(atLimit, undefined, { maxCatalogTools: MCP_AUTHORIZED_INVENTORY_LIMIT + 1 }), isCode('invalid_input'));
  await allowed.close(); await refused.close();
});

test('trusted smaller Composite inventory ceiling remains enforced without truncation', async () => {
  const base = new SyntheticInventory(300), limits = { maxCatalogTools: 299 }, composite = new CompositeTurnSurface(base, undefined, limits);
  limits.maxCatalogTools = MCP_AUTHORIZED_INVENTORY_LIMIT;
  assert.throws(() => composite.issueCapability({ turnId: scope.turnId }), isCode('unavailable')); assert.equal(base.tokens.size, 0); assert.equal(base.calls, 0);
  const permitted = new CompositeTurnSurface(base, undefined, { maxCatalogTools: 300, maxCapabilities: 1 });
  const cap = permitted.issueCapability({ turnId: scope.turnId }); assert.equal(permitted.listTools(cap.token).length, 300);
  assert.throws(() => permitted.issueCapability({ turnId: scope.turnId }), isCode('unavailable')); assert.equal(base.tokens.size, 1);
  permitted.revokeCapability(cap.token); await composite.close(); await permitted.close();
});

test('decorators count actual eligible first-party definitions and revoke child admission on full-inventory overflow', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dx-capacity-guard-'))), store = new HostStore({ dataDir: dir });
  const bot = store.createBot({ name: 'Synthetic inventory boundary', profileId: 'capacity', engine: 'claude' }), thread = store.createThread(bot.id);
  const turn = store.createTurn(thread.id, { clientRequestId: randomUUID(), content: 'Synthetic inventory boundary' }).turn;
  store.claimNextTurn(thread.id);
  const issuedScope: CapabilityScope = { installationId: store.hostId, ownerId: store.ownerId, profileId: bot.profileId, botId: bot.id,
    threadId: thread.id, turnId: turn.id, expiresAt: store.now() + 60_000 };
  const surfaces: Array<{ close(): Promise<void> }> = [];
  t.after(async () => { for (const surface of surfaces) await surface.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.setGrant({ botId: bot.id, tool: 'dexter.browseruse.configure', destination: BROWSER_USE_DESTINATION, policy: 'deny' });
  for (const [count, succeeds] of [[MCP_AUTHORIZED_INVENTORY_LIMIT - 2, true], [MCP_AUTHORIZED_INVENTORY_LIMIT - 1, false]] as const) {
    const base = new SyntheticInventory(count, issuedScope), browser = new BrowserUseTurnSurface({ store, base, vault: new BrowserUseKeyVault() }); surfaces.push(browser);
    if (succeeds) { const cap = browser.issueCapability({ turnId: turn.id }); assert.equal(browser.listTools(cap.token).length, MCP_AUTHORIZED_INVENTORY_LIMIT); browser.revokeCapability(cap.token); }
    else assert.throws(() => browser.issueCapability({ turnId: turn.id }), isCode('unavailable'));
    assert.equal(base.tokens.size, 0); assert.equal(base.calls, 0);
  }
  const agendaBase = new SyntheticInventory(MCP_AUTHORIZED_INVENTORY_LIMIT, issuedScope), agenda = new AutomationTurnSurface({ store, base: agendaBase, port: () => undefined }); surfaces.push(agenda);
  const agendaCap = agenda.issueCapability({ turnId: turn.id }); assert.equal(agenda.listTools(agendaCap.token).length, MCP_AUTHORIZED_INVENTORY_LIMIT); agenda.revokeCapability(agendaCap.token);
  const makeHarness = (count: number) => { const base = new SyntheticInventory(count, issuedScope), harness = new HarnessOperationSurface({ store, base,
    catalog: async () => [], runtime: () => { throw new Error('Unused synthetic runtime'); }, skills: () => { throw new Error('Unused synthetic skills'); }, effectiveSkills: () => [] }); surfaces.push(harness); return { base, harness }; };
  const empty = makeHarness(0), emptyCap = empty.harness.issueCapability({ turnId: turn.id }), ownCount = empty.harness.listTools(emptyCap.token).length;
  assert(ownCount > 0); empty.harness.revokeCapability(emptyCap.token);
  for (const [count, succeeds] of [[MCP_AUTHORIZED_INVENTORY_LIMIT - ownCount, true], [MCP_AUTHORIZED_INVENTORY_LIMIT - ownCount + 1, false]] as const) {
    const { base, harness } = makeHarness(count);
    if (succeeds) { const cap = harness.issueCapability({ turnId: turn.id }); assert.equal(harness.listTools(cap.token).length, MCP_AUTHORIZED_INVENTORY_LIMIT); harness.revokeCapability(cap.token); }
    else assert.throws(() => harness.issueCapability({ turnId: turn.id }), isCode('unavailable'));
    assert.equal(base.tokens.size, 0); assert.equal(base.calls, 0);
  }
});
