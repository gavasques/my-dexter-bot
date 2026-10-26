import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { HostStore } from '../packages/hub/dist/index.js';
import { ContextHost, FixtureMemoryAdapter } from '../packages/context/dist/index.js';
import { OpenVikingAdapter } from '../packages/context/dist/openviking-adapter.js';
import { OpenVikingIdentityMapper } from '../packages/context/dist/openviking-identity.js';
import { validateMemoryLedger } from '../packages/operations/dist/memory-ledger.js';

const code=expected=>error=>error?.code===expected;
async function fixture(t){
 const root=realpathSync(mkdtempSync('/private/tmp/dexter-memory-ledger-adapter-r1-')),clock={now:1000},store=new HostStore({dataDir:join(root,'data'),clock:()=>clock.now}),bot=store.createBot({name:'Synthetic HTTP',profileId:'synthetic',engine:'codex'}),mapper=new OpenVikingIdentityMapper(store.hostId),identity=mapper.bot(bot.id);
 let context=new ContextHost(store,new FixtureMemoryAdapter([]),{memoryIdentityMapper:botId=>mapper.bot(botId)});context.memoryLedger.provisionBotSubject(bot.id);
 const state={writes:0,files:new Map(),mode:'normal',beforeAck:null},adapters=[];
 const send=(res,result,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(result));};
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');let raw='';for await(const chunk of req)raw+=chunk;
  if(url.pathname==='/health')return send(res,{status:'ok',healthy:true,auth_mode:'api_key',role:'user',account_id:identity.accountId,user_id:identity.userId});
  if(url.pathname==='/api/v1/content/read'){
   const text=state.files.get(url.searchParams.get('uri'));
   return text===undefined?send(res,{status:'error',error:{code:'NOT_FOUND'}},404):send(res,{status:'ok',result:text});
  }
  if(url.pathname==='/api/v1/content/write'){
   const body=JSON.parse(raw);state.writes++;assert.equal(body.mode,'create');state.files.set(body.uri,body.content);
   if(state.beforeAck)await state.beforeAck();
   if(state.mode==='lost-ack')return req.socket.destroy();
   return send(res,{status:'ok',result:{uri:body.uri,mode:'create',content_updated:true,written_bytes:Buffer.byteLength(body.content),semantic_status:'queued',vector_status:'queued'}});
  }
  return send(res,{status:'error',error:{code:'NOT_FOUND'}},404);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 const adapter=worker=>{const value=new OpenVikingAdapter({origin,identity,credential:()=>[identity.accountId,identity.userId,'1'.repeat(64)].map(value=>Buffer.from(value).toString('base64url')).join('.'),journal:context.memoryLedger.projectionJournal(worker,30_000)});adapters.push(value);return value;};
 t.after(async()=>{adapters.forEach(adapter=>adapter.close());server.closeAllConnections();await new Promise(resolve=>server.close(resolve));context.close();store.close();rmSync(root,{recursive:true,force:true});});
 const accepted=context.memoryLedger.acceptRevision({recordId:'synthetic HTTP record',botId:bot.id,scope:{kind:'bot',botId:bot.id},kind:'fact',expectedRevision:0,policyEpoch:0,content:'\ufeffMemória literal e\u0301 🚀\r\n',evidenceRefs:['synthetic-source'],operationKey:'accept-http'});
 const input={operationKey:accepted.projectionOperationKey,recordId:accepted.recordId,revision:accepted.revision,markdown:context.memoryLedger.readRevision(accepted.recordId).content,sha256:accepted.sha256};
 const reopen=()=>{context.close();context=new ContextHost(store,new FixtureMemoryAdapter([]),{memoryIdentityMapper:botId=>mapper.bot(botId)});};
 const validate=()=>store.withWriterLease(()=>{const db=new DatabaseSync(context.databasePath,{readOnly:true}),hub=new DatabaseSync(store.databasePath,{readOnly:true});try{validateMemoryLedger(db,hub);}finally{db.close();hub.close();}});
 return {state,adapter,input,reopen,validate,accepted,bot,clock,get ledger(){return context.memoryLedger;}};
}

test('M02 + M03 actual HTTP create/read-back records canonical receipt, mapper/URI/key agree and confirmed replay sends once',async t=>{
 const f=await fixture(t),first=await f.adapter('first-worker').project(f.input);assert.equal(first.outcome,'confirmed');assert.equal(first.indexing,'unproven');assert.equal(first.uri,f.accepted.uri);assert.equal(f.state.writes,1);f.validate();
 f.reopen();const replay=await f.adapter('restarted-worker').project(f.input);assert.equal(replay.outcome,'confirmed');assert.equal(f.state.writes,1);f.validate();
 assert.deepEqual(f.ledger.listPendingProjections(f.bot.id).items,[]);
});

test('M02 + M03 lost ACK survives ledger reopen and reconciles with GET without a second POST',async t=>{
 const f=await fixture(t);f.state.mode='lost-ack';const unknown=await f.adapter('first-worker').project(f.input);assert.equal(unknown.outcome,'unknown');assert.equal(f.state.writes,1);f.validate();
 f.reopen();f.state.mode='normal';const pending=f.ledger.listPendingProjections(f.bot.id).items;assert.equal(pending.length,1);assert.equal(pending[0].state,'unknown');
 assert.equal((await f.adapter('restarted-worker').project(f.input)).outcome,'confirmed');assert.equal(f.state.writes,1);f.validate();
});

test('M02 + M03 forget during HTTP blocks a late success receipt; remote purge remains explicit pending work',async t=>{
 const f=await fixture(t);f.state.beforeAck=async()=>{f.ledger.forgetRecord({recordId:f.accepted.recordId,expectedRevision:1,policyEpoch:0,operationKey:'forget-http',suppressionSignature:'synthetic-source'});};
 await assert.rejects(f.adapter('first-worker').project(f.input),code('journal'));assert.equal(f.state.writes,1);assert.equal(f.state.files.has(f.accepted.uri),true);
 assert.throws(()=>f.ledger.readRevision(f.accepted.recordId),code('forbidden'));assert.deepEqual(f.ledger.listPendingProjections(f.bot.id).items,[]);assert.equal(f.ledger.status().remotePurge,'not_implemented');f.validate();
});
