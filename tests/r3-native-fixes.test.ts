import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { HostStore } from "@dexter/hub";
import { CapabilityGateway } from "@dexter/gateway";
import { inspectMcpMetadata, NativeMcpRuntime, McpUpstreamSession, checkMcpDefinition, probeMcpServer, type McpRuntimeHost } from "@dexter/connectors";
// Exercise the exact production module instances (including the shared bounded program cache), with
// dependencies resolved beside connectors/dist rather than a second emitted source copy.
const nativeSchema = await import(pathToFileURL(resolve("packages/connectors/dist/mcp/schema.js")).href) as typeof import("../packages/connectors/src/mcp/schema.js");
const assertSupportedMcpSchema: typeof import("../packages/connectors/src/mcp/schema.js").assertSupportedMcpSchema = nativeSchema.assertSupportedMcpSchema;
const { validateNativeMcpArguments, validateNativeMcpOutput } = nativeSchema;
const { toolDefinitionHash } = await import(pathToFileURL(resolve("packages/connectors/dist/mcp/session.js")).href) as typeof import("../packages/connectors/src/mcp/session.js");
const { checkedMcpPattern, mcpPatternCacheStats } = await import(pathToFileURL(resolve("packages/connectors/dist/mcp/linear-regexp.js")).href) as typeof import("../packages/connectors/src/mcp/linear-regexp.js");
import { CATALOG, READ, SEND, COMPOSIO_KEY, serviceLab, hostLab } from "./fixtures/connections-lab.js";
const CANARY="synthetic-private-token-c4973a17";
const err=(code:string)=>(error:unknown)=>error instanceof Error&&(error as Error & {code?:string}).code===code;
const definition=()=>checkMcpDefinition({id:"synthetic",name:"Synthetic",transport:{type:"streamable_http",url:"https://mcp.example.test/mcp"},runsOn:"owner_mac",auth:"none",readOnlyTools:["read"]});
const TOOL={name:"read",description:"Read synthetic input",inputSchema:{type:"object",properties:{nested:{type:"object",properties:{value:{type:"integer"}},required:["value"]}},required:["nested"]},outputSchema:{type:"object",properties:{ok:{type:"boolean"}},required:["ok"]}};
function fakePeer(tools:Record<string,unknown>[]=[TOOL],modern=false,listChanged=false) {
  const calls:{method:string;id:unknown;params:Record<string,unknown>;headers:Headers}[]=[];
  let result:Record<string,unknown>={content:[{type:"text",text:"synthetic"}],structuredContent:{ok:true}};
  let toolHandler:((params:Record<string,unknown>)=>Record<string,unknown>)|null=null;
  let discoverError:{code:number;message:string}|null=null;
  let discoverReply:{status:number;body:string}|null=null;
  const subscribers=new Map<ReadableStreamDefaultController<Uint8Array>,string>();
  const fetch=(async(_url:unknown,init?:RequestInit)=>{
    if(init?.method!=="POST")return new Response(null,{status:405});
    const m=JSON.parse(init.body as string) as {id?:unknown;method:string;params?:Record<string,unknown>};
    calls.push({method:m.method,id:m.id,params:m.params??{},headers:new Headers(init.headers)});
    if(m.id===undefined)return new Response(null,{status:202});
    let value:unknown;
    if(m.method==="subscriptions/listen") {
      const stream=new ReadableStream<Uint8Array>({start(controller){subscribers.set(controller,String(m.id));controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({jsonrpc:"2.0",method:"notifications/subscriptions/acknowledged",params:{notifications:{toolsListChanged:true},_meta:{"io.modelcontextprotocol/subscriptionId":String(m.id)}}})}\n\n`));
        init?.signal?.addEventListener("abort",()=>{subscribers.delete(controller);try{controller.close();}catch{/* closed */}},{once:true});},cancel(){/* Synthetic fixture has no resources outside this stream. */}});
      return new Response(stream,{headers:{"content-type":"text/event-stream"}});
    }
    if(m.method==="server/discover") {
      if(discoverReply)return new Response(discoverReply.body,{status:discoverReply.status,headers:{"content-type":"application/json"}});
      if(discoverError)return Response.json({jsonrpc:"2.0",id:m.id,error:discoverError},{status:400});
      if(!modern)return Response.json({jsonrpc:"2.0",id:m.id,error:{code:-32601,message:"Method not found"}});
      value={resultType:"complete",supportedVersions:["2026-07-28"],_meta:{"io.modelcontextprotocol/serverInfo":{name:"synthetic",version:"1"}},capabilities:{tools:listChanged?{listChanged:true}:{}},ttlMs:0,cacheScope:"private"};
    } else if(m.method==="initialize")value={protocolVersion:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"synthetic",version:"1"}};
    else if(m.method==="tools/list")value={tools};
    else if(m.method==="tools/call")value=toolHandler?toolHandler(m.params??{}):result;
    else value={};
    if(modern&&m.method!=="server/discover")value={...(value as object),resultType:(value as Record<string,unknown>).resultType??"complete",
      _meta:{"io.modelcontextprotocol/serverInfo":{name:"synthetic",version:"1"}},...(m.method==="tools/list"?{ttlMs:0,cacheScope:"private"}:{})};
    return Response.json((value as Record<string,unknown>).syntheticError?{jsonrpc:"2.0",id:m.id,error:(value as Record<string,unknown>).syntheticError}:{jsonrpc:"2.0",id:m.id,result:value});
  }) as typeof globalThis.fetch;
  const host:McpRuntimeHost={runsOn:"owner_mac",stdioRoot:"/private/tmp/dexter-synthetic-unused",fetch,...(modern?{protocolMode:"modern"}:{}),secretValues:()=>[CANARY]};
  return {calls,host,setResult:(r:Record<string,unknown>)=>{result=r;},setToolHandler:(handler:typeof toolHandler)=>{toolHandler=handler;},
    setDiscoverError:(error:typeof discoverError)=>{discoverError=error;},
    setDiscoverReply:(reply:typeof discoverReply)=>{discoverReply=reply;},
    notify:()=>{for(const [controller,id] of subscribers)controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({jsonrpc:"2.0",method:"notifications/tools/list_changed",params:{_meta:{"io.modelcontextprotocol/subscriptionId":id}}})}\n\n`));return subscribers.size;}};
}
test("R3-01: 10,000 validations reuse bounded NFA programs; churn evicts safely", () => {
  const schema={type:"object",properties:{value:{type:"string",pattern:"^[a-z0-9_-]{1,64}$"}},required:["value"]};
  validateNativeMcpArguments(schema,{value:"hello_123"});
  const before=mcpPatternCacheStats(), batches:number[]=[];
  for(let batch=0;batch<10;batch++) {
    const start=performance.now();
    for(let i=0;i<1000;i++)validateNativeMcpArguments(schema,{value:"hello_123"});
    batches.push(performance.now()-start);
    validateNativeMcpOutput(schema,{value:"hello_123"});
  }
  const after=mcpPatternCacheStats();assert.equal(after.created,before.created);assert.equal(after.live,before.live);
  assert.ok(batches.slice(-3).every(ms=>ms<300),`steady batches bounded: ${batches}`);
  for(let i=0;i<100;i++)validateNativeMcpArguments({type:"string",pattern:`^x${i}[a-z]{1,64}$`},`x${i}hello`);
  const churn=mcpPatternCacheStats();assert.equal(churn.live,churn.limit);assert.ok(churn.deleted>=68);
  validateNativeMcpArguments(schema,{value:"hello_123"});
  console.log(JSON.stringify({probe:"validations-10000",batches,cache:churn}));
});
test("R3-01: high counted programs refuse before allocation; rejected schema cannot poison peers", () => {
  const before=mcpPatternCacheStats();
  for(const count of [10,20,40,51]) {
    const pattern=`^${"\\d{0,1000}".repeat(count)}x$`,start=performance.now();
    assert.throws(()=>assertSupportedMcpSchema({type:"string",pattern}),err("schema_unsupported"));
    assert.ok(performance.now()-start<100,"unsafe compilation preflight <100ms");
  }
  for(const pattern of ["^[01]*1[01]{20}$","[01]{20}1[01]{20}x", "^a*b+$", "^[^\\u2000]{65}$", "^\\S{65}$", "^[^\\u2000\\u2011\\u2022\\u2033]{64}$"]) {
    const start=performance.now();assert.throws(()=>assertSupportedMcpSchema({type:"string",pattern}),err("schema_unsupported"));assert.ok(performance.now()-start<100);
  }
  assert.equal(mcpPatternCacheStats().created,before.created);
  const schema={type:"string",pattern:`^${"\\d{0,30}".repeat(6)}$`};
  const start=performance.now();assertSupportedMcpSchema(schema);assert.ok(performance.now()-start<100,"safe cold compilation <100ms");
  const matchStart=performance.now();assert.throws(()=>validateNativeMcpArguments(schema,"1".repeat(65535)+"x"),err("input_schema_invalid"));
  assert.ok(performance.now()-matchStart<100,"adversarial linear match <100ms");
  validateNativeMcpArguments({type:"string",pattern:"^ok$"},"ok");validateNativeMcpArguments({type:"integer"},5);
});
test("R3-04: JWT adversary at 256KiB scans in <100ms and genuine shapes still quarantine", () => {
  const text=("-eyJ"+"a".repeat(12)).repeat(16384), start=performance.now();
  assert.equal(Buffer.byteLength(text),256*1024);assert.equal(inspectMcpMetadata(text).safe,true);
  const elapsed=performance.now()-start;assert.ok(elapsed<100,`metadata scanner ${elapsed}ms`);
  for(const secret of ["sk-proj-0123456789abcdefABCDEF", "ghp_0123456789abcdefABCDEF", "Bearer abcDEF0123456789xyz", "eyJabcdef0123456789.abcdef0123456789.abcdef0123456789", "-----BEGIN ENCRYPTED PRIVATE KEY-----", "https://example.test/?client_secret=real_value"])assert.equal(inspectMcpMetadata(secret).safe,false,secret);
  console.log(JSON.stringify({probe:"metadata-256KiB",elapsed}));
});
test("R3-05: schema positions preserve property names, filesystem search_files, formats and discriminator", () => {
  const filesystem={type:"object",properties:{path:{type:"string"},pattern:{type:"string"},excludePatterns:{type:"array",items:{type:"string"},default:[]}},required:["path","pattern"],additionalProperties:false,$schema:"http://json-schema.org/draft-07/schema#"};
  assert.throws(()=>assertSupportedMcpSchema({$async:true,type:"integer"}),err("schema_unsupported"));
  validateNativeMcpArguments(filesystem,{path:"/synthetic",pattern:"*.ts"});
  for(const [pattern,good,bad] of [["^(asc|desc)$","asc","ascending"],["^.{1,64}$","hello","\n"],["^\\S+$","hello","a b"]]) {
    const schema={type:"string",pattern},original=JSON.stringify(schema);validateNativeMcpArguments(schema,good);
    assert.throws(()=>validateNativeMcpArguments(schema,bad),err("input_schema_invalid"));assert.equal(JSON.stringify(schema),original);
  }
  const props={type:"object",properties:{pattern:{type:"string"},patternProperties:{type:"string"},$ref:{type:"string"},format:{type:"string"}}};
  validateNativeMcpArguments(props,{pattern:"okay",patternProperties:"okay",$ref:"okay",format:"okay"});
  validateNativeMcpArguments({type:"string",format:"x-custom"},"arbitrary");
  assert.throws(()=>validateNativeMcpArguments({type:"string",format:"email"},"bad email"),err("input_schema_invalid"));
  const discriminated={type:"object",discriminator:{propertyName:"kind"},required:["kind"],oneOf:[{properties:{kind:{const:"a"},a:{type:"integer"}},required:["a"]},{properties:{kind:{const:"b"},b:{type:"string"}},required:["b"]}]};
  validateNativeMcpArguments(discriminated,{kind:"a",a:1});assert.throws(()=>validateNativeMcpArguments(discriminated,{kind:"a",b:"x"}),err("input_schema_invalid"));
});
test("R3-06: dialect ambiguities refuse; accepted subset differentially equals ECMAScript-u", () => {
  for(const pattern of ["^[][a]$","^[^]$","^[^\\cj]*$","^[^\\uD83D\\uDE00]+$","^\\u{D800}$","^😀$"])assert.throws(()=>assertSupportedMcpSchema({type:"string",pattern}),err("schema_unsupported"));
  const require=createRequire(import.meta.resolve("@dexter/connectors"));
  const {WrappedRE2}=require("re2-wasm/build/wasm/re2.js") as {WrappedRE2:new(p:string,i:boolean,m:boolean,s:boolean)=>{match(v:string,n:number,c:boolean):{index:number};delete():void}};
  const corpus=["","asc","desc","as","descending","a","ab","123","A_b-1","a b","a\nb","hello\r","hello\u2028","hello\u2029","\u00a0","\u1680","\u202f","\ufeff","😀","é","\u0000"];
  const patterns=["^(asc|desc)$","^.{1,64}$","^\\S+$","^\\s+$","^[a-z0-9_-]{1,64}$","^\\d{0,30}\\d{0,30}$","[abc]+","[^abc]+","^\\w+$","^\\W+$","^\\u00e9$","^\\u{1f600}$","^a?$","^ab*$","^a(?:b|c)$","^\\x41$","^\\0$","^\\d+$","^\\D+$"];
  let comparisons=0;
  for(const pattern of patterns) {
    const native=new WrappedRE2(checkedMcpPattern(pattern),false,false,false),ecma=new RegExp(pattern,"u");
    try{for(const value of corpus){assert.equal(native.match(value,0,false).index>=0,ecma.test(value),`${pattern} ${JSON.stringify(value)}`);const schema={type:"string",pattern};if(ecma.test(value))validateNativeMcpArguments(schema,value);else assert.throws(()=>validateNativeMcpArguments(schema,value),err("input_schema_invalid"));comparisons++;}}finally{native.delete();}
  }
  assert.throws(()=>validateNativeMcpArguments({type:"string",pattern:"^\\u{fffd}$"},"\ud800"),err("input_schema_invalid"));
  console.log(JSON.stringify({probe:"RE2-ECMAScript-differential",comparisons}));
});
test("R3-07: explicit examples and low entropy query codes are safe; known canary overrides placeholder", () => {
  for(const text of ["Bearer YOUR_ACCESS_TOKEN_HERE","sk-xxxxxxxxxxxxxxxxxxxxxxxx","ghp_xxxxxxxxxxxxxxxxxxxxxxxx","eyJxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxx","https://example.test/?code=","https://example.test/?code=example"])assert.equal(inspectMcpMetadata(text).safe,true,text);
  for(const text of ["Bearer YOUR_ACCESS_TOKEN_HERE","sk-xxxxxxxxxxxxxxxxxxxxxxxx"])assert.equal(inspectMcpMetadata(text,[text]).safe,false,"custody secrets never exempt");
  assert.equal(inspectMcpMetadata("https://example.test/?code=AbC0def123GhI456jKlM789pqRst").safe,false);
  assert.equal(inspectMcpMetadata({default:CANARY},[CANARY]).safe,false);
});
test("R3-07: native quarantines one definition before DB/context and healthy selected tool still works",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-r3-quarantine-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const tools=[TOOL,{...TOOL,name:"bad",description:CANARY},{...TOOL,name:"sample",description:"Bearer YOUR_ACCESS_TOKEN_HERE"}];
  const f=fakePeer(tools),store=new HostStore({dataDir:dir}),runtime=new NativeMcpRuntime({host:f.host}),gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});
  runtime.bind(store,gateway);t.after(async()=>{await runtime.close();gateway.close();store.close();});
  const bot=store.createBot({name:"Synthetic",profileId:"work",engine:"codex"});runtime.admin.addServer({definition:definition()});
  const result=await runtime.admin.discover("synthetic");assert.equal(result.server.status,"ready");assert.equal(result.tools.filter(tool=>tool.state==="publishable").length,2);
  assert.equal(result.tools.filter(tool=>tool.state==="unsupported_schema").length,1);assert.ok(!JSON.stringify(result).includes(CANARY));
  runtime.admin.setBotSelection("synthetic",bot.id,{toolIds:["mcp.synthetic.read"],policy:"ask"});
  for(const suffix of ["","-wal"])try{assert.ok(!readFileSync(join(dir,`native-mcp.sqlite${suffix}`)).includes(Buffer.from(CANARY)));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const session=await McpUpstreamSession.open(definition(),{},f.host);
  try { await session.listTools(); await session.callTool("read",{nested:{value:1}}); assert.equal(f.calls.filter(call=>call.method==="tools/call").length,1); } finally { await session.close(); }
  const probe=await probeMcpServer(definition(),{},f.host);assert.equal(probe.state,"ready");assert.ok(!JSON.stringify(probe).includes(CANARY));
});
test("R3-07: managed service and host gallery preserve healthy definitions with synthetic contaminated siblings",async t=>{
  const service=await serviceLab(t,{catalog:[{...CATALOG[0]!,tools:[READ,{...SEND,description:COMPOSIO_KEY},{...SEND,name:"gmail.placeholder",description:"Bearer YOUR_ACCESS_TOKEN_HERE"}]}]});
  const catalog=service.service.catalog();assert.equal(catalog.services.length,1);assert.deepEqual(catalog.services[0]!.tools.map(tool=>(tool as {name:string}).name),[READ.name,"gmail.placeholder"]);
  assert.ok(!JSON.stringify(catalog).includes(COMPOSIO_KEY));
  const host=await hostLab(t,service);const result=await host.api("GET","/v1/connections/catalog");assert.equal(result.status,200);
  assert.equal(result.json.services[0].tools.length,2);assert.ok(!JSON.stringify(result.json).includes(COMPOSIO_KEY));
  for(const file of ["connections.sqlite","connections.sqlite-wal"])try{assert.ok(!readFileSync(join(host.dir,file)).includes(Buffer.from(COMPOSIO_KEY)));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
});
test("R3-05: unsupported baseline definition retains selection and exact inert grant across discovery/restart",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-r3-inert-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const tools:Record<string,unknown>[]=[{name:"read",description:"Historical baseline",inputSchema:{type:"object",properties:{value:{type:"string"}},required:["value"]}}];
  let f=fakePeer(tools),store=new HostStore({dataDir:dir}),runtime=new NativeMcpRuntime({host:f.host}),gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});runtime.bind(store,gateway);
  const bot=store.createBot({name:"Synthetic",profileId:"work",engine:"codex"});runtime.admin.addServer({definition:definition()});await runtime.admin.discover("synthetic");runtime.admin.setBotSelection("synthetic",bot.id,{toolIds:["mcp.synthetic.read"],policy:"ask"});
  const connection=gateway.registry.listConnections("work")[0]!,grant=store.getGrant(bot.id,"mcp.synthetic.read",connection.id)!;
  await runtime.close();gateway.close();store.close();
  tools[0]={...tools[0],inputSchema:{type:"object",properties:{value:{type:"string",pattern:"^[^\\uD83D\\uDE00]+$"}},required:["value"]}};
  const db=new DatabaseSync(join(dir,"native-mcp.sqlite")),rows=JSON.parse(String(db.prepare("SELECT tools FROM catalogs WHERE server_id='synthetic'").get()!.tools));
  delete rows[0].manifest.nativeInputSchema;rows[0].manifest.inputSchema={type:"object",properties:{value:{type:"string",maxLength:8192}},required:["value"],additionalProperties:false};rows[0].manifest.version=toolDefinitionHash(tools[0]!);
  db.prepare("UPDATE catalogs SET tools=? WHERE server_id='synthetic'").run(JSON.stringify(rows));db.close();
  f=fakePeer(tools);store=new HostStore({dataDir:dir});runtime=new NativeMcpRuntime({host:f.host});gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});runtime.bind(store,gateway);
  const discovered=await runtime.admin.discover("synthetic");assert.equal(discovered.tools[0]!.state,"unsupported_schema");assert.deepEqual(runtime.admin.botSelection("synthetic",bot.id).toolIds,["mcp.synthetic.read"]);assert.deepEqual(store.getGrant(bot.id,"mcp.synthetic.read",connection.id),grant);assert.equal(gateway.registry.getTool("mcp.synthetic.read")!.status,"retired");assert.deepEqual(runtime.admin.catalogChanges("synthetic")!.removed,[]);assert.deepEqual(runtime.admin.catalogChanges("synthetic")!.changed,["mcp.synthetic.read"]);
  await runtime.close();gateway.close();store.close();f=fakePeer(tools);store=new HostStore({dataDir:dir});runtime=new NativeMcpRuntime({host:f.host});gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});runtime.bind(store,gateway);
  t.after(async()=>{await runtime.close();gateway.close();store.close();});assert.deepEqual(runtime.admin.botSelection("synthetic",bot.id).toolIds,["mcp.synthetic.read"]);assert.deepEqual(store.getGrant(bot.id,"mcp.synthetic.read",connection.id),grant);assert.equal(gateway.registry.getTool("mcp.synthetic.read")!.status,"retired");assert.equal(f.calls.length,0);
});

test("R3-05: modern unsupported header definitions remain visible and inert while healthy peer publishes",async()=>{
  const f=fakePeer([TOOL,{...TOOL,name:"bad_header",inputSchema:{type:"object",properties:{value:{type:"string","x-mcp-header":"Authorization"}}}}],true);
  const result=await probeMcpServer(definition(),{},f.host);assert.equal(result.state,"ready");if(result.state!=="ready")throw new Error("healthy peer remains ready");
  assert.equal(result.tools.find(tool=>tool.mcpName==="read")!.status,"publishable");assert.equal(result.tools.find(tool=>tool.mcpName==="bad_header")!.status,"unsupported_schema");
  assert.equal(f.calls.filter(call=>call.method==="tools/call").length,0);
});

test("R3-38: legacy server quarantine clears atomically when rediscovery needs auth",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-r3-quarantine-auth-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let f=fakePeer(),store=new HostStore({dataDir:dir}),runtime=new NativeMcpRuntime({host:f.host}),gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});runtime.bind(store,gateway);
  runtime.admin.addServer({definition:definition()});await runtime.admin.discover("synthetic");await runtime.close();gateway.close();store.close();
  const path=join(dir,"native-mcp.sqlite"),db=new DatabaseSync(path),hash="a".repeat(64);
  db.prepare("UPDATE servers SET status='failed' WHERE id='synthetic'").run();db.prepare("INSERT INTO meta(key,value) VALUES (?,?)").run("mcp-quarantine:synthetic",JSON.stringify({metadataHash:hash,observedAt:1}));db.close();
  f=fakePeer();let toolPosts=0;
  f.host.fetch=(async(_url:unknown,init?:RequestInit)=>{if(init?.body&&JSON.parse(String(init.body)).method==="tools/call")toolPosts++;return new Response(null,{status:401,headers:{"www-authenticate":"Bearer"}});}) as typeof globalThis.fetch;
  store=new HostStore({dataDir:dir});runtime=new NativeMcpRuntime({host:f.host});gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});runtime.bind(store,gateway);
  t.after(async()=>{await runtime.close();gateway.close();store.close();});assert.equal(runtime.admin.quarantineStatus("synthetic")!.metadataHash,hash);
  const result=await runtime.admin.discover("synthetic");assert.equal(result.server.status,"needs_auth");assert.equal(runtime.admin.quarantineStatus("synthetic"),null);assert.equal(toolPosts,0);
  const check=new DatabaseSync(path,{readOnly:true});try{assert.equal(check.prepare("SELECT value FROM meta WHERE key='mcp-quarantine:synthetic'").get(),undefined);assert.equal(check.prepare("SELECT status FROM servers WHERE id='synthetic'").get()!.status,"needs_auth");}finally{check.close();}
});
