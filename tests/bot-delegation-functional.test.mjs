import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,realpathSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSecretKey} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {HostStore,ConversationRuntime,BotDelegationRuntime} from '@dexter/hub';
import {createHostApp} from '@dexter/hub/http';
import {CapabilityGateway,GatewayMcpBridge} from '@dexter/gateway';
import {BotDelegationSurface} from '../packages/cli/dist/bot-delegation-surface.js';
import {captureInspectionSnapshot,restoreForInspection} from '@dexter/operations';

const refused=error=>['forbidden','conflict'].includes(error.code);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function rpcBridge(surface,token) {
  const input=new PassThrough(),output=new PassThrough();
  const bridge=new GatewayMcpBridge({gateway:surface,capability:token,input,output});
  let seq=0,buffer=''; const pending=new Map();
  output.on('data',chunk=>{buffer+=chunk.toString();let cut;while((cut=buffer.indexOf('\n'))>=0){const row=JSON.parse(buffer.slice(0,cut));buffer=buffer.slice(cut+1);pending.get(row.id)?.(row);pending.delete(row.id);}});
  const send=(method,params)=>new Promise(resolve=>{const id=++seq;pending.set(id,resolve);input.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  return {send,initialize:async()=>{await send('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'Synthetic',version:'1'}});input.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');},close:()=>bridge.close()};
}

test('synthetic Codex harness discovers/delegates durably; policy, cycles, limits, replay, cancel, crash and snapshot are bounded',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-bot-delegation-')));let store,runtime;
 try {
  const dir=join(root,'host');store=new HostStore({dataDir:dir});
  const make=name=>store.createBot({name,profileId:'synthetic',engine:'codex'});
  const a=make('Coordinator'),b=make('Receiver'),c=make('Second receiver'),d=make('Fourth'),e=make('Fifth');
  const permit=(bot,fields)=>store.patchBot(bot.id,{expectedRevision:store.getBot(bot.id).revision,...fields});
  for(const bot of [a,b,c,d,e]) permit(bot,{canSeeBots:true,canSendActions:true,canReceiveOrders:true});
  permit(a,{roleDescription:'Own synthetic coordinator role'});
  store.setGrant({botId:a.id,tool:'fixture.check',destination:'synthetic',policy:'allow'});
  let service,surface; const tokens=new Map();let childRuns=0;const results=new Map();
  const gateway=new CapabilityGateway({store,broker:{credentialFor:async()=>({})},adapter:{execute:async()=>{throw Error('No external tools');}}});
  const call=(turnId,callId,target,task)=>surface.call(tokens.get(turnId),{tool:'dexter.bots.delegate',connectionId:'dexter-bots-internal',callId,arguments:{targetBotId:target.id,task}});
  const driver={id:'codex',sessionReuse:'turn',
   open:async(threadId,cursor,context)=>{const issued=surface.issueCapability({turnId:context.turnId});tokens.set(context.turnId,issued.token);return{threadId,nativeCursor:'synthetic_cursor'};},
   async *turn(session,turnId,input,signal){
    const event=(type,extra={})=>({type,threadId:session.threadId,turnId,...extra});const bot=store.getTurn(turnId).botId;
    if(bot!==a.id){childRuns++;
      if(input==='hello') yield event('tool.request',{request:{botId:bot,threadId:session.threadId,tool:'fixture.check',destination:'synthetic',arguments:{},idempotencyKey:'own-grant'}});
      if(input==='cycle-child'){assert.ok(!service.peers(turnId).some(peer=>peer.id===a.id));await assert.rejects(call(turnId,'cycle-back',a,'bad'),refused);}
      if(input==='hold') await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});
      if(input==='short')await wait(25);
      if(signal.aborted){yield event('turn.interrupted');return;}
      yield event('text.delta',{text:input==='cycle-child'?'cycle refused':'Child response'});yield event('turn.completed',{usage:{}});return;
    }
    let text='done';
    if(input==='allowed'){
      const rpc=rpcBridge(surface,tokens.get(turnId));try{await rpc.initialize();const catalog=await rpc.send('tools/list',{});assert.equal(catalog.result.tools.length,2);
      const alias=catalog.result.tools.find(tool=>tool.inputSchema.properties.input.properties.targetBotId).name;
      const response=await rpc.send('tools/call',{name:alias,arguments:{callId:'mcp-child',input:{targetBotId:b.id,task:'hello'}}});
      assert.equal(response.result.structuredContent.status,'succeeded');text=response.result.structuredContent.result.result;results.set(input,response.result.structuredContent);
      }finally{rpc.close();}
    } else if(input==='replay'){
      const one=await call(turnId,'same',b,'hello'),two=await call(turnId,'same',b,'hello');assert.equal(one.actionId,two.actionId);
      await assert.rejects(call(turnId,'same',b,'changed'),refused);results.set(input,one);
    } else if(input==='cycle'){results.set(input,await call(turnId,'cycle',b,'cycle-child'));
    } else if(input==='eight'){
      for(let i=0;i<8;i++) await call(turnId,`child-${i}`,b,'hello');await assert.rejects(call(turnId,'ninth',b,'hello'),refused);
    } else if(input==='two'){
      const p=call(turnId,'one',b,'short'),q=call(turnId,'two',c,'short');await assert.rejects(call(turnId,'three',b,'hello'),refused);await Promise.all([p,q]);
    } else if(input==='cancel'){
      results.set('cancel-started',true);await call(turnId,'hold',b,'hold');
    } else if(input==='revoke'){
      const before=childRuns;const p=call(turnId,'revoked',b,'hello');permit(b,{canReceiveOrders:false});const result=await p;
      assert.notEqual(result.status,'succeeded');assert.equal(childRuns,before);permit(b,{canReceiveOrders:true});
    } else if(input==='disabled'){
      permit(a,{canSendActions:false});assert.ok(!surface.listTools(tokens.get(turnId)).some(tool=>tool.name==='dexter.bots.delegate'));
      await assert.rejects(call(turnId,'disabled',b,'hello'),refused);permit(a,{canSendActions:true});
      await assert.rejects(surface.call(tokens.get(turnId),{tool:'dexter.bots.delegate',connectionId:'dexter-bots-internal',callId:'spoof',arguments:{targetBotId:b.id,task:'hello'},sourceTurnId:'foreign'}),refused);
    }
    if(signal.aborted){yield event('turn.interrupted');return;}
    yield event('text.delta',{text});yield event('turn.completed',{usage:{}});
   },respondToTool:async(session,turnId,requestId,result)=>{assert.equal(requestId,'own-grant');assert.equal(result.state,'refused');assert.equal(result.result,null);},interrupt:async()=>{},close:async session=>{const turn=[...tokens.keys()].find(id=>store.getTurn(id).threadId===session.threadId);if(turn)surface.revokeCapability(tokens.get(turn));}
  };
  runtime=new ConversationRuntime({store,drivers:[driver],turnTimeoutMs:2000,abortGraceMs:50});service=new BotDelegationRuntime(store,runtime);surface=new BotDelegationSurface(store,gateway,()=>service);
  const run=async name=>{const thread=store.createThread(a.id);const turn=runtime.startTurn(thread.id,{clientRequestId:name,content:name}).turn;const done=await runtime.waitForTurn(turn.id,5000);assert.equal(done.state,'completed',name);return turn;};
  const before=childRuns;const allowed=await run('allowed');assert.equal(childRuns,before+1);assert.equal(store.turnOutput(allowed.id),'Child response');
  const replayBefore=childRuns;await run('replay');assert.equal(childRuns,replayBefore+1);
  await run('cycle');await run('eight');await run('two');await run('revoke');await run('disabled');
  const thread=store.createThread(a.id);const cancelled=runtime.startTurn(thread.id,{clientRequestId:'cancel',content:'cancel'}).turn;
  while(!store.delegationChildren(cancelled.id).length)await wait(1);
  runtime.cancelTurn(cancelled.id);assert.equal((await runtime.waitForTurn(cancelled.id,5000)).state,'interrupted');
  const child=store.delegationChildren(cancelled.id)[0];assert.equal((await runtime.waitForTurn(child.targetTurnId,5000)).state,'interrupted');
  while(service.get(child.id).state==='running')await wait(1);assert.equal(service.get(child.id).state,'cancelled');
  const app=createHostApp(store,{botDelegation:service});const list=await(await app.request(`http://127.0.0.1/v1/bot-delegations?botId=${b.id}`)).json();assert.ok(list.items.length>0);
  assert.equal((await app.request('http://127.0.0.1/v1/bot-delegations',{headers:{origin:'https://foreign.invalid'}})).status,403);
  const disabledApp=createHostApp(store);assert.equal((await disabledApp.request('http://127.0.0.1/v1/bot-delegations')).status,503);
  // Store admission boundaries independent of the dispatcher: three ancestors are durable, fourth refused.
  const boundaryThread=store.createThread(a.id);const boundary=store.createTurn(boundaryThread.id,{clientRequestId:'boundary',content:'boundary'}).turn;store.claimNextTurn(boundaryThread.id);
  let parentTurn=boundary.id;const boundaryDeadline=store.now()+1000;
  for(const [i,target] of [b,c,d].entries()){
    const admitted=store.createDelegation(parentTurn,`depth-${i}`,{targetBotId:target.id,task:'boundary'},boundaryDeadline).delegation;
    store.claimNextTurn(admitted.targetThreadId);store.updateDelegation(admitted.id,'completed');parentTurn=admitted.targetTurnId;
  }
  assert.throws(()=>store.createDelegation(parentTurn,'depth-four',{targetBotId:e.id,task:'boundary'},store.now()+500),refused);
  // A committed-but-undispatched child cannot be replayed after reopen, or restored for inspection.
  const pending=store.createDelegation(boundary.id,'pending',{targetBotId:e.id,task:'not-dispatched'},store.now()+1000).delegation;
  mkdirSync(join(root,'out'),{mode:0o700});const keyObject=createSecretKey(Buffer.alloc(32,57));const key={keyId:'synthetic',use:fn=>fn(keyObject)};
  const artifact=captureInspectionSnapshot({source:store,include:{context:false,agenda:false,deviceRegistry:false,deviceSurface:false},key,output:join(root,'out','delegation.dxg8')});
  const restore=restoreForInspection({artifact:artifact.path,key,destination:join(root,'inspection')});
  const copy=new DatabaseSync(join(restore.destination,'inspection','hub.inspect.sqlite'),{readOnly:true});assert.equal(copy.prepare('SELECT state FROM bot_delegations WHERE id=?').get(pending.id).state,'unknown');copy.close();
  await runtime.shutdown({closeStore:false,graceMs:1000});await service.close();store.close();store=new HostStore({dataDir:dir});
  assert.equal(store.getDelegation(pending.id).state,'unknown');assert.equal(store.getDelegation(results.get('replay').actionId).state,'completed');
  const historical=store.createDelegation(boundary.id,'pending',{targetBotId:e.id,task:'not-dispatched'},store.now()+1000);assert.equal(historical.created,false);assert.equal(historical.delegation.state,'unknown');
 } finally {if(runtime)await runtime.shutdown({closeStore:false,graceMs:1000}).catch(()=>{});store?.close();rmSync(root,{recursive:true,force:true});}
});
