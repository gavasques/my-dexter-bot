import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,existsSync,mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostServices} from '../packages/cli/dist/host-services.js';
import {HARNESS_OPERATION_DESTINATION} from '../packages/cli/dist/harness-operation-surface.js';

// Composed host (real runtime, Context teams, Groups, MCP turn leases) with a synthetic engine driver. The driver records
// the per-turn MCP allow-list and calls the host's own workspace facade for the running turn. Synthetic data only.
const catalog=()=>[{id:'claude',available:true,defaultModel:'synthetic-model',models:[{id:'synthetic-model',reasoningEfforts:[],speeds:[]}],reasoningEfforts:[],speeds:[]}];
const alias=name=>'dx_'+createHash('sha256').update(`${name}\u0000${HARNESS_OPERATION_DESTINATION}`).digest('hex').slice(0,24);
const FILE_TOOLS=['files.list','files.read','files.write','files.search','files.tree','terminal.status','terminal.run','cli.run'].map(name=>alias('dexter.harness.'+name));
const exposed=list=>FILE_TOOLS.filter(a=>list.some(tool=>tool.endsWith('__'+a))).length;
const attempt=fn=>{try{return {ok:fn()};}catch(error){return {code:error?.code??'thrown'};}};

function fixture(t){
  const data=realpathSync(mkdtempSync(join(tmpdir(),'dx-outputs-composed-')));chmodSync(data,0o700);
  const seen=new Map(),nativeAllowed=new Map();let onTurn=null;
  const driver=(id,options)=>({id,sessionReuse:'turn',capabilities:{resume:true,interrupt:true,fork:false,steer:false},
    status:async()=>({engine:id,installed:true,authentication:'unverified',billing:'unknown'}),open:async threadId=>{const client=new Client({name:'synthetic-output-catalog',version:'1'});await client.connect(new StdioClientTransport({command:options.localMcpServer.command,args:[...options.localMcpServer.args],env:{PATH:'/usr/bin:/bin'},stderr:'pipe'}));return {threadId,nativeCursor:'synthetic',client};},
    async *turn(session,turnId){nativeAllowed.set(turnId,[...(options?.allowedMcpTools??[])]);const available=[];for(const name of ['files.list','files.read','files.write','files.search','files.tree','terminal.status','terminal.run','cli.run']){const canonical='dexter.harness.'+name,result=await session.client.callTool({name:'dx_catalog_search',arguments:{query:canonical,limit:20}});assert.equal(result.isError,false);for(const tool of result.structuredContent.tools)if(tool.title===canonical&&tool.alias===alias(canonical))available.push('mcp__dexter_gateway__'+tool.alias);}seen.set(turnId,available);if(onTurn)await onTurn(turnId);yield {type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},
    respondToTool:async()=>{},interrupt:async session=>session.client?.close(),close:async session=>session.client?.close()});
  const services=new HostServices({dataDir:data,enableEngines:true,enableMcp:true,enableBotDelegation:true,engineCommands:{claude:'/usr/bin/false'},engineCatalog:catalog,makeDriver:driver});
  t.after(async()=>{await services.shutdown();rmSync(data,{recursive:true,force:true});});
  const run=async(threadId,hook)=>{onTurn=hook;const {turn}=services.runtime.startTurn(threadId,{clientRequestId:'run-'+Math.random().toString(36).slice(2),content:'synthetic'});
    const done=await services.runtime.waitForTurn(turn.id,10000);onTurn=null;return {turnId:turn.id,state:done.state};};
  const bot=name=>{const created=services.store.createBot({name,profileId:'synthetic',engine:'claude'});
    // Same bot-to-bot flags as the existing team fixtures; they grant no file access.
    services.store.patchBot(created.id,{expectedRevision:0,canSeeBots:true,canSendActions:true,canReceiveOrders:true});return services.store.getBot(created.id);};
  return {data,services,seen,nativeAllowed,run,set onTurn(fn){onTurn=fn;},bot};
}
const facade=(f,turnId)=>({botId:f.services.store.getTurn(turnId).botId,turnId});

test('private turn: own bot namespace; team turn: team namespace, no member private files, revalidated mid-turn',async t=>{
  const f=fixture(t),coordinator=f.bot('Coordinator'),member=f.bot('Member');
  const results={};
  const own=f.services.store.createThread(member.id);
  const privateRun=await f.run(own.id,async turnId=>{results.private=attempt(()=>f.services.botWorkspaceTools.write(facade(f,turnId),{path:'private.md',text:'MEMBER_PRIVATE_SENTINEL'}));});
  assert.equal(privateRun.state,'completed');assert.ok(results.private.ok,JSON.stringify(results.private));
  assert.equal(readFileSync(join(f.data,'bot-files',member.id,'private.md'),'utf8'),'MEMBER_PRIVATE_SENTINEL');
  assert.equal(exposed(f.seen.get(privateRun.turnId)),FILE_TOOLS.length,'all exact own file targets remain resolvable, including deferred ones');for(const name of ['search','describe','call'])assert.ok(f.nativeAllowed.get(privateRun.turnId).includes('mcp__dexter_gateway__dx_catalog_'+name));
  const store=f.services.store,team=f.services.teamsHttp.create({expectedHostID:store.hostId,clientRequestId:randomUUID(),name:'Synthetic Team',botIds:[coordinator.id,member.id],
    coordinatorBotId:coordinator.id,rules:'',memory:''});
  const thread=store.createThread(coordinator.id);f.services.teamsHttp.bindThread(team.id,thread.id,team.revision,randomUUID());
  const teamRun=await f.run(thread.id,async turnId=>{
    const owner=facade(f,turnId);
    results.teamWrite=attempt(()=>f.services.botWorkspaceTools.write(owner,{path:'team.md',text:'TEAM_OUTPUT'}));
    results.teamList=attempt(()=>f.services.botWorkspaceTools.list(owner,{}));
    results.teamReadPrivate=attempt(()=>f.services.botWorkspaceTools.read(owner,{path:'private.md'}));
    results.teamStatus=attempt(()=>f.services.botWorkspaceTools.status(owner));
  });
  assert.equal(teamRun.state,'completed');
  assert.ok(results.teamWrite.ok,JSON.stringify(results.teamWrite));
  assert.equal(readFileSync(join(f.data,'team-files',team.id,'team.md'),'utf8'),'TEAM_OUTPUT');
  assert.equal(existsSync(join(f.data,'bot-files',coordinator.id,'team.md')),false,'never the coordinator private folder');
  assert.deepEqual(results.teamList.ok.entries.map(e=>e.name),['team.md'],'team namespace holds only team outputs');
  assert.equal(results.teamReadPrivate.code,'not_found','a member private file is not reachable from the team');
  assert.equal(results.teamStatus.ok.fileToolsScope,'team_workspace');
  assert.deepEqual(results.teamStatus.ok.outputNamespace,{kind:'team',generation:1,relativePath:`team-files/${team.id}`,layout:'legacy'});
  assert.equal(exposed(f.seen.get(teamRun.turnId)),FILE_TOOLS.length);
  // Membership/coordinator revalidated on every call: changing the coordinator mid-turn refuses the running team turn.
  const current=f.services.teamsHttp.get(team.id);
  const changed=await f.run(thread.id,async turnId=>{
    const owner=facade(f,turnId);
    results.beforeChange=attempt(()=>f.services.botWorkspaceTools.list(owner,{}));
    f.services.teamsHttp.update(team.id,{expectedHostID:store.hostId,expectedRevision:current.revision,coordinatorBotId:member.id});
    results.afterChange=attempt(()=>f.services.botWorkspaceTools.write(owner,{path:'late.md',text:'LATE'}));
  });
  // The host also stops the running team turn once the team changed; the late write was refused either way.
  assert.ok(['completed','failed','interrupted'].includes(changed.state),changed.state);
  assert.ok(results.beforeChange.ok,JSON.stringify(results.beforeChange));
  assert.equal(results.afterChange.code,'forbidden',JSON.stringify(results.afterChange));
  assert.equal(existsSync(join(f.data,'team-files',team.id,'late.md')),false);
});

test('group turns have no file tools: hidden from the turn allow-list and refused by the host facade',async t=>{
  const f=fixture(t),a=f.bot('Alpha'),b=f.bot('Beta'),store=f.services.store;
  const private_=await f.run(store.createThread(a.id).id,async turnId=>{f.services.botWorkspaceTools.write(facade(f,turnId),{path:'alpha-plan.md',text:'ALPHA_PRIVATE'});});
  assert.equal(private_.state,'completed');
  const group=store.groups.create({expectedHostId:store.hostId,clientRequestId:'group-1',expectedRevision:0,name:'Synthetic Group',botIds:[a.id,b.id],historyBotIds:[a.id,b.id]}).result;
  const conversation=store.groups.createConversation(group.id,{expectedHostId:store.hostId,clientRequestId:'conversation-1',expectedRevision:group.revision}).result;
  const attempts=new Map();
  f.onTurn=async turnId=>{const owner=facade(f,turnId);attempts.set(turnId,{list:attempt(()=>f.services.botWorkspaceTools.list(owner,{})),
    read:attempt(()=>f.services.botWorkspaceTools.read(owner,{path:'alpha-plan.md'})),write:attempt(()=>f.services.botWorkspaceTools.write(owner,{path:'g.md',text:'G'}))});};
  const dispatch=f.services.groups.send(conversation.id,{expectedHostId:store.hostId,clientRequestId:'send-1',expectedRevision:group.revision,content:'Synthetic shared question',recipients:{kind:'all'}});
  const finished=await f.services.groups.wait(dispatch.id);f.onTurn=null;
  assert.equal(finished.state,'completed');
  assert.equal(attempts.size,2,'both group recipients ran');
  for(const [turnId,result] of attempts){
    assert.deepEqual([result.list.code,result.read.code,result.write.code],['forbidden','forbidden','forbidden'],turnId);
    assert.equal(exposed(f.seen.get(turnId)),0,'no file or terminal tool in a group turn');
  }
  assert.equal(existsSync(join(f.data,'bot-files',b.id,'g.md')),false);assert.equal(existsSync(join(f.data,'bot-files',a.id,'g.md')),false);
});
