// Operator selection and synthetic protocol only. Never launches the Swift native backend.
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { generateSyntheticIdentity, DeviceError, HandlerRefusal, CuaHelperProcess, type LocalCapabilities } from "../packages/devices/src/index.js";
import { confirmNativeSelection, readDaemonConfig } from "../packages/devices/src/daemon-config.js";
import { main, type NativeClientHandle } from "../packages/devices/src/daemon-main.js";
import { memoryCustody } from "./fixtures/device-memory-custody.js";
function setup(t:TestContext){
 const root=realpathSync(mkdtempSync(join(tmpdir(),"dexter-native-cua-selection-")));
 const host=generateSyntheticIdentity(join(root,"host"),"host"),device=generateSyntheticIdentity(join(root,"device"),"device");memoryCustody(join(root,"device"),device,t);
 const dataDir=join(root,"data");mkdirSync(dataDir,{mode:0o700});
 const executable=join(root,"protocol.mjs"),configPath=join(root,"native.json"),path=join(root,"daemon.json"),policyPath=join(root,"policy.json");
 writeFileSync(executable,`#!${process.execPath}\nimport readline from 'node:readline';\nconst lines=readline.createInterface({input:process.stdin});\nlines.on('line',line=>{const m=JSON.parse(line);process.stdout.write(JSON.stringify({v:2,id:m.id,ok:false,code:'lock_state_unknown',argv:process.argv.slice(2),env:Object.keys(process.env)})+'\\n');});\n`,{mode:0o700});
 const native={installationID:"host_fixture",hostURL:"https://127.0.0.1:12345",hostCertificateDER:new X509Certificate(host.certPem).raw.toString("base64"),hostFingerprint:host.fingerprint};
 const saveNative=(v:unknown)=>writeFileSync(configPath,JSON.stringify(v),{mode:0o600});saveNative(native);
 const client={kind:"native-helper",identityMode:"production",executable,configPath,installationID:native.installationID};
 const config={version:2,mode:"local-capabilities",dataDir,name:"Synthetic",capabilities:["mac.cua.status"],hostUrl:native.hostURL,hostCertPath:join(root,"host/cert.pem"),hostFingerprint:host.fingerprint,client,browser:null,cua:{mode:"native",executable},policyPath};
 const save=(v:unknown)=>writeFileSync(path,JSON.stringify(v),{mode:0o600});save(config);
 t.after(()=>rmSync(root,{recursive:true,force:true}));return{root,host,device,dataDir,path,policyPath,config,client,native,executable,configPath,save,saveNative};
}
const context={hostId:"host_fixture",ownerId:"owner_fixture",deviceId:"dev_fixture",botId:"bot_fixture",threadId:"thr_fixture",actionId:"act_fixture",requestHash:"a".repeat(64),tool:"mac.cua.status",deadlineAt:Date.now()+30000};
test("explicit production v2 native selection preserves executable, grants nothing and creates no storage",t=>{
 const s=setup(t),before=readdirSync(s.dataDir),c=readDaemonConfig(s.path);assert.equal(c.mode,"local-capabilities");if(c.mode!=="local-capabilities")assert.fail();
 assert.deepEqual(c.cua,{mode:"native",executable:s.executable});assert.equal(c.client.kind,"native-helper");assert.throws(()=>c.policy.authorize(context,"mac.cua.status"),e=>e instanceof HandlerRefusal&&e.code==="not_granted");
 assert.deepEqual(readdirSync(s.dataDir),before);assert.equal(existsSync(s.policyPath),false);
});
test("native and fixture config selections drive exact real transport argv and close their owned protocol shims",async t=>{
 const s=setup(t);
 for(const mode of ["native","fixture"] as const){s.save({...s.config,cua:{mode,executable:s.executable}});const c=readDaemonConfig(s.path);if(c.mode!=="local-capabilities"||!c.cua)assert.fail();
  const transport=new CuaHelperProcess(c.cua);t.after(async()=>{await transport.close(1000);});
  const reply=await transport.request({op:"check"},AbortSignal.timeout(3000));assert.deepEqual(reply.argv,mode==="native"?[]:["--fixture"]);assert.deepEqual((reply.env as string[]).filter(k=>k!=="__CF_USER_TEXT_ENCODING"),[]);assert.equal(reply.code,"lock_state_unknown");
  await transport.close(1000);await transport.exited;assert.equal(transport.alive,false);
 }
});
test("main injects the validated native CUA into capability composition and drains owned resources",async t=>{
 const s=setup(t);let loads=0,clients=0,closed=0,stopped=0,capClosed=0;const events:unknown[]=[];
 writeFileSync(join(s.dataDir,"native-device.json"),JSON.stringify({fingerprint:s.device.fingerprint}),{mode:0o600});
 writeFileSync(join(s.dataDir,"binding.json"),JSON.stringify({installationId:s.client.installationID,ownerId:"owner_fixture",deviceId:"dev_fixture",hostFingerprint:s.host.fingerprint}),{mode:0o600});
 const client:NativeClientHandle={hostFingerprint:s.host.fingerprint,loadOnly:async()=>{loads++;return{fingerprint:s.device.fingerprint,certificateDER:new X509Certificate(s.device.certPem).raw.toString("base64"),policy:"secure_enclave_data_protection_keychain_device_only"};},post:async()=>{throw Error("unexpected network");},close:async()=>{closed++;}};
 let caps:LocalCapabilities|undefined;
 const result=await main(["--config",s.path],{emit:e=>events.push(e),loadIdentity:()=>{throw Error("PEM fallback");},createNativeClient:options=>{clients++;assert.equal(options.identityMode,"production");return client;},
 createCapabilities:c=>{assert.deepEqual(c.cua,{mode:"native",executable:s.executable});caps={handlers:new Map([["mac.cua.status",async()=>({status:"synthetic"})]]),browser:null,cua:null,close:async()=>{capClosed++;}};return caps;},
 createDaemon:options=>{assert.equal(options.client,client);assert.deepEqual([...options.handlers.keys()],["mac.cua.status"]);assert.deepEqual(options.resources,[caps]);return{binding:{deviceId:"dev_fixture"} as never,start:stop=>stop?.(null),stop:async()=>{stopped++;await caps!.close();await client.close();}};}});
 assert.equal(result,0);assert.deepEqual([clients,loads,stopped,closed,capClosed],[1,1,1,1,1]);assert.deepEqual(events,[{event:"ready",deviceId:"dev_fixture"},{event:"stopped",reason:"stopped"}]);assert.equal(existsSync(join(s.dataDir,"journal.sqlite")),false);
});
async function preflight(s:ReturnType<typeof setup>,code:string){
 assert.throws(()=>readDaemonConfig(s.path),e=>e instanceof DeviceError&&e.code===code);
 const before=readdirSync(s.dataDir);let effects=0;const output:Record<string,unknown>[]=[];
 const forbidden=()=>{effects++;throw Error("unexpected startup side effect");};
 assert.equal(await main(["--config",s.path],{emit:e=>output.push(e),loadIdentity:forbidden,createNativeClient:forbidden,createCapabilities:forbidden,createDaemon:forbidden,readPairingLine:forbidden,pairDevice:forbidden}),1);
 assert.equal(effects,0);assert.equal(output.length,1);assert.equal(output[0]!.event,"error");assert.deepEqual(output,[{event:"error",code}]);
 assert.deepEqual(readdirSync(s.dataDir),before);assert.equal(existsSync(s.policyPath),false);
}
test("v1, legacy, PEM, implicit production, laboratory-native and laboratory-browser never select native CUA",async t=>{
 const s=setup(t),{client:_,...rest}=s.config;
 const values=[{...rest,version:1,identityDir:join(s.root,"device")},{...s.config,client:{kind:"laboratory-pem",identityDir:join(s.root,"device")}},{...s.config,client:{...s.client,identityMode:undefined}},{...s.config,client:{...s.client,identityMode:"laboratory-native"}},{...s.config,mode:"laboratory-browser"},{...s.config,mode:"laboratory",fixtureRoot:s.dataDir},{...s.config,mode:undefined,version:undefined,identityDir:join(s.root,"device")}];
 const codes=["unsupported","unsupported","unsupported","forbidden","forbidden","invalid_input","invalid_input"];
 for(const [index,value] of values.entries()){s.save(value);await preflight(s,codes[index]!);}
});
test("production outer config refuses laboratory-tagged public native binding before startup",async t=>{
 const s=setup(t);s.saveNative({...s.native,laboratoryID:"a".repeat(32)});await preflight(s,"forbidden");
 // The same public laboratory binding is allowed only through the explicit fixture route.
 s.save({...s.config,cua:{mode:"fixture",executable:s.executable}});const c=readDaemonConfig(s.path);
 assert.equal(c.mode,"local-capabilities");if(c.mode!=="local-capabilities")assert.fail();assert.equal(c.cua?.mode,"fixture");
 assert.equal(c.client.kind,"native-helper");confirmNativeSelection(c.client,c.trust);
 assert.deepEqual(readdirSync(s.dataDir),[]);assert.equal(existsSync(s.policyPath),false);
});
test("unknown, nested and ambiguous schemas refuse before all startup hooks",async t=>{
 const s=setup(t);
 for(const value of [{...s.config,version:3},{...s.config,identityDir:s.dataDir},{...s.config,cua:{mode:"native",executable:s.executable,grant:true}},{...s.config,cua:{mode:{native:true},executable:s.executable}},{...s.config,client:{...s.client,nested:{identityMode:"production"}}},{...s.config,cua:{mode:"Native",executable:s.executable}},{...s.config,capabilities:["mac.cua.status"],cua:null},{...s.config,capabilities:["mac.browser.read"]}]){s.save(value);await preflight(s,value.cua===null||value.capabilities[0]==="mac.browser.read"?"unsupported":"invalid_input");}
});
test("private native CUA executable and storage guards run before identity, helpers, pairing and journal",async t=>{
 const s=setup(t),weak=join(s.root,"weak.mjs"),link=join(s.root,"link.mjs");writeFileSync(weak,"fixture",{mode:0o755});symlinkSync(s.executable,link);
 for(const executable of [weak,link,s.root,join(s.root,"missing")]){s.save({...s.config,cua:{mode:"native",executable}});await preflight(s,"forbidden");}
 s.save(s.config);chmodSync(s.executable,0o600);await preflight(s,"forbidden");chmodSync(s.executable,0o700);
 symlinkSync(join(s.root,"outside"),join(s.dataDir,"journal.sqlite-wal"));await preflight(s,"forbidden");rmSync(join(s.dataDir,"journal.sqlite-wal"));
 writeFileSync(s.policyPath,JSON.stringify({version:1,bots:[]}),{mode:0o644});await preflightWithPolicy();
 async function preflightWithPolicy(){let effects=0;assert.equal(await main(["--config",s.path],{emit(){},createNativeClient:()=>{effects++;throw Error("no");}}),1);assert.equal(effects,0);assert.deepEqual(readdirSync(s.dataDir),[]);}
});
test("host and installation trust mismatches refuse before startup",async t=>{
 const s=setup(t);
 for(const native of [{...s.native,hostURL:"https://127.0.0.1:54321"},{...s.native,installationID:"host_other"},{...s.native,hostFingerprint:"b".repeat(64)}]){s.saveNative(native);await preflight(s,native.hostFingerprint!==s.native.hostFingerprint?"tls_pin_mismatch":"forbidden");}
 s.saveNative(s.native);writeFileSync(join(s.dataDir,"binding.json"),JSON.stringify({installationId:"host_other",ownerId:"owner_fixture",deviceId:"dev_fixture",hostFingerprint:s.host.fingerprint}),{mode:0o600});await preflight(s,"conflict");
});

test("duplicate and escaped duplicate operator keys cannot silently select a backend",async t=>{
 const s=setup(t),text=JSON.stringify(s.config);
 for(const body of [text.replace('"mode":"native"','"mode":"fixture","mode":"native"'),text.replace('"mode":"native"','"mode":"fixture","mo\\u0064e":"native"'),text.replace('"version":2','"version":1,"version":2')]){writeFileSync(s.path,body,{mode:0o600});await preflight(s,"invalid_input");}
 s.save(s.config);writeFileSync(s.configPath,JSON.stringify(s.native).replace('"installationID":"host_fixture"','"installationID":"host_other","installationID":"host_fixture"'),{mode:0o600});await preflight(s,"invalid_input");
});

test("production native binding digest stays frozen through confirmation and public config drift refuses",t=>{
 const s=setup(t),c=readDaemonConfig(s.path);assert.equal(c.client.kind,"native-helper");if(c.client.kind!=="native-helper")assert.fail();
 assert.equal(c.client.digest,createHash("sha256").update(JSON.stringify(s.native)).digest("hex"));confirmNativeSelection(c.client,c.trust);
 s.saveNative({...s.native,laboratoryID:"a".repeat(32)});
 assert.throws(()=>confirmNativeSelection(c.client,c.trust),e=>e instanceof DeviceError&&e.code==="forbidden");
 assert.throws(()=>readDaemonConfig(s.path),e=>e instanceof DeviceError&&e.code==="forbidden");
 s.saveNative(s.native);confirmNativeSelection(c.client,c.trust);
 assert.deepEqual(readdirSync(s.dataDir),[]);assert.equal(existsSync(s.policyPath),false);
});
