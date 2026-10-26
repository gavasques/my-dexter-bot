import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,realpathSync,rmSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {HostStore,ConversationRuntime,BotDelegationRuntime} from '@dexter/hub';
import {ContextHost,FixtureMemoryAdapter} from '@dexter/context';
import {CapabilityGateway} from '@dexter/gateway';
import {BotDelegationSurface} from '../packages/cli/dist/bot-delegation-surface.js';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read){for(let i=0;i<600;i++){const result=await read();if(result)return result;await sleep(10);}assert.fail('bounded synthetic observation');}
const denied=e=>['forbidden','unauthorized','invalid_input','conflict'].includes(e.code);
const evidence=(name,data)=>{if(process.env.DELEGATION_RESULTS_EVIDENCE)appendFileSync(process.env.DELEGATION_RESULTS_EVIDENCE,JSON.stringify({name,...data})+'\n');};
function setup(){
 const root=realpathSync(mkdtempSync(join(process.env.TMPDIR??'/private/tmp','delegation-results-')));let store,context,port;
 const open=()=>{store=new HostStore({dataDir:join(root,'data')});context=new ContextHost(store,new FixtureMemoryAdapter([]));
  port={list:()=>context.listTeamWorkspaces(),get:id=>context.getTeamWorkspace(id),create:i=>context.createTeamWorkspace(i),update:(id,i)=>context.updateTeamWorkspace(id,i),
   threadTeam:id=>context.teamForThread(id),turnTeam:id=>context.teamScopeForTurn(id),assertTurn:id=>context.assertTeamTurn(id),filterPeers:(id,peers)=>context.filterTeamPeers(id,peers),assertDelegation:(id,target)=>context.assertTeamDelegation(id,target),bindDelegation:(id,row)=>context.bindTeamDelegation(id,row)};
  store.bindTeamPolicy(port);
 };open();
 const make=name=>store.createBot({name,profileId:'synthetic-'+name,engine:'codex'}),master=make('Master'),coordinator=make('Coordinator'),specialist=make('Specialist'),other=make('Other');
 for(const bot of [master,coordinator,specialist,other])store.patchBot(bot.id,{expectedRevision:0,canSeeBots:true,canSendActions:true,canReceiveOrders:true,...(bot.id===master.id?{isMaster:true}:{})});
 const team=port.create({expectedHostID:store.hostId,clientRequestId:randomUUID(),name:'Synthetic team',botIds:[coordinator.id,specialist.id],coordinatorBotId:coordinator.id,rules:'PRIVATE_TEAM_RULES',memory:'PRIVATE_TEAM_MEMORY'});
 const thread=store.createThread(master.id);
 return {root,master,coordinator,specialist,other,team,thread,get store(){return store;},get port(){return port;},get context(){return context;},reopen(){context.close();store.close();open();},close(){context.close();store.close();rmSync(root,{recursive:true,force:true});}};
}
function tools(f,drivers=[],options={}){
 const runtime=new ConversationRuntime({store:f.store,drivers,turnTimeoutMs:10000,abortGraceMs:50,...options});
 const service=new BotDelegationRuntime(f.store,runtime,f.port),gateway=new CapabilityGateway({store:f.store,broker:{credentialFor:async()=>({})},adapter:{execute:async()=>{throw Error('No external tools');}}});
 const surface=new BotDelegationSurface(f.store,gateway,()=>service,()=>f.port);return {runtime,service,surface};
}
function claim(f,thread=f.thread){const turn=f.store.createTurn(thread.id,{clientRequestId:'parent-'+f.store.listTurns(thread.id).length,content:'synthetic request'}).turn;f.store.claimNextTurn(thread.id);return turn;}
function child(f,parent,name,state='completed'){
 const admitted=f.store.createDelegation(parent.id,name,{targetBotId:f.specialist.id,task:'PRIVATE_TASK_PAYLOAD'},f.store.now()+5000).delegation;
 f.store.claimNextTurn(admitted.targetThreadId);f.store.finishTurn(admitted.targetTurnId,state,state==='completed'?null:state==='unknown'?'host_interrupted':state==='failed'?'engine_failed':'cancelled');f.store.updateDelegation(admitted.id,state==='interrupted'?'cancelled':state,state==='completed'?'public answer':null);return admitted;
}

test('5-A parent capability reads canonical bounded states, wrong identity fails, reopen/replay never schedules or revives a child',async t=>{
 const f=setup();let x=tools(f);t.after(async()=>{await x.runtime.shutdown({closeStore:false});await x.service.close();f.close();});
 const parent=claim(f),rows=['completed','failed','unknown','interrupted'].map((state,i)=>child(f,parent,'child-'+i,state));
 const token=x.surface.issueCapability({turnId:parent.id}).token;
 const call=(input,callId='read')=>x.surface.call(token,{connectionId:'dexter-bots-internal',tool:'dexter.bots.results',callId,arguments:input});
 const one=await call({limit:2});assert.equal(one.status,'succeeded');assert.equal(one.result.hasMore,true);assert.equal(one.result.items.length,2);
 const addUnsettled=kind=>{
  const row=f.store.createDelegation(parent.id,'unsettled-'+kind,{targetBotId:f.specialist.id,task:'bound effect'},f.store.now()+4000).delegation;f.store.claimNextTurn(row.targetThreadId);
  if(!f.store.getGrant(f.specialist.id,'fixture.bound','local'))f.store.setGrant({botId:f.specialist.id,tool:'fixture.bound',destination:'local',policy:'ask'});
  const action=f.store.requestAction({botId:f.specialist.id,threadId:row.targetThreadId,tool:'fixture.bound',destination:'local',arguments:{private:'NOT_FOR_PARENT'},idempotencyKey:kind});f.store.bindToolAction(action.id,row.targetTurnId,'bound-'+kind);
  if(kind==='unknown'){f.store.decideAction(action.id,{requestHash:action.requestHash,decision:'allow'});f.store.claimAction(action.id);f.store.markUnknown(action.id,'executor_error');}
  f.store.finishTurn(row.targetTurnId,'completed',null);f.store.updateDelegation(row.id,'completed','unsettled answer must stay hidden');return row;
 };
 const awaiting=addUnsettled('approval'),uncertain=addUnsettled('unknown');
 const page=(await call({limit:8})).result;
 for(const [i,state]of ['completed','failed','unknown','cancelled'].entries())assert.equal(page.items.find(item=>item.delegationId===rows[i].id).state,state);
 assert.equal(page.items.find(item=>item.delegationId===rows[0].id).result,'public answer');
 const approvalItem=page.items.find(item=>item.delegationId===awaiting.id),unknownItem=page.items.find(item=>item.delegationId===uncertain.id);
 assert.equal(approvalItem.state,'approval_pending');assert.equal(approvalItem.result,null);assert.equal(unknownItem.state,'unknown');assert.equal(unknownItem.effectsUnknown,true);assert.equal(unknownItem.result,null);assert.ok(!JSON.stringify(page).includes('NOT_FOR_PARENT'));
 assert.ok(!JSON.stringify(page).includes('PRIVATE_TASK_PAYLOAD'));assert.ok(!JSON.stringify(page).includes('PRIVATE_TEAM_'));assert.ok(page.items.every(i=>!('arguments' in i)&&!('actions'in i)&&!('memory'in i)));
 await assert.rejects(call({botId:f.other.id}),denied);await assert.rejects(call({limit:9}),denied);
 const foreignThread=f.store.createThread(f.master.id),foreign=claim(f,foreignThread);await assert.rejects(call({sourceTurnId:foreign.id}),denied);
 const otherThread=f.store.createThread(f.other.id),otherTurn=claim(f,otherThread),foreignToken=x.surface.issueCapability({turnId:otherTurn.id}).token;
 await assert.rejects(x.surface.call(foreignToken,{connectionId:'dexter-bots-internal',tool:'dexter.bots.results',callId:'cross-bot',arguments:{sourceTurnId:parent.id}}),denied);
 f.store.finishTurn(parent.id,'completed',null);f.store.finishTurn(foreign.id,'completed',null);f.store.finishTurn(otherTurn.id,'completed',null);
 await x.runtime.shutdown({closeStore:false});await x.service.close();f.reopen();x=tools(f);
 const current=claim(f),newToken=x.surface.issueCapability({turnId:current.id}).token,count=f.store.listDelegations().length;
 const historical=await x.surface.call(newToken,{connectionId:'dexter-bots-internal',tool:'dexter.bots.results',callId:'after-restart',arguments:{sourceTurnId:parent.id,limit:8}});
 assert.deepEqual(historical.result,page);assert.equal(f.store.listDelegations().length,count);assert.equal(x.runtime.pending().turns,0);
 await assert.rejects(x.service.delegate(parent.id,'child-2',{targetBotId:f.specialist.id,task:'PRIVATE_TASK_PAYLOAD'}),denied);assert.equal(f.store.listDelegations().length,count);
 assert.equal(f.store.getDelegation(rows[2].id).state,'unknown');f.store.finishTurn(current.id,'completed',null);
 evidence('bounded_restart',{states:page.items.map(i=>i.state),wrongBotAndThreadRefused:true,rawIdentityRefused:true,limit8:true,hasMore:true,sameLinksAfterReopen:true,newChildren:0,unknownNotRevived:true,privateTaskAndTeamAbsent:true,completedWithApprovalStillPending:true,completedWithUnknownEffectStillUnknown:true});
});

test('5-A Master→Time→specialist completes/fails/awaits own approval; normal parent consolidation is persisted and root cancel reaches children',async t=>{
 const f=setup();let x,tokens=new Map(),observed=[],runs=0;
 f.store.setGrant({botId:f.master.id,tool:'fixture.work',destination:'local',policy:'allow'});
 f.store.setGrant({botId:f.specialist.id,tool:'fixture.work',destination:'local',policy:'ask'});
 const call=(turnId,tool,args,callId)=>x.surface.call(tokens.get(turnId),{connectionId:'dexter-bots-internal',tool,arguments:args,callId});
 const driver={id:'codex',sessionReuse:'turn',open:async(threadId,cursor,scope)=>{tokens.set(scope.turnId,x.surface.issueCapability({turnId:scope.turnId}).token);return{threadId,nativeCursor:'synthetic'};},
  async *turn(session,turnId,input,signal){const bot=f.store.getTurn(turnId).botId,event=(type,extra={})=>({type,threadId:session.threadId,turnId,...extra});
   if(bot===f.master.id){const list=await call(turnId,'dexter.teams.list',{},'directory');assert.equal(list.result.items[0].id,f.team.id);
    const response=await call(turnId,'dexter.teams.delegate',{teamId:f.team.id,task:input==='cancel'?'hold':'work'},'team-order');
    const read=await call(turnId,'dexter.bots.results',{delegationId:response.actionId},'team-result');observed.push(read.result.items[0]);
    if(signal.aborted){yield event('turn.interrupted');return;}yield event('text.delta',{text:'Consolidated actual child outcomes: '+response.result.result});yield event('turn.completed',{usage:{}});return;
   }
   if(bot===f.coordinator.id){
    if(input==='hold'){await call(turnId,'dexter.bots.delegate',{targetBotId:f.specialist.id,task:'hold'},'hold-specialist');if(signal.aborted){yield event('turn.interrupted');return;}}
    const parts=[];
    for(const task of ['success','failure','approval']){
     const operation=call(turnId,'dexter.bots.delegate',{targetBotId:f.specialist.id,task},'specialist-'+task);
     if(task==='approval'){await until(()=>{const action=f.store.listActions('awaiting_approval')[0];return action&&f.store.toolActionOrigin(action.id);});const pending=await call(turnId,'dexter.bots.results',{},'progress');const awaiting=pending.result.items.find(item=>item.state==='approval_pending');assert.ok(awaiting);observed.push(awaiting);}
     const result=await operation;parts.push({state:result.result.state,answer:result.result.result,code:result.result.turnCode});
    }
    yield event('text.delta',{text:JSON.stringify(parts)});yield event('turn.completed',{usage:{}});return;
   }
   runs++;
   if(input==='failure')throw Error('PRIVATE_RAW_STDERR');
   if(input==='hold'){await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));yield event('turn.interrupted');return;}
   if(input==='approval')yield event('tool.request',{request:{botId:bot,threadId:session.threadId,tool:'fixture.work',destination:'local',arguments:{private:'ACTION_PAYLOAD'},idempotencyKey:'own-specialist-approval'}});
   if(signal.aborted){yield event('turn.interrupted');return;}yield event('text.delta',{text:'Public specialist '+input});yield event('turn.completed',{usage:{}});
  },respondToTool:async(_session,turnId,_request,outcome)=>{assert.equal(outcome.state,'succeeded');const action=f.store.getAction(outcome.actionId);f.store.observeToolResult(turnId,{actionId:action.id,requestHash:action.requestHash,status:action.state});},interrupt:async()=>{},close:async()=>{}};
 x=tools(f,[driver],{executor:async()=>({syntheticEffect:'one'})});t.after(async()=>{await x.runtime.shutdown({closeStore:false});await x.service.close();f.close();});
 const parent=x.runtime.startTurn(f.thread.id,{clientRequestId:'journey',content:'journey'}).turn;
 const pending=await until(()=>f.store.listActions('awaiting_approval')[0]);assert.equal(pending.request.botId,f.specialist.id);assert.equal(pending.authorization,undefined,'Master allow grant was not inherited');
 // Generic synthetic EngineEvent requests have no origin binder: host setup uses the real canonical child/call, like the native harness.
 const childOrigin=f.store.listDelegations().find(row=>row.targetThreadId===pending.request.threadId&&row.targetBotId===f.specialist.id);assert.ok(childOrigin);f.store.bindToolAction(pending.id,childOrigin.targetTurnId,'own-specialist-approval');
 const progress=await call(parent.id,'dexter.bots.results',{},'root-progress');assert.equal(progress.result.items[0].state,'approval_pending');assert.ok(!JSON.stringify(progress).includes('ACTION_PAYLOAD'));
 await until(()=>observed.some(item=>item.state==='approval_pending'));
 f.store.decideAction(pending.id,{requestHash:pending.requestHash,decision:'allow'});
 assert.equal((await x.runtime.waitForTurn(parent.id,8000)).state,'completed');const text=f.store.turnOutput(parent.id);
 evidence('journey-diagnostic',{links:f.store.listDelegations().map(r=>({source:r.sourceBotId,target:r.targetBotId,state:r.state,resultAvailable:r.result!==null})),failedTurns:f.store.listTurnsByState('failed').map(r=>({id:r.id,code:r.code})),actions:f.store.listActions().map(r=>({state:r.state,reason:r.reason}))});
 assert.match(text,/Consolidated actual child outcomes/);assert.match(text,/"state":"failed"/);assert.match(text,/Public specialist success/);assert.ok(!text.includes('PRIVATE_RAW_STDERR'));assert.equal(runs,3);assert.ok(f.store.getTurn(parent.id).outputMessageId);
 const cancel=x.runtime.startTurn(f.thread.id,{clientRequestId:'cancel',content:'cancel'}).turn;await until(()=>f.store.delegationChildren(cancel.id)[0]&&f.store.delegationChildren(f.store.delegationChildren(cancel.id)[0].targetTurnId)[0]);
 x.runtime.cancelTurn(cancel.id);assert.equal((await x.runtime.waitForTurn(cancel.id,6000)).state,'interrupted');
 await until(()=>f.store.delegationChildren(cancel.id).every(row=>!['pending','running'].includes(row.state)));
 const top=f.store.delegationChildren(cancel.id)[0],nested=f.store.delegationChildren(top.targetTurnId)[0];assert.equal(f.store.getTurn(top.targetTurnId).state,'interrupted');assert.equal(f.store.getTurn(nested.targetTurnId).state,'interrupted');
 evidence('synthetic_journey',{masterToTeamToSpecialist:true,specialistRunsBeforeCancel:3,ownGrantApprovalPending:true,recursiveApprovalVisible:true,failedNotSuccess:true,parentOutputPersisted:true,parentOutputMessageId:f.store.getTurn(parent.id).outputMessageId,cancelRootChildren:true,privatePayloadsAbsent:true,noInference:true});
});

test('5-A reads/dispatch fail after flags or team member removal; results bound size and never expose unrelated specialists',async t=>{
 const f=setup(),x=tools(f);t.after(async()=>{await x.runtime.shutdown({closeStore:false});await x.service.close();f.close();});
 const parent=claim(f),entry=f.store.createDelegation(parent.id,'team',{targetBotId:f.coordinator.id,task:'team'},f.store.now()+5000,f.team.id).delegation;f.port.bindDelegation(f.team.id,entry);f.store.claimNextTurn(entry.targetThreadId);
 const nested=f.store.createDelegation(entry.targetTurnId,'nested',{targetBotId:f.specialist.id,task:'work'},f.store.now()+4000).delegation;f.store.claimNextTurn(nested.targetThreadId);f.store.finishTurn(nested.targetTurnId,'completed',null);f.store.updateDelegation(nested.id,'completed','a'.repeat(6000));f.store.finishTurn(entry.targetTurnId,'completed',null);f.store.updateDelegation(entry.id,'completed','b'.repeat(6000));
 assert.equal(x.service.results(parent.id).items[0].result.length,4096);assert.equal(x.service.results(parent.id).items[0].resultTruncated,true);
 const coordinatorCurrent=claim(f,f.store.getThread(entry.targetThreadId));
 const wrong=f.store.createDelegation(parent.id,'unrelated',{targetBotId:f.other.id,task:'other'},f.store.now()+3000).delegation;
 assert.throws(()=>x.service.results(coordinatorCurrent.id,{delegationId:wrong.id}),denied);
 f.store.patchBot(f.master.id,{expectedRevision:f.store.getBot(f.master.id).revision,canSendActions:false});assert.throws(()=>x.service.results(parent.id),denied);await assert.rejects(x.service.delegate(parent.id,'revoked',{targetBotId:f.specialist.id,task:'no'}),denied);
 f.store.patchBot(f.master.id,{expectedRevision:f.store.getBot(f.master.id).revision,canSendActions:true});
 f.port.update(f.team.id,{expectedHostID:f.store.hostId,expectedRevision:f.team.revision,botIds:[f.coordinator.id]});
 assert.throws(()=>x.service.results(parent.id),denied);assert.throws(()=>x.service.results(coordinatorCurrent.id,{sourceTurnId:entry.targetTurnId}),denied);await assert.rejects(x.service.delegate(coordinatorCurrent.id,'removed',{targetBotId:f.specialist.id,task:'no'}),denied);
 assert.equal(f.store.delegationChildren(coordinatorCurrent.id).length,0);
 evidence('revocation',{flagsRevalidated:true,memberRemovalReadAndDispatchRefused:true,wrongParentChildRefused:true,result4096:true,overflowTruncated:true,newChildrenAfterRevocation:0});
});
