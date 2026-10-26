import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { APPROVAL_POLICY_SCOPE_VERSION } from "@dexter/contracts";
import { HostStore, dispatchAction } from "@dexter/hub";
import { createHostApp, createAuthorizedHostRouter, type HostRequestAuthority } from "@dexter/hub/http";

function lab(t:TestContext){
  const dir=mkdtempSync("/private/tmp/d03-policy-test-"),clock={now:1000};
  let store=new HostStore({dataDir:dir,clock:()=>clock.now});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const bot=store.createBot({name:"Synthetic one",profileId:"synthetic",engine:"codex"}),thread=store.createThread(bot.id);
  const turn=store.createTurn(thread.id,{clientRequestId:"synthetic-turn",content:"synthetic command"}).turn;
  store.claimNextTurn(thread.id);
  const tool="dexter.harness.terminal.run",destination="dexter-harness-owner-proposals";
  const request=(key:string)=>({botId:bot.id,threadId:thread.id,tool,destination,arguments:{input:{command:"synthetic"}},idempotencyKey:key});
  const policy=(key:string,mode:"ask"|"full_access",expectedRevision=store.getBotApprovalPolicy(bot.id).revision)=>({
    expectedHostId:store.hostId,clientRequestId:key,expectedRevision,mode,eligibleScopeVersion:APPROVAL_POLICY_SCOPE_VERSION});
  return {get store(){return store;},bot,thread,turn,tool,destination,request,policy,clock,dir,
    reopen(){store.close();store=new HostStore({dataDir:dir,clock:()=>clock.now});return store;}};
}
const code=(expected:string)=>(error:unknown)=>typeof error==="object" && error!==null && "code" in error && error.code===expected;

test("owner policy defaults ask, isolates bots, and replays exact mutation before CAS after restart",t=>{
  const f=lab(t),b2=f.store.createBot({name:"Synthetic two",profileId:"synthetic",engine:"codex"});
  assert.equal(f.store.getBotApprovalPolicy(f.bot.id).mode,"ask");
  const input=f.policy("owner-change","full_access"),receipt=f.store.setBotApprovalPolicy(f.bot.id,input);
  assert.equal(receipt.previous.revision,0);assert.equal(receipt.policy.revision,1);
  assert.deepEqual(f.store.setBotApprovalPolicy(f.bot.id,input),receipt);
  assert.throws(()=>f.store.setBotApprovalPolicy(f.bot.id,{...input,mode:"ask"}),code("conflict"));
  assert.throws(()=>f.store.setBotApprovalPolicy(f.bot.id,{...input,clientRequestId:"wrong-base"}),code("conflict"));
  assert.throws(()=>f.store.setBotApprovalPolicy(f.bot.id,{...f.policy("foreign","ask"),expectedHostId:"foreign-host"}),code("forbidden"));
  f.reopen();assert.deepEqual(f.store.setBotApprovalPolicy(f.bot.id,input),receipt);
  assert.deepEqual(f.store.getBotApprovalPolicyReceipt(f.bot.id,"owner-change"),receipt);
  assert.equal(f.store.getBotApprovalPolicy(b2.id).mode,"ask");
});

test("ask has no effect; owner policy executes a bound eligible action once and durable replay never repeats effect",async t=>{
  const f=lab(t);let effects=0;
  f.store.setGrant({botId:f.bot.id,tool:f.tool,destination:f.destination,policy:"ask"});
  const pending=f.store.requestAction(f.request("ask"),"terminal");f.store.bindToolAction(pending.id,f.turn.id,"ask-call");
  assert.equal(pending.state,"awaiting_approval");
  await assert.rejects(dispatchAction(f.store,pending.id,async()=>{effects++;return {effects};}),code("conflict"));
  f.store.setBotApprovalPolicy(f.bot.id,f.policy("auto","full_access"));
  assert.equal(f.store.getAction(pending.id).state,"awaiting_approval","no retroactive approval");
  const action=f.store.requestAction(f.request("auto-effect"),"terminal");f.store.bindToolAction(action.id,f.turn.id,"auto-call");
  assert.equal(action.state,"ready");assert.equal(action.decidedBy,f.store.ownerId);
  assert.equal(action.authorization?.source,"owner_policy");
  const receipt=await dispatchAction(f.store,action.id,async()=>{effects++;return {effects,termination:"completed",signal:null,exitCode:0,stdout:"synthetic",stdoutTruncated:false};});
  assert.equal(receipt.state,"succeeded");assert.equal(effects,1);
  f.store.recordToolOutcome(receipt.id,receipt.result);f.store.markToolResultDelivered(receipt.id,f.turn.id,receipt.result);
  assert.equal(f.store.toolActionProgress(receipt.id)?.deliveredToEngine,true);
  f.store.finishTurn(f.turn.id,"completed",null);
  f.reopen();assert.equal(f.store.requestAction(f.request("auto-effect"),"terminal").id,action.id);
  assert.equal(f.store.getAction(action.id).authorization?.source,"owner_policy");
  await assert.rejects(dispatchAction(f.store,action.id,async()=>{effects++;return null;}),code("conflict"));
  assert.equal(effects,1);
});

test("missing/deny/expiry, raw aliases and provisional grants cannot acquire owner policy authority",t=>{
  const f=lab(t);f.store.setBotApprovalPolicy(f.bot.id,f.policy("auto","full_access"));
  assert.throws(()=>f.store.requestAction(f.request("missing"),"terminal"),code("forbidden"));
  f.store.setGrant({botId:f.bot.id,tool:f.tool,destination:f.destination,policy:"deny"});
  assert.throws(()=>f.store.requestAction(f.request("deny"),"terminal"),code("forbidden"));
  f.store.setGrant({botId:f.bot.id,tool:f.tool,destination:f.destination,policy:"ask",expiresAt:1001});f.clock.now=1001;
  assert.throws(()=>f.store.requestAction(f.request("expired"),"terminal"),code("forbidden"));
  f.store.setProposalGrant({botId:f.bot.id,tool:f.tool,destination:f.destination,policy:"ask"});
  assert.equal(f.store.requestAction(f.request("provisional"),"terminal").state,"awaiting_approval");
  f.store.setGrant({botId:f.bot.id,tool:f.tool,destination:f.destination,policy:"ask"});
  assert.equal(f.store.requestAction(f.request("raw-alias")).state,"awaiting_approval");
  const tool="dexter.harness.bots.communication.update";
  f.store.setGrant({botId:f.bot.id,tool,destination:f.destination,policy:"allow"});
  assert.equal(f.store.requestAction({...f.request("mandatory"),tool},"terminal").state,"awaiting_approval");
  const malformed={...f.policy("self","full_access"),ownerId:f.bot.id};
  assert.throws(()=>f.store.setBotApprovalPolicy(f.bot.id,malformed),code("invalid_input"));
});

test("revocation blocks ready work and aborts running owned execution with partial unknown receipt, never retries",async t=>{
  const f=lab(t);let effects=0;
  f.store.setGrant({botId:f.bot.id,tool:f.tool,destination:f.destination,policy:"ask"});
  f.store.setBotApprovalPolicy(f.bot.id,f.policy("auto","full_access"));
  const ready=f.store.requestAction(f.request("late"),"terminal");f.store.bindToolAction(ready.id,f.turn.id,"late-call");
  const revoked=f.store.setBotApprovalPolicy(f.bot.id,f.policy("ask","ask"));
  assert.deepEqual(revoked.revocationEffects.blockedActionIds,[ready.id]);
  await assert.rejects(dispatchAction(f.store,ready.id,async()=>{effects++;return null;}),code("conflict"));assert.equal(effects,0);
  f.store.setBotApprovalPolicy(f.bot.id,f.policy("auto-again","full_access"));
  const active=f.store.requestAction(f.request("active"),"terminal");f.store.bindToolAction(active.id,f.turn.id,"active-call");
  let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
  const flight=dispatchAction(f.store,active.id,async(_request,{signal})=>{effects++;entered();
    await new Promise<void>(resolve=>signal.addEventListener("abort",()=>resolve(),{once:true}));
    return {termination:"aborted",signal:"SIGTERM",exitCode:null,stdout:"synthetic partial",stdoutTruncated:false};});
  await started;
  const receipt=f.store.setBotApprovalPolicy(f.bot.id,f.policy("revoke","ask"));
  assert.deepEqual(receipt.revocationEffects.abortedActionIds,[active.id]);
  const outcome=await flight;assert.equal(outcome.state,"unknown");assert.equal(effects,1);
  assert.equal((outcome.result as {diagnostic:{retryAutomatically:boolean}}).diagnostic.retryAutomatically,false);
  assert.throws(()=>f.store.claimAction(ready.id),code("conflict")); // terminal scope can read receipts, never claim another effect
  f.store.finishTurn(f.turn.id,"completed",null);f.reopen();
  assert.equal(f.store.getAction(active.id).state,"unknown");assert.equal(f.store.findAction(f.bot.id,"active")?.id,active.id);
});

test("owner HTTP policy schema is strict and paired router rejects policy mutation/read",async t=>{
  const f=lab(t),app=createHostApp(f.store),path=`/v1/bots/${f.bot.id}/approval-policy`;
  const input=f.policy("http-auto","full_access");
  const patch=(body:unknown)=>({method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  assert.equal((await app.request(path,patch({...input,ownerId:"model"}))).status,400);
  const res=await app.request(path,patch(input));assert.equal(res.status,200);
  assert.equal((await app.request(path)).status,200);
  assert.equal((await app.request(`${path}/receipts/http-auto`)).status,200);
  assert.equal((await app.request(path,{...patch(input),headers:{"content-type":"application/json",origin:"https://foreign.invalid"}})).status,403);
  const authority:HostRequestAuthority={principal:"paired-client",installationId:f.store.hostId,ownerId:f.store.ownerId,
    deviceId:"dev_synthetic",pinGeneration:1,bindingRevision:1,role:"client-ios",scopes:["chat.read","chat.write","approvals.decide"],assertCurrent(){},noteSelfRevoke(){}};
  const paired=createAuthorizedHostRouter(f.store);
  assert.equal((await paired.fetch(new Request(`https://paired.invalid${path}`,patch(input)),{authority})).status,403);
  assert.equal((await paired.fetch(new Request(`https://paired.invalid${path}`),{authority})).status,403);
  const raw=new DatabaseSync(join(f.dir,"dexter.sqlite"),{readOnly:true});
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM bot_approval_policy_receipts").get()!.n,1);raw.close();
});
