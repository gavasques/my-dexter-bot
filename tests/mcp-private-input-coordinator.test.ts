import assert from'node:assert/strict';import{test}from'node:test';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{randomUUID}from'node:crypto';
import{HostStore}from'@dexter/hub';import{CapabilityGateway,type AdapterCall}from'@dexter/gateway';import{McpPrivateInputCoordinator}from'../packages/cli/src/mcp-private-input.js';
async function f(t:{after(fn:()=>Promise<void>):void}){
  const dir=mkdtempSync(join(tmpdir(),'dx-mrtr-coordinator-')),store=new HostStore({dataDir:dir});let coordinator:McpPrivateInputCoordinator;
  const gateway=new CapabilityGateway({store,broker:{acquire:()=>({headers:{}}),secretValues:()=>[]},adapter:{execute:async(call:AdapterCall,_auth,context)=>{
    const response=await coordinator.request(call,{r1:{method:'elicitation/create',params:{mode:'form',message:'Confirm this synthetic operation',requestedSchema:{type:'object',properties:{confirm:{type:'boolean'}},required:['confirm'],additionalProperties:false}}}},context.signal);
    return {isError:false,structuredContent:{confirmed:(response.r1 as {content:{confirm:boolean}}).content.confirm}};
  }}});coordinator=new McpPrivateInputCoordinator(store,()=>gateway);
  t.after(async()=>{coordinator.close();gateway.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const bot=store.createBot({name:'Synthetic',profileId:'default',engine:'claude'}),thread=store.createThread(bot.id),turn=store.createTurn(thread.id,{clientRequestId:randomUUID(),content:'Synthetic operation'}).turn;store.claimNextTurn(thread.id);
  gateway.registerTool({name:'fixture.write',toolkit:'fixture',version:'1.0.0',upstreamSlug:'WRITE',upstreamHost:'fixture.example.test',description:'Synthetic',effect:'write',destinationArgument:null,destinationOrigins:null,inputSchema:{type:'object',properties:{},required:[],additionalProperties:false}});
  const connection=gateway.connectAccount({profileId:'default',toolkit:'fixture',label:'Synthetic',upstreamAccountRef:'synthetic',credentialRef:'fixture',allowedHosts:['fixture.example.test']});store.setGrant({botId:bot.id,tool:'fixture.write',destination:connection.id,policy:'allow'});
  const cap=gateway.issueCapability({turnId:turn.id}),controller=new AbortController(),operation=gateway.call(cap.token,{callId:'one',tool:'fixture.write',connectionId:connection.id,arguments:{}},{signal:controller.signal});
  let input=coordinator.list().requests[0];for(let n=0;!input&&n<50;n++){await new Promise(r=>setTimeout(r,5));input=coordinator.list().requests[0];}assert.ok(input);
  return{store,gateway,coordinator,operation,input,controller,turn};
}
test('human exact input review resolves the original action, deduplicates response and stores only a hash',async t=>{
  const f0=await f(t),{input,coordinator,store}=f0,body={expectedHostID:store.hostId,clientRequestId:randomUUID(),expectedRevision:input.revision,actionId:input.actionId,requestHash:input.requestHash,responses:{r1:{action:'accept',content:{confirm:true}}},approval:'approve_exact_input'};
  assert.throws(()=>coordinator.respond(input.id,{...body,approval:undefined}));
  const receipt=coordinator.respond(input.id,body);assert.equal(receipt.state,'answered');assert.ok(receipt.responseHash);assert.ok(!('responses'in receipt));
  assert.deepEqual(coordinator.respond(input.id,body),receipt);assert.throws(()=>coordinator.respond(input.id,{...body,responses:{r1:{action:'accept',content:{confirm:false}}}}));
  const done=await f0.operation;assert.equal(done.actionId,input.actionId);assert.equal(done.status,'succeeded');assert.equal(store.listActions().length,1);
});
test('Stop and original RPC abort make late forms inert and retain the original uncertain receipt',async t=>{
  const f0=await f(t);f0.store.withdrawTurnToolActions(f0.turn.id);f0.controller.abort();
  assert.throws(()=>f0.coordinator.respond(f0.input.id,{expectedHostID:f0.store.hostId,clientRequestId:randomUUID(),expectedRevision:1,actionId:f0.input.actionId,requestHash:f0.input.requestHash,approval:'approve_exact_input',responses:{r1:{action:'accept',content:{confirm:true}}}}));
  const outcome=await f0.operation;assert.equal(outcome.actionId,f0.input.actionId);assert.equal(outcome.status,'unknown');assert.equal(f0.store.listActions().length,1);
});
