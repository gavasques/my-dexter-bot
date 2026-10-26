// LAB ONLY: real Node adapter -> fixture Swift storage -> production PreparedDeviceRequest/transport -> real DeviceHostServer.
// No Keychain calls. Synthetic P256 credentials arrive only on inherited FD3; FD4 is non-secret control.
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { TLSSocket } from "node:tls";
import { HostStore } from "@dexter/hub";
import { DeviceHostServer } from "../packages/devices/src/host-server.js";
import { DevicePairingRegistry } from "../packages/devices/src/registry.js";
import { NativeDeviceClient } from "../packages/devices/src/native-client.js";
import { MacDeviceDaemon, pairDevice, readBinding } from "../packages/devices/src/daemon.js";
import { DeviceError } from "../packages/devices/src/errors.js";
import { type TlsIdentity } from "../packages/devices/src/files.js";
import { createLabTlsIdentity } from "../packages/devices/src/lab-pki.js";
import { installNativeMemoryTransport } from "./fixtures/native-swift-memory-pipe.mjs";
import { FILE_APPEND } from "../packages/devices/src/operations.js";
import { createFixtureHandlers } from "../packages/devices/src/handlers.js";
const code = (c:string) => (e:unknown) => e instanceof DeviceError && e.code === c;
async function until(check:()=>boolean,ms=20000) { const end=Date.now()+ms; while(!check()) { assert.ok(Date.now()<end,"owned fixture barrier"); await new Promise(r=>setTimeout(r,10)); } }
function identity(root:string,name:string,san="IP:127.0.0.1",client=false):TlsIdentity {
  const dir=join(root,name);mkdirSync(dir,{mode:0o700});
  const value=createLabTlsIdentity({profile:client?"client":"host",name:"synthetic-"+name,san:[san]}).identity;
  writeFileSync(join(dir,"cert.pem"),value.certPem,{mode:0o600});return value;
}
async function lab(t:TestContext,san="IP:127.0.0.1",pollWaitMs=100) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"dexter-native-swift-chain-")));chmodSync(root,0o700);
  const host=identity(root,"host",san),peer=identity(root,"peer","DNS:synthetic-client",true),other=identity(root,"other","DNS:synthetic-other",true);
  const executable=join(root,"native-client-laboratory");
  assert.ok(process.env.DEXTER_SWIFT_LAB_EXECUTABLE,"explicit fixture executable required; no production fallback");copyFileSync(process.env.DEXTER_SWIFT_LAB_EXECUTABLE,executable);chmodSync(executable,0o700);
  const transport=installNativeMemoryTransport(executable);let setupComplete=false;t.after(()=>{if(!setupComplete)transport.restore();});
  const material=(config:string,id:TlsIdentity)=>transport.register(config,id,"dexter-native-client-laboratory-v1");
  const pipeSource=join(process.env.DEXTER_SWIFT_LAB_EXECUTABLE,"..","native-client-laboratory-pipe.py");copyFileSync(pipeSource,join(root,"native-client-laboratory-pipe.py"));chmodSync(join(root,"native-client-laboratory-pipe.py"),0o600);
  const store=new HostStore({dataDir:join(root,"host-store")}),registry=new DevicePairingRegistry(store);
  let tcp=0,http=0;const sessions:Array<{socket:TLSSocket;closed:boolean;protocol:string|null;resumed:boolean;fingerprint:string}>=[];
  let captured:ReturnType<typeof https.createServer>|null=null;
  const original=https.createServer;
  https.createServer=((...args:Parameters<typeof https.createServer>)=>{
    const server=original(...args);captured=server;server.on("connection",()=>tcp++);server.on("request",()=>http++);
    server.on("secureConnection",(socket:TLSSocket)=>{ const record={socket,closed:false,protocol:socket.getProtocol(),resumed:socket.isSessionReused(),fingerprint:new X509Certificate(socket.getPeerCertificate().raw).fingerprint256.replaceAll(":","").toLowerCase()};sessions.push(record);socket.once("close",()=>record.closed=true); });return server;
  }) as typeof https.createServer;syncBuiltinESMExports();
  let server:DeviceHostServer;
  try {server=new DeviceHostServer({store,registry,identity:host,pollWaitMs,receiptTimeoutMs:20000});}finally{https.createServer=original;syncBuiltinESMExports();}
  const hostURL=await server.start(),trust={hostUrl:hostURL,hostCertPem:host.certPem,hostFingerprint:host.fingerprint};
  const clients:NativeDeviceClient[]=[],daemons:MacDeviceDaemon[]=[];
  const client=(pin:TlsIdentity=host)=>{
    const config=join(root,`config-${clients.length}.json`);writeFileSync(config,JSON.stringify({installationID:store.hostId,laboratoryID:"0123456789abcdef0123456789abcdef",hostURL,hostCertificateDER:new X509Certificate(pin.certPem).raw.toString("base64"),hostFingerprint:pin.fingerprint}),{mode:0o600});material(config,peer);
    const value=new NativeDeviceClient({executable,configPath:config,installationID:store.hostId,identityMode:"laboratory-native"});clients.push(value);return {value,config};
  };
  t.after(async()=>{for(const d of daemons.reverse())await d.stop();for(const c of clients)await c.close();await server.close();registry.close();store.close();transport.restore();rmSync(root,{recursive:true,force:true});});
  setupComplete=true;return {root,host,peer,other,material,transport,store,registry,server,trust,client,daemons,sessions,counters:()=>({tcp,http}),nativeServer:()=>{assert.ok(captured);return captured;}};
}
async function pair(l:Awaited<ReturnType<typeof lab>>,client:NativeDeviceClient,dir:string) {
  const offer=l.server.pairingBundle({kind:"pair"});const promise=pairDevice({dataDir:dir,client,trust:l.trust,offerId:offer.offerId,code:offer.code,name:"Swift Laboratory",capabilities:[FILE_APPEND],timeoutMs:20000,pollIntervalMs:50});
  await until(()=>l.registry.listPendingClaims().length===1);const claim=l.registry.listPendingClaims()[0]!;assert.equal(claim.clientFingerprint,l.peer.fingerprint);l.registry.approveClaim(claim.claimId);return promise;
}
test("actual Swift chain pairs, dispatches claimed append, receipts, restarts same identity without auto grants and refuses revoked",async t=>{
  const l=await lab(t),{value:c}=l.client();const publicIdentity=await c.loadOnly(20000);assert.equal(publicIdentity.fingerprint,l.peer.fingerprint);assert.equal(publicIdentity.policy,"cli_forwarding_laboratory_memory_only");
  const dir=join(l.root,"mac"),binding=await pair(l,c,dir);assert.deepEqual(readBinding(dir),binding);
  const fixtures=join(l.root,"effects");mkdirSync(fixtures,{mode:0o700});
  const d=new MacDeviceDaemon({dataDir:dir,client:c,trust:l.trust,pollTimeoutMs:20000,handlers:createFixtureHandlers({root:fixtures,enable:[FILE_APPEND]})});l.daemons.push(d);
  const bot=l.store.createBot({name:"Synthetic",profileId:"lab",engine:"claude"}),thread=l.store.createThread(bot.id);
  l.store.setGrant({botId:bot.id,tool:FILE_APPEND,destination:binding.deviceId,policy:"allow"});
  const action=l.store.requestAction({botId:bot.id,threadId:thread.id,tool:FILE_APPEND,destination:binding.deviceId,arguments:{name:"notes.txt",line:"real-swift"},idempotencyKey:"chain-1"});
  const [result]=await Promise.all([l.server.dispatch(action.id),d.runOnce()]);assert.equal(result.state,"succeeded");assert.equal(readFileSync(join(fixtures,"notes.txt"),"utf8"),"real-swift\n");assert.equal(d.journal.entry(action.id)?.acked,true);await d.stop();
  const {value:restart}=l.client();assert.equal((await restart.loadOnly(20000)).fingerprint,publicIdentity.fingerprint);
  assert.deepEqual(readBinding(dir),binding);const restartedDaemon=new MacDeviceDaemon({dataDir:dir,client:restart,trust:l.trust,pollTimeoutMs:20000,handlers:createFixtureHandlers({root:fixtures,enable:[FILE_APPEND]})});l.daemons.push(restartedDaemon);await restartedDaemon.runOnce();
  const newBot=l.store.createBot({name:"Untrusted",profileId:"lab",engine:"claude"}),newThread=l.store.createThread(newBot.id);assert.throws(()=>l.store.requestAction({botId:newBot.id,threadId:newThread.id,tool:FILE_APPEND,destination:binding.deviceId,arguments:{name:"notes.txt",line:"denied"},idempotencyKey:"chain-no-grant"}),e=>typeof e==="object"&&e!==null&&"code" in e&&e.code==="forbidden");assert.equal(readFileSync(join(fixtures,"notes.txt"),"utf8"),"real-swift\n");
  await assert.rejects(restart.post("pair/status",{claimId:"claim_missing"},20000),code("not_found"));
  l.server.revokeDevice(binding.deviceId);await assert.rejects(restart.post("device/poll",{deviceId:binding.deviceId,installationId:l.store.hostId,receipts:[]},20000),code("forbidden"));
  assert.ok(l.sessions.length>=5);assert.ok(l.sessions.every(s=>s.protocol==="TLSv1.3"&&!s.resumed&&s.fingerprint===l.peer.fingerprint));
});
test("identity swap after actual Swift load refuses before any TCP or TLS admission",async t=>{
  const l=await lab(t),{value:c,config}=l.client();await c.loadOnly(20000);const before=l.counters();l.material(config,l.other);
  await assert.rejects(c.post("device/poll",{deviceId:"dev_missing",installationId:l.store.hostId,receipts:[]},20000),code("conflict"));assert.deepEqual(l.counters(),before,"changed identity must refuse before transport creation");await c.close();assert.equal(c.pending,0);
});
test("actual Swift wrong host pin refuses before HTTP",async t=>{
  const l=await lab(t),{value:c}=l.client(l.other);await c.loadOnly(20000);
  await assert.rejects(c.post("device/poll",{deviceId:"dev_missing",installationId:l.store.hostId,receipts:[]},20000),code("tls_pin_mismatch"));assert.equal(l.counters().http,0);
});
test("actual Swift invalid server SAN refuses before HTTP",async t=>{
  const l=await lab(t,"DNS:wrong.example"),{value:c}=l.client();await c.loadOnly(20000);
  await assert.rejects(c.post("device/poll",{deviceId:"dev_missing",installationId:l.store.hostId,receipts:[]},20000),code("tls_pin_mismatch"));assert.equal(l.counters().http,0);
});
test("actual Swift late host response cannot publish after close and drain reaches helper exit",async t=>{
  const l=await lab(t),{value:c}=l.client();await c.loadOnly(20000);const binding=await pair(l,c,join(l.root,"mac"));
  let held=false,release:(()=>void)|null=null;
  l.nativeServer().prependListener("request",(req,res)=>{if(req.url!=="/v1/device/poll")return;const end=res.end;res.end=((...args:Parameters<typeof res.end>)=>{held=true;release=()=>{end.apply(res,args);};return res;}) as typeof res.end;});
  const response=c.post("device/poll",{deviceId:binding.deviceId,installationId:l.store.hostId,receipts:[]},20000).then(v=>v,e=>e);await until(()=>held);const closing=c.close();await assert.rejects(c.post("device/poll",{deviceId:binding.deviceId,installationId:l.store.hostId,receipts:[]},20000),code("unavailable"));assert.ok(release);(release as ()=>void)();
  const outcome:unknown=await response;assert.ok(outcome instanceof DeviceError);assert.equal(outcome.code,"outcome_unknown");await closing;assert.equal(c.pending,0);await until(()=>l.sessions.every(s=>s.closed));
});

test("actual Swift detached pipe keeps helper close pending until its finite descendant exits",async t=>{
  const l=await lab(t),{value:c,config}=l.client();await c.loadOnly(20000);
  const path=config+".pipe-control";l.transport.holdPipe(config,true);
  const reply=c.post("device/poll",{deviceId:"dev_missing",installationId:l.store.hostId,receipts:[]},20000).then(v=>v,e=>e);
  await until(()=>{try{return Number(readFileSync(path+".pid","utf8"))>0;}catch{return false;}});const pid=Number(readFileSync(path+".pid","utf8"));
  const alive=()=>{try{process.kill(pid,0);return true;}catch{return false;}};assert.ok(alive());
  t.after(async()=>{if(alive())process.kill(pid,"SIGKILL");await until(()=>!alive());});
  let drained=false;const closing=c.close().then(()=>{drained=true;});await new Promise(r=>setTimeout(r,30));assert.equal(drained,false,"leader exit/kill is not descendant pipe drain");assert.ok(c.pending>0);
  const outcome:unknown=await reply;assert.ok(outcome instanceof DeviceError);assert.equal(outcome.code,"outcome_unknown");await closing;await until(()=>!alive());assert.equal(c.pending,0);
});
