import { mcpDirectoryClient } from './fixtures/mcp-directory-client.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { HostServices } from '../packages/cli/dist/host-services.js';
import { BROWSER_USE_DESTINATION } from '../packages/cli/dist/browser-use-surface.js';
import { BROWSER_USE_API } from '../packages/connectors/dist/index.js';
import { createHostApp } from '../packages/hub/dist/http.js';

// The executable only speaks the native Claude protocol. HostServices constructs the production
// BrowserUse -> optional Automation -> Harness -> memory surfaces, WorkspaceDriver, McpTurnLease
// and MCP stdio wrapper unchanged. All Browser Use HTTP responses and credential bytes are synthetic.
const KEY = 'synthetic-browser-same-turn-fixture';
const TASK = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const TASK_INPUT = { task: 'Complete ORIGINAL_BROWSER_TASK by reading the synthetic example page.', start_url: 'https://example.com/' };
const nativeFixture = String.raw`
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const args=process.argv.slice(2), flag=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
if(args.includes('--version')){console.log('synthetic 1.2.3');process.exit(0);}
if(args.includes('auth')){send({loggedIn:true,authMethod:'claude.ai'});process.exit(0);}
let source='';for await(const line of createInterface({input:process.stdin}))source+=line;
const input=JSON.parse(source).message.content;
const server=JSON.parse(flag('--mcp-config')).mcpServers.dexter_gateway;
const child=spawn(server.command,server.args,{env:{PATH:'/usr/bin:/bin'},stdio:['pipe','pipe','ignore']});
let sequence=0,buffer='';const pending=new Map();
child.stdout.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const n=buffer.indexOf('\n'),row=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);pending.get(row.id)?.(row);pending.delete(row.id);}});
const rpc=(method,params)=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'Browser-same-turn-synthetic',version:'1'}});
child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
const nativeSession=flag('--session-id')??flag('--resume');
send({type:'system',subtype:'init',session_id:nativeSession,mcp_servers:[{name:'dexter_gateway',status:'connected'}]});
const directory=(MCP_DIRECTORY_CLIENT_FACTORY)(rpc);
const catalog=(await rpc('tools/list',{})).result.tools;
const find=name=>directory.find(name);
const run=await find('dexter.browseruse.run'),configure=await find('dexter.browseruse.configure'),status=await find('dexter.browseruse.status');
assert.ok(run,'run must be discoverable before activation');
assert.ok(flag('--allowedTools').split(',').includes('mcp__dexter_gateway__'+(run.viaDirectory?'dx_catalog_call':run.name)),'the original native allowlist must include run');
const call=(tool,callId,input={})=>directory.call(tool,callId,input);
const observe=(toolUseId,result)=>send({type:'user',session_id:nativeSession,message:{role:'user',content:[{type:'tool_result',tool_use_id:toolUseId,content:result.content}]}});
const before=(await call(status,'before-status')).result.structuredContent.result;
assert.equal(before.runAvailable,false);
const task={task:'Complete ORIGINAL_BROWSER_TASK by reading the synthetic example page.',start_url:'https://example.com/'};
const beforeRun=(await call(run,'before-activation',task)).result;
assert.equal(beforeRun.isError,true);
const configurationResult=(await call(configure,'configure-once',{expectedRevision:before.revision,enabled:true,allowed_domains:['example.com'],max_steps:7,timeout_seconds:30,profile_id:''})).result;
observe('configuration-use',configurationResult);
const configured=configurationResult.structuredContent;
const after=(await call(status,'after-status')).result.structuredContent.result;
// Deliberately reuse the run object and native allowlist captured before configure. There is no
// new capability, process, turn, or user message after the configuration decision. All aliases
// resolve through the real directory before that decision; the same original run alias is used.
const executed=(await call(run,'run-once',task)).result;
observe('run-use',executed);
const replay=(await call(run,'run-once',task)).result;
const answer={nativeSession,originalTaskPresent:input.includes('ORIGINAL_BROWSER_TASK'),runAlias:run.name,
  nativeRunAllowed:true,hasAutomation:(directory.result(await rpc('tools/call',{name:'dx_catalog_search',arguments:{query:'dexter.automations.list'}})).structuredContent.tools.some(tool=>tool.title==='dexter.automations.list')),
  before,beforeRun,configured,after,executed,replay};
child.stdin.end();await new Promise(resolve=>child.once('close',resolve));
send({type:'result',subtype:'success',result:JSON.stringify(answer),usage:{}});
`;
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
async function until(predicate, timeout = 7000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= end) throw new Error('Browser same-turn bounded condition failed.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const catalog = () => [{ id: 'claude', available: true, models: [{ id: 'fixture-opus', reasoningEfforts: ['high'], speeds: [] }],
  defaultModel: 'fixture-opus', reasoningEfforts: ['high'], speeds: [] }];
async function fixture(t, { agenda, initialDeny = false }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dexter-browser-same-turn-')));
  const executable = join(root, 'synthetic-claude.mjs');
  writeFileSync(executable, `#!${process.execPath}\n${nativeFixture.replace('MCP_DIRECTORY_CLIENT_FACTORY',mcpDirectoryClient.toString())}`, { mode: 0o700 });
  const originalFetch = globalThis.fetch, observed = [];
  globalThis.fetch = async (url, init) => {
    assert.ok(typeof url === 'string' && url.startsWith(BROWSER_USE_API + '/'), 'only the fixed synthetic Browser Use API is intercepted');
    const entry = { path: url.slice(BROWSER_USE_API.length), method: init.method ?? 'GET',
      body: init.body === undefined ? null : JSON.parse(init.body), keyMatched: new Headers(init.headers).get('X-Browser-Use-API-Key') === KEY };
    observed.push(entry);
    if (entry.path === '/tasks' && entry.method === 'POST') return response({ id: TASK, sessionId: SESSION });
    if (entry.path === `/tasks/${TASK}/status`) return response({ id: TASK, status: 'finished', output: 'Synthetic same-turn result', isSuccess: true });
    if (entry.path === `/tasks/${TASK}` && entry.method === 'PATCH') return response({ id: TASK, status: 'stopped' });
    if (entry.path === `/sessions/${SESSION}`) return response({ id: SESSION, status: 'stopped' });
    throw new Error('Unexpected synthetic Browser Use route.');
  };
  let services, server;
  t.after(async () => {
    try {
      if (server) await new Promise(resolve => server.close(resolve));
      await services?.shutdown();
    } finally { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); }
  });
  services = new HostServices({ dataDir: join(root, 'host'), enableMcp: true, enableEngines: true,
    enableAgenda: agenda, engineCommands: { claude: executable }, engineCatalog: catalog });
  const bot = services.store.createBot({ name: 'Synthetic same-turn Browser', profileId: 'synthetic-only', engine: 'claude',
    defaultSelection: { engine: 'claude', model: 'fixture-opus', reasoningEffort: 'high', speed: null } });
  const thread = services.store.createThread(bot.id);
  services.browserUseKeyVault.set(KEY);
  services.store.patchBrowserUseSettings({ expectedHostID: services.store.hostId, expectedRevision: 0, enabled: true,
    bots: initialDeny ? { [bot.id]: { enabled: false, allowedDomains: [], maxSteps: 7, timeoutSeconds: 30, profileId: null } } : {} });
  assert.equal(services.store.getBrowserUseConfiguration().bots[bot.id]?.enabled ?? false, false);
  assert.equal(services.store.getGrant(bot.id, 'dexter.browseruse.run', BROWSER_USE_DESTINATION)?.policy ?? null, initialDeny ? 'deny' : null);
  const app = createHostApp(services.store, { runtime: services.runtime });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await until(() => server.listening);
  const decide = async (action, decision = 'allow') => {
    const reply = await originalFetch(`http://127.0.0.1:${server.address().port}/v1/actions/${action.id}/decisions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision, requestHash: action.requestHash }) });
    assert.equal(reply.status, 200); return reply.json();
  };
  return { services, bot, thread, observed, decide };
}
async function pending(f, turnId, tool) {
  return until(() => {
    const state = f.services.store.getTurn(turnId);
    assert.ok(!['failed', 'unknown'].includes(state.state), JSON.stringify({ state: state.state, code: state.code,
      events: f.services.store.listTurnEvents({ turnId }) }));
    return f.services.store.listActions('awaiting_approval').find(action => action.request.tool === tool);
  });
}

for (const [agenda, initialDeny] of [[false, false], [true, true]]) {
  test(`Browser Use native MCP: original run alias continues after exact configuration approval (agenda=${agenda}, initial deny=${initialDeny})`, { timeout: 20000 }, async t => {
    const f = await fixture(t, { agenda, initialDeny });
    const { turn } = f.services.runtime.startTurn(f.thread.id, { clientRequestId: 'same-turn-browser', content: 'ORIGINAL_BROWSER_TASK' });
    const configured = await pending(f, turn.id, 'dexter.browseruse.configure');
    assert.equal(f.services.store.getTurn(turn.id).state, 'running');
    assert.equal(f.services.store.listActions().length, 1, 'the disabled pre-activation run creates no action');
    assert.equal(f.observed.length, 0);
    await f.decide(configured);
    const run = await pending(f, turn.id, 'dexter.browseruse.run');
    assert.notEqual(run.id, configured.id, 'configuration and task have distinct exact Ask approvals');
    assert.equal(f.services.store.getAction(configured.id).state, 'succeeded');
    assert.equal(run.request.botId, f.bot.id); assert.equal(run.request.threadId, f.thread.id);
    assert.deepEqual(run.request.arguments.input, { task: TASK_INPUT.task, startUrl: TASK_INPUT.start_url });
    assert.equal(f.services.store.toolActionOrigin(run.id).turnId, turn.id);
    assert.equal(f.services.store.listTurns(f.thread.id).length, 1);
    assert.equal(f.observed.length, 0, 'approved activation never approves the task or submits a POST');
    await f.decide(run);
    assert.equal((await f.services.runtime.waitForTurn(turn.id, 7000)).state, 'completed');
    const answer = JSON.parse(f.services.store.turnOutput(turn.id));
    assert.ok(answer, JSON.stringify(f.services.store.listTurnEvents({ turnId: turn.id })));
    assert.equal(answer.originalTaskPresent, true); assert.equal(answer.nativeRunAllowed, true);
    assert.equal(answer.hasAutomation, agenda); assert.equal(answer.before.runAvailable, false);
    assert.equal(answer.beforeRun.isError, true); assert.equal(answer.configured.actionId, configured.id);
    assert.equal(answer.after.runAvailable, true); assert.equal(answer.after.authentication, 'unverified');
    assert.equal(answer.executed.structuredContent.actionId, run.id); assert.equal(answer.executed.structuredContent.status, 'succeeded');
    assert.deepEqual(answer.replay.structuredContent, answer.executed.structuredContent);
    assert.equal(f.services.store.toolActionOrigin(run.id).continuationTurnId, null);
    assert.equal(f.services.store.toolActionOrigin(run.id).delivered, true);
    assert.equal(f.services.store.toolActionProgress(run.id).consumedByEngine, true);
    assert.equal(f.services.store.listTurns(f.thread.id).length, 1);
    assert.equal(f.services.store.listMessages(f.thread.id).filter(message => message.role === 'user').length, 1);
    assert.equal(f.observed.filter(entry => entry.method === 'POST').length, 1);
    assert.ok(f.observed.every(entry => entry.keyMatched));
    assert.equal(f.observed.find(entry => entry.method === 'POST').body.task, TASK_INPUT.task);
    assert.equal(f.services.store.listActions().length, 2);
  });
}

test('Browser Use native MCP: denied configuration keeps the original visible run alias blocked without a task action or POST', { timeout: 20000 }, async t => {
  const f = await fixture(t, { agenda: true, initialDeny: true });
  const { turn } = f.services.runtime.startTurn(f.thread.id, { clientRequestId: 'same-turn-denied-config', content: 'ORIGINAL_BROWSER_TASK' });
  const configured = await pending(f, turn.id, 'dexter.browseruse.configure');
  await f.decide(configured, 'deny');
  assert.equal((await f.services.runtime.waitForTurn(turn.id, 7000)).state, 'completed');
  const answer = JSON.parse(f.services.store.turnOutput(turn.id));
  assert.ok(answer, JSON.stringify(f.services.store.listTurnEvents({ turnId: turn.id })));
  assert.equal(answer.configured.status, 'denied'); assert.equal(answer.after.runAvailable, false);
  assert.equal(answer.executed.isError, true); assert.equal(answer.replay.isError, true);
  assert.equal(f.services.store.listActions().length, 1); assert.equal(f.observed.length, 0);
  assert.equal(f.services.store.listTurns(f.thread.id).length, 1);
  assert.equal(f.services.store.listMessages(f.thread.id).filter(message => message.role === 'user').length, 1);
});
