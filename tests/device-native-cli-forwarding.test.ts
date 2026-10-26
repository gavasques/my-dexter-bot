// LAB ONLY: unchanged actual Swift CLI main imports a private module with test-only storage replacement.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { HostStore } from "@dexter/hub";
import { DeviceHostServer } from "../packages/devices/src/host-server.js";
import { DevicePairingRegistry } from "../packages/devices/src/registry.js";
import { type TlsIdentity } from "../packages/devices/src/files.js";
import { createLabTlsIdentity } from "../packages/devices/src/lab-pki.js";
import { installNativeMemoryTransport } from "./fixtures/native-swift-memory-pipe.mjs";
import { FILE_APPEND } from "../packages/devices/src/operations.js";
function identity(root:string,name:string,san="IP:127.0.0.1",client=false):TlsIdentity {
  const dir=join(root,name);mkdirSync(dir,{mode:0o700});
  const value=createLabTlsIdentity({profile:client?"client":"host",name:"synthetic-"+name,san:[san]}).identity;
  writeFileSync(join(dir,"cert.pem"),value.certPem,{mode:0o600});return value;
}
async function lab(t:TestContext) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"dexter-native-cli-forwarding-")));chmodSync(root,0o700);
  const host=identity(root,"host"),peer=identity(root,"peer","IP:127.0.0.1",true),other=identity(root,"other","IP:127.0.0.1",true);
  assert.ok(process.env.DEXTER_SWIFT_CLI_LAB_EXECUTABLE,"explicit laboratory executable required");
  const executable=join(root,"actual-cli");copyFileSync(process.env.DEXTER_SWIFT_CLI_LAB_EXECUTABLE,executable);chmodSync(executable,0o700);
  const transport=installNativeMemoryTransport(executable);let setupComplete=false;t.after(()=>{if(!setupComplete)transport.restore();});
  const store=new HostStore({dataDir:join(root,"host-store")}),registry=new DevicePairingRegistry(store);let tcp=0,http=0;
  const original=https.createServer;https.createServer=((...args:Parameters<typeof https.createServer>)=>{const server=original(...args);server.on("connection",()=>tcp++);server.on("request",()=>http++);return server;}) as typeof https.createServer;syncBuiltinESMExports();
  let server:DeviceHostServer;try{server=new DeviceHostServer({store,registry,identity:host,pollWaitMs:100});}finally{https.createServer=original;syncBuiltinESMExports();}
  const hostURL=await server.start(),config=join(root,"config.json");writeFileSync(config,JSON.stringify({installationID:store.hostId,laboratoryID:"0123456789abcdef0123456789abcdef",hostURL,hostCertificateDER:new X509Certificate(host.certPem).raw.toString("base64"),hostFingerprint:host.fingerprint}),{mode:0o600});
  const material=(id:TlsIdentity)=>transport.register(config,id);material(peer);
  const children=new Set<ReturnType<typeof spawn>>();
  t.after(async()=>{for(const child of children)child.kill("SIGKILL");await Promise.all([...children].map(child=>new Promise<void>(resolve=>child.once("close",()=>resolve()))));await server.close();registry.close();store.close();transport.restore();rmSync(root,{recursive:true,force:true});});
  const execute=(command:Record<string,unknown>)=>new Promise<{exit:number|null;value:Record<string,unknown>}>((resolve,reject)=>{
    const child=spawn(executable,["--config",config],{env:{},cwd:root,stdio:"pipe"});children.add(child);const chunks:Buffer[]=[];let stdout=0,stderr=0,failed=false;
    const fail=(e:Error)=>{if(failed)return;failed=true;child.kill("SIGKILL");reject(e);};const timer=setTimeout(()=>fail(new Error("bounded actual CLI fixture deadline")),20000);
    child.stdout.on("data",(b:Buffer)=>{stdout+=b.length;if(stdout>360000)fail(new Error("bounded stdout"));else chunks.push(b);});child.stderr.on("data",(b:Buffer)=>{stderr+=b.length;if(stderr>16384)fail(new Error("bounded stderr"));});child.on("error",fail);
    child.once("close",exit=>{clearTimeout(timer);children.delete(child);if(failed)return;try{const value:unknown=JSON.parse(Buffer.concat(chunks).toString("utf8"));assert.ok(value&&typeof value==="object"&&!Array.isArray(value));assert.equal(stderr,0,"actual CLI emits no diagnostics");resolve({exit,value:value as Record<string,unknown>});}catch(e){reject(e);}});child.stdin.on("error",()=>undefined);child.stdin.end(JSON.stringify(command));
  });
  const counts=()=>existsSync(config+".memory-fixture.counts")?readFileSync(config+".memory-fixture.counts","utf8").trim().split("\n"):[];
  const command=(expected:unknown=peer.fingerprint)=>{const offer=server.pairingBundle({kind:"pair"});return {operation:"request",route:"/v1/pair/claim",bodyBase64:Buffer.from(JSON.stringify({offerId:offer.offerId,code:offer.code,name:"Actual CLI Laboratory",platform:"macos",capabilities:[FILE_APPEND]})).toString("base64"),timeoutSeconds:10,expectedClientFingerprint:expected};};
  setupComplete=true;return {peer,other,material,execute,counts,command,registry,counters:()=>({tcp,http})};
}
test("unchanged actual Main forwards valid expected fingerprint into real production request and TLS",async t=>{
  const l=await lab(t),out=await l.execute(l.command());assert.equal(out.exit,0,"valid CLI request must not fail closed from dropped forwarding");assert.equal(out.value.ok,true);assert.equal(typeof out.value.responseBase64,"string");
  const response=JSON.parse(Buffer.from(out.value.responseBase64 as string,"base64").toString("utf8")) as Record<string,unknown>;assert.equal(response.status,"pending");assert.equal(typeof response.claimId,"string");assert.deepEqual(l.counts(),["load"]);assert.deepEqual(l.counters(),{tcp:1,http:1});assert.equal(l.registry.listPendingClaims()[0]?.clientFingerprint,l.peer.fingerprint);
});
test("unchanged actual Main missing and malformed expected fingerprint refuses before storage and TCP",async t=>{
  const l=await lab(t);const absent=l.command();delete (absent as Partial<typeof absent>).expectedClientFingerprint;
  for(const command of [absent,...[null,42,"a".repeat(63),"A".repeat(64),"g".repeat(64)].map(v=>l.command(v))]){
    const out=await l.execute(command);assert.equal(out.exit,1);assert.deepEqual(out.value,{ok:false,error:"invalidInput"});assert.deepEqual(l.counts(),[],"canonical expected fingerprint validation precedes storage");assert.deepEqual(l.counters(),{tcp:0,http:0});
  }
});
test("unchanged actual Main passes expected binding and rejects swapped identity before TCP",async t=>{
  const l=await lab(t);l.material(l.other);const out=await l.execute(l.command(l.peer.fingerprint));assert.equal(out.exit,1);assert.deepEqual(out.value,{ok:false,error:"conflict"});assert.deepEqual(l.counts(),["load"]);assert.deepEqual(l.counters(),{tcp:0,http:0});assert.equal(l.registry.listPendingClaims().length,0);
});
test("unchanged actual Main load retains public certificate response and never provisions",async t=>{
  const l=await lab(t),out=await l.execute({operation:"load"});assert.equal(out.exit,0);assert.equal(out.value.ok,true);assert.equal(out.value.fingerprint,l.peer.fingerprint);assert.equal(out.value.policy,"cli_forwarding_laboratory_memory_only");assert.equal(new X509Certificate(Buffer.from(out.value.certificateDER as string,"base64")).fingerprint256.replaceAll(":","").toLowerCase(),l.peer.fingerprint);assert.deepEqual(l.counts(),["load"]);assert.deepEqual(l.counters(),{tcp:0,http:0});
});
