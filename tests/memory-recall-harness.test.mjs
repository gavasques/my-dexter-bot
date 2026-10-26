import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {createConnection} from 'node:net';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {HostServices} from '../packages/cli/dist/host-services.js';
import {MemoryServiceTurnSurface,MEMORY_SERVICE_CONNECTION as connection} from '../packages/cli/dist/memory-service-turn-surface.js';
import {OpenVikingIdentityMapper,openVikingRevisionUri,openVikingPrivateMemoryRoot} from '../packages/context/dist/openviking-identity.js';
import {prepareMcpTurn} from '../packages/gateway/dist/index.js';
import {createHostApp} from '../packages/hub/dist/http.js';
import {APP_CONFIGURATION_GUIDE_PAGES,readAppConfigurationGuidePage,readHarnessGuideTopic} from '../packages/context/dist/index.js';

const parent=new URL('../../fixtures/',import.meta.url).pathname;
const tool=name=>'dexter.harness.memory.'+name;
const keyFor=i=>[i.accountId,i.userId,'a'.repeat(64)].map(p=>Buffer.from(p).toString('base64url')).join('.');
const fixtureGates=new Set();
const deferred=()=>{let settle;const promise=new Promise(r=>settle=r);const gate={promise,resolve:v=>{fixtureGates.delete(gate);settle(v);}};fixtureGates.add(gate);return gate;};
const refused=e=>['forbidden','unauthorized','conflict','unavailable'].includes(e?.code);
const catalog=()=>[{id:'codex',available:true,installed:true,adapterSupported:true,defaultModel:'fixture-model',models:[{id:'fixture-model',label:'Synthetic',reasoningEfforts:[],speeds:[]}],reasoningEfforts:[],speeds:[]}];
function rpcClient(path){
 const socket=createConnection(path),pending=new Map();let seq=0,buffer='';
 const ready=new Promise((r,j)=>{socket.once('connect',r);socket.once('error',j);});
 socket.on('data',b=>{buffer+=b;while(buffer.includes('\n')){const n=buffer.indexOf('\n'),m=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error('RPC '+m.error.code)):p.resolve(m.result);}}});
 socket.on('error',()=>{});socket.on('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Owned RPC closed'));}pending.clear();});
 async function rpc(method,params){await ready;const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Owned RPC test timeout'));},5000);pending.set(id,{resolve,reject,timer});socket.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
 return{rpc,async initialize(){await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'OwnedMemoryFixture',version:'1'}});socket.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');},close:()=>socket.destroy()};
}
async function fixture(t,options={}){
 const root=realpathSync(mkdtempSync(join(parent,'recall-'))),requests=[],hits=[],bodies=new Map(),hooks={search:null,read:null},admin='synthetic-private-admin',users=new Set(),accounts=new Set();
 const server=createServer(async(req,res)=>{
  const u=new URL(req.url,'http://127.0.0.1');let raw='';for await(const b of req)raw+=b;const args=raw?JSON.parse(raw):null;
  const key=req.headers['x-api-key'],parts=typeof key==='string'&&key!==admin?key.split('.').map(p=>Buffer.from(p,'base64url').toString('utf8')):[];
  requests.push({method:req.method,path:u.pathname,uri:u.searchParams.get('uri'),args,role:key===admin?'root':'user',accountId:parts[0]??null,userId:parts[1]??null});
  const send=(status,value)=>{if(!res.destroyed&&!res.writableEnded){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));}},ok=result=>send(200,{status:'ok',result});
  if(u.pathname==='/health')return send(200,{status:'ok',healthy:true,auth_mode:'api_key',role:key===admin?'root':'user',account_id:parts[0]??'default',user_id:parts[1]??'root'});
  if(u.pathname==='/api/v1/admin/accounts'){if(key!==admin)return send(403,{});if(req.method==='POST'){accounts.add(args.account_id);return ok({account_id:args.account_id,admin_user_id:args.admin_user_id});}return ok(accounts.has(u.searchParams.get('name'))?[{account_id:u.searchParams.get('name')}]:[]);}
  const match=u.pathname.match(/^\/api\/v1\/admin\/accounts\/([^/]+)\/users(?:\/([^/]+)\/settings)?$/);
  if(match){if(key!==admin)return send(403,{});if(match[2])return ok({account_id:match[1],user_id:match[2],memory_policy:{self:{enabled:false},peer:{enabled:false},working_memory:{enabled:false},memory_types:[]}});if(req.method==='POST'){users.add(args.user_id);return ok({account_id:match[1],user_id:args.user_id,user_key:keyFor({accountId:match[1],userId:args.user_id})});}return ok(users.has(u.searchParams.get('name'))?[{user_id:u.searchParams.get('name'),role:'user'}]:[]);}
  if(key===admin||parts.length!==3)return send(403,{});
  if(u.pathname==='/api/v1/search/find'){await hooks.search?.();return ok({resources:[...hits],memories:[],skills:[],total:hits.length});}
  if(u.pathname==='/api/v1/content/read'){await hooks.read?.();const uri=u.searchParams.get('uri');return bodies.has(uri)?ok(bodies.get(uri)):send(404,{status:'error',error:{code:'NOT_FOUND'}});}
  return send(404,{});
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const clock={now:Date.now()},clients=[];let services,turnScript=async()=>({});
 const makeDriver=(id,native)=>({id,capabilities:{resume:true,interrupt:true,fork:false,steer:false},status:async()=>({engine:id,installed:true,authentication:'unverified'}),
  open:async(threadId)=>{assert.ok(native.localMcpServer);assert.equal(services.context.status().activeCapabilities,0,'native open holds no Context read token');const rpc=rpcClient(native.localMcpServer.args[1]);clients.push(rpc);await rpc.initialize();return{threadId,nativeCursor:'synthetic-only',rpc};},
  async *turn(session,turnId,input){const result=await turnScript(session.rpc,turnId,input);yield{type:'text.delta',threadId:session.threadId,turnId,text:JSON.stringify(result)};yield{type:'turn.completed',threadId:session.threadId,turnId,usage:{}};},respondToTool:async()=>{},interrupt:async()=>{},close:async session=>session.rpc.close()});
 services=new HostServices({dataDir:join(root,'host'),enableMcp:true,enableEngines:true,engineCommands:{codex:'/usr/bin/false'},engineCatalog:catalog,makeDriver,
  ...(options.privateBackend?{}:{memoryService:{backend:{origin,credential:options.credential??keyFor,...(options.ignoreHttpAbort?{fetch:(url,init)=>fetch(url,{...init,signal:undefined})}:{})},jobTimeoutMs:options.jobTimeoutMs??5000}})});
 const surface=new MemoryServiceTurnSurface({store:services.store,base:services.gateway,context:services.context,memory:services.memoryService});
 const mapper=new OpenVikingIdentityMapper(services.store.hostId),actor=(name='Own')=>{const bot=services.store.createBot({name,profileId:'synthetic',engine:'codex'}),thread=services.store.createThread(bot.id);return{bot,thread,identity:mapper.bot(bot.id)};};
 const a=actor(),b=actor('Other');for(const who of [a,b])services.context.memoryLedger.provisionBotSubject(who.bot.id);
 const live=(who=a,ttlMs=300000)=>{const turn=services.store.createTurn(who.thread.id,{clientRequestId:'turn-'+randomUUID(),content:'Synthetic only'}).turn;services.store.claimNextTurn(who.thread.id);const cap=surface.issueCapability({turnId:turn.id,ttlMs});return{...who,turn,...cap};};
 const accept=(who,recordId,content='Approved synthetic canonical knowledge',extra={})=>{const rec=services.context.memoryLedger.acceptRevision({recordId,botId:who.bot.id,scope:{kind:'bot',botId:who.bot.id},kind:'fact',expectedRevision:0,policyEpoch:0,content,evidenceRefs:['owned-synthetic-turn:source'],operationKey:'accept-'+recordId,...extra}),uri=openVikingRevisionUri(who.identity,rec);bodies.set(uri,content);hits.push({uri,context_type:'resource',level:2,score:0.9,abstract:'UNTRUSTED_REMOTE_ABSTRACT'});return{...rec,uri,ref:{recordId:rec.recordId,revision:rec.revision,sha256:rec.sha256}};};
 const call=(l,name,callId,args={},signal)=>surface.call(l.token,{connectionId:connection,tool:tool(name),callId,arguments:args},{signal});
 let wrapping;
 if(options.privateBackend){services.memoryBackendHttp.configure({expectedHostId:services.store.hostId,clientRequestId:'configure',expectedRevision:0,origin,enabled:true});wrapping=Buffer.alloc(32,3).toString('base64');assert.equal(await services.memoryBackendPrivateInput.frame({schema:'dexter.memory-backend-key/1',requestId:randomUUID(),hostID:services.store.hostId,origin,expectedRevision:1,operation:'create',administrativeRole:'root',administrativeKey:admin,wrappingKeyBase64:wrapping}),'ready');}
 t.after(async()=>{for(const gate of [...fixtureGates])gate.resolve();hooks.search=null;hooks.read=null;for(const c of clients)c.close();await surface.close();await services.shutdown({graceMs:5000});server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});});
 return{root,services,surface,requests,hits,bodies,hooks,a,b,actor,live,accept,call,origin,async privateLock(){return services.memoryBackendPrivateInput.frame({schema:'dexter.memory-backend-key/1',requestId:randomUUID(),hostID:services.store.hostId,origin,expectedRevision:1,operation:'lock'});},async unlock(){return services.memoryBackendPrivateInput.frame({schema:'dexter.memory-backend-key/1',requestId:randomUUID(),hostID:services.store.hostId,origin,expectedRevision:1,operation:'unlock',administrativeRole:'root',wrappingKeyBase64:wrapping});},
  setTurnScript(fn){turnScript=fn;},async bridge(l){const lease=await prepareMcpTurn({store:services.store,gateway:surface,wrapperPath:new URL('../packages/cli/dist/mcp-stdio.js',import.meta.url).pathname,turnId:l.turn.id});const rpc=rpcClient(lease.socketPath);clients.push(rpc);await rpc.initialize();const tools=(await rpc.rpc('tools/list',{})).tools;t.after(async()=>{lease.stop();await lease.whenDrained();});return{lease,rpc,tools};}};
}
const rpcTool=(tools,name)=>tools.find(t=>t.title.startsWith(tool(name)+' ')).name;
const readRpc=(rpc,name,callId,input)=>rpc.rpc('tools/call',{name,arguments:{callId,input}});
const pinGrant=(f,l,name,policy)=>f.services.store.setGrant({botId:l.bot.id,tool:tool(name),destination:connection,policy,expiresAt:null});
const forget=(f,record)=>f.services.context.memoryLedger.forgetRecord({recordId:record.recordId,expectedRevision:record.revision,policyEpoch:0,operationKey:'forget-'+record.recordId,suppressionSignature:'synthetic-suppression'});

test('actual HostServices native RPC -> private provisioned bot user -> M05 -> canonical receipt -> conversation response',async t=>{
 const f=await fixture(t,{privateBackend:true}),record=f.accept(f.a,'approved-record');
 f.setTurnScript(async(rpc,turnId,input)=>{assert.ok(input.includes('BUILT-IN HARNESS GUIDE'));const tools=(await rpc.rpc('tools/list',{})).tools;assert.ok(tools.some(v=>v.title.startsWith(tool('details')+' ')));
  const result=await readRpc(rpc,rpcTool(tools,'recall'),'native-read',{query:'synthetic knowledge',limit:8});assert.equal(result.isError,false);assert.equal(result.structuredContent.status,'succeeded');assert.equal(result.structuredContent.result.memories[0].sha256,record.sha256);return result.structuredContent.result;});
 const {turn}=f.services.runtime.startTurn(f.a.thread.id,{clientRequestId:'native-integration',content:'Recall own memory'});const terminal=await f.services.runtime.waitForTurn(turn.id,10000);assert.equal(terminal.state,'completed',terminal.code);
 assert.equal(JSON.parse(f.services.store.turnOutput(turn.id)).memories[0].markdown,'Approved synthetic canonical knowledge');assert.equal(f.services.context.status().activeCapabilities,0);
 const data=f.requests.filter(r=>r.path.startsWith('/api/v1/content/')||r.path.startsWith('/api/v1/search/'));assert.ok(data.length>=2);assert.ok(data.every(r=>r.role==='user'&&r.accountId===f.a.identity.accountId&&r.userId===f.a.identity.userId));assert.equal(data.find(r=>r.path.endsWith('/find')).args.target_uri,openVikingPrivateMemoryRoot(f.a.identity));
 assert.equal(f.requests.filter(r=>r.method==='POST'&&r.path.startsWith('/api/v1/admin/')).length,2);assert.equal(JSON.stringify(data).includes('UNTRUSTED_REMOTE_ABSTRACT'),false);
});

test('real RPC aliases have closed schemas; details pins exact revision/hash and cannot select another identity',async t=>{
 const f=await fixture(t),l=f.live(),r=f.accept(f.a,'details-record'),{rpc,tools}=await f.bridge(l),name=rpcTool(tools,'details');
 const out=await readRpc(rpc,name,'detail-good',r.ref);assert.equal(out.isError,false);assert.equal(out.structuredContent.result.memory.sha256,r.sha256);
 for(const input of [{...r.ref,botId:f.b.bot.id},{...r.ref,sha256:'0'.repeat(64)},{...r.ref,revision:2},{...r.ref,recordId:'different-record'}])assert.equal((await readRpc(rpc,name,'bad-'+randomUUID(),input)).isError,true);
 const recall=tools.find(v=>v.title.startsWith(tool('recall')+' '));assert.equal(recall.inputSchema.properties.input.properties.limit.maximum,8);assert.equal(recall.inputSchema.properties.input.additionalProperties,false);
 const before=f.requests.length;await assert.rejects(f.call(l,'recall','bad-limit',{query:'x',limit:9}),e=>e.code==='invalid_input');await assert.rejects(f.call(l,'recall','bad-query',{query:'x'.repeat(2001)}),e=>e.code==='invalid_input');assert.equal(f.requests.length,before);
});

test('other bot, confidential/source scope and foreign backend URI cannot disclose bytes or citations',async t=>{
 const f=await fixture(t),l=f.live(),other=f.accept(f.b,'other-record','OTHER_PRIVATE'),hidden=f.accept(f.a,'secret-source','CONFIDENTIAL',{scope:{kind:'confidential',botId:f.a.bot.id}});
 await assert.rejects(f.call(l,'details','other',other.ref),refused);await assert.rejects(f.call(l,'details','hidden',hidden.ref),refused);assert.equal(f.requests.length,0);
 f.hits.splice(0,f.hits.length,{uri:other.uri,context_type:'resource',level:2,score:1});await assert.rejects(f.call(l,'recall','foreign-uri',{query:'x'}),refused);assert.equal(f.requests.some(r=>r.uri===hidden.uri||r.uri===other.uri),false);
});

test('forgotten records are suppressed immediately even when remote content/index still exists',async t=>{
 const f=await fixture(t),l=f.live(),r=f.accept(f.a,'forgotten');assert.equal((await f.call(l,'details','before',r.ref)).result.memory.recordId,r.recordId);forget(f,r);
 const before=f.requests.length;await assert.rejects(f.call(l,'details','after',r.ref),refused);assert.equal(f.requests.length,before);assert.deepEqual((await f.call(l,'recall','search-after',{query:'x'})).result.memories,[]);assert.ok(f.bodies.has(r.uri));
});

test('missing read grant uses only existing Context own default; explicit Context deny and tool DENY refuse stale alias',async t=>{
 const f=await fixture(t),l=f.live(),r=f.accept(f.a,'policy');assert.equal(f.services.store.getGrant(l.bot.id,tool('recall'),connection),null);await f.call(l,'recall','default',{query:'x'});
 assert.equal(f.services.store.getGrant(l.bot.id,tool('recall'),connection),null);f.services.context.setRecallGrant(l.bot.id,{kind:'bot',botId:l.bot.id},false);assert.equal(f.surface.listTools(l.token).filter(v=>v.connectionId===connection).length,0);
 await assert.rejects(f.call(l,'details','context-deny',r.ref),refused);f.services.context.setRecallGrant(l.bot.id,{kind:'bot',botId:l.bot.id},true);pinGrant(f,l,'recall','deny');assert.ok(!f.surface.listTools(l.token).some(v=>v.name===tool('recall')));await assert.rejects(f.call(l,'recall','tool-deny',{query:'x'}),refused);
});

test('ASK uses exact owner HTTP decision/dispatch receipt; no grant creation and no blind duplicate HTTP',async t=>{
 const f=await fixture(t),r=f.accept(f.a,'ask-record');f.services.store.setGrant({botId:f.a.bot.id,tool:tool('details'),destination:connection,policy:'ask',expiresAt:null});
 f.services.store.setBotApprovalPolicy(f.a.bot.id,{expectedHostId:f.services.store.hostId,clientRequestId:'full-access-policy',expectedRevision:0,mode:'full_access',eligibleScopeVersion:'d03.execution.v1'});
 const app=createHostApp(f.services.store,{runtime:f.services.runtime});
 f.setTurnScript(async(rpc)=>{const tools=(await rpc.rpc('tools/list',{})).tools;const reading=readRpc(rpc,rpcTool(tools,'details'),'approved-read',r.ref);
  const action=await new Promise((resolve,reject)=>{const end=Date.now()+3000;const poll=()=>{const a=f.services.store.listActions('awaiting_approval').find(a=>a.request.destination===connection);if(a)return resolve(a);if(Date.now()>end)return reject(new Error('ASK not admitted'));setTimeout(poll,5);};poll();});
  assert.equal(f.requests.length,0);const wrong=await app.request('http://127.0.0.1/v1/actions/'+action.id+'/decisions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:'allow',requestHash:'0'.repeat(64)})});assert.equal(wrong.status,409);
  const yes=await app.request('http://127.0.0.1/v1/actions/'+action.id+'/decisions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:'allow',requestHash:action.requestHash})});assert.equal(yes.status,200);
  const out=await reading;assert.equal(out.isError,false);assert.equal(out.structuredContent.status,'succeeded');assert.equal(out.structuredContent.actionId,action.id);return out.structuredContent;});
 const {turn}=f.services.runtime.startTurn(f.a.thread.id,{clientRequestId:'ask-integration',content:'Exact own read'});assert.equal((await f.services.runtime.waitForTurn(turn.id,10000)).state,'completed');
 assert.equal(f.services.store.getGrant(f.a.bot.id,tool('details'),connection).policy,'ask');assert.equal(f.services.store.listActions().filter(a=>a.state==='succeeded').length,1);assert.equal(f.requests.filter(r=>r.path==='/api/v1/content/read').length,1);
});

test('mid HTTP Context grant revocation refuses late body',async t=>{
 const f=await fixture(t),l=f.live();f.accept(f.a,'mid-grant');const reached=deferred(),release=deferred();f.hooks.search=async()=>{reached.resolve();await release.promise;};
 const result=f.call(l,'recall','slow',{query:'x'});const check=assert.rejects(result,refused);await reached.promise;f.services.context.setRecallGrant(l.bot.id,{kind:'bot',botId:l.bot.id},false);release.resolve();await check;assert.equal(f.requests.filter(r=>r.path==='/api/v1/content/read').length,0);assert.equal(f.services.context.status().activeCapabilities,0);
});

test('mid HTTP tool grant revision, epoch/forget and TTL all refuse late responses',async t=>{
 for(const mode of ['grant','epoch','ttl']){const f=await fixture(t),l=f.live(f.a,mode==='ttl'?300:300000),r=f.accept(f.a,'mid-'+mode),reached=deferred(),release=deferred();if(mode==='grant')pinGrant(f,l,'details','allow');f.hooks.read=async()=>{reached.resolve();await release.promise;};
  const result=f.call(l,'details','mid',r.ref),check=assert.rejects(result,refused);await reached.promise;if(mode==='grant')pinGrant(f,l,'details','deny');else if(mode==='epoch')forget(f,r);else await new Promise(r=>setTimeout(r,350));release.resolve();await check;}
});

test('private backend lock during real HTTP revokes stamp; unlocked next read uses same custody without replay',async t=>{
 const f=await fixture(t,{privateBackend:true}),l=f.live(),r=f.accept(f.a,'locked-record');await f.call(l,'details','prime',r.ref);const reached=deferred(),release=deferred();f.hooks.read=async()=>{reached.resolve();await release.promise;};
 const result=f.call(l,'details','late-lock',r.ref),check=assert.rejects(result,refused);await reached.promise;assert.equal(await f.privateLock(),'locked');release.resolve();await check;
 f.hooks.read=null;assert.equal(await f.unlock(),'ready');assert.equal((await f.call(l,'details','after-unlock',r.ref)).result.memory.recordId,r.recordId);assert.equal(f.requests.filter(r=>r.method==='POST'&&r.path.startsWith('/api/v1/admin/')).length,2);
});

test('one Context token per turn: serial reads, eight waiting, direct call ID dedup, 64 admissions',async t=>{
 const f=await fixture(t),l=f.live(),r=f.accept(f.a,'serial'),reached=deferred(),release=deferred();f.hooks.read=async()=>{reached.resolve();await release.promise;};
 const first=f.call(l,'details','first',r.ref);await reached.promise;assert.equal(f.services.context.status().activeCapabilities,1);assert.throws(()=>f.services.context.issue(l.turn.id),e=>e.code==='conflict');
 const waiting=Array.from({length:8},(_,i)=>f.call(l,'details','queue-'+i,r.ref));await assert.rejects(f.call(l,'details','overflow',r.ref),e=>e.code==='unavailable');await assert.rejects(f.call(l,'details','first',r.ref),e=>e.code==='conflict');release.resolve();await Promise.all([first,...waiting]);f.hooks.read=null;assert.equal(f.services.context.status().activeCapabilities,0);
 for(let i=9;i<64;i++)await f.call(l,'details','budget-'+i,r.ref);await assert.rejects(f.call(l,'details','budget-over',r.ref),e=>e.code==='unavailable');assert.equal(f.requests.filter(r=>r.path==='/api/v1/content/read').length,64);
});

test('deadline/ignored HTTP abort retains Context token, serial slot and Host writer until actual IO drains',async t=>{
 const f=await fixture(t,{jobTimeoutMs:250,ignoreHttpAbort:true}),r=f.accept(f.a,'late-io'),reached=deferred(),release=deferred(),done=deferred();f.hooks.read=async()=>{reached.resolve();await release.promise;};
 let settled=false;f.setTurnScript(async rpc=>{const tools=(await rpc.rpc('tools/list',{})).tools;try{return await readRpc(rpc,rpcTool(tools,'details'),'deadline',r.ref);}catch{return{refused:true};}finally{settled=true;done.resolve();}});
 f.services.runtime.startTurn(f.a.thread.id,{clientRequestId:'deadline-native',content:'Owned late IO'});await reached.promise;await new Promise(r=>setTimeout(r,300));assert.equal(settled,false);assert.equal(f.services.context.status().activeCapabilities,1);
 let readRevokes=0;const original=f.services.context.revoke.bind(f.services.context);f.services.context.revoke=token=>{readRevokes++;return original(token);};
 await assert.rejects(f.services.shutdown({graceMs:30}));assert.doesNotThrow(()=>f.services.store.listBots());assert.equal(readRevokes,0,'terminal authority may prune immediately, but owned token is not explicitly released before late IO drains');
 release.resolve();await done.promise;await f.services.shutdown({graceMs:5000});assert.equal(settled,true);assert.equal(readRevokes,1);
});

test('stale RPC catalog, capability revoke and stop cannot enable, replay or publish a late callback',async t=>{
 const f=await fixture(t),l=f.live(),r=f.accept(f.a,'stop-read'),{rpc,tools,lease}=await f.bridge(l),alias=rpcTool(tools,'details');pinGrant(f,l,'details','deny');assert.equal((await readRpc(rpc,alias,'stale',r.ref)).isError,true);
 pinGrant(f,l,'details','allow');const reached=deferred(),release=deferred();f.hooks.read=async()=>{reached.resolve();await release.promise;};const result=f.call(l,'details','stop',r.ref),check=assert.rejects(result,refused);await reached.promise;f.surface.stopAdmission();lease.stop();release.resolve();await check;const before=f.requests.length;await assert.rejects(f.call(l,'details','replay',r.ref),refused);assert.equal(f.requests.length,before);await f.surface.close();assert.equal(f.services.context.status().activeCapabilities,0);
});

test('closed backend remains typed refusal; no legacy ai-memory/backend fallback or secret/identity knobs',async t=>{
 const f=await fixture(t),l=f.live();f.accept(f.a,'no-fallback');f.services.memoryService.stopAdmission();await assert.rejects(f.call(l,'recall','closed',{query:'x'}),refused);assert.equal(f.requests.length,0);
 for(const key of ['ownerId','accountId','userId','origin','credentials','privateRecallAllowed'])await assert.rejects(f.call(l,'recall','knob-'+key,{query:'x',[key]:'synthetic'}),e=>e.code==='invalid_input');
});

test('real Team and Group audience/tombstones never publish private read aliases or become private fallback',async t=>{
 const f=await fixture(t),store=f.services.store,context=f.services.context;
 const team=context.createTeamWorkspace({expectedHostID:store.hostId,clientRequestId:randomUUID(),name:'Synthetic Team',coordinatorBotId:f.a.bot.id,botIds:[f.a.bot.id]});
 context.bindTeamThread(team.id,f.a.thread.id,team.revision,randomUUID());const teamLive=f.live();assert.equal(f.surface.listTools(teamLive.token).filter(v=>v.connectionId===connection).length,0);await assert.rejects(f.call(teamLive,'recall','team-attempt',{query:'x'}),refused);
 const g=store.groups.create({expectedHostId:store.hostId,clientRequestId:'group-create',expectedRevision:0,name:'Synthetic Group',botIds:[f.b.bot.id],historyBotIds:[]}).result;
 const c=store.groups.createConversation(g.id,{expectedHostId:store.hostId,clientRequestId:'group-conversation',expectedRevision:g.revision}).result;
 const d=store.groups.send(c.id,{expectedHostId:store.hostId,clientRequestId:'group-input',expectedRevision:g.revision,content:'Synthetic shared input',recipients:{kind:'all'}}).dispatch;
 const prepared=store.groups.prepareRecipient(d.recipients[0].id),thread=store.createGroupThread(prepared.recipient.id,f.b.bot.id,prepared.threadId);
 const turn=store.createTurn(thread.id,{clientRequestId:prepared.recipient.id,content:prepared.content}).turn;store.groups.bindTurn(prepared.recipient.id,turn.id);store.claimNextTurn(thread.id);
 const cap=f.surface.issueCapability({turnId:turn.id});assert.equal(f.surface.listTools(cap.token).filter(v=>v.connectionId===connection).length,0);
 await assert.rejects(f.surface.call(cap.token,{tool:tool('recall'),connectionId:connection,callId:'group-attempt',arguments:{query:'x'}}),refused);
 store.groups.archive(g.id,{expectedHostId:store.hostId,clientRequestId:'group-archive',expectedRevision:g.revision});assert.throws(()=>context.isPrivateMemoryTurn(turn.id));assert.throws(()=>f.surface.listTools(cap.token));assert.equal(f.requests.length,0);
});

test('focused first-party guide publishes stable controls and schemas through real configuration RPC on demand',async t=>{
 const f=await fixture(t);f.setTurnScript(async rpc=>{const tools=(await rpc.rpc('tools/list',{})).tools,configuration=tools.find(v=>v.title.startsWith('dexter.harness.configuration '));assert.ok(configuration);
  const out=await readRpc(rpc,configuration.name,'focused-guide',{page:'memory-recall'});assert.equal(out.isError,false);const page=out.structuredContent.result;assert.equal(page.id,'memory-recall');assert.deepEqual(page.fields.map(x=>x.id),['memory.recall.query','memory.details.reference','memory.recall.permission','memory.recall.receipt','memory.recall.queue','memory.recall.stop']);assert.match(page.sha256,/^[a-f0-9]{64}$/);for(const field of page.fields)for(const k of ['purpose','scope','read','change','approval','result','recovery','availability'])assert.ok(field[k]);return{pageId:page.id,sha256:page.sha256};});
 const {turn}=f.services.runtime.startTurn(f.a.thread.id,{clientRequestId:'guide-rpc',content:'Read focused documentation'});assert.equal((await f.services.runtime.waitForTurn(turn.id,10000)).state,'completed');assert.ok(APP_CONFIGURATION_GUIDE_PAGES.some(p=>p.id==='memory-recall'));assert.ok(readAppConfigurationGuidePage('memory-recall').markdown.includes('dexter.harness.memory.recall'));assert.ok(readHarnessGuideTopic('models').markdown.includes('memory-recall'));assert.equal(f.requests.length,0);
});

test('pending ASK cannot rehydrate on replacement surface; stopped/restarted binding never repeats HTTP',async t=>{
 const f=await fixture(t),l=f.live(),r=f.accept(f.a,'pending-read');pinGrant(f,l,'details','ask');const pending=await f.call(l,'details','original',r.ref);assert.equal(pending.status,'awaiting_approval');
 await f.surface.close();const next=new MemoryServiceTurnSurface({store:f.services.store,base:f.services.gateway,context:f.services.context,memory:f.services.memoryService});t.after(()=>next.close());const cap=next.issueCapability({turnId:l.turn.id});
 await assert.rejects(next.call(cap.token,{connectionId:connection,tool:tool('details'),callId:'original',arguments:r.ref}),e=>e.code==='conflict');assert.equal(f.requests.length,0);
 f.services.store.decideAction(pending.actionId,{decision:'allow',requestHash:pending.requestHash});const action=f.services.store.getAction(pending.actionId);assert.equal((await next.continueOwnerAction(action)).state,'blocked');assert.equal(f.requests.length,0);
});

test('missing local subject does not hide catalogue or require registration; read creates only fixed metadata and no grant',async t=>{
 const f=await fixture(t),fresh=f.actor('Fresh subject'),l=f.live(fresh);assert.ok(f.surface.listTools(l.token).some(v=>v.name===tool('recall')));const result=await f.call(l,'recall','fresh',{query:'own empty'});assert.deepEqual(result.result.memories,[]);
 assert.equal(f.services.context.memoryLedger.subject(fresh.bot.id).userId,fresh.identity.userId);assert.equal(f.services.store.getGrant(fresh.bot.id,tool('recall'),connection),null);assert.equal(f.requests.filter(r=>r.path.startsWith('/api/v1/admin/')).length,0);
});

test('recall limit8 performs at most8 exact details and returns eight approved canonical heads',async t=>{
 const f=await fixture(t),l=f.live(),records=Array.from({length:9},(_,i)=>f.accept(f.a,'bounded-'+i,'Approved '+i));const out=await f.call(l,'recall','eight',{query:'approved',limit:8});assert.equal(out.result.memories.length,8);assert.equal(f.requests.filter(r=>r.path==='/api/v1/content/read').length,8);
 assert.deepEqual(out.result.memories.map(r=>r.sha256),records.slice(0,8).map(r=>r.sha256));assert.equal(f.services.context.status().activeCapabilities,0);
});

test('ASK unknown receipt never repeats backend HTTP; successful receipt body is withheld after forget',async t=>{
 const f=await fixture(t),l=f.live(),r=f.accept(f.a,'unknown-receipt');pinGrant(f,l,'details','ask');f.bodies.set(r.uri,'Wrong synthetic remote bytes');
 const pending=await f.call(l,'details','unknown-call',r.ref);f.services.store.decideAction(pending.actionId,{decision:'allow',requestHash:pending.requestHash});const unknown=await f.call(l,'details','unknown-call',r.ref);assert.equal(unknown.status,'unknown');const count=f.requests.length;assert.equal((await f.call(l,'details','unknown-call',r.ref)).status,'unknown');assert.equal(f.requests.length,count);
 f.bodies.set(r.uri,'Approved synthetic canonical knowledge');const next=await f.call(l,'details','good-call',r.ref);f.services.store.decideAction(next.actionId,{decision:'allow',requestHash:next.requestHash});assert.equal((await f.call(l,'details','good-call',r.ref)).status,'succeeded');forget(f,r);await assert.rejects(f.call(l,'details','good-call',r.ref),refused);assert.equal(f.requests.length,count+2);
});

test('forgotten source/hash suppress other preexisting records before details HTTP, while unrelated head remains readable',async t=>{
 const f=await fixture(t),l=f.live(),gone=f.accept(f.a,'gone-source','FORGOTTEN_BYTES',{evidenceRefs:['private-source']}),sameSource=f.accept(f.a,'same-source','OTHER_BYTES',{evidenceRefs:['private-source']}),sameHash=f.accept(f.a,'same-hash','FORGOTTEN_BYTES',{evidenceRefs:['different-source']}),safe=f.accept(f.a,'safe-source','SAFE_CANONICAL',{evidenceRefs:['safe-source']});
 forget(f,gone);const before=f.requests.length;await assert.rejects(f.call(l,'details','suppressed-source',sameSource.ref),refused);await assert.rejects(f.call(l,'details','suppressed-hash',sameHash.ref),refused);assert.equal(f.requests.length,before);
 const recalled=await f.call(l,'recall','safe-only',{query:'source'});assert.deepEqual(recalled.result.memories.map(r=>r.recordId),[safe.recordId]);assert.equal(f.requests.some(r=>r.uri===sameSource.uri||r.uri===sameHash.uri),false);
});

test('actual native actions.read cannot disclose a historical ASK memory body after forget or via generic receipt alias',async t=>{
 const f=await fixture(t),r=f.accept(f.a,'history-route','PRIVATE_MEMORY_HISTORY_BYTES');pinGrant(f,{bot:f.a.bot},'details','ask');const app=createHostApp(f.services.store,{runtime:f.services.runtime});
 f.setTurnScript(async rpc=>{const tools=(await rpc.rpc('tools/list',{})).tools,detail=rpcTool(tools,'details'),actions=tools.find(v=>v.title.startsWith('dexter.harness.actions.read '));assert.ok(actions);
  const pending=readRpc(rpc,detail,'history-own-read',r.ref);const action=await new Promise((resolve,reject)=>{const end=Date.now()+3000;const poll=()=>{const a=f.services.store.listActions('awaiting_approval').find(a=>a.request.destination===connection);if(a)return resolve(a);if(Date.now()>end)return reject(new Error('ASK not admitted'));setTimeout(poll,5);};poll();});
  assert.equal((await app.request('http://127.0.0.1/v1/actions/'+action.id+'/decisions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:'allow',requestHash:action.requestHash})})).status,200);
  const original=await pending;assert.equal(original.structuredContent.result.memory.markdown,'PRIVATE_MEMORY_HISTORY_BYTES');
  for(const stage of ['before','after']){if(stage==='after')forget(f,r);const receipt=await readRpc(rpc,actions.name,'history-'+stage,{action_id:action.id});assert.equal(receipt.isError,false);assert.equal(receipt.structuredContent.result.state,'succeeded');assert.equal(receipt.structuredContent.result.result,null);assert.equal(JSON.stringify(receipt).includes('PRIVATE_MEMORY_HISTORY_BYTES'),false);}
  return{genericReceiptBody:'withheld',originalRead:'authorized'};});
 const {turn}=f.services.runtime.startTurn(f.a.thread.id,{clientRequestId:'history-native',content:'Exact private read and bounded history'});assert.equal((await f.services.runtime.waitForTurn(turn.id,10000)).state,'completed');assert.equal(f.requests.filter(r=>r.path==='/api/v1/content/read').length,1);
});
