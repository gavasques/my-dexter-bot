import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { HostStore } from "@dexter/hub";
import { CapabilityGateway, GatewayMcpBridge, SyntheticCredentialBroker, gatewayToolAlias, MCP_MODERN_VERSION, prepareMcpTurn,
  type GatewayCallResult, type TurnToolSurface } from "@dexter/gateway";

type Message = { id: number; result?: any; error?: { code: number } };
const TOOL="synthetic.append", HOST="directory-replay.example.test";
const INPUT={line:"once",tag:"synthetic"};
const metadata={"io.modelcontextprotocol/protocolVersion":MCP_MODERN_VERSION,
  "io.modelcontextprotocol/clientInfo":{name:"synthetic-directory-replay",version:"1"},"io.modelcontextprotocol/clientCapabilities":{}};
async function fixture(t:TestContext,unknown=false,modern=false){
  const root=mkdtempSync(join(tmpdir(),"dx-directory-replay-")),effect=join(root,"effect.txt");
  const store=new HostStore({dataDir:join(root,"host")}),broker=new SyntheticCredentialBroker();
  broker.put("synthetic-ref",{headers:{},allowedHosts:[HOST]});let effects=0,forwarded=0;
  const gateway=new CapabilityGateway({store,broker,adapter:{async execute(){
    effects++;appendFileSync(effect,"once\n");if(unknown)throw Error("synthetic failure after effect");
    return {accepted:true,privateBody:"synthetic original response"};
  }}});
  gateway.registerTool({name:TOOL,toolkit:"synthetic",upstreamSlug:"SYNTHETIC_APPEND",version:"v1",description:"Append one synthetic line",
    upstreamHost:HOST,effect:"write",inputSchema:{type:"object",additionalProperties:false,required:["line","tag"],
      properties:{line:{type:"string",maxLength:32},tag:{type:"string",maxLength:32}}}});
  const bot=store.createBot({name:"Replay owner",profileId:"own",engine:"claude"});
  const foreignBot=store.createBot({name:"Foreign",profileId:"foreign",engine:"claude"});
  const account=(profileId:string,label:string)=>gateway.connectAccount({profileId,toolkit:"synthetic",label,upstreamAccountRef:label,
    credentialRef:"synthetic-ref",allowedHosts:[HOST]});
  const own=account("own","own_account"),late=account("own","late_account"),foreign=account("foreign","foreign_account");
  const grant=(policy:"ask"|"allow"|"deny")=>store.setGrant({botId:bot.id,tool:TOOL,destination:own.id,policy});
  grant("allow");store.setGrant({botId:foreignBot.id,tool:TOOL,destination:foreign.id,policy:"allow"});
  const thread=store.createThread(bot.id),turn=store.createTurn(thread.id,{clientRequestId:"synthetic-replay",content:"synthetic"}).turn;
  store.claimNextTurn(thread.id);
  const makeBridge=async()=>{
    const issued=gateway.issueCapability({turnId:turn.id,ttlMs:60_000});
    // A lease admits only its initial bindings. New grants require a new lease; metadata is always revalidated.
    const admitted=new Set(gateway.listTools(issued.token).map(view=>gatewayToolAlias(view)));
    const surface:TurnToolSurface={issueCapability:input=>gateway.issueCapability(input),revokeCapability:token=>gateway.revokeCapability(token),
      listTools:token=>gateway.listTools(token).filter(view=>admitted.has(gatewayToolAlias(view))),
      call:async(token,input,options)=>{forwarded++;return gateway.call(token,input,options);}};
    const input=new PassThrough(),output=new PassThrough(),messages:Message[]=[];
    const waiting=new Map<number,{resolve(value:Message):void;timer:ReturnType<typeof setTimeout>}>();let rest="",seq=0;
    output.on("data",chunk=>{rest+=chunk.toString();while(rest.includes("\n")){
      const n=rest.indexOf("\n"),row=JSON.parse(rest.slice(0,n)) as Message;rest=rest.slice(n+1);messages.push(row);
      const pending=waiting.get(row.id);if(pending){clearTimeout(pending.timer);waiting.delete(row.id);pending.resolve(row);}
    }});
    const bridge=new GatewayMcpBridge({gateway:surface,capability:issued.token,input,output});
    const send=(value:unknown)=>input.write(JSON.stringify(value)+"\n");
    const rpc=(method:string,params:Record<string,unknown>={}):Promise<Message>=>{
      const id=++seq;return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{waiting.delete(id);reject(Error("synthetic replay RPC deadline"));},3000);
        waiting.set(id,{resolve,timer});send({jsonrpc:"2.0",id,method,params:modern?{...params,_meta:metadata}:params});
      });
    };
    if(modern)assert.equal((await rpc("server/discover")).result.resultType,"complete");
    else{await rpc("initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"synthetic",version:"1"}});send({jsonrpc:"2.0",method:"notifications/initialized"});}
    await rpc("tools/list");
    t.after(async()=>{bridge.close();await bridge.whenDrained();for(const item of waiting.values())clearTimeout(item.timer);});
    const call=(alias:string,callId:string,input:unknown=INPUT,directory=true)=>rpc("tools/call",directory?
      {name:"dx_catalog_call",arguments:{alias,callId,input}}:{name:alias,arguments:{callId,input}});
    return {bridge,issued,rpc,call,send,messages};
  };
  t.after(()=>{gateway.close();store.close();rmSync(root,{recursive:true,force:true});});
  const session=await makeBridge(),alias=gatewayToolAlias({name:TOOL,connectionId:own.id});
  return {store,gateway,bot,turn,own,late,foreign,grant,effect,session,alias,makeBridge,
    effects:()=>effects,forwarded:()=>forwarded,
    once:()=>{assert.equal(effects,1);assert.equal(readFileSync(effect,"utf8"),"once\n");assert.equal(store.listActions().length,1);}};
}
function persistedAction(store:HostStore,actionId:string):string{
  const db=new DatabaseSync(store.databasePath,{readOnly:true});
  try{return JSON.stringify(db.prepare("SELECT * FROM actions WHERE id=?").get(actionId));}finally{db.close();}
}
function receipt(message:Message):GatewayCallResult{assert.equal(message.error,undefined);assert(message.result?.structuredContent);return message.result.structuredContent;}
function refused(message:Message){assert.equal(message.error?.code,-32602);}

for(const modern of [false,true])for(const initialDirectory of [false,true])for(const unknown of [false,true])
  test(`${modern?"modern":"legacy"} ${initialDirectory?"directory":"direct"} admission retains ${unknown?"unknown":"success"} directory receipt after grant revocation`,async t=>{
    const f=await fixture(t,unknown,modern),first=receipt(await f.session.call(f.alias,"original",INPUT,initialDirectory));
    assert.equal(first.status,unknown?"unknown":"succeeded");f.once();
    const stored=persistedAction(f.store,first.actionId);f.grant("deny");
    const search=await f.session.rpc("tools/call",{name:"dx_catalog_search",arguments:{query:TOOL,limit:20}});
    assert.deepEqual(search.result.structuredContent.tools,[]);
    refused(await f.session.rpc("tools/call",{name:"dx_catalog_describe",arguments:{alias:f.alias}}));
    const replies=await Promise.all([f.session.call(f.alias,"original"),f.session.call(f.alias,"original",{tag:"synthetic",line:"once"})]);
    for(const response of replies){const replay=receipt(response);assert.equal(replay.actionId,first.actionId);assert.equal(replay.requestHash,first.requestHash);
      assert.equal(replay.status,first.status);assert.equal(replay.result,null);assert.equal(response.result.isError,unknown);}
    // The direct path keeps its existing canonical status/identity semantics.
    const direct=receipt(await f.session.call(f.alias,"original",INPUT,false));assert.equal(direct.actionId,first.actionId);assert.equal(direct.status,first.status);
    assert.equal(persistedAction(f.store,first.actionId),stored);f.once();
  });

test("revoked directory alias rejects changed input, new call ID and unknown/foreign/late bindings before gateway dispatch",async t=>{
  const f=await fixture(t);receipt(await f.session.call(f.alias,"original"));f.grant("deny");
  f.store.setGrant({botId:f.bot.id,tool:TOOL,destination:f.late.id,policy:"allow"});
  const before=f.forwarded();
  for(const[alias,callId,input]of [[f.alias,"new",INPUT],[f.alias,"original",{...INPUT,line:"changed"}],
    ["dx_"+"f".repeat(24),"original",INPUT],[gatewayToolAlias({name:TOOL,connectionId:f.foreign.id}),"original",INPUT],
    [gatewayToolAlias({name:TOOL,connectionId:f.late.id}),"original",INPUT]]as const)refused(await f.session.call(alias,callId,input));
  assert.equal(f.forwarded(),before);f.once();
});

test("listed but undispatched alias and pending approval never confer a revoked replay path",async t=>{
  const f=await fixture(t);f.grant("ask");const pending=receipt(await f.session.call(f.alias,"pending"));assert.equal(pending.status,"awaiting_approval");
  assert.equal(f.effects(),0);f.grant("deny");const before=f.forwarded();
  refused(await f.session.call(f.alias,"pending"));refused(await f.session.call(f.alias,"never-admitted"));
  assert.equal(f.forwarded(),before);assert.equal(f.effects(),0);assert.equal(existsSync(f.effect),false);
});

test("a replacement lease cannot import another bridge's retained terminal request",async t=>{
  const f=await fixture(t);receipt(await f.session.call(f.alias,"original"));f.grant("deny");const other=await f.makeBridge();
  const before=f.forwarded();refused(await other.call(f.alias,"original"));assert.equal(f.forwarded(),before);f.once();
});

for(const mode of ["revoke","expire","turn-stopped"]as const)test(`retained replay refuses ${mode} capability before gateway dispatch`,async t=>{
  const f=await fixture(t);receipt(await f.session.call(f.alias,"original"));f.grant("deny");
  if(mode==="revoke")f.gateway.revokeCapability(f.session.issued.token);
  if(mode==="expire")f.store.now=()=>f.session.issued.scope.expiresAt;
  if(mode==="turn-stopped")f.store.finishTurn(f.turn.id,"completed",null);
  const before=f.forwarded(),reply=await f.session.call(f.alias,"original");assert.ok(reply.error);assert.equal(reply.result,undefined);
  assert.equal(f.forwarded(),before);f.once();
});

test("Stop closes the bridge and cannot disclose or dispatch a retained replay",async t=>{
  const f=await fixture(t);receipt(await f.session.call(f.alias,"original"));f.grant("deny");f.session.bridge.close();await f.session.bridge.whenDrained();
  const before=f.forwarded(),messages=f.session.messages.length;assert.equal(f.session.bridge.isClosed,true);
  f.session.send({jsonrpc:"2.0",id:999,method:"tools/call",params:{name:"dx_catalog_call",arguments:{alias:f.alias,callId:"original",input:INPUT}}});
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.forwarded(),before);assert.equal(f.session.messages.length,messages);f.once();
});

for(const modern of [false,true]) test(`${modern?"modern":"legacy"} real lease retained replay preserves the persisted canonical delivered body`,async t=>{
  const f=await fixture(t),lease=await prepareMcpTurn({store:f.store,gateway:f.gateway,turnId:f.turn.id,
    wrapperPath:fileURLToPath(new URL("../packages/cli/src/mcp-stdio.js",import.meta.url))});
  const socket=connect(lease.socketPath),waiting=new Map<number,{resolve:(m:Message)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  let tail="",seq=0;
  socket.on("error",()=>{});
  socket.on("data",chunk=>{tail+=chunk.toString();while(tail.includes("\n")){
    const n=tail.indexOf("\n"),row=JSON.parse(tail.slice(0,n)) as Message;tail=tail.slice(n+1);
    const p=waiting.get(row.id);if(p){clearTimeout(p.timer);waiting.delete(row.id);p.resolve(row);}
  }});
  t.after(async()=>{socket.destroy();lease.stop();await lease.whenDrained();for(const p of waiting.values()){clearTimeout(p.timer);p.reject(Error("closed"));}});
  await new Promise<void>((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject);});
  const rpc=(method:string,params:Record<string,unknown>={}):Promise<Message>=>new Promise((resolve,reject)=>{
    const id=++seq,timer=setTimeout(()=>{waiting.delete(id);reject(Error("lease deadline"));},3000);
    waiting.set(id,{resolve,reject,timer});socket.write(JSON.stringify({jsonrpc:"2.0",id,method,params:modern?{...params,_meta:metadata}:params})+"\n");
  });
  if(modern)await rpc("server/discover");else{
    await rpc("initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"lease",version:"1"}});
    socket.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})+"\n");
  }
  const call=(directory=true)=>rpc("tools/call",directory?{name:"dx_catalog_call",arguments:{alias:f.alias,callId:"lease-original",input:INPUT}}
    :{name:f.alias,arguments:{callId:"lease-original",input:INPUT}});
  const original=receipt(await call());assert.deepEqual(original.result,{accepted:true,privateBody:"synthetic original response"});
  await new Promise<void>(resolve=>setImmediate(resolve));
  const row=()=>{const db=new DatabaseSync(f.store.databasePath,{readOnly:true});try{return db.prepare("SELECT * FROM tool_action_continuations WHERE action_id=?").get(original.actionId);}finally{db.close();}};
  const before=row();assert.equal(before?.delivered,1);assert.equal(before?.receipt_result,JSON.stringify(original.result));
  f.grant("deny");
  assert.equal(receipt(await call()).result,null);await new Promise<void>(resolve=>setImmediate(resolve));assert.deepEqual(row(),before);
  const direct=receipt(await call(false));assert.equal(direct.actionId,original.actionId);assert.equal(direct.requestHash,original.requestHash);
  await new Promise<void>(resolve=>setImmediate(resolve));assert.deepEqual(row(),before);
  f.grant("allow");assert.deepEqual(receipt(await call()).result,original.result);await new Promise<void>(resolve=>setImmediate(resolve));assert.deepEqual(row(),before);
  // Defensive write-once body protection also holds if another ACK consumer sends a redacted reply.
  f.store.markToolResultDelivered(original.actionId,f.turn.id,null);assert.deepEqual(row(),before);f.once();
});
