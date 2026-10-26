import assert from "node:assert/strict";
import { createHash, createSecretKey, type KeyObject } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { deflateSync } from "node:zlib";
import { defaultLiveVoiceConfiguration, LIVE_VOICE_META_KEY, liveVoiceConfigurationJSON } from "@dexter/contracts";
import { canonicalJson, hashRequest, HostError, HostStore, SCHEMA_VERSION, validatePng, type ExistingHostIdentity } from "@dexter/hub";
import { captureInspectionSnapshot, checkFullSchema, INSPECTION_DIR, INSPECTION_FILES, restoreForInspection, type SnapshotKey } from "@dexter/operations";
import { EXACT_SCHEMAS } from "../packages/operations/src/exact.js";

// Historical SQL and synthetic records only. No native CLI, account, keychain, personal database, network or root.
const sha = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");
const hostCode = (code: string) => (error: unknown): boolean => error instanceof HostError && error.code === code;
const CLAUDE_BOT = "bot_synthetic_claude", CODEX_BOT = "bot_synthetic_codex";
const CLAUDE_THREAD = "thread_synthetic_claude", CODEX_THREAD = "thread_synthetic_codex";
const ROOT_TURN = "turn_synthetic_root", CHILD_TURN = "turn_synthetic_child";
const imageId = "11111111-1111-4111-8111-111111111111";
const selection = (engine: "claude" | "codex"): string => JSON.stringify({ engine, model: null, reasoningEffort: null, speed: null });
const actionRequest = { botId: CLAUDE_BOT, threadId: CLAUDE_THREAD, tool: "synthetic.read",
  destination: "synthetic-destination", idempotencyKey: "synthetic-action-receipt", arguments: { path: "synthetic.md" } };

function png(): Buffer {
  const crc = (bytes: Buffer): number => {
    let value = 0xffffffff;
    for (const byte of bytes) { value ^= byte; for (let bit=0; bit<8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Buffer): Buffer => {
    const body=Buffer.concat([Buffer.from(name),data]), head=Buffer.alloc(4), tail=Buffer.alloc(4);
    head.writeUInt32BE(data.length); tail.writeUInt32BE(crc(body)); return Buffer.concat([head,body,tail]);
  };
  const header=Buffer.alloc(13); header.writeUInt32BE(1,0); header.writeUInt32BE(1,4); header[8]=8; header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),
    chunk("IDAT",deflateSync(Buffer.from([0,15,30,45,255]))),chunk("IEND",Buffer.alloc(0))]);
}

function fixture(t: TestContext): { root: string; dataDir: string; identity: ExistingHostIdentity; image: Buffer } {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"dexter-engine-migration-"))), dataDir=join(root,"host"), image=png();
  chmodSync(root,0o700); mkdirSync(dataDir,{mode:0o700});
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const identity={installationId:"synthetic-engine-installation",ownerId:"synthetic-engine-owner"};
  const db=new DatabaseSync(join(dataDir,"dexter.sqlite"),{enableForeignKeyConstraints:true});
  try {
    db.exec(EXACT_SCHEMAS.hub8.sql); db.exec("PRAGMA user_version=8;PRAGMA journal_mode=WAL;");
    for (const [key,value] of [["host_id",identity.installationId],["owner_id",identity.ownerId],
      [LIVE_VOICE_META_KEY,liveVoiceConfigurationJSON({...defaultLiveVoiceConfiguration(),revision:2,botVoices:{[CLAUDE_BOT]:"bossa"}})]])
      db.prepare("INSERT INTO meta(key,value)VALUES(?,?)").run(key!,value!);
    db.prepare(`INSERT INTO host_authority(id,installation_id,owner_id,epoch,state,directory,directory_ino,provenance,updated_at)
      VALUES(1,?,?,3,'active',?,?,'genesis',10)`).run(identity.installationId,identity.ownerId,dataDir,statSync(dataDir,{bigint:true}).ino.toString());
    db.prepare("INSERT INTO profiles VALUES('profile_synthetic',?,10)").run(identity.ownerId);
    for (const [id,engine,master] of [[CLAUDE_BOT,"claude",1],[CODEX_BOT,"codex",0]] as const) {
      db.prepare(`INSERT INTO bots(id,owner_id,profile_id,name,engine,created_at,role_description,avatar_emoji,
        can_see_bots,can_receive_orders,can_send_actions,is_master,revision,default_selection)
        VALUES(?,?,'profile_synthetic',?,?,10,'Synthetic preserved role','🧪',1,1,1,?,4,?)`)
        .run(id,identity.ownerId,`Synthetic ${engine}`,engine,master,selection(engine));
    }
    for (const [thread,bot,engine,turn,cursor] of [[CLAUDE_THREAD,CLAUDE_BOT,"claude",ROOT_TURN,17],
      [CODEX_THREAD,CODEX_BOT,"codex",CHILD_TURN,23]] as const) {
      db.prepare("INSERT INTO threads VALUES(?,?,10)").run(thread,bot);
      db.prepare("INSERT INTO thread_sessions VALUES(?,?,?,10,11)").run(thread,engine,`synthetic-native-${engine}`);
      db.prepare("INSERT INTO thread_engine_selections(thread_id,selection,revision,handoff)VALUES(?,?,2,?)")
        .run(thread,selection(engine),"Synthetic handoff retained");
      const input=`Synthetic ${engine} historical input`, output=`Synthetic ${engine} historical output`;
      db.prepare("INSERT INTO messages(cursor,id,thread_id,client_message_id,role,content,created_at)VALUES(?,?,?,?,'user',?,10)")
        .run(cursor,`${turn}_input`,thread,`turn-in:${turn}`,input);
      db.prepare("INSERT INTO messages(cursor,id,thread_id,client_message_id,role,content,created_at)VALUES(?,?,?,?,'assistant',?,11)")
        .run(cursor+1,`${turn}_output`,thread,`turn-out:${turn}`,output);
      db.prepare(`INSERT INTO turns(cursor,id,thread_id,bot_id,engine,client_request_id,input_hash,input_message_id,output_message_id,
        state,output_chars,created_at,started_at,finished_at,updated_at,selection,handoff)
        VALUES(?,?,?,?,?,?,?,?,?,'completed',?,10,10,11,11,?,?)`)
        .run(cursor,turn,thread,bot,engine,`historical-${engine}`,engine === "claude"
          ? sha(JSON.stringify({content:input,attachments:[{id:imageId,sha256:validatePng(image).sha256}]})) : sha(input),`${turn}_input`,`${turn}_output`,output.length,
          selection(engine),"Synthetic turn handoff retained");
      const event=db.prepare("INSERT INTO turn_events(turn_id,thread_id,kind,text,data,created_at)VALUES(?,?,?,NULL,?,10)");
      event.run(turn,thread,"turn.queued",null); event.run(turn,thread,"turn.started",null);
      event.run(turn,thread,"turn.completed",JSON.stringify({code:null,outputMessageId:`${turn}_output`}));
    }
    // Deleted historical turns must not let a rebuilt AUTOINCREMENT cursor reuse an observed ID.
    db.prepare("UPDATE sqlite_sequence SET seq=900 WHERE name='turns'").run();
    db.prepare("INSERT INTO grants VALUES('grant_synthetic',?,'synthetic.read','synthetic-destination','ask',NULL,7,10)").run(CLAUDE_BOT);
    db.prepare(`INSERT INTO actions(id,bot_id,thread_id,tool,destination,idempotency_key,request,request_hash,grant_revision,state,
      created_at,updated_at,approval_expires_at,decided_by,reason)VALUES('action_synthetic',? ,?,'synthetic.read','synthetic-destination',
      'synthetic-action-receipt',?,?,7,'denied',10,11,60000,?,'user_denied')`)
      .run(CLAUDE_BOT,CLAUDE_THREAD,canonicalJson(actionRequest),hashRequest(actionRequest),identity.ownerId);
    db.prepare("INSERT INTO devices VALUES('dev_synthetic',?,'Synthetic Mac','macos','[]',10,11,NULL)").run(identity.ownerId);
    db.prepare(`INSERT INTO bot_delegations(id,source_bot_id,target_bot_id,source_thread_id,target_thread_id,source_turn_id,target_turn_id,
      parent_id,root_id,depth,deadline_at,state,created_at,updated_at,result,request_hash,call_id)
      VALUES('delegation_synthetic',?,?,?,?,?,?,NULL,?,1,100000,'completed',10,11,'Synthetic result',?,'synthetic-call')`)
      .run(CLAUDE_BOT,CODEX_BOT,CLAUDE_THREAD,CODEX_THREAD,ROOT_TURN,CHILD_TURN,ROOT_TURN,"a".repeat(64));
    const validated=validatePng(image);
    db.prepare("INSERT INTO image_attachments VALUES(?,?,?,'image/png',?,?,?,?,10,?)")
      .run(imageId,CLAUDE_THREAD,imageId,validated.sha256,validated.bytes,validated.width,validated.height,image);
    db.prepare("INSERT INTO message_attachments VALUES(?,?,0)").run(`${ROOT_TURN}_input`,imageId);
    // Keep a real image-set hash on the Claude receipt and a text-only Codex receipt for historical replay.
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
    assert.deepEqual(checkFullSchema(db,"hub"),identity,"version8 remains an exact supported catalog");
    db.prepare("UPDATE thread_engine_selections SET selection=? WHERE thread_id=?")
      .run(JSON.stringify({engine:"grok",model:null,reasoningEffort:null,speed:null}),CLAUDE_THREAD);
    assert.throws(()=>checkFullSchema(db,"hub"),error=>!!error && typeof error === "object" && "code" in error && error.code === "corrupt",
      "expanded contracts do not retroactively admit a schema9 engine in a historical artifact");
    db.prepare("UPDATE thread_engine_selections SET selection=? WHERE thread_id=?").run(selection("claude"),CLAUDE_THREAD);
  } finally { db.close(); }
  return {root,dataDir,identity,image};
}

function read<T>(path: string, operation: (db: DatabaseSync)=>T): T {
  const db=new DatabaseSync(path,{readOnly:true}); try { return operation(db); } finally { db.close(); }
}
function logical(path: string): Record<string,unknown> {
  return read(path,db=>Object.fromEntries((db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name!='host_lease' ORDER BY name").all() as {name:string}[])
    .map(({name})=>[name,db.prepare(`SELECT * FROM "${name}"`).all()
      .map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value])))
      .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))])));
}

test("canonical schema8 migrates to schema9 with durable receipts, authority and expanded engine CHECKs",t=>{
  const f=fixture(t), path=join(f.dataDir,"dexter.sqlite"), before=logical(path);
  assert.throws(()=>new HostStore({dataDir:f.dataDir,existingInstallation:{...f.identity,ownerId:"synthetic-wrong-owner"}}),hostCode("forbidden"));
  assert.equal(read(path,db=>db.prepare("PRAGMA user_version").get()!.user_version),8);
  assert.deepEqual(logical(path),before,"identity refusal did not migrate or mutate data");
  let store: HostStore | undefined=new HostStore({dataDir:f.dataDir,existingInstallation:f.identity});
  try {
    assert.equal(SCHEMA_VERSION,9); assert.equal(store.summary().schemaVersion,9);
    assert.deepEqual(logical(path),before,"rebuild preserved every durable row, BLOB, permission and high-water mark");
    assert.equal(store.authorityStatus().epoch,3);
    assert.equal(store.createTurn(CODEX_THREAD,{clientRequestId:"historical-codex",content:"Synthetic codex historical input"}).created,false);
    assert.throws(()=>store!.createTurn(CODEX_THREAD,{clientRequestId:"historical-codex",content:"Changed synthetic input"}),hostCode("conflict"));
    assert.equal(store.requestAction(actionRequest).id,"action_synthetic");
    assert.equal(store.getBot(CLAUDE_BOT).isMaster,true);
    assert.equal(store.getGrant(CLAUDE_BOT,"synthetic.read","synthetic-destination")!.revision,7);
    assert.deepEqual(Buffer.from(store.getImageAttachment(CLAUDE_THREAD,imageId).data),f.image);
    store.withWriterLease(()=>assert.equal((store as unknown as {db:DatabaseSync}).db.prepare("PRAGMA foreign_keys").get()!.foreign_keys,1));
    for (const engine of ["grok","muse","antigravity"] as const) {
      const bot=store.createBot({name:`Synthetic ${engine}`,profileId:"profile_synthetic",engine}), thread=store.createThread(bot.id);
      const turn: ReturnType<HostStore["createTurn"]>["turn"]=store.createTurn(thread.id,{clientRequestId:`new-${engine}`,content:`Synthetic ${engine} turn`}).turn;
      assert.ok(turn.cursor>900); assert.equal(turn.engine,engine); assert.equal(store.getThreadSession(thread.id)!.engine,engine);
      assert.equal(store.claimNextTurn(thread.id)!.id,turn.id); store.appendTurnDelta(turn.id,`Synthetic ${engine} result`);
      store.finishTurn(turn.id,"completed",null,`synthetic-${engine}-cursor`);
      assert.equal(store.createTurn(thread.id,{clientRequestId:`new-${engine}`,content:`Synthetic ${engine} turn`}).created,false);
    }
    read(path,db=>{assert.deepEqual(checkFullSchema(db,"hub"),f.identity);assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);});
    const keyObject=createSecretKey(Buffer.alloc(32,23));
    const key: SnapshotKey={keyId:"synthetic-migration-key",use:<T>(operation:(lent:KeyObject)=>T):T=>operation(keyObject)};
    const captured=captureInspectionSnapshot({source:store,key,output:join(f.root,"engine-migration.dxg8"),
      include:{context:false,agenda:false,deviceRegistry:false,deviceSurface:false}});
    const restored=restoreForInspection({artifact:captured.path,key,destination:join(f.root,"inspection"),expect:f.identity});
    const inspected=join(restored.destination,INSPECTION_DIR,INSPECTION_FILES.hub);
    read(inspected,db=>{
      assert.deepEqual(checkFullSchema(db,"hub"),f.identity); assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,9);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
      assert.deepEqual(Buffer.from(db.prepare("SELECT data FROM image_attachments WHERE id=?").get(imageId)!.data as Uint8Array),f.image);
      assert.deepEqual(db.prepare("SELECT engine FROM bots WHERE engine IN ('grok','muse','antigravity') ORDER BY engine").all().map(row=>row.engine),["antigravity","grok","muse"]);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM host_lease").get()!.n,0);
      assert.equal(db.prepare("SELECT state FROM host_authority").get()!.state,"revoked","inspection is never a writer");
    });
    store.close(); store=new HostStore({dataDir:f.dataDir,existingInstallation:f.identity});
    assert.equal(store.getBot(CLAUDE_BOT).revision,4); assert.equal(store.getTurn(CHILD_TURN).cursor,23);
    assert.equal(store.getThreadSession(CODEX_THREAD)!.nativeCursor,"synthetic-native-codex");
    t.diagnostic(JSON.stringify({migration:"8_to_9",addedEngines:["grok","muse","antigravity"],durableRowsPreserved:true,
      foreignKeysEnabled:true,exactSchemaBackupAndReopen:true,realAccountsUsed:false}));
  } finally { store?.close(); }
});

test("engine rebuild refuses unknown DDL and broken references without dropping historical records",t=>{
  for (const corruption of ["extra_index","broken_reference"] as const) {
    const f=fixture(t), path=join(f.dataDir,"dexter.sqlite"), db=new DatabaseSync(path);
    try {
      if(corruption==="extra_index") db.exec("CREATE INDEX synthetic_unadmitted_index ON bots(name)");
      else { db.exec("PRAGMA foreign_keys=OFF"); db.prepare("UPDATE grants SET bot_id='bot_synthetic_missing'").run(); }
    } finally { db.close(); }
    const before=logical(path), oldCatalog=read(path,raw=>raw.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name").all());
    assert.throws(()=>new HostStore({dataDir:f.dataDir,existingInstallation:f.identity}),hostCode("conflict"));
    assert.equal(read(path,raw=>raw.prepare("PRAGMA user_version").get()!.user_version),8);
    assert.deepEqual(logical(path),before); assert.deepEqual(read(path,raw=>raw.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name").all()),oldCatalog);
  }
});

test("closed schema8 authority checkpoint activates through schema9 without losing conversation bindings",t=>{
  const f=fixture(t), checkpointId="ckp_syntheticEngineMigration", sourcePath=join(f.dataDir,"dexter.sqlite");
  const source=new DatabaseSync(sourcePath);
  try {
    source.exec("PRAGMA journal_mode=DELETE");
    source.prepare("UPDATE host_authority SET state='checkpointed',checkpoint_id=? WHERE id=1").run(checkpointId);
    assert.deepEqual(checkFullSchema(source,"hub"),f.identity);
  } finally { source.close(); }
  const destination=join(f.root,"activated"); mkdirSync(destination,{mode:0o700});
  const copyPath=join(destination,"dexter.sqlite"); copyFileSync(sourcePath,copyPath); chmodSync(copyPath,0o600);
  const report=HostStore.activateCheckpointCopy(copyPath,{...f.identity,checkpointId,sourceEpoch:3,directory:destination,
    directoryIno:statSync(destination,{bigint:true}).ino.toString(),receiptSha256:"b".repeat(64),activatedAt:120000});
  assert.equal(report.epoch,4); assert.equal(report.nativeCursorsCleared,2); assert.equal(report.devicesRevoked,1);
  read(copyPath,db=>{
    assert.deepEqual(checkFullSchema(db,"hub"),f.identity); assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,9);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
    assert.equal(db.prepare("SELECT cursor FROM turns WHERE id=?").get(CHILD_TURN)!.cursor,23);
    assert.equal(db.prepare("SELECT state FROM bot_delegations WHERE id='delegation_synthetic'").get()!.state,"completed");
    assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='turns'").get()!.seq,900);
  });
  const activated=new HostStore({dataDir:destination,ownerId:f.identity.ownerId});
  try { assert.equal(activated.hostId,f.identity.installationId); assert.equal(activated.authorityStatus().epoch,4);
    assert.equal(activated.createTurn(CODEX_THREAD,{clientRequestId:"historical-codex",content:"Synthetic codex historical input"}).created,false); }
  finally { activated.close(); }
  assert.equal(read(sourcePath,db=>db.prepare("PRAGMA user_version").get()!.user_version),8,"closed source catalog remains historical");
});
