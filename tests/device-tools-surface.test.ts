import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Action, JsonValue } from "@dexter/contracts";
import { canonicalJson, HostError, HostStore } from "@dexter/hub";
import { GatewayError } from "@dexter/gateway";
import { operationFor } from "@dexter/devices";
import { DeviceTurnSurface, DeviceDispatchPreflightError, type DeviceToolsPort, type DevicePinSnapshot, type DeviceToolOperation } from "../packages/cli/src/device-turn-surface.js";

const tool = "mac.file.append";
const args = { name:"fixture.txt",line:"synthetic" };
function descriptor(overrides: { version?: string; effect?: "read" | "write"; inputSchema?: DeviceToolOperation["inputSchema"] } = {}): DeviceToolOperation {
  const canonical = operationFor(tool), base = { version:overrides.version ?? "v1",tool,effect:overrides.effect ?? canonical.effect,description:canonical.description,inputSchema:overrides.inputSchema ?? canonical.inputSchema };
  return { ...base,schemaHash:createHash("sha256").update(canonicalJson(base as unknown as JsonValue)).digest("hex"),validate:a=>canonical.validate(a) };
}
const operation = (version = "v1"): DeviceToolOperation => descriptor({ version });
function gate() { let release!:()=>void; const promise = new Promise<void>(r=>{release=r;});return { promise,release }; }
const code = (value:string) => (e:unknown) => e instanceof GatewayError && e.code === value;
function setup(t: { after(fn:()=>void|Promise<void>):void },options: {approvalTtlMs?:number}={}) {
  let quarantined=false;
  const dir=mkdtempSync(join(tmpdir(),"dexter-device-tools-"));let now=1_000_000;
  const store=new HostStore({dataDir:dir,clock:()=>now,...options});
  const bot=store.createBot({name:"Synthetic",profileId:"fixture",engine:"claude"});const other=store.createBot({name:"Other",profileId:"fixture",engine:"claude"});
  const device=store.registerDevice({name:"Synthetic Mac",platform:"macos",capabilities:[tool]});
  const thread=store.createThread(bot.id), turn=store.createTurn(thread.id,{clientRequestId:"fixture",content:"synthetic"}).turn;store.claimNextTurn(thread.id);
  let pin:DevicePinSnapshot={installationId:store.hostId,ownerId:store.ownerId,deviceId:device.id,fingerprint:"a".repeat(64),generation:1,revision:1,status:"active"};
  let presence:"online"|"stale"|"revoked"="online", op=operation(), effects=0, dispatches=0;const gates:ReturnType<typeof gate>[]=[];
  let run=async(context:Parameters<DeviceToolsPort["dispatchBound"]>[1],action:Action):Promise<Action>=>{
    if(!context.guard(action,pin)||context.signal.aborted)return store.markUnknown(action.id,"executor_error");effects++;return store.completeAction(action.id,{ok:true});
  };
  const port:DeviceToolsPort={installationId:store.hostId,ownerId:store.ownerId,snapshot:()=>({...pin}),authenticatedPresence:()=>presence,operation:()=>op,
    dispatchBound(id,context){dispatches++;const action=store.claimAction(id);return run(context,action);} };
  let surface=new DeviceTurnSurface(store,port);
  t.after(async()=>{for(const g of gates)g.release();try{await surface.close();}catch(e){if(!quarantined)throw e;}store.close();rmSync(dir,{recursive:true,force:true});});
  const grant=(policy:"allow"|"ask"|"deny")=>store.setGrant({botId:bot.id,tool,destination:device.id,policy});
  const route=surface.admin.bindRoute({botId:bot.id,deviceId:device.id,tool});
  return {dir,store,bot,other,device,thread,turn,port,route,get surface(){return surface;},replace:(s:DeviceTurnSurface)=>{surface=s;},grant,
    issue:()=>surface.issueCapability({turnId:turn.id}),call:(token:string,callId="call",arguments_=args,options:{signal?:AbortSignal}={})=>surface.call(token,{tool,connectionId:route.id,callId,arguments:arguments_},options),
    counts:()=>({effects,dispatches}),rotate:(same=false)=>{pin={...pin,fingerprint:same?pin.fingerprint:"b".repeat(64),generation:pin.generation+1,revision:pin.revision+1};},
    pin:()=>pin,expectQuarantine:()=>{quarantined=true;},setPresence:(p:typeof presence)=>{presence=p;},setOperation:(v:string)=>{op=operation(v);},setDescriptor:(descriptor:DeviceToolOperation)=>{op=descriptor;},advance:(n:number)=>{now+=n;},setRun:(fn:typeof run)=>{run=fn;},gates};
}

test("owner binding grants nothing; own bot/device/tool and native arguments create only one canonical action",async t=>{
  const s=setup(t),{token}=s.issue();assert.deepEqual(s.surface.listTools(token),[]);
  await assert.rejects(s.call(token),code("forbidden"));assert.equal(s.store.listActions().length,0);
  s.grant("allow");const done=await s.call(token);assert.equal(done.status,"succeeded");assert.deepEqual(s.counts(),{effects:1,dispatches:1});
  const a=s.store.getAction(done.actionId);assert.equal(a.request.destination,s.device.id);assert.equal(a.request.tool,tool);assert.deepEqual(a.request.arguments,args);assert.equal(Object.hasOwn(a.request.arguments,"pin"),false);
  assert.deepEqual(await s.call(token),done);assert.equal(s.store.listActions().length,1);assert.equal(s.counts().effects,1);
  const foreignThread=s.store.createThread(s.other.id),foreignTurn=s.store.createTurn(foreignThread.id,{clientRequestId:"other",content:"fixture"}).turn;s.store.claimNextTurn(foreignThread.id);
  const foreign=s.surface.issueCapability({turnId:foreignTurn.id});assert.deepEqual(s.surface.listTools(foreign.token),[]);await assert.rejects(s.call(foreign.token),code("forbidden"));
  await assert.rejects(s.surface.call(token,{tool,connectionId:s.route.id,callId:"extra",arguments:args,botId:s.other.id}),code("invalid_input"));
  await assert.rejects(s.call(token,"extra",{...args,pin:{fingerprint:"foreign"}} as typeof args),code("invalid_input"));
});

test("ask returns frozen requestHash without dispatch; exact owner approval and replay effect once",async t=>{
  const s=setup(t);s.grant("ask");const {token}=s.issue();const pending=await s.call(token);assert.equal(pending.status,"awaiting_approval");assert.equal(s.counts().dispatches,0);
  assert.throws(()=>s.store.decideAction(pending.actionId,{decision:"allow",requestHash:"0".repeat(64)}),e=>e instanceof HostError&&e.code==="conflict");
  s.store.decideAction(pending.actionId,{decision:"allow",requestHash:pending.requestHash});assert.equal((await s.call(token)).status,"succeeded");assert.equal((await s.call(token)).status,"succeeded");assert.equal(s.counts().effects,1);
  await assert.rejects(s.call(token,"call",{...args,line:"different"}),code("conflict"));
  const otherRoute=s.surface.admin.bindRoute({botId:s.other.id,deviceId:s.device.id,tool});
  await assert.rejects(s.surface.call(token,{tool,connectionId:otherRoute.id,callId:"call",arguments:args}),code("conflict"));assert.equal(s.store.listActions().length,1);
});

test("P0 device owner continuation executes the exact approved binding after the turn ends; model capability stays revoked",async t=>{
  const s=setup(t);s.grant("ask");const {token}=s.issue(),pending=await s.call(token);
  s.store.finishTurn(s.turn.id,"completed",null);s.surface.revokeCapability(token);
  const approved=s.store.decideAction(pending.actionId,{decision:"allow",requestHash:pending.requestHash});
  const receipt=await s.surface.continueOwnerAction(approved);
  assert.equal(receipt.state,"succeeded");assert.deepEqual(s.counts(),{effects:1,dispatches:1});
  assert.equal((await s.surface.continueOwnerAction(receipt)).id,receipt.id);assert.equal(s.counts().effects,1);
  await assert.rejects(s.call(token),code("unauthorized"));
});

test("P0 device owner continuation refuses a rotated pin after the proposing turn ends",async t=>{
  const s=setup(t);s.grant("ask");const {token}=s.issue(),pending=await s.call(token);
  s.store.finishTurn(s.turn.id,"completed",null);s.surface.revokeCapability(token);
  const approved=s.store.decideAction(pending.actionId,{decision:"allow",requestHash:pending.requestHash});s.rotate(true);
  assert.equal((await s.surface.continueOwnerAction(approved)).state,"blocked");assert.equal(s.counts().effects,0);
});

test("R3 issuing a new turn capability preserves an admitted owner device effect after origin completion",async t=>{
  const s=setup(t);s.grant("ask");const {token}=s.issue(),pending=await s.call(token);
  s.store.finishTurn(s.turn.id,"completed",null);s.surface.revokeCapability(token);
  const approved=s.store.decideAction(pending.actionId,{decision:"allow",requestHash:pending.requestHash});
  const entered=gate(),finish=gate();s.gates.push(entered,finish);let aborted=true,authorized=false;
  s.setRun(async(context,action)=>{
    entered.release();await finish.promise;aborted=context.signal.aborted;authorized=context.guard(action,s.pin());
    return !aborted&&authorized?s.store.completeAction(action.id,{ok:true}):s.store.markUnknown(action.id,"executor_error");
  });
  const execution=s.surface.continueOwnerAction(approved);await entered.promise;
  const nextThread=s.store.createThread(s.bot.id),next=s.store.createTurn(nextThread.id,{clientRequestId:"next-turn",content:"synthetic"}).turn;
  s.store.claimNextTurn(nextThread.id);const nextCap=s.surface.issueCapability({turnId:next.id});
  finish.release();const receipt=await execution;
  assert.equal(receipt.state,"succeeded");assert.equal(aborted,false);assert.equal(authorized,true);assert.equal(s.counts().dispatches,1);
  assert.equal((await s.surface.continueOwnerAction(receipt)).id,receipt.id);assert.equal(s.counts().dispatches,1);
  s.surface.revokeCapability(nextCap.token);
});

test("R2 offline device after owner Allow gets a terminal no-effect receipt; reconnect never retries it",async t=>{
  const s=setup(t);s.grant("ask");const {token}=s.issue(),pending=await s.call(token);
  s.store.finishTurn(s.turn.id,"completed",null);s.surface.revokeCapability(token);
  const approved=s.store.decideAction(pending.actionId,{decision:"allow",requestHash:pending.requestHash});s.setPresence("stale");
  const receipt=await s.surface.continueOwnerAction(approved);
  assert.equal(receipt.state,"blocked");assert.equal(receipt.reason,null);assert.deepEqual(receipt.result,{kind:"action_not_executed",code:"destination_unavailable",effectDispatched:false});
  assert.equal(s.store.toolActionProgress(receipt.id)?.resultBodyAvailable,true);
  s.setPresence("online");assert.equal((await s.surface.continueOwnerAction(receipt)).state,"blocked");
  assert.deepEqual(s.counts(),{effects:0,dispatches:0});
});

test("legacy HTTP heartbeat cannot establish authenticated presence or persist an offline intent",async t=>{
  const s=setup(t);s.grant("allow");const {token}=s.issue();s.setPresence("stale");s.store.heartbeatDevice(s.device.id);
  await assert.rejects(s.call(token),code("unavailable"));assert.equal(s.store.listActions().length,0);
  const db=new DatabaseSync(s.surface.databasePath);assert.equal((db.prepare("SELECT COUNT(*) n FROM device_calls").get() as {n:number}).n,0);db.close();
  s.setPresence("online");s.grant("ask");const pending=await s.call(token);s.store.decideAction(pending.actionId,{decision:"allow",requestHash:pending.requestHash});s.setPresence("stale");
  await assert.rejects(s.call(token),code("unavailable"));assert.equal(s.store.getAction(pending.actionId).state,"ready");assert.equal(s.counts().dispatches,0);
});

test("pin rotation and same-fingerprint ABA invalidate old routes; explicit rebind then fresh grant is required",async t=>{
  const s=setup(t);s.grant("ask");const {token}=s.issue();const pending=await s.call(token);s.rotate(true);
  assert.deepEqual(s.surface.listTools(token),[]);assert.equal((await s.call(token)).status,"blocked");
  s.grant("allow");const rebound=s.surface.admin.bindRoute({botId:s.bot.id,deviceId:s.device.id,tool});assert.equal(rebound.id,s.route.id);assert.equal(rebound.needsFreshGrant,true);
  assert.deepEqual(s.surface.listTools(token),[]);await assert.rejects(s.call(token,"new"),code("forbidden"));
  s.grant("allow");assert.equal(s.surface.listTools(token).length,1);const done=await s.call(token,"new");assert.equal(done.status,"succeeded");assert.notEqual(done.requestHash,pending.requestHash);
  assert.equal(s.store.listActions().length,2);assert.equal((await s.call(token)).actionId,pending.actionId);
});

test("revoked device cannot rebind and an old-generation queued claim is never delivered",async t=>{
  const s=setup(t);s.grant("allow");const {token}=s.issue(),g=gate();s.gates.push(g);
  s.setRun(async(context,a)=>{await g.promise;return context.guard(a,s.pin())?s.store.completeAction(a.id,{ok:true}):s.store.markUnknown(a.id,"executor_error");});
  const running=s.call(token);s.rotate(true);g.release();assert.equal((await running).status,"unknown");assert.equal(s.counts().effects,0);
  s.store.revokeDevice(s.device.id);assert.deepEqual(s.surface.listTools(token),[]);assert.throws(()=>s.surface.admin.bindRoute({botId:s.bot.id,deviceId:s.device.id,tool}),code("forbidden"));
  assert.equal((await s.call(token)).status,"unknown");assert.equal(s.counts().dispatches,1);
});

test("grant ABA and schema change after await refuse delivery; terminal unknown is not repeated",async t=>{
  const s=setup(t);s.grant("allow");const {token}=s.issue(),g=gate();s.gates.push(g);
  s.setRun(async(context,a)=>{await g.promise;return context.guard(a,s.pin())?s.store.completeAction(a.id,{ok:true}):s.store.markUnknown(a.id,"executor_error");});
  const pending=s.call(token);s.grant("deny");s.grant("allow");s.setOperation("v2");g.release();assert.equal((await pending).status,"unknown");assert.equal((await s.call(token)).status,"unknown");assert.equal(s.counts().dispatches,1);
});

test("intent survives crash before Hub request and after Hub commit; restart creates no second action",async t=>{
  const s=setup(t);s.grant("ask");let {token}=s.issue();const original=s.store.requestAction.bind(s.store);let phase="before";
  s.store.requestAction=(input)=>{if(phase==="before")throw new Error("synthetic crash");const action=original(input);if(phase==="after")throw new Error("synthetic crash after commit");return action;};
  await assert.rejects(s.call(token),code("unavailable"));assert.equal(s.store.listActions().length,0);
  await s.surface.close();s.replace(new DeviceTurnSurface(s.store,s.port));token=s.issue().token;phase="after";
  await assert.rejects(s.call(token),code("unavailable"));assert.equal(s.store.listActions().length,1);const action=s.store.listActions()[0]!;assert.equal(s.surface.isTurnBound(action.id),true);
  await s.surface.close();s.replace(new DeviceTurnSurface(s.store,s.port));token=s.issue().token;phase="ok";
  assert.equal((await s.call(token)).actionId,action.id);assert.equal(s.store.listActions().length,1);assert.equal(s.counts().effects,0);
});

test("rotation between durable intent and Hub request refuses recovery without a new action",async t=>{
  const s=setup(t);s.grant("allow");let {token}=s.issue();const request=s.store.requestAction.bind(s.store);s.store.requestAction=()=>{throw new Error("synthetic crash");};
  await assert.rejects(s.call(token),code("unavailable"));s.store.requestAction=request;await s.surface.close();s.rotate();s.replace(new DeviceTurnSurface(s.store,s.port));token=s.issue().token;
  await assert.rejects(s.call(token),code("forbidden"));s.surface.admin.bindRoute({botId:s.bot.id,deviceId:s.device.id,tool});s.grant("allow");
  await assert.rejects(s.call(token),code("forbidden"));assert.equal(s.store.listActions().length,0);
});

test("short TTL, ended turn and cap revocation fail closed without captured effect",async t=>{
  const s=setup(t);s.grant("allow");const cap=s.surface.issueCapability({turnId:s.turn.id,ttlMs:5});s.advance(5);await assert.rejects(s.call(cap.token),code("unauthorized"));
  const next=s.issue();s.surface.revokeCapability(next.token);await assert.rejects(s.call(next.token),code("unauthorized"));
  const final=s.issue();s.store.finishTurn(s.turn.id,"completed",null);await assert.rejects(s.call(final.token),code("unauthorized"));assert.equal(s.store.listActions().length,0);
});

test("before-claim abort refuses action; after-claim abort and noncooperative drain retain writer and DB",async t=>{
  const s=setup(t);s.grant("allow");const {token}=s.issue(),controller=new AbortController();controller.abort();await assert.rejects(s.call(token,"early",args,{signal:controller.signal}),code("unauthorized"));assert.equal(s.store.listActions().length,0);
  const g=gate();s.gates.push(g);let observedAbort=false,observedGuard=true;s.setRun(async(context,a)=>{await g.promise;observedAbort=context.signal.aborted;observedGuard=context.guard(a,s.pin());return s.store.markUnknown(a.id,"executor_error");});
  const call=s.call(token),observed=call.catch(e=>e);const closing=s.surface.close();let closed=false;void closing.then(()=>{closed=true;});
  await new Promise(r=>setTimeout(r,20));assert.equal(closed,false);assert.equal(s.surface.status().flights,1);assert.equal(s.surface.status().closed,false);
  assert.throws(()=>new HostStore({dataDir:s.dir}),e=>e instanceof HostError&&e.code==="host_locked");g.release();await observed;await closing;assert.equal(observedAbort,true);assert.equal(observedGuard,false);assert.equal(s.store.listActions()[0]?.state,"unknown");assert.equal(s.surface.status().closed,true);assert.equal(s.store.summary().hostId,s.store.hostId);
});

test("writer loss refuses DB mutation and delivery; own fixture restores lease only after no effects",async t=>{
  const s=setup(t);s.grant("allow");const {token}=s.issue(),db=new DatabaseSync(s.store.databasePath);const prior=db.prepare("SELECT token FROM host_lease").get() as {token:string};
  db.prepare("UPDATE host_lease SET token=?").run("synthetic-writer-loss");
  try {await assert.rejects(s.call(token),e=>e instanceof HostError&&e.code==="host_locked");assert.throws(()=>s.surface.admin.suspendRoute(s.route.id),e=>e instanceof HostError&&e.code==="host_locked");assert.equal(s.counts().effects,0);}
  finally {db.prepare("UPDATE host_lease SET token=?").run(prior.token);db.close();}
  assert.equal(s.store.listActions().length,0);
});

test("private registry rejects dangling database/sidecars and never writes outside its owned directory",async t=>{
  const s=setup(t);await s.surface.close();const dbPath=s.surface.databasePath;renameSync(dbPath,dbPath+".saved");const outsideDir=mkdtempSync(join(tmpdir(),"dexter-device-tools-outside-"));t.after(()=>rmSync(outsideDir,{recursive:true,force:true}));const outside=join(outsideDir,"absent-outside.sqlite");symlinkSync(outside,dbPath);
  assert.throws(()=>new DeviceTurnSurface(s.store,s.port),code("unavailable"));assert.throws(()=>lstatSync(outside),{code:"ENOENT"});rmSync(dbPath);renameSync(dbPath+".saved",dbPath);
  symlinkSync(outside,dbPath+"-wal");assert.throws(()=>new DeviceTurnSurface(s.store,s.port),code("unavailable"));assert.throws(()=>lstatSync(outside),{code:"ENOENT"});rmSync(dbPath+"-wal");
  s.replace(new DeviceTurnSurface(s.store,s.port));assert.equal(lstatSync(dbPath).mode&0o077,0);
});

test("metadata/inode replacement fails closed and preserves foreign files",async t=>{
  const s=setup(t),path=s.surface.databasePath;renameSync(path,path+".owned");writeFileSync(path,"foreign",{mode:0o600});assert.throws(()=>s.surface.admin.listRoutes(),code("unavailable"));
  rmSync(path);renameSync(path+".owned",path);
});


test("server delivery guard binds the current admission capability and signal inside the writer fence",async t=>{
  const s=setup(t);s.grant("allow");const {token}=s.issue(),controller=new AbortController(),g=gate();s.gates.push(g);
  let closureAllowed=false,serverAllowed=false,afterAbort=true,afterRevoke=true;
  s.setRun(async(context,a)=>{
    closureAllowed=s.store.withWriterLease(()=>context.guard(a,s.pin()));
    serverAllowed=s.store.withWriterLease(()=>s.surface.deliveryGuard(a,s.pin()));
    await g.promise;
    afterAbort=s.store.withWriterLease(()=>s.surface.deliveryGuard(a,s.pin()));
    s.surface.revokeCapability(token);
    afterRevoke=s.store.withWriterLease(()=>s.surface.deliveryGuard(a,s.pin()));
    return s.store.markUnknown(a.id,"executor_error");
  });
  const call=s.call(token,"guard",args,{signal:controller.signal}),observed=call.catch(e=>e);controller.abort();g.release();await observed;
  assert.equal(closureAllowed,true);assert.equal(serverAllowed,true);assert.equal(afterAbort,false);assert.equal(afterRevoke,false);
  const action=s.store.listActions()[0]!;assert.equal(s.surface.isTurnBound(action.id),true);assert.equal(s.surface.deliveryGuard(action,s.pin()),false);assert.equal(action.state,"unknown");
});


test("a cached running action cannot authorize delivery after canonical unknown",async t=>{
 const s=setup(t);s.grant("allow");const {token}=s.issue(),g=gate();s.gates.push(g);let cachedGuard=true,serverGuard=true;
 s.setRun(async(context,a)=>{await g.promise;cachedGuard=context.guard(a,s.pin());serverGuard=s.surface.deliveryGuard(a,s.pin());return s.store.getAction(a.id);});
 const call=s.call(token),action=s.store.listActions()[0]!;assert.equal(action.state,"running");s.store.markUnknown(action.id,"executor_error");g.release();assert.equal((await call).status,"unknown");
 assert.equal(cachedGuard,false);assert.equal(serverGuard,false);assert.equal(s.counts().effects,0);assert.equal((await s.call(token)).status,"unknown");assert.equal(s.counts().dispatches,1);
});


// unbranded_ready: a plain GatewayError from the port, action still ready, is not a trusted preflight proof.
for (const refusal of ["peer_error","misused_preflight","unbranded_ready"] as const) test(`a ${refusal} dispatch rejection quarantines close until fixture process exit`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),"dexter-device-unconfirmed-"));
 const script=`
 import {createHash} from 'node:crypto';
 import {HostStore,canonicalJson,HostError} from ${JSON.stringify(import.meta.resolve("@dexter/hub"))};
 import {GatewayError} from ${JSON.stringify(import.meta.resolve("@dexter/gateway"))};
 import {DeviceTurnSurface,DeviceDispatchPreflightError} from ${JSON.stringify(new URL("../packages/cli/src/device-turn-surface.js",import.meta.url).href)};
 const store=new HostStore({dataDir:${JSON.stringify(dir)}}),bot=store.createBot({name:'Synthetic',profileId:'fixture',engine:'claude'}),device=store.registerDevice({name:'Synthetic',platform:'macos',capabilities:['mac.process.probe']}),thread=store.createThread(bot.id),turn=store.createTurn(thread.id,{clientRequestId:'fixture',content:'synthetic'}).turn;store.claimNextTurn(thread.id);
 const base={version:'v1',tool:'mac.process.probe',effect:'read',description:'Synthetic',inputSchema:{type:'object',additionalProperties:false,required:[],properties:{}}};
 let claims=0,dispatches=0;const surface=new DeviceTurnSurface(store,{installationId:store.hostId,ownerId:store.ownerId,snapshot:()=>({installationId:store.hostId,ownerId:store.ownerId,deviceId:device.id,fingerprint:'a'.repeat(64),generation:1,revision:1,status:'active'}),authenticatedPresence:()=>'online',operation:()=>({...base,schemaHash:createHash('sha256').update(canonicalJson(base)).digest('hex'),validate:a=>a}),async dispatchBound(id){dispatches++;${refusal === 'unbranded_ready' ? "throw new GatewayError('unavailable','synthetic plain refusal');" : "store.claimAction(id);claims++;"+(refusal === 'peer_error' ? "throw Object.assign(new Error('synthetic peer unavailable'),{code:'unavailable'});" : "throw new DeviceDispatchPreflightError('unavailable');")}}});
 const route=surface.admin.bindRoute({botId:bot.id,deviceId:device.id,tool:base.tool});store.setGrant({botId:bot.id,tool:base.tool,destination:device.id,policy:'allow'});const cap=surface.issueCapability({turnId:turn.id});await surface.call(cap.token,{tool:base.tool,connectionId:route.id,callId:'one',arguments:{}}).catch(()=>{});
 const first=surface.close();let rejected=false;try{await first;}catch{rejected=true;}
 let writerLocked=false;try{new HostStore({dataDir:${JSON.stringify(dir)}});}catch(e){writerLocked=e instanceof HostError&&e.code==='host_locked';}
 let second=false;try{await surface.call(cap.token,{tool:base.tool,connectionId:route.id,callId:'two',arguments:{}});}catch{second=true;}let reissue=false;try{surface.issueCapability({turnId:turn.id});}catch{reissue=true;}
 console.log(JSON.stringify({rejected,sharedPromise:surface.close()===first,writerLocked,state:store.listActions()[0].state,claims,dispatches,second,reissue,status:surface.status()}));
 // No external effect was invoked. Leave quarantine intact and let process exit close its handles.
 `;
 const child=spawn(process.execPath,["--input-type=module","-e",script],{env:{PATH:"/usr/bin:/bin"},stdio:"pipe",shell:false});let output="",stderr="";child.stdout.on("data",b=>{output+=b.toString();});child.stderr.on("data",b=>{stderr+=b.toString();});
 const exited=new Promise<number|null>(r=>child.once("close",r));let timer:ReturnType<typeof setTimeout>|undefined;
 try{const code_=await Promise.race([exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("fixture deadline"));},5000);})]);assert.equal(code_,0,stderr);const proof=JSON.parse(output);assert.equal(proof.rejected,true);assert.equal(proof.sharedPromise,true);assert.equal(proof.writerLocked,true);assert.equal(proof.state,refusal==="unbranded_ready"?"ready":"unknown");assert.equal(proof.claims,refusal==="unbranded_ready"?0:1);assert.equal(proof.dispatches,1);assert.equal(proof.second,true);assert.equal(proof.reissue,true);assert.equal(proof.status.unconfirmed,true);assert.equal(proof.status.closed,false);assert.equal(proof.status.accepting,false);}
 finally{clearTimeout(timer);child.kill("SIGKILL");await exited;rmSync(dir,{recursive:true,force:true});}
});


test("trusted offline preflight refusal leaves ready action and permits confirmed close",async t=>{
 const s=setup(t);s.grant("allow");const {token}=s.issue();s.port.dispatchBound=async()=>{throw new DeviceDispatchPreflightError("unavailable");};
 await assert.rejects(s.call(token),code("unavailable"));assert.equal(s.store.listActions()[0]?.state,"ready");assert.equal(s.surface.status().unconfirmed,false);assert.equal(s.counts().effects,0);await s.surface.close();assert.equal(s.surface.status().closed,true);
});

test("trusted preflight after permission revocation blocks action without an admitted executor",async t=>{
 const s=setup(t);s.grant("allow");const {token}=s.issue();s.port.dispatchBound=async()=>{s.grant("deny");throw new DeviceDispatchPreflightError("forbidden");};
 await assert.rejects(s.call(token),code("forbidden"));assert.equal(s.store.listActions()[0]?.state,"blocked");assert.equal(s.surface.status().unconfirmed,false);assert.equal(s.counts().effects,0);
});

test("abort while trusted preflight waits never claims or quarantines an executor",async t=>{
 const s=setup(t);s.grant("allow");const {token}=s.issue(),controller=new AbortController(),g=gate();s.gates.push(g);let observedAbort=false;
 s.port.dispatchBound=async(_id,context)=>{await g.promise;observedAbort=context.signal.aborted;throw new DeviceDispatchPreflightError("unauthorized");};
 const call=s.call(token,"preflight-abort",args,{signal:controller.signal});controller.abort();g.release();await assert.rejects(call,code("unauthorized"));assert.equal(observedAbort,true);assert.equal(s.store.listActions()[0]?.state,"ready");assert.equal(s.surface.status().unconfirmed,false);assert.equal(s.counts().effects,0);
});


test("canonical operation descriptors are consumed without a divergent schema catalog",async t=>{
 const s=setup(t);s.setDescriptor(operationFor(tool));s.grant("allow");const {token}=s.issue();assert.deepEqual(s.surface.listTools(token),[]);
 // Explicit rebind pins the canonical provider version; no implicit schema upgrade executes an old intent or reuses old consent.
 const bound=s.surface.admin.bindRoute({botId:s.bot.id,deviceId:s.device.id,tool});assert.equal(bound.schemaHash,operationFor(tool).schemaHash);assert.equal(bound.needsFreshGrant,true);
 assert.deepEqual(s.surface.listTools(token),[]);await assert.rejects(s.call(token,"canonical"),code("forbidden"));s.grant("allow");const [view]=s.surface.listTools(token);assert.deepEqual(view?.inputSchema,operationFor(tool).inputSchema);assert.equal((await s.call(token,"canonical")).status,"succeeded");
 const control=operationFor("mac.cua.control");assert.equal(Object.isFrozen(control.inputSchema),true);assert.ok(control.inputSchema.if);
 const device=s.store.registerDevice({name:"Synthetic CUA",platform:"macos",capabilities:[control.tool]}),pin={...s.pin(),deviceId:device.id};const originalSnapshot=s.port.snapshot;
 s.port.snapshot=id=>id===device.id?pin:originalSnapshot(id);s.port.operation=name=>operationFor(name);let cuaEffect=0;
 s.port.dispatchBound=async(id,context)=>{const action=s.store.claimAction(id);if(!s.store.withWriterLease(()=>context.guard(action,pin)))return s.store.markUnknown(id,"executor_error");cuaEffect++;return s.store.completeAction(id,{fixture:true});};
 const cuaRoute=s.surface.admin.bindRoute({botId:s.bot.id,deviceId:device.id,tool:control.tool});s.store.setGrant({botId:s.bot.id,tool:control.tool,destination:device.id,policy:"allow"});
 const cuaView=s.surface.listTools(token).find(v=>v.name===control.tool);assert.deepEqual(cuaView?.inputSchema,control.inputSchema);
 const input={surfaceId:"srf_"+"a".repeat(32),elementId:"el_1",action:"press"};const call={tool:control.tool,connectionId:cuaRoute.id,callId:"cua",arguments:input};
 await assert.rejects(s.surface.call(token,{...call,arguments:{...input,value:"unexpected"}}),code("invalid_input"));assert.equal(cuaEffect,0);assert.equal(s.store.listActions().length,1);
 assert.equal((await s.surface.call(token,call)).status,"succeeded");assert.equal((await s.surface.call(token,call)).status,"succeeded");assert.equal(cuaEffect,1);
});


test("synchronous unstarted disposal closes only never-issued surfaces and preserves the borrowed store",async t=>{
 const idle=setup(t);idle.surface.disposeUnstarted();assert.equal(idle.surface.status().closed,true);idle.surface.disposeUnstarted();await idle.surface.close();assert.equal(idle.store.summary().hostId,idle.store.hostId);
 const issued=setup(t),cap=issued.issue();issued.surface.revokeCapability(cap.token);assert.throws(()=>issued.surface.disposeUnstarted(),code("conflict"));assert.equal(issued.surface.status().closed,false);
});


for(const expiry of ["capability","approval"] as const) test(`${expiry} expiry: a claimed owner approval survives its human deadline; a model capability remains bounded`,async t=>{
 const s=setup(t,{approvalTtlMs:5});s.grant(expiry==="approval"?"ask":"allow");const cap=s.surface.issueCapability({turnId:s.turn.id,...(expiry==="capability"?{ttlMs:5}:{})});
 if(expiry==="approval"){const pending=await s.call(cap.token);s.store.decideAction(pending.actionId,{decision:"allow",requestHash:pending.requestHash});}
 const g=gate();s.gates.push(g);let localGuard=true,serverGuard=true;
 s.setRun(async(context,a)=>{await g.promise;localGuard=context.guard(a,s.pin());serverGuard=s.surface.deliveryGuard(a,s.pin());return s.store.markUnknown(a.id,"executor_error");});
 const call=s.call(cap.token),observed=call.catch(e=>e);s.advance(5);g.release();const result=await observed;
 // Admitted work reports its canonical outcome even after the capability expired; no body exists to withhold.
 assert.equal((result as {status:string}).status,"unknown");assert.equal((result as {result:unknown}).result,null);
 assert.equal(localGuard,expiry==="approval");assert.equal(serverGuard,expiry==="approval");assert.equal(s.counts().effects,0);assert.equal(s.store.listActions()[0]?.state,"unknown");assert.equal(s.counts().dispatches,1);
});


test("schema migration checks installation owner before adding global call bindings",async t=>{
 const s=setup(t);await s.surface.close();const db=new DatabaseSync(s.surface.databasePath);
 s.store.withWriterLease(()=>{db.exec("DROP TABLE composite_call_bindings; DROP TABLE device_route_receipts");db.prepare("UPDATE meta SET value='1' WHERE key='schema'").run();db.prepare("UPDATE meta SET value='foreign-owner' WHERE key='owner'").run();});db.close();
 assert.throws(()=>new DeviceTurnSurface(s.store,s.port),code("conflict"));const inspect=new DatabaseSync(s.surface.databasePath);assert.equal(inspect.prepare("SELECT 1 FROM sqlite_master WHERE name='composite_call_bindings'").get(),undefined);assert.equal((inspect.prepare("SELECT value FROM meta WHERE key='schema'").get() as {value:string}).value,"1");
 s.store.withWriterLease(()=>inspect.prepare("UPDATE meta SET value=? WHERE key='owner'").run(s.store.ownerId));inspect.close();s.replace(new DeviceTurnSurface(s.store,s.port));
 const migrated=new DatabaseSync(s.surface.databasePath);assert.equal((migrated.prepare("SELECT value FROM meta WHERE key='schema'").get() as {value:string}).value,"3");assert.ok(migrated.prepare("SELECT 1 FROM sqlite_master WHERE name='composite_call_bindings'").get());migrated.close();
});


test("same-call polling joins one asynchronous preflight before any Hub claim",async t=>{
 const s=setup(t);s.grant("allow");const {token}=s.issue(),g=gate();s.gates.push(g);let preflights=0;
 s.port.dispatchBound=async()=>{preflights++;await g.promise;throw new DeviceDispatchPreflightError("unavailable");};
 const one=s.call(token),two=s.call(token);assert.equal(preflights,1);assert.equal(s.store.listActions().length,1);assert.equal(s.store.listActions()[0]?.state,"ready");g.release();await assert.rejects(one,code("unavailable"));await assert.rejects(two,code("unavailable"));assert.equal(s.surface.status().unconfirmed,false);assert.equal(s.counts().effects,0);
});


const tighter = (() => { const schema = structuredClone(operationFor(tool).inputSchema) as DeviceToolOperation["inputSchema"] & { properties: Record<string,Record<string,unknown>> }; schema.properties.line = { ...schema.properties.line,maxLength:4 }; return schema as DeviceToolOperation["inputSchema"]; })();
for (const [label,initial,next] of [
  ["schema-only",descriptor(),descriptor({ inputSchema:tighter })],
  ["version-only",descriptor(),descriptor({ version:"v2" })],
  ["effect-narrowing",descriptor(),descriptor({ effect:"read" })],
  ["effect-widening",descriptor({ effect:"read" }),descriptor()],
  ["version-downgrade",descriptor({ version:"v2" }),descriptor({ version:"v1" })],
] as const) test(`${label} operation change plus explicit rebind requires fresh consent and never reuses prior calls`,async t=>{
  const s=setup(t),grantRevision=()=>s.store.getGrant(s.bot.id,tool,s.device.id)?.revision ?? 0;
  s.setDescriptor(initial);s.surface.admin.bindRoute({botId:s.bot.id,deviceId:s.device.id,tool});s.grant("allow");const {token}=s.issue();
  const before=await s.call(token,"before");assert.equal(before.status,"succeeded");assert.deepEqual(before.result,{ok:true});
  s.setDescriptor(next);assert.deepEqual(s.surface.listTools(token),[]);const small={name:"fixture.txt",line:"ok"};await assert.rejects(s.call(token,"stale",small),code("forbidden"));
  const prior=grantRevision(),rebound=s.surface.admin.bindRoute({botId:s.bot.id,deviceId:s.device.id,tool});
  assert.equal(rebound.id,s.route.id);assert.equal(rebound.schemaHash,next.schemaHash);assert.equal(rebound.needsFreshGrant,true);assert.equal(rebound.minimumGrantRevision,prior+1);
  assert.deepEqual(s.surface.listTools(token),[]);await assert.rejects(s.call(token,"no-consent",small),code("forbidden"));
  // The earlier call is bound to the old operation: canonical success, never re-executed, body withheld.
  assert.deepEqual(await s.call(token,"before"),{...before,result:null});assert.equal(s.counts().effects,1);
  s.grant("allow");const [view]=s.surface.listTools(token);assert.equal(view?.effect,next.effect);assert.deepEqual(view?.inputSchema,next.inputSchema);
  if(label==="schema-only"){await assert.rejects(s.call(token,"fresh"),code("invalid_input"));assert.equal((await s.call(token,"fresh-ok",small)).status,"succeeded");}
  else assert.equal((await s.call(token,"fresh")).status,"succeeded");
  assert.equal(s.counts().effects,2);assert.equal(s.store.listActions().length,2);
  assert.equal(s.surface.admin.bindRoute({botId:s.bot.id,deviceId:s.device.id,tool}).minimumGrantRevision,rebound.minimumGrantRevision);
});

test("operation A-B-A rebind never automatically reuses an earlier grant revision",async t=>{
  const s=setup(t),grantRevision=()=>s.store.getGrant(s.bot.id,tool,s.device.id)!.revision;s.grant("allow");const {token}=s.issue();const r1=grantRevision();
  s.setOperation("v2");let route=s.surface.admin.bindRoute({botId:s.bot.id,deviceId:s.device.id,tool});assert.equal(route.minimumGrantRevision,r1+1);
  s.grant("allow");const r2=grantRevision();assert.equal((await s.call(token,"v2")).status,"succeeded");
  s.setOperation("v1");route=s.surface.admin.bindRoute({botId:s.bot.id,deviceId:s.device.id,tool});assert.equal(route.needsFreshGrant,true);assert.equal(route.minimumGrantRevision,r2+1);
  assert.deepEqual(s.surface.listTools(token),[]);await assert.rejects(s.call(token,"v1-old-consent"),code("forbidden"));
  s.grant("allow");assert.equal((await s.call(token,"v1")).status,"succeeded");assert.equal(s.counts().effects,2);
});

const losses = { grant:"withheld",capability:"disclosed",signal:"disclosed",pin:"withheld",schema:"withheld",route:"withheld",turn:"refused" } as const;
for (const [loss,replay] of Object.entries(losses) as [keyof typeof losses,(typeof losses)[keyof typeof losses]][]) test(`effect committed before ${loss} change reports canonical success with body withheld; replay ${replay}`,async t=>{
  const s=setup(t);s.grant("allow");const cap=s.issue(),controller=new AbortController();let effects=0;
  s.setRun(async(context,a)=>{
    if(!context.guard(a,s.pin()))return s.store.markUnknown(a.id,"executor_error");effects++;const done=s.store.completeAction(a.id,{body:"withheld-fixture"});
    if(loss==="grant")s.grant("allow"); else if(loss==="capability")s.surface.revokeCapability(cap.token); else if(loss==="signal")controller.abort();
    else if(loss==="pin")s.rotate(true); else if(loss==="schema")s.setOperation("v2"); else if(loss==="route")s.surface.admin.suspendRoute(s.route.id); else s.store.finishTurn(s.turn.id,"completed",null);
    return done;
  });
  const out=await s.call(cap.token,"call",args,{signal:controller.signal}),canonical=s.store.listActions()[0]!;
  assert.deepEqual(out,{actionId:canonical.id,status:"succeeded",requestHash:canonical.requestHash,reason:null,result:null});
  assert.equal(canonical.state,"succeeded");assert.deepEqual(canonical.result,{body:"withheld-fixture"});assert.equal(s.surface.status().unconfirmed,false);
  if(replay==="refused")await assert.rejects(s.call(cap.token),code("unauthorized"));
  else {
    const token=loss==="capability"?s.issue().token:cap.token,again=await s.call(token);assert.equal(again.status,"succeeded");assert.deepEqual(again.result,replay==="disclosed"?{body:"withheld-fixture"}:null);
    // A fresh valid capability never bypasses the stale grant/route/pin/operation to disclose the body.
    if(replay==="withheld"){s.surface.revokeCapability(token);assert.equal((await s.call(s.issue().token)).result,null);}
  }
  assert.equal(effects,1);assert.equal(s.store.listActions().length,1);
});

test("unchanged authority discloses the body on flight and identical replay",async t=>{
  const s=setup(t);s.grant("allow");const {token}=s.issue(),first=await s.call(token);assert.deepEqual(first.result,{ok:true});assert.deepEqual(await s.call(token),first);assert.equal(s.counts().effects,1);
});

test("a store that cannot confirm the admitted outcome yields fixed unknown and permanent quarantine",async t=>{
  const s=setup(t);s.grant("allow");s.expectQuarantine();const {token}=s.issue(),read=s.store.getAction.bind(s.store);
  s.setRun(async(_context,a)=>{const done=s.store.completeAction(a.id,{body:"withheld-fixture"});s.store.getAction=()=>{throw new HostError("host_locked","synthetic writer loss");};return done;});
  const out=await s.call(token);s.store.getAction=read;const canonical=s.store.listActions()[0]!;
  assert.deepEqual(out,{actionId:canonical.id,status:"unknown",requestHash:canonical.requestHash,reason:null,result:null});assert.equal(canonical.state,"succeeded");
  assert.equal(s.surface.status().unconfirmed,true);assert.equal(s.surface.status().accepting,false);await assert.rejects(s.surface.close(),code("unavailable"));
  assert.throws(()=>s.surface.issueCapability({turnId:s.turn.id}),code("unavailable"));await assert.rejects(s.call(token),code("unauthorized"));assert.equal(s.counts().dispatches,1);
});

test("orphaned Hub commit is recovered by exact key and blocked under stale authority without another action",async t=>{
  const s=setup(t);s.grant("allow");let {token}=s.issue();const request=s.store.requestAction.bind(s.store);
  s.store.requestAction=input=>{request(input);throw new Error("synthetic crash after commit");};await assert.rejects(s.call(token),code("unavailable"));s.store.requestAction=request;
  const orphan=s.store.listActions()[0]!;assert.equal(orphan.state,"ready");await s.surface.close();s.rotate();s.replace(new DeviceTurnSurface(s.store,s.port));token=s.issue().token;
  let created=0;s.store.requestAction=input=>{created++;return request(input);};
  const out=await s.call(token);assert.equal(out.actionId,orphan.id);assert.equal(out.status,"blocked");assert.equal(created,0);assert.equal(s.store.listActions().length,1);assert.equal(s.store.getAction(orphan.id).state,"blocked");
  assert.equal(s.surface.isTurnBound(orphan.id),true);assert.deepEqual(s.counts(),{effects:0,dispatches:0});
  const db=new DatabaseSync(s.surface.databasePath);assert.equal((db.prepare("SELECT action_id FROM device_calls").get() as {action_id:string}).action_id,orphan.id);db.close();
});
