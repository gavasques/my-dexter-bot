import assert from "node:assert/strict";
import test from "node:test";
import { X509Certificate } from "node:crypto";
import { HostError, HostStore, type ClientDeviceScope, type ConversationRuntime } from "@dexter/hub";
import { createAuthorizedHostRouter, type HostRequestAuthority } from "@dexter/hub/http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientPairingRegistry } from "@dexter/devices";
import { appLab, pairClient, call } from "./app-client-lab.js";
import { validClientCertificate } from "../packages/cli/src/app-client-server.js";
const botInput = { name: "R2", profileId: "p", engine: "codex" };

test("TLS: revocation after async body helper return prevents canonical admission", async t => {
 const l=await appLab(t); const key=l.identity("race"); const device=await pairClient(l,key);
 const original=ClientPairingRegistry.prototype.authenticate; let checks=0, writes=0;
 const create=l.store.createBot.bind(l.store);
 l.store.createBot=input=>{writes++; assert.equal(l.store.getDevice(device).revokedAt,null); return create(input);};
 ClientPairingRegistry.prototype.authenticate=function(fp){const b=original.call(this,fp); if(fp===key.fingerprint && ++checks===4)queueMicrotask(()=>l.store.revokeDevice(device));return b;};
 try {
  assert.deepEqual(await call(l.trust,key,"POST","/v1/bots",botInput),{status:403,json:{error:"authority_changed",effect:"unknown"}});
  assert.equal(writes,0); assert.equal(l.store.listBots().length,0); assert.notEqual(l.store.getDevice(device).revokedAt,null);
 }finally{ClientPairingRegistry.prototype.authenticate=original;}
});

test("all retained projection, HTTP, admin and grant seams permanently refuse after stop",async t=>{
 const l=await appLab(t);const key=l.identity("retained"),device=await pairClient(l,key);
 const {projection,peersHttp,admin,grants}=l.services; const original=l.store.getDevice(device).name;
 l.services.stopAdmission(); l.services.stopAdmission();
 for(const fn of [()=>projection.list(),()=>projection.get(device),()=>projection.rename(device,{name:"late"}),()=>projection.revoke(device),
  ()=>projection.isClientDevice(device),()=>projection.http.list(),()=>projection.http.get(device),()=>projection.http.rename(device,{name:"late"}),
  ()=>projection.http.revoke(device),()=>projection.http.dispatch("act_missing"),()=>projection.http.status(),
  ()=>peersHttp.list(),()=>peersHttp.get(device),()=>peersHttp.rename(device,{name:"late"}),()=>peersHttp.revoke(device),()=>peersHttp.status(),
  ()=>admin.pendingClaims(),()=>admin.pairingBundle({kind:"pair",role:"client-ios",scopes:[]}),()=>admin.approveClaim("ccl_missing"),
  ()=>admin.rejectClaim("ccl_missing"),()=>admin.cancelOffer("cof_missing"),()=>grants.list("bot_missing"),()=>grants.put({})])assert.throws(fn,/closing/);
 assert.throws(()=>peersHttp.dispatch("act_missing"),/closing/);
 assert.equal(l.store.getDevice(device).name,original);assert.equal(l.store.getDevice(device).revokedAt,null);
});

test("finite native byte bounds return explicit oversized error without retry or leaked data",async t=>{
 const l=await appLab(t),key=l.identity("quota");await pairClient(l,key);
 const bot=l.store.createBot(botInput),thread=l.store.createThread(bot.id);
 for(let i=0;i<10;i++)l.store.appendMessage(thread.id,{clientMessageId:`m${i}`,content:"x".repeat(32768)});
 const small=await call(l.trust,key,"GET",`/v1/threads/${thread.id}/messages`);
 assert.equal(small.status,200);assert.equal(small.json.items!.length,1);
 const large=await call(l.trust,key,"GET",`/v1/threads/${thread.id}/messages?limit=100`);
 assert.deepEqual(large,{status:500,json:{error:"response_too_large"}});
 const rawBody=JSON.stringify({...botInput,name:"x".repeat(65536)});
 assert.equal((await call(l.trust,key,"POST","/v1/bots",undefined,{rawBody})).status,413);
 assert.equal(l.store.listBots().length,1);
 const create=l.store.createBot.bind(l.store);
 l.store.createBot=input=>({...create(input),padding:"z".repeat(262144)});
 assert.deepEqual(await call(l.trust,key,"POST","/v1/bots",botInput),{status:500,json:{error:"response_too_large",effect:"unknown"}});
 assert.equal(l.store.listBots().length,2,"admitted effect retained, never retried");
 assert.equal((await call(l.trust,key,"GET","/v1/bots?limit=100")).status,200,"accepted SDK limits preserved");
});

test("app client certificate profile: clientAuth/P256/current validity required",async t=>{
 const l=await appLab(t),key=l.identity("profile"),cert=new X509Certificate(key.certPem);
 assert.equal(validClientCertificate(cert.raw),true);
 assert.equal(validClientCertificate(cert.raw,Date.parse(cert.validTo)),false);
 assert.equal(validClientCertificate(cert.raw,Date.parse(cert.validFrom)-1),false);
 assert.equal(validClientCertificate(new X509Certificate(l.host.certPem).raw),false,"no clientAuth");
 await assert.rejects(call(l.trust,l.host,"POST","/app-client/v1/pair/claim",{offerId:"cof_missing",code:"none",name:"profile"}));
 assert.deepEqual(l.services.admin.pendingClaims(),[]);
});


test("router: every body-carrying mutation checks again in its synchronous admission section",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"dexter-r2-router-")),store=new HostStore({dataDir:dir});
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const bot=store.createBot(botInput),thread=store.createThread(bot.id);
 let effects=0;
 const touched=()=>{effects++;throw new Error("unexpected admission");};
 store.createBot=touched;store.appendMessage=touched;store.decideAction=touched;
 const runtime={startTurn:touched,decideAction:touched,createBot:async(_input:unknown,admit:()=>void)=>{admit();return touched();}} as unknown as ConversationRuntime;
 const peers={list:()=>[],get:touched,rename:touched,revoke:touched},grants={list:()=>({}),put:touched};
 const router=createAuthorizedHostRouter(store,{runtime,peers,grants});
 const scopes:ClientDeviceScope[]=["chat.write","approvals.decide","devices.manage","grants.manage"];
 const cases:[string,string,unknown][]=[
  ["POST","/v1/bots",botInput],
  ["POST",`/v1/threads/${thread.id}/messages`,{clientMessageId:"r2",content:"hi"}],
  ["POST",`/v1/threads/${thread.id}/turns`,{clientRequestId:"r2",content:"hi"}],
  ["POST","/v1/actions/act_synthetic/decisions",{decision:"allow",requestHash:"a".repeat(64)}],
  ["PATCH","/v1/devices/dev_synthetic",{name:"late"}],
  ["PUT","/v1/device-grants",{}],
 ];
 for(const [method,path,body] of cases){
  let active=true,checks=0;
  const authority:HostRequestAuthority={principal:"paired-client",installationId:store.hostId,ownerId:store.ownerId,deviceId:"dev_client",role:"client-ios",scopes,pinGeneration:1,bindingRevision:1,
   assertCurrent(){if(!active)throw new HostError("forbidden","revoked");if(++checks===2)queueMicrotask(()=>{active=false;});},noteSelfRevoke(){}};
  const response=await router.fetch(new Request(`https://app-client.invalid${path}`,{method,headers:{"content-type":"application/json"},body:JSON.stringify(body)}),{authority});
  assert.equal(response.status,403,path);assert.equal(effects,0,path);assert.equal(checks,2,path);
 }
});

test("server close waits for the finite response and actual TLS socket closure",async t=>{
 const {AppClientServer}=await import("../packages/cli/src/app-client-server.js");
 const {hostIdentity,clientIdentity}=await import("./app-client-lab.js");
 const dir=mkdtempSync(join(tmpdir(),"dexter-r2-drain-")),store=new HostStore({dataDir:join(dir,"host")});
 const host=hostIdentity(join(dir,"server")),key=clientIdentity(join(dir,"client")),registry=new ClientPairingRegistry(store);
 let release!:()=>void;
 const body=new ReadableStream<Uint8Array>({start(controller){release=()=>{controller.enqueue(new TextEncoder().encode('{"ok":true}'));controller.close();};}});
 const server=new AppClientServer({store,registry,identity:host,router:{fetch(){return new Response(body,{headers:{"content-type":"application/json"}});}},listenHost:"127.0.0.1",port:0,advertisedOrigin:null,maxConnections:8,maxInFlight:4,headersTimeoutMs:1000,requestTimeoutMs:2000});
 t.after(async()=>{await server.close();registry.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const url=await server.start(),trust={url,certPem:host.certPem,fingerprint:host.fingerprint};
 const offer=registry.createOffer({kind:"pair",role:"client-ios",scopes:[]});
 const claim=await call(trust,key,"POST","/app-client/v1/pair/claim",{offerId:offer.offerId,code:offer.code,name:"Synthetic"});
 registry.approveClaim(claim.json.claimId as string);
 const reply=call(trust,key,"GET","/health");
 const deadline=Date.now()+2000;while(server.status().inFlight!==1){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,5));}
 let completed=false;const closing=server.close().then(()=>{completed=true;});
 await new Promise(r=>setTimeout(r,40));assert.equal(completed,false,"response body still pending");
 release();assert.deepEqual(await reply,{status:403,json:{error:"forbidden"}},"closing withholds late data");
 await closing;assert.equal(server.status().inFlight,0);assert.equal(server.status().connections,0);
});
