import assert from "node:assert/strict";
import { createHash, createSecretKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { existsSync,mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { HostStore, canonicalJson, dispatchAction } from "@dexter/hub";
import { checkMcpDefinition, MCP_INSTANCE_SELECTION_SQL, NativeMcpRuntime } from "@dexter/connectors";
import { CapabilityGateway,checkManifest } from "@dexter/gateway";
import { AuthorityCoordinator, LocalAuthorityController, OfflineMaintenance, openCheckpointArtifact, captureInspectionSnapshot, restoreForInspection, INSPECTION_DIR, INSPECTION_FILES, type SnapshotKey, type OwnerAuthority } from "@dexter/operations";
import type { ConnectionWorkflow, JsonValue, McpPrivateInput } from "@dexter/contracts";
import { checkFullSchema, FULL_SCHEMAS } from "../packages/operations/src/full-schemas.js";
import {assertMcpCheckpointSafety,validateNativeMcpCatalogMetadata,validateNativeMcpJournalReferences} from '../packages/operations/src/mcp-journals.js';
import {validateNativeMcp} from '../packages/operations/src/native-mcp.js';
import {vacuumInto} from '../packages/operations/src/capture.js';
import {OwnedPaths} from '../packages/operations/src/files.js';
import {DEFAULT_LIMITS} from '../packages/operations/src/manifest.js';
import {validateCheckpointStores} from '../packages/operations/src/checkpoint.js';
import { McpPrivateInputCoordinator } from "../packages/cli/src/mcp-private-input.js";

const H = "a".repeat(64), TOOL = "mcp.fixture.write", CONNECTION = "conn_syntheticFixture";
const safeRequests = { r1: { method: "elicitation/create", params: { mode: "form", message: "Confirm the synthetic operation", requestedSchema: {
  type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"], additionalProperties: false,
} } } };
const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value as JsonValue)).digest("hex");
const meta = (path: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare("SELECT key,value FROM meta ORDER BY key").all(); } finally { db.close(); } };

async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dx-mcp-journals-"))), source = join(root, "source"), store = new HostStore({ dataDir: source });
  t.after(() => { try { store.close(); } catch { /* already closed for offline capture */ } rmSync(root, { recursive: true, force: true }); });
  const bot = store.createBot({ name: "Synthetic checkpoint bot", engine: "claude", profileId: "default" });
  const batch = { operationId: randomUUID(), grants: [{ botId: bot.id, tool: TOOL, destination: CONNECTION, expectedRevision: 0, policy: "ask", expiresAt: null }] };
  const grantReceipt = store.applyGrantBatch(batch);
  async function setup(state: "pending" | "ready" | "cancelled") {
    const thread = store.createThread(bot.id), turn = store.createTurn(thread.id, { clientRequestId: randomUUID(), content: "Synthetic setup request" }).turn;
    store.claimNextTurn(thread.id);
    const input = { clientRequestId: randomUUID(), expectedBotRevision: bot.revision, target: { kind: "native_mcp", serverId: "fixture", instancePin: H } };
    store.setGrant({ botId: bot.id, tool: "dexter.harness.connections.request", destination: "dexter-harness-owner-proposals", policy: "ask" });
    const action = store.requestAction({ botId: bot.id, threadId: thread.id, tool: "dexter.harness.connections.request", destination: "dexter-harness-owner-proposals", arguments: { input }, idempotencyKey: randomUUID() });
    store.bindToolAction(action.id, turn.id, `setup-${state}`); store.decideAction(action.id, { decision: "allow", requestHash: action.requestHash });
    let workflow!: ConnectionWorkflow;
    await dispatchAction(store, action.id, async () => { workflow = store.createConnectionWorkflow(action.id, input); return { requestId: workflow.id }; });
    store.finishTurn(turn.id, "completed", null);
    const response = { expectedHostID: store.hostId, clientRequestId: randomUUID(), expectedRevision: 1 };
    if (state === "ready") {
      const completion = { ...response, selections: [{ connectionId: CONNECTION, expectedRevision: 1, tools: [{ name: TOOL, manifestHash: H }] }] };
      workflow = store.completeConnectionWorkflow(workflow.id, completion);
      store.claimNextTurn(thread.id); store.finishTurn(workflow.continuationTurnId!, "completed", null);
      return { workflow, completion, response };
    }
    if (state === "cancelled") workflow = store.cancelConnectionWorkflow(workflow.id, response);
    return { workflow, completion: null, response };
  }
  async function form(state: "pending" | "answered") {
    const thread = store.createThread(bot.id), turn = store.createTurn(thread.id, { clientRequestId: randomUUID(), content: "Synthetic form operation" }).turn;
    store.claimNextTurn(thread.id);
    const action = store.requestAction({ botId: bot.id, threadId: thread.id, tool: TOOL, destination: CONNECTION, arguments: {}, idempotencyKey: randomUUID() });
    store.bindToolAction(action.id, turn.id, `form-${state}`); store.decideAction(action.id, { decision: "allow", requestHash: action.requestHash });
    let input!: McpPrivateInput;
    await dispatchAction(store, action.id, async () => {
      input = store.recordMcpPrivateInput({ version: 1, id: `mcpform_${randomUUID()}`, actionId: action.id, requestHash: action.requestHash,
        connectionId: CONNECTION, botId: bot.id, threadId: thread.id, revision: 1, state: "pending", requests: safeRequests,
        createdAt: store.now(), expiresAt: store.now() + 300_000, responseHash: null, clientRequestId: null });
      if (state === "answered") input = store.recordMcpPrivateInput({ ...input, revision: 2, state, responseHash: sha({ synthetic: "approved" }), clientRequestId: randomUUID() });
      return { synthetic: true };
    });
    store.finishTurn(turn.id, "completed", null); return input;
  }
  const [pending, ready, cancelled] = [await setup("pending"), await setup("ready"), await setup("cancelled")];
  const [pendingForm, answeredForm] = [await form("pending"), await form("answered")];
  return { root, source, store, bot, batch, grantReceipt, pending, ready, cancelled, pendingForm, answeredForm };
}

function nativeFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const path=join(f.source,"native-mcp.sqlite"),db=new DatabaseSync(path);
  const definition=checkMcpDefinition({id:"fixture",name:"Synthetic native registry",runsOn:"owner_mac",auth:"none",transport:{type:"stdio",command:"/usr/bin/synthetic-checkpoint-only"}});
  const intent={version:1,operationId:f.batch.operationId,serverId:"fixture",instancePin:H,state:"prepared",changes:[{botId:f.bot.id,toolIds:[TOOL]}],catalog:null,grants:f.batch.grants};
  try {
    db.exec(FULL_SCHEMAS.nativeMcp.sql+MCP_INSTANCE_SELECTION_SQL);
    const set=db.prepare("INSERT INTO meta(key,value)VALUES(?,?)");
    for(const [key,value]of [["schema","3"],["installation",f.store.hostId],["owner",f.store.ownerId],["mcp-instance:fixture",randomUUID()]] as const)set.run(key,value);
    db.prepare("INSERT INTO servers(id,definition,status)VALUES(?,?,'failed')").run("fixture",JSON.stringify(definition));
    set.run("mcp-command:fixture",canonicalJson({realPath:"/usr/bin/synthetic-checkpoint-only",sha256:H,invocationHash:H,sizeBytes:12}));
    set.run("mcp-quarantine:fixture",canonicalJson({metadataHash:H,observedAt:1}));
    set.run("mcp-changes:fixture",canonicalJson({revision:H,added:[TOOL],removed:[],changed:[],observedAt:1}));
    set.run(`mcp-grants:${intent.operationId}`,canonicalJson(intent));
    checkFullSchema(db,"nativeMcp");
  }finally{db.close();}
  return {path,intent};
}

test("Hub16 MCP journal checkpoint/activation retains exact history, interrupts pending forms/setup and GET never applies grants", async t => {
  const f = await fixture(t), destination = join(f.root, "destination"), ownerId = f.store.ownerId;
  const native=nativeFixture(f),nativeBefore=meta(native.path);
  const before = meta(f.store.databasePath); f.store.close();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519"), secret = createSecretKey(randomBytes(32));
  const key: SnapshotKey = { keyId: "synthetic-mcp-journal", use: fn => fn(secret) }, owner: OwnerAuthority = { publicKey, sign: bytes => sign(null, bytes, privateKey) };
  const coordinator = AuthorityCoordinator.open(join(f.root, "coordinator"), { ownerId, ownerPublicKey: publicKey }); t.after(() => coordinator.close());
  const maintenance = new OfflineMaintenance(f.source); t.after(() => maintenance.close());
  const controller = new LocalAuthorityController({ coordinator }), hold = await controller.quiesce(maintenance), artifact = join(f.root, "journal.dxg8");
  const prepared = controller.prepare(hold, { output: artifact, key });
  const opened = openCheckpointArtifact(artifact, key);
  assert.equal(opened.manifest.schemas.hub, "hub-v16");
  assert.equal(opened.manifest.schemas.nativeMcp,"native-mcp-v3");
  assert.deepEqual(meta(hold.store.databasePath), before, "copy sanitization never changes live journal history");
  assert.deepEqual(meta(native.path),nativeBefore,"native recovery copy remains prepared at the source");
  controller.revokeSource({ store: hold.store }, prepared.checkpointId, destination);
  controller.activate({ artifact, key, receipt: controller.issueReceipt(owner, prepared.checkpointId) });
  const restored = new HostStore({ dataDir: destination }); t.after(() => restored.close());
  assert.deepEqual(restored.grantBatchReceipt(f.batch.operationId), f.grantReceipt);
  assert.deepEqual(restored.applyGrantBatch(f.batch), f.grantReceipt, "exact replay returns history without grant mutation");
  assert.equal(restored.getGrant(f.bot.id,TOOL,CONNECTION)?.policy,"deny","native receipt never restores effective grants");
  const nativeRestored=new DatabaseSync(join(destination,"native-mcp.sqlite"),{readOnly:true});
  try {
    checkFullSchema(nativeRestored,"nativeMcp");
    const recovered=JSON.parse(String(nativeRestored.prepare("SELECT value FROM meta WHERE key=?").get(`mcp-grants:${native.intent.operationId}`)!.value));
    assert.equal(recovered.state,"interrupted");
    for(const key of ["mcp-command:fixture","mcp-quarantine:fixture","mcp-changes:fixture"])assert.equal(nativeRestored.prepare("SELECT value FROM meta WHERE key=?").get(key)!.value,nativeBefore.find(row=>row.key===key)!.value);
  }finally{nativeRestored.close();}
  assert.equal(restored.connectionWorkflow(f.pending.workflow.id)?.state, "stopped");
  assert.equal(restored.mcpPrivateInput(f.pendingForm.id)?.state, "interrupted");
  assert.deepEqual(restored.mcpPrivateInput(f.answeredForm.id), f.answeredForm);
  assert.equal(restored.mcpPrivateInputResponseOwner(f.answeredForm.clientRequestId!), f.answeredForm.id);
  assert.deepEqual(restored.completeConnectionWorkflow(f.ready.workflow.id, f.ready.completion), f.ready.workflow);
  assert.deepEqual(restored.cancelConnectionWorkflow(f.cancelled.workflow.id, f.cancelled.response), f.cancelled.workflow);
  assert.throws(() => restored.completeConnectionWorkflow(f.pending.workflow.id, { ...f.pending.response, selections: f.ready.completion!.selections }));
  const privateInputs = new McpPrivateInputCoordinator(restored, () => { throw new Error("No transport exists after restore"); }); t.after(() => privateInputs.close());
  assert.throws(() => privateInputs.respond(f.pendingForm.id, { expectedHostID: restored.hostId, clientRequestId: randomUUID(), expectedRevision: 2,
    actionId: f.pendingForm.actionId, requestHash: f.pendingForm.requestHash, responses: { r1: { action: "accept", content: { confirm: true } } }, approval: "approve_exact_input" }));
  const db = new DatabaseSync(restored.databasePath, { readOnly: true }); try { checkFullSchema(db, "hub"); assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 16); } finally { db.close(); }
  const stable = meta(restored.databasePath), grants = restored.getGrant(f.bot.id, TOOL, CONNECTION);
  for (let n = 0; n < 3; n++) { restored.connectionWorkflows(); privateInputs.list(); restored.mcpPrivateInputResponseOwner(f.answeredForm.clientRequestId!); restored.grantBatchReceipt(f.batch.operationId); }
  assert.deepEqual(meta(restored.databasePath), stable, "GET leaves journals and response dedupe untouched");
  assert.deepEqual(restored.getGrant(f.bot.id, TOOL, CONNECTION), grants);
  const runtime=new NativeMcpRuntime({host:{runsOn:"owner_mac",stdioRoot:join(destination,"mcp-stdio")},oauth:false}),gateway=new CapabilityGateway({store:restored,broker:runtime.broker,adapter:runtime.adapter});
  let applied=0;restored.applyGrantBatch=()=>{applied++;throw new Error("Recovery must use GET only");};
  try {runtime.bind(restored,gateway);assert.equal(runtime.admin.listServers().length,1);assert.equal(runtime.openSessions,0);assert.equal(applied,0);assert.equal(restored.getGrant(f.bot.id,TOOL,CONNECTION)?.policy,"deny");}
  finally{await runtime.close();gateway.close();}
});

test("checkpoint rejects unknown families, noncanonical JSON, forged receipt checksum/revision and foreign references", async t => {
  const f = await fixture(t), db = new DatabaseSync(f.store.databasePath);
  t.after(() => db.close());
  checkFullSchema(db, "hub");
  const receiptKey = `grant_batch_v1:${f.batch.operationId}`, formKey = `mcp_private_input_v1:${f.answeredForm.id}`;
  const mutations: [string, (db: DatabaseSync) => void][] = [
    ["unknown grant family", db => db.prepare("INSERT INTO meta(key,value)VALUES(?,?)").run("grant_batch_v2:unknown", "{}")],
    ["unknown setup key", db => db.prepare("INSERT INTO meta(key,value)VALUES(?,?)").run("connection_setup_v1:bad key", "{}")],
    ["receipt checksum", db => db.prepare("UPDATE meta SET value=? WHERE key=?").run(canonicalJson({ ...f.grantReceipt, requestHash: "b".repeat(64) } as JsonValue), receiptKey)],
    ["receipt extra key", db => db.prepare("UPDATE meta SET value=? WHERE key=?").run(canonicalJson({ ...f.grantReceipt, secret: "opaque" } as JsonValue), receiptKey)],
    ["receipt wrong owner", db => db.prepare("UPDATE meta SET value=? WHERE key=?").run(canonicalJson({ ...f.grantReceipt, ownerId: "owner_other" } as JsonValue), receiptKey)],
    ["receipt future revision", db => db.prepare("UPDATE meta SET value=? WHERE key=?").run(canonicalJson({ ...f.grantReceipt, grants: [{ ...f.grantReceipt.grants[0]!, revision: 999 }] } as JsonValue), receiptKey)],
    ["whitespace JSON", db => db.prepare("UPDATE meta SET value=? WHERE key=?").run(JSON.stringify(f.grantReceipt, null, 2), receiptKey)],
    ["private opaque state", db => db.prepare("UPDATE meta SET value=? WHERE key=?").run(canonicalJson({ ...f.answeredForm, requests: { r1: { ...safeRequests.r1, params: { ...safeRequests.r1.params, _meta: { requestState: "opaque state" } } } } } as JsonValue), formKey)],
    ["private persisted answers", db => db.prepare("UPDATE meta SET value=? WHERE key=?").run(canonicalJson({ ...f.answeredForm, answers: { confirm: true } } as JsonValue), formKey)],
    ["private credential solicitation", db => db.prepare("UPDATE meta SET value=? WHERE key=?").run(canonicalJson({ ...f.answeredForm, requests: { r1: { ...safeRequests.r1, params: { ...safeRequests.r1.params, message: "Paste your API key" } } } } as JsonValue), formKey)],
    ["private credential bytes", db => db.prepare("UPDATE meta SET value=? WHERE key=?").run(canonicalJson({ ...f.answeredForm, requests: { r1: { ...safeRequests.r1, params: { ...safeRequests.r1.params, message: "ghp_syntheticCREDENTIAL0123456789abcdef" } } } } as JsonValue), formKey)],
    ["forged response index", db => db.prepare("UPDATE meta SET value=? WHERE key=?").run(f.pendingForm.id, `mcp_private_response_v1:${f.answeredForm.clientRequestId}`)],
    ["missing completion receipt", db => db.prepare("DELETE FROM meta WHERE key=?").run(`connection_setup_receipt_v1:${f.ready.response.clientRequestId}`)],
    ["forged completion receipt hash", db => { const key=`connection_setup_receipt_v1:${f.ready.response.clientRequestId}`; db.prepare("UPDATE meta SET value=? WHERE key=?").run(canonicalJson({hash:H,workflow:f.ready.workflow} as JsonValue),key); }],
    ["workflow checksum differs from approved action",db=>db.prepare("UPDATE meta SET value=? WHERE key=?").run(canonicalJson({...f.pending.workflow,requestHash:"b".repeat(64)} as JsonValue),`connection_setup_v1:${f.pending.workflow.id}`)],
  ];
  for (const [name, mutation] of mutations) {
    await t.test(name,()=>{db.exec("SAVEPOINT negative"); try { mutation(db); assert.throws(() => checkFullSchema(db, "hub"), name); } finally { db.exec("ROLLBACK TO negative; RELEASE negative"); }});
  }
  checkFullSchema(db, "hub");
});

test("inspection restore preserves historical grant receipts while expired copy grants advance revision and pending journals stop",async t=>{
  const f=await fixture(t),secret=createSecretKey(randomBytes(32)),key:SnapshotKey={keyId:"synthetic-mcp-inspection",use:fn=>fn(secret)};
  const provisional=f.store.setProposalGrant({botId:f.bot.id,tool:"dexter.harness.memory.policy.update",destination:"dexter-harness-memory-learning",policy:"ask"});
  const sourceRows=()=>{const source=new DatabaseSync(f.store.databasePath,{readOnly:true});try{return source.prepare("SELECT p.grant_revision,g.revision,g.policy,g.expires_at FROM proposal_only_grants p JOIN grants g ON p.bot_id=g.bot_id AND p.tool=g.tool AND p.destination=g.destination ORDER BY p.tool").all().map(row=>({...row}));}finally{source.close();}};
  const sourceBefore=sourceRows(),sourceHistory=meta(f.store.databasePath);
  assert.deepEqual(sourceBefore,[{grant_revision:provisional.revision,revision:provisional.revision,policy:"ask",expires_at:null}]);
  const receipt=captureInspectionSnapshot({source:f.store,key,output:join(f.root,"inspection.dxg8"),include:{context:false,agenda:false,deviceRegistry:false,deviceSurface:false}});
  const destination=join(f.root,"inspection");restoreForInspection({artifact:receipt.path,key,destination});
  const db=new DatabaseSync(join(destination,INSPECTION_DIR,INSPECTION_FILES.hub),{readOnly:true});
  try{
    checkFullSchema(db,"hub");
    const grant=db.prepare("SELECT revision,expires_at FROM grants WHERE bot_id=? AND tool=? AND destination=?").get(f.bot.id,TOOL,CONNECTION)!;
    assert.equal(grant.revision,f.grantReceipt.grants[0]!.revision+1);assert.equal(grant.expires_at,receipt.capturedAt);
    const binding=db.prepare("SELECT p.grant_revision,g.revision,g.policy,g.expires_at FROM proposal_only_grants p JOIN grants g ON p.bot_id=g.bot_id AND p.tool=g.tool AND p.destination=g.destination WHERE p.bot_id=? AND p.tool=? AND p.destination=?").get(f.bot.id,provisional.tool,provisional.destination)!;
    assert.deepEqual({...binding},{grant_revision:provisional.revision+1,revision:provisional.revision+1,policy:"ask",expires_at:receipt.capturedAt});
    assert.equal(db.prepare("SELECT state FROM host_authority").get()!.state,"revoked");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM host_lease").get()!.n,0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM grants WHERE expires_at IS NULL OR expires_at>?").get(receipt.capturedAt)!.n,0,"inspection retains no effective grant");
    const stored=JSON.parse(String(db.prepare("SELECT value FROM meta WHERE key=?").get(`grant_batch_v1:${f.batch.operationId}`)!.value));assert.deepEqual(stored,f.grantReceipt);
    const pending=JSON.parse(String(db.prepare("SELECT value FROM meta WHERE key=?").get(`mcp_private_input_v1:${f.pendingForm.id}`)!.value));assert.equal(pending.state,"interrupted");
    const workflow=JSON.parse(String(db.prepare("SELECT value FROM meta WHERE key=?").get(`connection_setup_v1:${f.pending.workflow.id}`)!.value));assert.equal(workflow.state,"stopped");
  }finally{db.close();}
  assert.deepEqual(sourceRows(),sourceBefore,"copy-only expiry does not alter live proposal bindings");
  assert.deepEqual(meta(f.store.databasePath),sourceHistory,"source immutable receipts/journals remain unchanged");
  assert.deepEqual(f.store.grantBatchReceipt(f.batch.operationId),f.grantReceipt);
  assert.equal(f.store.getGrant(f.bot.id,TOOL,CONNECTION)?.revision,f.grantReceipt.grants[0]!.revision,"source authority unchanged");
});

test("Native3 checkpoint metadata admits closed hash-only families and rejects unknown/circuit/forged/credential metadata",async t=>{
  const f=await fixture(t),native=nativeFixture(f),db=new DatabaseSync(native.path),hub=new DatabaseSync(f.store.databasePath,{readOnly:true});
  t.after(()=>{db.close();hub.close();});
  validateNativeMcpJournalReferences(db,hub);
  const set=(key:string,value:unknown)=>db.prepare("INSERT INTO meta(key,value)VALUES(?,?)ON CONFLICT(key)DO UPDATE SET value=excluded.value").run(key,canonicalJson(value as JsonValue));
  const cases:[string,()=>void][]=[
    ["unknown key",()=>set("mcp-command-extra:fixture",{})],
    ["persisted circuit",()=>set("mcp-circuit:fixture",{state:"closed"})],
    ["command opaque argv",()=>set("mcp-command:fixture",{realPath:"/usr/bin/synthetic",sha256:H,invocationHash:H,args:["opaque"]})],
    ["command invalid hash",()=>set("mcp-command:fixture",{realPath:"/usr/bin/synthetic",sha256:"unsafe",invocationHash:H})],
    ["quarantine invalid hash",()=>set("mcp-quarantine:fixture",{metadataHash:"unsafe",observedAt:1})],
    ["quarantine unknown request state",()=>set("mcp-quarantine:fixture",{metadataHash:H,observedAt:1,requestState:"opaque"})],
    ["catalog changes foreign tool",()=>set("mcp-changes:fixture",{revision:H,added:["mcp.other.write"],removed:[],changed:[],observedAt:1})],
    ["intent extra state",()=>set(`mcp-grants:${native.intent.operationId}`,{...native.intent,requestState:"opaque"})],
    ["intent mismatching receipt",()=>set(`mcp-grants:${native.intent.operationId}`,{...native.intent,grants:[{...native.intent.grants[0],expectedRevision:999}]})],
    ["intent credential catalog",()=>set(`mcp-grants:${native.intent.operationId}`,{...native.intent,catalog:[{description:"ghp_syntheticCREDENTIAL0123456789abcdef"}]})],
    ["intent foreign bot",()=>set(`mcp-grants:${native.intent.operationId}`,{...native.intent,changes:[{botId:"bot_foreign",toolIds:[TOOL]}]})],
  ];
  for(const [name,mutation]of cases)await t.test(name,()=>{db.exec("SAVEPOINT negative");try{mutation();assert.throws(()=>{checkFullSchema(db,"nativeMcp");validateNativeMcpJournalReferences(db,hub);},name);}finally{db.exec("ROLLBACK TO negative; RELEASE negative");}});
  await t.test("removed server keeps canonical historical grant receipt",()=>{
    db.exec("SAVEPOINT historical");try{
      set(`mcp-grants:${native.intent.operationId}`,{...native.intent,state:"completed"});
      db.prepare("DELETE FROM servers WHERE id='fixture'").run();
      db.prepare("DELETE FROM meta WHERE key IN ('mcp-instance:fixture','mcp-command:fixture','mcp-quarantine:fixture','mcp-changes:fixture')").run();
      checkFullSchema(db,"nativeMcp");validateNativeMcpJournalReferences(db,hub);
    }finally{db.exec("ROLLBACK TO historical; RELEASE historical");}
  });
});

test("restore admission refuses authenticated-store content with pending private waits/setup or prepared native intents",async t=>{
  const f=await fixture(t),native=nativeFixture(f),hub=new DatabaseSync(f.store.databasePath),db=new DatabaseSync(native.path);
  t.after(()=>{db.close();hub.close();});
  const validate=()=>validateCheckpointStores({hub,nativeMcp:db},null,{ownerId:f.store.ownerId,installationId:f.store.hostId},null);
  assert.throws(validate,/pending MCP/);
  hub.exec("SAVEPOINT restore");db.exec("SAVEPOINT restore");
  try{
    const set=hub.prepare("UPDATE meta SET value=? WHERE key=?");
    set.run(canonicalJson({...f.pending.workflow,state:"stopped",revision:2} as JsonValue),`connection_setup_v1:${f.pending.workflow.id}`);
    assert.throws(validate,/pending MCP/,"private wait itself is refused after pending setup is closed");
    set.run(canonicalJson({...f.pendingForm,state:"interrupted",revision:2} as JsonValue),`mcp_private_input_v1:${f.pendingForm.id}`);
    assert.throws(validate,/prepared native MCP/);
    db.prepare("UPDATE meta SET value=? WHERE key=?").run(canonicalJson({...native.intent,state:"interrupted"}),`mcp-grants:${native.intent.operationId}`);
    assert.doesNotThrow(()=>assertMcpCheckpointSafety(hub,db));
  }finally{hub.exec("ROLLBACK TO restore; RELEASE restore");db.exec("ROLLBACK TO restore; RELEASE restore");}
});

test("150 native definitions of about 2 KiB checkpoint and restore with aggregate limits, zero grants/effects and intact original schemas",async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"dx-large-native-checkpoint-"))),source=join(root,"source"),destination=join(root,"destination"),store=new HostStore({dataDir:source});
  t.after(()=>{try{store.close();}catch{/* closed for offline maintenance */}rmSync(root,{recursive:true,force:true});});
  const ownerId=store.ownerId,hostId=store.hostId,nativePath=join(source,"native-mcp.sqlite"),db=new DatabaseSync(nativePath);
  const originalSchema={type:"object",properties:{confirm:{type:"boolean"}},required:["confirm"],additionalProperties:false};
  const catalog=Array.from({length:150},(_,i)=>{
    const mcpName=`synthetic_${i}`,name=`mcp.fixture.${mcpName}`,description=`Synthetic ${i} `+"safe catalog definition metadata ".repeat(28);
    const manifest=checkManifest({name,toolkit:"mcp-fixture",version:sha({name,description,inputSchema:originalSchema}).slice(0,32),upstreamSlug:mcpName,upstreamHost:"fixture.mcp.dexter.internal",description,effect:"write",
      destinationArgument:null,destinationOrigins:null,inputSchema:{type:"object",properties:{},required:[],additionalProperties:false},nativeInputSchema:originalSchema});
    return{id:name,mcpName,description,effect:"write",state:"publishable",manifest,argumentNames:{confirm:"confirm"}};
  });
  assert.equal(catalog.length,150);assert(Buffer.byteLength(JSON.stringify(catalog))>256*1024);assert(catalog.every(tool=>Buffer.byteLength(JSON.stringify(tool))>2*1024));
  const prepared={version:1,operationId:randomUUID(),serverId:"fixture",instancePin:H,state:"prepared",changes:[],catalog,grants:[]};
  const completed={...prepared,operationId:randomUUID(),state:"completed",catalog:null};
  try{
    db.exec(FULL_SCHEMAS.nativeMcp.sql+MCP_INSTANCE_SELECTION_SQL);
    const set=db.prepare("INSERT INTO meta(key,value)VALUES(?,?)");
    for(const [key,value]of [["schema","3"],["installation",hostId],["owner",ownerId],["mcp-instance:fixture",randomUUID()]] as const)set.run(key,value);
    db.prepare("INSERT INTO servers(id,definition,status)VALUES(?,?,'ready')").run("fixture",JSON.stringify(checkMcpDefinition({id:"fixture",name:"Synthetic large catalog",runsOn:"owner_mac",auth:"none",transport:{type:"stdio",command:"/usr/bin/synthetic-checkpoint-only"}})));
    db.prepare("INSERT INTO catalogs(server_id,tools)VALUES(?,?)").run("fixture",JSON.stringify(catalog));
    set.run(`mcp-grants:${prepared.operationId}`,JSON.stringify(prepared));set.run(`mcp-grants:${completed.operationId}`,JSON.stringify(completed));
    checkFullSchema(db,"nativeMcp");
    const hub=new DatabaseSync(store.databasePath,{readOnly:true});
    try{
      assert.equal(validateNativeMcp(db,hub).catalogs,1);
      await t.test("original definition with credential canary is rejected whole, with no redaction",()=>{
        const unsafe=catalog.map((tool,i)=>i?tool:{...tool,manifest:{...tool.manifest,nativeInputSchema:{...originalSchema,properties:{confirm:{type:"boolean"},choice:{type:"string",default:"Bearer AbC0def123GhI456jKlM789pqRst"}}}}});
        assert.throws(()=>validateNativeMcpCatalogMetadata(unsafe));
        db.exec("SAVEPOINT canary");try{
          db.prepare("UPDATE catalogs SET tools=? WHERE server_id='fixture'").run(JSON.stringify(unsafe));
          assert.throws(()=>validateNativeMcp(db,hub));
          assert.equal(JSON.parse(String(db.prepare("SELECT tools FROM catalogs WHERE server_id='fixture'").get()!.tools))[0].manifest.nativeInputSchema.properties.choice.default,"Bearer AbC0def123GhI456jKlM789pqRst");
          db.prepare("UPDATE meta SET value=? WHERE key=?").run(JSON.stringify({...prepared,catalog:unsafe}),`mcp-grants:${prepared.operationId}`);
          assert.throws(()=>checkFullSchema(db,"nativeMcp"));
        }finally{db.exec("ROLLBACK TO canary; RELEASE canary");}
      });
      await t.test("one definition over 256 KiB is rejected inside an otherwise valid larger aggregate",()=>{
        const oversized=catalog.map((tool,i)=>i?tool:{...tool,manifest:{...tool.manifest,nativeInputSchema:{...originalSchema,description:"Synthetic safe metadata ".repeat(12_000)}}});
        assert.throws(()=>validateNativeMcpCatalogMetadata(oversized));
      });
    }finally{hub.close();}
  }finally{db.close();}
  await t.test("database byte budget is refused before any large metadata inspection",()=>{
    let inspections=0;const target=join(root,"oversized-copy.sqlite");
    assert.throws(()=>vacuumInto("nativeMcp",()=>{inspections++;throw new Error("Metadata must not be scanned before the database quota");},nativePath,target,
      {ownerId,installationId:hostId},{...DEFAULT_LIMITS,maxDatabaseBytes:16*1024},new OwnedPaths()),error=>!!error&&typeof error==="object"&&"code"in error&&error.code==="quota_exceeded");
    assert.equal(inspections,0);assert.equal(existsSync(target),false);
  });
  const before=meta(nativePath);store.close();
  const {privateKey,publicKey}=generateKeyPairSync("ed25519"),secret=createSecretKey(randomBytes(32)),key:SnapshotKey={keyId:"synthetic-large-native",use:fn=>fn(secret)},owner:OwnerAuthority={publicKey,sign:bytes=>sign(null,bytes,privateKey)};
  const coordinator=AuthorityCoordinator.open(join(root,"coordinator"),{ownerId,ownerPublicKey:publicKey});t.after(()=>coordinator.close());
  const maintenance=new OfflineMaintenance(source);t.after(()=>maintenance.close());
  const controller=new LocalAuthorityController({coordinator}),hold=await controller.quiesce(maintenance),artifact=join(root,"large.dxg8"),captured=controller.prepare(hold,{output:artifact,key});
  assert.deepEqual(meta(nativePath),before,"only staged intent changes to interrupted");
  controller.revokeSource({store:hold.store},captured.checkpointId,destination);controller.activate({artifact,key,receipt:controller.issueReceipt(owner,captured.checkpointId)});
  const restored=new HostStore({dataDir:destination}),native=new DatabaseSync(join(destination,"native-mcp.sqlite"),{readOnly:true}),hub=new DatabaseSync(restored.databasePath,{readOnly:true});
  try{
    assert.equal(validateNativeMcp(native,hub).catalogs,1);
    const restoredCatalog=JSON.parse(String(native.prepare("SELECT tools FROM catalogs WHERE server_id='fixture'").get()!.tools));assert.deepEqual(restoredCatalog,catalog);
    const intent=JSON.parse(String(native.prepare("SELECT value FROM meta WHERE key=?").get(`mcp-grants:${prepared.operationId}`)!.value));assert.equal(intent.state,"interrupted");assert.deepEqual(intent.catalog,catalog);
    const history=JSON.parse(String(native.prepare("SELECT value FROM meta WHERE key=?").get(`mcp-grants:${completed.operationId}`)!.value));assert.equal(history.catalog,null);assert.equal(history.state,"completed");
    assert.equal(hub.prepare("SELECT COUNT(*) AS n FROM grants").get()!.n,0);assert.equal(hub.prepare("SELECT COUNT(*) AS n FROM actions").get()!.n,0);assert.equal(native.prepare("SELECT COUNT(*) AS n FROM connections").get()!.n,0);
  }finally{native.close();hub.close();}
  const runtime=new NativeMcpRuntime({host:{runsOn:"owner_mac",stdioRoot:join(destination,"mcp-stdio")},oauth:false}),gateway=new CapabilityGateway({store:restored,broker:runtime.broker,adapter:runtime.adapter});
  let effects=0;restored.applyGrantBatch=()=>{effects++;throw new Error("Restored catalog grants nothing");};
  try{
    runtime.bind(restored,gateway);assert.equal(runtime.admin.tools("fixture").length,150);assert.equal(runtime.openSessions,0);assert.equal(effects,0);assert.equal(existsSync(join(destination,"mcp-stdio")),false);
    const verification=new DatabaseSync(restored.databasePath,{readOnly:true});try{assert.equal(verification.prepare("SELECT COUNT(*) AS n FROM grants").get()!.n,0);}finally{verification.close();}
  }
  finally{await runtime.close();gateway.close();restored.close();}
});
