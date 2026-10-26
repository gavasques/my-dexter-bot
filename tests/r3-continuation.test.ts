import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { ToolExecutionFailure, type Action, type ConnectionWorkflow } from "@dexter/contracts";
import type { EngineDriver, EngineEvent } from "@dexter/engines";
import { HostStore, ConversationRuntime, canonicalJson, dispatchAction } from "@dexter/hub";
import { CapabilityGateway } from "@dexter/gateway";
import type { ConnectionsAdmin, NativeMcpAdmin } from "@dexter/connectors";
import { connectionWorkflows } from "../packages/cli/src/connection-workflows.js";

const SETUP="dexter.harness.connections.request",DESTINATION="dexter-harness-owner-proposals",HASH="a".repeat(64);
const manifest={name:"fixture.write",toolkit:"fixture",version:"1.0.0",upstreamSlug:"WRITE",upstreamHost:"fixture.example.test",description:"Synthetic write",effect:"write" as const,
  destinationArgument:null,destinationOrigins:null,inputSchema:{type:"object" as const,properties:{input:{type:"string" as const,maxLength:64}},required:[],additionalProperties:false as const}};
const until=async(check:()=>boolean)=>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw new Error("Synthetic continuation deadline");await new Promise(resolve=>setTimeout(resolve,5));}};

async function fixture(t:TestContext,second:"note"|"setup"|null="note",gate?:Promise<void>){
  const dir=mkdtempSync(join(tmpdir(),"dx-r3-continuation-")),store=new HostStore({dataDir:dir});let effects=0;
  const gateway=new CapabilityGateway({store,broker:{acquire:()=>({headers:{}}),secretValues:()=>[]},adapter:{execute:async()=>{effects++;return {ok:true};}}});
  const bot=store.createBot({name:"Synthetic continuation",profileId:"default",engine:"claude"}),thread=store.createThread(bot.id);
  gateway.registerTool(manifest);const connection=gateway.connectAccount({profileId:"default",toolkit:"fixture",label:"Synthetic",upstreamAccountRef:"synthetic",credentialRef:"fixture",allowedHosts:[manifest.upstreamHost]});
  store.setGrant({botId:bot.id,tool:manifest.name,destination:connection.id,policy:"allow"});
  const origin=store.createTurn(thread.id,{clientRequestId:randomUUID(),content:"Perform the synthetic terminal write once."}).turn;store.claimNextTurn(thread.id);
  for(const tool of [SETUP,"fixture.note"])store.setGrant({botId:bot.id,tool,destination:DESTINATION,policy:"ask"});
  const propose=(tool:string,callId:string)=>{const input=tool===SETUP?{clientRequestId:randomUUID(),expectedBotRevision:bot.revision,target:{kind:"managed",serviceId:"fixture",catalogPin:HASH}}:{note:"synthetic"};
    const action=store.requestAction({botId:bot.id,threadId:thread.id,tool,destination:DESTINATION,arguments:{input},idempotencyKey:randomUUID()});store.bindToolAction(action.id,origin.id,callId);return action;};
  const a=propose(SETUP,"setup-a"),b=second?propose(second==="setup"?SETUP:"fixture.note","sibling-b"):null;store.finishTurn(origin.id,"completed",null);
  let runtime!:ConversationRuntime;const inputs:string[]=[],receipts:{actionId:string;status:string}[]=[];
  const driver:EngineDriver={id:"claude",capabilities:{resume:true,interrupt:true,fork:false,steer:false},status:async()=>({engine:"claude",installed:true,version:"synthetic",authentication:"authenticated",billing:"subscription"}),
    open:async(threadId)=>({threadId,nativeCursor:"synthetic"}),
    async *turn(session,turnId,input):AsyncIterable<EngineEvent>{inputs.push(input);if(input.includes("Host tool continuation.")&&gate)await gate;
      // Deliberately ignore receipt-only prose: enforcement must still deduplicate the effect.
      const result=await gateway.call(gateway.issueCapability({turnId}).token,{callId:`write-${turnId}`,tool:manifest.name,connectionId:connection.id,arguments:{}});receipts.push(result);
      yield {type:"tool.result.observed",threadId:session.threadId,turnId,actionId:result.actionId,requestHash:result.requestHash,status:result.status};
      yield {type:"turn.completed",threadId:session.threadId,turnId,usage:null};},respondToTool:async()=>{},interrupt:async()=>{},close:async()=>{}};
  const tool=gateway.registry.getTool(manifest.name)!;
  const workflows=connectionWorkflows(store,{gateway:()=>gateway,native:()=>({}) as Readonly<NativeMcpAdmin>,runtime:()=>runtime,
    managed:()=>({catalog:async()=>({pin:HASH,services:[{serviceId:"fixture",availability:{state:"available"}}]}),accounts:()=>({items:[{gatewayConnectionIds:[connection.id],status:"connected",serviceId:"fixture",profileId:"default",tools:[{name:manifest.name,manifestHash:tool.manifestHash}]}]})}) as unknown as Readonly<ConnectionsAdmin>});
  runtime=new ConversationRuntime({store,drivers:[driver],abortGraceMs:20,turnTimeoutMs:5000,ownerActionContinuation:action=>dispatchAction(store,action.id,async()=>action.request.tool===SETUP?{setupRequestId:(await workflows.request(action.id,action.request.arguments.input as never)).id}:{noted:true})});
  t.after(async()=>{await runtime.shutdown({closeStore:false});gateway.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const approve=async(action:Action)=>{runtime.decideAction(action.id,{decision:"allow",requestHash:action.requestHash});await until(()=>store.getAction(action.id).state==="succeeded");};
  const complete=(action=a)=>{const workflow=store.connectionWorkflow(`setup_${action.id}`)!;return workflows.complete(workflow.id,{expectedHostID:store.hostId,clientRequestId:randomUUID(),expectedRevision:workflow.revision,
    selections:[{connectionId:connection.id,expectedRevision:connection.revision,tools:[{name:manifest.name,manifestHash:tool.manifestHash}]}]});};
  const drain=()=>until(()=>store.listTurns(thread.id).every(turn=>!["queued","running"].includes(turn.state))&&runtime.status().pending.turns===0);
  return {store,gateway,runtime,workflows,bot,thread,origin,a,b,approve,complete,drain,inputs,receipts,effects:()=>effects,connection};
}

test("R3 S2: late sibling delivers its receipt without re-presenting the task or repeating the effect",async t=>{
  const f=await fixture(t);await f.approve(f.a);f.complete();await f.drain();await f.approve(f.b!);await f.drain();
  assert.equal(f.effects(),1);assert.equal(f.inputs.length,2);assert.equal(f.inputs.filter(input=>input.includes("Original request:")||input.includes("Original user request")).length,1);
  assert.ok(f.inputs[1]!.includes("Receipt delivery only"));assert.ok(f.inputs[1]!.includes(f.b!.id));assert.equal(f.receipts[0]!.actionId,f.receipts[1]!.actionId);
});
test("R3 S3: completed generic sibling is canonical; later setup is receipt-only and reuses the effect",async t=>{
  const f=await fixture(t);await f.approve(f.a);await f.approve(f.b!);await f.drain();f.complete();await f.drain();
  assert.equal(f.effects(),1);assert.equal(f.inputs.filter(input=>input.includes("Original user request")||input.includes("Original request:")).length,1);assert.ok(f.inputs[1]!.includes("Receipt delivery only"));
});
test("R3 S3q: complete refuses a running sibling; reconciled completion delivers only setup receipt",async t=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});t.after(()=>release());const f=await fixture(t,"note",gate);
  await f.approve(f.a);await f.approve(f.b!);await until(()=>f.inputs.length===1);assert.throws(()=>f.complete(),error=>!!error&&typeof error==="object"&&"code"in error&&error.code==="conflict");
  assert.equal(f.store.connectionWorkflow(`setup_${f.a.id}`)?.state,"awaiting_user");release();await f.drain();f.complete();await f.drain();assert.equal(f.effects(),1);
  assert.equal(f.inputs.filter(input=>input.includes("Original user request")||input.includes("Original request:")).length,1);
});
test("R3 S5: two setups keep exact receipts but only one task continuation",async t=>{
  const f=await fixture(t,"setup");await f.approve(f.a);await f.approve(f.b!);const first=f.complete(f.a);await f.drain();const second=f.complete(f.b!);await f.drain();
  assert.equal(f.effects(),1);assert.notEqual(first.id,second.id);assert.equal(f.inputs.filter(input=>input.includes("Original request:")).length,1);assert.ok(f.inputs[1]!.includes(f.b!.id));
});
test("R3 S3 queued: completing a second setup is refused until the first queued continuation reconciles",async t=>{
  const f=await fixture(t,"setup");await f.approve(f.a);await f.approve(f.b!);
  const workflow=f.store.connectionWorkflow(`setup_${f.a.id}`)!;
  const first=f.store.completeConnectionWorkflow(workflow.id,{expectedHostID:f.store.hostId,clientRequestId:randomUUID(),expectedRevision:1,
    selections:[{connectionId:f.connection.id,expectedRevision:1,tools:[{name:manifest.name,manifestHash:f.gateway.registry.getTool(manifest.name)!.manifestHash}]}]});
  assert.equal(f.store.getTurn(first.continuationTurnId!).state,"queued");assert.throws(()=>f.complete(f.b!),error=>!!error&&typeof error==="object"&&"code"in error&&error.code==="conflict");
  f.runtime.scheduleConnectionWorkflow(first.id);await f.drain();f.complete(f.b!);await f.drain();assert.equal(f.effects(),1);
  assert.equal(f.inputs.filter(input=>input.includes("Original request:")).length,1);
});
test("R3 receipt reuse is scoped to canonical input, tool, account and real continuation ancestry",async t=>{
  const f=await fixture(t,null);await f.approve(f.a);const ready=f.complete();await f.drain();
  const replay=f.store.replayedContinuationAction(ready.continuationTurnId!,manifest.name,f.connection.id,{});assert.equal(replay?.id,f.receipts[0]!.actionId);
  assert.equal(f.store.replayedContinuationAction(ready.continuationTurnId!,manifest.name,f.connection.id,{different:true}),null);
  assert.equal(f.store.replayedContinuationAction(ready.continuationTurnId!,"fixture.other",f.connection.id,{}),null);
  assert.equal(f.store.replayedContinuationAction(ready.continuationTurnId!,manifest.name,"conn_other",{}),null);
  const independent=f.store.createTurn(f.thread.id,{clientRequestId:randomUUID(),content:"Independent synthetic task"}).turn;
  assert.equal(f.store.replayedContinuationAction(independent.id,manifest.name,f.connection.id,{}),null);
  assert.equal(f.effects(),1);
});

for(const state of ["before_dispatch","after_dispatch","denied"] as const)for(const namedInput of [false,true])test(`R3 replay: ${state} stays distinct after setup${namedInput?" with an upstream argument named input":""}`,async t=>{
  const dir=mkdtempSync(join(tmpdir(),"dx-r3-recovery-")),store=new HostStore({dataDir:dir});let connected=false,effects=0;
  const gateway=new CapabilityGateway({store,broker:{acquire:()=>({headers:{}}),secretValues:()=>[]},adapter:{execute:async()=>{if(!connected){if(state==="after_dispatch")effects++;throw new ToolExecutionFailure("credential_unavailable",state==="after_dispatch"?"after_dispatch":"before_dispatch");}effects++;return {ok:true};}}});
  t.after(()=>{gateway.close();store.close();rmSync(dir,{recursive:true,force:true});});const bot=store.createBot({name:"Synthetic recovery",profileId:"default",engine:"claude"}),thread=store.createThread(bot.id);
  gateway.registerTool(manifest);const connection=gateway.connectAccount({profileId:"default",toolkit:"fixture",label:"Synthetic",upstreamAccountRef:"synthetic",credentialRef:"fixture",allowedHosts:[manifest.upstreamHost]});
  store.setGrant({botId:bot.id,tool:manifest.name,destination:connection.id,policy:state==="denied"?"ask":"allow"});const origin=store.createTurn(thread.id,{clientRequestId:randomUUID(),content:"Recover synthetic account and write once."}).turn;store.claimNextTurn(thread.id);
  const arguments_=namedInput?{input:"synthetic"}:{};
  let original=await gateway.call(gateway.issueCapability({turnId:origin.id}).token,{callId:"original-write",tool:manifest.name,connectionId:connection.id,arguments:arguments_});
  if(state==="denied"){store.decideAction(original.actionId,{decision:"deny",requestHash:original.requestHash});original={...original,status:"denied"};}
  store.setGrant({botId:bot.id,tool:SETUP,destination:DESTINATION,policy:"ask"});const action=store.requestAction({botId:bot.id,threadId:thread.id,tool:SETUP,destination:DESTINATION,arguments:{},idempotencyKey:randomUUID()});store.bindToolAction(action.id,origin.id,"setup");store.decideAction(action.id,{decision:"allow",requestHash:action.requestHash});
  let workflow!:ConnectionWorkflow;await dispatchAction(store,action.id,async()=>{workflow=store.createConnectionWorkflow(action.id,{clientRequestId:randomUUID(),expectedBotRevision:bot.revision,target:{kind:"managed",serviceId:"fixture",catalogPin:HASH}});return {requestId:workflow.id};});
  store.finishTurn(origin.id,"completed",null);connected=true;store.setGrant({botId:bot.id,tool:manifest.name,destination:connection.id,policy:"allow"});
  workflow=store.completeConnectionWorkflow(workflow.id,{expectedHostID:store.hostId,clientRequestId:randomUUID(),expectedRevision:1,selections:[{connectionId:connection.id,expectedRevision:1,tools:[{name:manifest.name,manifestHash:gateway.registry.getTool(manifest.name)!.manifestHash}]}]});store.claimNextTurn(thread.id);
  const result=await gateway.call(gateway.issueCapability({turnId:workflow.continuationTurnId!}).token,{callId:"after-setup-write",tool:manifest.name,connectionId:connection.id,arguments:arguments_});
  assert.equal(effects,state==="denied"?0:1);if(state==="before_dispatch"){assert.equal(result.status,"succeeded");assert.notEqual(result.actionId,original.actionId);}else{assert.equal(result.actionId,original.actionId);assert.equal(result.status,state==="denied"?"denied":"unknown");}
});

test("R3 delegated setup is refused before creating a workflow, even while the delegation is live",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"dx-r3-delegation-")),store=new HostStore({dataDir:dir});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const parent=store.createBot({name:"Parent",profileId:"default",engine:"claude"}),child=store.createBot({name:"Child",profileId:"default",engine:"claude"});
  for(const bot of [parent,child])store.patchBot(bot.id,{expectedRevision:0,canSeeBots:true,canSendActions:true,canReceiveOrders:true,...(bot.id===parent.id?{isMaster:true}:{})});
  const thread=store.createThread(parent.id),origin=store.createTurn(thread.id,{clientRequestId:randomUUID(),content:"Synthetic delegation"}).turn;store.claimNextTurn(thread.id);
  const {delegation}=store.createDelegation(origin.id,"delegate",{targetBotId:child.id,task:"Synthetic setup task"},store.now()+60000);store.claimNextTurn(delegation.targetThreadId);
  store.setGrant({botId:child.id,tool:SETUP,destination:DESTINATION,policy:"ask"});const action=store.requestAction({botId:child.id,threadId:delegation.targetThreadId,tool:SETUP,destination:DESTINATION,arguments:{},idempotencyKey:randomUUID()});store.bindToolAction(action.id,delegation.targetTurnId,"setup");store.decideAction(action.id,{decision:"allow",requestHash:action.requestHash});
  const request={clientRequestId:randomUUID(),expectedBotRevision:store.getBot(child.id).revision,target:{kind:"native_mcp" as const,serverId:"fixture",instancePin:HASH}};
  const coordinator=connectionWorkflows(store,{gateway:()=>{throw new Error("Unused synthetic gateway");},managed:()=>{throw new Error("Unused synthetic managed catalog");},
    native:()=>({instancePin:()=>HASH}) as unknown as Readonly<NativeMcpAdmin>,runtime:()=>{throw new Error("Unused synthetic runtime");}});
  const refused=await dispatchAction(store,action.id,async()=>{await coordinator.request(action.id,request);return {unexpected:true};});
  assert.equal(refused.state,"blocked");assert.equal((refused.result as {effectDispatched:boolean}).effectDispatched,false);
  assert.equal(store.connectionWorkflows().length,0);store.finishTurn(delegation.targetTurnId,"completed",null);store.updateDelegation(delegation.id,"completed","done");store.finishTurn(origin.id,"completed",null);
  assert.throws(()=>store.assertDelegationDispatch(delegation.targetTurnId));assert.equal(store.listTurns(delegation.targetThreadId).length,1);
});
test("R3 legacy setup continuation retains delegation identity and becomes inert when its parent retires",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"dx-r3-legacy-delegation-")),store=new HostStore({dataDir:dir});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const parent=store.createBot({name:"Parent",profileId:"default",engine:"claude"}),child=store.createBot({name:"Child",profileId:"default",engine:"claude"});
  for(const bot of [parent,child])store.patchBot(bot.id,{expectedRevision:0,canSeeBots:true,canSendActions:true,canReceiveOrders:true,...(bot.id===parent.id?{isMaster:true}:{})});
  const thread=store.createThread(parent.id),origin=store.createTurn(thread.id,{clientRequestId:randomUUID(),content:"Synthetic legacy delegation"}).turn;store.claimNextTurn(thread.id);
  const {delegation}=store.createDelegation(origin.id,"delegate",{targetBotId:child.id,task:"Synthetic legacy setup"},store.now()+60000);store.claimNextTurn(delegation.targetThreadId);
  const request={clientRequestId:randomUUID(),expectedBotRevision:store.getBot(child.id).revision,target:{kind:"native_mcp" as const,serverId:"fixture",instancePin:HASH}};
  store.setGrant({botId:child.id,tool:SETUP,destination:DESTINATION,policy:"ask"});const action=store.requestAction({botId:child.id,threadId:delegation.targetThreadId,tool:SETUP,destination:DESTINATION,arguments:{input:request},idempotencyKey:randomUUID()});store.bindToolAction(action.id,delegation.targetTurnId,"setup");store.decideAction(action.id,{decision:"allow",requestHash:action.requestHash});
  const workflow:ConnectionWorkflow={version:1,id:`setup_${action.id}`,hostId:store.hostId,botId:child.id,threadId:delegation.targetThreadId,originTurnId:delegation.targetTurnId,actionId:action.id,
    clientRequestId:request.clientRequestId,requestHash:createHash("sha256").update(canonicalJson(request)).digest("hex"),target:request.target,revision:1,state:"awaiting_user",createdAt:store.now(),expiresAt:store.now()+1800000,selections:[],continuationTurnId:null};
  await dispatchAction(store,action.id,async()=>{const db=new DatabaseSync(store.databasePath);try{db.prepare("INSERT INTO meta(key,value)VALUES(?,?)").run(`connection_setup_v1:${workflow.id}`,canonicalJson(workflow));
    db.prepare("INSERT INTO meta(key,value)VALUES(?,?)").run(`connection_setup_request_v1:${workflow.clientRequestId}`,workflow.id);}finally{db.close();}return {setupRequestId:workflow.id};});
  store.finishTurn(delegation.targetTurnId,"completed",null);
  const ready=store.completeConnectionWorkflow(workflow.id,{expectedHostID:store.hostId,clientRequestId:randomUUID(),expectedRevision:1,selections:[{connectionId:"conn_fixture",expectedRevision:1,tools:[{name:manifest.name,manifestHash:HASH}]}]});
  assert.equal(store.delegationForTurn(ready.continuationTurnId!)?.id,delegation.id);store.assertDelegationDispatch(ready.continuationTurnId!);
  store.updateDelegation(delegation.id,"completed","finished");store.finishTurn(origin.id,"completed",null);
  assert.throws(()=>store.assertDelegationDispatch(ready.continuationTurnId!));assert.throws(()=>store.turnInput(ready.continuationTurnId!));
  const runtime=new ConversationRuntime({store,drivers:[]});t.after(()=>runtime.shutdown({closeStore:false}));assert.throws(()=>runtime.scheduleConnectionWorkflow(workflow.id));
});
test("R3 setup admission pin/provider failures have durable before_dispatch receipts",async t=>{
  const f=await fixture(t,null);const input=f.a.request.arguments.input as never;
  const bad=connectionWorkflows(f.store,{gateway:()=>f.gateway,native:()=>({}) as Readonly<NativeMcpAdmin>,runtime:()=>f.runtime,
    managed:()=>({catalog:async()=>{throw new Error("Synthetic unavailable provider");}}) as unknown as Readonly<ConnectionsAdmin>});
  f.store.decideAction(f.a.id,{decision:"allow",requestHash:f.a.requestHash});
  const receipt=await dispatchAction(f.store,f.a.id,async()=>{await bad.request(f.a.id,input);return {unexpected:true};});
  assert.equal(receipt.state,"blocked");assert.equal((receipt.result as {effectDispatched:boolean}).effectDispatched,false);assert.equal(f.store.connectionWorkflows().length,0);assert.equal(f.effects(),0);
});
test("R3 exact complete replay after ready → stopped returns original receipt without scheduling",async t=>{
  const f=await fixture(t,null);await f.approve(f.a);const workflow=f.store.connectionWorkflow(`setup_${f.a.id}`)!,input={expectedHostID:f.store.hostId,clientRequestId:randomUUID(),expectedRevision:1,
    selections:[{connectionId:f.connection.id,expectedRevision:1,tools:[{name:manifest.name,manifestHash:f.gateway.registry.getTool(manifest.name)!.manifestHash}]}]};
  const ready=f.workflows.complete(workflow.id,input);await f.drain();f.store.withdrawTurnToolActions(f.origin.id);assert.equal(f.store.connectionWorkflow(workflow.id)?.state,"stopped");
  assert.deepEqual(f.workflows.complete(workflow.id,input),ready);assert.equal(f.store.listTurns(f.thread.id).length,2);assert.equal(f.effects(),1);
});
test("R3 complete replay recovers a scheduler failure after commit without another continuation",async t=>{
  const f=await fixture(t,null);await f.approve(f.a);const workflow=f.store.connectionWorkflow(`setup_${f.a.id}`)!,input={expectedHostID:f.store.hostId,clientRequestId:randomUUID(),expectedRevision:1,
    selections:[{connectionId:f.connection.id,expectedRevision:1,tools:[{name:manifest.name,manifestHash:f.gateway.registry.getTool(manifest.name)!.manifestHash}]}]};
  const schedule=f.runtime.scheduleConnectionWorkflow.bind(f.runtime);let attempts=0;
  f.runtime.scheduleConnectionWorkflow=id=>{attempts++;if(attempts===1)throw new Error("Synthetic scheduler failure after durable commit");schedule(id);};
  assert.throws(()=>f.workflows.complete(workflow.id,input));const committed=f.store.connectionWorkflow(workflow.id)!;assert.equal(committed.state,"ready");
  assert.deepEqual(f.workflows.complete(workflow.id,input),committed);await f.drain();assert.equal(attempts,2);assert.equal(f.store.listTurns(f.thread.id).length,2);assert.equal(f.effects(),1);
});
