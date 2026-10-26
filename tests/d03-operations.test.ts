import { createHostApp } from "@dexter/hub/http";
import assert from "node:assert/strict";
import { createHash, createSecretKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { APPROVAL_POLICY_SCOPE_VERSION } from "@dexter/contracts";
import { HostStore } from "@dexter/hub";
import {
  AuthorityCoordinator, EXACT_SCHEMAS, FULL_SCHEMAS, INSPECTION_DIR, INSPECTION_FILES, LocalAuthorityController,
  OperationsError, captureCheckpointArtifact, captureInspectionSnapshot, checkFullSchema, doctor, openCheckpointArtifact, restoreForInspection,
  type OwnerAuthority, type SnapshotKey,
} from "@dexter/operations";
import { AUTHORITY_ENVELOPE_PURPOSE, sealEnvelope } from "../packages/operations/src/envelope.js";

function lab(t:TestContext):string {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"d03-operations-")));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return root;
}
function custody():{key:SnapshotKey;owner:OwnerAuthority} {
  const secret=createSecretKey(Buffer.alloc(32,17));
  const pair=generateKeyPairSync("ed25519");
  return {key:{keyId:"synthetic-d03-policy",use:operation=>operation(secret)},
    owner:{publicKey:pair.publicKey,sign:bytes=>sign(null,bytes,pair.privateKey)}};
}
function policy(store:HostStore,botId:string,mode:"ask"|"approve_all",clientRequestId:string) {
  return store.setBotApprovalPolicy(botId,{expectedHostId:store.hostId,clientRequestId,
    expectedRevision:store.getBotApprovalPolicy(botId).revision,mode,eligibleScopeVersion:APPROVAL_POLICY_SCOPE_VERSION});
}
function withDb<T>(path:string,read:(db:DatabaseSync)=>T):T {
  const db=new DatabaseSync(path,{readOnly:true});
  try{return read(db);}finally{db.close();}
}
const refused=(error:unknown)=>error instanceof OperationsError && ["unsupported_schema","corrupt","reference_broken"].includes(error.code);

test("D03 Hub13 exact backup, activation and inspection retain policy receipts without importing new consent",async t=>{
  const root=lab(t),source=join(root,"source"),destination=join(root,"destination");
  const store=new HostStore({dataDir:source});t.after(()=>store.close());
  const first=store.createBot({name:"Synthetic A",engine:"claude",profileId:"personal"});
  const second=store.createBot({name:"Synthetic B",engine:"claude",profileId:"personal"});
  assert.equal(store.getBotApprovalPolicy(first.id).mode,"ask");
  policy(store,first.id,"approve_all","synthetic-mode-1");
  policy(store,first.id,"ask","synthetic-mode-2");
  const receipt=policy(store,first.id,"approve_all","synthetic-mode-3");
  const thread=store.createThread(first.id);
  const app=createHostApp(store),access=await (await app.request(`/v1/bots/${first.id}/execution-access`)).json() as {inventoryHash:string;botRevision:number};
  const enabled=await app.request(`/v1/bots/${first.id}/execution-access`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({expectedHostId:store.hostId,clientRequestId:"synthetic-access",expectedBotRevision:access.botRevision,expectedInventoryHash:access.inventoryHash,scopeVersion:"d03.access.v1",operation:"terminal",enabled:true})});
  assert.equal(enabled.status,200);
  const accessReceipt=store.getBotExecutionAccessReceipt(first.id,"synthetic-access");
  const action=store.requestAction({botId:first.id,threadId:thread.id,tool:"dexter.harness.terminal.run",
    destination:"dexter-harness-owner-proposals",idempotencyKey:"synthetic-call",arguments:{command:"synthetic-no-executor"}},"terminal");
  assert.equal(action.state,"ready");assert.equal(action.authorization?.source,"owner_policy");
  store.setProposalGrant({botId:first.id,tool:"dexter.automations.run",destination:"dexter-automations",policy:"ask",expiresAt:null});
  const {key,owner}=custody();
  const inspection=join(root,"inspection.dxg8");
  captureInspectionSnapshot({source:store,key,output:inspection,include:{context:false,agenda:false,deviceRegistry:false,deviceSurface:false}});
  const inspected=restoreForInspection({artifact:inspection,key,destination:join(root,"inspected")});
  assert.equal(inspected.activatable,false);
  withDb(join(inspected.destination,INSPECTION_DIR,INSPECTION_FILES.hub),db=>{
    checkFullSchema(db,"hub");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bot_approval_policy_receipts").get()!.n,3);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bot_execution_access_receipts").get()!.n,1);
    assert.equal(db.prepare("SELECT state FROM host_authority").get()!.state,"revoked");
  });
  // Synthetic empty portable registry: no adapter, process, account or credential is constructed.
  const nativeRegistry=new DatabaseSync(join(source,"native-mcp.sqlite"));
  try{
    nativeRegistry.exec(FULL_SCHEMAS.nativeMcp.sql);
    for(const [name,value] of [["schema","1"],["owner",store.ownerId],["installation",store.hostId]])
      nativeRegistry.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(name!,value!);
  }finally{nativeRegistry.close();}
  store.setProposalGrant({botId:first.id,tool:"mcp.synthetic.echo",destination:"synthetic-connection",policy:"ask",expiresAt:null});
  const coordinator=AuthorityCoordinator.open(join(root,"coordinator"),{ownerId:store.ownerId,ownerPublicKey:owner.publicKey});
  t.after(()=>coordinator.close());
  const controller=new LocalAuthorityController({coordinator});
  const hold=await controller.quiesce({quiesceForMaintenance:async()=>store});
  const backup=join(root,"backup.dxg8");controller.backup(hold,{key,output:backup});
  const opened=openCheckpointArtifact(backup,key);
  assert.equal(opened.manifest.schemas.hub,"hub-v13");
  const member=join(root,"backup-hub.sqlite");writeFileSync(member,opened.members.get("hub.sqlite")!,{mode:0o600});
  withDb(member,db=>{
    assert.equal(checkFullSchema(db,"hub").installationId,store.hostId);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bot_approval_policy_receipts").get()!.n,3);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bot_execution_access_receipts").get()!.n,1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM proposal_only_grants").get()!.n,1);
    assert.equal(db.prepare("SELECT policy FROM grants WHERE tool='mcp.synthetic.echo'").get()!.policy,"deny");
    assert.equal(db.prepare("SELECT source FROM action_authorizations WHERE action_id=?").get(action.id)!.source,"owner_policy");
  });
  const nextHold=await controller.quiesce({quiesceForMaintenance:async()=>store});
  const transfer=join(root,"transfer.dxg8"),prepared=controller.prepare(nextHold,{key,output:transfer});
  controller.revokeSource({store},prepared.checkpointId,destination);
  controller.activate({artifact:transfer,key,receipt:controller.issueReceipt(owner,prepared.checkpointId)});
  const restored=new HostStore({dataDir:destination});
  try{
    assert.deepEqual(restored.getBotApprovalPolicy(first.id),receipt.policy);
    assert.equal(restored.getBotApprovalPolicy(second.id).mode,"ask");
    assert.deepEqual(restored.getBotApprovalPolicyReceipt(first.id,"synthetic-mode-3"),receipt);
    assert.deepEqual(restored.getBotExecutionAccessReceipt(first.id,"synthetic-access"),accessReceipt);
    assert.equal(restored.getAction(action.id).state,"ready");
    assert.equal(restored.getGrant(first.id,"mcp.synthetic.echo","synthetic-connection")!.policy,"deny");
    assert.equal(doctor(destination).hub.supported,true);
  }finally{restored.close();}
});

test("D03 exact admission refuses changed schema, foreign policy and detached receipt history",t=>{
  const root=lab(t),source=join(root,"source");
  const store=new HostStore({dataDir:source});
  const bot=store.createBot({name:"Synthetic",engine:"claude",profileId:"personal"});
  policy(store,bot.id,"approve_all","synthetic-mode-1");
  policy(store,bot.id,"ask","synthetic-mode-2");
  const path=store.databasePath;store.close();
  const original=readFileSync(path);
  for(const [name,sql] of [
    ["schema","ALTER TABLE bot_approval_policies ADD COLUMN extra TEXT"],
    ["host","UPDATE bot_approval_policies SET host_id='foreign-host'"],
    ["history","DELETE FROM bot_approval_policy_receipts WHERE client_request_id='synthetic-mode-1'"],
  ]) {
    const copy=join(root,`${name}.sqlite`);writeFileSync(copy,original,{mode:0o600});
    const db=new DatabaseSync(copy);
    try{db.exec(sql!);assert.throws(()=>checkFullSchema(db,"hub"),refused);}finally{db.close();}
  }
});

test("D03 canonical Hub11 migration and artifact activation start every bot asking, preserving grants",async t=>{
  const root=lab(t),source=join(root,"legacy");
  const store=new HostStore({dataDir:source});
  const first=store.createBot({name:"Synthetic A",engine:"claude",profileId:"personal"});
  const second=store.createBot({name:"Synthetic B",engine:"claude",profileId:"personal"});
  const grant=store.setGrant({botId:first.id,tool:"dexter.harness.terminal.run",destination:"dexter-harness-owner-proposals",policy:"ask",expiresAt:null});
  const path=store.databasePath;store.close();
  const legacy=new DatabaseSync(path);
  try{
    legacy.exec("DROP TABLE action_approval_requirements; DROP TABLE bot_execution_access_receipts; DROP TABLE proposal_only_grants; DROP TABLE action_authorizations; DROP TABLE bot_approval_policy_receipts; DROP TABLE bot_approval_policies; PRAGMA user_version=11;");
    assert.equal(checkFullSchema(legacy,"hub").ownerId,first.ownerId);
    assert.equal(EXACT_SCHEMAS.hub11.userVersion,11);
  }finally{legacy.close();}
  const migrated=new HostStore({dataDir:source});
  try{
    for(const bot of [first,second]){
      const actual=migrated.getBotApprovalPolicy(bot.id);assert.equal(actual.mode,"ask");
      assert.equal(actual.revision,0);assert.equal(actual.receiptId,null);
    }
    assert.deepEqual(migrated.getGrant(first.id,grant.tool,grant.destination),grant);
    withDb(path,db=>{
      checkFullSchema(db,"hub");assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,13);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bot_approval_policy_receipts").get()!.n,0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM proposal_only_grants").get()!.n,1);
    });
    const {key,owner}=custody(),checkpointId="ckp_syntheticD03LegacyCheckpoint01";
    const coordinator=AuthorityCoordinator.open(join(root,"coordinator"),{ownerId:migrated.ownerId,ownerPublicKey:owner.publicKey});
    t.after(()=>coordinator.close());
    const controller=new LocalAuthorityController({coordinator});
    const hold=await controller.quiesce({quiesceForMaintenance:async()=>migrated});
    coordinator.beginCheckpoint({installationId:migrated.hostId,ownerId:migrated.ownerId,epoch:hold.authority.epoch,
      state:"active",directory:source,checkpointId:null},checkpointId,Date.now());
    const checkpoint=migrated.checkpointForTransfer(checkpointId),artifact=join(root,"legacy.dxg8");
    captureCheckpointArtifact({source:migrated,checkpoint,key,output:artifact});
    const opened=openCheckpointArtifact(artifact,key),member=join(root,"legacy-member.sqlite");
    writeFileSync(member,opened.members.get("hub.sqlite")!,{mode:0o600});
    const historical=new DatabaseSync(member);
    try{
      historical.exec("DROP TABLE action_approval_requirements; DROP TABLE bot_execution_access_receipts; DROP TABLE proposal_only_grants; DROP TABLE action_authorizations; DROP TABLE bot_approval_policy_receipts; DROP TABLE bot_approval_policies; PRAGMA user_version=11; VACUUM;");
      checkFullSchema(historical,"hub");
    }finally{historical.close();}
    const bytes=readFileSync(member),sha=(value:Buffer)=>createHash("sha256").update(value).digest("hex");
    opened.members.set("hub.sqlite",bytes);opened.manifest.schemas.hub="hub-v11";
    const hubMember=opened.manifest.members.find(value=>value.name==="hub.sqlite")!;
    hubMember.bytes=bytes.length;hubMember.sha256=sha(bytes);
    const manifest=Buffer.from(JSON.stringify(opened.manifest)),prefix=Buffer.alloc(4);prefix.writeUInt32BE(manifest.length);
    const envelope=sealEnvelope(Buffer.concat([prefix,manifest,...opened.manifest.members.map(value=>opened.members.get(value.name)!)]),key,AUTHORITY_ENVELOPE_PURPOSE);
    writeFileSync(artifact,envelope,{mode:0o600});
    coordinator.recordCaptured(checkpointId,sha(envelope),sha(manifest),Date.now());
    assert.equal(openCheckpointArtifact(artifact,key).manifest.schemas.hub,"hub-v11");
    const destination=join(root,"restored-legacy");controller.revokeSource({store:migrated},checkpointId,destination);
    controller.activate({artifact,key,receipt:controller.issueReceipt(owner,checkpointId)});
    const restored=new HostStore({dataDir:destination});
    try{
      for(const bot of [first,second]){
        assert.equal(restored.getBotApprovalPolicy(bot.id).mode,"ask");
        assert.equal(restored.getBotApprovalPolicy(bot.id).revision,0);
      }
      assert.deepEqual(restored.getGrant(first.id,grant.tool,grant.destination),grant);
      assert.equal(doctor(destination).hub.supported,true);
    }finally{restored.close();}
  }finally{migrated.close();}
});
