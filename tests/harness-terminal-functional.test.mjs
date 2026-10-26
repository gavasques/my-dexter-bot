import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {existsSync,linkSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const packageRoot=process.env.DEXTER_PACKAGED_HOST_DIR;
if(packageRoot!==undefined&&!isAbsolute(packageRoot))throw new Error('DEXTER_PACKAGED_HOST_DIR must be absolute.');
const load=relative=>import(pathToFileURL(join(packageRoot??resolve('.'),packageRoot===undefined?relative:
 relative.replace(/^packages\/([^/]+)\//,'node_modules/@dexter/$1/'))).href);
const [{HostServices},{HarnessOperationSurface,HARNESS_OPERATION_DESTINATION},{BotWorkspaceTools},{createHostApp}]=await Promise.all([
 load('packages/cli/dist/host-services.js'),load('packages/cli/dist/harness-operation-surface.js'),
 load('packages/cli/dist/bot-workspace-tools.js'),load('packages/hub/dist/http.js'),
]);
const refused=error=>['invalid_input','forbidden','not_found','conflict','unauthorized','unavailable'].includes(error?.code);
const hash=text=>createHash('sha256').update(text,'utf8').digest('hex');
async function until(predicate){
 const deadline=Date.now()+5000;
 while(!predicate()){if(Date.now()>=deadline)throw new Error('Synthetic owned process did not reach its bounded marker.');await new Promise(done=>setTimeout(done,10));}
}
const groupGone=pid=>{try{process.kill(-pid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}};

// One local delivery flow: synthetic bot identity, real file/shell executors and real owner decision HTTP.
// No native model, personal files, external account, credential, CUA, provider or deployment is touched.
test('own workspace files and approved terminal runtimes preserve CAS/replay, OS-boundary honesty and owned process drain', {timeout:30_000},async(t)=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-harness-terminal-'))),dataDir=join(root,'host');
 let services,surface,closable,closingSurface;const turns=[],executedRuntimes=[],priorSentinel=process.env.DEXTER_TERMINAL_PRIVATE_SENTINEL;
 process.env.DEXTER_TERMINAL_PRIVATE_SENTINEL='synthetic-parent-environment-value';
 const makeDriver=engine=>({id:engine,capabilities:{resume:true,interrupt:true,fork:false,steer:false},status:async()=>({engine,installed:true}),
  open:async threadId=>({threadId,nativeCursor:'synthetic-terminal-only'}),async *turn(session,turnId){
   yield{type:'turn.completed',threadId:session.threadId,turnId,usage:{}};
  },respondToTool:async()=>{},interrupt:async()=>{},close:async()=>{}});
 try{
  services=new HostServices({dataDir,enableEngines:true,enableMcp:true,enableWorkspaceTools:true,
   engineCommands:{codex:'/usr/bin/false'},makeDriver,engineCatalog:()=>[]});
  const app=createHostApp(services.store,{runtime:services.runtime});
  const actor=services.store.createBot({name:'Terminal synthetic',profileId:'synthetic',engine:'codex'});
  const other=services.store.createBot({name:'Separate workspace synthetic',profileId:'synthetic',engine:'codex'});
  surface=new HarnessOperationSurface({store:services.store,base:services.gateway,catalog:services.engineCatalog,
   runtime:()=>services.runtime,skills:()=>services.skillsHttp,effectiveSkills:()=>[],workspace:()=>services.botWorkspaceTools});
  const thread=services.store.createThread(actor.id),{turn}=services.store.createTurn(thread.id,
   {clientRequestId:'terminal-manual',content:'Synthetic workspace request'});
  assert.equal(services.store.claimNextTurn(thread.id).id,turn.id);turns.push(turn);
  const token=surface.issueCapability({turnId:turn.id}).token;
  const call=(name,callId,args={},options)=>surface.call(token,{connectionId:HARNESS_OPERATION_DESTINATION,
   tool:`dexter.harness.${name}`,callId,arguments:args},options);
  const decide=async(receipt,decision='allow',requestHash=receipt.requestHash)=>{
   const response=await app.request(`http://127.0.0.1/v1/actions/${receipt.actionId}/decisions`,{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({decision,requestHash})});return response.status;
  };
  const approved=async(name,callId,args)=>{
   const pending=await call(name,callId,args);assert.equal(pending.status,'awaiting_approval');
   assert.equal(await decide(pending),200);return call(name,callId,args);
  };
  const actorRoot=join(dataDir,'bot-files',actor.id),otherRoot=join(dataDir,'bot-files',other.id);

  const status=(await call('terminal.status','status')).result;
  assert.equal(status.executionBoundary,'owner_os_permissions');assert.equal(status.cwdIsNotSandbox,true);
  assert.equal(status.fileToolsScope,'own_bot_workspace');assert.equal(status.workspace.exists,false);
  assert.deepEqual(status.runtimes.map(runtime=>runtime.id),['bash','zsh','sh','bun']);
  assert.ok(status.runtimes.every(runtime=>runtime.verifiedBy==='executable_metadata_only'));
  assert.ok(!JSON.stringify(status).includes(root));
  const initialPin=services.botWorkspaceTools.pin(actor.id);assert.equal(initialPin,services.botWorkspaceTools.pin(actor.id));
  assert.deepEqual((await call('files.list','empty-list')).result.entries,[]);
  assert.deepEqual((await call('files.tree','empty-tree')).result.entries,[]);
  assert.equal(existsSync(actorRoot),false,'constructor, status, pin and reads do not create a workspace or start a shell');

  const createArgs={path:'reports/note.md',text:'\ufeffSynthetic report\nNeedle: primeira linha\nUnicode: café 🎯\n'};
  const denied=await call('files.write','denied-file',createArgs);assert.equal(denied.status,'awaiting_approval');
  assert.equal(await decide(denied,'allow','0'.repeat(64)),409);assert.equal(await decide(denied,'deny'),200);
  assert.equal((await call('files.write','denied-file',createArgs)).status,'denied');assert.equal(existsSync(actorRoot),false);
  const created=await approved('files.write','create-file',createArgs);assert.equal(created.status,'succeeded');
  assert.equal(created.result.created,true);assert.equal(created.result.sha256,hash(createArgs.text));
  assert.equal(readFileSync(join(actorRoot,createArgs.path),'utf8'),createArgs.text);
  const read=(await call('files.read','read-file',{path:createArgs.path})).result;
  assert.equal(read.text,createArgs.text);assert.equal(read.sha256,created.result.sha256);
  services.store.setGrant({botId:actor.id,tool:'dexter.harness.files.read',destination:HARNESS_OPERATION_DESTINATION,policy:'deny'});
  assert.ok(!surface.listTools(token).some(tool=>tool.name==='dexter.harness.files.read'));
  await assert.rejects(call('files.read','denied-read',{path:createArgs.path}),refused);
  services.store.setGrant({botId:actor.id,tool:'dexter.harness.files.read',destination:HARNESS_OPERATION_DESTINATION,policy:'ask'});
  assert.equal((await call('files.write','create-file',createArgs)).actionId,created.actionId);
  await assert.rejects(call('files.write','create-conflict',createArgs),refused);
  await assert.rejects(call('files.write','create-file',{...createArgs,text:'Changed replay'}),refused);
  const replaceArgs={path:createArgs.path,text:'Needle: approved replacement\n',expected_sha256:read.sha256};
  const replaced=await approved('files.write','replace-file',replaceArgs);assert.equal(replaced.status,'succeeded');assert.equal(replaced.result.created,false);
  const staleArgs={path:createArgs.path,text:'STALE_WRITE\n',expected_sha256:replaced.result.sha256};
  const stale=await call('files.write','stale-file',staleArgs);
  services.botWorkspaceTools.write(actor.id,{path:createArgs.path,text:'Needle: owner intervened\n',expected_sha256:replaced.result.sha256});
  assert.equal(await decide(stale),200);assert.equal((await call('files.write','stale-file',staleArgs)).status,'blocked');
  assert.equal(readFileSync(join(actorRoot,createArgs.path),'utf8'),'Needle: owner intervened\n');
  const cleared=await approved('files.write','clear-file',{path:createArgs.path,text:'',expected_sha256:hash('Needle: owner intervened\n')});
  assert.equal(cleared.status,'succeeded');assert.equal(readFileSync(join(actorRoot,createArgs.path),'utf8'),'');
  const restored=await approved('files.write','restore-file',{path:createArgs.path,text:'Needle: restored exact text\n',expected_sha256:hash('')});
  assert.equal(restored.status,'succeeded');
  services.botWorkspaceTools.write(other.id,{path:createArgs.path,text:'PEER_ONLY_SENTINEL\n'});
  assert.equal(readFileSync(join(otherRoot,createArgs.path),'utf8'),'PEER_ONLY_SENTINEL\n');
  await assert.rejects(call('files.read','spoof-read',{path:createArgs.path,botId:other.id}),refused);
  await assert.rejects(call('files.write','spoof-write',{path:'spoof.txt',text:'synthetic',botId:other.id}),refused);
  await assert.rejects(call('files.write','oversized-utf8',{path:'oversized.txt',text:'é'.repeat(32769)}),refused);
  for(const path of ['../outside.txt','reports/../../outside.txt',join(root,'outside.txt'),'reports/.env','reports/auth.json'])
   await assert.rejects(call('files.read',`bad-path-${hash(path).slice(0,8)}`,{path}),refused);
  symlinkSync(join(otherRoot,createArgs.path),join(actorRoot,'linked.txt'));
  linkSync(join(otherRoot,createArgs.path),join(actorRoot,'hardlinked.txt'));
  writeFileSync(join(actorRoot,'auth.json'),'SYNTHETIC_BLOCKED_NAME');
  for(const path of ['linked.txt','hardlinked.txt','auth.json']){
   await assert.rejects(call('files.read',`blocked-read-${path}`,{path}),refused);
   await assert.rejects(call('files.write',`blocked-write-${path}`,{path,text:'overwrite'}),refused);
  }
  const tree=(await call('files.tree','tree',{maxDepth:3})).result;
  assert.ok(tree.entries.some(entry=>entry.path==='reports/note.md'));assert.ok(tree.entries.some(entry=>entry.path==='linked.txt'&&entry.type==='blocked'));
  assert.ok(!tree.entries.some(entry=>entry.path==='auth.json'));
  const found=(await call('files.search','search',{query:'Needle'})).result;
  assert.equal(found.matches[0].path,'reports/note.md');assert.equal(found.matches[0].line,1);
  assert.equal((await call('files.search','no-peer',{query:'PEER_ONLY_SENTINEL'})).result.matches.length,0);
  unlinkSync(join(actorRoot,'hardlinked.txt'));

  const deniedRunArgs={runtime:'bash',command:"printf 'denied' > denied-shell.txt"};
  const deniedRun=await call('terminal.run','denied-shell',deniedRunArgs);assert.equal(deniedRun.status,'awaiting_approval');
  assert.equal(existsSync(join(actorRoot,'denied-shell.txt')),false);assert.equal(await decide(deniedRun,'deny'),200);
  assert.equal((await call('terminal.run','denied-shell',deniedRunArgs)).status,'denied');assert.equal(existsSync(join(actorRoot,'denied-shell.txt')),false);
  for(const runtime of ['bash','zsh','sh']){
   assert.equal(status.runtimes.find(item=>item.id===runtime).available,true,`Mac runtime ${runtime} is present`);
   const args={runtime,cwd:'reports',command:[`printf '${runtime}-ran\\n' >> ${runtime}.txt`, 'if [ -n "$(/bin/ls -A "$HOME")" ]; then exit 91; fi','/bin/pwd','/usr/bin/env',
    "printf 'SYNTHETIC_STDERR_ONLY' >&2"].join('\n')};
   const pending=await call('terminal.run',`run-${runtime}`,args);assert.equal(pending.status,'awaiting_approval');
   assert.equal(existsSync(join(actorRoot,'reports',`${runtime}.txt`)),false);assert.equal(await decide(pending),200);
   const result=await call('terminal.run',`run-${runtime}`,args);assert.equal(result.status,'succeeded');
   assert.equal(result.result.termination,'completed');assert.equal(result.result.exitCode,0);
   executedRuntimes.push(runtime);
   assert.equal(result.result.executionBoundary,'owner_os_permissions');assert.equal(result.result.cwdIsNotSandbox,true);
   assert.equal(result.result.cwd,'reports');assert.ok(result.result.stdout.includes(join(actorRoot,'reports')));
   assert.ok(!result.result.stdout.includes('DEXTER_TERMINAL_PRIVATE_SENTINEL'));
   assert.ok(!result.result.stdout.includes('synthetic-parent-environment-value'));
   assert.ok(!result.result.stdout.includes('SYNTHETIC_STDERR_ONLY'));assert.equal(result.result.stderrDiscarded,true);
   const home=result.result.stdout.split('\n').find(line=>line.startsWith('HOME=')).slice(5);
   assert.ok(home.startsWith(join(dataDir,'bot-terminal-private')+'/'));assert.equal(existsSync(home),false,'disposable HOME is removed after process close');
   assert.equal((await call('terminal.run',`run-${runtime}`,args)).actionId,result.actionId);
   assert.equal(readFileSync(join(actorRoot,'reports',`${runtime}.txt`),'utf8'),`${runtime}-ran\n`,'replay starts no second process');
  }
  if(status.runtimes.find(item=>item.id==='bun').available){
   const args={runtime:'bun',command:"const fs=require('node:fs');console.log(JSON.stringify({cwd:process.cwd(),sentinel:Boolean(process.env.DEXTER_TERMINAL_PRIVATE_SENTINEL),homeEntries:fs.readdirSync(process.env.HOME).length}));fs.writeFileSync('bun.txt','bun-ran\\n');console.error('SYNTHETIC_STDERR_ONLY');"};
   const bun=await approved('terminal.run','run-bun',args);assert.equal(bun.status,'succeeded');assert.equal(bun.result.exitCode,0);
   executedRuntimes.push('bun');
   assert.deepEqual(JSON.parse(bun.result.stdout),{cwd:actorRoot,sentinel:false,homeEntries:0});assert.equal(bun.result.stderrDiscarded,true);
   assert.equal((await call('terminal.run','run-bun',args)).actionId,bun.actionId);assert.equal(readFileSync(join(actorRoot,'bun.txt'),'utf8'),'bun-ran\n');
  }
  const limited=await approved('terminal.run','output-limit',{runtime:'bash',command:"for ((i=0;i<2000;i++)); do printf '012345678901234567890123456789\\n'; done"});
  assert.equal(limited.status,'succeeded');assert.equal(limited.result.termination,'completed');assert.equal(limited.result.stdoutTruncated,true);
  assert.ok(Buffer.byteLength(limited.result.stdout)<=16384);
  const timeout=await approved('terminal.run','deadline',{runtime:'sh',command:'/bin/sleep 2',timeout_ms:50});
  assert.equal(timeout.status,'unknown');assert.equal(timeout.result.termination,'timeout');assert.equal(timeout.result.commandOutcome,'interrupted');

  const cancelArgs={runtime:'bash',command:["trap '' TERM","printf '%s' \"$$\" > cancel-pid.txt","printf 'ready' > cancel-started.txt",
   '/bin/sleep 2',"printf 'escaped' > cancel-finished.txt"].join('\n')};
  const cancelPending=await call('terminal.run','cancel-owned',cancelArgs);assert.equal(await decide(cancelPending),200);
  const abort=new AbortController(),running=call('terminal.run','cancel-owned',cancelArgs,{signal:abort.signal});
  await until(()=>existsSync(join(actorRoot,'cancel-started.txt')));const pid=Number(readFileSync(join(actorRoot,'cancel-pid.txt'),'utf8'));
  services.runtime.cancelTurn(turn.id);abort.abort();const cancelled=await running;assert.equal(cancelled.status,'unknown','owner Stop interrupts the effect without claiming reversal');
  await until(()=>groupGone(pid));assert.equal(existsSync(join(actorRoot,'cancel-finished.txt')),false);
  assert.equal((await call('terminal.run','cancel-owned',cancelArgs)).actionId,cancelled.actionId);
  assert.equal(existsSync(join(actorRoot,'cancel-finished.txt')),false,'unknown replay never re-executes');

  // Exercise the owned executor's close/drain behind the same approved facade.
  closable=new BotWorkspaceTools({dataDir});
  closingSurface=new HarnessOperationSurface({store:services.store,base:services.gateway,catalog:services.engineCatalog,
   runtime:()=>services.runtime,skills:()=>services.skillsHttp,effectiveSkills:()=>[],workspace:()=>closable});
  const closeThread=services.store.createThread(actor.id),{turn:closeTurn}=services.store.createTurn(closeThread.id,
   {clientRequestId:'terminal-close',content:'Synthetic owned process close'});
  assert.equal(services.store.claimNextTurn(closeThread.id).id,closeTurn.id);turns.push(closeTurn);
  const closeToken=closingSurface.issueCapability({turnId:closeTurn.id}).token;
  const closeArgs={runtime:'sh',command:["printf '%s' \"$$\" > close-pid.txt","printf 'ready' > close-started.txt",'/bin/sleep 2'].join('\n')};
  const closeCall=()=>closingSurface.call(closeToken,{connectionId:HARNESS_OPERATION_DESTINATION,tool:'dexter.harness.terminal.run',callId:'close-owned',arguments:closeArgs});
  const closePending=await closeCall();assert.equal(closePending.status,'awaiting_approval');assert.equal(await decide(closePending),200);
  const closingRun=closeCall();
  await until(()=>existsSync(join(actorRoot,'close-started.txt')));const closePid=Number(readFileSync(join(actorRoot,'close-pid.txt'),'utf8'));
  await closable.close();const closed=await closingRun;assert.equal(closed.status,'unknown');assert.equal(closed.result.termination,'closed');await until(()=>groupGone(closePid));
  assert.throws(()=>closable.status(actor.id),refused);
  assert.equal(readFileSync(join(otherRoot,createArgs.path),'utf8'),'PEER_ONLY_SENTINEL\n');
  t.diagnostic(JSON.stringify({terminalRuntimesExecuted:executedRuntimes,executionBoundary:'owner_os_permissions',cwdIsNotSandbox:true}));
 }finally{
  if(priorSentinel===undefined)delete process.env.DEXTER_TERMINAL_PRIVATE_SENTINEL;else process.env.DEXTER_TERMINAL_PRIVATE_SENTINEL=priorSentinel;
  await closable?.close();await closingSurface?.close();await surface?.close();
  for(const turn of turns)if(services?.store.getTurn(turn.id).state==='running')services.store.finishTurn(turn.id,'completed',null);
  await services?.shutdown();rmSync(root,{recursive:true,force:true});
 }
});
