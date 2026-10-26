import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { AgendaHostConsumer } from "@dexter/agenda";
import type { EngineId } from "@dexter/contracts";
import { ManagedAppsRuntime } from "@dexter/connectors";
import { HostError, HostStore } from "@dexter/hub";
import type { HostServices as HostServicesType } from "../packages/cli/src/host-services.js";
import { countingEngine } from "./fixtures/relay-recovery-lab.js";
const { HostServices } = await import(pathToFileURL(resolve("packages/cli/dist/host-services.js")).href) as { HostServices: typeof HostServicesType };
const code = (c:string) => (error:unknown) => error instanceof HostError && error.code === c;
function stack(t:TestContext, config: { holdClose?:boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(),"dx-host-agenda-")); let calls = 0; let release = () => {};
  const close = new Promise<void>(done => { release = done; });
  const options = { dataDir:root, enableEngines:true, enableAgenda:true, makeDriver: (engine:EngineId) => ({ id:engine,
    capabilities:{resume:true,interrupt:true,fork:false,steer:false}, async status() { return {engine,installed:true,version:"synthetic",authentication:"authenticated" as const,billing:"subscription" as const}; },
    async open(threadId:string,nativeCursor?:string) { return {threadId,nativeCursor:nativeCursor ?? "synthetic-cursor"}; },
    async *turn(session:{threadId:string},turnId:string) { calls++; yield {type:"turn.completed" as const,threadId:session.threadId,turnId,usage:{}}; },
    async respondToTool() {}, async interrupt() {}, async close() { if(config.holdClose) await close; } }) };
  let services = new HostServices(options);
  const bot = services.store.createBot({name:"Agenda",profileId:"personal",engine:"claude"}), thread = services.store.createThread(bot.id);
  t.after(async()=>{release();await services.shutdown({graceMs:3000});rmSync(root,{recursive:true,force:true});});
  return {root,bot,thread,get services(){return services;},get calls(){return calls;},release,
    schedule(){return services.agendaAdmin.create({botId:bot.id,threadId:thread.id,content:"trusted input",when:{kind:"once",at:services.store.now()}});},
    async restart(){await services.shutdown({graceMs:3000});services = new HostServices(options);} };
}
test("Agenda opt-in rejects missing runtime and malformed flag before creating a canonical host", () => {
  const root=mkdtempSync(join(tmpdir(),"dx-agenda-invalid-")); const absent=join(root,"absent");
  try { for(const options of [{enableAgenda:true},{enableAgenda:"yes"}]) { assert.throws(()=>new HostServices({dataDir:absent,...options} as never),code("invalid_input"));assert.equal(existsSync(absent),false); } }
  finally{rmSync(root,{recursive:true,force:true});}
});
test("same-host manual tick accepts exactly one turn and restart/repeated tick do not infer again",async t=>{
  const l=stack(t), schedule=l.schedule(); assert.equal(l.calls,0);assert.equal(l.services.store.listTurns(l.thread.id).length,0);
  const tick=l.services.tickAgenda();assert.equal(l.services.tickAgenda(),tick);const report=await tick;assert.equal(report.accepted,1);
  const receipt=l.services.agendaAdmin.listOccurrences({scheduleId:schedule.id}).items[0]!;
  await l.services.runtime!.waitForTurn(receipt.turnId!);assert.equal(l.calls,1);
  assert.equal((await l.services.tickAgenda()).attempted,0);await l.restart();assert.equal((await l.services.tickAgenda()).attempted,0);assert.equal(l.calls,1);
  assert.equal(l.services.store.listTurns(l.thread.id).length,1);assert.equal(l.services.store.getTurn(receipt.turnId!).clientRequestId,receipt.clientRequestId);
});
test("held queued turn is not resumed by manual consumer, even across repeated ticks",async t=>{
  const l=stack(t);const held=l.services.store.createTurn(l.thread.id,{clientRequestId:"held",content:"preserved"}).turn;
  await l.restart();assert.equal(l.services.runtime!.status().heldQueuedTurns,1);l.schedule();
  assert.equal((await l.services.tickAgenda()).deferred,1);assert.equal((await l.services.tickAgenda()).pending,1);
  assert.equal(l.services.store.getTurn(held.id).state,"queued");assert.equal(l.calls,0);assert.equal(l.services.store.listTurns(l.thread.id).length,1);
});
test("shutdown admission closes retained Agenda facade before failed runtime drain; positive retry releases writer",async t=>{
  const l=stack(t,{holdClose:true}), retained=l.services.agendaAdmin;l.schedule();const report=await l.services.tickAgenda();await l.services.runtime!.waitForTurn(report.attempts[0]!.turnId!);
  await assert.rejects(l.services.shutdown({graceMs:10}));assert.throws(()=>retained.listSchedules(),code("conflict"));assert.throws(()=>l.services.agendaAdmin,code("conflict"));await assert.rejects(l.services.tickAgenda(),code("conflict"));
  assert.throws(()=>new HostStore({dataDir:l.root}),code("host_locked"));l.release();await l.services.shutdown({graceMs:3000});const reopened=new HostStore({dataDir:l.root});reopened.close();
});
test("shutdown before deferred tick starts accepts no turn and closes auxiliary without closing store early",async t=>{
  const l=stack(t);l.schedule();const tick=l.services.tickAgenda();const close=l.services.shutdown({graceMs:3000});await assert.rejects(tick,code("conflict"));await close;assert.equal(l.calls,0);
  const reopened=new HostStore({dataDir:l.root});assert.equal(reopened.listTurns(l.thread.id).length,0);reopened.close();
});

test("commit before ACK failure survives host restart and unknown turn is acknowledged without reinference",async t=>{
  const l=stack(t), schedule=l.schedule();const agenda=new DatabaseSync(join(l.root,"agenda.sqlite"));
  agenda.exec("CREATE TRIGGER synthetic_ack_failure BEFORE UPDATE ON occurrences WHEN NEW.state = 'accepted' BEGIN SELECT RAISE(ABORT, 'synthetic_ack_failure'); END");
  assert.equal((await l.services.tickAgenda()).deferred,1);const occurrence=l.services.agendaAdmin.listOccurrences({scheduleId:schedule.id}).items[0]!;
  const committed=l.services.store.findTurn(l.thread.id,occurrence.clientRequestId)!;await l.services.runtime!.waitForTurn(committed.id);assert.equal(l.calls,1);
  await l.services.shutdown({graceMs:3000});agenda.exec("DROP TRIGGER synthetic_ack_failure");agenda.close();
  // Only the durable synthetic crash record is changed after all native fixture cleanup was confirmed.
  const hub=new DatabaseSync(l.services.store.databasePath);hub.prepare("UPDATE turns SET state = 'running' WHERE id = ?").run(committed.id);hub.close();
  await l.restart();assert.equal(l.services.store.getTurn(committed.id).state,"unknown");assert.equal((await l.services.tickAgenda()).replayed,1);
  assert.equal(l.services.agendaAdmin.listOccurrences({scheduleId:schedule.id}).items[0]!.turnId,committed.id);assert.equal(l.calls,1);assert.equal(l.services.store.listTurns(l.thread.id).length,1);
});

for (const rejected of [false,true]) test(`constructor rollback disposes idle Agenda before writer release; rejection holds writer=${rejected}`,()=>{
  const root=mkdtempSync(join(tmpdir(),"dx-agenda-rollback-"));let store:HostStore|undefined;let disposals=0,providerCalls=0;
  const bind=ManagedAppsRuntime.prototype.bind,dispose=AgendaHostConsumer.prototype.disposeUnstarted;
  ManagedAppsRuntime.prototype.bind=function(s){store=s as HostStore;throw Error("synthetic_late_bind_failure");};
  AgendaHostConsumer.prototype.disposeUnstarted=function(){
    disposals++;assert.ok(store);assert.throws(()=>new HostStore({dataDir:root}),code("host_locked"));
    dispose.call(this);if(rejected)throw Error("synthetic_disposal_failure");
  };
  const providerCall=async()=>{providerCalls++;throw Error("unexpected_provider_work");};
  try{
    assert.throws(()=>new HostServices({dataDir:root,enableEngines:true,enableMcp:true,enableAgenda:true,makeDriver:countingEngine().makeDriver,
      managedApps:{provider:{catalog:providerCall,provision:providerCall,lookup:providerCall,account:providerCall},
        credentialRef:"synthetic-ref",broker:{acquire(){providerCalls++;return null;},secretValues(){return [];}},
        fetch:providerCall,disposeOwnedBroker:async()=>{providerCalls++;}}}),
      new RegExp(rejected?"synthetic_disposal_failure":"synthetic_late_bind_failure"));
    assert.equal(disposals,1);assert.equal(providerCalls,0);
    if(rejected)assert.throws(()=>new HostStore({dataDir:root}),code("host_locked"));
    else{const reopened=new HostStore({dataDir:root});reopened.close();}
  }finally{ManagedAppsRuntime.prototype.bind=bind;AgendaHostConsumer.prototype.disposeUnstarted=dispose;
    // Explicit fixture teardown after the assertion; production must retain an unconfirmed writer.
    if(rejected)store?.close();rmSync(root,{recursive:true,force:true});}
});
