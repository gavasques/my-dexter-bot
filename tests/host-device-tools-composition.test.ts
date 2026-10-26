import { mcpDirectoryClient } from "./fixtures/mcp-directory-client.mjs";
import { sendMemoryIdentity } from "./fixtures/memory-identity-channel.js";
// Real local MCP stdio + mutual TLS devices, synthetic native driver and private synthetic files only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { inspect } from "node:util";
import { HostStore, HostError, hashRequest } from "@dexter/hub";
import { createHostApp } from "@dexter/hub/http";
import { AgendaHostConsumer } from "@dexter/agenda";
import { ManagedAppsRuntime } from "@dexter/connectors";
import { directoryToolDefinitions, SyntheticCredentialBroker } from "@dexter/gateway";
import { FILE_APPEND, generateSyntheticIdentity, pairDevice, DeviceClient } from "@dexter/devices";
import type { EngineId } from "@dexter/contracts";
import { EngineError, type EngineDriver, type EngineEvent, type EngineSession } from "@dexter/engines";
import type { ResolvedFixtureMcpTool } from "./fixtures/mcp-directory-client.mjs";
import type { WorkspaceNativeOptions } from "../packages/cli/src/workspace-driver.js";
import type { HostServices as HostServicesType } from "../packages/cli/src/host-services.js";
const { DeviceServices } = await import(pathToFileURL(resolve("packages/cli/dist/device-services.js")).href) as typeof import("../packages/cli/src/device-services.js");
const { DeviceTurnSurface } = await import(pathToFileURL(resolve("packages/cli/dist/device-turn-surface.js")).href) as typeof import("../packages/cli/src/device-turn-surface.js");
const { HostServices } = await import(pathToFileURL(resolve("packages/cli/dist/host-services.js")).href) as { HostServices: typeof HostServicesType };
const until=async(check:()=>boolean)=>{const end=Date.now()+10000;while(!check()){if(Date.now()>end)throw Error("fixture_timeout");await new Promise(r=>setTimeout(r,5));}};
const gate=()=>{let release=()=>{};const promise=new Promise<void>(done=>{release=done;});return {promise,release};};
class FixtureRpcError extends Error {
  constructor(readonly rpcCode:number){super("synthetic MCP RPC refused");}
}
class Rpc {
  readonly child; readonly exited:Promise<void>;#seq=0;#pending=new Map<number,{resolve(value:any):void;reject(error:unknown):void}>();
  constructor(server:NonNullable<WorkspaceNativeOptions["localMcpServer"]>){
    this.child=spawn(server.command,[...server.args],{stdio:"pipe",env:{PATH:"/usr/bin:/bin"}});let buffer="";this.child.stdin.on("error",()=>{});this.child.stderr.resume();
    this.child.stdout.on("data",v=>{buffer+=v.toString();while(buffer.includes("\n")){const n=buffer.indexOf("\n"),msg=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);const p=this.#pending.get(msg.id);if(p){this.#pending.delete(msg.id);msg.error?p.reject(new FixtureRpcError(msg.error.code)):p.resolve(msg.result);}}});
    this.exited=new Promise(done=>this.child.once("close",()=>{for(const p of this.#pending.values())p.reject(new EngineError("session_closed"));this.#pending.clear();done();}));
  }
  rpc(method:string,params?:unknown):Promise<any>{const id=++this.#seq;const result=new Promise<any>((resolve,reject)=>this.#pending.set(id,{resolve,reject}));this.child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");return result;}
  async init(){await this.rpc("initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"synthetic-host",version:"1"}});this.child.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})+"\n");}
  async close(){this.child.stdin.end();await this.exited;}
}
class Native implements EngineDriver {
  readonly capabilities={resume:true,interrupt:true,fork:false,steer:false} as const;
  rpc?:Rpc; tools:any[]=[];receipts:any[]=[];readonly release=gate();readonly resolved=new Map<string,ResolvedFixtureMcpTool>();deviceUnavailableObserved=false;
  constructor(readonly id:EngineId,readonly options:WorkspaceNativeOptions,readonly behavior:(native:Native,signal:AbortSignal)=>Promise<void>,readonly didOpen:(native:Native)=>void){}
  async status(){return {engine:this.id,installed:true,version:"synthetic",authentication:"authenticated" as const,billing:"subscription" as const};}
  async open(threadId:string,cursor?:string){this.resolved.clear();this.rpc=new Rpc(this.options.localMcpServer!);await this.rpc.init();this.tools=(await this.rpc.rpc("tools/list")).tools;this.didOpen(this);return {threadId,nativeCursor:cursor??"synthetic-cursor"};}
  async *turn(session:EngineSession,turnId:string,_input:string,signal:AbortSignal):AsyncIterable<EngineEvent>{await this.behavior(this,signal);if(signal.aborted){yield {type:"turn.interrupted",threadId:session.threadId,turnId};return;}yield {type:"text.delta",threadId:session.threadId,turnId,text:"synthetic result"};yield {type:"turn.completed",threadId:session.threadId,turnId,usage:{}};}
  async call(callId="same",input:unknown={name:"notes.txt",line:"once"},tool=FILE_APPEND){
    const directory=mcpDirectoryClient(this.rpc!.rpc.bind(this.rpc!));
    let resolved=this.resolved.get(tool);
    if(!resolved){resolved=await directory.find(tool);this.resolved.set(tool,resolved);}
    // Retain the issued alias across grant changes, to exercise replay/stale-admission checks.
    const response=directory.result(await directory.call({...resolved,viaDirectory:true},callId,input));
    if(response.structuredContent)this.receipts.push(response.structuredContent);return response;
  }
  async assertRefused(callId="same",input:unknown={name:"notes.txt",line:"once"},tool=FILE_APPEND){
    try{const response=await this.call(callId,input,tool);assert.equal(response.isError,true);}
    catch(error){assert.ok(error instanceof FixtureRpcError);assert.ok([-32602,-32001].includes(error.rpcCode),'only a typed missing-target/closed-capability refusal is accepted');}
  }
  async directoryCall(callId="same",input:unknown={name:"notes.txt",line:"once"},tool=FILE_APPEND){return this.call(callId,input,tool);}
  async assertDeviceUnavailable(){
    for(const definition of directoryToolDefinitions()){
      const projected=this.tools.find(tool=>tool.name===definition.name);assert.ok(projected);
      assert.deepEqual(projected.inputSchema,definition.inputSchema);
    }
    assert.equal(this.tools.some(tool=>tool.title?.startsWith(FILE_APPEND+' ')),false);
    const response=await this.rpc!.rpc("tools/call",{name:"dx_catalog_search",arguments:{query:FILE_APPEND,limit:20}});
    assert.equal(response.isError,false);assert.ok(Array.isArray(response.structuredContent.tools));
    assert.equal(response.structuredContent.tools.filter((tool:any)=>tool.title===FILE_APPEND).length,0,'real scoped directory must exclude the ungranted device operation');
    this.deviceUnavailableObserved=true;
  }
  async interrupt(){this.release.release();}async respondToTool(){}async close(){this.release.release();await this.rpc?.close();}
}
async function lab(t:TestContext,behavior:(native:Native,signal:AbortSignal)=>Promise<void>,beforeEffect?:()=>Promise<void>,mixed=false,enableAgenda=false){
  const root=mkdtempSync(join(tmpdir(),"dx-host-tool-"));chmodSync(root,0o700);const identity=generateSyntheticIdentity(join(root,"host-id"),"host"),peer=generateSyntheticIdentity(join(root,"peer-id"),"peer");
  const fixtures=join(root,"files");mkdirSync(fixtures,{mode:0o700});const natives:Native[]=[];const created:Native[]=[];let daemon: { stop(): Promise<void> } | undefined;
  const broker=new SyntheticCredentialBroker();broker.put("synthetic-ref",{headers:{authorization:"synthetic-host-tools-secret"},allowedHosts:["upstream.example.test"]});let upstreamCalls=0;
  let processEndingQuarantine=false;
  const services=new HostServices({dataDir:join(root,"host"),enableEngines:true,enableMcp:true,enableDeviceTools:true,enableAgenda,devices:{identity,pollWaitMs:50,receiptTimeoutMs:3000},...(mixed?{upstream:{broker,adapter:{async execute(){upstreamCalls++;return {value:"synthetic-host-tools-secret"};}}}}:{}),makeDriver(engine,options){const n=new Native(engine,options,behavior,opened=>{if(!natives.includes(opened))natives.push(opened);});created.push(n);return n;}});
  t.after(async()=>{for(const n of created)n.release.release();await daemon?.stop();if(processEndingQuarantine)services.store.close();else await services.shutdown({graceMs:5000});rmSync(root,{recursive:true,force:true});});
  const url=await services.startDevices(),trust={hostUrl:url,hostFingerprint:identity.fingerprint,hostCertPem:identity.certPem};
  const offer=services.devicesAdmin.pairingBundle({kind:"pair"});const pending=pairDevice({dataDir:join(root,"peer"),identity:peer,trust,offerId:offer.offerId,code:offer.code,name:"Mac",capabilities:[FILE_APPEND],pollIntervalMs:10});
  await until(()=>services.devicesAdmin.pendingClaims().length===1);services.devicesAdmin.approveClaim(services.devicesAdmin.pendingClaims()[0]!.claimId);const id=(await pending).deviceId;
  const bot=services.store.createBot({name:"Device",profileId:"personal",engine:"claude"}),thread=services.store.createThread(bot.id);
  let upstreamConnection:string|undefined;
  if(mixed){services.gateway!.registerTool({name:"synthetic.read",toolkit:"synthetic",upstreamSlug:"SYNTH_READ",version:"v1",description:"Synthetic",upstreamHost:"upstream.example.test",effect:"read",inputSchema:{type:"object",additionalProperties:false,properties:{},required:[]}});upstreamConnection=services.gateway!.connectAccount({profileId:"personal",toolkit:"synthetic",label:"Synthetic",upstreamAccountRef:"ca_fixture",credentialRef:"synthetic-ref",allowedHosts:["upstream.example.test"]}).id;services.store.setGrant({botId:bot.id,tool:"synthetic.read",destination:upstreamConnection,policy:"allow"});}
  const route=services.deviceRoutesAdmin.bindRoute({botId:bot.id,deviceId:id,tool:FILE_APPEND});
  const app=createHostApp(services.store,{devices:services.devicesHttp!});
  return {get upstreamCalls(){return upstreamCalls;},quarantineTeardown(){processEndingQuarantine=true;},root,fixtures,services,id,bot,thread,route,natives,trust,peer,app,
    grant(policy:"allow"|"ask"|"deny"="allow",expiresAt?:number){return services.devicesAdmin.grant({botId:bot.id,tool:FILE_APPEND,destination:id,policy,...(expiresAt!==undefined?{expiresAt}:{})});},
    async poll(){await new DeviceClient(peer,trust).post("device/poll",{deviceId:id,installationId:services.store.hostId,receipts:[]},1000);},
    async startDaemon(){
      // A separately owned process receives memory identity over inherited IPC.
      const configPath=join(root,"daemon-config.json");
      writeFileSync(configPath,JSON.stringify({dataDir:join(root,"peer"),identityDir:join(root,"peer-id"),trust,fixtures,held:Boolean(beforeEffect)}),{mode:0o600});
      const script=`import {readFileSync} from "node:fs";
        import {receiveMemoryIdentity} from ${JSON.stringify(new URL("./fixtures/memory-identity-channel.js",import.meta.url).href)};
        import {MacDeviceDaemon,createFixtureHandlers,FILE_APPEND} from ${JSON.stringify(import.meta.resolve("@dexter/devices"))};
        const c=JSON.parse(readFileSync(process.argv[1],"utf8"));let release;
        const identity=await receiveMemoryIdentity({keepOpen:true});
        const daemon=new MacDeviceDaemon({dataDir:c.dataDir,identity,trust:c.trust,pollTimeoutMs:1000,
          handlers:createFixtureHandlers({root:c.fixtures,enable:[FILE_APPEND],...(c.held?{beforeEffect:()=>new Promise(done=>{release=done;process.send({kind:"before"});})}:{})})});
        process.on("message",async m=>{if(m.kind==="release")release?.();if(m.kind==="stop"){await daemon.stop();process.disconnect();}});
        daemon.start(()=>{});`;
      const child=spawn(process.execPath,["--input-type=module","-e",script,configPath],{stdio:["ignore","ignore","pipe","ipc"],env:{PATH:"/usr/bin:/bin"}});
      const identityReady=sendMemoryIdentity(child,peer); void identityReady.catch(()=>child.kill("SIGTERM"));
      child.stderr!.resume();
      const exited=new Promise<void>((done,reject)=>{child.once("error",reject);child.once("exit",code=>code===0?done():reject(Error("synthetic_daemon_failed")));});
      void exited.catch(()=>{});
      child.on("message",async(message:any)=>{if(message.kind==="before"){await beforeEffect!();if(child.connected)child.send({kind:"release"});}});
      daemon={async stop(){if(child.connected)child.send({kind:"stop"});await exited;}};
      assert.notEqual(child.pid,process.pid);await identityReady;await until(()=>services.devicesHttp!.get(id).presence==="online");
    },
    start(){return services.runtime!.startTurn(thread.id,{clientRequestId:"synthetic-"+natives.length,content:"trusted"}).turn;},
    async dispatchHTTP(actionId:string){return app.request(`/v1/actions/${actionId}/dispatch`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});}
  };
}

test("device-tools invalid opt-in is refused before any host files or driver/provider work",()=>{
  const root=mkdtempSync(join(tmpdir(),"dx-tools-preflight-")),absent=join(root,"absent");let calls=0;
  try{for(const flags of [{enableDeviceTools:true},{enableDeviceTools:true,enableEngines:true,enableMcp:true},{enableDeviceTools:"yes"}]){assert.throws(()=>new HostServices({dataDir:absent,...flags,makeDriver(){calls++;throw Error("unexpected");}} as never),HostError);assert.equal(existsSync(absent),false);}assert.equal(calls,0);}finally{rmSync(root,{recursive:true,force:true});}
});
test("real MCP/Runtime/TLS: one turn, one canonical finite action, one append and safe replay",async t=>{
  const l=await lab(t,async n=>{await n.call();await n.call();});l.grant();await l.startDaemon();const turn=l.start();assert.equal((await l.services.runtime!.waitForTurn(turn.id)).state,"completed");
  assert.equal(l.services.store.listActions().length,1);const action=l.services.store.listActions()[0]!;assert.equal(action.request.botId,l.bot.id);assert.equal(action.request.threadId,l.thread.id);assert.equal(action.request.destination,l.id);assert.deepEqual(action.request.arguments,{name:"notes.txt",line:"once"});assert.equal(action.requestHash,hashRequest(action.request));
  assert.equal(readFileSync(join(l.fixtures,"notes.txt"),"utf8"),"once\n");assert.deepEqual(l.natives[0]!.receipts.map(x=>x.status),["succeeded","succeeded"]);
  assert.equal((await l.dispatchHTTP(action.id)).status,403);const replay=l.services.runtime!.startTurn(l.thread.id,{clientRequestId:turn.clientRequestId,content:"trusted"});assert.equal(replay.turn.id,turn.id);assert.equal(l.natives.length,1);
  const safe=JSON.stringify(l.natives[0]!.options)+JSON.stringify(l.services.hostToolStatus())+inspect(l.services.hostToolStatus());for(const forbidden of ["PRIVATE KEY",l.peer.fingerprint,l.trust.hostFingerprint])assert.equal(safe.includes(forbidden),false);
});
test("route alone and denied grant publish no MCP aliases or actions",async t=>{
  const l=await lab(t,async n=>{await n.assertDeviceUnavailable();});await l.startDaemon();const one=l.start();assert.equal((await l.services.runtime!.waitForTurn(one.id)).state,"completed");assert.equal(l.services.store.listActions().length,0);
  l.grant("deny");const two=l.start();assert.equal((await l.services.runtime!.waitForTurn(two.id)).state,"completed");assert.equal(l.natives[1]!.deviceUnavailableObserved,true);assert.equal(l.services.store.listActions().length,0);assert.equal(existsSync(join(l.fixtures,"notes.txt")),false);
});
test("ask grant uses same canonical action/hash and HTTP cannot bypass waiting approval",async t=>{
  const waiting=gate();t.after(()=>waiting.release());const l=await lab(t,async n=>{await n.call();await waiting.promise;await n.call();await n.call();});l.grant("ask");await l.startDaemon();const turn=l.start();await until(()=>l.services.store.listActions("awaiting_approval").length===1);
  assert.equal(l.natives[0]!.receipts.length,0,"tool RPC stays pending until exact owner decision");
  const a=l.services.store.listActions()[0]!;assert.equal(a.state,"awaiting_approval");assert.equal((await l.dispatchHTTP(a.id)).status,403);
  const raw=new DatabaseSync(join(l.root,"host","device-tools.sqlite"));raw.prepare("UPDATE device_calls SET action_id=NULL WHERE action_id=?").run(a.id);raw.close();assert.equal((await l.dispatchHTTP(a.id)).status,403,"orphan intent still owns its canonical idempotency key");
  assert.throws(()=>l.services.store.decideAction(a.id,{decision:"allow",requestHash:"f".repeat(64)}),HostError);
  l.services.store.decideAction(a.id,{decision:"allow",requestHash:a.requestHash});waiting.release();assert.equal((await l.services.runtime!.waitForTurn(turn.id)).state,"completed");assert.equal(l.services.store.listActions().length,1);assert.equal(readFileSync(join(l.fixtures,"notes.txt"),"utf8"),"once\n");
  assert.deepEqual(l.natives[0]!.receipts.map(x=>x.status),["succeeded","succeeded","succeeded"]);
});
test("offline preclaim refusal creates no action; same call retries once after authenticated daemon poll",async t=>{
  const waiting=gate();t.after(()=>waiting.release());let refused=false;const l=await lab(t,async n=>{const response=await n.directoryCall();assert.equal(response.isError,true);refused=true;await waiting.promise;await n.directoryCall();});l.grant();const turn=l.start();await until(()=>refused);
  assert.equal(l.services.store.listActions().length,0);await l.startDaemon();waiting.release();assert.equal((await l.services.runtime!.waitForTurn(turn.id)).state,"completed");assert.equal(l.services.store.listActions().length,1);assert.equal(readFileSync(join(l.fixtures,"notes.txt"),"utf8"),"once\n");
});
test("revoked route while turn remains running refuses stale alias without a new effect",async t=>{
  const waiting=gate();t.after(()=>waiting.release());const l=await lab(t,async n=>{await n.call();await waiting.promise;await n.assertRefused("new");});l.grant();await l.startDaemon();const turn=l.start();await until(()=>l.natives[0]?.receipts.length===1);
  l.services.deviceRoutesAdmin.revokeRoute(l.route.id);waiting.release();await l.services.runtime!.waitForTurn(turn.id);assert.equal(l.services.store.listActions().length,1);assert.equal(readFileSync(join(l.fixtures,"notes.txt"),"utf8"),"once\n");
});

test("real certificate rotation requires a fresh explicit grant and advances persisted generation",async t=>{
  const l=await lab(t,async n=>{await n.assertDeviceUnavailable();});const old=l.grant();
  const next=generateSyntheticIdentity(join(l.root,"peer-next"),"peer-next");
  const offer=l.services.devicesAdmin.pairingBundle({kind:"rotate",deviceId:l.id});
  const pending=pairDevice({dataDir:join(l.root,"peer"),identity:next,trust:l.trust,offerId:offer.offerId,code:offer.code,name:"Mac",capabilities:[FILE_APPEND],pollIntervalMs:10});
  await until(()=>l.services.devicesAdmin.pendingClaims().length===1);l.services.devicesAdmin.approveClaim(l.services.devicesAdmin.pendingClaims()[0]!.claimId);await pending;
  const rebound=l.services.deviceRoutesAdmin.bindRoute({botId:l.bot.id,deviceId:l.id,tool:FILE_APPEND});assert.ok(rebound.generation>l.route.generation);assert.notEqual(rebound.fingerprint,l.route.fingerprint);assert.equal(rebound.needsFreshGrant,true);
  const turn=l.start();await l.services.runtime!.waitForTurn(turn.id);assert.equal(l.natives[0]!.deviceUnavailableObserved,true);
  const fresh=l.grant();assert.ok(fresh.revision>old.revision);assert.equal(l.services.deviceRoutesAdmin.listRoutes(l.bot.id)[0]!.needsFreshGrant,false);
});
test("persisted same-fingerprint generation change cannot restore an old route/grant (defensive TEMP database scenario)",async t=>{
  const l=await lab(t,async n=>{await n.assertDeviceUnavailable();});const old=l.grant();
  // Public rotation rejects reused certificates. This simulates a future/legacy same-pin rebind,
  // only in the synthetic registry, and verifies the actual port reads the persisted generation.
  const db=new DatabaseSync(join(l.root,"host","devices.sqlite"));
  db.prepare("UPDATE device_bindings SET generation=generation+1,revision=revision+1 WHERE device_id=?").run(l.id);db.close();
  const rebound=l.services.deviceRoutesAdmin.bindRoute({botId:l.bot.id,deviceId:l.id,tool:FILE_APPEND});
  assert.equal(rebound.fingerprint,l.route.fingerprint);assert.ok(rebound.generation>l.route.generation);assert.equal(rebound.needsFreshGrant,true);
  const turn=l.start();assert.equal((await l.services.runtime!.waitForTurn(turn.id)).state,"completed");
  const fresh=l.grant();assert.ok(fresh.revision>old.revision);assert.equal(l.services.deviceRoutesAdmin.listRoutes(l.bot.id)[0]!.needsFreshGrant,false);
});
test("cancellation after claim records unknown, revokes MCP admission and never repeats a daemon append",async t=>{
  const effect=gate();t.after(()=>effect.release());let entered=false;
  const l=await lab(t,async(n,signal)=>{try{await n.call();}catch(error){if(!signal.aborted)throw error;}},async()=>{entered=true;await effect.promise;});l.grant();await l.startDaemon();const turn=l.start();await until(()=>entered);
  assert.equal(l.services.store.listActions()[0]!.state,"running");l.services.runtime!.cancelTurn(turn.id);
  await l.services.runtime!.waitForTurn(turn.id);await until(()=>l.services.store.listActions()[0]!.state==="unknown");effect.release();
  await until(()=>existsSync(join(l.fixtures,"notes.txt"))&&readFileSync(join(l.fixtures,"notes.txt"),"utf8")==="once\n");
  assert.equal(l.services.store.listActions().length,1);assert.equal((await l.dispatchHTTP(l.services.store.listActions()[0]!.id)).status,403);
  const admin=l.services.deviceRoutesAdmin;await l.services.shutdown({graceMs:5000});assert.throws(()=>admin.listRoutes());assert.throws(()=>l.services.deviceRoutesAdmin,HostError);assert.equal(l.natives[0]!.rpc!.child.exitCode!==null,true);
  const reopened=new HostStore({dataDir:join(l.root,"host")});assert.equal(reopened.listActions()[0]!.state,"unknown");reopened.close();
});

test("denied approval stays on one action and polling never dispatches the append",async t=>{
  const waiting=gate();t.after(()=>waiting.release());const l=await lab(t,async n=>{await n.call();await waiting.promise;await n.call();await n.call();});l.grant("ask");await l.startDaemon();const turn=l.start();await until(()=>l.services.store.listActions("awaiting_approval").length===1);
  assert.equal(l.natives[0]!.receipts.length,0,"pending approval is canonical state, not an early tool receipt");
  const action=l.services.store.listActions()[0]!;l.services.store.decideAction(action.id,{decision:"deny",requestHash:action.requestHash});waiting.release();await l.services.runtime!.waitForTurn(turn.id);
  assert.deepEqual(l.natives[0]!.receipts.map(x=>x.status),["denied","denied","denied"]);assert.equal(l.services.store.listActions().length,1);assert.equal(existsSync(join(l.fixtures,"notes.txt")),false);
});
test("expired combined capability rejects the issued alias while turn is live, without another action",async t=>{
  const waiting=gate();t.after(()=>waiting.release());const l=await lab(t,async n=>{await n.call();await waiting.promise;await n.assertRefused("after-expiry");});l.grant();await l.startDaemon();const turn=l.start();await until(()=>l.natives[0]?.receipts.length===1);
  const now=l.services.store.now.bind(l.services.store);l.services.store.now=()=>now()+86_400_000;t.after(()=>{l.services.store.now=now;});waiting.release();await l.services.runtime!.waitForTurn(turn.id);l.services.store.now=now;
  assert.equal(l.services.store.listActions().length,1);assert.equal(readFileSync(join(l.fixtures,"notes.txt"),"utf8"),"once\n");
});
test("revoked paired pin invalidates the live-turn alias and grants do not return",async t=>{
  const waiting=gate();t.after(()=>waiting.release());const l=await lab(t,async n=>{await n.call();await waiting.promise;await n.assertRefused("after-revoke");});l.grant();await l.startDaemon();const turn=l.start();await until(()=>l.natives[0]?.receipts.length===1);
  const response=await l.app.request(`/v1/devices/${l.id}/revoke`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});assert.equal(response.status,200);waiting.release();await l.services.runtime!.waitForTurn(turn.id);
  assert.equal(l.services.devicesHttp!.get(l.id).paired,false);assert.throws(()=>l.grant(),HostError);assert.equal(l.services.store.listActions().length,1);assert.equal(readFileSync(join(l.fixtures,"notes.txt"),"utf8"),"once\n");
});

test("rejected owned Surface cleanup permanently quarantines writer and blocks retained administration",async t=>{
  const l=await lab(t,async n=>{await n.call();});l.grant();await l.startDaemon();const turn=l.start();await l.services.runtime!.waitForTurn(turn.id);
  const admin=l.services.deviceRoutesAdmin, original=DeviceTurnSurface.prototype.close;let closes=0;
  DeviceTurnSurface.prototype.close=async function(){closes++;await original.call(this);throw Error("synthetic_post_cleanup_rejection");};
  try{await assert.rejects(l.services.shutdown({graceMs:3000}));await assert.rejects(l.services.shutdown({graceMs:3000}));assert.equal(closes,1);
    assert.throws(()=>new HostStore({dataDir:join(l.root,"host")}),e=>e instanceof HostError&&e.code==="host_locked");assert.throws(()=>admin.listRoutes());assert.throws(()=>l.services.deviceRoutesAdmin,HostError);
    assert.equal(l.natives[0]!.rpc!.child.exitCode!==null,true);assert.equal(readFileSync(join(l.fixtures,"notes.txt"),"utf8"),"once\n");
  }finally{DeviceTurnSurface.prototype.close=original;l.quarantineTeardown();}
});

test("one MCP endpoint reserves call IDs across real device and gateway surfaces before either effect",async t=>{
  const l=await lab(t,async n=>{await n.directoryCall("global");await n.assertRefused("global",{},"synthetic.read");const response=await n.directoryCall("separate",{},"synthetic.read");assert.equal(response.isError,false);assert.equal(JSON.stringify(response).includes("synthetic-host-tools-secret"),false);},undefined,true);
  l.grant();await l.startDaemon();const turn=l.start();assert.equal((await l.services.runtime!.waitForTurn(turn.id)).state,"completed");assert.equal(l.upstreamCalls,1);assert.equal(l.services.store.listActions().length,2);assert.equal(readFileSync(join(l.fixtures,"notes.txt"),"utf8"),"once\n");
});

// This regression also exercises projection through the real bridge, rather than only the child API.
test("successful device replay retains succeeded status but withholds body after explicit grant revocation",async t=>{
  const waiting=gate();t.after(()=>waiting.release());const l=await lab(t,async n=>{
    await n.call();await waiting.promise;const replay=await n.call();
    assert.equal(replay.isError,false);assert.equal(replay.structuredContent.status,"succeeded");
    assert.equal(replay.structuredContent.result,null);
  });l.grant();await l.startDaemon();const turn=l.start();await until(()=>l.natives[0]?.receipts.length===1);
  l.grant("deny");waiting.release();assert.equal((await l.services.runtime!.waitForTurn(turn.id)).state,"completed");
  assert.deepEqual(l.natives[0]!.receipts.map(r=>r.status),["succeeded","succeeded"]);
  assert.equal(l.services.store.listActions().length,1);assert.equal(l.services.store.listActions()[0]!.state,"succeeded");
  assert.equal(readFileSync(join(l.fixtures,"notes.txt"),"utf8"),"once\n");
});

test("failed runtime drain keeps writer and permanently closes retained device administration before auxiliary cleanup",async t=>{
  const waiting=gate();t.after(()=>waiting.release());let entered=false;
  const l=await lab(t,async()=>{entered=true;await waiting.promise;});l.grant();await l.startDaemon();const turn=l.start();await until(()=>entered);
  const routes=l.services.deviceRoutesAdmin,devices=l.services.devicesAdmin;
  await assert.rejects(l.services.shutdown({graceMs:10}));
  assert.throws(()=>routes.bindRoute({botId:l.bot.id,deviceId:l.id,tool:FILE_APPEND}));
  assert.throws(()=>devices.grant({botId:l.bot.id,tool:FILE_APPEND,destination:l.id,policy:"allow"}));
  assert.throws(()=>l.services.deviceRoutesAdmin,HostError);
  assert.throws(()=>new HostStore({dataDir:join(l.root,"host")}),e=>e instanceof HostError&&e.code==="host_locked");
  assert.equal(l.services.store.listActions().length,0);waiting.release();await l.services.runtime!.waitForTurn(turn.id);
  await l.services.shutdown({graceMs:5000});const reopened=new HostStore({dataDir:join(l.root,"host")});reopened.close();
});

for(const rejected of [false,true])test(`late constructor rollback disposes Agenda/Surface/Device synchronously; Surface rejection retains writer=${rejected}`,()=>{
  const root=mkdtempSync(join(tmpdir(),"dx-tools-rollback-")),dataDir=join(root,"host"),identity=generateSyntheticIdentity(join(root,"identity"),"host");
  const sequence:string[]=[];let store:HostStore|undefined;let effects=0;
  const bind=ManagedAppsRuntime.prototype.bind,agenda=AgendaHostConsumer.prototype.disposeUnstarted,
    surface=DeviceTurnSurface.prototype.disposeUnstarted,devices=DeviceServices.prototype.disposeUnstarted,close=HostStore.prototype.close;
  ManagedAppsRuntime.prototype.bind=function(s){store=s as HostStore;assert.equal(existsSync(join(dataDir,"agenda.sqlite")),true);sequence.push("bind");throw Error("synthetic_late_bind");};
  AgendaHostConsumer.prototype.disposeUnstarted=function(){sequence.push("agenda");agenda.call(this);};
  DeviceTurnSurface.prototype.disposeUnstarted=function(){sequence.push("surface");surface.call(this);if(rejected)throw Error("synthetic_surface_dispose");};
  DeviceServices.prototype.disposeUnstarted=function(){sequence.push("devices");devices.call(this);};
  HostStore.prototype.close=function(){sequence.push("store");close.call(this);};
  const external=async()=>{effects++;throw Error("unexpected_external_work");};
  try{
    assert.throws(()=>new HostServices({dataDir,enableEngines:true,enableMcp:true,enableDeviceTools:true,enableAgenda:true,devices:{identity},
      managedApps:{provider:{catalog:external,provision:external,lookup:external,account:external},credentialRef:"synthetic-ref",
        broker:{acquire(){effects++;return null;},secretValues(){return [];}},fetch:external,disposeOwnedBroker:external}}),
        error=>rejected ? error instanceof AggregateError && error.cause instanceof Error
          && error.cause.message==="synthetic_late_bind" && error.errors[0]?.message==="synthetic_surface_dispose"
          : error instanceof Error && error.message==="synthetic_late_bind");
    assert.deepEqual(sequence,rejected?["bind","agenda","surface"]:["bind","agenda","surface","devices","store"]);assert.equal(effects,0);
    if(rejected)assert.throws(()=>new HostStore({dataDir}),e=>e instanceof HostError&&e.code==="host_locked");
    else{const reopened=new HostStore({dataDir});reopened.close();}
  }finally{ManagedAppsRuntime.prototype.bind=bind;AgendaHostConsumer.prototype.disposeUnstarted=agenda;
    DeviceTurnSurface.prototype.disposeUnstarted=surface;DeviceServices.prototype.disposeUnstarted=devices;HostStore.prototype.close=close;
    // Quarantined fixture only; explicit teardown happens after writer-retention assertions.
    if(rejected)store?.close();rmSync(root,{recursive:true,force:true});}
});


test("rejected Agenda cleanup tries later auxiliaries in order, closes paired TLS polls and caches quarantine",async t=>{
  const sequence:string[]=[];
  const agenda=AgendaHostConsumer.prototype.close,devices=DeviceServices.prototype.close,
    surface=DeviceTurnSurface.prototype.close;
  const start=DeviceServices.prototype.start;let owned:InstanceType<typeof DeviceServices>|undefined;
  DeviceServices.prototype.start=function(){owned=this;return start.call(this);};
  const l=await lab(t,async()=>{},undefined,false,true);DeviceServices.prototype.start=start;
  AgendaHostConsumer.prototype.close=async function(){sequence.push("agenda");await agenda.call(this);throw Error("synthetic_agenda_close_rejection");};
  DeviceServices.prototype.close=async function(){sequence.push("devices");await devices.call(this);};
  DeviceTurnSurface.prototype.close=async function(){sequence.push("surface");await surface.call(this);throw Error("synthetic_surface_close_rejection");};
  const gateway=l.services.gateway!,gatewayClose=gateway.close;
  gateway.close=function(){sequence.push("gateway");gatewayClose.call(this);};
  try{
    await l.poll(); // A paired, authenticated poll is served before shutdown.
    await assert.rejects(l.services.shutdown({graceMs:3000}));
    assert.deepEqual(sequence,["agenda","devices","surface","gateway"]);
    assert.equal(l.services.devicesHttp!.status().listening,false);
    await assert.rejects(l.poll(),"paired TLS poll must refuse after Agenda cleanup rejection");
    assert.throws(()=>new HostStore({dataDir:join(l.root,"host")}),e=>e instanceof HostError&&e.code==="host_locked");
    await assert.rejects(l.services.shutdown({graceMs:3000}));
    assert.deepEqual(sequence,["agenda","devices","surface","gateway"],"no rejected close may be retried");
    assert.throws(()=>l.services.devicesAdmin,e=>e instanceof HostError&&e.code==="conflict");
  }finally{
    AgendaHostConsumer.prototype.close=agenda;DeviceServices.prototype.close=devices;
    DeviceTurnSurface.prototype.close=surface;gateway.close=gatewayClose;l.quarantineTeardown();
    // Fixture-only fallback also prevents a broken mutant leaking its real TLS listener.
    await owned?.close().catch(()=>{});
  }
});
