import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultEngineSelection, ThreadEngineSelectionSchema } from "@dexter/contracts";
import { ConversationRuntime, HostStore, type RuntimeDriver } from "@dexter/hub";
import { createAuthorizedHostRouter, createHostApp, type HostRequestAuthority } from "@dexter/hub/http";

test("combined selection atomically checks both revisions, propagates safe inheritance and remains owner-local",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-selection-scope-")),store=new HostStore({dataDir:dir});
  const bot=store.createBot({name:"Synthetic",profileId:"synthetic",engine:"claude"});
  const chosen=store.createThread(bot.id),inherited=store.createThread(bot.id),explicit=store.createThread(bot.id);
  const first={...defaultEngineSelection("claude"),model:"first"},second={...defaultEngineSelection("claude"),model:"second"};
  store.patchThreadEngineSelection(chosen.id,{expectedRevision:0,selection:first});
  store.patchThreadEngineSelection(explicit.id,{expectedRevision:0,selection:first});
  store.appendMessage(chosen.id,{clientMessageId:"chosen",content:"Synthetic chosen context"});
  store.appendMessage(inherited.id,{clientMessageId:"inherited",content:"Synthetic inherited context"});
  let runs=0;
  const driver:RuntimeDriver={id:"claude",async open(threadId){return {threadId,nativeCursor:"synthetic_cursor"};},
    async *turn(){runs++;throw new Error("Choosing settings must not infer.");},
    async respondToTool(){},async interrupt(){},async close(){}};
  const runtime=new ConversationRuntime({store,drivers:[driver],engineCatalog:()=>[{id:"claude",available:true,defaultModel:null,
    reasoningEfforts:[],speeds:[],models:[{id:"first",reasoningEfforts:[],speeds:[]},{id:"second",reasoningEfforts:[],speeds:[]}]}]});
  t.after(async()=>{await runtime.shutdown();rmSync(dir,{recursive:true,force:true});});
  const snapshot=()=>JSON.stringify({bot:store.getBot(bot.id),threads:[chosen,inherited,explicit].map(thread=>store.getThreadEngineSelection(thread.id))});
  const initial=snapshot(),request={expectedRevision:1,selection:second,scope:"thread_and_bot",expectedBotRevision:0};
  assert.throws(()=>store.patchThreadEngineSelection(chosen.id,{...request,expectedRevision:0}));
  assert.equal(snapshot(),initial);
  assert.throws(()=>store.patchThreadEngineSelection(chosen.id,{...request,expectedBotRevision:1}));
  assert.equal(snapshot(),initial);
  const queued=store.createTurn(inherited.id,{clientRequestId:"blocked",content:"Synthetic queued input"});
  await assert.rejects(runtime.patchThreadEngineSelection(chosen.id,request));
  assert.equal(snapshot(),initial);store.cancelQueuedTurn(queued.turn.id);
  store.setGrant({botId:bot.id,tool:"mail.send",destination:"synthetic",policy:"ask"});
  const pending=store.requestAction({botId:bot.id,threadId:inherited.id,tool:"mail.send",destination:"synthetic",arguments:{text:"synthetic"},idempotencyKey:"synthetic"});
  await assert.rejects(runtime.patchThreadEngineSelection(chosen.id,request));
  assert.equal(snapshot(),initial);
  store.decideAction(pending.id,{decision:"deny",requestHash:pending.requestHash});

  const remote=createAuthorizedHostRouter(store,{runtime});
  const authority:HostRequestAuthority={principal:"paired-client",installationId:store.hostId,ownerId:store.ownerId,
    deviceId:"synthetic_client",role:"client-ios",scopes:["chat.write"],pinGeneration:1,bindingRevision:1,
    assertCurrent(){},noteSelfRevoke(){}};
  const json=(body:unknown)=>({method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  assert.equal((await remote.fetch(new Request(`https://synthetic.invalid/v1/threads/${chosen.id}/engine-selection`,json(request)),{authority})).status,403);
  assert.equal(snapshot(),initial);
  // A busy explicit override is unaffected by changing the bot default.
  const explicitQueued=store.createTurn(explicit.id,{clientRequestId:"explicit",content:"Synthetic independent input"});
  const response=await createHostApp(store,{runtime}).request(`http://127.0.0.1/v1/threads/${chosen.id}/engine-selection`,json(request));
  assert.equal(response.status,200);
  const result=ThreadEngineSelectionSchema.parse(await response.json());
  assert.deepEqual(result.selection,second);assert.deepEqual(result.override,second);assert.equal(result.revision,2);
  assert.equal(result.updatedBot?.id,bot.id);assert.equal(result.updatedBot?.revision,1);assert.deepEqual(result.updatedBot?.defaultSelection,second);
  assert.equal(result.handoffStatus,"ready");
  assert.deepEqual(store.getThreadEngineSelection(inherited.id),{selection:second,override:null,revision:1,handoffStatus:"ready"});
  assert.deepEqual(store.getThreadEngineSelection(explicit.id),{selection:first,override:first,revision:1,handoffStatus:"none"});
  store.cancelQueuedTurn(explicitQueued.turn.id);
  assert.equal(runs,0);
});
