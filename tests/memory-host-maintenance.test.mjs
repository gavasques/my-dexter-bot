import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';
const source=readFileSync(new URL('../packages/cli/src/memory-host-maintenance.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
// Pure scheduling class only. The final package typecheck and actual HostServices composition are separate gates.
const {HostMemoryMaintenance}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
function fixture({deletes=0,projections=0,age=120001,busy=false}={}) {
  const log=[],state={deletes,projections,age,busy};let signal;
  const host={now:()=>200000,lastMemoryChatActivityAt:()=>200000-state.age,
    listBots:()=>[{id:'own'}],listTurnsByState:kind=>state.busy&&kind==='running'?[{}]:[]};
  const learning={tick:async()=>log.push('learning'),chatStarted:()=>log.push('chat')};
  const ledger={listPendingDeletes:()=>Array(state.deletes).fill({}),listPendingProjections:()=>({items:Array(state.projections).fill({})})};
  const service={flushBotDeletes:async(bot,limit,options)=>{signal=options.signal;log.push(['delete',bot,limit,signal.aborted]);},
    flushBotProjections:async(bot,limit,options)=>{signal=options.signal;log.push(['project',bot,limit,signal.aborted]);}};
  return {maintenance:new HostMemoryMaintenance(host,learning,ledger,service,()=>120000),log,state,service,signal:()=>signal};
}
test('empty durable queues never provision a backend or make a data request',async()=>{
  const q=fixture();await q.maintenance.tick();assert.deepEqual(q.log,['learning']);
});
test('chat activity and each bot idle limit prevent backend maintenance',async()=>{
  for(const options of [{age:10},{busy:true}]){const q=fixture({...options,deletes:1,projections:1});await q.maintenance.tick();assert.deepEqual(q.log,['learning']);}
});
test('durable tombstones reconcile before accepted projections in a bounded batch',async()=>{
  const q=fixture({deletes:1,projections:1});await q.maintenance.tick();
  assert.deepEqual(q.log,['learning',['delete','own',1,false],['project','own',1,false]]);
});
test('chat arrival aborts the owned purge and prevents following projection',async()=>{
  const q=fixture({deletes:1,projections:1});let release;
  q.service.flushBotDeletes=async(bot,limit,{signal})=>{q.log.push('held-delete');await new Promise(r=>release=r);assert.equal(signal.aborted,true);};
  const first=q.maintenance.tick();await Promise.resolve();await Promise.resolve();assert.equal(q.log.at(-1),'held-delete');
  q.state.busy=true;q.maintenance.chatStarted();release();await first;
  assert.deepEqual(q.log,['learning','held-delete','chat']);
});
test('concurrent ticks coalesce and close waits for owned work to settle',async()=>{
  const q=fixture({projections:1});let release,closed=false;
  q.service.flushBotProjections=async()=>{q.log.push('held-project');await new Promise(r=>release=r);};
  const first=q.maintenance.tick(),second=q.maintenance.tick();assert.equal(first,second);
  await Promise.resolve();await Promise.resolve();
  const close=q.maintenance.close().then(()=>closed=true);await Promise.resolve();assert.equal(closed,false);
  release();await first;await close;assert.equal(closed,true);
  await q.maintenance.tick();assert.deepEqual(q.log,['learning','held-project']);
});
