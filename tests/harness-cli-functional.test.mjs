import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync,mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const packageRoot=process.env.DEXTER_PACKAGED_HOST_DIR;
if(packageRoot!==undefined&&!isAbsolute(packageRoot))throw new Error('DEXTER_PACKAGED_HOST_DIR must be absolute.');
const load=relative=>import(pathToFileURL(join(packageRoot??resolve('.'),packageRoot===undefined?relative:
 relative.replace(/^packages\/([^/]+)\//,'node_modules/@dexter/$1/'))).href);
const [{HostServices},{HarnessOperationSurface,HARNESS_OPERATION_DESTINATION},{createHostApp}]=await Promise.all([
 load('packages/cli/dist/host-services.js'),load('packages/cli/dist/harness-operation-surface.js'),load('packages/hub/dist/http.js'),
]);
const refused=error=>['invalid_input','forbidden','conflict','unauthorized','unavailable'].includes(error?.code);

// One new-tool delivery flow. Real Python uses only its synthetic workspace; gh runs --version only.
// No network, account/auth lookup, personal file, root escalation, install or native engine is invoked.
test('owner-approved literal gh/Python argv works without root elevation and preserves deny/replay and isolated credentials',{timeout:30_000},async(t)=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'dexter-harness-cli-'))),dataDir=join(root,'host');
 const priorSentinel=process.env.DEXTER_CLI_PRIVATE_SENTINEL,priorGhToken=process.env.GH_TOKEN;
 process.env.DEXTER_CLI_PRIVATE_SENTINEL='synthetic-private-parent-environment';
 process.env.GH_TOKEN='synthetic-parent-value-never-a-real-token';
 let services,surface,turn;
 const makeDriver=engine=>({id:engine,capabilities:{resume:true,interrupt:true,fork:false,steer:false},status:async()=>({engine,installed:true}),
  open:async threadId=>({threadId,nativeCursor:'synthetic-cli-only'}),async *turn(session,turnId){
   yield{type:'turn.completed',threadId:session.threadId,turnId,usage:{}};
  },respondToTool:async()=>{},interrupt:async()=>{},close:async()=>{}});
 try{
  services=new HostServices({dataDir,enableEngines:true,enableMcp:true,enableWorkspaceTools:true,
   engineCommands:{codex:'/usr/bin/false'},makeDriver,engineCatalog:()=>[]});
  const app=createHostApp(services.store,{runtime:services.runtime});
  const bot=services.store.createBot({name:'CLI synthetic',profileId:'synthetic',engine:'codex'});
  const thread=services.store.createThread(bot.id);({turn}=services.store.createTurn(thread.id,
   {clientRequestId:'cli-tools-manual',content:'Synthetic gh and Python request'}));
  assert.equal(services.store.claimNextTurn(thread.id).id,turn.id);
  surface=new HarnessOperationSurface({store:services.store,base:services.gateway,catalog:services.engineCatalog,
   runtime:()=>services.runtime,skills:()=>services.skillsHttp,effectiveSkills:()=>[],workspace:()=>services.botWorkspaceTools});
  const token=surface.issueCapability({turnId:turn.id}).token;
  const call=(name,callId,args={})=>surface.call(token,{connectionId:HARNESS_OPERATION_DESTINATION,
   tool:`dexter.harness.${name}`,callId,arguments:args});
  const decide=async(receipt,decision='allow',requestHash=receipt.requestHash)=>{
   const response=await app.request(`http://127.0.0.1/v1/actions/${receipt.actionId}/decisions`,{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({decision,requestHash})});return response.status;
  };
  const botRoot=join(dataDir,'bot-files',bot.id);
  const status=(await call('terminal.status','cli-status')).result;
  assert.deepEqual(status.commandTools.map(tool=>tool.id),['gh','python3']);
  assert.ok(status.commandTools.every(tool=>tool.available===true&&tool.verifiedBy==='executable_metadata_only'
   &&tool.requiresRoot===false&&tool.privilegePolicy==='host_user_no_elevation'&&tool.authentication==='not_checked'
   &&tool.homePolicy==='isolated'&&tool.inheritedCredentials===false));
  assert.equal(status.executionBoundary,'owner_os_permissions');assert.equal(status.cwdIsNotSandbox,true);
  assert.ok(!JSON.stringify(status).includes(root));assert.equal(existsSync(botRoot),false);
  assert.equal(services.botWorkspaceTools.pin(bot.id),services.botWorkspaceTools.pin(bot.id));
  assert.equal(existsSync(botRoot),false,'status and pin never spawn a process or create a workspace');

  const deniedArgs={tool:'python3',args:['-I','-c','from pathlib import Path; Path("denied.txt").write_text("denied")']};
  const denied=await call('cli.run','denied-python',deniedArgs);assert.equal(denied.status,'awaiting_approval');
  assert.equal(existsSync(botRoot),false);assert.equal(await decide(denied,'allow','0'.repeat(64)),409);
  assert.equal(await decide(denied,'deny'),200);assert.equal((await call('cli.run','denied-python',deniedArgs)).status,'denied');
  assert.equal(existsSync(botRoot),false);

  const literalArgs=['literal; touch injected.txt','$(touch injected.txt)','', 'line one\nline two'];
  const script=[
   'import json,os,pathlib,shutil,sys',
   'target=pathlib.Path("python.txt")',
   'target.write_text((target.read_text() if target.exists() else "")+"python-run\\n")',
   'print(json.dumps({"sum":sum(range(6)),"argv":sys.argv[1:],"uid":os.getuid(),"cwd":os.getcwd(),"home":os.environ["HOME"],"homeEntries":len(os.listdir(os.environ["HOME"])),"privateInherited":"DEXTER_CLI_PRIVATE_SENTINEL" in os.environ,"ghTokenInherited":"GH_TOKEN" in os.environ,"ghFound":bool(shutil.which("gh")),"pythonFound":bool(shutil.which("python3"))}))',
   'print("SYNTHETIC_STDERR_ONLY",file=sys.stderr)',
  ].join('\n');
  const pythonArgs={tool:'python3',args:['-I','-c',script,...literalArgs],timeout_ms:10000};
  const pending=await call('cli.run','python-literal',pythonArgs);assert.equal(pending.status,'awaiting_approval');
  assert.equal(existsSync(botRoot),false,'exact approval precedes Python');assert.equal(await decide(pending),200);
  const python=await call('cli.run','python-literal',pythonArgs);assert.equal(python.status,'succeeded');
  assert.equal(python.result.tool,'python3');assert.equal(python.result.argumentMode,'literal_argv');assert.equal(python.result.exitCode,0);
  assert.equal(python.result.termination,'completed');assert.equal(python.result.requiresRoot,false);
  assert.equal(python.result.privilegePolicy,'host_user_no_elevation');assert.equal(python.result.authentication,'not_checked');
  assert.equal(python.result.executionBoundary,'owner_os_permissions');assert.equal(python.result.cwdIsNotSandbox,true);
  assert.equal(python.result.stderrDiscarded,true);assert.ok(!python.result.stdout.includes('SYNTHETIC_STDERR_ONLY'));
  const observation=JSON.parse(python.result.stdout);
  assert.equal(observation.sum,15);assert.deepEqual(observation.argv,literalArgs);assert.equal(observation.cwd,botRoot);
  assert.equal(observation.uid,process.getuid(),'Python uses the existing host user, never an elevation wrapper');
  assert.equal(observation.homeEntries,0);assert.equal(observation.privateInherited,false);assert.equal(observation.ghTokenInherited,false);
  assert.equal(observation.ghFound,true);assert.equal(observation.pythonFound,true);
  assert.ok(observation.home.startsWith(join(dataDir,'bot-terminal-private')+'/'));assert.equal(existsSync(observation.home),false);
  assert.equal(existsSync(join(botRoot,'injected.txt')),false,'argument strings are never shell-parsed');
  assert.equal(readFileSync(join(botRoot,'python.txt'),'utf8'),'python-run\n');
  assert.equal((await call('cli.run','python-literal',pythonArgs)).actionId,python.actionId);
  assert.equal(readFileSync(join(botRoot,'python.txt'),'utf8'),'python-run\n','replay does not spawn Python again');
  await assert.rejects(call('cli.run','python-literal',{...pythonArgs,args:['--version']}),refused);

  const ghArgs={tool:'gh',args:['--version']};
  const ghPending=await call('cli.run','gh-version',ghArgs);assert.equal(ghPending.status,'awaiting_approval');
  assert.equal(await decide(ghPending),200);const gh=await call('cli.run','gh-version',ghArgs);assert.equal(gh.status,'succeeded');
  assert.equal(gh.result.exitCode,0);assert.match(gh.result.stdout,/^gh version /);assert.equal(gh.result.authentication,'not_checked');
  // Credential-named receipt fields retain the generic redaction; inspect the public execution policy instead.
  assert.equal(gh.result.homePolicy,'isolated');assert.equal(gh.result.privilegePolicy,'host_user_no_elevation');
  assert.equal(gh.result.requiresRoot,false);
  assert.equal((await call('cli.run','gh-version',ghArgs)).actionId,gh.actionId);
  for(const [suffix,args] of [
   ['tool',{tool:'sudo',args:['--version']}],['root',{...ghArgs,requiresRoot:true}],['spoof',{...ghArgs,botId:'peer'}],
   ['nul',{tool:'python3',args:['\0']}],['many',{tool:'gh',args:Array(65).fill('x')}],
   ['large',{tool:'gh',args:['x'.repeat(4097),'x'.repeat(4096)]}],
   ['secret',{tool:'gh',args:['api','--token','synthetic-secret-value']}],
  ])await assert.rejects(call('cli.run',`bad-cli-${suffix}`,args),refused);
  services.store.setGrant({botId:bot.id,tool:'dexter.harness.cli.run',destination:HARNESS_OPERATION_DESTINATION,policy:'deny'});
  assert.ok(!surface.listTools(token).some(tool=>tool.name==='dexter.harness.cli.run'));
  await assert.rejects(call('cli.run','grant-denied',ghArgs),refused);
  t.diagnostic(JSON.stringify({commandToolsExecuted:['python3','gh'],ghOperation:'--version',networkUsed:false,
   rootElevationUsed:false,hostUidPreserved:true,authentication:'not_checked',homePolicy:'isolated',executionBoundary:'owner_os_permissions'}));
 }finally{
  if(priorSentinel===undefined)delete process.env.DEXTER_CLI_PRIVATE_SENTINEL;else process.env.DEXTER_CLI_PRIVATE_SENTINEL=priorSentinel;
  if(priorGhToken===undefined)delete process.env.GH_TOKEN;else process.env.GH_TOKEN=priorGhToken;
  await surface?.close();
  if(turn&&services?.store.getTurn(turn.id).state==='running')services.store.finishTurn(turn.id,'completed',null);
  await services?.shutdown();rmSync(root,{recursive:true,force:true});
 }
});
