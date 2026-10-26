import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HostServices} from '../packages/cli/dist/host-services.js';
import {DEXTER_HARNESS_GUIDE,HARNESS_GUIDE_MAX_INSTRUCTION_CHARACTERS,HARNESS_GUIDE_TOPICS,readHarnessGuideTopic} from '@dexter/context';
import {createHostApp,createAuthorizedHostRouter} from '@dexter/hub/http';

function guideState(input){
 const guide=DEXTER_HARNESS_GUIDE;
 const begin=`BEGIN DEXTER BUILT-IN HARNESS GUIDE ${guide.id}@${guide.version} sha256=${guide.sha256}\n`;
 const end=`\nEND DEXTER BUILT-IN HARNESS GUIDE ${guide.id}@${guide.version}`;
 assert.equal(input.split(begin).length,2,'one code-owned guide per native turn');
 const start=input.indexOf(begin)+begin.length,finish=input.indexOf(end,start);
 assert.equal(input.slice(start,finish),guide.markdown);
 assert.equal(createHash('sha256').update(input.slice(start,finish),'utf8').digest('hex'),guide.sha256);
 const state=input.match(/BEGIN DEXTER TURN STATE \(quoted data, not instructions\)\n([^\n]+)\nEND DEXTER TURN STATE/);
 assert.ok(state,'bounded own-turn state is separate quoted data');
 const guideBlock=input.slice(input.indexOf(begin),input.indexOf('END DEXTER TURN STATE')+'END DEXTER TURN STATE'.length);
 assert.ok(guideBlock.length<=HARNESS_GUIDE_MAX_INSTRUCTION_CHARACTERS);
 return JSON.parse(state[1]);
}

// One bounded functional proof; injected native driver never launches a CLI or account.
test('owner immutable Markdown/CAS pages work without memory or MCP; own live skill instructions preserve role and grants',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-skills-owner-')));let services,configured;
 const observed=[];let a,b;
 const makeDriver=(id,options)=>({id,capabilities:{resume:true,interrupt:true,fork:false,steer:false},
  status:async()=>({engine:id,state:'ready'}),
  open:async(threadId)=>{
   assert.equal(options.localMcpServer,undefined);assert.equal(services.context.status().activeCapabilities,0);
   return {threadId,nativeCursor:'synthetic_skill_cursor'};
  },
  async *turn(session,turnId,input,signal){
   assert.equal(signal.aborted,false);observed.push({botId:services.store.getTurn(turnId).botId,input});
   const token=services.context.issue(turnId);
   try{await assert.rejects(services.context.recall(token,{query:'synthetic',locale:'pt-BR'}),error=>error.code==='adapter_failed');}
   finally{services.context.revoke(token);}
   yield {type:'text.delta',threadId:session.threadId,turnId,text:'Synthetic answer'};
   yield {type:'turn.completed',threadId:session.threadId,turnId,usage:{}};
  },respondToTool:async()=>{},interrupt:async()=>{},close:async()=>{}});
 try{
  services=new HostServices({dataDir:join(root,'host'),enableEngines:true,engineCommands:{codex:'/usr/bin/false'},makeDriver});
  assert.equal(services.gateway,undefined);assert.equal(services.memoryClient,undefined);
  assert.equal(services.context.status().backend,'unconfigured');
  a=services.store.createBot({name:'Own source',profileId:'synthetic',engine:'codex'});
  b=services.store.createBot({name:'Other bot',profileId:'synthetic',engine:'codex'});
  services.store.patchBot(a.id,{expectedRevision:0,roleDescription:'ROLE_FOR_OWN_BOT'});
  const app=createHostApp(services.store,{runtime:services.runtime,skills:services.skillsHttp,teams:services.teamsHttp});
  const request=(path,method,body)=>app.request(`http://127.0.0.1${path}`,body===undefined?{}:{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const status=await(await request('/v1/local-context')).json();assert.equal(status.memoryConfigured,false);assert.equal(status.backend,'unconfigured');
  const register=async(id,version,markdown)=>{
   const response=await request('/v1/skills','POST',{id,version,markdown});assert.equal(response.status,201);return response.json();
  };
  const global=await register('shared','1.0.0','GLOBAL_OWNER_MARKDOWN');
  const own=await register('own','1.0.0','OWN_BOT_MARKDOWN');
  const other=await register('other','1.0.0','OTHER_BOT_PRIVATE_MARKDOWN');
  const ownV2=await register('own','2.0.0','OWN_BOT_UPDATED_MARKDOWN');
  assert.equal((await request('/v1/skills','POST',{id:'own',version:'1.0.0',markdown:'OVERWRITE'})).status,409);
  assert.equal((await(await request('/v1/skills/own/versions/1.0.0')).json()).markdown,'OWN_BOT_MARKDOWN');
  assert.equal((await request('/v1/skills/own/versions/99.0.0')).status,404);
  assert.equal((await request('/v1/skills','POST',{id:'invalid id',version:'1.0.0',markdown:'bad'})).status,400);
  assert.equal((await request('/v1/skills','POST',{id:'valid',version:'1.0.0',markdown:'bad',ownerId:'foreign'})).status,400);
  let page=await(await request('/v1/skills?limit=2')).json();assert.equal(page.items.length,2);assert.ok(page.next);
  const page2=await(await request(`/v1/skills?limit=2&after=${encodeURIComponent(page.next)}`)).json();assert.equal(page2.items.length,2);assert.equal(page2.next,null);
  assert.equal(new Set([...page.items,...page2.items].map(lock=>`${lock.id}@${lock.version}`)).size,4);
  assert.equal((await request('/v1/skills?limit=201')).status,400);assert.equal((await request('/v1/skills?limit=1&limit=2')).status,400);
  assert.equal((await(await request('/v1/skills?skillId=own')).json()).items.length,2);
  const scopeA={kind:'bot',botId:a.id},scopeB={kind:'bot',botId:b.id};
  const activate=(lock,scope,expected=null,version=lock.version)=>request(`/v1/skill-activations/${lock.id}`,'PUT',{scope,expected,version});
  assert.equal((await activate(global,{kind:'global'})).status,200);
  assert.equal((await activate(own,scopeA)).status,200);assert.equal((await activate(other,scopeB)).status,200);
  assert.equal((await activate(ownV2,scopeA)).status,409);
  assert.equal((await activate(ownV2,scopeA,{version:own.version,sha256:own.sha256})).status,200);
  assert.equal((await activate(own,scopeA,{version:own.version,sha256:own.sha256})).status,409);
  assert.equal((await activate(own,{kind:'bot',botId:'foreign'})).status,404);
  assert.equal((await activate(own,{kind:'team',teamId:'foreign'})).status,400);
  const activations=await(await request(`/v1/skill-activations?scopeKind=bot&botId=${a.id}`)).json();assert.equal(activations.items.length,1);assert.equal(activations.items[0].lock.version,'2.0.0');
  assert.equal((await request('/v1/skill-activations?scopeKind=bot')).status,400);
  assert.equal((await request(`/v1/skill-activations?scopeKind=global&botId=${a.id}`)).status,400);
  assert.equal((await app.request('http://127.0.0.1/v1/skills',{headers:{origin:'https://foreign.invalid'}})).status,403);
  const paired=createAuthorizedHostRouter(services.store),authority={principal:'paired-client',installationId:services.store.hostId,ownerId:services.store.ownerId,deviceId:'synthetic',role:'client-ios',scopes:['chat.read','chat.write','grants.manage'],pinGeneration:1,bindingRevision:1,assertCurrent(){},noteSelfRevoke(){}};
  assert.equal((await paired.fetch(new Request('https://app-client.invalid/v1/skills'),{authority})).status,404);
  // A configured Team and its canonical thread, rather than legacy membership plus a private thread.
  const teamReply=await request('/v1/teams','POST',{expectedHostID:services.store.hostId,clientRequestId:randomUUID(),
   name:'Synthetic own team',coordinatorBotId:a.id,botIds:[a.id]});
  assert.equal(teamReply.status,201);const team=await teamReply.json();
  const teamSkill=await register('team','1.0.0','OWN_TEAM_MARKDOWN');
  services.context.compareAndSetSkillActivation({kind:'team',teamId:team.id},teamSkill.id,null,teamSkill.version);
  const thread=services.store.createThread(a.id);
  const run=async(bot,content)=>{
   const t=bot.id===a.id?thread:services.store.createThread(bot.id);const turn=services.runtime.startTurn(t.id,{clientRequestId:content,content}).turn;
   return services.runtime.waitForTurn(turn.id,5000);
  };
  assert.equal((await run(a,'first')).state,'completed');
  const first=observed.at(-1).input;assert.ok(first.includes('ROLE_FOR_OWN_BOT'));assert.ok(first.includes('GLOBAL_OWNER_MARKDOWN'));assert.ok(first.includes('OWN_BOT_UPDATED_MARKDOWN'));assert.ok(!first.includes('OWN_TEAM_MARKDOWN'),'membership never publishes Team skills into a private conversation');assert.ok(!first.includes('OTHER_BOT_PRIVATE_MARKDOWN'));assert.ok(first.includes('USER TASK:'));
  assert.equal(guideState(first).botId,a.id);
  assert.equal(services.context.status().activeCapabilities,0);assert.equal(services.store.summary().counts.grants,0);
  const teamThreadReply=await request(`/v1/teams/${team.id}/threads`,'POST',{
   expectedHostID:services.store.hostId,expectedRevision:team.revision,clientRequestId:randomUUID()});
  assert.equal(teamThreadReply.status,201);const teamThread=(await teamThreadReply.json()).thread;
  const teamTurn=services.runtime.startTurn(teamThread.id,{clientRequestId:'own-team-skills',content:'Synthetic own Team task'}).turn;
  assert.equal((await services.runtime.waitForTurn(teamTurn.id,5000)).state,'completed');
  const sharedInput=observed.at(-1).input;
  assert.ok(sharedInput.includes('OWN_TEAM_MARKDOWN'),'the activated Team skill reaches its actual host-bound Team conversation');
  for(const privateMarker of ['GLOBAL_OWNER_MARKDOWN','OWN_BOT_UPDATED_MARKDOWN','OTHER_BOT_PRIVATE_MARKDOWN'])
   assert.ok(!sharedInput.includes(privateMarker),`Team never receives private/global skill ${privateMarker}`);
  assert.equal(guideState(sharedInput).botId,a.id);assert.equal(services.context.status().activeCapabilities,0);
  assert.equal(services.store.summary().counts.grants,0);
  const otherTeamReply=await request('/v1/teams','POST',{expectedHostID:services.store.hostId,clientRequestId:randomUUID(),
   name:'Synthetic other team',coordinatorBotId:a.id,botIds:[a.id]});
  assert.equal(otherTeamReply.status,201);const otherTeam=await otherTeamReply.json();
  const otherTeamSkill=await register('other_team','1.0.0','OTHER_TEAM_MARKDOWN');
  services.context.compareAndSetSkillActivation({kind:'team',teamId:otherTeam.id},otherTeamSkill.id,null,otherTeamSkill.version);
  const sameTeamTurn=services.runtime.startTurn(teamThread.id,{clientRequestId:'own-team-stays-scoped',content:'Synthetic scoped Team task'}).turn;
  assert.equal((await services.runtime.waitForTurn(sameTeamTurn.id,5000)).state,'completed');
  assert.ok(observed.at(-1).input.includes('OWN_TEAM_MARKDOWN'));assert.ok(!observed.at(-1).input.includes('OTHER_TEAM_MARKDOWN'));
  services.context.setMember(team.id,services.store.ownerId,false);
  const beforeRevoked=observed.length;
  assert.throws(()=>services.runtime.startTurn(teamThread.id,{clientRequestId:'revoked-team-skills',content:'Never admitted'}),
   error=>error.code==='forbidden');
  assert.equal(observed.length,beforeRevoked,'revoked Team cannot reopen an engine or fall back to private skills');
  assert.equal((await activate(ownV2,scopeA,{version:ownV2.version,sha256:ownV2.sha256},null)).status,200);
  assert.equal((await run(a,'second')).state,'completed');assert.ok(!observed.at(-1).input.includes('OWN_BOT_UPDATED_MARKDOWN'));
  assert.equal((await run(b,'other')).state,'completed');assert.ok(observed.at(-1).input.includes('OTHER_BOT_PRIVATE_MARKDOWN'));assert.ok(!observed.at(-1).input.includes('ROLE_FOR_OWN_BOT'));assert.ok(!observed.at(-1).input.includes('OWN_TEAM_MARKDOWN'));
  assert.equal(guideState(observed.at(-1).input).botId,b.id);
  const large=await register('large','1.0.0','X'.repeat(32768));assert.equal((await activate(large,scopeA)).status,200);
  const before=observed.length;const largeTurn=await run(a,'too-large');assert.equal(largeTurn.state,'failed');assert.equal(largeTurn.code,'context_limit');assert.equal(observed.length,before);assert.equal(services.context.status().activeCapabilities,0);
  assert.equal((await activate(large,scopeA,{version:large.version,sha256:large.sha256},null)).status,200);
  for(let index=0;index<17;index++){const lock=await register(`bounded_${index}`,'1.0.0','Bounded instruction');assert.equal((await activate(lock,scopeA)).status,200);}
  const countTurn=await run(a,'too-many');assert.equal(countTurn.state,'failed');assert.equal(countTurn.code,'context_limit');assert.equal(observed.length,before);assert.equal(services.context.status().activeCapabilities,0);
  writeFileSync(join(services.context.repositoryPath,own.path),'tampered');
  const tamper=await request('/v1/skills/own/versions/1.0.0');assert.equal(tamper.status,409);assert.equal((await tamper.json()).message,'Local skill pin verification failed.');
  let fetches=0;
  configured=new HostServices({dataDir:join(root,'configured'),enableEngines:true,engineCommands:{codex:'/usr/bin/false'},makeDriver,enableMcp:true,context:{ownerExclusiveDeployment:true,memory:{origin:'http://127.0.0.1:1',labLoopbackWithoutAuth:true,fetch:async()=>{fetches++;return Response.json([]);}}}});
  assert.equal(configured.context.status().backend,'ai-memory-read-adapter');assert.equal(fetches,0);
  await configured.shutdown();configured=null;await services.shutdown();services=null;
 }finally{await configured?.shutdown();await services?.shutdown();rmSync(root,{recursive:true,force:true});}
});

test('all bots receive the pinned built-in guide without activated skills, MCP, memory or catalog discovery',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-built-in-guide-')));let services;let catalogCalls=0;
 const observed=[];
 const makeDriver=id=>({id,capabilities:{resume:true,interrupt:true,fork:false,steer:false},
  status:async()=>({engine:id,installed:true,version:'synthetic',authentication:'authenticated',billing:'subscription'}),
  open:async threadId=>({threadId,nativeCursor:'synthetic_guide_cursor'}),
  async *turn(session,turnId,input){observed.push({turnId,input});
   yield {type:'text.delta',threadId:session.threadId,turnId,text:'Synthetic guide answer'};
   yield {type:'turn.completed',threadId:session.threadId,turnId,usage:{}};
  },respondToTool:async()=>{},interrupt:async()=>{},close:async()=>{}});
 try{
  services=new HostServices({dataDir:join(root,'host'),enableEngines:true,engineCommands:{codex:'/usr/bin/false'},makeDriver,
   engineCatalog:async()=>{catalogCalls++;throw new Error('Guide must not discover models on every turn.');}});
  assert.deepEqual(HARNESS_GUIDE_TOPICS.map(topic=>topic.id),['structure','models','skills','memory-routines','bots','configuration','terminal','attachments','voice','mcp','browser-use','delegation','teams','automations','authorization','memory-learning','groups','native-voice']);
  for(const topic of HARNESS_GUIDE_TOPICS){
   assert.equal(topic.markdown,undefined,'index does not preload the full manual');
   const read=readHarnessGuideTopic(topic.id);assert.equal(read.version,topic.version,'each focused topic keeps its advertised version');
   assert.equal(read.characters,read.markdown.length);assert.equal(read.sha256,topic.sha256);
   assert.equal(createHash('sha256').update(read.markdown,'utf8').digest('hex'),read.sha256);
  }
  assert.throws(()=>readHarnessGuideTopic('private_other_bot'),error=>error.code==='not_found');
  const a=services.store.createBot({name:'A private display name',profileId:'guide_a',engine:'codex'});
  const b=services.store.createBot({name:'B private display name',profileId:'guide_b',engine:'codex'});
  const threadA=services.store.createThread(a.id),threadB=services.store.createThread(b.id);
  const run=async(thread,content)=>{const {turn}=services.runtime.startTurn(thread.id,{clientRequestId:content,content});
   assert.equal((await services.runtime.waitForTurn(turn.id,5000)).state,'completed');return {turn,state:guideState(observed.at(-1).input),input:observed.at(-1).input};};
  assert.deepEqual(services.context.listSkillCatalog().items,[]);
  const first=await run(threadA,'guide_first');
  const second=await run(threadB,'guide_second');
  for(const [result,bot,thread] of [[first,a,threadA],[second,b,threadB]]){
   assert.equal(result.state.botId,bot.id);assert.equal(result.state.threadId,thread.id);assert.equal(result.state.turnId,result.turn.id);
   assert.deepEqual(result.state.selection,{engine:'codex',model:null,reasoningEffort:null,speed:null});
   assert.deepEqual(result.state.features,{mcpToolsEnabled:false,harnessAdminToolsEnabled:false,nativeMcpConfigured:false,
    botDelegationEnabled:false,deviceToolsEnabled:false,externalMemoryConfigured:false});
   assert.ok(result.input.includes('No owner-selected skills are active for this bot.'));
   assert.ok(!result.input.includes(root));assert.ok(!result.input.includes('synthetic_guide_cursor'));
   const builtIn=result.input.slice(result.input.indexOf('BEGIN DEXTER BUILT-IN HARNESS GUIDE'),result.input.indexOf('END DEXTER BUILT-IN HARNESS GUIDE'));
   assert.ok(!builtIn.includes('private display name'),'code-owned guide does not contain owner metadata');
   assert.ok(!result.input.includes((bot.id===a.id?b:a).name),'own identity never exposes another bot name');
   assert.ok(!result.input.includes('guide_a'));assert.ok(!result.input.includes('guide_b'));
  }
  assert.ok(!first.input.includes(b.id));assert.ok(!second.input.includes(a.id));
  // A same-ID owner skill remains distinct; it cannot replace or activate the code-owned guide.
  const lock=services.context.registerSkill(DEXTER_HARNESS_GUIDE.id,'1.0.0','OWNER_SKILL_SAME_ID_WITHOUT_AUTHORITY');
  services.context.activateSkill({kind:'bot',botId:a.id},lock);
  services.store.patchBot(a.id,{expectedRevision:0,canSeeBots:true,canSendActions:true});
  const changed=await run(threadA,'guide_next_turn');assert.equal(changed.state.botFlags.canSeeBots,true);
  assert.equal(changed.state.botFlags.canSendActions,true);assert.equal(changed.state.features.mcpToolsEnabled,false);
  assert.ok(changed.input.includes('OWNER_SKILL_SAME_ID_WITHOUT_AUTHORITY'));
  const otherAgain=await run(threadB,'guide_other_again');assert.equal(otherAgain.state.botFlags.canSeeBots,false);
  assert.ok(!otherAgain.input.includes('OWNER_SKILL_SAME_ID_WITHOUT_AUTHORITY'));
  assert.equal(catalogCalls,0);assert.equal(services.gateway,undefined);assert.equal(services.memoryClient,undefined);
  assert.equal(services.context.status().activeCapabilities,0);assert.equal(services.store.summary().counts.grants,0);
 }finally{await services?.shutdown();rmSync(root,{recursive:true,force:true});}
});
