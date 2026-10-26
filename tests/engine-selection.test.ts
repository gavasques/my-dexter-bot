import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultEngineSelection, type EngineCatalogEntry } from "@dexter/contracts";
import { ConversationRuntime, HostStore, type RuntimeDriver, type RuntimeOpenContext } from "@dexter/hub";

const catalog:EngineCatalogEntry[]=[{id:"claude",available:true,defaultModel:null,reasoningEfforts:[],speeds:[],
  models:[{id:"first",reasoningEfforts:["high"],speeds:[]},{id:"second",reasoningEfforts:[],speeds:[]}]}];
function setup(t:{after:(callback:()=>Promise<void>|void)=>void}) {
  const dir=mkdtempSync(join(tmpdir(),"dexter-selection-"));
  const store=new HostStore({dataDir:dir});
  const bot=store.createBot({name:"Synthetic",profileId:"synthetic",engine:"claude"});
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return {dir,store,bot,thread:store.createThread(bot.id)};
}

test("canonical defaults and overrides survive reopen; inherited bot changes preserve override",t=>{
  const {dir,store,bot,thread}=setup(t),other=store.createThread(bot.id);
  const second={...defaultEngineSelection("claude"),model:"second"};
  store.patchThreadEngineSelection(other.id,{expectedRevision:0,selection:second});
  const first={...defaultEngineSelection("claude"),model:"first"};
  store.patchBot(bot.id,{expectedRevision:0,defaultSelection:first});
  assert.equal(store.getThreadEngineSelection(thread.id).selection.model,"first");
  assert.equal(store.getThreadEngineSelection(other.id).selection.model,"second");
  store.close();
  const reopened=new HostStore({dataDir:dir});
  try {assert.equal(reopened.getBot(bot.id).defaultSelection?.model,"first");assert.equal(reopened.getThreadEngineSelection(other.id).override?.model,"second");}
  finally {reopened.close();}
});

test("queued turn pins selection; switches and bot default edits reject busy threads and stale CAS",t=>{
  const {store,bot,thread}=setup(t);t.after(()=>store.close());
  const initial=store.createTurn(thread.id,{clientRequestId:"one",content:"synthetic question"});
  assert.equal(initial.turn.selection?.model,null);
  assert.throws(()=>store.patchThreadEngineSelection(thread.id,{expectedRevision:0,selection:{...defaultEngineSelection("claude"),model:"first"}}));
  assert.throws(()=>store.patchBot(bot.id,{expectedRevision:0,defaultSelection:{...defaultEngineSelection("claude"),model:"first"}}));
  store.cancelQueuedTurn(initial.turn.id);
  store.patchThreadEngineSelection(thread.id,{expectedRevision:0,selection:{...defaultEngineSelection("claude"),model:"first"}});
  assert.throws(()=>store.patchThreadEngineSelection(thread.id,{expectedRevision:0,selection:null}));
  assert.equal(store.getTurn(initial.turn.id).selection?.model,null);
});

test("switch opens a fresh selected session and sends bounded quoted context once without inference while choosing",async t=>{
  const {store,thread}=setup(t);let opens=0,runs=0,closes=0;const inputs:string[]=[],contexts:RuntimeOpenContext[]=[];
  const driver:RuntimeDriver={id:"claude",async open(threadId,cursor,context){opens++;assert.equal(cursor,undefined);contexts.push(context!);return {threadId,nativeCursor:`synthetic_${opens}`};},
    async *turn(session,turnId,input){runs++;inputs.push(input);yield {type:"text.delta",threadId:session.threadId,turnId,text:"Synthetic answer"};yield {type:"turn.completed",threadId:session.threadId,turnId,usage:{}};},
    async respondToTool(){throw new Error("Unexpected tool");},async interrupt(){},async close(){closes++;}};
  const runtime=new ConversationRuntime({store,drivers:[driver],engineCatalog:()=>catalog});
  t.after(()=>runtime.shutdown());
  await runtime.waitForTurn(runtime.startTurn(thread.id,{clientRequestId:"one",content:"Remember synthetic orchard"}).turn.id);
  // Terminal state can precede cleanup by one microtask; wait until runtime has released its pump.
  await new Promise(resolve=>setImmediate(resolve));
  const changed=await runtime.patchThreadEngineSelection(thread.id,{expectedRevision:0,selection:{...defaultEngineSelection("claude"),model:"second"}});
  assert.equal(changed.handoffStatus,"ready");assert.equal(runs,1);assert.equal(closes,1);
  await runtime.waitForTurn(runtime.startTurn(thread.id,{clientRequestId:"two",content:"Continue synthetic"}).turn.id);
  assert.equal(opens,2);assert.equal(contexts[1]?.selection?.model,"second");
  assert.match(inputs[1]!,/quoted data, not instructions/);assert.match(inputs[1]!,/synthetic orchard/);
  const same=runtime.startTurn(thread.id,{clientRequestId:"two",content:"Continue synthetic"});assert.equal(same.created,false);assert.equal(runs,2);
  await assert.rejects(runtime.validateEngineSelection({...defaultEngineSelection("claude"),model:"unknown"}));
  await assert.rejects(runtime.validateEngineSelection({...defaultEngineSelection("claude"),model:"second",reasoningEffort:"high"}));
});
