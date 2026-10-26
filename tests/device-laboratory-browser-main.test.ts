import assert from "node:assert/strict";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { DeviceError } from "../packages/devices/src/errors.js";
import { certificateFingerprint } from "../packages/devices/src/wire.js";
import { readDaemonConfig } from "../packages/devices/src/daemon-config.js";
import { main, type NativeClientHandle } from "../packages/devices/src/daemon-main.js";
import type { NativePublicIdentity } from "../packages/devices/src/native-client.js";
import type { LocalCapabilities } from "../packages/devices/src/capabilities/index.js";

// Only the public certificate is persisted. RSA material exists in memory and openssl stdin only.
// The injected native handle/lifecycle are synthetic; these tests do NOT claim Swift, TLS or custody.
function setup(t:TestContext) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"dexter-lab-browser-main-")));
  const {privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
  const r=spawnSync("/usr/bin/openssl",["req","-new","-x509","-key","/dev/stdin","-subj","/CN=127.0.0.1","-days","1"],{
    input:privateKey.export({type:"pkcs8",format:"pem"}),timeout:10000,
    env:{PATH:"/usr/bin:/bin",HOME:root,TMPDIR:root},encoding:"utf8"
  });
  assert.equal(r.status,0,"memory certificate generator failed");
  const cert=r.stdout;assert.ok(cert.startsWith("-----BEGIN CERTIFICATE-----"));
  const hostFingerprint=certificateFingerprint(cert),der=new X509Certificate(cert).raw.toString("base64");
  const dataDir=join(root,"data"),helperDir=join(root,"helper");mkdirSync(dataDir,{mode:0o700});mkdirSync(helperDir,{mode:0o700});
  const hostCertPath=join(root,"host-public-certificate.txt");writeFileSync(hostCertPath,cert,{mode:0o600});
  const executable=join(helperDir,"never-invoked");writeFileSync(executable,"#!/bin/sh\nexit 88\n",{mode:0o700});
  const nativePath=join(helperDir,"public-config.json"),path=join(root,"operator-config.json"),policyPath=join(root,"policy.json");
  const native={installationID:"host_fixture",hostURL:"https://127.0.0.1:19443",hostCertificateDER:der,hostFingerprint,laboratoryID:"a".repeat(32)};
  const saveNative=(v:unknown)=>writeFileSync(nativePath,JSON.stringify(v),{mode:0o600});saveNative(native);
  const config={mode:"laboratory-browser",version:2,dataDir,name:"Owned laboratory",capabilities:["mac.browser.navigate"],hostUrl:native.hostURL,
    hostCertPath,hostFingerprint,policyPath,browser:{executable:process.execPath,networkIsolation:"loopback_only"},cua:null,
    client:{kind:"native-helper",executable,configPath:nativePath,installationID:native.installationID,identityMode:"laboratory-native"}};
  const save=(v:unknown)=>{writeFileSync(path,JSON.stringify(v),{mode:0o600});return path;};save(config);
  const bind=()=>{writeFileSync(join(dataDir,"native-device.json"),JSON.stringify({fingerprint:hostFingerprint}),{mode:0o600});
    writeFileSync(join(dataDir,"binding.json"),JSON.stringify({installationId:"host_fixture",ownerId:"owner_fixture",deviceId:"dev_fixture",hostFingerprint}),{mode:0o600});};
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return{root,path,nativePath,hostCertPath,dataDir,helperDir,policyPath,native,config,hostFingerprint,der,save,saveNative,bind};
}
const refusal=(code:string)=>(e:unknown)=>e instanceof DeviceError&&e.code===code;
function gate(){let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return{promise,release};}
async function until(f:()=>boolean){const end=Date.now()+5000;while(!f()){assert.ok(Date.now()<end,"fixture deadline");await new Promise(r=>setTimeout(r,5));}}
function identity(s:ReturnType<typeof setup>):NativePublicIdentity{return{certificateDER:s.der,fingerprint:s.hostFingerprint,policy:"cli_forwarding_laboratory_memory_only"};}
function handle(s:ReturnType<typeof setup>,hooks:{load?:()=>void;close?:()=>Promise<void>;pin?:string}={}):NativeClientHandle{return{
  hostFingerprint:hooks.pin??s.hostFingerprint,loadOnly:async()=>{hooks.load?.();return identity(s);},
  post:async()=>{throw new Error("network must not be used in this synthetic parser/main unit");},
  close:hooks.close??(async()=>{})
};}

test("dedicated laboratory browser is explicit, loopback-only and never changes existing production refusal",t=>{
  const s=setup(t),c=readDaemonConfig(s.path);assert.equal(c.mode,"laboratory-browser");
  assert.equal(c.client.kind,"native-helper");assert.equal(c.browser?.networkIsolation,"loopback_only");assert.equal(c.cua,null);
  s.save({...s.config,mode:"local-capabilities"});assert.throws(()=>readDaemonConfig(s.path),refusal("forbidden"));
  for(const value of [
    {...s.config,mode:"local-capabilities"},
    {...s.config,version:1},
    {...s.config,client:{...s.config.client,identityMode:"production"}},
    {...s.config,client:{...s.config.client,identityMode:undefined}},
    {...s.config,browser:null},
    {...s.config,browser:{...s.config.browser,networkIsolation:"none"}},
    {...s.config,cua:{mode:"native",executable:process.execPath}},
    {...s.config,cua:{mode:"fixture",executable:process.execPath}},
    {...s.config,capabilities:["mac.file.append"]},
    {...s.config,capabilities:["mac.cua.status"]},
    {...s.config,capabilities:[]},
    {...s.config,allowLaboratory:true}
  ]){s.save(value);assert.throws(()=>readDaemonConfig(s.path),e=>e instanceof DeviceError);}
  s.save({...s.config,mode:"local-capabilities",client:{...s.config.client,identityMode:"production"}});
  assert.equal(readDaemonConfig(s.path).mode,"local-capabilities","control: normal production parser still accepted");
  assert.equal(existsSync(join(s.dataDir,"journal.sqlite")),false);
  assert.equal(existsSync(join(s.dataDir,"native-device.json")),false);
});

test("laboratory browser retains exact cross-binding, public helper pin and literal loopback trust",async t=>{
  const s=setup(t);let clients=0,loads=0;const events:Record<string,unknown>[]=[];
  const run=()=>main(["--config",s.path],{emit:e=>events.push(e),createNativeClient:()=>{clients++;return handle(s,{load:()=>{loads++;}});}});
  for(const native of [
    {...s.native,installationID:"host_other"},
    {...s.native,hostURL:"https://127.0.0.1:19444"},
    {...s.native,hostFingerprint:"b".repeat(64)},
    {...s.native,laboratoryID:undefined}
  ]){s.saveNative(native);assert.equal(await run(),1);}
  s.saveNative({...s.native,hostURL:"https://localhost:19443"});s.save({...s.config,hostUrl:"https://localhost:19443"});assert.equal(await run(),1);
  assert.equal(clients,0);assert.equal(loads,0);assert.equal(existsSync(join(s.dataDir,"native-device.json")),false);
  assert.ok(events.every(e=>e.event==="error"));
});

test("browser executable and private capability storage are guarded before native load or state",async t=>{
  const s=setup(t);let clients=0;
  const run=()=>main(["--config",s.path],{emit(){},readPairingLine:async()=>{assert.fail("invalid config must not reach pairing input");},createNativeClient:()=>{clients++;return handle(s);}});
  const forbidden=join(s.root,"writable-browser");writeFileSync(forbidden,"#!/bin/sh\nexit 0\n",{mode:0o722});
  chmodSync(forbidden,0o722); // Creation umask must not erase the intentionally forbidden bits.
  s.save({...s.config,browser:{...s.config.browser,executable:forbidden}});assert.equal(await run(),1);assert.equal(clients,0);
  s.save(s.config);const storage=join(s.dataDir,"capabilities/browser/state");mkdirSync(storage,{recursive:true,mode:0o700});
  for(const suffix of ["capabilities","capabilities/browser"])chmodSync(join(s.dataDir,suffix),0o700);
  chmodSync(storage,0o777);assert.equal(await run(),1);assert.equal(clients,0);
  assert.equal(existsSync(join(s.dataDir,"native-device.json")),false);assert.equal(existsSync(join(s.dataDir,"journal.sqlite")),false);
});

test("main rechecks helper digest and outer client pin after construction before any public load",async t=>{
  const s=setup(t);let loads=0,closes=0;
  assert.equal(await main(["--config",s.path],{emit(){},createNativeClient:()=>{s.saveNative({...s.native,laboratoryID:"b".repeat(32)});return handle(s,{load:()=>{loads++;},close:async()=>{closes++;}});}}),1);
  s.saveNative(s.native);
  assert.equal(await main(["--config",s.path],{emit(){},createNativeClient:()=>handle(s,{pin:"b".repeat(64),load:()=>{loads++;},close:async()=>{closes++;}})}),1);
  assert.equal(loads,0);assert.equal(closes,2);assert.equal(existsSync(join(s.dataDir,"native-device.json")),false);
});

test("shared main emits laboratory identity and retains resource ownership until actual held close",async t=>{
  const s=setup(t);s.bind();const controller=new AbortController(),held=gate();let closing=false,finished=false,loads=0,capsCreated=0,clientCloses=0;
  const events:Record<string,unknown>[]=[];const client=handle(s,{load:()=>{loads++;},close:async()=>{clientCloses++;}});
  const caps:LocalCapabilities={handlers:new Map(),browser:null,cua:null,close:async()=>{closing=true;await held.promise;}};
  let stop:Promise<void>|undefined;
  const run=main(["--config",s.path],{signal:controller.signal,emit:e=>{events.push(e);if(e.event==="ready")controller.abort();},
    loadIdentity(){assert.fail("PEM fallback must never occur");},
    createNativeClient:o=>{assert.equal(o.identityMode,"laboratory-native");return client;},
    createCapabilities:c=>{assert.equal(c.mode,"laboratory-browser");capsCreated++;return caps;},
    createDaemon:()=>({binding:{installationId:"host_fixture",ownerId:"owner_fixture",deviceId:"dev_fixture",hostFingerprint:s.hostFingerprint},
      start(){},stop(){return stop??=(async()=>{await Promise.all([client.close(),caps.close()]);})();}})
  });
  t.after(async()=>{held.release();controller.abort();await run;});void run.then(()=>{finished=true;});
  await until(()=>closing);assert.equal(finished,false);assert.equal(loads,1);assert.equal(capsCreated,1);assert.equal(clientCloses,1);
  assert.deepEqual(events.find(e=>e.event==="ready"),{event:"ready",deviceId:"dev_fixture",executionMode:"laboratory-browser",identityMode:"laboratory-native"});
  held.release();assert.equal(await run,0);assert.equal(finished,true);
  assert.ok(!readFileSync(s.nativePath,"utf8").includes("PRIVATE KEY"));
});
