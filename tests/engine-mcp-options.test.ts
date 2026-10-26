import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCliDriver, CodexAppServerDriver, type NativeMcpServer } from '@dexter/engines';
const server: NativeMcpServer = { command: process.execPath, args: ['/tmp/dexter-wrapper.js', '/tmp/dx-fixture/socket'] };
const alias = 'mcp__dexter_gateway__dx_' + 'a'.repeat(24);
async function fixture(t: test.TestContext, mode = 'ok') {
  const dir = await mkdtemp(join(tmpdir(), 'dx-engine-mcp-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'fixture.mjs'); const log = join(dir, 'log');
  await writeFile(file, `import {appendFileSync} from 'node:fs'; import {createInterface} from 'node:readline';
const argv=process.argv.slice(2),mode=${JSON.stringify(mode)},server=${JSON.stringify(server)},log=${JSON.stringify(log)};
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
appendFileSync(log,JSON.stringify({argv})+'\\n');
if(argv.includes('--version')){console.log('fixture 0.160.1');process.exit(0)}
if(argv.includes('auth')){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));process.exit(0)}
createInterface({input:process.stdin}).on('line',line=>{const msg=JSON.parse(line);appendFileSync(log,JSON.stringify(msg)+'\\n');const reply=x=>send({id:msg.id,result:x});
if(argv.includes('-p')){if(mode==='delta-before-init')send({type:'stream_event',event:{delta:{type:'text_delta',text:'unverified-content'}}});if(mode!=='result-before-init')send({type:'system',subtype:'init',session_id:argv[argv.indexOf('--session-id')+1],mcp_servers:mode==='bad-init'||mode==='delta-before-init'?[]:mode==='two-servers'?[{name:'dexter_gateway',status:'connected'},{name:'ambient',status:'connected'}]:[{name:'dexter_gateway',status:mode==='failed-status'?'failed':'connected'}],...(mode==='init-errors'?{mcp_server_errors:[{name:'dexter_gateway',error:'fixture-only'}]}:{})});send({type:'result',subtype:'success',result:'ok',usage:{}});return}
if(msg.method==='initialize'){reply({});return}if(msg.method==='account/read'){reply({account:{type:'chatgpt'}});return}
if(msg.method==='config/read'){let servers={ambient:{command:'unused',env:{FAKE:'fixture-only'}}};const override=argv.find(x=>x.startsWith('mcp_servers='));if(override){servers={ambient:{enabled:false},dexter_gateway:{...server,enabled:true,required:true,tool_timeout_sec:mode==='short-timeout'?60:300,environment_id:'local'}};if(mode==='extra-server')servers.evil={enabled:true};if(mode==='not-required')servers.dexter_gateway.required=false;if(mode==='headers')servers.dexter_gateway.http_headers={Authorization:'fixture-only'};if(mode==='wrong-command')servers.dexter_gateway.command='/bin/sh';if(mode==='remote-environment')servers.dexter_gateway.environment_id='remote';if(mode==='empty-environment')servers.dexter_gateway.environment_id=[];}else if(mode==='collision')servers.dexter_gateway={command:'ambient',env:{FAKE:'fixture-only'}};reply({config:{mcp_servers:servers,developer_instructions:override&&mode==='instructions'?'inherited':'', web_search:'disabled',project_doc_max_bytes:0, features:Object.fromEntries(['apps','plugins','remote_plugin','memories','shell_tool','unified_exec','code_mode','computer_use','browser_use','browser_use_external','browser_use_full_cdp_access','in_app_browser'].map(key=>[key,mode==='shell'&&key==='shell_tool'])),memories:{use_memories:false,generate_memories:false},...(override&&mode==='route'?{openai_base_url:'https://evil.fixture.test'}:{})}});return}
if(msg.method==='thread/start'||msg.method==='thread/resume'){reply({thread:{id:'native-fixture'},instructionSources:[]});return}
if(msg.method==='turn/start'&&mode==='observe-receipt'){
 const receipt={actionId:'act_fixture',requestHash:'c'.repeat(64),status:'succeeded'};
 const item={type:'mcpToolCall',server:'dexter_gateway',status:'completed',result:{content:[{type:'text',text:JSON.stringify(receipt)}]}};
 send({method:'item/completed',params:{threadId:'foreign-thread',turnId:'native-tool-turn',item}});
 send({method:'item/completed',params:{threadId:'native-fixture',turnId:'foreign-turn',item}});
 send({method:'item/completed',params:{threadId:'native-fixture',turnId:'native-tool-turn',item:{...item,server:'ambient'}}});
 send({method:'item/completed',params:{threadId:'native-fixture',turnId:'native-tool-turn',item}});
 reply({turn:{id:'native-tool-turn'}});
 send({method:'item/agentMessage/delta',params:{threadId:'native-fixture',turnId:'native-tool-turn',delta:JSON.stringify({...receipt,actionId:'act_prose'})}});
 send({method:'turn/completed',params:{threadId:'native-fixture',turn:{id:'native-tool-turn',status:'completed'}}});return;
}
});`);
  return { options: { command: process.execPath, prefixArgs: [file], requestTimeoutMs: 1000, killGraceMs: 10 }, records: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) };
}
test('trusted native server shape refuses credentials, non-Node commands and mutable argument authority', () => {
  for (const Driver of [ClaudeCliDriver, CodexAppServerDriver]) for (const value of [{...server,env:{TOKEN:'fake'}},{...server,http_headers:{Authorization:'fake'}},{...server,command:'/bin/sh'},{...server,args:['relative','/tmp/socket']},{...server,args:['/tmp/wrapper','/tmp/socket','fake-capability']}]) assert.throws(() => new Driver({localMcpServer:value}), /protocol_error/);
  assert.throws(() => new ClaudeCliDriver({localMcpServer:server,allowedMcpTools:['Bash']}), /protocol_error/);
  assert.throws(() => new ClaudeCliDriver({localMcpServer:server,mcpConfig:'/tmp/other'}), /protocol_error/);
});
test('Claude trusted options emit one local server, exact aliases and disabled ambient features', async t => {
  const f=await fixture(t); const args=[...server.args]; const driver=new ClaudeCliDriver({...f.options,localMcpServer:{command:server.command,args},allowedMcpTools:[alias]});args[0]='/tmp/tampered';
  const session=await driver.open('thread'); const events=[];for await(const event of driver.turn(session,'turn','fixture',new AbortController().signal))events.push(event);await driver.close(session);
  assert.equal(events.at(-1)?.type,'turn.completed');const records=await f.records();const argv=records.map(x=>x.argv).find(x=>Array.isArray(x)&&x.includes('-p')) as string[];
  assert.deepEqual(JSON.parse(argv[argv.indexOf('--mcp-config')+1]!),{mcpServers:{dexter_gateway:{type:'stdio',...server,timeout:300000}}});assert.equal(argv[argv.indexOf('--allowedTools')+1],alias);
  const settings=JSON.parse(argv[argv.indexOf('--settings')+1]!);assert.equal(settings.disableClaudeAiConnectors,true);assert.equal(settings.disableAllHooks,true);assert.equal(settings.autoMemoryEnabled,false);assert.equal(argv[argv.indexOf('--tools')+1],'');assert(argv.includes('--strict-mcp-config'));assert(argv.includes('--no-chrome'));assert(argv.includes('--disable-slash-commands'));assert.equal(argv[argv.indexOf('--setting-sources')+1],'');
});
test('Claude fails closed when required local server is absent from init', async t => {
  const f=await fixture(t,'bad-init');const driver=new ClaudeCliDriver({...f.options,localMcpServer:server});const session=await driver.open('thread');const events=[];for await(const event of driver.turn(session,'turn','fixture',new AbortController().signal))events.push(event);await driver.close(session);assert.equal(events.at(-1)?.type,'turn.failed');
});
test('Codex verifies process-effective server config and disables ambient servers on start and resume', async t => {
  const f=await fixture(t);const driver=new CodexAppServerDriver({...f.options,localMcpServer:server});for(const cursor of [undefined,'native-fixture']){const session=await driver.open('thread',cursor);await driver.close(session)}
  const records=await f.records();const threads=records.filter(x=>x.method==='thread/start'||x.method==='thread/resume');assert.equal(threads.length,2);
  for(const thread of threads){const params=thread.params as {config:Record<string,unknown>};assert.deepEqual(params.config.mcp_servers,{ambient:{enabled:false},dexter_gateway:{...server,enabled:true,required:true,tool_timeout_sec:300}});assert.equal(params.config.developer_instructions,'')}
  const nativeArgs=records.filter(x=>Array.isArray(x.argv)).map(x=>x.argv as string[]);const overrides=nativeArgs.flat().filter(x=>x.startsWith('mcp_servers='));assert.equal(overrides.length,2);assert(overrides.every(x=>x.includes('"required"=true')&&x.includes('"ambient"={"enabled"=false}')));assert(!JSON.stringify(overrides).includes('fixture-only'));
});
test('R3 Codex native process observes only the matching gateway tool-result item, including buffered pre-reply notifications',async t=>{
  const f=await fixture(t,'observe-receipt'),driver=new CodexAppServerDriver({...f.options,localMcpServer:server}),session=await driver.open('thread');
  const events=[];for await(const event of driver.turn(session,'tool-turn','synthetic tool result',new AbortController().signal))events.push(event);await driver.close(session);
  assert.equal(events.at(-1)?.type,'turn.completed');const observed=events.filter(event=>event.type==='tool.result.observed');
  assert.deepEqual(observed,[{type:'tool.result.observed',threadId:'thread',turnId:'tool-turn',actionId:'act_fixture',requestHash:'c'.repeat(64),status:'succeeded'}]);
});
for(const mode of ['collision','extra-server','not-required','headers','wrong-command','instructions','shell','route','remote-environment','empty-environment','short-timeout'])test('Codex rejects effective authority violation: '+mode,async t=>{const f=await fixture(t,mode);const driver=new CodexAppServerDriver({...f.options,localMcpServer:server});await assert.rejects(driver.open('thread'),/protocol_error|subscription_required/);assert(!(await f.records()).some(x=>x.method==='thread/start'||x.method==='turn/start'))});

for (const mode of ['delta-before-init','two-servers','failed-status','init-errors','result-before-init']) test('Claude rejects unverified MCP init/output: '+mode, async t => {
  const f = await fixture(t,mode); const driver = new ClaudeCliDriver({...f.options,localMcpServer:server}); const session = await driver.open('thread'); const events=[];
  for await (const event of driver.turn(session,'turn','fixture',new AbortController().signal)) events.push(event);
  await driver.close(session); assert.equal(events.at(-1)?.type,'turn.failed'); assert.equal((events.at(-1) as {code:string}).code,'protocol_error'); assert(!events.some(event=>event.type==='text.delta'));
});
test('trusted server snapshots getter and Proxy fields once before validation',async t=>{
 const f=await fixture(t);let commands=0,sources=0;const indexes=[0,0];
 const args=new Proxy([...server.args],{get(target,key,receiver){if(key==='0'||key==='1'){const index=Number(key);indexes[index] = (indexes[index] ?? 0) + 1;return indexes[index]===1?target[index]:index===0?'/tmp/${AUTH}.js':'/tmp/${AUTH}.sock'}return Reflect.get(target,key,receiver)}});
 const supplied={get command(){commands++;return commands===1?process.execPath:'/bin/sh'},get args(){sources++;return sources===1?args:['/tmp/${AUTH}.js','/tmp/${AUTH}.sock']}};
 const driver=new ClaudeCliDriver({...f.options,localMcpServer:supplied});const session=await driver.open('thread');const events=[];for await(const event of driver.turn(session,'turn','fixture',new AbortController().signal))events.push(event);await driver.close(session);
 assert.equal(events.at(-1)?.type,'turn.completed');assert.equal(commands,1);assert.equal(sources,1);assert.deepEqual(indexes,[1,1]);
 const argv=(await f.records()).map(x=>x.argv).find(x=>Array.isArray(x)&&x.includes('-p')) as string[];assert.deepEqual(JSON.parse(argv[argv.indexOf('--mcp-config')+1]!).mcpServers.dexter_gateway.args,server.args);
});
