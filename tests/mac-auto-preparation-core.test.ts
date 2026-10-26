import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CuaCapability, LocalCapabilityPolicy, generateSyntheticIdentity, DeviceError, HandlerRefusal, type CuaTransport } from "../packages/devices/src/index.js";
import { parseDaemonArguments } from "../packages/devices/src/daemon-config.js";
import { main, type NativeClientHandle } from "../packages/devices/src/daemon-main.js";
function fixture(t:TestContext){
 const root=realpathSync(mkdtempSync(join(tmpdir(),"dexter-auto-preparation-"))),host=generateSyntheticIdentity(join(root,"host"),"host"),device=generateSyntheticIdentity(join(root,"device"),"device");
 const dataDir=join(root,"data"),executable=join(root,"synthetic-never-executed"),nativePath=join(root,"identity-helper.json"),path=join(root,"config.json");mkdirSync(dataDir,{mode:0o700});writeFileSync(executable,"known fixture",{mode:0o700});
 const native={installationID:"host_fixture",hostURL:"https://127.0.0.1:8443",hostFingerprint:host.fingerprint,hostCertificateDER:new X509Certificate(host.certPem).raw.toString("base64")};writeFileSync(nativePath,JSON.stringify(native),{mode:0o600});
 const config={version:2,mode:"local-capabilities",name:"fixture",dataDir,capabilities:["mac.cua.status","mac.cua.observe","mac.cua.control"],hostUrl:native.hostURL,hostFingerprint:host.fingerprint,hostCertPath:join(root,"host/cert.pem"),client:{kind:"native-helper",identityMode:"production",executable,configPath:nativePath,installationID:native.installationID},browser:null,cua:{mode:"native",executable},policyPath:join(root,"policy.json")};
 const save=(value:unknown)=>writeFileSync(path,JSON.stringify(value),{mode:0o600});save(config);t.after(()=>rmSync(root,{recursive:true,force:true}));return{root,config,dataDir,path,host,device,save};
}
function transport():CuaTransport&{requests:number;closed:number}{return{alive:true,requests:0,closed:0,request:async function(){this.requests++;throw Error("no request during owner preparation");},onEvent:()=>()=>{},onExit:()=>{},close:async function(){this.closed++;},kill(){throw Error("unexpected kill");}};}
test("closed argv accepts only unique explicit prepare and pairing flags",()=>{
 for(const flags of [[],["--pair"],["--prepare-cua"],["--pair","--prepare-cua"],["--prepare-cua","--pair"]]){const result=parseDaemonArguments(["--config","/private/config.json",...flags]);assert.equal(result.pair,flags.includes("--pair"));assert.equal(result.prepareCua,flags.includes("--prepare-cua"));}
 for(const flags of [["--prepare-cua","--prepare-cua"],["--pair","--pair"],["--prepare-cua=true"],["--calibrated"],["--prepare-cua","bot_fixture"]])assert.throws(()=>parseDaemonArguments(["--config","/private/config.json",...flags]),e=>e instanceof DeviceError&&e.code==="invalid_input");
});
test("owner preparation warms exactly same transport and neither grants nor creates sessions",async()=>{
 const helper=transport();let starts=0;const capability=new CuaCapability({policy:new LocalCapabilityPolicy({version:1,bots:[]}),transport:()=>{starts++;return helper;}});
 assert.equal(starts,0);capability.prepareForOwner();capability.prepareForOwner();assert.equal(starts,1);assert.equal(helper.requests,0);assert.deepEqual(capability.status(),{helper:true,sessions:[],consentsPending:0});
 await capability.close();assert.equal(helper.closed,1);assert.throws(()=>capability.prepareForOwner(),e=>e instanceof HandlerRefusal&&e.code==="capability_closed");assert.equal(starts,1);
});
test("missing or fixture CUA preparation refuses before identity and pairing hooks",async t=>{
 const f=fixture(t);
 for(const value of [{...f.config,cua:null,browser:{executable:f.config.cua.executable,networkIsolation:"none"},capabilities:["mac.browser.read"]},{...f.config,cua:{...f.config.cua,mode:"fixture"}}]){
  f.save(value);const before=readdirSync(f.dataDir);let effects=0;const forbidden=()=>{effects++;throw Error("unexpected effect");};const events:unknown[]=[];
  assert.equal(await main(["--config",f.path,"--prepare-cua"],{emit:e=>events.push(e),createNativeClient:forbidden,loadIdentity:forbidden,createCapabilities:forbidden,createDaemon:forbidden,pairDevice:forbidden,readPairingLine:forbidden}),1);assert.equal(effects,0);assert.deepEqual(events,[{event:"error",code:"unsupported"}]);assert.deepEqual(readdirSync(f.dataDir),before);
 }
});
test("owner warm happens after one native load and explicit pairing, before daemon, then same drain",async t=>{
 const f=fixture(t),order:string[]=[];const helper=transport();let capability:CuaCapability|undefined;let closed=0;
 const client:NativeClientHandle={hostFingerprint:f.host.fingerprint,loadOnly:async()=>{order.push("load");return{fingerprint:f.device.fingerprint,certificateDER:new X509Certificate(f.device.certPem).raw.toString("base64"),policy:"secure_enclave_data_protection_keychain_device_only"};},post:async()=>{throw Error("no network");},close:async()=>{closed++;}};
 const code=await main(["--config",f.path,"--pair","--prepare-cua"],{emit(){},createNativeClient:()=>client,readPairingLine:async()=>{order.push("input");return{offerId:"offer_fixture",code:"human_fixture"};},pairDevice:async()=>{order.push("pair");return{installationId:"host_fixture",deviceId:"dev_fixture",ownerId:"owner_fixture",hostFingerprint:f.host.fingerprint};},
  createCapabilities:config=>{order.push("caps");capability=new CuaCapability({policy:config.policy,transport:()=>{order.push("transport");return helper;}});return{handlers:new Map(),browser:null,cua:capability,close:async()=>{await capability!.close();}};},
  createDaemon:()=>{order.push("daemon");return{binding:{deviceId:"dev_fixture"} as never,start:stop=>stop?.(null),stop:async()=>{await capability!.close();await client.close();}};}});
 assert.equal(code,0);assert.deepEqual(order,["load","input","pair","caps","transport","daemon"]);assert.equal(helper.requests,0);assert.equal(helper.closed,1);assert.equal(closed,1);assert.deepEqual(capability!.status().sessions,[]);
});
