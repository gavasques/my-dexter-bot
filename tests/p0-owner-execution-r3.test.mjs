import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,appendFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSecretKey,createHash,randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {HostStore} from '../packages/hub/dist/index.js';
import {createHostApp} from '../packages/hub/dist/http.js';
import {Agenda} from '../packages/agenda/dist/index.js';
import {captureInspectionSnapshot,restoreForInspection} from '../packages/operations/dist/index.js';
import {checkHubExact} from '../packages/operations/dist/exact.js';
const repository=fileURLToPath(new URL('../',import.meta.url));
const evidence=(name,value)=>{if(process.env.DEXTER_R3_EVIDENCE_FILE)appendFileSync(process.env.DEXTER_R3_EVIDENCE_FILE,JSON.stringify({name,...value})+'\n');};
const tinyPng=()=>{const chunk=(type,data)=>{const body=Buffer.concat([Buffer.from(type),data]),head=Buffer.alloc(4),tail=Buffer.alloc(4);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let i=0;i<8;i++)crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;}head.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([head,body,tail]);};const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,17,21,34,255]))),chunk('IEND',Buffer.alloc(0))]);};
async function wait(read,predicate,timeout=8000){const end=Date.now()+timeout;for(;;){const value=await read();if(predicate(value))return value;if(Date.now()>end)throw Error('R3 bounded condition failed: '+JSON.stringify({turns:value.turns?.map(t=>({state:t.state,code:t.code})),actions:value.actions?.map(a=>({state:a.state,reason:a.reason,termination:a.result?.termination})),ownerCalls:value.ownerCalls}));await new Promise(r=>setTimeout(r,15));}}
async function boot(t,{deadline=5000,broken=false}={}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-r3-process-')));mkdirSync(join(root,'home'));mkdirSync(join(root,'tmp'));mkdirSync(join(root,'home','.bun','bin'),{recursive:true});
  // Metadata-detected executable, missing interpreter: real OS spawn failure with no child process.
  writeFileSync(join(root,'home','.bun','bin','bun'),'#!/synthetic-r3-missing/interpreter\n',{mode:0o700});
  const binary=join(root,'engine.mjs');writeFileSync(binary,'#!'+process.execPath+'\n'+readFileSync(join(repository,'tests/fixtures/p0-r3-engine.mjs'),'utf8'),{mode:0o700});
  const params={dataDir:join(root,'data'),engine:binary,wrapper:join(repository,'packages/cli/dist/mcp-stdio.js'),deadline,broken};
  let child,exited,url;
  const launch=async()=>{child=spawn(process.execPath,[join(repository,'tests/fixtures/p0-r3-host.mjs'),JSON.stringify(params)],{cwd:repository,env:{HOME:join(root,'home'),TMPDIR:join(root,'tmp'),PATH:'/usr/bin:/bin'},stdio:['ignore','ignore','ignore','ipc']});exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));const value=await Promise.race([new Promise(r=>child.once('message',r)),exited.then(()=>{throw Error('R3 own host exited before listening');})]);url='http://127.0.0.1:'+value.port;return value;};
  const stop=async()=>{if(child.exitCode!==null||child.signalCode!==null)return;child.send('shutdown');const stopped=await Promise.race([exited,new Promise(r=>setTimeout(()=>r(null),5000))]);if(!stopped){child.kill('SIGKILL');await exited;throw Error('R3 own host did not drain');}assert.equal(stopped.code,0);};
  t.after(async()=>{try{await stop();}finally{rmSync(root,{recursive:true,force:true});}});
  const ready=await launch();params.botId=ready.botId;params.threadId=ready.threadId;
  const request=async(path,body)=>{const response=await fetch(url+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const state=async()=> (await request('/lab/state')).body;
  return {root,...ready,request,state,async restart(){await stop();const next=await launch();assert.equal(next.hostId,ready.hostId);},async start(mode,attachmentIds){const value=await request('/v1/threads/'+ready.threadId+'/turns',{clientRequestId:'r3-input',content:JSON.stringify(mode),...(attachmentIds?{attachmentIds}:{})});assert.equal(value.status,201);const s=await wait(state,s=>{if(s.turns.some(t=>['failed','unknown'].includes(t.state)))throw Error('R3 fixture turn: '+JSON.stringify(s.turns.map(t=>({state:t.state,code:t.code}))));return s.actions.some(a=>a.state==='awaiting_approval');});return {turn:value.body,action:s.actions[0]};},
    async allow(action){return request('/v1/actions/'+action.id+'/decisions',{decision:'allow',requestHash:action.requestHash});},
    async continuation(){return wait(state,s=>s.turns.length===2&&s.turns[1].state==='completed');},
    file(name){const p=join(root,'data','bot-files',ready.botId,name);return existsSync(p)?readFileSync(p,'utf8'):null;}};
}
const slow={runtime:'sh',command:"printf 'begin\\n' >> effect.txt; sleep 1; printf 'done\\n' >> effect.txt; printf 'R3_DONE'",timeout_ms:3000};
test('R3 N1/N4 short MCP deadline expires after approval; real owned shell completes once and host answers once',{timeout:15000},async t=>{
  const f=await boot(t,{deadline:350}),png=tinyPng(),upload=await f.request('/v1/threads/'+f.threadId+'/attachments',{clientAttachmentId:randomUUID(),mediaType:'image/png',dataBase64:png.toString('base64')});assert.equal(upload.status,201);
  const {turn,action}=await f.start({operation:slow,consume:true},[upload.body.id]);
  assert.equal((await f.allow(action)).status,200);
  const s=await f.continuation(),progress=(await f.request('/v1/actions/'+action.id+'/continuation')).body.continuation;
  assert.equal(s.actions[0].state,'succeeded');assert.equal(f.file('effect.txt'),'begin\ndone\n');assert.equal(s.turns[0].outputMessageId,null);
  assert.equal(progress.deliveredToEngine,false);assert.equal(progress.consumedByEngine,false);assert.equal(progress.resultBodyAvailable,true);
  assert.equal(s.turns[1].inputMessageId,turn.inputMessageId);assert.deepEqual(s.turns[1].selection,turn.selection);
  assert.equal(s.messages.filter(m=>m.role==='user').length,1);assert.equal(s.messages.filter(m=>m.role==='assistant').length,1);
  const answer=JSON.parse(s.messages.find(m=>m.role==='assistant').content);assert.equal(answer.receipt.result.stdout,'R3_DONE');assert.equal(answer.model,'r3-model');
  assert.deepEqual(answer.imageHashes,[createHash('sha256').update(png).digest('hex')]);assert.deepEqual(answer.imageBlocks,['text','image']);
  assert.equal((await f.allow(action)).status,200);assert.equal(f.file('effect.txt'),'begin\ndone\n');
  evidence('short_bridge',{deadlineMs:350,effect:s.actions[0].state,file:f.file('effect.txt'),progress,turns:s.turns.length,humanMessages:1,assistantMessages:1,imageHashes:answer.imageHashes});
});
test('R3 N1 ordinary engine process exit does not cancel an approved shell',{timeout:15000},async t=>{
  const f=await boot(t),{action}=await f.start({operation:slow,exit:true,exitDelay:500});assert.equal((await f.allow(action)).status,200);
  const s=await f.continuation();assert.equal(s.turns[0].state,'failed');assert.equal(s.actions[0].state,'succeeded');assert.equal(f.file('effect.txt'),'begin\ndone\n');
  evidence('engine_exit',{origin:s.turns[0].state,action:s.actions[0].state,file:f.file('effect.txt'),turns:s.turns.length});
});
test('R3 N1/N5/N8 Stop still aborts host work after RPC/turn completion and preserves its partial bounded receipt',{timeout:15000},async t=>{
  const f=await boot(t,{deadline:250}),{turn,action}=await f.start({operation:slow,consume:true});await f.allow(action);
  await wait(f.state,s=>s.turns[0].state==='completed'&&s.actions[0].state==='running');
  assert.equal((await f.request('/v1/turns/'+turn.id+'/cancel',{})).status,200);
  const s=await wait(f.state,s=>s.actions[0].state==='unknown'),result=s.actions[0].result;
  assert.equal(result.termination,'cancelled');assert.equal(result.commandOutcome,'interrupted');assert.equal(result.signal,'SIGTERM');assert.equal(result.diagnostic.effectMayBePartial,true);
  assert.equal(f.file('effect.txt'),'begin\n');assert.equal((await f.allow(action)).status,409);
  assert.equal((await f.request('/v1/actions/'+action.id+'/decisions',{decision:'deny',requestHash:action.requestHash})).status,409);
  await new Promise(r=>setTimeout(r,150));assert.equal((await f.state()).turns.length,1);
  evidence('stop_after_rpc',{action:s.actions[0].state,result,file:f.file('effect.txt'),lateAllow:409,lateDeny:409,continuations:0});
});
test('R3 N4 socket delivery without a tool-result transcript falls back once; consumed evidence suppresses fallback',{timeout:15000},async t=>{
  for(const consume of [false,true]){
    const f=await boot(t),{action}=await f.start({operation:{runtime:'sh',command:"printf 'once' >> effect.txt; printf 'RESULT'"},consume});await f.allow(action);
    const s=await wait(f.state,s=>consume?s.turns[0].state==='completed':s.turns.length===2&&s.turns[1].state==='completed');
    const progress=(await f.request('/v1/actions/'+action.id+'/continuation')).body.continuation;
    assert.equal(progress.deliveredToEngine,true);assert.equal(progress.consumedByEngine,consume);assert.equal(s.turns.length,consume?1:2);
    assert.equal(s.messages.filter(m=>m.role==='assistant').length,1);assert.equal(f.file('effect.txt'),'once');
    evidence(consume?'transcript_consumed':'client_abandoned',{progress,turns:s.turns.length,assistantMessages:1,effects:f.file('effect.txt')});
  }
});
test('R3 N2 truncation drains stdout without killing subsequent effects or holding agenda',{timeout:15000},async t=>{
  const f=await boot(t),{action}=await f.start({operation:{runtime:'sh',command:"head -c 20000 /dev/zero | tr '\\0' a; printf 'done' > after-output.txt",timeout_ms:2000},consume:true});await f.allow(action);
  const s=await wait(f.state,s=>s.turns[0].state==='completed'),result=s.actions[0].result;
  assert.equal(s.actions[0].state,'succeeded');assert.equal(result.stdout.length,16384);assert.equal(result.stdoutTruncated,true);assert.equal(result.termination,'completed');assert.equal(result.diagnostic.code,'command_output_truncated');assert.equal(f.file('after-output.txt'),'done');assert.equal(s.unsettled,false);
  const schedule=(await f.request('/lab/agenda-create',{})).body.schedule;assert.equal((await f.request('/lab/agenda-run',{id:schedule.id})).status,200);
  evidence('stdout_truncation',{state:s.actions[0].state,length:result.stdout.length,truncated:true,afterEffect:f.file('after-output.txt'),agendaRun:200});
});
test('R3 N2 timeout reconciliation is exact human-only CAS, deduplicated and never a second effect',{timeout:15000},async t=>{
  const f=await boot(t),{action}=await f.start({operation:{runtime:'sh',command:"printf 'partial' >> effect.txt; sleep 2; printf 'late' >> effect.txt",timeout_ms:100},consume:true});await f.allow(action);
  const s=await wait(f.state,s=>s.turns[0].state==='completed');assert.equal(s.actions[0].state,'unknown');
  const schedule=(await f.request('/lab/agenda-create',{})).body.schedule;assert.equal((await f.request('/lab/agenda-run',{id:schedule.id})).status,409);
  const endpoint='/v1/actions/'+action.id+'/reconciliation',before=(await f.request(endpoint)).body;
  const body={hostId:f.hostId,clientRequestId:'r3-human-ack',expectedRevision:before.revision,requestHash:action.requestHash,decision:'release_hold',acknowledgement:'effect_may_have_occurred'};
  assert.equal((await f.request(endpoint,{...body,expectedRevision:body.expectedRevision-1})).status,409);
  assert.equal((await f.request(endpoint,{...body,hostId:'foreign-host'})).status,403);
  assert.equal((await f.request(endpoint,{...body,acknowledgement:'success'})).status,400);
  const receipt=await f.request(endpoint,body);assert.equal(receipt.status,200);assert.equal(receipt.body.state,'unknown');assert.equal(receipt.body.receipt.effectOutcome,'unknown');assert.equal(receipt.body.receipt.effectReexecuted,false);
  assert.deepEqual((await f.request(endpoint,body)).body,receipt.body);assert.equal((await f.request(endpoint,{...body,clientRequestId:'different-decision'})).status,409);
  await f.restart();assert.deepEqual((await f.request(endpoint,body)).body,receipt.body);
  assert.equal((await f.request('/lab/agenda-run',{id:schedule.id})).status,200);assert.equal(f.file('effect.txt'),'partial');
  assert.equal((await f.request('/v1/actions/'+action.id)).body.state,'unknown');
  evidence('human_reconciliation',{state:'unknown',receipt:receipt.body.receipt,replayEqual:true,stale:409,foreign:403,malformed:400,agendaBefore:409,agendaAfter:200,effect:f.file('effect.txt')});
});
test('R3 N6 real spawn_failed is a definite not-started receipt without an agenda hold',{timeout:15000},async t=>{
  const f=await boot(t),{action}=await f.start({operation:{runtime:'bun',command:'throw Error("never executed")',timeout_ms:1000},consume:true});await f.allow(action);
  const s=await wait(f.state,s=>s.turns[0].state==='completed'),result=s.actions[0].result;
  assert.equal(s.actions[0].state,'succeeded');assert.equal(result.termination,'spawn_failed');assert.equal(result.commandOutcome,'not_started');assert.equal(result.effectDispatched,false);assert.equal(result.diagnostic.effectMayBePartial,false);assert.equal(s.unsettled,false);
  evidence('spawn_failed',{state:s.actions[0].state,result,unsettled:s.unsettled});
});
test('R3 N7 unexpected owner port not_found becomes one bounded failure receipt without crash or effect',{timeout:15000},async t=>{
  const f=await boot(t,{broken:true}),{action}=await f.start({operation:{runtime:'sh',command:"printf 'must not execute' > effect.txt"},exit:true,exitDelay:100});
  await wait(f.state,s=>s.turns[0].state==='failed');assert.equal((await f.allow(action)).status,200);
  const s=await wait(f.state,s=>s.actions[0].state==='blocked'),progress=(await f.request('/v1/actions/'+action.id+'/continuation')).body.continuation;
  assert.equal(progress.recoveryFailure.code,'owner_continuation_not_found');assert.equal(s.actions[0].result.effectDispatched,false);assert(!JSON.stringify(progress).includes('synthetic private port message'));assert.equal(f.file('effect.txt'),null);
  await new Promise(r=>setTimeout(r,200));assert.equal((await f.state()).ownerCalls,1);
  evidence('recovery_failure',{state:s.actions[0].state,failure:progress.recoveryFailure,ownerCalls:1,effects:0});
  await f.restart();assert.equal((await f.state()).ownerCalls,0);assert.equal((await f.request('/v1/actions/'+action.id+'/continuation')).body.continuation.recoveryFailure.code,'owner_continuation_not_found');
});

test('R3 N1 detached real shell still stops on grant revocation or bot revision change',{timeout:15000},async t=>{
  for(const kind of ['grant','bot']){
    const f=await boot(t,{deadline:250}),{action}=await f.start({operation:slow,consume:true});await f.allow(action);
    await wait(f.state,s=>s.actions[0].state==='running'&&f.file('effect.txt')==='begin\n');
    assert.equal((await f.request('/lab/change-authority',{kind})).status,200);
    const s=await wait(f.state,s=>s.actions[0].state==='unknown');assert.equal(f.file('effect.txt'),'begin\n');assert.equal(s.actions[0].result.termination,'cancelled');
    evidence('authority_'+kind,{action:'unknown',termination:s.actions[0].result.termination,file:f.file('effect.txt')});
  }
});

test('R3 N5 Stop before approval closes exactly this proposal without a false user_denied reason',{timeout:15000},async t=>{
  const f=await boot(t),{turn,action}=await f.start({operation:slow,consume:true});assert.equal((await f.request('/v1/turns/'+turn.id+'/cancel',{})).status,200);
  const s=await wait(f.state,s=>s.actions[0].state==='denied');assert.equal(s.actions[0].reason,null);assert.equal(s.actions[0].result.code,'cancelled');assert.equal(s.actions[0].result.effectDispatched,false);assert.equal((await f.allow(action)).status,409);assert.equal(f.file('effect.txt'),null);
  evidence('stop_before_approval',{state:'denied',reason:null,code:'cancelled',effects:0,lateAllow:409});
});

test('R3 N2 human acknowledgement releases an uncertain accepted agenda occurrence; journal survives reopen and exact backup',{timeout:15000},async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-r3-uncertain-occurrence-')));let now=Date.now(),store=new HostStore({dataDir:join(root,'data'),clock:()=>now}),agenda=new Agenda(store,{clock:()=>now});
  t.after(()=>{agenda.close();store.close();rmSync(root,{recursive:true,force:true});});
  const bot=store.createBot({name:'R3 occurrence',profileId:'synthetic',engine:'claude'}),thread=store.createThread(bot.id);
  const schedule=agenda.createAutomation({hostId:store.hostId,clientRequestId:'r3-schedule',expectedRevision:0,botId:bot.id,threadId:thread.id,title:'R3 uncertain occurrence',content:'synthetic occurrence',when:{kind:'interval',everyMs:60000,firstAt:now+100}}).schedule;
  now+=100;const tick=agenda.tick({startTurn:(id,input)=>store.createTurn(id,input)});assert.equal(tick.accepted,1);
  const turn=store.listTurns(thread.id)[0];store.claimNextTurn(thread.id);store.finishTurn(turn.id,'unknown','host_interrupted');
  now+=60000;assert.equal(agenda.prepareDue().prepared,0);
  const before=store.uncertaintyStatus('turn',turn.id),input={hostId:store.hostId,clientRequestId:'r3-turn-ack',expectedRevision:before.revision,decision:'release_hold',acknowledgement:'effect_may_have_occurred'};
  const reconciled=store.reconcileUncertainty('turn',turn.id,input);assert.equal(reconciled.state,'unknown');assert.equal(reconciled.receipt.revision,reconciled.revision);assert.equal(reconciled.receipt.effectReexecuted,false);
  const old=agenda.listOccurrences({scheduleId:schedule.id}).items[0];assert.equal(old.state,'accepted');assert.equal(old.turnId,turn.id);
  const key={keyId:'synthetic-r3',use:operation=>operation(createSecretKey(Buffer.alloc(32,23)))},artifact=join(root,'receipt.dxg8');
  captureInspectionSnapshot({source:store,key,output:artifact,include:{context:false,agenda:false,deviceRegistry:false,deviceSurface:false}});restoreForInspection({artifact,key,destination:join(root,'inspection')});
  const copy=new DatabaseSync(join(root,'inspection','inspection','hub.inspect.sqlite'),{readOnly:true});try{checkHubExact(copy);const audit=copy.prepare("SELECT data FROM turn_events WHERE json_extract(data,'$.kind')='uncertainty_reconciliation'").get();assert.deepEqual(JSON.parse(audit.data),reconciled.receipt);}finally{copy.close();}
  agenda.close();store.close();store=new HostStore({dataDir:join(root,'data'),clock:()=>now});agenda=new Agenda(store,{clock:()=>now});assert.deepEqual(store.reconcileUncertainty('turn',turn.id,input),reconciled);
  assert.equal(agenda.prepareDue().prepared,1);assert.equal(store.getTurn(turn.id).state,'unknown');assert.equal(agenda.listOccurrences({scheduleId:schedule.id}).items.find(o=>o.turnId===turn.id).state,'accepted');assert.equal(store.listTurns(thread.id).length,1);
  evidence('unknown_occurrence',{acceptedHistory:'accepted',turnHistory:'unknown',newPrepared:1,newTurns:0,reopenEqual:true,backupJournalEqual:true,receipt:reconciled.receipt});
});

test('R3 N8 a claimed action reopened without completion keeps a bounded honest recovery body and never retries',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-r3-recovery-body-')));let store=new HostStore({dataDir:root});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const bot=store.createBot({name:'R3 recovery',profileId:'synthetic',engine:'claude'}),thread=store.createThread(bot.id),{turn}=store.createTurn(thread.id,{clientRequestId:'r3-recovery-input',content:'synthetic claim journal'});store.claimNextTurn(thread.id);
  store.setGrant({botId:bot.id,tool:'fixture.local',destination:'local',policy:'ask'});
  const action=store.requestAction({botId:bot.id,threadId:thread.id,tool:'fixture.local',destination:'local',arguments:{},idempotencyKey:'r3-interrupted-claim'});store.bindToolAction(action.id,turn.id,'r3-interrupted-call');store.decideAction(action.id,{decision:'allow',requestHash:action.requestHash});store.claimAction(action.id);store.close();store=new HostStore({dataDir:root});
  const current=store.getAction(action.id);assert.equal(current.state,'unknown');assert.equal(current.result.termination,'host_interrupted');assert.equal(current.result.stdoutAvailable,false);assert.equal(current.result.diagnostic.effectMayBePartial,true);assert.equal(store.toolActionProgress(action.id).resultBodyAvailable,true);assert.throws(()=>store.claimAction(action.id),e=>e.code==='conflict');
  const response=store.createActionResultTurn(action.id);assert.equal(store.createActionResultTurn(action.id).id,response.id);assert.match(store.turnInput(response.id),/host_interrupted/);assert.equal(store.listActions().length,1);
  evidence('recovery_body',{action:'unknown',body:current.result,resultAvailable:true,effectRetries:0,syntheticClaimOnly:true});
});

test('R3 N5 legacy ready owner decisions return 409 with a definite no-effect receipt on every retry',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-r3-legacy-ready-'))),store=new HostStore({dataDir:root});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const bot=store.createBot({name:'R3 legacy',profileId:'synthetic',engine:'claude'}),thread=store.createThread(bot.id);store.setGrant({botId:bot.id,tool:'dexter.harness.terminal.run',destination:'dexter-harness-owner-proposals',policy:'ask'});
  const action=store.requestAction({botId:bot.id,threadId:thread.id,tool:'dexter.harness.terminal.run',destination:'dexter-harness-owner-proposals',arguments:{input:{runtime:'sh',command:'synthetic legacy never dispatched'}},idempotencyKey:'r3-legacy-ready'});
  // Legacy preimage fixture: owner decided in an older host, but no durable tool origin was stored.
  const seed=new DatabaseSync(store.databasePath);try{seed.prepare("UPDATE actions SET state='ready',decided_by=? WHERE id=?").run(store.ownerId,action.id);}finally{seed.close();}
  const app=createHostApp(store),url='http://127.0.0.1/v1/actions/'+action.id+'/decisions',options={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:'allow',requestHash:action.requestHash})};
  assert.equal((await app.request(url,options)).status,409);assert.equal((await app.request(url,options)).status,409);const receipt=store.getAction(action.id);assert.equal(receipt.state,'blocked');assert.equal(receipt.reason,null);assert.equal(receipt.result.code,'legacy_origin_missing');assert.equal(receipt.result.effectDispatched,false);
  evidence('legacy_ready_http',{state:'blocked',reason:null,code:'legacy_origin_missing',first:409,retry:409,effects:0,inProcessHttp:true});
});
