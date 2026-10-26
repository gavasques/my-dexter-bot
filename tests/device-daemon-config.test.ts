import { sendMemoryIdentity } from "./fixtures/memory-identity-channel.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { HostStore, HostError } from "@dexter/hub";
import { DeviceError, generateSyntheticIdentity, DevicePairingRegistry, DeviceHostServer, pairDevice, MacDeviceDaemon, HandlerRefusal, type LocalCapabilities } from "../packages/devices/src/index.js";
import { readDaemonConfig, parseDaemonArguments } from "../packages/devices/src/daemon-config.js";
import { main } from "../packages/devices/src/daemon-main.js";
import { memoryCustody } from "./fixtures/device-memory-custody.js";
const refusal=(code:string)=>(e:unknown)=>e instanceof DeviceError&&e.code===code;
function gate(){let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return{promise,release};}
async function until(fn:()=>boolean,ms=5000){const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw new Error("fixture deadline");await new Promise(r=>setTimeout(r,5));}}
function setup(t:TestContext){
 const cleanup:(()=>void|Promise<void>)[]=[];const root=mkdtempSync(join(tmpdir(),"dexter-daemon-config-"));const host=generateSyntheticIdentity(join(root,"host-id"),"host"),identity=generateSyntheticIdentity(join(root,"identity"),"device");
 memoryCustody(join(root,"identity"),identity,t);
 const dataDir=join(root,"data"),fixtureRoot=join(root,"fixtures");mkdirSync(dataDir,{mode:0o700});mkdirSync(fixtureRoot,{mode:0o700});
 const path=join(root,"config.json"),policyPath=join(root,"policy.json"),config={dataDir,identityDir:join(root,"identity"),fixtureRoot,name:"Fixture Mac",capabilities:["mac.file.append"],hostUrl:"https://127.0.0.1:12345",hostCertPath:join(root,"host-id/cert.pem"),hostFingerprint:host.fingerprint};
 const save=(value:unknown)=>{writeFileSync(path,JSON.stringify(value),{mode:0o600});return path;};save(config);
 const local=()=>({mode:"local-capabilities",version:1,dataDir,identityDir:config.identityDir,name:config.name,capabilities:["mac.browser.navigate"],hostUrl:config.hostUrl,hostCertPath:config.hostCertPath,hostFingerprint:config.hostFingerprint,policyPath,browser:{executable:process.execPath,networkIsolation:"loopback_only"},cua:null});
 const bind=()=>writeFileSync(join(dataDir,"binding.json"),JSON.stringify({installationId:"host_fixture",ownerId:"owner_fixture",deviceId:"dev_fixture",hostFingerprint:host.fingerprint}),{mode:0o600});
 t.after(async()=>{for(const f of cleanup.reverse())await f();rmSync(root,{recursive:true,force:true});});return{cleanup:(f:()=>void|Promise<void>)=>cleanup.push(f),root,host,identity,dataDir,fixtureRoot,path,policyPath,config,local,save,bind};
}
test("legacy fixture config stays explicit; local missing policy grants nothing and exposes only declared families",t=>{
 const s=setup(t);assert.equal(readDaemonConfig(s.path).mode,"laboratory");s.save(s.local());const c=readDaemonConfig(s.path);assert.equal(c.mode,"local-capabilities");assert.equal(existsSync(s.policyPath),false);
 if(c.mode!=="local-capabilities")assert.fail();assert.throws(()=>c.policy.authorize({hostId:"host_fixture",ownerId:"owner_fixture",deviceId:"dev_fixture",botId:"bot_fixture",threadId:"thr_fixture",actionId:"act_fixture",requestHash:"a".repeat(64),tool:"mac.browser.navigate",deadlineAt:Date.now()+1000},"mac.browser.navigate"),e=>e instanceof HandlerRefusal&&e.code==="not_granted");
 s.save({...s.local(),capabilities:["mac.file.append"]});assert.throws(()=>readDaemonConfig(s.path),refusal("unsupported"));s.save({...s.config,capabilities:["mac.browser.navigate"]});assert.throws(()=>readDaemonConfig(s.path),refusal("unsupported"));
});
test("unknown modes/fields, oversized body, controls and incorrect host pin are refused before identity hooks",async t=>{
 const s=setup(t);let identityLoads=0;const outputs:unknown[]=[];const run=()=>main(["--config",s.path],{loadIdentity(){identityLoads++;return s.identity;},emit:e=>outputs.push(e)});
 for(const value of [{...s.local(),unknown:true},{...s.local(),mode:"other"},{...s.local(),name:"bad\nname"},{...s.local(),hostUrl:"https://127.0.0.1:1/private"},{...s.local(),hostFingerprint:"b".repeat(64)}]){s.save(value);assert.equal(await run(),1);}
 writeFileSync(s.path,"x".repeat(16385));assert.equal(await run(),1);assert.equal(identityLoads,0);assert.equal(existsSync(join(s.dataDir,"journal.sqlite")),false);assert.ok(!JSON.stringify(outputs).includes("bad"));
 assert.throws(()=>parseDaemonArguments(["--config",s.path,"--unknown"]),refusal("invalid_input"));assert.throws(()=>parseDaemonArguments(["--config","relative"]),refusal("invalid_input"));
});
test("private paths reject dangling and ancestor symlinks, public configuration/policy and nonexecutables",t=>{
 const s=setup(t);chmodSync(s.path,0o644);assert.throws(()=>readDaemonConfig(s.path),refusal("forbidden"));chmodSync(s.path,0o600);
 const missing=join(s.root,"outside-missing");symlinkSync(missing,s.policyPath);s.save(s.local());assert.throws(()=>readDaemonConfig(s.path),refusal("forbidden"));assert.equal(existsSync(missing),false);rmSync(s.policyPath);
 writeFileSync(s.policyPath,JSON.stringify({version:1,bots:[]}),{mode:0o644});assert.throws(()=>readDaemonConfig(s.path),refusal("forbidden"));chmodSync(s.policyPath,0o600);
 const linked=join(s.root,"linked");symlinkSync(s.root,linked);s.save({...s.local(),policyPath:join(linked,"policy.json")});assert.throws(()=>readDaemonConfig(s.path),refusal("forbidden"));
 const exe=join(s.root,"not-executable");writeFileSync(exe,"fixture",{mode:0o600});s.save({...s.local(),browser:{executable:exe,networkIsolation:"loopback_only"}});assert.throws(()=>readDaemonConfig(s.path),refusal("forbidden"));
});
test("CUA native fails closed while explicitly named fixture validates without launching anything",async t=>{
 const s=setup(t);s.save({...s.local(),browser:null,capabilities:["mac.cua.observe"],cua:{mode:"native",executable:process.execPath}});let loads=0;const output:Record<string,unknown>[]=[];
 assert.throws(()=>readDaemonConfig(s.path),refusal("unsupported"));
 assert.equal(await main(["--config",s.path],{loadIdentity(){loads++;return s.identity;},emit:e=>output.push(e)}),1);assert.equal(loads,0);assert.deepEqual(output,[{event:"error",code:"unsupported"}]);
 s.save({...s.local(),browser:null,capabilities:["mac.cua.observe"],cua:{mode:"fixture",executable:process.execPath}});const c=readDaemonConfig(s.path);assert.equal(c.mode,"local-capabilities");if(c.mode==="local-capabilities")assert.equal(c.cua?.mode,"fixture");
});
function resource(close:()=>Promise<void>):LocalCapabilities{return{handlers:new Map(),browser:null,cua:null,close};}
test("cancelled startup drains created resources before returning and never constructs a journal",async t=>{
 const s=setup(t);s.save(s.local());s.bind();const controller=new AbortController(),g=gate();let closed=false,created=0,finished=false;
 const result=main(["--config",s.path],{signal:controller.signal,emit(){},createCapabilities(){controller.abort();return resource(async()=>{await g.promise;closed=true;});},createDaemon(){created++;throw new Error("must not create");}});s.cleanup(async()=>{g.release();await result;});void result.then(()=>{finished=true;});
 await new Promise(r=>setTimeout(r,10));assert.equal(finished,false);assert.equal(created,0);assert.equal(existsSync(join(s.dataDir,"journal.sqlite")),false);g.release();assert.equal(await result,1);assert.equal(closed,true);
});
test("constructor failure closes capability resources and emits only fixed codes",async t=>{
 const s=setup(t);s.save(s.local());s.bind();const g=gate();let closed=false,finished=false;const output:Record<string,unknown>[]=[];
 const result=main(["--config",s.path],{emit:e=>output.push(e),createCapabilities:()=>resource(async()=>{await g.promise;closed=true;}),createDaemon(){throw new Error("synthetic private body must never appear");}});s.cleanup(async()=>{g.release();await result;});void result.then(()=>{finished=true;});await new Promise(r=>setTimeout(r,10));assert.equal(finished,false);g.release();assert.equal(await result,1);assert.equal(closed,true);assert.deepEqual(output,[{event:"error",code:"unavailable"}]);
});
test("real daemon resource drain precedes journal writer release in the main lifecycle",async t=>{
 const s=setup(t);s.save(s.local());s.bind();const g=gate();let closing=false,finished=false,realDaemon:MacDeviceDaemon|null=null;const caps=resource(async()=>{closing=true;await g.promise;});
 const result=main(["--config",s.path],{emit(){},createCapabilities:()=>caps,createDaemon(options){const d=new MacDeviceDaemon(options);realDaemon=d;d.start=onStop=>{onStop?.(null);};return d;}});s.cleanup(async()=>{g.release();await realDaemon?.stop();await result;});void result.then(()=>{finished=true;});await until(()=>closing);
 assert.equal(finished,false);assert.throws(()=>new MacDeviceDaemon({dataDir:s.dataDir,identity:s.identity,trust:{hostUrl:s.config.hostUrl,hostCertPem:s.host.certPem,hostFingerprint:s.host.fingerprint},handlers:new Map()}),refusal("conflict"));
 g.release();assert.equal(await result,0);const second=new MacDeviceDaemon({dataDir:s.dataDir,identity:s.identity,trust:{hostUrl:s.config.hostUrl,hostCertPem:s.host.certPem,hostFingerprint:s.host.fingerprint},handlers:new Map()});await second.stop();
});

async function channel(s:ReturnType<typeof setup>,capabilities:string[]){
 const store=new HostStore({dataDir:join(s.root,"hub")}),registry=new DevicePairingRegistry(store),server=new DeviceHostServer({store,registry,identity:s.host,pollWaitMs:50,receiptTimeoutMs:5000});
 const hostUrl=await server.start(),trust={hostUrl,hostCertPem:s.host.certPem,hostFingerprint:s.host.fingerprint};const bundle=server.pairingBundle({kind:"pair"});
 const pairing=pairDevice({dataDir:s.dataDir,identity:s.identity,trust,offerId:bundle.offerId,code:bundle.code,name:"Fixture Mac",capabilities,pollIntervalMs:5});await until(()=>registry.listPendingClaims().length===1);registry.approveClaim(registry.listPendingClaims()[0]!.claimId);const binding=await pairing;
 s.cleanup(async()=>{await server.close();registry.close();store.close();});return{store,registry,server,hostUrl,binding};
}
function daemonChild(s:ReturnType<typeof setup>,path=s.path,entry=resolve("packages/devices/dist/daemon-main.js"),pair=false){
 const child=spawn(process.execPath,["--import",fileURLToPath(new URL("./fixtures/device-memory-preload.js",import.meta.url)),entry,"--config",path,...(pair?["--pair"]:[])],{shell:false,env:{PATH:"/usr/bin:/bin",NODE_NO_WARNINGS:"1"},stdio:["pipe","pipe","pipe","ipc"]});const identityReady=sendMemoryIdentity(child,s.identity); void identityReady.catch(()=>{child.kill("SIGTERM");});let out="",err="";child.stdout!.on("data",b=>{out+=b.toString();});child.stderr!.on("data",b=>{err+=b.toString();});const exited=new Promise<number|null>(r=>child.once("close",r));let done=false;void exited.then(()=>{done=true;});
 s.cleanup(async()=>{if(!done){child.kill("SIGTERM");await until(()=>done,4000).catch(()=>{child.kill("SIGKILL");});await exited;}});return{child,exited,output:()=>out,stderr:()=>err,stop:async()=>{child.kill("SIGTERM");await until(()=>done,4000);return exited;}};
}
test("real subprocess legacy daemon appends one synthetic line over pinned TLS and stops its journal",async t=>{
 const s=setup(t),c=await channel(s,["mac.file.append"]);s.save({...s.config,hostUrl:c.hostUrl});const child=daemonChild(s);await until(()=>child.output().includes('"ready"'));
 const bot=c.store.createBot({name:"Synthetic",profileId:"fixture",engine:"claude"}),thread=c.store.createThread(bot.id);c.store.setGrant({botId:bot.id,tool:"mac.file.append",destination:c.binding.deviceId,policy:"allow"});
 const action=c.store.requestAction({botId:bot.id,threadId:thread.id,tool:"mac.file.append",destination:c.binding.deviceId,arguments:{name:"fixture.txt",line:"SYNTHETIC-NOT-OUTPUT"},idempotencyKey:"one"});assert.equal((await c.server.dispatch(action.id)).state,"succeeded");assert.equal(readFileSync(join(s.fixtureRoot,"fixture.txt"),"utf8"),"SYNTHETIC-NOT-OUTPUT\n");assert.equal(await child.stop(),0);assert.ok(!child.output().includes("SYNTHETIC-NOT-OUTPUT"));assert.ok(!child.output().includes("PRIVATE KEY"));
 const db=new DatabaseSync(join(s.dataDir,"journal.sqlite"));assert.equal((db.prepare("SELECT COUNT(*) n FROM lease").get() as {n:number}).n,0);db.close();
});
test("real subprocess local browser uses both host and local bot grants with only synthetic CDP",async t=>{
 const s=setup(t),c=await channel(s,["mac.browser.navigate","mac.browser.read"]);const exe=join(s.root,"browser.mjs"),fixture=fileURLToPath(new URL("./fixtures/fake-cdp-browser.js",import.meta.url));writeFileSync(exe,`#!${process.execPath}\n${readFileSync(fixture,"utf8")}`,{mode:0o700});writeFileSync(join(s.root,"site.json"),JSON.stringify({pages:{"http://127.0.0.1:19444/":{title:"Fixture",text:"UNTRUSTED-SYNTHETIC"}}}),{mode:0o600});
 const bot=c.store.createBot({name:"Synthetic",profileId:"fixture",engine:"claude"}),other=c.store.createBot({name:"Other",profileId:"fixture",engine:"claude"}),thread=c.store.createThread(bot.id),otherThread=c.store.createThread(other.id);writeFileSync(s.policyPath,JSON.stringify({version:1,bots:[{botId:bot.id,label:"Synthetic",operations:["mac.browser.navigate","mac.browser.read"],browserOrigins:["http://127.0.0.1:19444"],cuaMaxSessionSeconds:0}]}),{mode:0o600});
 s.save({...s.local(),hostUrl:c.hostUrl,capabilities:["mac.browser.navigate","mac.browser.read"],browser:{executable:exe,networkIsolation:"loopback_only"}});const child=daemonChild(s);await until(()=>child.output().includes('"ready"'));let n=0;
 const ask=(botId:string,threadId:string,tool:string,arguments_:Record<string,string|number>)=>c.store.requestAction({botId,threadId,tool,destination:c.binding.deviceId,arguments:arguments_,idempotencyKey:"k"+(++n)});
 assert.throws(()=>ask(bot.id,thread.id,"mac.browser.navigate",{url:"http://127.0.0.1:19444/"}),e=>e instanceof HostError&&e.code==="forbidden");assert.equal(c.store.listActions().length,0);assert.equal(existsSync(join(s.root,"log.jsonl")),false);
 for(const b of [bot,other])for(const tool of ["mac.browser.navigate","mac.browser.read"])c.store.setGrant({botId:b.id,tool,destination:c.binding.deviceId,policy:"allow"});
 const foreign=ask(other.id,otherThread.id,"mac.browser.navigate",{url:"http://127.0.0.1:19444/"});const notGranted=await c.server.dispatch(foreign.id);assert.equal((notGranted.result as {code:string}).code,"not_granted");assert.equal(existsSync(join(s.root,"log.jsonl")),false);
 assert.equal((await c.server.dispatch(ask(bot.id,thread.id,"mac.browser.navigate",{url:"http://127.0.0.1:19444/"}).id)).state,"succeeded");const read=await c.server.dispatch(ask(bot.id,thread.id,"mac.browser.read",{maxChars:100}).id);assert.ok(JSON.stringify(read.result).includes("UNTRUSTED-SYNTHETIC"));assert.ok(JSON.stringify(read.result).includes("untrusted_external"));assert.equal(await child.stop(),0);assert.ok(!child.output().includes("UNTRUSTED-SYNTHETIC"));const events=readFileSync(join(s.root,"log.jsonl"),"utf8");assert.ok(events.includes('"launch"'));assert.ok(events.includes('"browser_close"'));assert.equal(child.stderr(),"");
});

test("macOS /tmp entry alias still runs config validation instead of silently exiting",async t=>{
 const s=setup(t);s.save({...s.local(),browser:null,capabilities:["mac.cua.observe"],cua:{mode:"native",executable:process.execPath}});
 const real=resolve("packages/devices/dist/daemon-main.js"),entry=real.startsWith("/private/tmp/")?real.replace("/private/tmp/","/tmp/"):join(s.root,"daemon-alias.js");if(entry!==real&&!entry.startsWith("/tmp/"))symlinkSync(real,entry);
 const child=daemonChild(s,s.path,entry);await until(()=>child.output().includes('"error"'));const code=await child.exited;assert.equal(code,1);assert.equal(child.output(),'{"event":"error","code":"unsupported"}\n');assert.equal(existsSync(join(s.dataDir,"journal.sqlite")),false);
});


test("journal sidecars and capability-root symlinks refuse before loading private identity",async t=>{
 const s=setup(t);s.save(s.local());let loads=0;const outside=join(s.root,"missing-outside"),journal=join(s.dataDir,"journal.sqlite-wal"),cap=join(s.dataDir,"capabilities");
 for(const target of [journal,cap]){symlinkSync(outside,target);const output:Record<string,unknown>[]=[];assert.equal(await main(["--config",s.path],{loadIdentity(){loads++;throw new Error("identity preflight sentinel");},emit:e=>output.push(e)}),1);assert.deepEqual(output,[{event:"error",code:"forbidden"}]);assert.equal(existsSync(outside),false);rmSync(target);}
 assert.equal(loads,0);
});

test("real process pairs only through bounded stdin and emits no pairing code or private key",async t=>{
 const s=setup(t),store=new HostStore({dataDir:join(s.root,"hub")}),registry=new DevicePairingRegistry(store),server=new DeviceHostServer({store,registry,identity:s.host,pollWaitMs:50});
 const hostUrl=await server.start();s.cleanup(async()=>{await server.close();registry.close();store.close();});s.save({...s.config,hostUrl});const bundle=server.pairingBundle({kind:"pair"}),child=daemonChild(s,s.path,undefined,true);
 child.child.stdin!.write(JSON.stringify({offerId:bundle.offerId,code:bundle.code})+"\n");await until(()=>registry.listPendingClaims().length===1);registry.approveClaim(registry.listPendingClaims()[0]!.claimId);await until(()=>child.output().includes('"ready"'));
 assert.ok(child.output().includes('"paired"'));assert.ok(!child.output().includes(bundle.code));assert.ok(!child.output().includes("PRIVATE KEY"));assert.equal(await child.stop(),0);assert.equal(child.stderr(),"");
});
test("oversized pairing stdin refuses without a journal or echoing its body",async t=>{
 const s=setup(t),child=daemonChild(s,s.path,undefined,true);child.child.stdin!.end("PRIVATE-INPUT-"+"x".repeat(4097)+"\n");await until(()=>child.output().includes('"error"'));assert.equal(await child.exited,1);assert.equal(child.output(),'{"event":"error","code":"invalid_input"}\n');assert.equal(existsSync(join(s.dataDir,"journal.sqlite")),false);
});

const ALL_TOOLS=["mac.browser.navigate","mac.browser.read","mac.browser.close","mac.cua.observe","mac.cua.control","mac.cua.status","mac.file.append","mac.file.read","mac.process.probe"];
function lifecycle(onStart:(stop:(reason:string|null)=>void)=>void,stop:()=>Promise<void>=async()=>{}){return{binding:{deviceId:"dev_fixture"} as never,start:(f?:(code:never)=>void)=>{onStart(f as (reason:string|null)=>void);},stop};}
test("installed handlers are exactly the declared capabilities and an undeclared handler is never reachable",async t=>{
 const s=setup(t);s.bind();s.save({...s.local(),capabilities:["mac.browser.navigate","mac.cua.status"],cua:{mode:"fixture",executable:process.execPath}});
 const calls:string[]=[];const offered=new Map(ALL_TOOLS.map(tool=>[tool,(async()=>{calls.push(tool);return tool;}) as never]));let seen:ReadonlyMap<string,unknown>|null=null,resources=0;
 const code=await main(["--config",s.path],{emit(){},createCapabilities:()=>({handlers:offered,browser:null,cua:null,close:async()=>{}}),
  createDaemon(options){seen=options.handlers;resources=options.resources?.length??0;return lifecycle(stop=>stop(null));}});
 assert.equal(code,0);assert.equal(resources,1);assert.deepEqual([...seen!.keys()].sort(),["mac.browser.navigate","mac.cua.status"]);
 for(const tool of ALL_TOOLS.filter(x=>x!=="mac.browser.navigate"&&x!=="mac.cua.status"))assert.equal(seen!.get(tool),undefined,tool);
 const job={} as never;assert.equal(await (seen!.get("mac.cua.status") as (a:object,c:never)=>Promise<string>)({},job),"mac.cua.status");assert.deepEqual(calls,["mac.cua.status"]);
});
test("CUA status needs the fixture family; invalid and native modes are distinct refusals; no default grant",t=>{
 const s=setup(t);s.save({...s.local(),browser:null,capabilities:["mac.cua.status"],cua:{mode:"fixture",executable:process.execPath}});const c=readDaemonConfig(s.path);assert.equal(c.mode,"local-capabilities");
 if(c.mode!=="local-capabilities")assert.fail();assert.throws(()=>c.policy.authorize({hostId:"host_fixture",ownerId:"owner_fixture",deviceId:"dev_fixture",botId:"bot_fixture",threadId:"thr_fixture",actionId:"act_fixture",requestHash:"a".repeat(64),tool:"mac.cua.status",deadlineAt:Date.now()+1000},"mac.cua.status"),e=>e instanceof HandlerRefusal&&e.code==="not_granted");
 s.save({...s.local(),browser:null,capabilities:["mac.cua.status"],cua:null});assert.throws(()=>readDaemonConfig(s.path),refusal("unsupported"));
 s.save({...s.local(),browser:null,capabilities:["mac.cua.status"],cua:{mode:"native",executable:process.execPath}});assert.throws(()=>readDaemonConfig(s.path),refusal("unsupported"));
 for(const mode of ["bogus","Fixture",1,null])for(const value of [{mode,executable:process.execPath}]){s.save({...s.local(),browser:null,capabilities:["mac.cua.status"],cua:value});assert.throws(()=>readDaemonConfig(s.path),refusal("invalid_input"));}
 s.save({...s.local(),browser:{executable:process.execPath,networkIsolation:"open"}});assert.throws(()=>readDaemonConfig(s.path),refusal("invalid_input"));
});
test("forbidden and tls_pin_mismatch stop reasons exit 3 with fixed output; other reasons exit 0",async t=>{
 const s=setup(t);s.bind();for(const [reason,expected] of [["forbidden",3],["tls_pin_mismatch",3],["unavailable",0],[null,0]] as const){
  const out:Record<string,unknown>[]=[];const code=await main(["--config",s.path],{emit:e=>out.push(e),createDaemon:()=>lifecycle(stop=>stop(reason))});
  assert.equal(code,expected,String(reason));assert.deepEqual(out,[{event:"ready",deviceId:"dev_fixture"},{event:"stopped",reason:reason??"stopped"}]);}
});
test("abort after approval and before resources leaves no resources, daemon, journal or paired/ready event",async t=>{
 const s=setup(t);const controller=new AbortController();const out:Record<string,unknown>[]=[];let created=0,built=0;
 const code=await main(["--config",s.path,"--pair"],{signal:controller.signal,emit:e=>out.push(e),readPairingLine:async()=>({offerId:"off_fixture",code:"synthetic"}),
  pairDevice:async()=>{controller.abort();return{deviceId:"dev_fixture"} as never;},createCapabilities(){built++;throw new Error("no");},createDaemon(){created++;throw new Error("no");}});
 assert.equal(code,1);assert.equal(created+built,0);assert.deepEqual(out,[{event:"claiming"},{event:"error",code:"unavailable"}]);assert.equal(existsSync(join(s.dataDir,"journal.sqlite")),false);
});
test("repeated controlled SIGTERM during drain requests the same stop and keeps handlers until the writer finished",async t=>{
 const s=setup(t);s.bind();const g=gate();let stops=0,entered=false;const base=process.listenerCount("SIGTERM"),baseInt=process.listenerCount("SIGINT");let finished=false;
 const result=main(["--config",s.path],{emit(){},createDaemon:()=>lifecycle(()=>{},async()=>{stops++;entered=true;await g.promise;})});s.cleanup(async()=>{g.release();await result;});void result.then(()=>{finished=true;});
 await until(()=>process.listenerCount("SIGTERM")===base+1);assert.equal(process.listenerCount("SIGINT"),baseInt+1);
 process.emit("SIGTERM");await until(()=>entered);process.emit("SIGTERM");process.emit("SIGINT");
 assert.equal(process.listenerCount("SIGTERM"),base+1);assert.equal(process.listenerCount("SIGINT"),baseInt+1);assert.equal(finished,false);
 g.release();assert.equal(await result,0);assert.equal(stops,1);assert.equal(process.listenerCount("SIGTERM"),base);assert.equal(process.listenerCount("SIGINT"),baseInt);
});
test("valid pairing JSON padded beyond 4096 bytes is refused by the byte bound, not parsed and claimed",async t=>{
 const s=setup(t),store=new HostStore({dataDir:join(s.root,"hub")}),registry=new DevicePairingRegistry(store),server=new DeviceHostServer({store,registry,identity:s.host,pollWaitMs:50});
 const hostUrl=await server.start();s.cleanup(async()=>{await server.close();registry.close();store.close();});s.save({...s.config,hostUrl});const bundle=server.pairingBundle({kind:"pair"}),child=daemonChild(s,s.path,undefined,true);
 child.child.stdin!.end(`{"offerId":"${bundle.offerId}",${" ".repeat(5000)}"code":"${bundle.code}"}\n`);await until(()=>child.output().includes('"error"'),8000);
 assert.equal(await child.exited,1);assert.equal(child.output(),'{"event":"error","code":"invalid_input"}\n');assert.equal(registry.listPendingClaims().length,0);assert.ok(!child.output().includes(bundle.code));assert.equal(existsSync(join(s.dataDir,"journal.sqlite")),false);
});
async function proxyProbe(t:TestContext,isolation:"none"|"loopback_only",origin:(port:number)=>string,granted:boolean){
 const s=setup(t);let hits=0;const web=createServer((_q,r)=>{hits++;r.end("SYNTHETIC-OWNED");});await new Promise<void>(r=>web.listen(0,"127.0.0.1",r));const port=(web.address() as AddressInfo).port;s.cleanup(()=>new Promise<void>(r=>{web.close(()=>r());web.closeAllConnections();}));
 const c=await channel(s,["mac.browser.navigate"]);const exe=join(s.root,"browser.mjs"),fixture=fileURLToPath(new URL("./fixtures/fake-cdp-browser.js",import.meta.url));writeFileSync(exe,`#!${process.execPath}\n${readFileSync(fixture,"utf8")}`,{mode:0o700});
 const target=`${origin(port)}/`,navigated=granted?target:"http://127.0.0.1:1/";writeFileSync(join(s.root,"site.json"),JSON.stringify({pages:{[navigated]:{title:"Fixture",text:"x"}}}),{mode:0o600});
 const bot=c.store.createBot({name:"Synthetic",profileId:"fixture",engine:"claude"}),thread=c.store.createThread(bot.id);c.store.setGrant({botId:bot.id,tool:"mac.browser.navigate",destination:c.binding.deviceId,policy:"allow"});
 writeFileSync(s.policyPath,JSON.stringify({version:1,bots:[{botId:bot.id,label:"Synthetic",operations:["mac.browser.navigate"],browserOrigins:[new URL(navigated).origin],cuaMaxSessionSeconds:0}]}),{mode:0o600});
 s.save({...s.local(),hostUrl:c.hostUrl,capabilities:["mac.browser.navigate"],browser:{executable:exe,networkIsolation:isolation}});const child=daemonChild(s);await until(()=>child.output().includes('"ready"'));
 await c.server.dispatch(c.store.requestAction({botId:bot.id,threadId:thread.id,tool:"mac.browser.navigate",destination:c.binding.deviceId,arguments:{url:navigated},idempotencyKey:"k"}).id);
 const launch=readFileSync(join(s.root,"log.jsonl"),"utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l) as {event:string;argv?:string[]}).find(e=>e.event==="launch")!;
 const proxyPort=Number(/^--proxy-server=http:\/\/127\.0\.0\.1:([0-9]+)$/.exec(launch.argv!.find(a=>a.startsWith("--proxy-server="))!)![1]);
 const status=await new Promise<number>((resolve,reject)=>{const q=httpRequest({host:"127.0.0.1",port:proxyPort,path:target,headers:{host:new URL(target).host},agent:false},res=>{res.resume();res.on("end",()=>resolve(res.statusCode??0));});q.on("error",reject);q.end();});
 const stopped=await child.stop();assert.equal(stopped,0);return{status,hits};
}
test("networkIsolation none keeps the per-origin proxy: ungranted loopback origin is denied before any dial",async t=>{
 const r=await proxyProbe(t,"none",p=>`http://127.0.0.1:${p}`,false);assert.equal(r.status,403);assert.equal(r.hits,0);
});
test("networkIsolation none reaches a granted non-loopback-form address while loopback_only refuses it",async t=>{
 // 0.0.0.0 is a non-loopback literal that routes to this host: no DNS and no external network is involved.
 const open=await proxyProbe(t,"none",p=>`http://0.0.0.0:${p}`,true);assert.equal(open.status,200);assert.equal(open.hits,1);
 const closed=await proxyProbe(t,"loopback_only",p=>`http://0.0.0.0:${p}`,true);assert.equal(closed.status,403);assert.equal(closed.hits,0);
 const granted=await proxyProbe(t,"loopback_only",p=>`http://127.0.0.1:${p}`,true);assert.equal(granted.status,200);assert.equal(granted.hits,1);
});
