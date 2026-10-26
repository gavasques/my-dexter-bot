import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { HostStore } from '../packages/hub/dist/index.js';
import { ContextHost, UnconfiguredMemoryAdapter } from '../packages/context/dist/index.js';
import { MemoryService, MEMORY_SERVICE_LIMITS } from '../packages/context/dist/memory-service.js';
import { OpenVikingIdentityMapper, openVikingRevisionUri, openVikingPrivateMemoryRoot } from '../packages/context/dist/openviking-identity.js';
import { HostServices } from '../packages/cli/dist/host-services.js';
import { OpenVikingSupervisor } from '../packages/cli/dist/openviking-supervisor.js';

const code = expected => error => error?.code === expected;
const json = (res, status, body) => { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(body)); };
const keyFor = identity => [identity.accountId, identity.userId, 'a'.repeat(64)].map(part => Buffer.from(part).toString('base64url')).join('.');
const deferred = () => { let resolve; const promise = new Promise(done => {resolve=done;}); return {promise,resolve}; };
async function fixture(t, overrides={}) {
  const root=realpathSync(mkdtempSync('/private/tmp/dexter-memory-service-composition-r1-'));
  const clock={now:1000}, store=new HostStore({dataDir:join(root,'data'),clock:()=>clock.now});
  const mapper=new OpenVikingIdentityMapper(store.hostId), options={memoryIdentityMapper:botId=>mapper.bot(botId)};
  let context=new ContextHost(store,new UnconfiguredMemoryAdapter(),options), service;
  const authorities=new Map(), memberships={stamp:'membership-v1'}, bodies=new Map(), hits=[], requests=[];
  const hooks={find:null,read:null,write:null}, server=createServer(async(req,res)=>{
    let body=''; for await(const bytes of req)body+=bytes.toString('utf8');
    const args=body?JSON.parse(body):null, url=new URL(req.url,'http://127.0.0.1');
    const key=req.headers['x-api-key'], parts=typeof key==='string'?key.split('.').map(part=>Buffer.from(part,'base64url').toString('utf8')):[];
    requests.push({method:req.method,path:url.pathname,args,uri:url.searchParams.get('uri')});
    if(url.pathname==='/health')return json(res,200,{status:'ok',healthy:true,auth_mode:'api_key',role:'user',account_id:parts[0],user_id:parts[1]});
    if(url.pathname==='/api/v1/search/find'){
      if(hooks.find)await hooks.find(req,res,args);
      if(res.destroyed||res.writableEnded)return;
      return json(res,200,{status:'ok',result:{resources:[...hits],memories:[],skills:[],total:hits.length}});
    }
    if(url.pathname==='/api/v1/content/read'){
      const uri=url.searchParams.get('uri'); if(hooks.read)await hooks.read(req,res,uri);
      if(res.destroyed||res.writableEnded)return;
      return bodies.has(uri)?json(res,200,{status:'ok',result:bodies.get(uri)}):json(res,404,{status:'error',error:{code:'NOT_FOUND'}});
    }
    if(url.pathname==='/api/v1/content/write'){
      bodies.set(args.uri,args.content); if(hooks.write)await hooks.write(req,res,args);
      if(res.destroyed||res.writableEnded)return;
      return json(res,200,{status:'ok',result:{uri:args.uri,mode:'create',content_updated:true,written_bytes:Buffer.byteLength(args.content),task_id:'synthetic-task'}});
    }
    json(res,404,{status:'error',error:{code:'NOT_FOUND'}});
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const authority=token=>{const current=context.memoryServiceAuthority(token),own=authorities.get(token);if(!own)throw Error('untrusted');return {...current,audience:own.audience,authorizationStamp:current.authorizationStamp+memberships.stamp};};
  const config={workspaceId:store.hostId,ledger:context.memoryLedger,resolveAuthority:authority,backend:{origin,credential:keyFor},...overrides};
  const open=()=>service=new MemoryService({...config,ledger:context.memoryLedger}); open();
  const principal=name=>{
    const bot=store.createBot({name,profileId:'synthetic',engine:'codex'}),thread=store.createThread(bot.id);
    const turn=store.createTurn(thread.id,{clientRequestId:'synthetic-'+name,content:'Synthetic turn'}).turn;store.claimNextTurn(thread.id);
    const token=context.issue(turn.id);authorities.set(token,{workspaceId:store.hostId,botId:bot.id,turnId:turn.id,threadId:thread.id,audience:'private',privateRecallAllowed:true});
    context.memoryLedger.provisionBotSubject(bot.id);return {bot,thread,turn,token,identity:mapper.bot(bot.id)};
  };
  const a=principal('Alpha'),b=principal('Beta');
  const accept=(actor,recordId,content='Synthetic accepted knowledge',extra={})=>{
    const input={recordId,botId:actor.bot.id,scope:{kind:'bot',botId:actor.bot.id},kind:'fact',expectedRevision:0,policyEpoch:0,content,evidenceRefs:['turn-synthetic:message-1'],operationKey:'accept-'+recordId,...extra};
    const accepted=context.memoryLedger.acceptRevision(input),uri=openVikingRevisionUri(actor.identity,accepted);
    return {...accepted,uri,content,ref:{recordId:accepted.recordId,revision:accepted.revision,sha256:accepted.sha256}};
  };
  const index=record=>{bodies.set(record.uri,record.content);hits.push({uri:record.uri,context_type:'resource',level:2,score:0.8,abstract:'Backend text must never be returned'});};
  t.after(async()=>{await service.close();context.close();store.close();await new Promise(done=>{server.closeAllConnections();server.close(done);});rmSync(root,{recursive:true,force:true});});
  return {store,clock,a,b,accept,index,bodies,hits,hooks,requests,memberships,authorities,config,root,get context(){return context;},get service(){return service;},
    reopen:async()=>{await service.close();context.close();context=new ContextHost(store,new UnconfiguredMemoryAdapter(),options);authorities.clear();open();}};
}

test('M05 HostServices always composes the service with MCP and engines disabled, and retains Context when supervisor cleanup is unconfirmed',async t=>{
  const root=realpathSync(mkdtempSync('/private/tmp/dexter-memory-service-host-r1-'));
  const host=new HostServices({dataDir:join(root,'normal')});
  assert.equal(host.gateway,undefined);assert.equal(host.runtime,undefined);assert.ok(host.memoryService);
  assert.equal(host.hostToolStatus().memoryService.state,'blocked_configuration');
  const bot=host.store.createBot({name:'Synthetic host bot',profileId:'synthetic',engine:'codex'}),thread=host.store.createThread(bot.id);
  const turn=host.store.createTurn(thread.id,{clientRequestId:'synthetic-host-turn',content:'Synthetic'}).turn;host.store.claimNextTurn(thread.id);
  const token=host.context.issue(turn.id);assert.equal((await host.memoryService.status(token)).state,'blocked_configuration');
  await host.shutdown();assert.equal(host.memoryService.diagnostic().state,'closed');
  const blocked=new HostServices({dataDir:join(root,'retained'),memoryService:{supervisor:{stop:async()=>({complete:false})}}});
  await assert.rejects(blocked.shutdown({graceMs:50}));
  assert.doesNotThrow(()=>blocked.context.status());assert.doesNotThrow(()=>blocked.store.listBots());
  // The test owns these handles. Explicit cleanup of the synthetic retained host after its failure assertion.
  blocked.context.close();blocked.store.close();t.after(()=>rmSync(root,{recursive:true,force:true}));
});

test('M05 no backend yields typed blocked configuration and performs no HTTP; credentials/IDs cannot be supplied by a read caller',async t=>{
  const f=await fixture(t,{backend:undefined});
  assert.equal(f.service.diagnostic().state,'blocked_configuration');
  const status=await f.service.status(f.a.token);assert.equal(status.state,'blocked_configuration');assert.equal(status.identityVerified,false);
  await assert.rejects(f.service.recall(f.a.token,{query:'knowledge'}),code('blocked_configuration'));
  await assert.rejects(f.service.recall(f.a.token,{query:'knowledge',botId:f.b.bot.id}),code('invalid_input'));
  assert.equal(f.requests.length,0);
});

test('M05 fixed private target, real ledger head and bounded provenance produce authorized recall; health leaves semantic coverage unproven',async t=>{
  const f=await fixture(t),record=f.accept(f.a,'own-record');f.index(record);
  const result=await f.service.recall(f.a.token,{query:'knowledge'});
  assert.equal(result.length,1);assert.equal(result[0].markdown,record.content);assert.equal(result[0].provenance.canonical,'context-ledger');
  assert.deepEqual(result[0].provenance.evidence,[{kind:'ledger_reference',reference:'turn-synthetic:message-1'}]);
  assert.equal(JSON.stringify(result).includes('Backend text'),false);
  const search=f.requests.find(request=>request.path==='/api/v1/search/find');assert.equal(search.args.target_uri,openVikingPrivateMemoryRoot(f.a.identity));
  const status=await f.service.status(f.a.token);assert.equal(status.identityVerified,true);assert.equal(status.semanticRecall,'unproven');assert.equal(status.indexing,'unproven');
  assert.equal((await f.service.read(f.a.token,record.ref)).sha256,record.sha256);
});

test('M05 cross-bot and confidential records disclose no bytes or citations and confidential hits cause no detail request',async t=>{
  const f=await fixture(t),other=f.accept(f.b,'other-record','Synthetic Beta private marker');
  await assert.rejects(f.service.read(f.a.token,other.ref),error=>['forbidden','revoked'].includes(error?.code));assert.equal(f.requests.length,0);
  const hidden=f.accept(f.a,'confidential-record','Synthetic compartment marker',{scope:{kind:'confidential',botId:f.a.bot.id}}),own=f.accept(f.a,'ordinary-record');
  f.index(hidden);f.index(own);const output=await f.service.recall(f.a.token,{query:'knowledge'});
  assert.deepEqual(output.map(item=>item.recordId),['ordinary-record']);assert.equal(JSON.stringify(output).includes('compartment'),false);
  assert.equal(f.requests.some(request=>request.path==='/api/v1/content/read'&&request.uri===hidden.uri),false);
  f.hits.splice(0,f.hits.length,{uri:other.uri,context_type:'resource',level:2,score:1});
  await assert.rejects(f.service.recall(f.a.token,{query:'knowledge'}),code('backend_unavailable'));
});

test('M05 Context capability revocation during search rejects its late result',async t=>{
  const f=await fixture(t),record=f.accept(f.a,'late-record');f.index(record);
  const reached=deferred(),release=deferred();f.hooks.find=async()=>{reached.resolve();await release.promise;};
  const result=f.service.recall(f.a.token,{query:'knowledge'});await reached.promise;f.context.revoke(f.a.token);release.resolve();
  await assert.rejects(result,error=>['forbidden','revoked'].includes(error?.code));
  assert.equal(f.requests.filter(request=>request.path==='/api/v1/content/read').length,0);
});

test('M05 membership stamp changes and team audience never fall back to private OpenViking recall',async t=>{
  const f=await fixture(t),record=f.accept(f.a,'member-record');f.index(record);
  const reached=deferred(),release=deferred();f.hooks.find=async()=>{reached.resolve();await release.promise;};
  const result=f.service.recall(f.a.token,{query:'knowledge'});await reached.promise;f.memberships.stamp='membership-v2';release.resolve();await assert.rejects(result,code('revoked'));
  f.authorities.get(f.a.token).audience='team';const before=f.requests.length;
  await assert.rejects(f.service.recall(f.a.token,{query:'knowledge'}),code('not_implemented'));assert.equal(f.requests.length,before);
});

test('M05 head CAS and tombstones invalidate details returned after asynchronous HTTP',async t=>{
  const f=await fixture(t),record=f.accept(f.a,'stale-record');f.index(record);
  const reached=deferred(),release=deferred();f.hooks.read=async()=>{reached.resolve();await release.promise;};
  const result=f.service.read(f.a.token,record.ref);await reached.promise;
  f.context.memoryLedger.acceptRevision({recordId:record.recordId,botId:f.a.bot.id,scope:{kind:'bot',botId:f.a.bot.id},kind:'fact',expectedRevision:1,policyEpoch:0,content:'Synthetic newer accepted head',evidenceRefs:['turn-synthetic:message-2'],operationKey:'accept-newer-head'});
  release.resolve();await assert.rejects(result,code('revoked'));
  const forgotten=f.accept(f.a,'forgotten-late-record');f.index(forgotten);
  const reachedForget=deferred(),releaseForget=deferred();f.hooks.read=async()=>{reachedForget.resolve();await releaseForget.promise;};
  const late=f.service.read(f.a.token,forgotten.ref);await reachedForget.promise;
  f.context.memoryLedger.forgetRecord({recordId:forgotten.recordId,expectedRevision:1,policyEpoch:0,operationKey:'forget-record',suppressionSignature:'synthetic-suppression'});
  releaseForget.resolve();await assert.rejects(late,code('revoked'));
  f.hooks.read=null;const before=f.requests.length;await assert.rejects(f.service.read(f.a.token,forgotten.ref),code('revoked'));assert.equal(f.requests.length,before);
});

test('M05 recall reads at most six details, caps body bytes and bounds structured references',async t=>{
  const f=await fixture(t);for(let i=0;i<9;i++){const r=f.accept(f.a,'bounded-'+i,'x'.repeat(8000),{evidenceRefs:Array.from({length:32},(_,n)=>'synthetic-reference-'+n+'x'.repeat(400))});f.index(r);}
  const result=await f.service.recall(f.a.token,{query:'knowledge'});
  assert.equal(result.length,4);assert.ok(result.reduce((sum,item)=>sum+Buffer.byteLength(item.markdown),0)<=MEMORY_SERVICE_LIMITS.totalBytes);
  assert.ok(f.requests.filter(request=>request.path==='/api/v1/content/read').length<=6);
  for(const detail of result){assert.ok(detail.provenance.evidence.length<=8);assert.ok(detail.provenance.evidence.reduce((n,e)=>n+Buffer.byteLength(e.reference),0)<=2048);}
});

test('M05 real projection journal persists lost ACK and reopened reconciliation uses GET only with the original binding',async t=>{
  const f=await fixture(t),record=f.accept(f.a,'lost-ack-record');f.hooks.write=async(_req,res)=>res.destroy();
  const first=await f.service.flushBotProjections(f.a.bot.id);assert.equal(first.attempted,1);assert.equal(first.receipts[0].outcome,'unknown');
  const writes=()=>f.requests.filter(request=>request.path==='/api/v1/content/write').length;assert.equal(writes(),1);
  assert.equal(f.context.memoryLedger.listPendingProjections(f.a.bot.id).items[0].state,'unknown');
  await f.reopen();f.hooks.write=null;const second=await f.service.flushBotProjections(f.a.bot.id);
  assert.equal(second.receipts[0].outcome,'confirmed');assert.equal(second.receipts[0].operationKey,record.projectionOperationKey);assert.equal(writes(),1);
  assert.equal(f.context.memoryLedger.listPendingProjections(f.a.bot.id).items.length,0);
});

test('M05 missing bot key is typed and sanitized; immutable config cannot redirect requests or borrow another bot credential',async t=>{
  let privateValue='synthetic-provider-exception';const backend={origin:'http://127.0.0.1:1',credential:()=>{throw Error(privateValue);}};
  const f=await fixture(t,{backend});backend.origin='https://redirected.invalid';backend.credential=keyFor;
  await assert.rejects(f.service.status(f.a.token),error=>error?.code==='blocked_configuration'&&!String(error).includes(privateValue));assert.equal(f.requests.length,0);
  privateValue='rotated-exception';assert.equal(JSON.stringify(f.service).includes('redirected'),false);
});

test('M05 another bot user key is rejected locally before health/search and real unconfigured supervisor never starts implicitly',async t=>{
  const f=await fixture(t);let probes=0;
  const supervisor=new OpenVikingSupervisor({mode:'unconfigured'},{probe:async()=>{probes++;throw Error('unadmitted');}});
  const service=new MemoryService({...f.config,ledger:f.context.memoryLedger,resolveAuthority:token=>f.context.memoryServiceAuthority(token),
    backend:{...f.config.backend,credential:()=>keyFor(f.b.identity)},supervisor});
  assert.equal(supervisor.snapshot().state,'stopped');
  await assert.rejects(service.status(f.a.token),code('blocked_configuration'));assert.equal(f.requests.length,0);assert.equal(probes,0);
  await service.close();assert.equal(probes,0);assert.equal(supervisor.snapshot().state,'stopped');
});

test('M05 close aborts owned requests, drains accepted calls, stops only injected lifetime and retained references refuse',async t=>{
  const calls=[];const supervisor={stop:async()=>{calls.push('stop');return {complete:true};}};
  const f=await fixture(t,{supervisor}),record=f.accept(f.a,'closing-record');f.index(record);
  const reached=deferred(),release=deferred();f.hooks.find=async()=>{reached.resolve();await release.promise;};
  const result=f.service.recall(f.a.token,{query:'knowledge'});const observed=result.catch(error=>error);await reached.promise;
  const close=f.service.close();release.resolve();await close;assert.ok((await observed).code);assert.deepEqual(calls,['stop']);assert.equal(f.service.diagnostic().state,'closed');
  await assert.rejects(f.service.status(f.a.token),code('closed'));
});

test('M05 R2 custody ignoring abort yields bounded deadlines for all facades; late keys cannot dispatch and host retains its writer until physical closure',async t=>{
  const root=realpathSync(mkdtempSync('/private/tmp/dexter-memory-service-deadline-r2-')),entered=deferred(),release=deferred();
  const custody=[];let networkCalls=0,closed=false;
  const host=new HostServices({dataDir:join(root,'data'),memoryService:{jobTimeoutMs:50,backend:{origin:'http://127.0.0.1:1',
    credential:async(identity,options)=>{custody.push({identity,signal:options.signal});if(custody.length===4)entered.resolve();await release.promise;return keyFor(identity);},
    fetch:async()=>{networkCalls++;throw Error('Synthetic network must not be admitted after stale custody');}}}});
  t.after(async()=>{release.resolve();await host.shutdown();rmSync(root,{recursive:true,force:true});});
  const bot=host.store.createBot({name:'Synthetic deadline bot',profileId:'synthetic',engine:'codex'}),thread=host.store.createThread(bot.id);
  const turn=host.store.createTurn(thread.id,{clientRequestId:'synthetic-deadline',content:'Synthetic'}).turn;host.store.claimNextTurn(thread.id);
  const token=host.context.issue(turn.id),ledger=host.context.memoryLedger;ledger.provisionBotSubject(bot.id);
  const record=ledger.acceptRevision({recordId:'deadline-record',botId:bot.id,scope:{kind:'bot',botId:bot.id},kind:'fact',expectedRevision:0,policyEpoch:0,
    content:'Synthetic deadline knowledge',evidenceRefs:['turn-synthetic:deadline'],operationKey:'deadline-accept'});
  const counts=ledger.status().counts,ref={recordId:record.recordId,revision:record.revision,sha256:record.sha256},started=performance.now();
  const outputs=Promise.allSettled([host.memoryService.status(token),host.memoryService.read(token,ref),host.memoryService.recall(token,{query:'knowledge'}),host.memoryService.flushBotProjections(bot.id)]);
  assert.equal(host.memoryService.diagnostic().jobTimeoutMs,50);
  await entered.promise;const results=await outputs;
  assert.ok(performance.now()-started<1000);assert.ok(results.every(result=>result.status==='rejected'&&result.reason.code==='deadline'));
  assert.ok(custody.every(call=>call.signal.aborted));assert.equal(networkCalls,0);assert.deepEqual(ledger.status().counts,counts);
  const physicalClose=host.memoryService.close().then(()=>{closed=true;});
  await assert.rejects(host.shutdown({graceMs:20}));assert.equal(closed,false);assert.equal(host.memoryService.diagnostic().state,'stopping');
  assert.doesNotThrow(()=>host.context.status());assert.doesNotThrow(()=>host.store.listBots());
  const databasePath=host.context.databasePath;release.resolve();await physicalClose;await host.shutdown();assert.equal(networkCalls,0);
  const db=new DatabaseSync(databasePath,{readOnly:true});try{
    assert.equal(db.prepare('SELECT state FROM memory_projection_outbox WHERE operation_key=?').get(record.projectionOperationKey).state,'queued');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_projection_receipts').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_revisions').get().n,1);
  }finally{db.close();}
});

test('M05 R2 one whole-job budget includes custody plus HTTP, and raced transport cannot conceal an ignored fetch closure from close',async t=>{
  const reachedFetch=deferred(),releaseFetch=deferred();let requests=0,identity,physicalClosed=false;
  const f=await fixture(t,{jobTimeoutMs:80,backend:{origin:'http://127.0.0.1:1',timeoutMs:1000,
    credential:async value=>{identity=value;await new Promise(done=>setTimeout(done,40));return keyFor(value);},
    fetch:async()=>{requests++;reachedFetch.resolve();await releaseFetch.promise;return new Response(JSON.stringify({status:'ok',healthy:true,auth_mode:'api_key',role:'user',account_id:identity.accountId,user_id:identity.userId}),{headers:{'content-type':'application/json'}});}}});
  t.after(()=>releaseFetch.resolve());
  for(const jobTimeoutMs of [0,120001,NaN,Infinity])assert.throws(()=>new MemoryService({...f.config,ledger:f.context.memoryLedger,jobTimeoutMs}),code('blocked_configuration'));
  assert.equal(f.service.diagnostic().jobTimeoutMs,80);
  const started=performance.now(),result=f.service.status(f.a.token);await reachedFetch.promise;
  await assert.rejects(result,code('deadline'));assert.ok(performance.now()-started<1000);assert.equal(requests,1);
  const close=f.service.close().then(()=>{physicalClosed=true;});await new Promise(done=>setTimeout(done,20));assert.equal(physicalClosed,false);
  assert.doesNotThrow(()=>f.context.memoryLedger.status());releaseFetch.resolve();await close;assert.equal(physicalClosed,true);assert.equal(requests,1);
  const completed=new MemoryService({...f.config,ledger:f.context.memoryLedger,jobTimeoutMs:1000});
  assert.equal((await completed.status(f.a.token)).identityVerified,true);await completed.close();assert.equal(completed.diagnostic().state,'closed');
  const reachedBody=deferred(),releaseBody=deferred();let bodyClosed=false;
  const streaming=new MemoryService({...f.config,ledger:f.context.memoryLedger,jobTimeoutMs:50,backend:{...f.config.backend,credential:keyFor,
    fetch:async()=>new Response(new ReadableStream({pull:async controller=>{reachedBody.resolve();await releaseBody.promise;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({status:'ok',healthy:true,auth_mode:'api_key',role:'user',account_id:f.a.identity.accountId,user_id:f.a.identity.userId})));controller.close();}}, {highWaterMark:0}),{headers:{'content-type':'application/json'}})}});
  t.after(()=>releaseBody.resolve());const streamResult=streaming.status(f.a.token);await reachedBody.promise;await assert.rejects(streamResult,code('deadline'));
  const streamClose=streaming.close().then(()=>{bodyClosed=true;});await new Promise(done=>setTimeout(done,20));assert.equal(bodyClosed,false);
  assert.doesNotThrow(()=>f.context.memoryLedger.status());releaseBody.resolve();await streamClose;assert.equal(bodyClosed,true);
});
