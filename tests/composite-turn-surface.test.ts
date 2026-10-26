import { gatewayToolAlias } from "@dexter/gateway";
import { MCP_DIRECTORY_NAMES } from "./fixtures/mcp-directory-client.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { CapabilityGateway, GatewayError, GatewayMcpBridge, prepareMcpTurn, SyntheticCredentialBroker, type CapabilityScope, type GatewayCallResult, type TurnToolSurface, type ToolView } from "@dexter/gateway";
import { ConversationRuntime, HostStore, type RuntimeDriver } from "@dexter/hub";
import { operationFor } from "@dexter/devices";
import { DeviceTurnSurface, type DeviceToolsPort } from "../packages/cli/src/device-turn-surface.js";
import { CompositeTurnSurface } from "../packages/cli/src/turn-surface.js";

const view:ToolView={name:"fixture.read",description:"Synthetic",effect:"read",inputSchema:{type:"object",additionalProperties:false,required:[],properties:{}},connectionId:"conn_fixture",connectionLabel:"Fixture",requiresApproval:false};
const scope:CapabilityScope={installationId:"host_fixture",ownerId:"owner_fixture",profileId:"profile_fixture",botId:"bot_fixture",threadId:"thread_fixture",turnId:"turn_fixture",expiresAt:1_000_000};
function gate(){let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return{promise,release};}
class Child implements TurnToolSurface {
  readonly tokens=new Set<string>();issued=0;revoked=0;calls=0;closes=0;failIssue=false;badScope=false;views=[structuredClone(view)];wait:ReturnType<typeof gate>|null=null;closeWait:ReturnType<typeof gate>|null=null;closeFails=false;
  issueCapability(){if(this.failIssue)throw new Error("synthetic issue fault");const token=randomBytes(32).toString("base64url");this.tokens.add(token);this.issued++;return {token,scope:Object.freeze({...scope,...(this.badScope?{botId:"foreign"}:{})})};}
  listTools(token:string){if(!this.tokens.has(token))throw new GatewayError("unauthorized","refused");return structuredClone(this.views);}
  lastResult:GatewayCallResult|null=null;
  async call(token:string){this.listTools(token);this.calls++;await this.wait?.promise;return this.lastResult={actionId:"act_fixture",status:"succeeded",requestHash:"a".repeat(64),reason:null,result:{ok:true}} satisfies GatewayCallResult;}
  revokeCapability(token:string){if(this.tokens.delete(token))this.revoked++;}
  ownsRoute(id:string){return id.startsWith("dvr_");}
  reserveCompositeCall(){}
  async close(){this.closes++;await this.closeWait?.promise;if(this.closeFails)throw new Error("synthetic cleanup failed");}
}
const code=(value:string)=>(e:unknown)=>e instanceof GatewayError&&e.code===value;

test("issue failure or wrong child principal revokes all successfully issued children",()=>{
  const gateway=new Child(),devices=new Child();devices.failIssue=true;const composite=new CompositeTurnSurface(gateway,devices);
  assert.throws(()=>composite.issueCapability({turnId:scope.turnId}),code("unavailable"));assert.equal(gateway.tokens.size,0);assert.equal(gateway.revoked,1);
  devices.failIssue=false;devices.badScope=true;assert.throws(()=>composite.issueCapability({turnId:scope.turnId}),code("unauthorized"));assert.equal(gateway.tokens.size,0);assert.equal(devices.tokens.size,0);assert.equal(composite.status().capabilities,0);
});

test("catalog collision/limit revokes both; aliases route only to their trusted surface",async()=>{
  const gateway=new Child(),devices=new Child(),composite=new CompositeTurnSurface(gateway,devices);assert.throws(()=>composite.issueCapability({turnId:scope.turnId}),code("conflict"));assert.equal(gateway.tokens.size+devices.tokens.size,0);
  devices.views=[{...view,name:"mac.fixture.read",connectionId:"dvr_fixture"}];const {token,scope:bound}=composite.issueCapability({turnId:scope.turnId});assert.equal(Object.isFrozen(bound),true);assert.equal(composite.listTools(token).length,2);
  await composite.call(token,{connectionId:"dvr_fixture"});assert.equal(devices.calls,1);assert.equal(gateway.calls,0);await composite.call(token,{connectionId:"conn_fixture"});assert.equal(gateway.calls,1);
  composite.revokeCapability(token);assert.equal(gateway.tokens.size+devices.tokens.size,0);await assert.rejects(composite.call(token,{}),code("unauthorized"));
  const small=new CompositeTurnSurface(gateway,devices,{maxCatalogTools:1});assert.throws(()=>small.issueCapability({turnId:scope.turnId}),code("unavailable"));assert.equal(gateway.tokens.size+devices.tokens.size,0);
});

test("a failed child revoke cannot skip revoking the other; tokens die before any component hook",()=>{
  const gateway=new Child(),devices=new Child();devices.views=[{...view,name:"mac.fixture.read",connectionId:"dvr_fixture"}];const composite=new CompositeTurnSurface(gateway,devices);const {token}=composite.issueCapability({turnId:scope.turnId});
  const revoke=gateway.revokeCapability.bind(gateway);gateway.revokeCapability=t=>{revoke(t);throw new Error("synthetic revoke hook error");};composite.revokeCapability(token);assert.equal(devices.tokens.size,0);assert.throws(()=>composite.listTools(token),code("unauthorized"));
});

test("close waits full noncooperative calls and both cleanup promises even if one rejects",async()=>{
  const gateway=new Child(),devices=new Child();devices.views=[{...view,name:"mac.fixture.read",connectionId:"dvr_fixture"}];const composite=new CompositeTurnSurface(gateway,devices);const {token}=composite.issueCapability({turnId:scope.turnId});
  gateway.wait=gate();devices.closeWait=gate();gateway.closeFails=true;const call=composite.call(token,{connectionId:"conn_fixture"});const observed=call.catch(e=>e);const closing=composite.close();let ended=false;void closing.then(()=>{ended=true;},()=>{ended=true;});
  await new Promise(r=>setTimeout(r,15));assert.equal(ended,false);assert.equal(gateway.closes+devices.closes,0);assert.equal(gateway.tokens.size+devices.tokens.size,0);
  gateway.wait.release();await observed;await new Promise(r=>setTimeout(r,15));assert.equal(gateway.closes,1);assert.equal(devices.closes,1);assert.equal(ended,false);devices.closeWait.release();await assert.rejects(closing,code("unavailable"));assert.equal(composite.status().closed,false);
});

function fixture(t:{after(fn:()=>void|Promise<void>):void},withDevices=false){
 const dir=mkdtempSync(join(tmpdir(),"dexter-composite-")),store=new HostStore({dataDir:dir});const broker=new SyntheticCredentialBroker();broker.put("fixture",{headers:{},allowedHosts:["fixture.example.test"]});let effects=0;
 const gateway=new CapabilityGateway({store,broker,adapter:{async execute(){effects++;return{ok:true};}}});
 const tool={name:"fixture.read",toolkit:"fixture",upstreamSlug:"FIXTURE_READ",version:"v1",description:"Synthetic",upstreamHost:"fixture.example.test",effect:"read",destinationArgument:null,inputSchema:view.inputSchema};gateway.registerTool(tool);
 const bot=store.createBot({name:"Synthetic",profileId:"fixture",engine:"claude"}),thread=store.createThread(bot.id),connection=gateway.connectAccount({profileId:"fixture",toolkit:"fixture",label:"Synthetic",upstreamAccountRef:"fixture_account",credentialRef:"fixture",allowedHosts:["fixture.example.test"]});store.setGrant({botId:bot.id,tool:tool.name,destination:connection.id,policy:"allow"});
 let deviceEffects=0;let devices:DeviceTurnSurface|undefined;let port:DeviceToolsPort|undefined;
 if(withDevices){
  const op=operationFor("mac.process.probe"),operation=op;
  const d=store.registerDevice({name:"Synthetic Mac",platform:"macos",capabilities:[op.tool]});
  const pin={installationId:store.hostId,ownerId:store.ownerId,deviceId:d.id,fingerprint:"c".repeat(64),generation:1,revision:1,status:"active" as const};
  port={installationId:store.hostId,ownerId:store.ownerId,snapshot:()=>pin,authenticatedPresence:()=>"online",operation:()=>operation,async dispatchBound(id,context){const a=store.claimAction(id);if(!store.withWriterLease(()=>context.guard(a,pin)))return store.markUnknown(id,"executor_error");deviceEffects++;return store.completeAction(id,{probe:true});}};devices=new DeviceTurnSurface(store,port);
  devices.admin.bindRoute({botId:bot.id,deviceId:d.id,tool:op.tool});store.setGrant({botId:bot.id,tool:op.tool,destination:d.id,policy:"allow"});
 }
 const extraCleanup:(()=>Promise<void>)[]=[];const composite=new CompositeTurnSurface(gateway,devices);t.after(async()=>{for(const cleanup of extraCleanup)await cleanup();await composite.close();store.close();rmSync(dir,{recursive:true,force:true});});return{store,gateway,composite,bot,thread,connection,broker,port,cleanup:(fn:()=>Promise<void>)=>extraCleanup.push(fn),effects:()=>effects,deviceEffects:()=>deviceEffects};
}

test("without devices the actual gateway catalog and action semantics remain unchanged",async t=>{
 const s=fixture(t),turn=s.store.createTurn(s.thread.id,{clientRequestId:"fixture",content:"synthetic"}).turn;s.store.claimNextTurn(s.thread.id);
 const baseline=s.gateway.issueCapability({turnId:turn.id}),composed=s.composite.issueCapability({turnId:turn.id});assert.deepEqual(s.composite.listTools(composed.token),s.gateway.listTools(baseline.token));
 const input={tool:view.name,connectionId:s.connection.id,callId:"once",arguments:{}};assert.equal((await s.composite.call(composed.token,input)).status,"succeeded");assert.equal((await s.composite.call(composed.token,input)).status,"succeeded");assert.equal(s.effects(),1);assert.equal(s.store.listActions().length,1);s.gateway.revokeCapability(baseline.token);
});

test("actual MCP bridge passes only alias-bound target; callId retry is one canonical action",async t=>{
 const s=fixture(t,true),turn=s.store.createTurn(s.thread.id,{clientRequestId:"fixture",content:"synthetic"}).turn;s.store.claimNextTurn(s.thread.id);const cap=s.composite.issueCapability({turnId:turn.id});const input=new PassThrough(),output=new PassThrough();
 const lines:Record<string,unknown>[]=[];let fragments="";output.on("data",chunk=>{fragments+=chunk.toString();for(let at;(at=fragments.indexOf("\n"))>=0;){lines.push(JSON.parse(fragments.slice(0,at)));fragments=fragments.slice(at+1);}});
 const bridge=new GatewayMcpBridge({gateway:s.composite,capability:cap.token,input,output});t.after(async()=>{bridge.close();await bridge.whenDrained();});
 const rpc=async(id:number,method:string,params:unknown={})=>{input.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");for(let i=0;i<200&&!lines.some(l=>l.id===id);i++)await new Promise(r=>setTimeout(r,2));return lines.find(l=>l.id===id)!;};
 await rpc(1,"initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"synthetic",version:"1"}});input.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})+"\n");
 const list=await rpc(2,"tools/list"),all=(list.result as {tools:{name:string}[]}).tools;assert.deepEqual(all.filter(t=>MCP_DIRECTORY_NAMES.includes(t.name)).map(t=>t.name),MCP_DIRECTORY_NAMES);const aliases=all.filter(t=>/^dx_[a-f0-9]{24}$/.test(t.name));assert.equal(aliases.length,2);const alias=gatewayToolAlias({name:"fixture.read",connectionId:s.connection.id});assert.ok(aliases.some(t=>t.name===alias));const deviceAlias=aliases.find(t=>t.name!==alias)!.name;
 const params={name:alias,arguments:{callId:"once",input:{}}};await rpc(3,"tools/call",params);await rpc(4,"tools/call",params);assert.equal(s.effects(),1);assert.equal(s.store.listActions().length,1);
 const refused=await rpc(5,"tools/call",{...params,arguments:{callId:"other",input:{},connectionId:"foreign"}});assert.ok(refused.error);assert.equal(s.effects(),1);await rpc(6,"tools/call",{name:deviceAlias,arguments:{callId:"device",input:{}}});await rpc(7,"tools/call",{name:deviceAlias,arguments:{callId:"device",input:{}}});assert.equal(s.deviceEffects(),1);assert.equal(s.store.listActions().length,2);bridge.close();await bridge.whenDrained();
});

test("actual runtime owns running turn and teardown; surface never creates another principal",async t=>{
 const s=fixture(t);let receipt:GatewayCallResult|undefined;let token:string|undefined;
 const driver:RuntimeDriver={id:"claude",async open(threadId){return{threadId,nativeCursor:randomUUID()};},async *turn(session,turnId,_input,signal){const issued=s.composite.issueCapability({turnId});token=issued.token;const tool=s.composite.listTools(token)[0]!;receipt=await s.composite.call(token,{tool:tool.name,connectionId:tool.connectionId,callId:"runtime",arguments:{}},{signal});yield{type:"text.delta",threadId:session.threadId,turnId,text:"synthetic result"};yield{type:"turn.completed",threadId:session.threadId,turnId,usage:null};},async respondToTool(){},async interrupt(){if(token)s.composite.revokeCapability(token);},async close(){if(token)s.composite.revokeCapability(token);}};
 const runtime=new ConversationRuntime({store:s.store,drivers:[driver]});const turn=runtime.startTurn(s.thread.id,{clientRequestId:"runtime",content:"synthetic"}).turn;
 for(let i=0;i<200&&s.store.getTurn(turn.id).state!=="completed";i++)await new Promise(r=>setTimeout(r,2));assert.equal(s.store.getTurn(turn.id).state,"completed");assert.equal(receipt?.status,"succeeded");assert.equal(s.store.getAction(receipt!.actionId).request.threadId,s.thread.id);assert.equal(s.effects(),1);await runtime.shutdown({closeStore:false});
});


test("real one-turn Unix lease and Node wrapper compose both surfaces without token-bearing configuration",async t=>{
 const s=fixture(t,true),turn=s.store.createTurn(s.thread.id,{clientRequestId:"wrapper",content:"synthetic"}).turn;s.store.claimNextTurn(s.thread.id);
 const lease=await prepareMcpTurn({store:s.store,gateway:s.composite,turnId:turn.id,wrapperPath:resolve("packages/cli/dist/mcp-stdio.js")});
 const child=spawn(lease.nativeServer.command,[...lease.nativeServer.args],{env:{PATH:"/usr/bin:/bin"},stdio:"pipe",shell:false});
 let stderr="",buffer="";const messages:Record<string,unknown>[]=[];child.stderr.on("data",b=>{stderr+=b.toString();});child.stdin.on("error",()=>{});
 child.stdout.on("data",b=>{buffer+=b.toString();for(let i;(i=buffer.indexOf("\n"))>=0;){messages.push(JSON.parse(buffer.slice(0,i)));buffer=buffer.slice(i+1);}});
 const exited=new Promise<number|null>(r=>child.once("close",r));
 const bounded=async<T>(p:Promise<T>):Promise<T>=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error("fixture deadline")),4000);})]);}finally{clearTimeout(timer);}};
 t.after(async()=>{lease.stop();child.kill("SIGTERM");try{await bounded(exited);}catch{child.kill("SIGKILL");await bounded(exited);}await bounded(lease.whenDrained());});
 const send=(v:unknown)=>child.stdin.write(JSON.stringify(v)+"\n");
 const rpc=async(id:number,method:string,params:unknown={})=>{send({jsonrpc:"2.0",id,method,params});return bounded((async()=>{for(let i=0;i<1500;i++){const message=messages.find(m=>m.id===id);if(message)return message;await new Promise(r=>setTimeout(r,2));}throw new Error("missing fixture response");})());};
 const init=await rpc(1,"initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"fixture",version:"1"}});assert.ok(init.result);send({jsonrpc:"2.0",method:"notifications/initialized"});
 const list=await rpc(2,"tools/list"),all=(list.result as {tools:{name:string}[]}).tools;assert.deepEqual(all.filter(t=>MCP_DIRECTORY_NAMES.includes(t.name)).map(t=>t.name),MCP_DIRECTORY_NAMES);const aliases=all.filter(t=>/^dx_[a-f0-9]{24}$/.test(t.name));assert.equal(aliases.length,2);assert.deepEqual(new Set(lease.allowedMcpTools),new Set([...MCP_DIRECTORY_NAMES,...aliases.map(t=>t.name)].map(name=>`mcp__dexter_gateway__${name}`)));
 for(const [n,alias] of aliases.entries()){const params={name:alias.name,arguments:{callId:"wrapper-"+n,input:{}}};const first=await rpc(3+n*2,"tools/call",params);assert.equal((first.result as {structuredContent:GatewayCallResult}).structuredContent.status,"succeeded");await rpc(4+n*2,"tools/call",params);}
 assert.equal(s.effects(),1);assert.equal(s.deviceEffects(),1);assert.equal(s.store.listActions().length,2);assert.equal(stderr,"");
 child.stdin.end();assert.equal(await bounded(exited),0);await bounded(lease.whenDrained());assert.equal(s.composite.status().capabilities,0);
});


test("global callId reservation survives restart and rejects cross-surface or changed-body effects",async t=>{
 const s=fixture(t,true),turn=s.store.createTurn(s.thread.id,{clientRequestId:"global",content:"synthetic"}).turn;s.store.claimNextTurn(s.thread.id);let cap=s.composite.issueCapability({turnId:turn.id});
 const device=s.composite.listTools(cap.token).find(v=>v.name==="mac.process.probe")!;const gw={tool:view.name,connectionId:s.connection.id,callId:"global",arguments:{}};const dv={tool:device.name,connectionId:device.connectionId,callId:"global",arguments:{}};
 assert.equal((await s.composite.call(cap.token,gw)).status,"succeeded");await assert.rejects(s.composite.call(cap.token,dv),code("conflict"));assert.equal(s.store.listActions().length,1);
 const originalCall=s.gateway.call.bind(s.gateway);s.gateway.call=async()=>{throw new GatewayError("unavailable","synthetic crash after reservation");};
 await assert.rejects(s.composite.call(cap.token,{...gw,callId:"reserved"}),code("unavailable"));s.gateway.call=originalCall;assert.equal(s.store.listActions().length,1);await s.composite.close();
 let restartedEffects=0;const gateway=new CapabilityGateway({store:s.store,broker:s.broker,adapter:{async execute(){restartedEffects++;return {ok:true};}}}),devices=new DeviceTurnSurface(s.store,s.port!),composite=new CompositeTurnSurface(gateway,devices);s.cleanup(()=>composite.close());cap=composite.issueCapability({turnId:turn.id});
 assert.equal((await composite.call(cap.token,gw)).status,"succeeded");await assert.rejects(composite.call(cap.token,dv),code("conflict"));await assert.rejects(composite.call(cap.token,{...gw,arguments:{changed:true}}),code("conflict"));assert.equal(restartedEffects,0);assert.equal(s.deviceEffects(),0);
 await assert.rejects(composite.call(cap.token,{...dv,callId:"reserved"}),code("conflict"));assert.equal((await composite.call(cap.token,{...gw,callId:"reserved"})).status,"succeeded");assert.equal((await composite.call(cap.token,{...gw,callId:"reserved"})).status,"succeeded");assert.equal(restartedEffects,1);
 assert.equal((await composite.call(cap.token,{...dv,callId:"new-device"})).status,"succeeded");await assert.rejects(composite.call(cap.token,{...gw,callId:"new-device"}),code("conflict"));assert.equal(s.deviceEffects(),1);
 // Invalid aliases do not consume a callId; a valid alias with invalid schema conservatively does.
 await assert.rejects(composite.call(cap.token,{...gw,connectionId:"foreign",callId:"not-poisoned"}),code("forbidden"));assert.equal((await composite.call(cap.token,{...gw,callId:"not-poisoned"})).status,"succeeded");
 await assert.rejects(composite.call(cap.token,{...gw,callId:"invalid-schema",arguments:{unexpected:true}}),code("invalid_input"));await assert.rejects(composite.call(cap.token,{...gw,callId:"invalid-schema"}),code("conflict"));assert.equal(s.store.listActions().length,4);await composite.close();
});


// A completed child outcome is never rewritten by a post-await catalog check (G3 semantics without devices).
for (const [late,withDevices,target] of [["ttl",false,"gateway"],["growth",false,"gateway"],["ttl",true,"gateway"],["growth",true,"gateway"],["collision",true,"gateway"],["outage",true,"gateway"],["outage",true,"device"],["ttl",true,"device"]] as const)
test(`late ${late} after a ${target} call${withDevices?" with devices":" without devices"} returns the exact child result`,async()=>{
  const gateway=new Child(),devices=withDevices?new Child():undefined;if(devices)devices.views=[{...view,name:"mac.fixture.read",connectionId:"dvr_fixture"}];
  const composite=new CompositeTurnSurface(gateway,devices,{maxCatalogTools:2}),{token}=composite.issueCapability({turnId:scope.turnId});
  const owner=target==="device"?devices!:gateway,other=target==="device"?gateway:(devices??gateway);owner.wait=gate();
  const pending=composite.call(token,{connectionId:target==="device"?"dvr_fixture":"conn_fixture"});
  if(late==="ttl")owner.tokens.clear();
  else if(late==="growth")other.views.push({...view,name:"fixture.more",connectionId:"conn_more"},{...view,name:"fixture.most",connectionId:"conn_most"});
  else if(late==="collision")other.views.push(structuredClone(view));
  else other.listTools=()=>{throw Object.assign(new Error("synthetic writer loss"),{code:"host_locked"});};
  owner.wait.release();const out=await pending;assert.equal(out,owner.lastResult);assert.equal(out.status,"succeeded");assert.deepEqual(out.result,{ok:true});
  // Future admission still applies pre-admission catalog/capability validation.
  const calls=gateway.calls+(devices?.calls??0);await assert.rejects(composite.call(token,{connectionId:"conn_fixture"}));assert.equal(gateway.calls+(devices?.calls??0),calls);
});

test("composed device child withholds a body after lost grant while the gateway effect stays positive",async t=>{
 const s=fixture(t,true),turn=s.store.createTurn(s.thread.id,{clientRequestId:"scrub",content:"synthetic"}).turn;s.store.claimNextTurn(s.thread.id);const cap=s.composite.issueCapability({turnId:turn.id});
 s.port!.dispatchBound=async(id,context)=>{const a=s.store.claimAction(id);if(!s.store.withWriterLease(()=>context.guard(a,s.port!.snapshot(a.request.destination)!)))return s.store.markUnknown(id,"executor_error");const done=s.store.completeAction(id,{probe:"fixture-body"});s.store.setGrant({botId:a.request.botId,tool:a.request.tool,destination:a.request.destination,policy:"allow"});return done;};
 const views=s.composite.listTools(cap.token),device=views.find(v=>v.name==="mac.process.probe")!;
 const gw=await s.composite.call(cap.token,{tool:view.name,connectionId:s.connection.id,callId:"gw",arguments:{}});assert.equal(gw.status,"succeeded");assert.notEqual(gw.result,null);assert.equal(s.effects(),1);
 const dv={tool:device.name,connectionId:device.connectionId,callId:"dv",arguments:{}},out=await s.composite.call(cap.token,dv),action=s.store.getAction(out.actionId);
 assert.equal(out.status,"succeeded");assert.equal(out.result,null);assert.equal(out.requestHash,action.requestHash);assert.equal(action.state,"succeeded");assert.deepEqual(action.result,{probe:"fixture-body"});
 assert.equal((await s.composite.call(cap.token,dv)).result,null);assert.equal(s.store.listActions().length,2);
});
