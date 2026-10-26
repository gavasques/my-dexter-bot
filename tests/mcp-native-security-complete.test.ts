import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,cpSync,realpathSync } from "node:fs";
import { join,dirname } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { HostStore } from "@dexter/hub";
import { CapabilityGateway, GatewayError } from "@dexter/gateway";
import { ToolExecutionFailure } from "@dexter/contracts";
import type { AdapterCall } from "@dexter/gateway";
import { HostServices } from "../packages/cli/src/host-services.js";
import {
  inspectMcpMetadata,assertSafeMcpMetadata,validateNativeMcpArguments,validateNativeMcpOutput,assertSupportedMcpSchema,
  createMcpEgressFetch,mcpAddressScope,validateMcpOAuthCallbackIssuer,encodeMcpHeaderValue,mcpParameterHeaders,mcpHeaderDeclarations,
  validateMcpRequestHeaders,checkMcpDefinition,McpUpstreamSession,probeMcpServer,McpConnectorError,NativeMcpRuntime,
  validateMcpPrivateInputRequests,validateMcpPrivateInputResponses,type McpRuntimeHost,type McpEgressNetwork,
  pinMcpStdioCommand,verifyMcpStdioCommand,McpToolAdapter,McpServerInventory,McpToolCatalog,
  McpOAuthClient,checkMcpEgressPolicy,MCP_METADATA_CATALOG_LIMITS,
} from "@dexter/connectors";
const CANARY="synthetic-private-token-c4973a17";
const err=(code:string)=>(e:unknown)=>e instanceof McpConnectorError&&e.code===code;
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
for(const location of ["description","default","enum","const","examples","url","ref","title","icon"])test(`metadata quarantine: ${location} known-secret canary rejected without changing original`,()=>{
  const raw:Record<string,unknown>={...TOOL,inputSchema:{type:"object"}};
  if(location==="description"||location==="title")raw[location]=CANARY;
  else if(location==="url")raw.resource={uri:`https://example.test/${encodeURIComponent(CANARY)}`};
  else if(location==="ref")raw.inputSchema={type:"object",$ref:`https://example.test/${CANARY}`};
  else if(location==="icon")raw.icons=[{src:`https://example.test/${CANARY}`}];
  else raw.inputSchema={type:"object",properties:{value:{type:"string",[location]:location==="enum"||location==="examples"?[CANARY]:CANARY}}};
  const before=JSON.stringify(raw),verdict=inspectMcpMetadata(raw,[CANARY]);
  assert.equal(verdict.safe,false);assert.match(verdict.hash,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(raw),before);
  assert.throws(()=>assertSafeMcpMetadata(raw,[CANARY]),e=>{assert.ok(err("metadata_quarantined")(e));assert.ok(!String(e).includes(CANARY));return true;});
});
test("metadata bounds: depth and cyclic metadata fail closed",()=>{
  const cycle:Record<string,unknown>={};cycle.child=cycle;assert.equal(inspectMcpMetadata(cycle).reason,"metadata_limit");
  let deep:unknown={value:"x"};for(let n=0;n<26;n++)deep={deep};assert.equal(inspectMcpMetadata(deep).reason,"metadata_limit");
});
test("metadata aggregate permits many bounded definitions but never widens a single definition or secret budget",()=>{
  const one={description:"x".repeat(2048),inputSchema:{type:"object"}},many=Array.from({length:150},()=>({...one}));
  assert.equal(inspectMcpMetadata(many).safe,false);assert.equal(inspectMcpMetadata(many,[],MCP_METADATA_CATALOG_LIMITS).safe,true);
  assert.equal(inspectMcpMetadata({description:"x".repeat(256*1024+1)}).safe,false);
  assert.equal(inspectMcpMetadata({},["s".repeat(8192),...Array.from({length:34},(_,i)=>String(i).padStart(8192,"s"))],MCP_METADATA_CATALOG_LIMITS).safe,false);
});
test("linear schema regex keeps exact bounded quantifier semantics in input, output and private forms",()=>{
  for(const count of [5,6]) {
    const pattern=`^${"\\d{0,30}".repeat(count)}$`,schema={type:"object",properties:{value:{type:"string",pattern}},required:["value"]},input={value:"1".repeat(40)+"x"};
    const before=JSON.stringify(schema),requests={r1:{method:"elicitation/create",params:{mode:"form",message:"Choose a number",requestedSchema:schema}}};
    assertSupportedMcpSchema(schema);validateMcpPrivateInputRequests(requests);
    for(const operation of [()=>validateNativeMcpArguments(schema,input),()=>validateNativeMcpOutput(schema,input),()=>validateMcpPrivateInputResponses(requests,{r1:{action:"accept",content:input}})]) {
      const start=performance.now();assert.throws(operation,e=>e instanceof McpConnectorError&&["input_schema_invalid","output_schema_invalid"].includes(e.code));assert.ok(performance.now()-start<100,"adversarial schema validation must finish within 100ms");
    }
    validateNativeMcpArguments(schema,{value:"1".repeat(40)});assert.equal(JSON.stringify(schema),before);
    const dynamic={type:"object",patternProperties:{[pattern]:{type:"integer"}},additionalProperties:false};assertSupportedMcpSchema(dynamic);
    const start=performance.now();assert.throws(()=>validateNativeMcpArguments(dynamic,{[input.value]:1}),err("input_schema_invalid"));assert.ok(performance.now()-start<100);
  }
  // JSON Schema uses no multiline flag; a final line terminator remains invalid for this anchored pattern.
  const anchored={type:"object",properties:{value:{type:"string",pattern:"^\\d+$"}}};validateNativeMcpArguments(anchored,{value:"123"});
  for(const value of ["123\n","123\r","123\u2028","123\u2029"])assert.throws(()=>validateNativeMcpArguments(anchored,{value}),err("input_schema_invalid"));
  for(const pattern of ["^(a|aa)+$","^(a+)+$","^a(?=b)$","^\\p{L}+$"]){
    const schema={type:"object",properties:{value:{type:"string",pattern}}},before=JSON.stringify(schema);
    assert.throws(()=>assertSupportedMcpSchema(schema),err("schema_unsupported"));assert.equal(JSON.stringify(schema),before);
    assert.throws(()=>assertSupportedMcpSchema({type:"object",patternProperties:{[pattern]:{type:"string"}}}),err("schema_unsupported"));
  }
});
test("startup egress policy is immutable, origin-only, bounded and cannot override actual placement",()=>{
  const input={placement:"owner_mac",privateOrigins:["https://AUTH.example.test:9443/"]},checked=checkMcpEgressPolicy(input,"owner_mac");
  assert.deepEqual(checked.privateOrigins,["https://auth.example.test:9443"]);assert.ok(Object.isFrozen(checked));assert.ok(Object.isFrozen(checked.privateOrigins));input.privateOrigins.push("https://unreviewed.example.test");assert.equal(checked.privateOrigins!.length,1);
  assert.deepEqual(checkMcpEgressPolicy({placement:"cloud"},"cloud").privateOrigins,[]);
  for(const raw of [{placement:"owner_mac",extra:true},{placement:"owner_mac",privateOrigins:["https://user:secret@example.test"]},{placement:"owner_mac",privateOrigins:["https://example.test/token"]},{placement:"owner_mac",privateOrigins:["https://example.test?code=x"]},{placement:"owner_mac",privateOrigins:["http://169.254.169.254"]},{placement:"cloud",privateOrigins:["https://example.test"]},{placement:"owner_mac",privateOrigins:Array(65).fill("https://example.test")}])assert.throws(()=>checkMcpEgressPolicy(raw),err("egress_refused"));
  assert.throws(()=>checkMcpEgressPolicy({placement:"owner_mac"},"cloud"),err("egress_refused"));
  assert.throws(()=>checkMcpEgressPolicy({placement:"owner_mac",privateOrigins:["https://AUTH.example.test/","https://auth.example.test"]}),err("egress_refused"));
});
test("JSON Schema exact: compositions, local refs and additional properties retain upstream semantics",()=>{
  const schema={type:"object",$defs:{address:{type:"object",properties:{city:{type:"string"}},required:["city"]}},properties:{address:{$ref:"#/$defs/address"},choice:{oneOf:[{type:"integer"},{type:"string"}]}},required:["address","choice"]};
  const before=JSON.stringify(schema);validateNativeMcpArguments(schema,{address:{city:"Sao Paulo",extra:1},choice:"ok",extra:true});
  assert.throws(()=>validateNativeMcpArguments(schema,{address:{},choice:false}),err("input_schema_invalid"));assert.equal(JSON.stringify(schema),before);
  assert.throws(()=>assertSupportedMcpSchema({type:"object",$ref:"https://schema.example.test/data"}),err("schema_unsupported"));
  assert.throws(()=>assertSupportedMcpSchema({$schema:"https://unsupported.test/dialect",type:"object"}),err("schema_unsupported"));
  assert.throws(()=>assertSupportedMcpSchema({type:"object",properties:{value:{type:"string",pattern:"^(a|aa)+$"}}}),err("schema_unsupported"));
  assert.throws(()=>assertSupportedMcpSchema({type:"object",properties:{value:{type:"string",unknownConstraint:"must reject"}}}),err("schema_unsupported"));
});
test("output validation failure is typed after effect, semantic error remains error",()=>{
  assert.throws(()=>validateNativeMcpOutput({type:"object",required:["ok"]},{other:1}),e=>{assert.ok(err("output_schema_invalid")(e));assert.equal((e as McpConnectorError).effect,"possible");return true;});
});
test("SSRF: IPv4, IPv6, mapped, rebinding, redirects and cloud private origins refused before request",async()=>{
  let resolved="8.8.8.8",requests=0,redirect=false;const ips:string[]=[];
  const network:McpEgressNetwork={lookup:async()=>[{address:resolved,family:4}],request:async(_url,address)=>{requests++;ips.push(address.address);resolved="127.0.0.1";return redirect?new Response(null,{status:302,headers:{location:"http://169.254.169.254/"}}):Response.json({ok:true});}};
  const fetch=createMcpEgressFetch({placement:"cloud"},network);
  await fetch("https://service.example.test/");assert.deepEqual(ips,["8.8.8.8"],"one resolved address handed directly to socket dependency");
  await assert.rejects(fetch("https://service.example.test/"),err("egress_refused"));assert.equal(requests,1);
  for(const ip of ["127.0.0.1","10.1.1.1","169.254.169.254","::1","::ffff:127.0.0.1","::ffff:7f00:1","fc00::1","fe80::1","64:ff9b::7f00:1"])assert.notEqual(mcpAddressScope(ip),"public");
  assert.throws(()=>createMcpEgressFetch({placement:"cloud",privateOrigins:["https://127.0.0.1"]},network),err("egress_refused"));
  resolved="8.8.8.8";redirect=true;await assert.rejects(fetch("https://service.example.test/"),err("upstream_redirect"));assert.equal(requests,2);
});
test("SSRF: explicitly reviewed owner loopback works; public mixed DNS answer cannot pick safe first address",async()=>{
  let calls=0;const network:McpEgressNetwork={lookup:async()=>[{address:"8.8.8.8",family:4},{address:"10.0.0.1",family:4}],request:async()=>{calls++;return Response.json({});}};
  await assert.rejects(createMcpEgressFetch({placement:"owner_mac"},network)("https://mixed.example.test/"),err("egress_refused"));assert.equal(calls,0);
  await createMcpEgressFetch({placement:"owner_mac",privateOrigins:["http://127.0.0.1:9000"]},network)("http://127.0.0.1:9000/mcp");assert.equal(calls,1);
});
test("default socket egress performs actual HTTP only on explicitly reviewed synthetic loopback",async t=>{
  let hits=0,body="";const server=createServer((req,res)=>{hits++;req.on("data",chunk=>{body+=chunk.toString();});req.on("end",()=>{res.writeHead(200,{"content-type":"application/json"}).end('{"ok":true}');});});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.deepEqual(await (await createMcpEgressFetch({placement:"owner_mac",privateOrigins:[origin]})(`${origin}/mcp`)).json(),{ok:true});assert.equal(hits,1);
  await createMcpEgressFetch({placement:"owner_mac",privateOrigins:[origin]})(`${origin}/token`,{method:"POST",body:new URLSearchParams({grant_type:"synthetic",resource:"synthetic"})});assert.equal(body,"grant_type=synthetic&resource=synthetic");
  await assert.rejects(createMcpEgressFetch({placement:"cloud"})(`${origin}/mcp`),err("egress_refused"));assert.equal(hits,2);
});
test("OAuth issuer validation equally rejects success/error mismatches without normalization",()=>{
  const issuer="https://issuer.example.test";
  for(const payload of [`iss=${encodeURIComponent(issuer+"/")}&code=x`,`iss=https%3A%2F%2Fother.test&error=denied`,`error=denied`,`iss=${encodeURIComponent(issuer)}&iss=${encodeURIComponent(issuer)}`])assert.throws(()=>validateMcpOAuthCallbackIssuer(issuer,true,new URLSearchParams(payload)),err("oauth_state_mismatch"));
  validateMcpOAuthCallbackIssuer(issuer,true,new URLSearchParams({iss:issuer,error:"denied"}));
  assert.throws(()=>validateMcpOAuthCallbackIssuer(issuer,false,new URLSearchParams({iss:"https://other.test",error:"denied"})),err("oauth_state_mismatch"));
  validateMcpOAuthCallbackIssuer(issuer,false,new URLSearchParams({code:"synthetic"}));
});
test("OAuth real loopback callback validates issuer on errors before code exchange or upstream error display",async t=>{
  let tokenPosts=0;
  const fetch=(async(input:unknown,init?:RequestInit)=>{
    const url=new URL(String(input));
    if(url.pathname.includes("oauth-protected-resource"))return Response.json({resource:"https://mcp.example.test/mcp",authorization_servers:["https://as.example.test"]});
    if(url.pathname.includes("oauth-authorization-server"))return Response.json({issuer:"https://as.example.test",authorization_endpoint:"https://as.example.test/authorize",token_endpoint:"https://as.example.test/token",response_types_supported:["code"],code_challenge_methods_supported:["S256"],authorization_response_iss_parameter_supported:true});
    if(init?.method==="POST")tokenPosts++;
    return Response.json({error:"synthetic"},{status:400});
  }) as typeof globalThis.fetch;
  const oauth=new McpOAuthClient({fetch});t.after(()=>oauth.close());const d=checkMcpDefinition({...definition(),auth:"oauth"});
  const started=await oauth.begin(d,{clientId:"synthetic-public-client"}),authorization=new URL(started.authorizationUrl),callback=new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state",authorization.searchParams.get("state")!);callback.searchParams.set("iss","https://other.example.test");callback.searchParams.set("error","denied");callback.searchParams.set("error_description",CANARY);
  const response=await globalThis.fetch(callback);assert.equal(response.status,400);assert.ok(!(await response.text()).includes(CANARY));await oauth.settled(d.id);assert.equal(oauth.status(d).lastError,"oauth_state_mismatch");assert.equal(tokenPosts,0);
});
test("modern header encoding: unicode/sentinel/padding exact; invalid declaration/path refuses",()=>{
  assert.equal(encodeMcpHeaderValue("=?base64?literal?="),"=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
  const schema={type:"object",properties:{nested:{type:"object",properties:{choice:{type:"string","x-mcp-header":"Choice"}}}}};
  assert.deepEqual(mcpParameterHeaders(schema,{nested:{choice:"Olá"}}),{"mcp-param-choice":"=?base64?T2zDoQ==?="});
  assert.throws(()=>mcpHeaderDeclarations({oneOf:[{type:"string","x-mcp-header":"Choice"}]}),err("header_mismatch"));
  assert.throws(()=>mcpHeaderDeclarations({properties:{a:{type:"string","x-mcp-header":"A"},b:{type:"string","x-mcp-header":"a"}}}),err("header_mismatch"));
  assert.throws(()=>validateMcpRequestHeaders(JSON.stringify({method:"tools/call",params:{name:"write",_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}),new Headers({"mcp-protocol-version":"2026-07-28","mcp-method":"tools/call","mcp-name":"other"})),err("header_mismatch"));
});
test("real SDK session: contaminated definition quarantines per tool without a call",async()=>{
  const f=fakePeer([TOOL,{...TOOL,name:"bad",description:CANARY}]);const result=await probeMcpServer(definition(),{},f.host);
  assert.equal(result.state,"ready");if(result.state!=="ready")throw new Error("healthy peer must remain ready");
  assert.equal(result.tools.find(tool=>tool.mcpName==="read")!.status,"publishable");assert.equal(result.tools.find(tool=>tool.mcpName==="bad")!.status,"unsupported_schema");
  assert.match(result.discovered.find(tool=>tool.name==="bad")!.quarantine!.metadataHash,/^[a-f0-9]{64}$/);assert.equal(f.calls.filter(c=>c.method==="tools/call").length,0);assert.ok(!JSON.stringify(result).includes(CANARY));
});
test("real SDK session: valid nested args dispatch once; bad output after write never retries",async t=>{
  const f=fakePeer(),s=await McpUpstreamSession.open(definition(),{},f.host);t.after(()=>s.close());
  await s.listTools();await assert.rejects(s.callTool("read",{nested:{}}),err("input_schema_invalid"));assert.equal(f.calls.filter(c=>c.method==="tools/call").length,0);
  f.setResult({content:[],structuredContent:{ok:"wrong"}});await assert.rejects(s.callTool("read",{nested:{value:2},extra:true}),err("output_schema_invalid"));assert.equal(f.calls.filter(c=>c.method==="tools/call").length,1);
  f.setResult({isError:true,content:[{type:"text",text:"semantic failure"}]});assert.equal((await s.callTool("read",{nested:{value:2}}) as {isError:boolean}).isError,true);
});
test("dual era: modern peer uses discovery/no initialize, legacy auto fallback only pre-effect",async t=>{
  const f=fakePeer([TOOL],true),s=await McpUpstreamSession.open(definition(),{},f.host);t.after(()=>s.close());assert.equal(s.protocolVersion,"2026-07-28");await s.listTools();await s.callTool("read",{nested:{value:2}});
  assert.equal(f.calls.filter(c=>c.method==="initialize").length,0);assert.equal(f.calls.filter(c=>c.method==="server/discover").length,1);assert.equal(f.calls.filter(c=>c.method==="tools/call").length,1);
  const legacy=fakePeer();legacy.host.protocolMode="auto";const l=await McpUpstreamSession.open(definition(),{},legacy.host);t.after(()=>l.close());assert.equal(l.protocolVersion,"2025-11-25");
});
test("dual era recognized modern probe errors never fall back to legacy initialize",async()=>{
  for(const code of [-32020,-32021,-32022]) {
    const f=fakePeer([TOOL],true);f.host.protocolMode="auto";f.setDiscoverError({code,message:"synthetic modern rejection"});
    await assert.rejects(McpUpstreamSession.open(definition(),{},f.host),e=>e instanceof McpConnectorError&&["protocol_unsupported","header_mismatch","connect_failed"].includes(e.code));assert.equal(f.calls.filter(c=>c.method==="initialize").length,0);assert.equal(f.calls.filter(c=>c.method==="tools/call").length,0);
  }
});
test("auto era accepts every unrecognized RPC discovery error and non-modern HTTP 4xx as legacy evidence",async t=>{
  for(const code of [-32600,-32602,-32001,-32099,42]) {
    const f=fakePeer();f.host.protocolMode="auto";f.setDiscoverError({code,message:"synthetic legacy probe rejection"});const session=await McpUpstreamSession.open(definition(),{},f.host);t.after(()=>session.close());
    assert.equal(session.protocolVersion,"2025-11-25");await session.listTools();assert.equal(f.calls.filter(c=>c.method==="initialize").length,1);assert.equal(f.calls.filter(c=>c.method==="tools/call").length,0);
  }
  for(const status of [400,404,405,409,422])for(const body of ["","legacy: unknown method",'{"message":"Missing session ID"}']) {
    const f=fakePeer();f.host.protocolMode="auto";f.setDiscoverReply({status,body});const session=await McpUpstreamSession.open(definition(),{},f.host);t.after(()=>session.close());
    assert.equal(session.protocolVersion,"2025-11-25");assert.equal(f.calls.filter(c=>c.method==="initialize").length,1);assert.equal(f.calls.filter(c=>c.method==="tools/call").length,0);
  }
  const malformed=fakePeer();malformed.host.protocolMode="auto";malformed.setDiscoverReply({status:400,body:'{"result":{"resultType":"complete","supportedVersions":[]}}'});
  await assert.rejects(McpUpstreamSession.open(definition(),{},malformed.host),err("protocol_unsupported"));assert.equal(malformed.calls.filter(c=>c.method==="initialize").length,0);
});
for(const mode of ["legacy","auto"] as const)test(`legacy ${mode} with private modern handler never advertises unsupported reverse elicitation`,async t=>{
  const f=fakePeer();f.host.protocolMode=mode;let privateCalls=0;
  f.host.inputRequired={authorized:()=>true,request:async()=>{privateCalls++;throw new Error("must not be called for legacy");}};
  const session=await McpUpstreamSession.open(definition(),{},f.host);t.after(()=>session.close());await session.listTools();
  f.setToolHandler(()=>{const initialized=f.calls.find(call=>call.method==="initialize")!;assert.deepEqual(initialized.params.capabilities,{},"this legacy peer would require a reverse elicitation handler if advertised");return {content:[],structuredContent:{ok:true}};});
  await session.callTool("read",{nested:{value:2}});assert.equal(privateCalls,0);assert.equal(session.protocolVersion,"2025-11-25");
  for(const call of f.calls) {const capabilities=((call.params._meta as Record<string,unknown>|undefined)?.["io.modelcontextprotocol/clientCapabilities"]??call.params.capabilities??{}) as object;assert.equal(Object.hasOwn(capabilities,"elicitation"),false);}
});
test("modern private form capability requires the canonical original action binding",async t=>{
  const f=fakePeer([TOOL],true);let privateCalls=0;f.host.inputRequired={authorized:()=>true,request:async()=>{privateCalls++;throw new Error("unbound request must not elicit");}};
  const session=await McpUpstreamSession.open(definition(),{},f.host);t.after(()=>session.close());await session.listTools();await session.callTool("read",{nested:{value:2}});
  assert.equal(privateCalls,0);const call=f.calls.find(call=>call.method==="tools/call")!;assert.deepEqual((call.params._meta as Record<string,unknown>)["io.modelcontextprotocol/clientCapabilities"],{});
});
for(const mode of ["legacy","modern","modern_error"])test(`stdio era negotiation ${mode}: actual pinned owned process, no effectful fallback`,async t=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-mcp-stdio-era-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,"peer.mjs"),log=join(dir,"calls.txt");
  writeFileSync(file,`import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';
const mode=${JSON.stringify(mode)},tool=${JSON.stringify(TOOL)};
for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);appendFileSync(${JSON.stringify(log)},m.method+'\\n');if(m.id===undefined)continue;let result,error;
if(m.method==='server/discover'){if(mode==='legacy')error={code:-32601,message:'Method not found'};else if(mode==='modern_error')error={code:-32020,message:'HeaderMismatch'};else result={resultType:'complete',supportedVersions:['2026-07-28'],_meta:{'io.modelcontextprotocol/serverInfo':{name:'synthetic',version:'1'}},capabilities:{tools:{}},ttlMs:0,cacheScope:'private'};}
else if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}};
else if(m.method==='tools/list')result={tools:[tool],...(mode==='modern'?{resultType:'complete',ttlMs:0,cacheScope:'private',_meta:{'io.modelcontextprotocol/serverInfo':{name:'synthetic',version:'1'}}}:{})};
else if(m.method==='tools/call')result={content:[],structuredContent:{ok:true},...(mode==='modern'?{resultType:'complete'}:{})};else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,...(error?{error}:{result})})+'\\n');}`);
  const d=checkMcpDefinition({id:"stdio",name:"Synthetic",transport:{type:"stdio",command:process.execPath,args:[file]},runsOn:"owner_mac",auth:"none"});
  if(d.transport.type!=="stdio")throw new Error("fixture");const pin=pinMcpStdioCommand(d.transport),host:McpRuntimeHost={runsOn:"owner_mac",stdioRoot:dir,protocolMode:"auto",stdioCommandPins:()=>pin};
  if(mode==="modern_error") {await assert.rejects(McpUpstreamSession.open(d,{},host),e=>e instanceof McpConnectorError);assert.ok(!readFileSync(log,"utf8").includes("initialize"));assert.ok(!readFileSync(log,"utf8").includes("tools/call"));return;}
  const session=await McpUpstreamSession.open(d,{},host);t.after(()=>session.close());assert.equal(session.protocolVersion,mode==="modern"?"2026-07-28":"2025-11-25");await session.listTools();await session.callTool("read",{nested:{value:2}});await session.close();
  const methods=readFileSync(log,"utf8").trim().split("\n");assert.equal(methods.filter(method=>method==="tools/call").length,1);assert.equal(methods.filter(method=>method==="initialize").length,mode==="legacy"?1:0);
});
test("private form is bounded, correlates responses, refuses secrets/url/sampling before handler",()=>{
  const req={r1:{method:"elicitation/create",params:{mode:"form",message:"Choose",requestedSchema:{type:"object",properties:{choice:{type:"string",enum:["a","b"]}},required:["choice"]}}}};
  validateMcpPrivateInputRequests(req);validateMcpPrivateInputResponses(req,{r1:{action:"accept",content:{choice:"a"}}});
  assert.throws(()=>validateMcpPrivateInputResponses(req,{r1:{action:"accept",content:{choice:"c"}}}),err("input_schema_invalid"));
  assert.throws(()=>validateMcpPrivateInputRequests({r1:{method:"elicitation/create",params:{mode:"url",message:"Login",url:"https://example.test"}}}),err("input_required"));
  assert.throws(()=>validateMcpPrivateInputRequests({r1:{method:"sampling/createMessage",params:{messages:[]}}}),err("input_required"));
  assert.throws(()=>validateMcpPrivateInputRequests({r1:{method:"elicitation/create",params:{message:"Secret",requestedSchema:{type:"object",properties:{password:{type:"string"}}}}}}),err("input_required"));
});
test("private forms reject normalized credential keys, visible credential labels and solicitations",()=>{
  const form=(key:string,property:Record<string,unknown>={type:"string"},message="Choose a value")=>({r1:{method:"elicitation/create",params:{mode:"form",message,requestedSchema:{type:"object",properties:{[key]:property}}}}});
  for(const key of ["client_secret","refresh_token","access_token","password_confirmation","passphrase","clientSecret","API_KEY","api-key","oauthCredential","bearerToken","privateKey","sessionToken","token_value","new_password","passwordConfirmation","userCredentials","oauth","Token","authCode","recoveryCode","ｃｌｉｅｎｔ＿ｓｅｃｒｅｔ"])
    assert.throws(()=>validateMcpPrivateInputRequests(form(key)),err("input_required"));
  for(const property of [{type:"string",title:"Password"},{type:"string",description:"Enter your API key"},{type:"string",title:"Refresh token"},{type:"string",format:"password"},{type:"string",writeOnly:true}])
    assert.throws(()=>validateMcpPrivateInputRequests(form("value",property,"No password required")),err("input_required"));
  for(const message of ["Paste your refresh token","Enter a password to continue","Cole sua chave de API","Informe sua senha","Provide a token"])
    assert.throws(()=>validateMcpPrivateInputRequests(form("value",{type:"string"},message)),err("input_required"));
});
test("private form nonsecret token measurements preserve schema; dynamic response credential keys and known values are refused",()=>{
  const requestedSchema={type:"object",properties:{tokenAmount:{type:"number",title:"Token amount"},tokenCount:{type:"integer"},tokenSymbol:{type:"string"}},additionalProperties:true};
  const req={r1:{method:"elicitation/create",params:{mode:"form",message:"Provide token amount (no password required).",requestedSchema}}};
  for(const extra of [{additionalProperties:{type:"string"}},{patternProperties:{"^extra_":{type:"string"}}}]) assert.throws(()=>validateMcpPrivateInputRequests({r1:{...req.r1,params:{...req.r1.params,requestedSchema:{...requestedSchema,...extra}}}}),err("input_required"));
  const before=JSON.stringify(req);validateMcpPrivateInputRequests(req);validateMcpPrivateInputResponses(req,{r1:{action:"accept",content:{tokenAmount:3,tokenCount:1,tokenSymbol:"DEX",extra_note:"ok"}}});assert.equal(JSON.stringify(req),before);
  for(const key of ["client_secret","refresh_token","access_token","password_confirmation","passphrase","extra_clientSecret"])
    assert.throws(()=>validateMcpPrivateInputResponses(req,{r1:{action:"accept",content:{tokenAmount:3,[key]:"synthetic-new-private-value"}}}),err("input_required"));
  assert.throws(()=>validateMcpPrivateInputResponses(req,{r1:{action:"accept",content:{extra_data:{passphrase:"synthetic-new-private-value"}}}}),err("input_required"));
  assert.throws(()=>validateMcpPrivateInputResponses(req,{r1:{action:"accept",content:{tokenSymbol:CANARY}}},[CANARY]),e=>{assert.ok(err("metadata_quarantined")(e));assert.ok(!String(e).includes(CANARY));return true;});
});
const logicalCall=():AdapterCall=>({toolkit:"mcp-synthetic",upstreamSlug:"read",version:"a".repeat(32),host:"synthetic.mcp.dexter.internal",upstreamUserId:"synthetic",upstreamAccountRef:"mcp:synthetic",arguments:{nested:{value:2}},idempotencyKey:"original-logical-call",connectionId:"connection-synthetic",
  scope:{installationId:"installation",ownerId:"owner",profileId:"work",botId:"bot",threadId:"thread",turnId:"turn"},actionId:"action-original",requestHash:"b".repeat(64),manifestHash:"c".repeat(64),toolRevision:1,connectionRevision:1});
test("MRTR actual SDK: private input resumes same logical effect once with new RPC ID and exact opaque state",async t=>{
  const f=fakePeer([TOOL],true),opaque="synthetic-opaque-state-private-219",call=logicalCall();let prompts=0;
  f.setToolHandler(params=>params.inputResponses?{content:[],structuredContent:{ok:true}}:{resultType:"input_required",requestState:opaque,inputRequests:{r1:{method:"elicitation/create",params:{mode:"form",message:"Choose",requestedSchema:{type:"object",properties:{choice:{type:"string",enum:["yes","no"]}},required:["choice"]}}}}});
  f.host.inputRequired={authorized:input=>input===call,request:async(input,requests)=>{assert.equal(input,call);assert.ok(!JSON.stringify(requests).includes(opaque));prompts++;return{r1:{action:"accept",content:{choice:"yes"}}};}};
  const s=await McpUpstreamSession.open(definition(),{},f.host);t.after(()=>s.close());await s.listTools();const out=await s.callTool("read",{nested:{value:2}},undefined,call);
  assert.equal((out as {isError:boolean}).isError,false);const legs=f.calls.filter(c=>c.method==="tools/call");assert.equal(legs.length,2);assert.notEqual(legs[0]!.id,legs[1]!.id);assert.equal(legs[1]!.params.requestState,opaque);assert.equal(prompts,1);
  const discovery=f.calls.find(c=>c.method==="server/discover")!;assert.deepEqual((discovery.params._meta as Record<string,unknown>)["io.modelcontextprotocol/clientCapabilities"],{});
  for(const leg of legs)assert.deepEqual((leg.params._meta as Record<string,unknown>)["io.modelcontextprotocol/clientCapabilities"],{elicitation:{form:{}}},"only bound modern tool requests advertise the implemented form handler");
});
test("MRTR secret form is refused before UI handoff and any resumed upstream request",async t=>{
  const f=fakePeer([TOOL],true),call=logicalCall();let privateCalls=0;
  f.setResult({resultType:"input_required",requestState:"synthetic-private-state",inputRequests:{r1:{method:"elicitation/create",params:{mode:"form",message:"Choose",requestedSchema:{type:"object",properties:{client_secret:{type:"string"}}}}}}});
  f.host.inputRequired={authorized:()=>true,request:async()=>{privateCalls++;return{r1:{action:"accept",content:{client_secret:"synthetic-new-private-value"}}};}};
  const session=await McpUpstreamSession.open(definition(),{},f.host);t.after(()=>session.close());await session.listTools();await assert.rejects(session.callTool("read",{nested:{value:2}},undefined,call),err("input_required"));assert.equal(privateCalls,0);assert.equal(f.calls.filter(c=>c.method==="tools/call").length,1);
});
test("MRTR dynamic response credential is refused before a second RPC without logging or forwarding its value",async t=>{
  const f=fakePeer([TOOL],true),call=logicalCall(),value="synthetic-new-private-value-c9836";let privateCalls=0;
  f.setResult({resultType:"input_required",requestState:"synthetic-private-state",inputRequests:{r1:{method:"elicitation/create",params:{mode:"form",message:"Choose",requestedSchema:{type:"object",properties:{choice:{type:"string"}},additionalProperties:true}}}}});
  f.host.inputRequired={authorized:()=>true,request:async()=>{privateCalls++;return{r1:{action:"accept",content:{choice:"yes",refresh_token:value}}};}};
  const session=await McpUpstreamSession.open(definition(),{},f.host);t.after(()=>session.close());await session.listTools();await assert.rejects(session.callTool("read",{nested:{value:2}},undefined,call),e=>{assert.ok(err("input_required")(e));assert.ok(!String(e).includes(value));return true;});assert.equal(privateCalls,1);assert.equal(f.calls.filter(c=>c.method==="tools/call").length,1);assert.ok(!JSON.stringify(f.calls).includes(value));
});
test("MRTR revoked during private input cannot dispatch a second round",async t=>{
  const f=fakePeer([TOOL],true),call=logicalCall();let authorized=true;
  f.setResult({resultType:"input_required",requestState:"synthetic-private-state",inputRequests:{r1:{method:"elicitation/create",params:{message:"Choose",requestedSchema:{type:"object",properties:{choice:{type:"boolean"}},required:["choice"]}}}}});
  f.host.inputRequired={authorized:()=>authorized,request:async()=>{authorized=false;return{r1:{action:"accept",content:{choice:true}}};}};
  const s=await McpUpstreamSession.open(definition(),{},f.host);t.after(()=>s.close());await s.listTools();await assert.rejects(s.callTool("read",{nested:{value:2}},undefined,call),err("aborted"));assert.equal(f.calls.filter(c=>c.method==="tools/call").length,1);
});
test("MRTR Stop aborts a pending private input immediately without re-dispatch",async t=>{
  const f=fakePeer([TOOL],true),call=logicalCall(),abort=new AbortController();let requested!:()=>void;const ready=new Promise<void>(resolve=>{requested=resolve;});
  f.setResult({resultType:"input_required",requestState:"synthetic-private-state",inputRequests:{r1:{method:"elicitation/create",params:{message:"Choose",requestedSchema:{type:"object",properties:{choice:{type:"boolean"}}}}}}});
  f.host.inputRequired={authorized:()=>true,request:async()=>{requested();return new Promise<Record<string,unknown>>(()=>{});}};
  const s=await McpUpstreamSession.open(definition(),{},f.host);t.after(()=>s.close());await s.listTools();const pending=s.callTool("read",{nested:{value:2}},abort.signal,call);await ready;abort.abort();await assert.rejects(pending,err("aborted"));assert.equal(f.calls.filter(c=>c.method==="tools/call").length,1);
});
test("modern HeaderMismatch is not retried or downgraded after a tool dispatch",async t=>{
  const f=fakePeer([TOOL],true);f.setToolHandler(()=>({syntheticError:{code:-32020,message:"HeaderMismatch"}}));const s=await McpUpstreamSession.open(definition(),{},f.host);t.after(()=>s.close());await s.listTools();
  await assert.rejects(s.callTool("read",{nested:{value:2}}),err("header_mismatch"));assert.equal(f.calls.filter(c=>c.method==="tools/call").length,1);assert.equal(f.calls.filter(c=>c.method==="initialize").length,0);
});
test("stdio executable/argv/script pins detect source replacement and do not execute during review",t=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-mcp-codepin-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,"synthetic.sh");
  writeFileSync(file,"echo synthetic-one\n");const transport={type:"stdio" as const,command:"/bin/sh",args:[file],cwd:dir,env:{},searchPath:["/bin"]};
  const pin=pinMcpStdioCommand(transport);assert.equal(verifyMcpStdioCommand(transport,pin),"/bin/sh");writeFileSync(file,"echo synthetic-two\n");assert.throws(()=>verifyMcpStdioCommand(transport,pin),err("command_changed"));
  assert.throws(()=>verifyMcpStdioCommand({...transport,args:[file,"--new-effect"]},pin),err("command_changed"));
});
test("stdio command status is value-free, placement-aware and never spawns or replaces the reviewed pin",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-mcp-command-status-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const command=join(dir,"synthetic.sh"),marker=join(dir,"must-not-execute");writeFileSync(command,`#!/bin/sh\ntouch '${marker}'\n`,{mode:0o700});
  const transport={type:"stdio" as const,command,args:["--private-argument-value"],cwd:dir,env:{},searchPath:["/bin"]},pin=pinMcpStdioCommand(transport);
  const store=new HostStore({dataDir:dir}),runtime=new NativeMcpRuntime({host:{runsOn:"owner_mac",stdioRoot:dir,stdioCommandPins:id=>id==="reviewed"?pin:null}}),gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});
  runtime.bind(store,gateway);t.after(async()=>{await runtime.close();gateway.close();store.close();});
  for(const [id,runsOn] of [["reviewed","owner_mac"],["unreviewed","owner_mac"],["elsewhere","cloud"]] as const)runtime.admin.addServer({definition:{id,name:id,transport,runsOn,auth:"none"}});
  runtime.admin.addServer({definition:definition()});assert.deepEqual(runtime.admin.commandStatus("synthetic"),{reviewed:null,current:null,state:"not_stdio"});
  assert.equal(runtime.admin.commandStatus("unreviewed").state,"unreviewed");assert.equal(runtime.admin.commandStatus("elsewhere").state,"unavailable");assert.equal(runtime.admin.commandStatus("elsewhere").current,null);
  const first=runtime.admin.commandStatus("reviewed");assert.equal(first.state,"unchanged");assert.equal(first.current!.sizeBytes,readFileSync(command).byteLength);assert.ok(Object.isFrozen(first));assert.ok(Object.isFrozen(first.current));assert.ok(!JSON.stringify(first).includes("--private-argument-value"));assert.ok(!existsSync(marker));
  writeFileSync(command,"#!/bin/sh\nexit 0\n");const changed=runtime.admin.commandStatus("reviewed");assert.equal(changed.state,"changed");assert.deepEqual(changed.reviewed,first.reviewed);assert.notEqual(changed.current!.sha256,first.current!.sha256);
  rmSync(command);const unavailable=runtime.admin.commandStatus("reviewed");assert.equal(unavailable.state,"unavailable");assert.deepEqual(unavailable.reviewed,first.reviewed);assert.equal(unavailable.current,null);assert.ok(!existsSync(marker));
});
test("persistent stdio session refuses a missing reviewed pin before spawn on the owner Mac",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-mcp-unreviewed-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const command=join(dir,"synthetic.sh"),marker=join(dir,"must-not-execute");writeFileSync(command,`#!/bin/sh\ntouch '${marker}'\n`,{mode:0o700});
  const d=checkMcpDefinition({id:"unreviewed",name:"Synthetic",transport:{type:"stdio",command},runsOn:"owner_mac",auth:"none"});
  await assert.rejects(McpUpstreamSession.open(d,{}, {runsOn:"owner_mac",stdioRoot:dir,stdioCommandPins:()=>null}),err("command_changed"));assert.ok(!existsSync(marker));
});
test("pinned HTTP discovery refuses stale pins and stdio before custody, network, pin writes or spawn",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-mcp-http-discovery-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const f=fakePeer();let custodyReads=0;const store=new HostStore({dataDir:dir}),runtime=new NativeMcpRuntime({host:f.host,credentials:{custody:{kind:"synthetic",read:async()=>{custodyReads++;return CANARY;}}}}),gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});
  runtime.bind(store,gateway);t.after(async()=>{await runtime.close();gateway.close();store.close();});
  runtime.admin.addServer({definition:definition()});runtime.admin.addServer({definition:{...definition(),id:"broker",auth:"broker",transport:{type:"streamable_http",url:"https://mcp.example.test/mcp",headers:{authorization:{kind:"secret",key:"headers.authorization"}}}}});
  const command=join(dir,"synthetic.sh"),marker=join(dir,"must-not-spawn");writeFileSync(command,`#!/bin/sh\ntouch '${marker}'\n`,{mode:0o700});runtime.admin.addServer({definition:{id:"local",name:"Local",runsOn:"owner_mac",auth:"none",transport:{type:"stdio",command}}});
  const wrongPin="0".repeat(64);
  await assert.rejects(runtime.admin.discover("broker",{expectedInstancePin:wrongPin,httpOnly:true}),err("store_conflict"));
  await assert.rejects(runtime.admin.discover("synthetic",{expectedInstancePin:"not-a-hash",httpOnly:true}),err("invalid_definition"));
  await assert.rejects(runtime.admin.discover("synthetic",{httpOnly:true}),err("invalid_definition"));
  await assert.rejects(runtime.admin.discover("local",{expectedInstancePin:runtime.admin.instancePin("local"),httpOnly:true}),err("invalid_definition"));
  assert.equal(custodyReads,0);assert.equal(f.calls.length,0);assert.ok(!existsSync(marker));assert.equal(runtime.admin.commandStatus("local").state,"unreviewed");
  const locked=await runtime.admin.discover("broker",{expectedInstancePin:runtime.admin.instancePin("broker"),httpOnly:true});assert.equal(locked.server.status,"needs_auth");assert.equal(custodyReads,0);assert.equal(f.calls.length,0,"HTTP-only workflow cannot implicitly unlock custody");
  const scope={expectedInstancePin:runtime.admin.instancePin("synthetic"),httpOnly:true as const,unlockCredentials:false as const};const pending=runtime.admin.discover("synthetic",scope);scope.expectedInstancePin=wrongPin;
  const ready=await pending;assert.equal(ready.server.status,"ready","review scope is captured immutably before the first await");assert.equal(ready.tools.length,1);assert.equal(f.calls.filter(call=>call.method==="tools/call").length,0);assert.equal(custodyReads,0);assert.ok(!existsSync(marker));
});
test("circuit uses only no-effect list probe and never retries failing writes",async t=>{
  const f=fakePeer(),base=f.host.fetch!;let now=1000,toolPosts=0,fail=true;
  f.host.now=()=>now;f.host.fetch=(async(url,init)=>{const message=init?.body?JSON.parse(init.body as string) as {method:string}:null;
    if(message?.method==="tools/call"){toolPosts++;if(fail)return new Response(null,{status:503});}return base(url,init);}) as typeof globalThis.fetch;
  const d=definition(),probe=await probeMcpServer(d,{},f.host);assert.equal(probe.state,"ready");if(probe.state!=="ready")return;
  const adapter=new McpToolAdapter({servers:new McpServerInventory([d]),catalog:new McpToolCatalog(d.id,probe.tools),host:f.host});t.after(()=>adapter.close());
  const call={...logicalCall(),version:probe.tools[0]!.manifest!.version};
  for(let n=0;n<3;n++)await assert.rejects(adapter.execute(call,{headers:{}},{signal:new AbortController().signal}),err("upstream_status"));assert.equal(toolPosts,3);
  await assert.rejects(adapter.execute(call,{headers:{}},{signal:new AbortController().signal}),err("circuit_open"));assert.equal(toolPosts,3);
  now=100000;fail=false;const lists=f.calls.filter(c=>c.method==="tools/list").length;await adapter.execute(call,{headers:{}},{signal:new AbortController().signal});assert.ok(f.calls.filter(c=>c.method==="tools/list").length>lists);assert.equal(toolPosts,4);assert.deepEqual(adapter.circuitStatus(),[]);
});
test("cross-DB real Hub: lost acknowledgement reconciles original receipt by GET without repeating grant",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-mcp-grants-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let store=new HostStore({dataDir:dir}),f=fakePeer(),runtime=new NativeMcpRuntime({host:f.host}),gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});
  gateway.setNativeMcpArgumentValidator(validateNativeMcpArguments);runtime.bind(store,gateway);
  const bot=store.createBot({name:"Synthetic",profileId:"work",engine:"codex"});runtime.admin.addServer({definition:definition()});await runtime.admin.discover("synthetic");
  const apply=store.applyGrantBatch.bind(store);let writes=0;
  store.applyGrantBatch=(input:unknown)=>{writes++;apply(input);throw new Error("synthetic lost ACK");};
  assert.throws(()=>runtime.admin.setBotSelection("synthetic",bot.id,{toolIds:["mcp.synthetic.read"],policy:"ask"}),err("store_conflict"));assert.equal(writes,1);
  const receiptDB=new DatabaseSync(join(dir,"native-mcp.sqlite"));const rows=receiptDB.prepare("SELECT value FROM meta WHERE key LIKE 'mcp-grants:%'").all();receiptDB.close();assert.ok(rows.some(row=>String(row.value).includes('"state":"prepared"')));
  await runtime.close();gateway.close();store.close();
  store=new HostStore({dataDir:dir});f=fakePeer();runtime=new NativeMcpRuntime({host:f.host});gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});gateway.setNativeMcpArgumentValidator(validateNativeMcpArguments);
  let recoveryWrites=0;const recoveredApply=store.applyGrantBatch.bind(store);store.applyGrantBatch=(input:unknown)=>{recoveryWrites++;return recoveredApply(input);};runtime.bind(store,gateway);
  assert.deepEqual(runtime.admin.botSelection("synthetic",bot.id).toolIds,["mcp.synthetic.read"]);assert.equal(recoveryWrites,0);assert.equal(f.calls.length,0,"restart fetches neither provider nor server");
  await runtime.close();gateway.close();store.close();
  assert.ok(!readFileSync(join(dir,"native-mcp.sqlite")).includes(Buffer.from(CANARY)));
});
test("catalog metadata canary never enters native SQLite; corrected definition clears quarantine and changed pin revokes selection",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-mcp-quarantine-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const tools:Record<string,unknown>[]=[{...TOOL}];
  const f=fakePeer(tools),store=new HostStore({dataDir:dir}),runtime=new NativeMcpRuntime({host:f.host}),gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});
  gateway.setNativeMcpArgumentValidator(validateNativeMcpArguments);runtime.bind(store,gateway);t.after(async()=>{await runtime.close();gateway.close();store.close();});
  const bot=store.createBot({name:"Synthetic",profileId:"work",engine:"codex"});runtime.admin.addServer({definition:definition()});await runtime.admin.discover("synthetic");runtime.admin.setBotSelection("synthetic",bot.id,{toolIds:["mcp.synthetic.read"],policy:"ask"});
  const connection=gateway.registry.listConnections("work")[0]!;tools[0]={...TOOL,description:CANARY};const bad=await runtime.admin.discover("synthetic");assert.equal(bad.server.status,"ready");assert.equal(bad.tools[0]!.state,"unsupported_schema");assert.match(bad.tools[0]!.description,/quarantined/);assert.deepEqual(runtime.admin.botSelection("synthetic",bot.id).toolIds,[]);assert.equal(store.getGrant(bot.id,"mcp.synthetic.read",connection.id)!.policy,"deny");assert.ok(!JSON.stringify(bad).includes(CANARY));
  for(const suffix of ["","-wal"]) {const path=join(dir,`native-mcp.sqlite${suffix}`);try{assert.ok(!readFileSync(path).includes(Buffer.from(CANARY)));}catch(error){if((error as {code?:string}).code!=="ENOENT")throw error;}}
  tools[0]={...TOOL,description:"Updated safe definition"};await runtime.admin.discover("synthetic");assert.equal(runtime.admin.quarantineStatus("synthetic"),null);assert.deepEqual(runtime.admin.botSelection("synthetic",bot.id).toolIds,[]);assert.equal(store.getGrant(bot.id,"mcp.synthetic.read",connection.id)!.policy,"deny");assert.deepEqual(runtime.admin.catalogChanges("synthetic")!.changed,["mcp.synthetic.read"]);
});
test("cross-DB prepared intent without a canonical Hub receipt never creates a grant on restart",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-mcp-no-receipt-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let store=new HostStore({dataDir:dir}),f=fakePeer(),runtime=new NativeMcpRuntime({host:f.host}),gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});gateway.setNativeMcpArgumentValidator(validateNativeMcpArguments);runtime.bind(store,gateway);
  const bot=store.createBot({name:"Synthetic",profileId:"work",engine:"codex"});runtime.admin.addServer({definition:definition()});await runtime.admin.discover("synthetic");store.applyGrantBatch=()=>{throw new Error("synthetic failure before commit");};
  assert.throws(()=>runtime.admin.setBotSelection("synthetic",bot.id,{toolIds:["mcp.synthetic.read"],policy:"ask"}),err("store_conflict"));const connection=gateway.registry.listConnections("work")[0]!;assert.equal(store.getGrant(bot.id,"mcp.synthetic.read",connection.id),null);
  await runtime.close();gateway.close();store.close();store=new HostStore({dataDir:dir});f=fakePeer();runtime=new NativeMcpRuntime({host:f.host});gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});gateway.setNativeMcpArgumentValidator(validateNativeMcpArguments);let writes=0;store.applyGrantBatch=()=>{writes++;throw new Error("must not run");};runtime.bind(store,gateway);
  assert.deepEqual(runtime.admin.botSelection("synthetic",bot.id).toolIds,[]);assert.equal(store.getGrant(bot.id,"mcp.synthetic.read",connection.id),null);assert.equal(writes,0);await runtime.close();gateway.close();store.close();
});
test("modern subscription listChanged revalidates native catalog and revokes stale pin without auto-grant",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-mcp-subscription-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const tools:Record<string,unknown>[]=[{...TOOL}],f=fakePeer(tools,true,true);
  const store=new HostStore({dataDir:dir}),runtime=new NativeMcpRuntime({host:f.host}),gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});gateway.setNativeMcpArgumentValidator(validateNativeMcpArguments);runtime.bind(store,gateway);t.after(async()=>{await runtime.close();gateway.close();store.close();});
  const bot=store.createBot({name:"Synthetic",profileId:"work",engine:"codex"});runtime.admin.addServer({definition:definition()});await runtime.admin.discover("synthetic");runtime.admin.setBotSelection("synthetic",bot.id,{toolIds:["mcp.synthetic.read"],policy:"ask"});const connection=gateway.registry.listConnections("work")[0]!,version=gateway.registry.getTool("mcp.synthetic.read")!.manifest.version;
  await runtime.adapter.execute({...logicalCall(),connectionId:connection.id,version,scope:{...logicalCall().scope,installationId:store.hostId,ownerId:store.ownerId,botId:bot.id}},{headers:{}},{signal:new AbortController().signal});
  tools[0]={...TOOL,description:"New safe published definition"};assert.equal(f.notify(),1);
  const until=Date.now()+1500;while(runtime.admin.botSelection("synthetic",bot.id).toolIds.length&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(runtime.admin.botSelection("synthetic",bot.id).toolIds,[]);assert.equal(store.getGrant(bot.id,"mcp.synthetic.read",connection.id)!.policy,"deny");assert.equal(f.calls.filter(c=>c.method==="tools/call").length,1);assert.ok(f.calls.some(c=>c.method==="subscriptions/listen"));
});
test("stdio listChanged invalidates readiness and closes its owned process without automatically spawning discovery",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-mcp-stdio-notify-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,"peer.mjs"),log=join(dir,"calls.txt");
  writeFileSync(file,`import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';const log=${JSON.stringify(log)},tool=${JSON.stringify(TOOL)};appendFileSync(log,'spawn:'+process.pid+'\\n');
for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);appendFileSync(log,m.method+'\\n');if(m.id===undefined)continue;let result;
if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{listChanged:true}},serverInfo:{name:'synthetic',version:'1'}};
else if(m.method==='tools/list')result={tools:[tool]};else if(m.method==='tools/call'){result={content:[],structuredContent:{ok:true}};setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})+'\\n'),30);}else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}`);
  const store=new HostStore({dataDir:dir}),runtime=new NativeMcpRuntime({host:{runsOn:"owner_mac",stdioRoot:join(dir,"runtime-home"),protocolMode:"legacy"}}),gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});gateway.setNativeMcpArgumentValidator(validateNativeMcpArguments);runtime.bind(store,gateway);t.after(async()=>{await runtime.close();gateway.close();store.close();});
  const bot=store.createBot({name:"Synthetic",profileId:"work",engine:"codex"});runtime.admin.addServer({definition:{id:"synthetic",name:"Synthetic",runsOn:"owner_mac",auth:"none",readOnlyTools:["read"],transport:{type:"stdio",command:process.execPath,args:[file]}}});await runtime.admin.discover("synthetic");runtime.admin.setBotSelection("synthetic",bot.id,{toolIds:["mcp.synthetic.read"],policy:"ask"});const connection=gateway.registry.listConnections("work")[0]!,version=gateway.registry.getTool("mcp.synthetic.read")!.manifest.version;
  await runtime.adapter.execute({...logicalCall(),connectionId:connection.id,version,scope:{...logicalCall().scope,installationId:store.hostId,ownerId:store.ownerId,botId:bot.id}},{headers:{}},{signal:new AbortController().signal});
  const ownPids=()=>readFileSync(log,"utf8").split("\n").filter(line=>line.startsWith("spawn:")).map(line=>Number(line.slice(6)));
  const running=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
  const until=Date.now()+2500;while((runtime.admin.listServers()[0]!.status!=="failed"||ownPids().some(running))&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
  const status=runtime.admin.listServers()[0]!;assert.equal(status.status,"failed");assert.equal(status.diagnostic!.code,"tool_changed");assert.equal(ownPids().length,2,"one explicit discovery and one requested call; notification must not spawn a third process");assert.ok(!ownPids().some(running));assert.equal(readFileSync(log,"utf8").split("\n").filter(line=>line==="tools/call").length,1);
});
test("library native bind installs exact schema validation for fresh and restarted catalogs without a host hook",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-mcp-library-bind-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));let botId="";
  for(let phase=0;phase<2;phase++) {
    const f=fakePeer(),store=new HostStore({dataDir:dir}),runtime=new NativeMcpRuntime({host:f.host}),gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});
    try {
      runtime.bind(store,gateway); // Deliberately no HostServices or manual schema hook.
      if(phase===0){botId=store.createBot({name:"Synthetic",profileId:"work",engine:"codex"}).id;runtime.admin.addServer({definition:definition()});await runtime.admin.discover("synthetic");}
      else assert.equal(f.calls.length,0,"restart reads the saved catalog without upstream traffic");
      runtime.admin.setBotSelection("synthetic",botId,{toolIds:["mcp.synthetic.read"],policy:"ask"});const connection=gateway.registry.listConnections("work")[0]!,registered=gateway.registry.getTool("mcp.synthetic.read")!;
      assert.deepEqual(registered.manifest.nativeInputSchema,TOOL.inputSchema);
      const thread=store.createThread(botId),{turn}=store.createTurn(thread.id,{clientRequestId:`phase-${phase}`,content:"synthetic"});store.claimNextTurn(thread.id);const capability=gateway.issueCapability({turnId:turn.id}).token;
      const posts=f.calls.filter(c=>c.method==="tools/call").length;
      await assert.rejects(gateway.call(capability,{tool:"mcp.synthetic.read",connectionId:connection.id,callId:`bad-${phase}`,arguments:{nested:{value:"invalid"}}}),e=>e instanceof GatewayError&&e.code==="invalid_input");assert.equal(f.calls.filter(c=>c.method==="tools/call").length,posts);
      await assert.rejects(runtime.adapter.execute({...logicalCall(),version:registered.manifest.version,connectionId:connection.id,arguments:{nested:{value:"invalid"}},scope:{installationId:store.hostId,ownerId:store.ownerId,botId,profileId:"work",threadId:thread.id,turnId:turn.id}},{headers:{}},{signal:new AbortController().signal}),e=>e instanceof ToolExecutionFailure&&e.code==="input_schema_invalid"&&e.phase==="before_dispatch");assert.equal(f.calls.filter(c=>c.method==="tools/call").length,posts);
      const input={tool:"mcp.synthetic.read",connectionId:connection.id,callId:`valid-${phase}`,arguments:{nested:{value:2,safeExtra:true},safeExtra:"allowed by original schema"}};
      const asked=await gateway.call(capability,input);assert.equal(asked.status,"awaiting_approval");store.decideAction(asked.actionId,{decision:"allow",requestHash:asked.requestHash});const outcome=await gateway.call(capability,input);assert.equal(outcome.status,"succeeded");assert.equal(f.calls.filter(c=>c.method==="tools/call").length,posts+1);
    }finally{await runtime.close();gateway.close();store.close();}
  }
});
test("native schema hook is idempotent only for the same function and rejects replacement or stopped admission",t=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-mcp-validator-once-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const store=new HostStore({dataDir:dir}),gateway=new CapabilityGateway({store,broker:{acquire:()=>null,secretValues:()=>[]},adapter:{execute:async()=>({})}});t.after(()=>{gateway.close();store.close();});
  gateway.setNativeMcpArgumentValidator(validateNativeMcpArguments);gateway.setNativeMcpArgumentValidator(validateNativeMcpArguments);
  assert.throws(()=>gateway.setNativeMcpArgumentValidator(()=>{}),e=>(e as {code?:string}).code==="conflict");gateway.stopAdmission();assert.throws(()=>gateway.setNativeMcpArgumentValidator(validateNativeMcpArguments),e=>(e as {code?:string}).code==="conflict");
});
test("remove and recreate clears local command evidence and requires a new human discovery pin",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-mcp-recreate-pin-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,"peer.mjs");
  const program=`import{createInterface}from'node:readline';const tool=${JSON.stringify(TOOL)};for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}}:{tools:[tool]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}`;
  writeFileSync(file,program);const store=new HostStore({dataDir:dir}),runtime=new NativeMcpRuntime({host:{runsOn:"owner_mac",stdioRoot:join(dir,"home")}}),gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});runtime.bind(store,gateway);t.after(async()=>{await runtime.close();gateway.close();store.close();});
  const definition={id:"synthetic",name:"Synthetic",runsOn:"owner_mac",auth:"none",transport:{type:"stdio",command:process.execPath,args:[file]}};
  runtime.admin.addServer({definition});await runtime.admin.discover("synthetic");const before=runtime.admin.commandStatus("synthetic").reviewed!,instance=runtime.admin.instancePin("synthetic");assert.equal(runtime.admin.commandStatus("synthetic").state,"unchanged");
  writeFileSync(file,program+"\n// New owner-reviewed source revision\n");assert.equal(runtime.admin.commandStatus("synthetic").state,"changed");
  await runtime.admin.removeServer("synthetic");runtime.admin.addServer({definition});assert.notEqual(runtime.admin.instancePin("synthetic"),instance);assert.equal(runtime.admin.commandStatus("synthetic").state,"unreviewed");assert.equal(runtime.admin.commandStatus("synthetic").reviewed,null);assert.equal(runtime.admin.catalogChanges("synthetic"),null);assert.equal(runtime.admin.quarantineStatus("synthetic"),null);
  const db=new DatabaseSync(join(dir,"native-mcp.sqlite"));const historical=Number(db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'mcp-grants:%'").get()!.n);db.close();assert.ok(historical>0,"immutable historical intent/receipt journal survives removal");
  assert.equal((await runtime.admin.discover("synthetic")).server.status,"ready");const after=runtime.admin.commandStatus("synthetic");assert.equal(after.state,"unchanged");assert.notEqual(after.reviewed!.argsHash,before.argsHash);
});
test("production HostServices auto-discovers reviewed owner loopback; cloud refuses the same definition before any request",async t=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),"dexter-mcp-production-loopback-")));t.after(()=>rmSync(dir,{recursive:true,force:true}));let requests=0;
  const peer=createServer((req,res)=>{let body="";req.on("data",part=>body+=part.toString());req.on("end",()=>{requests++;if(req.method!=="POST"){res.writeHead(405).end();return;}const m=JSON.parse(body) as {id?:unknown;method:string};if(m.id===undefined){res.writeHead(202).end();return;}if(m.method==="server/discover"){res.writeHead(400,{"content-type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:m.id,error:{code:-32600,message:"Missing session ID"}}));return;}const result=m.method==="initialize"?{protocolVersion:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"synthetic",version:"1"}}:{tools:[TOOL]};res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:m.id,result}));});});
  await new Promise<void>(resolve=>peer.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise<void>((resolve,reject)=>peer.close(error=>error?reject(error):resolve())));
  const d={...definition(),transport:{type:"streamable_http",url:`http://127.0.0.1:${(peer.address() as AddressInfo).port}/mcp`},runsOn:"any"};
  const owner=new HostServices({dataDir:join(dir,"owner"),enableEngines:true,engineCommands:{codex:"/usr/bin/false"},enableMcp:true,nativeMcp:{runsOn:"owner_mac"}});t.after(()=>owner.shutdown());owner.nativeMcpAdmin.addServer({definition:d});assert.equal((await owner.nativeMcpAdmin.discover("synthetic")).server.status,"ready");const prior=requests;assert.ok(prior>=3);
  const cloud=new HostServices({dataDir:join(dir,"cloud"),enableEngines:true,engineCommands:{codex:"/usr/bin/false"},enableMcp:true,nativeMcp:{runsOn:"cloud"}});t.after(()=>cloud.shutdown());cloud.nativeMcpAdmin.addServer({definition:d});const rejected=await cloud.nativeMcpAdmin.discover("synthetic");assert.equal(rejected.server.status,"failed");assert.equal(rejected.server.diagnostic!.code,"egress_refused");assert.equal(requests,prior);
  const invalidDir=join(dir,"invalid");assert.throws(()=>new HostServices({dataDir:invalidDir,enableEngines:true,engineCommands:{codex:"/usr/bin/false"},enableMcp:true,nativeMcp:{runsOn:"cloud",privateOrigins:["https://private.example.test"]}}),e=>(e as {code?:string}).code==="invalid_input");assert.equal(existsSync(invalidDir),false,"startup config validation precedes opening a store");
});
test("OAuth private issuer requires explicit startup review, is not inferred from resource metadata, and exposes egress refusal",async t=>{
  const resource="http://127.0.0.1:19012/mcp",issuer="http://127.0.0.1:19013";let issuerRequests=0;
  const network:McpEgressNetwork={lookup:async()=>{throw new Error("literal loopback fixture does not resolve DNS");},request:async(url)=>{if(url.origin===issuer){issuerRequests++;return Response.json({issuer,authorization_endpoint:issuer+"/authorize",token_endpoint:issuer+"/token",response_types_supported:["code"],code_challenge_methods_supported:["S256"]});}return Response.json({resource,authorization_servers:[issuer]});}};
  const d=checkMcpDefinition({...definition(),auth:"oauth",transport:{type:"streamable_http",url:resource}}),unreviewed=new McpOAuthClient({egressPolicy:{placement:"owner_mac"},egressNetwork:network});t.after(()=>unreviewed.close());
  await assert.rejects(unreviewed.begin(d,{clientId:"synthetic-public-client"}),err("egress_refused"));assert.equal(unreviewed.status(d).lastError,"egress_refused");assert.equal(issuerRequests,0);
  const reviewed=new McpOAuthClient({egressPolicy:checkMcpEgressPolicy({placement:"owner_mac",privateOrigins:[issuer]}),egressNetwork:network});t.after(()=>reviewed.close());const start=await reviewed.begin(d,{clientId:"synthetic-public-client"});assert.equal(new URL(start.authorizationUrl).origin,issuer);assert.ok(issuerRequests>0);
});
test("native aggregate catalog: 150 independently bounded tools survive discovery, durable selection and restart",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-mcp-large-catalog-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const tools=Array.from({length:150},(_,n)=>({...TOOL,name:`read_${n}`,description:"Synthetic "+"x".repeat(2048)}));let botId="";
  for(let phase=0;phase<2;phase++) {
    const f=fakePeer(tools),store=new HostStore({dataDir:dir}),runtime=new NativeMcpRuntime({host:f.host}),gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});
    try{runtime.bind(store,gateway);if(phase===0){botId=store.createBot({name:"Synthetic",profileId:"work",engine:"codex"}).id;runtime.admin.addServer({definition:definition()});const result=await runtime.admin.discover("synthetic");assert.equal(result.server.status,"ready");assert.equal(result.tools.length,150);runtime.admin.setBotSelection("synthetic",botId,{toolIds:["mcp.synthetic.read_149"],policy:"ask"});}
      else{assert.equal(f.calls.length,0);assert.equal(runtime.admin.tools("synthetic").length,150);assert.deepEqual(runtime.admin.botSelection("synthetic",botId).toolIds,["mcp.synthetic.read_149"]);}
      const db=new DatabaseSync(join(dir,"native-mcp.sqlite"));for(const row of db.prepare("SELECT value FROM meta WHERE key LIKE 'mcp-grants:%'").all()){const value=JSON.parse(String(row.value));if(value.state==="completed")assert.equal(value.catalog,null,"completed journal does not retain another catalog copy");}db.close();
    }finally{await runtime.close();gateway.close();store.close();}
  }
  const f=fakePeer([...tools,{...TOOL,name:"too_big",description:"x".repeat(256*1024+1)}]),result=await probeMcpServer(definition(),{},f.host);assert.equal(result.state,"ready");if(result.state!=="ready")throw new Error("healthy definitions remain available");assert.equal(result.tools.find(tool=>tool.mcpName==="too_big")!.status,"unsupported_schema");assert.equal(result.tools.filter(tool=>tool.status==="publishable").length,tools.length);
  const contaminated=fakePeer([...tools,{...TOOL,name:"late_canary",description:CANARY}]),quarantined=await probeMcpServer(definition(),{},contaminated.host);assert.equal(quarantined.state,"ready");assert.ok(!JSON.stringify(quarantined).includes(CANARY));if(quarantined.state!=="ready")throw new Error("healthy definitions remain available");assert.equal(quarantined.tools.find(tool=>tool.mcpName==="late_canary")!.status,"unsupported_schema");assert.equal(quarantined.tools.filter(tool=>tool.status==="publishable").length,tools.length);
});
test("legacy normalization migration preserves unchanged upstream selections and re-pins calls; actual upstream change revokes",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-mcp-format-upgrade-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const tools:Record<string,unknown>[]=[{name:"read",description:"Read synthetic",inputSchema:{type:"object",properties:{pageSize:{type:"integer",minimum:1}},required:["pageSize"]}}];
  let f=fakePeer(tools),store=new HostStore({dataDir:dir}),runtime=new NativeMcpRuntime({host:f.host}),gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});runtime.bind(store,gateway);const bot=store.createBot({name:"Synthetic",profileId:"work",engine:"codex"});runtime.admin.addServer({definition:definition()});await runtime.admin.discover("synthetic");runtime.admin.setBotSelection("synthetic",bot.id,{toolIds:["mcp.synthetic.read"],policy:"ask"});await runtime.close();gateway.close();store.close();
  // Synthetic historical on-disk fixture uses the baseline's flat/snake_case normalization; raw version stays pinned.
  const db=new DatabaseSync(join(dir,"native-mcp.sqlite")),catalog=JSON.parse(String(db.prepare("SELECT tools FROM catalogs WHERE server_id='synthetic'").get()!.tools));const manifest=catalog[0].manifest;delete manifest.nativeInputSchema;delete manifest.nativeOutputSchema;manifest.inputSchema={type:"object",properties:{page_size:{type:"integer",minimum:1}},required:["page_size"],additionalProperties:false};catalog[0].argumentNames={page_size:"pageSize"};db.prepare("UPDATE catalogs SET tools=? WHERE server_id='synthetic'").run(JSON.stringify(catalog));db.close();
  f=fakePeer(tools);store=new HostStore({dataDir:dir});runtime=new NativeMcpRuntime({host:f.host});gateway=new CapabilityGateway({store,broker:runtime.broker,adapter:runtime.adapter});runtime.bind(store,gateway);t.after(async()=>{await runtime.close();gateway.close();store.close();});const before=gateway.registry.getTool("mcp.synthetic.read")!,connection=gateway.registry.listConnections("work")[0]!;
  await runtime.admin.discover("synthetic");const after=gateway.registry.getTool("mcp.synthetic.read")!;assert.equal(after.manifest.version,before.manifest.version);assert.ok(after.revision>before.revision);assert.notEqual(after.manifestHash,before.manifestHash);assert.deepEqual(runtime.admin.botSelection("synthetic",bot.id).toolIds,["mcp.synthetic.read"]);assert.deepEqual(runtime.admin.catalogChanges("synthetic")!.changed,[]);assert.equal(store.getGrant(bot.id,"mcp.synthetic.read",connection.id)!.policy,"ask");assert.deepEqual(after.manifest.nativeInputSchema,(tools[0] as {inputSchema:object}).inputSchema);
  tools[0]={...tools[0],description:"Actually changed upstream"};await runtime.admin.discover("synthetic");assert.deepEqual(runtime.admin.botSelection("synthetic",bot.id).toolIds,[]);assert.equal(store.getGrant(bot.id,"mcp.synthetic.read",connection.id)!.policy,"deny");assert.deepEqual(runtime.admin.catalogChanges("synthetic")!.changed,["mcp.synthetic.read"]);
});
test("RE2 dependency published JS/WASM runs from a standalone copied package without system installation",t=>{
  const dir=mkdtempSync(join(tmpdir(),"dexter-re2-package-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const connectors=import.meta.resolve("@dexter/connectors"),dependency=createRequire(connectors).resolve("re2-wasm"),root=dirname(dirname(dirname(dependency)));cpSync(join(root,"build"),join(dir,"build"),{recursive:true});writeFileSync(join(dir,"package.json"),JSON.stringify({name:"re2-wasm",version:"1.0.2",main:"build/src/re2.js"}));
  const copied=createRequire(import.meta.url)(join(dir,"build/src/re2.js")) as {RE2:new(pattern:string,flags:string)=>{test(value:string):boolean}};const expression=new copied.RE2("^\\d{0,30}\\d{0,30}\\d{0,30}\\d{0,30}\\d{0,30}$","u");assert.equal(expression.test("1".repeat(40)),true);assert.equal(expression.test("1".repeat(40)+"x"),false);assert.ok(existsSync(join(dir,"build/wasm/re2.wasm")));
});
