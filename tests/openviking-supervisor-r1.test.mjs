import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdtemp,mkdir,rm,chmod} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {OpenVikingSupervisor,verifyOpenVikingAdmittedCommand,OPENVIKING_SUPERVISOR_UPSTREAM_PIN as pin} from '../packages/cli/dist/openviking-supervisor.js';
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const wait=async check=>{const until=Date.now()+3000;while(!check()){if(Date.now()>until)throw new Error('Bounded synthetic condition timeout');await sleep(5);}};
const sha=data=>createHash('sha256').update(data).digest('hex');
const nodeSha=sha(await readFile(process.execPath));
const allReady=input=>({generation:input.generation,httpAuthenticated:true,identityMatched:true,configuration:'admitted',accountUsersVerified:true,aclVerified:true,embeddingUsable:true,contentReadWriteConfirmed:true,indexCurrent:true,ownedGenerationVerified:true});
const timings={probeIntervalMs:5,probeTimeoutMs:100,admissionTimeoutMs:1000,restartBaseMs:10,restartMaxMs:30,restartJitterFraction:0.2,maxRestarts:2,failedProbeRestartThreshold:2,shutdownDeadlineMs:150};
async function fixture(body="setInterval(()=>{},1000)"){
 const dir=await mkdtemp(join(tmpdir(),'dexter-ov-supervisor-fixture-'));await chmod(dir,0o700);
 const config=join(dir,'config'),temp=join(dir,'tmp'),script=join(dir,'owned-child.mjs');await mkdir(config,{mode:0o700});await mkdir(temp,{mode:0o700});await writeFile(script,body,{mode:0o600});
 const server=createServer();await new Promise(done=>server.listen({host:'127.0.0.1',port:0},done));const port=server.address().port;await new Promise(done=>server.close(done));
 const command={admission:'host_admitted_loopback_api_key',upstreamPin:pin,expectedVersion:'synthetic-runtime-r1',attestedVersion:'synthetic-runtime-r1',executable:process.execPath,executableSha256:nodeSha,args:[script],publicInputPins:[{path:script,sha256:sha(await readFile(script))}],environment:{HOME:dir,XDG_CONFIG_HOME:config,TMPDIR:temp},dataDir:dir,configDir:config};
 return{dir,script,command,configuration:{mode:'owned',origin:`http://127.0.0.1:${port}`,command},cleanup:()=>rm(dir,{recursive:true,force:true})};
}
function syntheticHandle({exitDelay=null,ignoreSignals=false}={}){
 let alive=true,done;const signals=[];const exited=new Promise(resolve=>done=resolve),exit=()=>{if(alive){alive=false;done();}};
 if(exitDelay!==null)setTimeout(exit,exitDelay);
 return{pid:4242,exited,alive:()=>alive,signal:s=>{signals.push(s);if(!ignoreSignals)exit();},signals,exit};
}

test('unconfigured, missing/corrupt runtime, version mismatch and unsafe private directory never spawn',async()=>{
 const f=await fixture();try{
  let spawns=0,probes=0;const ports={probe:async i=>{probes++;return allReady(i);},spawn:()=>{spawns++;return syntheticHandle();}};
  const unconfigured=new OpenVikingSupervisor({mode:'unconfigured'},ports,timings);assert.equal((await unconfigured.start()).state,'blocked_configuration');await unconfigured.stop();
  for(const patch of [{executable:join(f.dir,'missing')},{executableSha256:'0'.repeat(64)},{attestedVersion:'different'},{environment:{HOME:f.dir,XDG_CONFIG_HOME:f.command.configDir,TMPDIR:'/tmp'}}]){
   const supervisor=new OpenVikingSupervisor({...f.configuration,command:{...f.command,...patch}},ports,timings);const state=await supervisor.start();assert.equal(state.state,'blocked_configuration');assert.equal(state.reason,'runtime_not_admitted');await supervisor.stop();
  }
  assert.equal(spawns,0);assert.equal(probes,0);
 }finally{await f.cleanup();}
});

test('real own synthetic child: authenticated HTTP alone stays degraded; explicit independent facts can become ready',async()=>{
 const f=await fixture("console.log('synthetic-memory-never-captured'); console.error('synthetic-key-never-captured'); setInterval(()=>{},1000)");let supervisor;
 try{
  let full=false;const snapshots=[];supervisor=new OpenVikingSupervisor(f.configuration,{probe:async i=>({...allReady(i),embeddingUsable:full,contentReadWriteConfirmed:full,indexCurrent:full,ownedGenerationVerified:full}),onSnapshot:s=>snapshots.push(s)},timings);
  const first=await supervisor.start();assert.equal(first.state,'degraded');assert.equal(first.process.owned,true);assert.ok(first.process.pid>0);assert.equal(first.readiness.httpAuthenticated,true);assert.equal(first.readiness.embeddingUsable,false);
  full=true;await wait(()=>supervisor.snapshot().state==='ready');const stop=await supervisor.stop();assert.equal(stop.complete,true);assert.equal(stop.snapshot.state,'stopped');assert.equal(stop.snapshot.process.alive,false);
  const json=JSON.stringify(snapshots);assert.ok(!json.includes('synthetic-memory-never-captured'));assert.ok(!json.includes('synthetic-key-never-captured'));assert.ok(!json.includes(f.dir));assert.ok(!json.includes('environment'));
 }finally{await supervisor?.stop();await f.cleanup();}
});

test('own real child exit restarts are bounded with backoff/jitter and circuit stays open',async()=>{
 const f=await fixture('setTimeout(()=>process.exit(7),15)');let supervisor;
 try{
  const recovery=[];supervisor=new OpenVikingSupervisor(f.configuration,{probe:async i=>allReady(i),random:()=>1,onSnapshot:s=>{if(s.state==='recovering')recovery.push(s.nextRestartDelayMs);}},timings);
  await supervisor.start();await wait(()=>supervisor.snapshot().circuitOpen);const status=supervisor.snapshot();assert.equal(status.reason,'restart_budget_exhausted');assert.equal(status.generation,3);assert.equal(status.restarts,2);assert.deepEqual(recovery,[12,24]);assert.equal(status.process.alive,false);
  await supervisor.start();assert.equal(supervisor.snapshot().generation,3);const stopped=await supervisor.stop();assert.equal(stopped.complete,true);await supervisor.start();assert.equal(supervisor.snapshot().generation,3);
 }finally{await supervisor?.stop();await f.cleanup();}
});

test('stop during admitted-runtime await invalidates the late result and cannot spawn',async()=>{
 const f=await fixture();let release,spawns=0;const admission=new Promise(done=>release=done);const supervisor=new OpenVikingSupervisor(f.configuration,{probe:async i=>allReady(i),verifyRuntime:async()=>admission,spawn:()=>{spawns++;return syntheticHandle();}},timings);
 try{const pending=supervisor.start();await sleep(5);const stop=await supervisor.stop();assert.equal(stop.complete,true);release(true);await pending;await sleep(15);assert.equal(spawns,0);assert.equal(supervisor.snapshot().state,'stopped');}finally{await supervisor.stop();await f.cleanup();}
});

test('stop during backoff cancels the next spawn and late probe cannot resurrect readiness',async()=>{
 const f=await fixture();let spawns=0,release,entered=false;const stale=new Promise(done=>release=done),handle=syntheticHandle();
 const supervisor=new OpenVikingSupervisor(f.configuration,{probe:async i=>{entered=true;return stale.then(()=>allReady(i));},spawn:()=>{spawns++;return handle;}},timings);
 try{const start=supervisor.start();await wait(()=>entered);await supervisor.stop();release();await start;await sleep(30);assert.equal(spawns,1);assert.equal(supervisor.snapshot().state,'stopped');assert.equal(supervisor.snapshot().readiness.httpAuthenticated,false);assert.deepEqual(handle.signals,['SIGTERM']);}finally{await supervisor.stop();await f.cleanup();}
 const again=await fixture();let count=0;const delayed=new OpenVikingSupervisor(again.configuration,{probe:async i=>allReady(i),spawn:()=>{count++;return syntheticHandle({exitDelay:1});}}, {...timings,restartBaseMs:300,restartMaxMs:300});
 try{await delayed.start();await wait(()=>delayed.snapshot().state==='recovering');await delayed.stop();await sleep(350);assert.equal(count,1);assert.equal(delayed.snapshot().state,'stopped');}finally{await delayed.stop();await again.cleanup();}
});

test('probe timeout is bounded even when the readiness port ignores abort; healthy process is restarted only to the budget',async()=>{
 const f=await fixture();let spawns=0;const handles=[];const supervisor=new OpenVikingSupervisor(f.configuration,{probe:()=>new Promise(()=>{}),spawn:()=>{spawns++;const h=syntheticHandle();handles.push(h);return h;}},{...timings,probeTimeoutMs:10,probeIntervalMs:1,failedProbeRestartThreshold:1,maxRestarts:1});
 try{assert.equal((await supervisor.start()).state,'degraded');await wait(()=>supervisor.snapshot().circuitOpen);assert.equal(spawns,2);assert.ok(handles.every(h=>!h.alive()));await supervisor.stop();}finally{await supervisor.stop();await f.cleanup();}
});

test('occupied origin and caller-owned external service never spawn or signal someone else',async()=>{
 const f=await fixture();const url=new URL(f.configuration.origin),foreign=createServer();await new Promise(done=>foreign.listen({host:'127.0.0.1',port:Number(url.port)},done));let spawns=0;
 try{
  const owned=new OpenVikingSupervisor(f.configuration,{probe:async i=>allReady(i),spawn:()=>{spawns++;return syntheticHandle();}},timings);const blocked=await owned.start();assert.equal(blocked.reason,'origin_occupied');await owned.stop();assert.equal(foreign.listening,true);
  const external=new OpenVikingSupervisor({mode:'external',origin:f.configuration.origin},{probe:async i=>({...allReady(i),ownedGenerationVerified:false}),spawn:()=>{spawns++;throw new Error('External service is not owned');},originAvailable:async()=>{throw new Error('External port must not be rebound');}},timings);
  assert.equal((await external.start()).state,'ready');assert.equal(external.snapshot().process.alive,null);assert.equal(external.snapshot().process.owned,false);assert.equal((await external.stop()).complete,true);assert.equal(foreign.listening,true);assert.equal(spawns,0);
 }finally{await new Promise(done=>foreign.close(done));await f.cleanup();}
});

test('drain and own shutdown have one deadline; unkillable handle is retained and no stopped/restart is fabricated',async()=>{
 const f=await fixture();const handle=syntheticHandle({ignoreSignals:true});let drainSignal,spawns=0;const supervisor=new OpenVikingSupervisor(f.configuration,{probe:async i=>allReady(i),spawn:()=>{spawns++;return handle;},drain:async i=>{drainSignal=i.signal;await new Promise(()=>{});}},{...timings,shutdownDeadlineMs:60});
 try{await supervisor.start();const began=Date.now();const a=supervisor.stop(),b=supervisor.stop();assert.equal(a,b);const stop=await a;assert.ok(Date.now()-began<250);assert.equal(stop.complete,false);assert.equal(stop.snapshot.state,'degraded');assert.equal(stop.snapshot.reason,'shutdown_deadline');assert.equal(stop.snapshot.process.owned,true);assert.equal(stop.snapshot.process.alive,true);assert.equal(drainSignal.aborted,true);assert.deepEqual(handle.signals,['SIGTERM','SIGKILL']);await supervisor.start({resetCircuit:true});assert.equal(spawns,1);handle.exit();const settled=await supervisor.stop();assert.equal(settled.snapshot.state,'stopped');}finally{handle.exit();await supervisor.stop();await f.cleanup();}
});

test('real synthetic child ignoring TERM receives only its own handle KILL; host config remains immutable and exact argv survives',async()=>{
 const f=await fixture("import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); writeFileSync(process.env.HOME+'/argv.json',JSON.stringify({args:process.argv.slice(2),extra:process.env.EXTRA??null}));setInterval(()=>{},1000)");let supervisor;
 try{
  const argv=[f.script,'literal space','$(never executed)','`never executed`'];f.command.args=argv;
  supervisor=new OpenVikingSupervisor(f.configuration,{probe:async i=>allReady(i)},{...timings,shutdownDeadlineMs:150});argv.push('late mutation');f.command.environment.EXTRA='late mutation';
  await supervisor.start();await sleep(80);const observed=JSON.parse(await readFile(join(f.dir,'argv.json'),'utf8'));assert.deepEqual(observed,{args:['literal space','$(never executed)','`never executed`'],extra:null});const stop=await supervisor.stop();assert.equal(stop.complete,true);assert.equal(stop.snapshot.process.alive,false);
  assert.equal(await verifyOpenVikingAdmittedCommand({...f.command,attestedVersion:'wrong'},new AbortController().signal),false);
 }finally{await supervisor?.stop();await f.cleanup();}
});

test('wrong generation and blocked config cannot declare ready, and configuration block stops only own handle',async()=>{
 const f=await fixture();const h=syntheticHandle();let block=false;const supervisor=new OpenVikingSupervisor(f.configuration,{spawn:()=>h,probe:async i=>({...allReady(i),generation:block?i.generation:i.generation+1,configuration:block?'blocked':'admitted'})},{...timings,failedProbeRestartThreshold:100});
 try{assert.equal((await supervisor.start()).state,'degraded');block=true;await wait(()=>supervisor.snapshot().state==='blocked_configuration');assert.equal(h.alive(),false);assert.deepEqual(h.signals,['SIGTERM']);assert.equal(supervisor.snapshot().state,'blocked_configuration');await supervisor.stop();}finally{await supervisor.stop();await f.cleanup();}
});
