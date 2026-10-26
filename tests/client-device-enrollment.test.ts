import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { HostStore, HostError, CLIENT_DEVICE_SCOPES, SCHEMA_VERSION, canonicalJson,
  type ClientDeviceClaimInput, type ClientDeviceClaimKey } from "@dexter/hub";
import { createHash } from "node:crypto";
const code = (value: string) => (error: unknown) => error instanceof HostError && error.code === value;
const claim = (extra: Partial<ClientDeviceClaimInput> = {}): ClientDeviceClaimInput => ({namespace:"app-client-v1",claimId:"claim_fixture",name:"Phone",fingerprint:"a".repeat(64),role:"client-ios",scopes:["chat.read","chat.write"],...extra});
const key = {namespace:"app-client-v1",claimId:"claim_fixture"} as const;
function lab(t: TestContext) {
  const dir=mkdtempSync(join(tmpdir(),"dx-client-enroll-"));let store=new HostStore({dataDir:dir});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,get store(){return store;},restart(){store.close();store=new HostStore({dataDir:dir});return store;},
    db(){return new DatabaseSync(store.databasePath);}};
}
function counts(db: DatabaseSync) {
  return Object.fromEntries(["devices","events","client_device_enrollments","grants"].map(table=>[table,Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n)]));
}
function schema2(l: ReturnType<typeof lab>) {
  l.store.close();const db=l.db();db.exec("DROP TRIGGER host_authority_no_delete;DROP TRIGGER host_authority_revoked_final;DROP TRIGGER host_authority_forward;DROP TABLE host_authority;DROP TRIGGER client_enrollment_no_update;DROP TRIGGER client_enrollment_no_delete;DROP TABLE client_device_enrollments;PRAGMA user_version=2");db.close();
}
// Schema 4: a database older than the authority schema opens only through the explicit owner-local upgrade.
const upgrade=(l: ReturnType<typeof lab>)=>{assert.throws(()=>new HostStore({dataDir:l.dir}),code("conflict"));return new HostStore({dataDir:l.dir,authorityBootstrap:"legacy_upgrade"});};
function tamper(l: ReturnType<typeof lab>,sql:string) {
  const db=l.db();db.exec("PRAGMA foreign_keys=OFF;DROP TRIGGER client_enrollment_no_update");const trigger="CREATE TRIGGER client_enrollment_no_update BEFORE UPDATE ON client_device_enrollments BEGIN SELECT RAISE(ABORT, 'client enrollment is immutable'); END";
  db.exec(sql);db.exec(trigger);db.close();
}
test("same claim atomically enrolls one canonical device/event, computes digest and survives reload/restart",t=>{
  const l=lab(t);assert.equal(SCHEMA_VERSION,4);const input=claim({name:" Phone ",scopes:["chat.write","chat.read"]});
  const one=l.store.registerClientDeviceForClaim(input);
  assert.equal(one.hostId,l.store.hostId);assert.equal(one.ownerId,l.store.ownerId);assert.equal(one.deviceId,one.device.id);
  assert.equal(one.device.platform,"ios");assert.deepEqual(one.device.capabilities,[]);assert.deepEqual(one.scopes,["chat.read","chat.write"]);assert.equal(one.originalName,"Phone");
  const expected=createHash("sha256").update(canonicalJson({...claim(),scopes:[...claim().scopes],hostId:l.store.hostId,ownerId:l.store.ownerId})).digest("hex");assert.equal(one.digest,expected);
  assert.deepEqual(l.store.registerClientDeviceForClaim(claim()),one);assert.deepEqual(l.store.findClientDeviceEnrollment(key),one);
  assert.deepEqual(l.restart().registerClientDeviceForClaim(claim()),one);
  const db=l.db();assert.deepEqual(counts(db),{devices:1,events:1,client_device_enrollments:1,grants:0});assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);db.close();
  assert.equal(l.store.listEvents().filter(e=>e.kind==="device.registered").length,1);
});
test("client-mac role and an empty privilege list publish no tool capabilities or grants",t=>{
  const l=lab(t), e=l.store.registerClientDeviceForClaim(claim({role:"client-mac",scopes:[]}));
  assert.equal(e.device.platform,"macos");assert.deepEqual(e.scopes,[]);assert.deepEqual(e.device.capabilities,[]);
  const db=l.db();assert.equal(counts(db).grants,0);db.close();assert.ok(Object.isFrozen(CLIENT_DEVICE_SCOPES));assert.ok(Object.isFrozen(e.scopes));
});
test("same-key divergence in every immutable field conflicts without device/name/event mutation",t=>{
  const l=lab(t),e=l.store.registerClientDeviceForClaim(claim());
  for(const extra of [{name:"Other"},{fingerprint:"b".repeat(64)},{role:"client-mac" as const},{scopes:["devices.manage"] as const}])
    assert.throws(()=>l.store.registerClientDeviceForClaim(claim(extra)),code("conflict"));
  assert.deepEqual(l.store.findClientDeviceEnrollment(key),e);const db=l.db();assert.deepEqual(counts(db),{devices:1,events:1,client_device_enrollments:1,grants:0});db.close();
});
test("one certificate cannot enroll a second canonical ID under a new claim",t=>{
  const l=lab(t),e=l.store.registerClientDeviceForClaim(claim());assert.throws(()=>l.store.registerClientDeviceForClaim(claim({claimId:"claim_other"})),code("conflict"));
  assert.equal(l.store.findClientDeviceEnrollment({namespace:"app-client-v1",claimId:"claim_other"}),null);assert.equal(l.store.listDevices().length,1);assert.equal(l.store.getDevice(e.deviceId).id,e.deviceId);
});
test("replay returns current renamed/revoked device and never restores denied grant or capabilities",t=>{
  const l=lab(t),e=l.store.registerClientDeviceForClaim(claim());l.store.renameDevice(e.deviceId,{name:"Renamed"});
  const bot=l.store.createBot({name:"Synthetic",profileId:"personal",engine:"claude"});l.store.setGrant({botId:bot.id,tool:"mail.send",destination:e.deviceId,policy:"allow"});
  const denied=l.store.setGrant({botId:bot.id,tool:"mail.send",destination:e.deviceId,policy:"deny"});l.store.revokeDevice(e.deviceId);
  const replay=l.restart().registerClientDeviceForClaim(claim());assert.equal(replay.deviceId,e.deviceId);assert.equal(replay.device.name,"Renamed");assert.notEqual(replay.device.revokedAt,null);
  assert.equal(replay.originalName,"Phone");assert.equal(replay.digest,e.digest);assert.deepEqual(l.store.getGrant(bot.id,"mail.send",e.deviceId),denied);assert.deepEqual(replay.device.capabilities,[]);
  assert.equal(l.store.listDevices().length,1);assert.equal(l.store.listEvents().filter(e=>e.kind==="device.registered").length,1);
});
test("invalid roles/scopes/digests/principals/controls/byte bounds fail before any canonical effect",t=>{
  const l=lab(t);const invalid:unknown[]=[null,[],"body",claim({role:"agent-mac" as never}),claim({scopes:["mac.cua"] as never}),claim({scopes:["chat.read","chat.read"]}),claim({scopes:Array(9).fill("chat.read")}),claim({name:""}),claim({name:"a".repeat(121)}),claim({name:"a".repeat(481)}),claim({name:" ".repeat(481)+"Phone"}),claim({name:"\ud800"}),claim({name:"\udfff"}),claim({name:"hello\nworld"}),claim({name:"hello\u0085world"}),claim({claimId:"id\n"}),claim({claimId:"x".repeat(129)}),claim({fingerprint:"A".repeat(64)}),claim({fingerprint:"a".repeat(63)}),claim({fingerprint:"a".repeat(65)}),{...claim(),namespace:"agent-v1"},{...claim(),digest:"a".repeat(64)},{...claim(),ownerId:"other"},{...claim(),hostId:"other"},{...claim(),platform:"macos"},{...claim(),capabilities:["mac.file.append"]}];
  for(const input of invalid)assert.throws(()=>l.store.registerClientDeviceForClaim(input as never),code("invalid_input"));
  let getters=0;const accessor={...claim()};Object.defineProperty(accessor,"name",{get(){getters++;return "Phone";}});assert.throws(()=>l.store.registerClientDeviceForClaim(accessor),code("invalid_input"));assert.equal(getters,0);
  const scopes=["chat.read"] as any;Object.defineProperty(scopes,0,{get(){getters++;return "chat.read";}});assert.throws(()=>l.store.registerClientDeviceForClaim(claim({scopes})),code("invalid_input"));assert.equal(getters,0);
  const db=l.db();assert.deepEqual(counts(db),{devices:0,events:0,client_device_enrollments:0,grants:0});db.close();
});
test("input snapshots and returned objects cannot rewrite immutable scopes or device metadata",t=>{
  const l=lab(t);const input=claim(), e=l.store.registerClientDeviceForClaim(input);(input.scopes as string[]).push("devices.manage");input.name="Changed";
  e.device.name="Fake";e.device.capabilities.push("mac.file.append");assert.throws(()=>(e.scopes as string[]).push("devices.manage"));
  assert.equal(l.store.findClientDeviceEnrollment(key)!.device.name,"Phone");assert.deepEqual(l.store.findClientDeviceEnrollment(key)!.device.capabilities,[]);
  assert.deepEqual(l.store.findClientDeviceEnrollment(key)!.scopes,["chat.read","chat.write"]);
});
test("missing lookup is null; invalid keys and caller-provided authority are refused",t=>{
  const l=lab(t);assert.equal(l.store.findClientDeviceEnrollment(key),null);
  for(const input of [null,{}, {...key,ownerId:"other"},{...key,digest:"a".repeat(64)},{...key,namespace:"other"},{...key,claimId:"../claim"}])
    assert.throws(()=>l.store.findClientDeviceEnrollment(input as ClientDeviceClaimKey),code("invalid_input"));
});
test("real SQLite insert-trigger failure between device and journal rolls back all devices/events/enrollments",t=>{
  const l=lab(t),db=l.db();db.exec("CREATE TRIGGER synthetic_claim_fault BEFORE INSERT ON client_device_enrollments BEGIN SELECT RAISE(ABORT,'synthetic_claim_fault');END");
  assert.throws(()=>l.store.registerClientDeviceForClaim(claim()),/synthetic_claim_fault/);assert.deepEqual(counts(db),{devices:0,events:0,client_device_enrollments:0,grants:0});
  db.exec("DROP TRIGGER synthetic_claim_fault");db.close();assert.equal(l.restart().findClientDeviceEnrollment(key),null);const e=l.store.registerClientDeviceForClaim(claim());assert.equal(l.store.listDevices()[0]!.id,e.deviceId);
});
test("event-insert failure rolls back the journal and device too",t=>{
  const l=lab(t),db=l.db();db.exec("CREATE TRIGGER synthetic_event_fault BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'synthetic_event_fault');END");
  assert.throws(()=>l.store.registerClientDeviceForClaim(claim()),/synthetic_event_fault/);assert.deepEqual(counts(db),{devices:0,events:0,client_device_enrollments:0,grants:0});db.exec("DROP TRIGGER synthetic_event_fault");db.close();
});
test("canonical journal rows are immutable and FK-protect the device/authority metadata",t=>{
  const l=lab(t),e=l.store.registerClientDeviceForClaim(claim()),db=l.db();db.exec("PRAGMA foreign_keys=ON");
  assert.throws(()=>db.exec("UPDATE client_device_enrollments SET role='client-mac'"),/immutable/);assert.throws(()=>db.exec("DELETE FROM client_device_enrollments"),/immutable/);
  assert.throws(()=>db.prepare("DELETE FROM devices WHERE id=?").run(e.deviceId),/FOREIGN KEY/);assert.throws(()=>db.exec("DELETE FROM meta WHERE key='host_id'"),/FOREIGN KEY/);db.close();
});
test("second writer refused; enrollment and missing lookup are fenced after actual token loss",t=>{
  const l=lab(t);l.store.registerClientDeviceForClaim(claim());assert.throws(()=>new HostStore({dataDir:l.dir}),code("host_locked"));
  const db=l.db();db.exec("UPDATE host_lease SET token='synthetic_stolen'");
  assert.throws(()=>l.store.registerClientDeviceForClaim(claim()),code("host_locked"));assert.throws(()=>l.store.registerClientDeviceForClaim(claim({claimId:"new",fingerprint:"b".repeat(64)})),code("host_locked"));
  assert.throws(()=>l.store.findClientDeviceEnrollment(key),code("host_locked"));assert.throws(()=>l.store.findClientDeviceEnrollment({namespace:"app-client-v1",claimId:"missing"}),code("host_locked"));assert.equal(counts(db).devices,1);db.close();
});
test("closed store cannot enroll or lookup even an existing/missing claim",t=>{
  const l=lab(t);l.store.registerClientDeviceForClaim(claim());l.store.close();assert.throws(()=>l.store.registerClientDeviceForClaim(claim()),code("host_locked"));assert.throws(()=>l.store.findClientDeviceEnrollment(key),code("host_locked"));
});
for(const field of ["host_id","owner_id"])test(`foreign ${field} in a persisted journal is conflict, never missing or adopted`,t=>{
  const l=lab(t);l.store.registerClientDeviceForClaim(claim());tamper(l,`UPDATE client_device_enrollments SET ${field}='foreign'`);
  assert.throws(()=>l.store.findClientDeviceEnrollment(key),code("conflict"));assert.throws(()=>l.store.registerClientDeviceForClaim(claim()),code("conflict"));l.store.close();assert.throws(()=>new HostStore({dataDir:l.dir}),code("conflict"));
});
test("changed canonical meta refuses even missing lookup; reopening cannot adopt old journal under another installation",t=>{
  const l=lab(t);l.store.registerClientDeviceForClaim(claim());const db=l.db();db.exec("UPDATE meta SET value='foreign-installation' WHERE key='host_id'");db.close();
  assert.throws(()=>l.store.findClientDeviceEnrollment({namespace:"app-client-v1",claimId:"missing"}),code("conflict"));l.store.close();assert.throws(()=>new HostStore({dataDir:l.dir}),code("conflict"));
});
for(const [name,sql] of [
  ["digest","UPDATE client_device_enrollments SET digest='"+"b".repeat(64)+"'"],
  ["unsorted scopes","UPDATE client_device_enrollments SET scopes='[\"chat.write\",\"chat.read\"]'"],
  ["unknown scopes","UPDATE client_device_enrollments SET scopes='[\"mac.cua\"]'"],
  ["name","UPDATE client_device_enrollments SET original_name=' Other '"],
  ["device FK","UPDATE client_device_enrollments SET device_id='dev_missing'"],
] as const)test(`corrupt ${name} fails lookup and restart closed`,t=>{
  const l=lab(t);l.store.registerClientDeviceForClaim(claim());tamper(l,sql);assert.throws(()=>l.store.findClientDeviceEnrollment(key),code("conflict"));l.store.close();assert.throws(()=>new HostStore({dataDir:l.dir}),code("conflict"));
});
for(const sql of ["UPDATE devices SET owner_id='foreign'","UPDATE devices SET platform='macos'","UPDATE devices SET capabilities='[\"mac.file.append\"]'"])
  test(`canonical device authority/capabilities corruption refuses: ${sql}`,t=>{
    const l=lab(t);l.store.registerClientDeviceForClaim(claim());const db=l.db();db.exec(sql);db.close();assert.throws(()=>l.store.findClientDeviceEnrollment(key),code("conflict"));l.store.close();assert.throws(()=>new HostStore({dataDir:l.dir}),code("conflict"));
  });
test("schema2 migration is additive/repeatable and preserves canonical data/authority",t=>{
  const l=lab(t),bot=l.store.createBot({name:"Preserved",profileId:"p",engine:"codex"}),host=l.store.hostId,owner=l.store.ownerId;schema2(l);
  const upgraded=upgrade(l);t.after(()=>upgraded.close());assert.equal(upgraded.authorityStatus().provenance,"legacy_upgrade");assert.equal(upgraded.hostId,host);assert.equal(upgraded.ownerId,owner);assert.equal(upgraded.getBot(bot.id).name,"Preserved");assert.equal(upgraded.findClientDeviceEnrollment(key),null);
  const e=upgraded.registerClientDeviceForClaim(claim());upgraded.close();assert.equal(l.restart().findClientDeviceEnrollment(key)!.deviceId,e.deviceId);const db=l.db();assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,4);db.close();
});
test("migration collision rolls back table/trigger creation and schema version, no writer acquired",t=>{
  const l=lab(t);schema2(l);const db=l.db();db.exec("CREATE TRIGGER client_enrollment_no_delete BEFORE DELETE ON devices BEGIN SELECT RAISE(ABORT,'synthetic_collision');END");
  assert.throws(()=>new HostStore({dataDir:l.dir}),/already exists/);assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name IN ('client_device_enrollments','client_enrollment_no_update')").get()!.n,0);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM host_lease").get()!.n,0);db.exec("DROP TRIGGER client_enrollment_no_delete");db.close();const after=upgrade(l);assert.equal(after.summary().schemaVersion,4);after.close();
});
test("foreign owner refusal rolls back a pending schema2 migration",t=>{
  const l=lab(t),owner=l.store.ownerId;schema2(l);assert.throws(()=>new HostStore({dataDir:l.dir,ownerId:"foreign"}),code("forbidden"));
  const db=l.db();assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,2);assert.equal(db.prepare("SELECT value FROM meta WHERE key='owner_id'").get()!.value,owner);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='client_device_enrollments'").get()!.n,0);db.close();
});
for(const version of [99,-1])test(`unsupported schema ${version} is refused without rewriting version`,t=>{
  const l=lab(t);l.store.close();const db=l.db();db.exec(`PRAGMA user_version=${version}`);assert.throws(()=>new HostStore({dataDir:l.dir}),code("conflict"));assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,version);db.close();
});
test("claimed schema3 with a malformed enrollment table is refused, not silently repaired",t=>{
  const l=lab(t);l.store.close();const db=l.db();db.exec("DROP TRIGGER client_enrollment_no_update;DROP TRIGGER client_enrollment_no_delete;DROP TABLE client_device_enrollments;CREATE TABLE client_device_enrollments (claim_id TEXT)");
  assert.throws(()=>new HostStore({dataDir:l.dir}),code("conflict"));assert.equal(db.prepare("SELECT COUNT(*) AS n FROM host_lease").get()!.n,0);assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,4);db.close();
});
test("unversioned nonempty/imported DB and missing old authority are refused without assigning owner",t=>{
  const l=lab(t);schema2(l);const db=l.db();db.exec("PRAGMA user_version=0");assert.throws(()=>new HostStore({dataDir:l.dir}),code("conflict"));db.exec("PRAGMA user_version=2;DELETE FROM meta WHERE key='host_id'");
  assert.throws(()=>new HostStore({dataDir:l.dir}),code("conflict"));assert.equal(db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key='host_id'").get()!.n,0);assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,2);db.close();
});
test("VACUUM-copy preserves live writer identity and cannot become another writer or rebind journal authority",t=>{
  const l=lab(t);l.store.registerClientDeviceForClaim(claim());const copyDir=mkdtempSync(join(tmpdir(),"dx-client-vacuum-"));t.after(()=>rmSync(copyDir,{recursive:true,force:true}));const db=l.db();db.prepare("VACUUM INTO ?").run(join(copyDir,"dexter.sqlite"));db.close();
  assert.throws(()=>new HostStore({dataDir:copyDir}),code("host_locked"));const copied=new DatabaseSync(join(copyDir,"dexter.sqlite"));copied.exec("DELETE FROM host_lease;UPDATE meta SET value='foreign' WHERE key='host_id'");copied.close();assert.throws(()=>new HostStore({dataDir:copyDir}),code("conflict"));
});

test("actual v1-to-v3 additive path retains messages, identity and can enroll a client",t=>{
  const l=lab(t),bot=l.store.createBot({name:"V1",profileId:"p",engine:"claude"}),thread=l.store.createThread(bot.id);l.store.appendMessage(thread.id,{clientMessageId:"kept",content:"synthetic kept message"});const host=l.store.hostId;schema2(l);
  const db=l.db();db.exec("DROP TABLE turn_events;DROP TABLE turns;DROP TABLE thread_sessions;PRAGMA user_version=1");db.close();
  const upgraded=upgrade(l);t.after(()=>upgraded.close());assert.equal(upgraded.hostId,host);assert.equal(upgraded.summary().schemaVersion,4);assert.equal(upgraded.listMessages(thread.id)[0]!.content,"synthetic kept message");
  const e=upgraded.registerClientDeviceForClaim(claim());assert.equal(upgraded.createTurn(thread.id,{clientRequestId:"after-migration",content:"synthetic"}).turn.state,"queued");upgraded.close();assert.equal(l.restart().findClientDeviceEnrollment(key)!.deviceId,e.deviceId);
});

test("imported additional enrollment/device/event triggers are refused before writer admission",t=>{
  for(const table of ["client_device_enrollments","devices","events"]){
    const l=lab(t);l.store.close();const db=l.db();db.exec(`CREATE TRIGGER synthetic_imported_trigger BEFORE INSERT ON ${table} BEGIN SELECT 1;END`);
    assert.throws(()=>new HostStore({dataDir:l.dir}),code("conflict"));assert.equal(db.prepare("SELECT COUNT(*) AS n FROM host_lease").get()!.n,0);db.close();
  }
});

test("valid Unicode and all eight explicit scopes round-trip without privilege synthesis",t=>{
  const l=lab(t),input=claim({name:"  Telefone 📱 日本語  ",scopes:[...CLIENT_DEVICE_SCOPES].reverse()});
  const e=l.store.registerClientDeviceForClaim(input);assert.equal(e.originalName,"Telefone 📱 日本語");
  assert.deepEqual(e.scopes,[...CLIENT_DEVICE_SCOPES].sort());assert.deepEqual(l.restart().registerClientDeviceForClaim(input),e);
});

for(const [label,sql] of [
  ["mixed-case Devices", "CREATE TRIGGER synthetic_unrevoke AFTER UPDATE OF revoked_at ON Devices BEGIN UPDATE devices SET revoked_at=NULL WHERE id=NEW.id; END"],
  ["other table host_lease", "CREATE TRIGGER synthetic_unrevoke AFTER INSERT ON host_lease BEGIN UPDATE devices SET revoked_at=NULL; END"],
] as const)test(`imported ${label} trigger refuses open before revoke drift and preserves database`,t=>{
  const l=lab(t),e=l.store.registerClientDeviceForClaim(claim());
  const revoked=l.store.revokeDevice(e.deviceId).revokedAt;assert.notEqual(revoked,null);
  l.store.close();const db=l.db();db.exec(sql);
  const fileBefore=createHash("sha256").update(readFileSync(l.store.databasePath)).digest("hex");
  const before={schema:db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
    devices:db.prepare("SELECT * FROM devices").all(),journal:db.prepare("SELECT * FROM client_device_enrollments").all(),
    events:db.prepare("SELECT * FROM events").all(),lease:db.prepare("SELECT * FROM host_lease").all(),
    version:db.prepare("PRAGMA user_version").get()};
  assert.throws(()=>new HostStore({dataDir:l.dir}),code("conflict"));
  assert.deepEqual({schema:db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
    devices:db.prepare("SELECT * FROM devices").all(),journal:db.prepare("SELECT * FROM client_device_enrollments").all(),
    events:db.prepare("SELECT * FROM events").all(),lease:db.prepare("SELECT * FROM host_lease").all(),
    version:db.prepare("PRAGMA user_version").get()},before);
  assert.equal(db.prepare("SELECT revoked_at FROM devices WHERE id=?").get(e.deviceId)!.revoked_at,revoked);
  assert.equal(createHash("sha256").update(readFileSync(l.store.databasePath)).digest("hex"),fileBefore);
  db.exec("DROP TRIGGER synthetic_unrevoke");db.close();
  assert.equal(l.restart().registerClientDeviceForClaim(claim()).device.revokedAt,revoked);
});

for(const [label,sql] of [
  ["created_at link", "UPDATE devices SET created_at=created_at+1"],
  ["negative revoked_at", "UPDATE devices SET revoked_at=-1"],
  ["unsafe revoked_at", "UPDATE devices SET revoked_at=9007199254740992"],
] as const)test(`invalid ${label} refuses lookup replay and reopening without repair`,t=>{
  const l=lab(t);l.store.registerClientDeviceForClaim(claim());const db=l.db();db.exec(sql);
  const snapshot=db.prepare("SELECT * FROM devices");snapshot.setReadBigInts(true);const before=snapshot.all();
  assert.throws(()=>l.store.findClientDeviceEnrollment(key),code("conflict"));
  assert.throws(()=>l.store.registerClientDeviceForClaim(claim()),code("conflict"));
  l.store.close();assert.throws(()=>new HostStore({dataDir:l.dir}),code("conflict"));
  assert.deepEqual(snapshot.all(),before);
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,4);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM host_lease").get()!.n,0);db.close();
});

test("NFC and NFD immutable names conflict without Unicode normalization",t=>{
  const l=lab(t),input=claim({name:"Café"}),e=l.store.registerClientDeviceForClaim(input);
  assert.throws(()=>l.store.registerClientDeviceForClaim({...input,name:input.name.normalize("NFD")}),code("conflict"));
  assert.deepEqual(l.store.findClientDeviceEnrollment(key),e);
  assert.deepEqual(l.restart().registerClientDeviceForClaim(input),e);
});
