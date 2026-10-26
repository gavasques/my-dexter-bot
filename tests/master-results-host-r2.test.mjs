import { mcpDirectoryClient } from "./fixtures/mcp-directory-client.mjs";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnection } from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HostServices } from '../packages/cli/dist/host-services.js';
import { createHostApp } from '@dexter/hub/http';

// Own synthetic protocol endpoint: the actual HostServices turn-owned bridge, not an LLM/account.
function rpcClient(path) {
  const socket = createConnection(path), pending = new Map(); let sequence = 0, buffer = '';
  const connected = new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.on('error', () => {});
  socket.on('data', bytes => {
    buffer += bytes.toString(); let cut;
    while ((cut = buffer.indexOf('\n')) >= 0) {
      const row = JSON.parse(buffer.slice(0, cut)); buffer = buffer.slice(cut + 1);
      const waiter = pending.get(row.id); if (!waiter) continue;
      clearTimeout(waiter.timer); pending.delete(row.id);
      row.error ? waiter.reject(new Error('synthetic_rpc_refused')) : waiter.resolve(row.result);
    }
  });
  socket.on('close', () => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('synthetic_rpc_closed')); } pending.clear(); });
  const request = async (method, params) => {
    await connected; const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('synthetic_rpc_timeout')); }, 10_000);
      pending.set(id, { resolve, reject, timer }); socket.write(JSON.stringify({jsonrpc:'2.0', id, method, params}) + '\n');
    });
  };
  return { request, close: () => socket.destroy(), initialize: async () => {
    await request('initialize', {protocolVersion:'2025-11-25', capabilities:{}, clientInfo:{name:'synthetic-master',version:'1'}});
    socket.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}) + '\n');
  }};
}
async function until(predicate) {
  const end = Date.now() + 8000;
  while (!predicate()) { if (Date.now() > end) throw new Error('synthetic_state_timeout'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('actual HostServices bridge: specialist approval, parent answer, restart read and revoked peer authority', {timeout:30000}, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'dexter-master-host-r2-')));
  let services, master, specialist, parentTurn, app, phase='delegate', childRuns=0, childReceipt;
  const clients = [], inputs = [], traces = [], diagnostic = [], rpcTrace = [];
  const makeDriver = (id, options) => ({
    id, capabilities:{resume:true,interrupt:true,fork:false,steer:false},
    status:async () => ({engine:id,installed:true,authentication:'unverified'}),
    open:async (threadId) => {
      assert.ok(options.localMcpServer); const rpc=rpcClient(options.localMcpServer.args[1]);clients.push(rpc);
      await rpc.initialize(); return {threadId,nativeCursor:'synthetic-master-host-session',rpc};
    },
    async *turn(session, turnId, input) {
      const event=(type,extra={})=>({type,threadId:session.threadId,turnId,...extra});
      try {
        inputs.push({turnId,input}); const directory=mcpDirectoryClient(session.rpc.request);
        const find=async name=>{rpcTrace.push({phase,bot:services.store.getTurn(turnId).botId,find:name});const tool=await directory.find(name);rpcTrace.push({phase,found:name,alias:tool.name});return tool;};
        const call=async (tool,callId,args)=>{rpcTrace.push({phase,callId,tool:tool.name});const response=directory.result(await directory.call({...tool,viaDirectory:true},callId,args));rpcTrace.push({phase,callId,status:response.structuredContent?.status,isError:response.isError});return response;};
        const bot=services.store.getTurn(turnId).botId;
        if (bot===specialist.id) {
          childRuns++; assert.ok(input.includes('own specialist instructions')); assert.ok(!input.includes('MASTER_PRIVATE_ONLY'));
          const update=await find('dexter.harness.documents.update');
          const answer=await call(update,'specialist-own-change',{expectedRevision:1,document:'MEMORY',markdown:'Specialist own synthetic note'});
          assert.equal(answer.isError,false); childReceipt=answer.structuredContent;assert.equal(childReceipt.status,'succeeded');
          yield event('tool.result.observed',{actionId:childReceipt.actionId,requestHash:childReceipt.requestHash,status:childReceipt.status});
          yield event('text.delta',{text:'Specialist final reply after own approval'});
        } else {
          const results=await find('dexter.bots.results');
          if(phase==='delegate') {
            const delegate=await find('dexter.bots.delegate');
            const reply=await call(delegate,'master-peer-request',{targetBotId:specialist.id,task:'Use your own instructions and update your own note, then return a result.'});
            assert.equal(reply.isError,false); assert.equal(reply.structuredContent.status,'succeeded');
            const item=reply.structuredContent.result; assert.equal(item.targetBotId,specialist.id); assert.equal(item.state,'completed');
            assert.equal(item.result,'Specialist final reply after own approval');
            traces.push(item); yield event('text.delta',{text:'Master consolidated: '+item.result});
          } else if(phase==='recover') {
            const response=await call(results,'historical-results',{sourceTurnId:parentTurn.id});
            assert.equal(response.isError,false);assert.equal(response.structuredContent.result.items.length,1);
            assert.equal(response.structuredContent.result.items[0].result,traces[0].result);
            yield event('text.delta',{text:'Recovered existing specialist reply; no repeated work'});
          } else {
            const response=await call(results,'revoked-results',{sourceTurnId:parentTurn.id});
            assert.equal(response.isError,true);yield event('text.delta',{text:'Peer authority revoked; no result exposed'});
          }
        }
        yield event('turn.completed',{usage:{}});
      } catch(error) { diagnostic.push({phase,code:error?.code??error?.name??'error'});throw error; }
    },
    respondToTool:async()=>{},interrupt:async()=>{},close:async session=>session.rpc.close(),
  });
  const open=()=>{
    services=new HostServices({dataDir:join(root,'host'),enableEngines:true,enableMcp:true,enableBotDelegation:true,enableWorkspaceTools:false,
      engineCommands:{codex:'/usr/bin/false'},engineCatalog:async()=>[{id:'codex',available:true,defaultModel:null,models:[],reasoningEfforts:[],speeds:[]}],makeDriver});
    app=createHostApp(services.store,{runtime:services.runtime,botDocuments:services.botDocumentsHttp,botDelegation:services.botDelegation});
  };
  try {
    open();master=services.store.createBot({name:'Synthetic Master',profileId:'synthetic',engine:'codex'});
    specialist=services.store.createBot({name:'Synthetic Specialist',profileId:'synthetic',engine:'codex'});
    master=services.store.patchBot(master.id,{expectedRevision:master.revision,canSeeBots:true,canSendActions:true,isMaster:true});
    specialist=services.store.patchBot(specialist.id,{expectedRevision:specialist.revision,canReceiveOrders:true});
    services.botDocumentsHttp.compareAndSet(master.id,{expectedRevision:0,soul:'MASTER_PRIVATE_ONLY',user:'',memory:''});
    services.botDocumentsHttp.compareAndSet(specialist.id,{expectedRevision:0,soul:'own specialist instructions',user:'',memory:''});
    // Parent permission cannot authorize the specialist's document mutation.
    services.store.setGrant({botId:master.id,tool:'dexter.harness.documents.update',destination:'dexter-harness-owner-proposals',policy:'allow'});
    // The specialist's own default can save a direct note automatically. An explicit own Ask
    // is required to test its approval boundary independently of the parent's Allow grant.
    services.store.setGrant({botId:specialist.id,tool:'dexter.harness.documents.update',destination:'dexter-harness-owner-proposals',policy:'ask'});
    const thread=services.store.createThread(master.id);
    parentTurn=services.runtime.startTurn(thread.id,{clientRequestId:'master-parent-r2',content:'Ask the specialist for its own approved note and consolidate its answer.'}).turn;
    await until(()=>services.store.listActions('awaiting_approval').length===1 || diagnostic.length>0);
    assert.deepEqual(diagnostic,[]);
    const action=services.store.listActions('awaiting_approval')[0];assert.equal(action.request.botId,specialist.id);
    assert.equal(action.state,'awaiting_approval');assert.equal(action.authorization,undefined);assert.equal(childRuns,1);
    assert.equal(services.botDocumentsHttp.read(specialist.id).memory,'');
    const response=await app.request(`http://127.0.0.1/v1/actions/${action.id}/decisions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:'allow',requestHash:action.requestHash})});
    assert.equal(response.status,200);const done=await services.runtime.waitForTurn(parentTurn.id,10000);assert.equal(done.state,'completed');
    assert.equal(services.store.turnOutput(done.id),'Master consolidated: Specialist final reply after own approval');
    assert.equal(services.botDocumentsHttp.read(specialist.id).memory,'Specialist own synthetic note');
    assert.equal(services.botDocumentsHttp.read(master.id).memory,'');assert.equal(childRuns,1);
    assert.equal(services.store.toolActionProgress(action.id).consumedByEngine,true);
    const count=services.botDelegation.list().length;assert.equal(count,1);
    await services.shutdown();services=null;phase='recover';open();
    const recovered=services.runtime.startTurn(thread.id,{clientRequestId:'master-recover-r2',content:'Consult the existing specialist result.'}).turn;
    assert.equal((await services.runtime.waitForTurn(recovered.id,10000)).state,'completed');
    assert.equal(services.botDelegation.list().length,count);assert.equal(childRuns,1);
    specialist=services.store.getBot(specialist.id);services.store.patchBot(specialist.id,{expectedRevision:specialist.revision,canReceiveOrders:false});
    phase='revoked';const revoked=services.runtime.startTurn(thread.id,{clientRequestId:'master-revoked-r2',content:'Check whether the old result remains authorized.'}).turn;
    assert.equal((await services.runtime.waitForTurn(revoked.id,10000)).state,'completed');assert.equal(childRuns,1);assert.equal(services.botDelegation.list().length,count);
    assert.deepEqual(diagnostic,[]);
  } catch(error) {
    t.diagnostic(JSON.stringify({phase,rpcTrace,diagnostic,actions:services?.store.listActions().map(a=>({id:a.id,botId:a.request.botId,tool:a.request.tool,state:a.state,reason:a.reason})),delegations:services?.botDelegation.list()}));throw error;
  } finally {
    for(const rpc of clients)rpc.close();if(services)await services.shutdown().catch(()=>{});rmSync(root,{recursive:true,force:true});
  }
});
