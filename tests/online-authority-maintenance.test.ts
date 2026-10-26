import assert from "node:assert/strict";
import test, {type TestContext} from "node:test";
import {spawn} from "node:child_process";
import {createConnection,createServer} from "node:net";
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,statSync,symlinkSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {setTimeout as delay} from "node:timers/promises";
import {DatabaseSync} from "node:sqlite";
import {HostStore} from "@dexter/hub";
import {AuthorityCoordinator,LocalAuthorityController,readSourceAuthority,currentOperationCatalog} from "@dexter/operations";
import {DeviceClient,DeviceError,MacDeviceDaemon,pairDevice} from "@dexter/devices";
import {HostServices} from "../packages/cli/src/host-services.js";
import {ownerControlRequest} from "../packages/cli/src/owner-control-client.js";
import {parseOwnerControlRequest,OWNER_CONTROL_PROTOCOL,encodeFrame,readFrame} from "../packages/cli/src/owner-control.js";
import {maintenanceResultPath,type OwnerMaintenanceResult} from "../packages/cli/src/owner-authority-maintenance.js";
import {newCustody,seedInstallation,seedDeviceSurface,SURFACE_TOOL} from "./authority-fixture.js";
import {memoryTLS} from "./fixtures/online-memory-tls.js";

function lab(_t:TestContext):string {const p=realpathSync(mkdtempSync(join(tmpdir(),"on-")));chmodSync(p,0o700);return p;}
const files=["dexter.sqlite","context.sqlite","agenda.sqlite","devices.sqlite","device-tools.sqlite","app-clients.sqlite","relay-host/relay-consumer.sqlite","relay-host/relay-associations.sqlite"];
type Row=Record<string,unknown>;
function tables(p:string):Record<string,Row[]> {const db=new DatabaseSync(p,{readOnly:true});try {return Object.fromEntries((db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).map(r=>[String(r.name),db.prepare(`SELECT * FROM "${String(r.name)}"`).all().map(r=>({...r}))]));}finally{db.close();}}
const sorted=(r:Row[])=>r.map(r=>JSON.stringify(r)).sort();
function tree(p:string,prefix=""):Record<string,string>{let out:Record<string,string>={};for(const n of readdirSync(p)){const q=join(p,n),k=prefix+n;if(statSync(q).isDirectory())out={...out,...tree(q,k+"/")};else out[k]=readFileSync(q).toString("base64");}return out;}
function cli(socket:string,artifact:string,dest:string,id:string){const c=spawn(process.execPath,[new URL("../../packages/cli/dist/index.js",import.meta.url).pathname,"authority","transfer","--owner-control-socket",socket,"--artifact",artifact,"--destination",dest,"--request-id",id],{stdio:["ignore","pipe","ignore"]});let stdout="";c.stdout.on("data",b=>stdout+=String(b));const timer=setTimeout(()=>c.kill("SIGTERM"),10_000);return {child:c,done:new Promise<{code:number|null;output:Row}>(resolve=>c.once("exit",code=>{clearTimeout(timer);let output:Row;try{output=JSON.parse(stdout);}catch{output={status:"unknown"};}resolve({code,output});}))};}
async function waitFor(predicate:()=>boolean){const until=Date.now()+3000;while(!predicate()){assert.ok(Date.now()<until,"bounded expected condition");await delay(10);}}

test("closed transfer schema rejects custody/store/catalog fields and unsafe socket paths",()=>{
 const args={requestId:"request_1",artifactPath:"/private/tmp/a",destinationPath:"/private/tmp/b"};
 assert.equal(parseOwnerControlRequest({protocol:OWNER_CONTROL_PROTOCOL,op:"authority.transfer",args}).op,"authority.transfer");
 for(const field of ["dataDir","coordinator","custody","key","receipt","operationCatalog"]){assert.throws(()=>parseOwnerControlRequest({protocol:OWNER_CONTROL_PROTOCOL,op:"authority.transfer",args:{...args,[field]:"forged"}}));}
});

test("missing trusted authority fails before quiesce and leaves owner service/writer admitted",async t=>{
 const p=lab(t),socket=join(p,"owner.sock"),artifact=join(p,"checkpoint"),dest=join(p,"dest");
 const host=new HostServices({dataDir:join(p,"host"),ownerControl:{socketPath:socket},authorityMaintenance:{}});t.after(()=>host.shutdown());
 await host.startOwnerControl();let quiesces=0;host.quiesceForMaintenance=async()=>{quiesces++;throw Error();};
 const out=await cli(socket,artifact,dest,"missing").done;assert.equal(out.code,2);assert.deepEqual(out.output.error,{code:"authority_unavailable",effect:"none"});
 assert.equal(quiesces,0);assert.equal(host.store.authorityStatus().state,"active");assert.equal(existsSync(artifact),false);assert.equal(existsSync(maintenanceResultPath(artifact)),false);
 host.store.createBot({name:"still admitted",engine:"claude",profileId:"personal"});
 assert.throws(()=>new HostServices({dataDir:join(p,"oldguard"),ownerControl:{socketPath:join(p,"other.sock")}}));
});

test("separate CLI ACK leaves owner drain before quiesce; single writer held until another admitted connection closes",async t=>{
 const p=lab(t),socket=join(p,"owner.sock"),artifact=join(p,"checkpoint"),dest=join(p,"dest"),data=join(p,"host");
 const custody=newCustody();const ownerHost=new HostServices({dataDir:data,ownerControl:{socketPath:socket},authorityMaintenance:{custody:custody.provider,graceMs:2000}});
 const coordinator=AuthorityCoordinator.open(join(p,"coord"),{ownerId:ownerHost.store.ownerId,ownerPublicKey:custody.owner.publicKey});await ownerHost.shutdown();
 const host=new HostServices({dataDir:data,ownerControl:{socketPath:socket},authorityMaintenance:{coordinator,custody:custody.provider,graceMs:2000}});t.after(()=>coordinator.close());t.after(()=>host.shutdown());await host.startOwnerControl();
 const held=createConnection(socket);await new Promise<void>(r=>held.once("connect",()=>r()));t.after(()=>held.destroy());
 let entered=false;let borrowed:HostStore|undefined;const real=host.quiesceForMaintenance.bind(host);host.quiesceForMaintenance=async o=>{entered=true;borrowed=await real(o);return borrowed;};
 const first=cli(socket,artifact,dest,"accepted");let done=false;void first.done.then(()=>done=true);
 await waitFor(()=>entered);assert.equal(done,false);assert.equal(borrowed,undefined);assert.throws(()=>new HostStore({dataDir:data}),e=>!!e&&typeof e==="object"&&"code"in e&&e.code==="host_locked");
 held.destroy();const out=await first.done;assert.equal(out.code,0);assert.equal(out.output.status,"source_revoked");assert.equal(borrowed,host.store);assert.equal(readSourceAuthority(data).state,"revoked");
 assert.throws(()=>new HostStore({dataDir:data}));
 const repeat=await ownerControlRequest(socket,{op:"authority.transfer",args:{requestId:"accepted",artifactPath:artifact,destinationPath:dest}});assert.equal(repeat.kind,"not_sent");
});

test("ONE online transfer jointly retains all eight populated stores then complete fresh mTLS pairing route explicit grant local dispatch",async t=>{
 const p=lab(t),data=join(p,"host"),dest=join(p,"dest"),artifact=join(p,"checkpoint"),socket=join(p,"owner.sock");
 const seeded=seedInstallation(data);const surface=await seedDeviceSurface(data,seeded);const custody=newCustody();
 const coordinator=AuthorityCoordinator.open(join(p,"coord"),{ownerId:seeded.ownerId,ownerPublicKey:custody.owner.publicKey});t.after(()=>coordinator.close());
 const sourceHostTLS=memoryTLS(),oldDeviceTLS=memoryTLS();let engineFactoryCalls=0;
 const host=new HostServices({dataDir:data,enableEngines:true,enableMcp:true,enableDeviceTools:true,enableAgenda:true,devices:{identity:sourceHostTLS,pollWaitMs:50,receiptTimeoutMs:1000},makeDriver:()=>{engineFactoryCalls++;throw Error("inference forbidden in this lab");},ownerControl:{socketPath:socket},authorityMaintenance:{coordinator,custody:custody.provider}});await host.startOwnerControl();
 const sourceUrl=await host.startDevices(),oldBundle=host.devicesAdmin.pairingBundle({kind:"pair"}),oldDir=join(p,"old-device");mkdirSync(oldDir,{mode:0o700});
 const oldPair=pairDevice({dataDir:oldDir,trust:{hostUrl:sourceUrl,hostCertPem:sourceHostTLS.certPem,hostFingerprint:sourceHostTLS.fingerprint},identity:oldDeviceTLS,offerId:oldBundle.offerId,code:oldBundle.code,name:"Old exact pin",capabilities:[SURFACE_TOOL],pollIntervalMs:10,timeoutMs:2000});
 await waitFor(()=>host.devicesAdmin.pendingClaims().length===1);host.devicesAdmin.approveClaim(host.devicesAdmin.pendingClaims()[0]!.claimId);const oldBinding=await oldPair;
 host.deviceRoutesAdmin.bindRoute({botId:seeded.botId,deviceId:oldBinding.deviceId,tool:SURFACE_TOOL});host.devicesAdmin.grant({botId:seeded.botId,tool:SURFACE_TOOL,destination:oldBinding.deviceId,policy:"allow"});

 const result=await cli(socket,artifact,dest,"joint8").done;assert.equal(result.code,0);assert.equal(result.output.status,"source_revoked");
 const terminal=JSON.parse(readFileSync(maintenanceResultPath(artifact),"utf8")) as OwnerMaintenanceResult;assert.ok(terminal.receipt);
 assert.equal(statSync(maintenanceResultPath(artifact)).mode&0o777,0o600);assert.ok(!JSON.stringify(terminal).includes(custody.wire.secret));
 const before=Object.fromEntries(files.map(f=>[f,tables(join(data,f))]));const repo=tree(join(data,"context-revisions"));
 const controller=new LocalAuthorityController({coordinator});const activated=controller.activate({artifact,key:custody.key,receipt:terminal.receipt,operationCatalog:currentOperationCatalog()});assert.equal(activated.epoch,2);assert.equal(activated.coverage.deviceSurface,"included");
 t.diagnostic(JSON.stringify({jointEightStoreRows:Object.fromEntries(files.map(f=>[f,Object.fromEntries(Object.entries(before[f]!).map(([table,rows])=>[table,rows.length]))]))}));
 const after=Object.fromEntries(files.map(f=>[f,tables(join(dest,f))]));
 for(const f of files){assert.deepEqual(Object.keys(after[f]!),Object.keys(before[f]!));assert.ok(Object.values(before[f]!).some(r=>r.length>0),`${f} actually populated`);
  for(const table of Object.keys(before[f]!)){
   const src=before[f]![table]!,dst=after[f]![table]!,expected=src.map(r=>({...r}));
   if(f==="dexter.sqlite"&&table==="host_lease"){assert.deepEqual(dst,[]);continue;}
   if(f==="dexter.sqlite"&&table==="host_authority"){
    assert.equal(dst.length,1);const d=dst[0]!;const r=expected[0]!;
    for(const k of ["epoch","state","directory","directory_ino","provenance","checkpoint_id","revoked_artifact","revoked_target","updated_at","activation_receipt"]){assert.ok(k in r);r[k]=d[k];}
    assert.equal(d.epoch,2);assert.equal(d.state,"active");assert.equal(d.directory,dest);assert.equal(d.provenance,"activation");assert.equal(d.checkpoint_id,null);assert.equal(d.revoked_artifact,null);assert.equal(d.revoked_target,null);assert.match(String(d.activation_receipt),/^[0-9a-f]{64}$/);
   }
   if(f==="dexter.sqlite"&&table==="devices")for(const r of expected){const d=dst.find(d=>d.id===r.id)!;assert.ok(d.revoked_at!==null);r.revoked_at=d.revoked_at;}
   if(f==="dexter.sqlite"&&table==="thread_sessions")for(const r of expected){const d=dst.find(d=>d.thread_id===r.thread_id)!;assert.equal(d.native_cursor,null);if(r.native_cursor!==null){r.native_cursor=null;r.updated_at=d.updated_at;}}
   if(f==="dexter.sqlite"&&table==="actions")for(const r of expected){if(["ready","awaiting_approval"].includes(String(r.state)) && before[f]!.devices!.some(d=>d.id===r.destination && d.revoked_at===null)){const d=dst.find(d=>d.id===r.id)!;assert.equal(d.state,"blocked");assert.equal(d.reason,"permission_changed");r.state="blocked";r.reason="permission_changed";r.updated_at=d.updated_at;}}
   if(f==="dexter.sqlite"&&table==="events"){
    const extras=dst.filter(r=>!sorted(src).includes(JSON.stringify(r)));const activeDevices=before[f]!.devices!.filter(d=>d.revoked_at===null).map(d=>d.id);const blockedActions=before[f]!.actions!.filter(a=>["ready","awaiting_approval"].includes(String(a.state)) && activeDevices.includes(a.destination));assert.equal(extras.length,activeDevices.length+blockedActions.length);assert.deepEqual(extras.filter(e=>e.kind==="device.revoked").map(e=>e.entity_id).sort(),[...activeDevices].sort());assert.deepEqual(extras.filter(e=>e.kind==="action.blocked").map(e=>e.entity_id).sort(),blockedActions.map(a=>a.id).sort());expected.push(...extras);
   }
   if(["devices.sqlite","app-clients.sqlite"].includes(f)&&table==="offers")for(const r of expected){if(r.status==="open"){const d=dst.find(d=>d.id===r.id)!;assert.equal(d.status,"cancelled");r.status="cancelled";r.updated_at=d.updated_at;}}
   if(["devices.sqlite","app-clients.sqlite"].includes(f)&&table==="claims")for(const r of expected){if(r.status==="pending"||r.status==="approving"){const d=dst.find(d=>d.id===r.id)!;const status=r.status==="pending"?"rejected":"failed";assert.equal(d.status,status);r.status=status;r.decided_at=d.decided_at;}}
   assert.deepEqual(sorted(dst),sorted(expected),`${f}:${table} exact with closed effects`);
  }
 }
 const actualTree=tree(join(dest,"context-revisions"));
 const covered=(name:string)=>!name.startsWith(".git/") || name===".git/HEAD" || name===".git/refs/heads/master" || /^\.git\/objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/.test(name);
 assert.deepEqual(Object.fromEntries(Object.entries(actualTree).filter(([n])=>covered(n))),Object.fromEntries(Object.entries(repo).filter(([n])=>covered(n))));
 assert.ok(Object.keys(repo).some(n=>/^\.git\/objects\//.test(n)));
 assert.deepEqual(Object.keys(actualTree).filter(n=>!covered(n)),[".git/config"]);
 assert.equal(Buffer.from(actualTree[".git/config"]!,"base64").toString(),"[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n");
 const hostTLS=memoryTLS(),clientTLS=memoryTLS(),deviceDir=join(p,"device");mkdirSync(deviceDir,{mode:0o700});
 const destination=new HostServices({dataDir:dest,enableEngines:true,enableMcp:true,enableDeviceTools:true,devices:{identity:hostTLS,port:0,pollWaitMs:50,receiptTimeoutMs:1000},makeDriver:()=>{engineFactoryCalls++;throw Error("inference forbidden in this lab");}});t.after(()=>destination.shutdown());
 const old=destination.store.getDevice(surface.deviceId);assert.ok(old.revokedAt!==null);assert.equal(destination.store.getTurn(seeded.queuedTurnId).state,"queued");assert.equal(destination.store.getAction(surface.unknownActionId).state,"unknown");
 assert.ok(destination.store.getGrant(seeded.botId,SURFACE_TOOL,surface.deviceId));
 const hostUrl=await destination.startDevices();const bundle=destination.devicesAdmin.pairingBundle({kind:"pair"});const trust={hostUrl,hostCertPem:hostTLS.certPem,hostFingerprint:hostTLS.fingerprint};
 const pairing=pairDevice({dataDir:deviceDir,trust,identity:clientTLS,offerId:bundle.offerId,code:bundle.code,name:"Fresh synthetic Mac",capabilities:[SURFACE_TOOL],pollIntervalMs:10,timeoutMs:2000});
 await waitFor(()=>destination.devicesAdmin.pendingClaims().length===1);destination.devicesAdmin.approveClaim(destination.devicesAdmin.pendingClaims()[0]!.claimId);const binding=await pairing;
 assert.notEqual(binding.deviceId,surface.deviceId);assert.equal(destination.store.getGrant(seeded.botId,SURFACE_TOOL,binding.deviceId),null);
 const route=destination.deviceRoutesAdmin.bindRoute({botId:seeded.botId,deviceId:binding.deviceId,tool:SURFACE_TOOL});assert.ok(route.id);assert.equal(route.needsFreshGrant,true);
 let executions=0;const daemon=new MacDeviceDaemon({dataDir:deviceDir,trust,identity:clientTLS,handlers:new Map([[SURFACE_TOOL,async()=>{executions++;return {written:true};}]]),pollTimeoutMs:1000,requestTimeoutMs:1000});t.after(()=>daemon.stop());await daemon.runOnce();
 assert.throws(()=>destination.store.requestAction({botId:seeded.botId,threadId:seeded.threadId,tool:SURFACE_TOOL,destination:binding.deviceId,arguments:{name:"before.txt",line:"synthetic"},idempotencyKey:"before-explicit-grant"}),e=>!!e&&typeof e==="object"&&"code"in e&&e.code==="forbidden");assert.equal(executions,0);
 destination.devicesAdmin.grant({botId:seeded.botId,tool:SURFACE_TOOL,destination:binding.deviceId,policy:"allow"});
 const action=destination.store.requestAction({botId:seeded.botId,threadId:seeded.threadId,tool:SURFACE_TOOL,destination:binding.deviceId,arguments:{name:"new.txt",line:"synthetic"},idempotencyKey:"fresh-dispatch"});
 const dispatch=destination.peersHttp!.dispatch(action.id);await daemon.runOnce();await daemon.runOnce();assert.equal((await dispatch).state,"succeeded");assert.equal(executions,1);assert.equal(destination.store.getAction(surface.unknownActionId).state,"unknown");
 const oldClient=new DeviceClient(oldDeviceTLS,trust);assert.ok(destination.store.getDevice(oldBinding.deviceId).revokedAt);const oldPin=tables(join(dest,"devices.sqlite")).device_certs!.find(r=>r.fp===oldDeviceTLS.fingerprint);assert.ok(oldPin);assert.equal(oldPin.device_id,oldBinding.deviceId);assert.equal(oldPin.state,"active"); /* Pin retained; HostStore device revocation denies authentication. */await assert.rejects(oldClient.post("device/poll",{deviceId:oldBinding.deviceId,installationId:destination.store.hostId,receipts:[]},1000),e=>e instanceof DeviceError && e.code==="forbidden");await oldClient.close();assert.equal(engineFactoryCalls,0);
});

test("reservation/replay/cancel and wrong or absent custody refuse without maintenance or duplicate effects",async t=>{
 const p=lab(t),host=new HostServices({dataDir:join(p,"host")});t.after(()=>host.shutdown());const c=newCustody(),wrong=newCustody();
 const coord=AuthorityCoordinator.open(join(p,"coord"),{ownerId:host.store.ownerId,ownerPublicKey:c.owner.publicKey});t.after(()=>coord.close());
 const {OwnerAuthorityMaintenance}=await import("../packages/cli/src/owner-authority-maintenance.js");
 const request={requestId:"r1",artifactPath:join(p,"checkpoint"),destinationPath:join(p,"dest")};
 for(const custody of [undefined,{snapshotKey:()=>null,ownerSigner:()=>c.owner},wrong.provider]) {
  const handler=new OwnerAuthorityMaintenance(host,{coordinator:coord,...(custody?{custody}:{})});assert.throws(()=>handler.reserve(request),e=>!!e&&typeof e==="object"&&"code"in e&&e.code==="authority_unavailable");
 }
 const handler=new OwnerAuthorityMaintenance(host,{coordinator:coord,custody:c.provider});const reserved=handler.reserve(request);
 assert.throws(()=>handler.reserve({...request,requestId:"r2"}),e=>!!e&&typeof e==="object"&&"code"in e&&e.code==="busy");reserved.cancel();assert.throws(()=>handler.reserve(request));
 const next=handler.reserve({...request,requestId:"r3"});next.cancel();assert.equal(host.store.authorityStatus().state,"active");assert.equal(existsSync(request.artifactPath),false);assert.deepEqual(coord.status().checkpoints,{});
});

test("pre/post durable revoke failures remain explicitly quarantined and never auto-abort or reactivate",async t=>{
 for(const phase of ["capture","receipt"] as const){
  const p=lab(t),data=join(p,"host"),artifact=join(p,"checkpoint"),socket=join(p,"owner.sock"),c=newCustody();let uses=0,signs=0;
  const init=new HostServices({dataDir:data});const coord=AuthorityCoordinator.open(join(p,"coord"),{ownerId:init.store.ownerId,ownerPublicKey:c.owner.publicKey});await init.shutdown();
  const custody={snapshotKey:()=>({keyId:c.key.keyId,use:((work:Parameters<typeof c.key.use>[0])=>{uses++;if(phase==="capture"&&uses>1)throw Error("synthetic refusal");return c.key.use(work);}) as typeof c.key.use}),ownerSigner:()=>({publicKey:c.owner.publicKey,sign:(b:Buffer)=>{signs++;if(phase==="receipt"&&signs>1)throw Error("synthetic refusal");return c.owner.sign(b);}})};
  const host=new HostServices({dataDir:data,ownerControl:{socketPath:socket},authorityMaintenance:{coordinator:coord,custody}});t.after(()=>coord.close());t.after(()=>host.shutdown());await host.startOwnerControl();
  const out=await cli(socket,artifact,join(p,"dest"),phase).done;assert.equal(out.code,4);assert.equal(out.output.status,phase==="capture"?"failed_before_revoke":"revoked_cleanup_incomplete");
  assert.equal(readSourceAuthority(data).state,phase==="capture"?"checkpointed":"revoked");assert.throws(()=>new HostStore({dataDir:data}));assert.equal(coord.status().openCheckpoints.length,1);
 }
});

test("drain deadline records incomplete while actual admitted connection and writer remain held; no automatic cleanup retry",async t=>{
 const p=lab(t),data=join(p,"host"),artifact=join(p,"checkpoint"),socket=join(p,"owner.sock"),c=newCustody();
 const init=new HostServices({dataDir:data});const coord=AuthorityCoordinator.open(join(p,"coord"),{ownerId:init.store.ownerId,ownerPublicKey:c.owner.publicKey});await init.shutdown();t.after(()=>coord.close());
 const host=new HostServices({dataDir:data,ownerControl:{socketPath:socket},authorityMaintenance:{coordinator:coord,custody:c.provider,graceMs:100}});await host.startOwnerControl();
 const held=createConnection(socket);await new Promise<void>(r=>held.once("connect",()=>r()));t.after(async()=>{held.destroy();await host.shutdown();});
 const out=await cli(socket,artifact,join(p,"dest"),"drain-deadline").done;assert.equal(out.code,4);assert.equal(out.output.status,"drain_incomplete");
 assert.equal(readSourceAuthority(data).state,"active");assert.throws(()=>new HostStore({dataDir:data}));assert.equal(existsSync(artifact),false);assert.deepEqual(coord.status().checkpoints,{});
 assert.equal((await ownerControlRequest(socket,{op:"authority.transfer",args:{requestId:"retry",artifactPath:artifact,destinationPath:join(p,"dest")}})).kind,"not_sent");
 held.destroy();await host.shutdown();assert.equal(readSourceAuthority(data).state,"active");
});

test("real owner socket reserves once, refuses concurrent job before ACK connection exits, then starts once",async t=>{
 const p=lab(t),data=join(p,"host"),artifact=join(p,"checkpoint"),socket=join(p,"owner.sock"),dest=join(p,"dest"),c=newCustody();
 const init=new HostServices({dataDir:data});const coord=AuthorityCoordinator.open(join(p,"coord"),{ownerId:init.store.ownerId,ownerPublicKey:c.owner.publicKey});await init.shutdown();t.after(()=>coord.close());
 const host=new HostServices({dataDir:data,ownerControl:{socketPath:socket},authorityMaintenance:{coordinator:coord,custody:c.provider}});t.after(()=>host.shutdown());await host.startOwnerControl();
 let quiesces=0;const quiesce=host.quiesceForMaintenance.bind(host);host.quiesceForMaintenance=o=>{quiesces++;return quiesce(o);};
 const first=createConnection({path:socket,allowHalfOpen:true});first.on("error",()=>{});t.after(()=>first.destroy());await new Promise<void>(r=>first.once("connect",()=>r()));
 first.write(encodeFrame({protocol:OWNER_CONTROL_PROTOCOL,op:"authority.transfer",args:{requestId:"one",artifactPath:artifact,destinationPath:dest}}));
 const ack=JSON.parse((await readFrame(first)).toString());assert.equal(ack.ok,true);assert.equal(quiesces,0);
 const concurrent=await ownerControlRequest(socket,{op:"authority.transfer",args:{requestId:"two",artifactPath:join(p,"second"),destinationPath:dest}});
 assert.equal(concurrent.kind,"response");if(concurrent.kind==="response"){assert.equal(concurrent.response.ok,false);if(!concurrent.response.ok)assert.deepEqual(concurrent.response.error,{code:"busy",effect:"none"});}
 assert.equal(quiesces,0);first.destroy();await waitFor(()=>existsSync(maintenanceResultPath(artifact)));assert.equal(quiesces,1);assert.equal(JSON.parse(readFileSync(maintenanceResultPath(artifact),"utf8")).status,"source_revoked");assert.equal(existsSync(join(p,"second")),false);
});

test("lost real host ACK through private local proxy is unknown to separate CLI with one admitted job and no retry",async t=>{
 const p=lab(t),data=join(p,"host"),artifact=join(p,"checkpoint"),socket=join(p,"owner.sock"),dest=join(p,"dest"),proxyPath=join(p,"proxy.sock"),c=newCustody();
 const init=new HostServices({dataDir:data});const coord=AuthorityCoordinator.open(join(p,"coord"),{ownerId:init.store.ownerId,ownerPublicKey:c.owner.publicKey});await init.shutdown();t.after(()=>coord.close());
 const host=new HostServices({dataDir:data,ownerControl:{socketPath:socket},authorityMaintenance:{coordinator:coord,custody:c.provider}});t.after(()=>host.shutdown());await host.startOwnerControl();let quiesces=0;const real=host.quiesceForMaintenance.bind(host);host.quiesceForMaintenance=o=>{quiesces++;return real(o);};
 let forwards=0;const proxy=createServer(front=>{front.on("error",()=>{});void(async()=>{const body=await readFrame(front);forwards++;const backend=createConnection(socket);backend.on("error",()=>{});try{await new Promise<void>(r=>backend.once("connect",()=>r()));const prefix=Buffer.alloc(4);prefix.writeUInt32BE(body.length);backend.write(Buffer.concat([prefix,body]));const ack=JSON.parse((await readFrame(backend)).toString());assert.equal(ack.ok,true);}finally{front.destroy();backend.destroy();}})().catch(()=>front.destroy());});
 await new Promise<void>(r=>proxy.listen(proxyPath,r));chmodSync(proxyPath,0o600);t.after(()=>new Promise<void>(r=>proxy.close(()=>r())));
 const out=await cli(proxyPath,artifact,dest,"lost-ack").done;assert.equal(out.code,3);assert.equal(out.output.status,"unknown");assert.equal(forwards,1);
 await waitFor(()=>existsSync(maintenanceResultPath(artifact)));assert.equal(quiesces,1);assert.equal(readSourceAuthority(data).state,"revoked");assert.equal(JSON.parse(readFileSync(maintenanceResultPath(artifact),"utf8")).status,"source_revoked");assert.deepEqual(coord.status().checkpoints,{revoked:1});
});


test("canonical source containment refuses artifact and destination before admission for symlink dataDir",async t=>{
 const p=lab(t),real=join(p,"real"),alias=join(p,"alias");mkdirSync(real,{mode:0o700});symlinkSync(real,alias,"dir");
 const source=join(real,"host"),data=join(alias,"host"),socket=join(p,"owner.sock"),custody=newCustody();
 const initial=new HostServices({dataDir:data});const coordinator=AuthorityCoordinator.open(join(p,"coord"),{ownerId:initial.store.ownerId,ownerPublicKey:custody.owner.publicKey});await initial.shutdown();
 const host=new HostServices({dataDir:data,ownerControl:{socketPath:socket},authorityMaintenance:{coordinator,custody:custody.provider}});t.after(()=>coordinator.close());t.after(()=>host.shutdown());await host.startOwnerControl();
 let quiesces=0;const quiesce=host.quiesceForMaintenance.bind(host);host.quiesceForMaintenance=async o=>{quiesces++;return quiesce(o);};
 mkdirSync(join(source,"nested"),{mode:0o700});symlinkSync(join(source,"nested"),join(p,"internal"),"dir");
 const authority=host.store.authorityStatus(),lease=tables(join(source,"dexter.sqlite")).host_lease;
 const cases=[{artifact:join(source,"checkpoint"),dest:join(p,"dest1")},{artifact:join(source,"nested","checkpoint"),dest:join(p,"dest2")},{artifact:join(p,"checkpoint3"),dest:join(source,"destination")},{artifact:join(p,"checkpoint4"),dest:join(p,"internal","destination")},{artifact:join(p,"internal","checkpoint"),dest:join(p,"dest5")}];
 for(const [i,c] of cases.entries()){
  const out=await cli(socket,c.artifact,c.dest,"containment_"+i).done;assert.equal(out.code,2);assert.deepEqual(out.output.error,{code:"invalid_input",effect:"none"});
  assert.equal(quiesces,0);assert.deepEqual(host.store.authorityStatus(),authority);assert.deepEqual(tables(join(source,"dexter.sqlite")).host_lease,lease);
  assert.equal(existsSync(c.artifact),false);assert.equal(existsSync(maintenanceResultPath(c.artifact)),false);assert.equal(existsSync(c.dest),false);
  host.store.createBot({name:"admitted "+i,engine:"claude",profileId:"personal"});
  assert.throws(()=>new HostStore({dataDir:source}),e=>!!e&&typeof e==="object"&&"code"in e&&e.code==="host_locked");
 }
});

test("real /tmp alias source refuses internal destination and artifact while retaining writer",async t=>{
 const p=lab(t);assert.ok(p.startsWith("/private/tmp/"));const source=join(p,"host"),data=source.replace("/private/tmp/","/tmp/"),socket=join(p,"owner.sock"),custody=newCustody();
 const initial=new HostServices({dataDir:data});const coordinator=AuthorityCoordinator.open(join(p,"coord"),{ownerId:initial.store.ownerId,ownerPublicKey:custody.owner.publicKey});await initial.shutdown();
 const host=new HostServices({dataDir:data,ownerControl:{socketPath:socket},authorityMaintenance:{coordinator,custody:custody.provider}});t.after(()=>coordinator.close());t.after(()=>host.shutdown());await host.startOwnerControl();
 let quiesces=0;const quiesce=host.quiesceForMaintenance.bind(host);host.quiesceForMaintenance=async o=>{quiesces++;return quiesce(o);};const authority=host.store.authorityStatus(),lease=tables(join(source,"dexter.sqlite")).host_lease;
 for(const [i,c] of [{artifact:join(source,"checkpoint"),dest:join(p,"dest")},{artifact:join(p,"checkpoint"),dest:join(source,"dest")}].entries()){
  const out=await cli(socket,c.artifact,c.dest,"tmp_alias_"+i).done;assert.equal(out.code,2);assert.deepEqual(out.output.error,{code:"invalid_input",effect:"none"});assert.equal(quiesces,0);
  assert.deepEqual(host.store.authorityStatus(),authority);assert.deepEqual(tables(join(source,"dexter.sqlite")).host_lease,lease);assert.equal(existsSync(c.artifact),false);assert.equal(existsSync(maintenanceResultPath(c.artifact)),false);assert.equal(existsSync(c.dest),false);
  host.store.createBot({name:"still usable "+i,engine:"claude",profileId:"personal"});assert.throws(()=>new HostStore({dataDir:source}),e=>!!e&&typeof e==="object"&&"code"in e&&e.code==="host_locked");
 }
});

async function filesystemAliasContainment(t:TestContext,kind:"case"|"firmlink") {
 const p=lab(t),data=join(p,"host"),nested=join(data,"nested"),outside=join(p,"outside");mkdirSync(data,{mode:0o700});mkdirSync(nested,{mode:0o700});mkdirSync(outside,{mode:0o700});
 const alias=kind==="case"?join(p,"HOST"):"/System/Volumes/Data"+data;
 const externalAlias=kind==="case"?join(p,"OUTSIDE"):"/System/Volumes/Data"+outside;
 const sameDirectory=(a:string,b:string)=>{try{const x=statSync(a,{bigint:true}),y=statSync(b,{bigint:true});return x.isDirectory()&&y.isDirectory()&&x.dev===y.dev&&x.ino===y.ino;}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return false;throw e;}};
 if(!sameDirectory(alias,data)||!sameDirectory(externalAlias,outside)){t.diagnostic(JSON.stringify({aliasCapability:kind,available:false}));t.skip("filesystem does not expose this actual same-directory alias; no refusal pass claimed");return;}
 t.diagnostic(JSON.stringify({aliasCapability:kind,available:true,sameDevIno:true,realpathStringDistinct:realpathSync(alias)!==realpathSync(data)}));
 const seeded=seedInstallation(data),socket=join(p,"owner.sock"),custody=newCustody(),coordinator=AuthorityCoordinator.open(join(p,"coord"),{ownerId:seeded.ownerId,ownerPublicKey:custody.owner.publicKey});
 const host=new HostServices({dataDir:data,ownerControl:{socketPath:socket},authorityMaintenance:{coordinator,custody:custody.provider}});t.after(()=>coordinator.close());t.after(()=>host.shutdown());await host.startOwnerControl();
 let quiesces=0;const quiesce=host.quiesceForMaintenance.bind(host);host.quiesceForMaintenance=async o=>{quiesces++;return quiesce(o);};
 const authority=host.store.authorityStatus(),lease=tables(join(data,"dexter.sqlite")).host_lease,coordinatorBefore=coordinator.status();
 const cases=[{artifact:join(alias,"checkpoint"),dest:join(outside,"dest1")},{artifact:join(alias,"nested","checkpoint"),dest:join(outside,"dest2")},{artifact:join(outside,"checkpoint3"),dest:join(alias,"dest")},{artifact:join(outside,"checkpoint4"),dest:join(alias,"nested","dest")}];
 for(const [i,c] of cases.entries()){
  const durableBefore=Object.fromEntries(files.filter(f=>existsSync(join(data,f))).map(f=>[f,tables(join(data,f))]));
  const out=await cli(socket,c.artifact,c.dest,kind+"_identity_"+i).done;assert.equal(out.code,2);assert.deepEqual(out.output.error,{code:"invalid_input",effect:"none"});assert.equal(quiesces,0);
  assert.deepEqual(host.store.authorityStatus(),authority);assert.deepEqual(tables(join(data,"dexter.sqlite")).host_lease,lease);assert.deepEqual(coordinator.status(),coordinatorBefore);
  assert.deepEqual(Object.fromEntries(Object.keys(durableBefore).map(f=>[f,tables(join(data,f))])),durableBefore,"all durable metadata and populated queues unchanged by refusal");
  assert.equal(existsSync(c.artifact),false);assert.equal(existsSync(maintenanceResultPath(c.artifact)),false);assert.equal(existsSync(c.dest),false);
  host.store.createBot({name:kind+" remains admitted "+i,engine:"claude",profileId:"personal"});assert.throws(()=>new HostStore({dataDir:data}),e=>!!e&&typeof e==="object"&&"code"in e&&e.code==="host_locked");
 }
 // An alias of an external directory is still valid: reserve/cancel alone never starts the host job.
 const {OwnerAuthorityMaintenance}=await import("../packages/cli/src/owner-authority-maintenance.js");const maintenance=new OwnerAuthorityMaintenance(host,{coordinator,custody:custody.provider});
 const accepted=maintenance.reserve({requestId:kind+"_outside",artifactPath:join(externalAlias,"checkpoint"),destinationPath:join(externalAlias,"dest")});assert.equal(accepted.result.status,"accepted");accepted.cancel();
 assert.equal(quiesces,0);assert.deepEqual(host.store.authorityStatus(),authority);assert.deepEqual(tables(join(data,"dexter.sqlite")).host_lease,lease);assert.deepEqual(coordinator.status(),coordinatorBefore);assert.equal(existsSync(join(outside,"checkpoint")),false);assert.equal(existsSync(join(outside,"dest")),false);
}
test("filesystem identity containment refuses actual case aliases and descendants before admission",async t=>filesystemAliasContainment(t,"case"));
test("filesystem identity containment refuses actual macOS firmlink aliases and descendants before admission",async t=>filesystemAliasContainment(t,"firmlink"));
