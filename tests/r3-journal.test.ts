import assert from "node:assert/strict";
import { createHash, createSecretKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { HostStore, canonicalJson, dispatchAction } from "@dexter/hub";
import { AuthorityCoordinator, LocalAuthorityController, OfflineMaintenance, openCheckpointArtifact, type SnapshotKey, type OwnerAuthority } from "@dexter/operations";
import type { ConnectionWorkflow, JsonValue } from "@dexter/contracts";
import { MCP_INSTANCE_SELECTION_SQL } from "@dexter/connectors";
// The Operations graph has an intentional exact/full admission cycle; enter its public module first.
await import("../packages/operations/src/index.js");
const { checkExactSchema }=await import("../packages/operations/src/exact.js");
const { checkFullSchema, FULL_SCHEMAS }=await import("../packages/operations/src/full-schemas.js");
const { validateHubMcpJournals }=await import("../packages/operations/src/mcp-journals.js");

const HASH="b".repeat(64),TOOL="mcp.fixture.write",DESTINATION="conn_fixture",AUTH="dexter.harness.mcp.authorize";
const idFor=(actionId:string)=>{const h=createHash("sha256").update(actionId).digest("hex");return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
const make=async(store:HostStore,state:"awaiting_user"|"cancelled"|"expired"|"ready",withReference=false)=>{
  const bot=store.createBot({name:`Synthetic native authorization ${state}`,engine:"claude",profileId:"default"}),thread=store.createThread(bot.id);
  const origin=store.createTurn(thread.id,{clientRequestId:randomUUID(),content:"Authorize the exact synthetic native instance."}).turn;store.claimNextTurn(thread.id);
  store.setGrant({botId:bot.id,tool:AUTH,destination:"dexter-harness-owner-proposals",policy:"ask"});
  store.setGrant({botId:bot.id,tool:TOOL,destination:DESTINATION,policy:"allow"});
  let reference:string|undefined;
  if(withReference){const tool="dexter.harness.mcp.discover";store.setGrant({botId:bot.id,tool,destination:"dexter-harness-owner-proposals",policy:"ask"});
    const prior=store.requestAction({botId:bot.id,threadId:thread.id,tool,destination:"dexter-harness-owner-proposals",arguments:{input:{serverId:"fixture"}},idempotencyKey:randomUUID()});
    store.bindToolAction(prior.id,origin.id,"discovery");store.decideAction(prior.id,{decision:"allow",requestHash:prior.requestHash});
    await dispatchAction(store,prior.id,async()=>({server:{id:"fixture"},instancePin:HASH}));reference=prior.id;}
  const input={serverId:"fixture",expectedInstancePin:HASH,...(reference?{actionId:reference}:{})};
  const action=store.requestAction({botId:bot.id,threadId:thread.id,tool:AUTH,destination:"dexter-harness-owner-proposals",idempotencyKey:randomUUID(),arguments:{input,
    pin:{instancePin:HASH,reachability:"reachable_own_selected_connection",receiptActionId:null,selectedTools:[TOOL],selectionHash:HASH},
    origin:{installationId:store.hostId,ownerId:store.ownerId,profileId:bot.profileId,botId:bot.id,threadId:thread.id,turnId:origin.id,expiresAt:store.now()+60000}}});
  store.bindToolAction(action.id,origin.id,"authorize");store.decideAction(action.id,{decision:"allow",requestHash:action.requestHash});
  let workflow!:ConnectionWorkflow;await dispatchAction(store,action.id,async()=>{workflow=store.createConnectionWorkflow(action.id,{clientRequestId:idFor(action.id),expectedBotRevision:bot.revision,
    target:{kind:"native_mcp",serverId:input.serverId,instancePin:input.expectedInstancePin}});return {kind:"mcp_authorization_handoff",serverId:input.serverId,instancePin:HASH,hostId:store.hostId,
      botId:bot.id,threadId:thread.id,actionId:action.id,requestHash:action.requestHash,expiresAt:store.now()+300000};});
  store.finishTurn(origin.id,"completed",null);const receiptInput={expectedHostID:store.hostId,clientRequestId:randomUUID(),expectedRevision:1};
  let completion:unknown=null;
  if(state==="ready"){completion={...receiptInput,selections:[{connectionId:DESTINATION,expectedRevision:1,tools:[{name:TOOL,manifestHash:HASH}]}]};workflow=store.completeConnectionWorkflow(workflow.id,completion);
    store.claimNextTurn(thread.id);store.finishTurn(workflow.continuationTurnId!,"completed",null);}
  if(state==="cancelled")workflow=store.cancelConnectionWorkflow(workflow.id,receiptInput);
  return {bot,thread,origin,action,input,workflow,completion,receiptInput};
};

for(const state of ["awaiting_user","cancelled","expired","ready"] as const)test(`R3 native authorize ${state}: exact/full backup → activate preserves history with zero grant replay`,async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"dx-r3-native-journal-"))),source=join(root,"source"),destination=join(root,"destination");let now=Date.now();
  const store=new HostStore({dataDir:source,clock:()=>now});t.after(()=>{try{store.close();}catch{}rmSync(root,{recursive:true,force:true});});
  const f=await make(store,state);if(state==="expired")now=f.workflow.expiresAt+1;
  const native=new DatabaseSync(join(source,"native-mcp.sqlite"));try{native.exec(FULL_SCHEMAS.nativeMcp.sql+MCP_INSTANCE_SELECTION_SQL);
    const set=native.prepare("INSERT INTO meta(key,value)VALUES(?,?)");set.run("schema","3");set.run("installation",store.hostId);set.run("owner",store.ownerId);}finally{native.close();}
  assert.equal(store.connectionWorkflow(f.workflow.id)?.state,state);
  const db=new DatabaseSync(store.databasePath,{readOnly:true});try{checkExactSchema(db,"hub16");checkFullSchema(db,"hub");}finally{db.close();}
  // A later bot revision cannot invalidate the history or invent the old setup revision.
  store.patchBot(f.bot.id,{expectedRevision:f.bot.revision,name:"Changed after setup"});
  const ownerId=store.ownerId,hostId=store.hostId,original=store.getAction(f.action.id);store.close();
  const {privateKey,publicKey}=generateKeyPairSync("ed25519"),secret=createSecretKey(randomBytes(32));
  const key:SnapshotKey={keyId:"synthetic-r3-authorization",use:fn=>fn(secret)},owner:OwnerAuthority={publicKey,sign:bytes=>sign(null,bytes,privateKey)};
  const coordinator=AuthorityCoordinator.open(join(root,"coordinator"),{ownerId,ownerPublicKey:publicKey});t.after(()=>coordinator.close());
  const maintenance=new OfflineMaintenance(source);t.after(()=>maintenance.close());const controller=new LocalAuthorityController({coordinator}),hold=await controller.quiesce(maintenance),artifact=join(root,"native.dxg8");
  const prepared=controller.prepare(hold,{output:artifact,key});assert.equal(openCheckpointArtifact(artifact,key).manifest.schemas.hub,"hub-v16");
  controller.revokeSource({store:hold.store},prepared.checkpointId,destination);controller.activate({artifact,key,receipt:controller.issueReceipt(owner,prepared.checkpointId)});
  const restored=new HostStore({dataDir:destination});t.after(()=>restored.close());const history=restored.getAction(f.action.id);
  assert.equal(history.requestHash,original.requestHash);assert.deepEqual(history.result,original.result);assert.equal(restored.hostId,hostId);
  assert.equal(restored.getGrant(f.bot.id,TOOL,DESTINATION)?.policy,"deny");assert.equal(restored.listActions().length,1);assert.equal(restored.listTurns(f.thread.id).length,state==="ready"?2:1);
  assert.equal(restored.connectionWorkflow(f.workflow.id)?.state,["awaiting_user","expired"].includes(state)?"stopped":state);
  if(state==="ready")assert.deepEqual(restored.completeConnectionWorkflow(f.workflow.id,f.completion),f.workflow);
  if(state==="cancelled")assert.deepEqual(restored.cancelConnectionWorkflow(f.workflow.id,f.receiptInput),f.workflow);
  assert.equal(restored.getGrant(f.bot.id,TOOL,DESTINATION)?.policy,"deny","recovery GET and exact receipt replay never reapply native grants");
  const verified=new DatabaseSync(restored.databasePath,{readOnly:true});try{checkExactSchema(verified,"hub16");checkFullSchema(verified,"hub");}finally{verified.close();}
});

test("R3 native authorize journal refuses forged workflow target/UUID/action/owner and invalid normalized public input",async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"dx-r3-journal-negative-"))),store=new HostStore({dataDir:root});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const f=await make(store,"cancelled"),db=new DatabaseSync(store.databasePath);t.after(()=>db.close());const key=`connection_setup_v1:${f.workflow.id}`;
  const mutations:[string,()=>void][]=[
    ["target",()=>db.prepare("UPDATE meta SET value=? WHERE key=?").run(canonicalJson({...f.workflow,target:{kind:"native_mcp",serverId:"other",instancePin:HASH}} as JsonValue),key)],
    ["instance pin",()=>db.prepare("UPDATE meta SET value=? WHERE key=?").run(canonicalJson({...f.workflow,target:{kind:"native_mcp",serverId:"fixture",instancePin:"c".repeat(64)}} as JsonValue),key)],
    ["derived UUID",()=>db.prepare("UPDATE meta SET value=? WHERE key=?").run(canonicalJson({...f.workflow,clientRequestId:randomUUID()} as JsonValue),key)],
    ["owner",()=>db.prepare("UPDATE actions SET decided_by='owner_foreign' WHERE id=?").run(f.action.id)],
    ["origin",()=>db.prepare("UPDATE meta SET value=? WHERE key=?").run(canonicalJson({...f.workflow,originTurnId:f.action.id} as JsonValue),key)],
    ["public contract",()=>{const request={...f.action.request,arguments:{input:{...f.input,secret:"forged"},pin:{},origin:{}}};db.prepare("UPDATE actions SET request=? WHERE id=?").run(canonicalJson(request as unknown as JsonValue),f.action.id);}],
  ];
  for(const [name,mutate]of mutations)await t.test(name,()=>{db.exec("SAVEPOINT negative");try{mutate();assert.throws(()=>validateHubMcpJournals(db,{ownerId:store.ownerId,installationId:store.hostId}),name);
    assert.throws(()=>checkExactSchema(db,"hub16"),name);}finally{db.exec("ROLLBACK TO negative; RELEASE negative");}});
  checkExactSchema(db,"hub16");checkFullSchema(db,"hub");
});
test("R3 native authorize action_id remains a succeeded own exact receipt with the same instance pin",async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"dx-r3-authorization-reference-"))),store=new HostStore({dataDir:root});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const f=await make(store,"cancelled",true),other=store.createBot({name:"Foreign synthetic",profileId:"other",engine:"claude"}),db=new DatabaseSync(store.databasePath);t.after(()=>db.close());const identity={ownerId:store.ownerId,installationId:store.hostId};
  validateHubMcpJournals(db,identity);checkExactSchema(db,"hub16");
  const cases:[string,()=>void][]=[
    ["foreign bot",()=>db.prepare("UPDATE actions SET bot_id=? WHERE id=?").run(other.id,f.input.actionId!)],
    ["wrong instance pin",()=>db.prepare("UPDATE actions SET result=? WHERE id=?").run(canonicalJson({server:{id:"fixture"},instancePin:"c".repeat(64)}),f.input.actionId!)],
    ["wrong receipt kind",()=>db.prepare("UPDATE actions SET tool='dexter.harness.connections.request' WHERE id=?").run(f.input.actionId!)],
    ["no exact approval",()=>db.prepare("UPDATE actions SET decided_by=NULL WHERE id=?").run(f.input.actionId!)],
  ];
  for(const [name,mutate]of cases)await t.test(name,()=>{db.exec("SAVEPOINT negative");try{mutate();assert.throws(()=>validateHubMcpJournals(db,identity),name);}finally{db.exec("ROLLBACK TO negative; RELEASE negative");}});
});
