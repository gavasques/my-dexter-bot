import assert from 'node:assert/strict';
import {test}from 'node:test';
import {mkdtempSync,rmSync,readFileSync,readdirSync}from 'node:fs';
import{tmpdir}from'node:os';import{join}from'node:path';
import{ToolExecutionFailure}from'@dexter/contracts';
import{HostStore,dispatchAction}from'@dexter/hub';
for(const phase of ['before_dispatch','after_dispatch']as const)test(`trusted ${phase} becomes a bounded terminal receipt, never replayed`,async t=>{
  const dir=mkdtempSync(join(tmpdir(),'dx-mcp-outcome-')),store=new HostStore({dataDir:dir});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const bot=store.createBot({name:'Synthetic',profileId:'default',engine:'claude'}),thread=store.createThread(bot.id);
  store.setGrant({botId:bot.id,tool:'fixture.write',destination:'fixture',policy:'allow'});
  const action=store.requestAction({botId:bot.id,threadId:thread.id,tool:'fixture.write',destination:'fixture',arguments:{},idempotencyKey:'one'});
  let calls=0;const done=await dispatchAction(store,action.id,async()=>{calls++;throw new ToolExecutionFailure(phase==='before_dispatch'?'egress_refused':'output_schema_invalid',phase);});
  assert.equal(done.state,phase==='before_dispatch'?'blocked':'unknown');assert.equal((done.result as {effectDispatched:boolean}).effectDispatched,phase==='after_dispatch');
  assert.equal((done.result as {retryAutomatically:boolean}).retryAutomatically,false);
  await assert.rejects(dispatchAction(store,action.id,async()=>{calls++;return null;}));assert.equal(calls,1);
});
test('untrusted remote failure-shaped object cannot claim that an effect never started',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'dx-mcp-untrusted-')),store=new HostStore({dataDir:dir});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const bot=store.createBot({name:'Synthetic',profileId:'default',engine:'claude'}),thread=store.createThread(bot.id);
  store.setGrant({botId:bot.id,tool:'fixture.write',destination:'fixture',policy:'allow'});
  const action=store.requestAction({botId:bot.id,threadId:thread.id,tool:'fixture.write',destination:'fixture',arguments:{},idempotencyKey:'one'});
  const done=await dispatchAction(store,action.id,async()=>{throw {name:'ToolExecutionFailure',phase:'before_dispatch',code:'egress_refused',message:'sk-SYNTHETIC-LEAK-CANARY-0123456789'};});
  assert.equal(done.state,'unknown');
  const bytes=readdirSync(dir).filter(n=>n.endsWith('.sqlite')||n.endsWith('-wal')).map(n=>readFileSync(join(dir,n)).toString('latin1')).join('');assert.ok(!bytes.includes('SYNTHETIC-LEAK-CANARY'));
});
