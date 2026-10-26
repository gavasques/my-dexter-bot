import assert from'node:assert/strict';import{test}from'node:test';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{randomUUID}from'node:crypto';
import{HostStore,dispatchAction}from'@dexter/hub';import type{ConnectionWorkflow}from'@dexter/contracts';
async function pending(store:HostStore):Promise<ConnectionWorkflow>{
  const bot=store.createBot({name:'Synthetic setup',profileId:'default',engine:'claude'}),thread=store.createThread(bot.id),turn=store.createTurn(thread.id,{clientRequestId:randomUUID(),content:'Use the selected synthetic account.'}).turn;
  store.claimNextTurn(thread.id);store.setGrant({botId:bot.id,tool:'dexter.harness.connections.request',destination:'dexter-harness-owner-proposals',policy:'ask'});
  const input={clientRequestId:randomUUID(),expectedBotRevision:bot.revision,target:{kind:'managed' as const,serviceId:'gmail',catalogPin:'a'.repeat(64)}};
  const action=store.requestAction({botId:bot.id,threadId:thread.id,tool:'dexter.harness.connections.request',destination:'dexter-harness-owner-proposals',arguments:{},idempotencyKey:randomUUID()});
  store.bindToolAction(action.id,turn.id,'setup-call');store.decideAction(action.id,{decision:'allow',requestHash:action.requestHash});
  let workflow:ConnectionWorkflow|undefined;const result=await dispatchAction(store,action.id,async()=>{workflow=store.createConnectionWorkflow(action.id,input);return {setupRequestId:workflow.id};});assert.equal(result.state,'succeeded');
  store.finishTurn(turn.id,'completed',null);return workflow!;
}
function fixture(t:{after(fn:()=>void):void}){const dir=mkdtempSync(join(tmpdir(),'dx-setup-workflow-'));let now=Date.now();const store=new HostStore({dataDir:dir,clock:()=>now});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,advance:()=>{now+=30*60_000;}};}
const selections=[{connectionId:'con_synthetic',expectedRevision:1,tools:[{name:'gmail.read',manifestHash:'b'.repeat(64)}]}];
test('exact owner setup commits one correlated continuation, keeps original input and deduplicates complete/cancel ids',async t=>{
  const {store}=fixture(t),request=await pending(store),input={expectedHostID:store.hostId,clientRequestId:randomUUID(),expectedRevision:request.revision,selections};
  const ready=store.completeConnectionWorkflow(request.id,input);assert.equal(ready.state,'ready');assert.ok(ready.continuationTurnId);
  assert.deepEqual(store.completeConnectionWorkflow(request.id,input),ready);
  assert.equal(store.listTurns(request.threadId).length,2);assert.equal(store.getTurn(ready.continuationTurnId!).inputMessageId,store.getTurn(request.originTurnId).inputMessageId);
  assert.match(store.turnInput(ready.continuationTurnId!),/HOST CONNECTION SETUP RESULT/);assert.match(store.turnInput(ready.continuationTurnId!),/Do not repeat previous terminal effects/);
  assert(store.turnInput(ready.continuationTurnId!).includes(`"actionId":"${request.actionId}"`));assert(store.turnInput(ready.continuationTurnId!).includes(`"requestHash":"${store.getAction(request.actionId).requestHash}"`));assert(store.turnInput(ready.continuationTurnId!).includes('"state":"succeeded"'));
  assert.throws(()=>store.completeConnectionWorkflow(request.id,{...input,selections:[]}));
  assert.throws(()=>store.cancelConnectionWorkflow(request.id,{expectedHostID:store.hostId,clientRequestId:input.clientRequestId,expectedRevision:request.revision}));
});
test('Stop, expiry and cancelled request are inert even after a late successful login',async t=>{
  const f=fixture(t),first=await pending(f.store);f.store.withdrawTurnToolActions(first.originTurnId);assert.equal(f.store.connectionWorkflow(first.id)?.state,'stopped');
  assert.throws(()=>f.store.completeConnectionWorkflow(first.id,{expectedHostID:f.store.hostId,clientRequestId:randomUUID(),expectedRevision:1,selections}));
  const second=await pending(f.store),cancel={expectedHostID:f.store.hostId,clientRequestId:randomUUID(),expectedRevision:1};
  const cancelled=f.store.cancelConnectionWorkflow(second.id,cancel);assert.deepEqual(f.store.cancelConnectionWorkflow(second.id,cancel),cancelled);
  assert.throws(()=>f.store.cancelConnectionWorkflow(second.id,{...cancel,clientRequestId:randomUUID()}));
  const third=await pending(f.store);f.advance();assert.equal(f.store.connectionWorkflow(third.id)?.state,'expired');assert.throws(()=>f.store.completeConnectionWorkflow(third.id,{expectedHostID:f.store.hostId,clientRequestId:randomUUID(),expectedRevision:1,selections}));
  assert.equal(f.store.listTurns(third.threadId).length,1);
});
