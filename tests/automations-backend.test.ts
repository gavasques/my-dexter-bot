import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtempSync,rmSync,readFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Agenda,AgendaHostConsumer,nextAutomationAt,validateAutomationWhen} from '@dexter/agenda';
import {HostStore,ConversationRuntime,HostError} from '@dexter/hub';
import {createHostApp} from '@dexter/hub/http';
import {createAutomationHttpPort} from '../packages/cli/src/automation-http-port.js';
import {checkFullSchema,agendaSchemaLabel} from '../packages/operations/src/full-schemas.js';
const conflict=(error:unknown)=>error instanceof HostError&&error.code==='conflict';
function lab(t:TestContext){
  const dir=mkdtempSync(join(tmpdir(),'dx-auto-backend-')),clock={now:Date.parse('2026-10-11T12:00:00Z')};
  const store=new HostStore({dataDir:dir,clock:()=>clock.now}),bot=store.createBot({name:'Synthetic scheduling',profileId:'fixture',engine:'claude'}),thread=store.createThread(bot.id);
  const runtime=new ConversationRuntime({store,drivers:[]});
  let agenda=new Agenda(store,{clock:()=>clock.now});
  t.after(async()=>{agenda.close();await runtime.shutdown({graceMs:1000});rmSync(dir,{recursive:true,force:true});});
  return {dir,clock,store,bot,thread,runtime,get agenda(){return agenda;},reopen(){agenda.close();agenda=new Agenda(store,{clock:()=>clock.now});},bind(){return {hostId:store.hostId,botId:bot.id,threadId:thread.id};}};
}
test('automations preserve v2 rows, durable CAS/replay and manual phase; pause affects only future slots',async t=>{
  const l=lab(t);l.agenda.close();
  const legacyThread=l.store.createThread(l.bot.id);
  const old=new DatabaseSync(join(l.dir,'agenda.sqlite'));old.exec('PRAGMA foreign_keys=OFF;DROP TABLE occurrences;DROP TABLE receipts;DROP TABLE schedules;DROP TABLE meta;');
  old.exec(readFileSync(resolve('tests/fixtures/agenda-v2.sql'),'utf8'));
  old.prepare('INSERT INTO meta VALUES(?,?)').run('schema_version','2');old.prepare('INSERT INTO meta VALUES(?,?)').run('owner_id',l.store.ownerId);old.prepare('INSERT INTO meta VALUES(?,?)').run('installation_id',l.store.hostId);
  old.prepare("INSERT INTO schedules(id,owner_id,installation_id,bot_id,thread_id,kind,at,interval_ms,next_at,content,state,revision,created_at,updated_at) VALUES(?,?,?,?,?,'interval',NULL,60000,?,'old intent','active',4,?,?)").run('ag_legacy',l.store.ownerId,l.store.hostId,l.bot.id,legacyThread.id,l.clock.now,l.clock.now,l.clock.now);
  old.exec('PRAGMA user_version=2;');old.close();chmodSync(join(l.dir,'agenda.sqlite'),0o600);l.reopen();
  assert.equal(l.agenda.get('ag_legacy').revision,4);assert.equal(l.agenda.get('ag_legacy').title,'Automação');
  const inspect=new DatabaseSync(join(l.dir,'agenda.sqlite'),{readOnly:true});assert.equal(agendaSchemaLabel(inspect),'agenda-v3');assert.equal(checkFullSchema(inspect,'agenda').installationId,l.store.hostId);inspect.close();
  const create={...l.bind(),clientRequestId:'owner-create',expectedRevision:0,title:'Daily synthetic',content:'Synthetic text only',when:{kind:'interval' as const,everyMs:60000,firstAt:l.clock.now+60000}};
  const receipt=l.agenda.createAutomation(create),id=receipt.scheduleId;
  assert.equal(l.agenda.createAutomation(create).replayed,true);
  assert.throws(()=>l.agenda.createAutomation({...create,title:'changed under same id'}),conflict);
  assert.throws(()=>l.agenda.stateAutomation(id,{hostId:l.store.hostId,clientRequestId:'stale',expectedRevision:2,state:'disabled'}),conflict);
  const next=receipt.schedule.nextAt;
  const run=l.agenda.runAutomation(id,{hostId:l.store.hostId,clientRequestId:'run-once',expectedRevision:1});assert.equal(run.occurrence?.source,'manual');assert.equal(run.schedule.nextAt,next);
  assert.throws(()=>l.agenda.runAutomation(id,{hostId:l.store.hostId,clientRequestId:'overlap',expectedRevision:1}),conflict);
  l.reopen();assert.equal(l.agenda.runAutomation(id,{hostId:l.store.hostId,clientRequestId:'run-once',expectedRevision:1}).replayed,true);
  const result=l.agenda.tick(l.runtime);assert.equal(result.accepted,2);
  await Promise.all(l.store.listTurns(l.thread.id).map(turn=>l.runtime.waitForTurn(turn.id)));
  const paused=l.agenda.stateAutomation(id,{hostId:l.store.hostId,clientRequestId:'pause',expectedRevision:1,state:'disabled'});assert.equal(paused.schedule.nextAt,next);
  l.clock.now+=180000;assert.equal(l.agenda.tick(l.runtime).prepared,1); // Only untouched legacy interval remains due.
  const resumed=l.agenda.stateAutomation(id,{hostId:l.store.hostId,clientRequestId:'resume',expectedRevision:2,state:'active'});assert.equal(resumed.schedule.nextAt,next);
  assert.equal(l.agenda.createAutomation(create).replayed,true); // Replay remains valid after the original start time.
  const history=l.agenda.historyAutomations({hostId:l.store.hostId,scheduleId:id});assert.equal(history.items[0]?.turnState,'failed');assert.equal(history.items[0]?.state,'accepted');assert.equal(history.items[0]?.threadId,l.thread.id);
});
test('canonical cron timezone/DST, projection bound and overdue coalescing use one recurrence',t=>{
  const l=lab(t),when=validateAutomationWhen({kind:'cron',expression:'0 9 * * *',timeZone:'America/New_York'});
  const before=Date.parse('2026-10-31T13:00:00Z');assert.equal(nextAutomationAt(when,before),Date.parse('2026-11-01T14:00:00Z'));
  assert.throws(()=>validateAutomationWhen({kind:'cron',expression:'0 0 9 * * *',timeZone:'America/New_York'}),HostError);
  assert.throws(()=>validateAutomationWhen({kind:'cron',expression:'* * * * *',timeZone:'Not/AZone'}),HostError);
  const schedule=l.agenda.createAutomation({...l.bind(),clientRequestId:'cron-create',expectedRevision:0,title:'Morning',content:'Synthetic',when}).schedule;
  const preview=l.agenda.previewAutomation({hostId:l.store.hostId,when,after:l.clock.now,count:3});
  const calendar=l.agenda.calendarAutomations({hostId:l.store.hostId,botId:l.bot.id,from:l.clock.now,to:l.clock.now+3*86400000,limit:3});assert.deepEqual(calendar.items.map(item=>item.scheduledAt),preview.dates);
  l.clock.now+=5*86400000;assert.equal(l.agenda.prepareDue().prepared,1);const occurrence=l.agenda.listOccurrences({scheduleId:schedule.id}).items[0]!;
  assert.ok(occurrence.scheduledAt<=l.clock.now);assert.ok(l.clock.now-occurrence.scheduledAt<86400000);assert.equal(l.agenda.get(schedule.id).nextAt,nextAutomationAt(when,l.clock.now));assert.equal(l.agenda.prepareDue().prepared,0);
  assert.throws(()=>l.agenda.calendarAutomations({hostId:l.store.hostId,from:0,to:43*86400000}),Error);
  assert.throws(()=>l.agenda.previewAutomation({hostId:'foreign',when}),conflict);
});
test('owned scheduler starts explicitly, serializes ticks, stops and holds unknown thread effects',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'dx-auto-consumer-')),store=new HostStore({dataDir:dir}),bot=store.createBot({name:'Timer fixture',profileId:'fixture',engine:'claude'}),thread=store.createThread(bot.id),runtime=new ConversationRuntime({store,drivers:[]}),consumer=new AgendaHostConsumer({store,runtime});
  t.after(async()=>{await consumer.close();await runtime.shutdown({graceMs:1000});rmSync(dir,{recursive:true,force:true});});
  const schedule=consumer.admin.create({botId:bot.id,threadId:thread.id,content:'Only synthetic timer input',when:{kind:'interval',everyMs:60000,firstAt:store.now()}});
  await new Promise(r=>setTimeout(r,20));assert.equal(store.listTurns(thread.id).length,0);assert.equal(consumer.status().running,false);
  consumer.start(10);await new Promise<void>((resolve,reject)=>{const end=Date.now()+1000;const poll=()=>{if(store.listTurns(thread.id).length){resolve();return;}if(Date.now()>end){reject(Error('timer acceptance timed out'));return;}setTimeout(poll,10);};poll();});
  const turn=store.listTurns(thread.id)[0]!;await runtime.waitForTurn(turn.id);assert.equal(store.listTurns(thread.id).length,1);
  store.setGrant({botId:bot.id,tool:'synthetic-write',destination:'fixture',policy:'ask'});
  const action=store.requestAction({botId:bot.id,threadId:thread.id,tool:'synthetic-write',destination:'fixture',idempotencyKey:'unknown-effect',arguments:{text:'synthetic'}});
  store.decideAction(action.id,{decision:'allow',requestHash:action.requestHash});store.claimAction(action.id);store.markUnknown(action.id,'host_interrupted');assert.equal(store.hasUnsettledThreadActions(thread.id),true);
  assert.throws(()=>consumer.admin.runAutomation(schedule.id,{hostId:store.hostId,clientRequestId:'unknown-hold',expectedRevision:1}),conflict);
  consumer.stopAdmission();assert.equal(consumer.status().running,false);await consumer.close();assert.equal(store.getAction(action.id).state,'unknown');
});
test('owner-local HTTP enforces host/CAS payload and exposes acceptance versus actual history',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'dx-auto-http-')),store=new HostStore({dataDir:dir}),bot=store.createBot({name:'HTTP fixture',profileId:'fixture',engine:'claude'}),thread=store.createThread(bot.id),runtime=new ConversationRuntime({store,drivers:[]}),consumer=new AgendaHostConsumer({store,runtime});
  t.after(async()=>{await consumer.close();await runtime.shutdown({graceMs:1000});rmSync(dir,{recursive:true,force:true});});
  const app=createHostApp(store,{runtime,automations:createAutomationHttpPort(store,consumer)}),post=(path:string,body:unknown)=>app.request(`http://127.0.0.1${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post('/v1/automations/list',{hostId:'foreign'})).status,409);assert.equal((await post('/v1/automations/list',{hostId:store.hostId,unknown:true})).status,400);
  assert.equal((await app.request('http://example.com/v1/automations/status')).status,403);
  const create=await post('/v1/automations/create',{hostId:store.hostId,clientRequestId:'http-create',expectedRevision:0,botId:bot.id,threadId:thread.id,title:'HTTP synthetic',content:'Synthetic',when:{kind:'once',at:store.now()+60000}});assert.equal(create.status,200);const receipt=await create.json() as {scheduleId:string;revision:number};
  const run=await post(`/v1/automations/${receipt.scheduleId}/run`,{hostId:store.hostId,clientRequestId:'http-run',expectedRevision:receipt.revision});assert.equal(run.status,200);
  await consumer.tick();const history=await post('/v1/automations/history',{hostId:store.hostId,scheduleId:receipt.scheduleId});assert.equal(history.status,200);assert.equal((await history.json() as {items:Array<{state:string}>}).items[0]?.state,'accepted');
});
