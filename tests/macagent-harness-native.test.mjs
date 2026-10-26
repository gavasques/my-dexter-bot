// Actual Swift CLI / pinned mutual TLS / owner HTTP / same conversation MCP bridge.
// Identity storage is the explicit memory-only laboratory replacement. No Keychain/TCC/native CUA claim.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chmodSync,copyFileSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes,X509Certificate} from 'node:crypto';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {test} from 'node:test';
import {createInterface} from 'node:readline';
const cuaMode=process.env.DEXTER_MACAGENT_CUA_MODE??'fixture';
const keychainMode=process.env.DEXTER_MACAGENT_KEYCHAIN_QA==='1';
if(!['fixture','native'].includes(cuaMode)||((cuaMode==='native'||keychainMode)&&process.env.DEXTER_MACAGENT_OPERATOR_GATE!=='fresh-own-QA-explicitly-authorized'))throw Error('Native operator QA requires Root-coordinated human authorization; default is fully synthetic.');
const operatorWait=async(code,instruction)=>{console.error('MANUAL_GATE '+code+': '+instruction+' Then type exactly '+code+'.');const reader=createInterface({input:process.stdin,output:process.stdout});const timer=setTimeout(()=>reader.close(),300000);try{for await(const line of reader){if(line.trim()===code)return;}throw Error('Manual operator step not confirmed.');}finally{clearTimeout(timer);reader.close();}};
const officialCommand=async(executable,config,operation)=>{const child=spawn(executable,['--config',config],{stdio:'pipe',env:{}});child.stderr.resume();const chunks=[];let length=0;child.stdout.on('data',b=>{length+=b.length;if(length>100000)child.kill('SIGTERM');else chunks.push(b);});child.stdin.end(JSON.stringify({operation}));return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('own official identity helper timed out'));},60000);child.once('error',reject);child.once('close',code=>{clearTimeout(timer);try{const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(code!==0||result.ok!==true)throw Error('own official identity helper refused');resolve(result);}catch(error){reject(error);}});});};
import {serve} from '@hono/node-server';
import {createHostApp} from '@dexter/hub/http';
import {createLabTlsIdentity,FILE_READ,FILE_APPEND,CUA_STATUS,CUA_OBSERVE,CUA_CONTROL} from '@dexter/devices';
import {HostServices} from '../packages/cli/dist/host-services.js';
import {installNativeMemoryTransport} from './fixtures/native-swift-memory-pipe.mjs';

const until=async(fn,ms=20000)=>{const deadline=Date.now()+ms;while(!fn()){if(Date.now()>deadline)throw Error('bounded QA deadline');await new Promise(r=>setTimeout(r,15));}};
class RPC {
  seq=0; pending=new Map();
  constructor(server){
    this.child=spawn(server.command,server.args,{stdio:'pipe',env:{PATH:'/usr/bin:/bin'}});let buffer='';this.child.stdin.on('error',()=>{});this.child.stderr.resume();
    this.child.stdout.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const end=buffer.indexOf('\n'),message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);const p=this.pending.get(message.id);if(p){this.pending.delete(message.id);message.error?p.reject(Error('MCP protocol refused')):p.resolve(message.result);}}});
    this.exited=new Promise(done=>this.child.once('close',()=>{for(const p of this.pending.values())p.reject(Error('MCP closed'));this.pending.clear();done();}));
  }
  call(method,params){const id=++this.seq;const response=new Promise((resolve,reject)=>this.pending.set(id,{resolve,reject}));this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return response;}
  async init(){await this.call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'macagent-owned-QA',version:'1'}});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');}
  async close(){this.child.stdin.end();await this.exited;}
}
class QAEngine {
  capabilities={resume:true,interrupt:true,fork:false,steer:false}; tools=[]; receipts=[];
  constructor(id,options,behavior){this.id=id;this.options=options;this.behavior=behavior;}
  async status(){return {engine:this.id,installed:true,version:'QA synthetic driver',authentication:'authenticated',billing:'subscription'};}
  async open(threadId,cursor){this.rpc=new RPC(this.options.localMcpServer);await this.rpc.init();this.tools=(await this.rpc.call('tools/list')).tools;return {threadId,nativeCursor:cursor??'qa-cursor'};}
  async *turn(session,turnId,input,signal){try{await this.behavior(this,signal,turnId,input);}catch(error){console.error('QA engine assertion',error);throw error;}yield {type:'text.delta',threadId:session.threadId,turnId,text:'QA response from canonical device receipts'};yield {type:'turn.completed',threadId:session.threadId,turnId,usage:{}};}
  async tool(tool,input,callId){const alias=this.tools.find(t=>t.title?.startsWith(tool));assert.ok(alias,tool+' must be registered through same MCP conversation');const response=await this.rpc.call('tools/call',{name:alias.name,arguments:{callId,input}});if(response.structuredContent)this.receipts.push(response.structuredContent);return response;}
  async interrupt(){} async respondToTool(){} async close(){await this.rpc?.close();}
}

test('same conversation owner publication -> actual Swift TLS helper -> selected file + real Swift CUA fixture -> receipts/response; revoke/offline/restart',async t=>{
  const base=resolve('../proof-runs');mkdirSync(base,{recursive:true,mode:0o700});
  const root=mkdtempSync(join(base,'native-harness-'));chmodSync(root,0o700);
  const helperDir=join(root,'helper');mkdirSync(helperDir,{mode:0o700});
  const executable=join(helperDir,'actual-cli');copyFileSync(resolve(keychainMode?'../build/device-identity/out/Products/Debug/dexter-device-identity':'../build/native-cli/actual-cli'),executable);chmodSync(executable,0o700);
  const host=createLabTlsIdentity({profile:'host',name:'macagent-qa-host',san:['IP:127.0.0.1']}).identity;
  let peer=createLabTlsIdentity({profile:'client',name:'macagent-qa-peer',san:['IP:127.0.0.1']}).identity;
  const tls=[];const original=https.createServer;
  https.createServer=(...args)=>{const server=original(...args);server.on('secureConnection',socket=>tls.push({protocol:socket.getProtocol(),resumed:socket.isSessionReused(),fingerprint:new X509Certificate(socket.getPeerCertificate().raw).fingerprint256.replaceAll(':','').toLowerCase()}));return server;};syncBuiltinESMExports();
  let behavior=async()=>{},engines=[];const requestedTurns=new Set();
  const services=new HostServices({dataDir:join(root,'host'),enableEngines:true,enableMcp:true,enableDeviceTools:true,devices:{identity:host,pollWaitMs:50,receiptTimeoutMs:30000},makeDriver(id,options){const engine=new QAEngine(id,options,async(native,signal,turnId,input)=>{if(requestedTurns.delete(turnId))await behavior(native,signal,turnId,input);});engines.push(engine);return engine;}});
  https.createServer=original;syncBuiltinESMExports();
  let agent,server,ownWindow;const transport=keychainMode?null:installNativeMemoryTransport(executable);const laboratoryID=keychainMode?randomBytes(16).toString('hex'):'0123456789abcdef0123456789abcdef';
  const messages=[];
  const stopAgent=async()=>{if(!agent)return;const child=agent;agent=null;if(child.connected)child.send({kind:'stop'});await new Promise((done,reject)=>{if(child.exitCode!==null)return done();const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('own agent drain timeout'));},25000);child.once('close',code=>{clearTimeout(timer);code===0?done():reject(Error('own agent failed'));});});};
  t.after(async()=>{const stopped=await Promise.allSettled([stopAgent()]);if(server)await new Promise(done=>server.close(done));await services.shutdown({graceMs:10000});transport?.restore();if(ownWindow&&ownWindow.exitCode===null){ownWindow.kill('SIGTERM');await new Promise(done=>ownWindow.once('close',done));}if(!keychainMode)rmSync(root,{recursive:true,force:true});if(stopped[0].status==='rejected')throw stopped[0].reason;});
  console.error('QA phase channel');const hostURL=await services.startDevices(),trust={hostUrl:hostURL,hostFingerprint:host.fingerprint,hostCertPem:host.certPem};
  const bot=services.store.createBot({name:'Macagent QA',profileId:'qa',engine:'claude'}),thread=services.store.createThread(bot.id);
  const selected=join(root,'own-file.txt');writeFileSync(selected,'own QA file\n',{mode:0o600});const stat=lstatSync(selected,{bigint:true});
  const policy=join(root,'files-policy.json');writeFileSync(policy,JSON.stringify({version:1,installationId:services.store.hostId,bots:[{botId:bot.id,files:[{name:'own.txt',path:selected,operations:[FILE_READ,FILE_APPEND],identity:{device:String(stat.dev),inode:String(stat.ino)},fence:'d'.repeat(32)}]}]}),{mode:0o600});
  const config=join(helperDir,'native.json');writeFileSync(config,JSON.stringify({installationID:services.store.hostId,laboratoryID,hostURL,hostCertificateDER:new X509Certificate(host.certPem).raw.toString('base64'),hostFingerprint:host.fingerprint}),{mode:0o600});if(transport)transport.register(config,peer);else{await operatorWait('provision-fresh-qa','Authorize provisioning only the fresh laboratory Keychain namespace '+laboratoryID+'; no existing identity/account.');const publicIdentity=await officialCommand(executable,config,'provision');peer={fingerprint:publicIdentity.fingerprint};}
  if(cuaMode==='native'){ownWindow=spawn(resolve('../build/MacagentOwnSurfaceQA.app/Contents/MacOS/MacagentOwnSurfaceQA'),[root,join(root,'own-window-state.json')],{stdio:'ignore',env:{}});await until(()=>existsSync(join(root,'own-window-state.json')));}
  const pkg=new URL('../packages/devices/dist/',import.meta.url);
  const modules={native:new URL('native-client.js',pkg).href,files:new URL('capabilities/files/policy.js',pkg).href,cua:new URL('capabilities/cua/transport.js',pkg).href,memory:new URL('./fixtures/native-swift-memory-pipe.mjs',import.meta.url).href};
  const script=`import{MacDeviceDaemon,pairDevice,createLocalCapabilities,LocalCapabilityPolicy}from${JSON.stringify(import.meta.resolve('@dexter/devices'))};
import{NativeDeviceClient}from${JSON.stringify(modules.native)};import{SelectedFilesPolicy}from${JSON.stringify(modules.files)};import{CuaHelperProcess}from${JSON.stringify(modules.cua)};
import{installInheritedNativeMemoryTransport}from${JSON.stringify(modules.memory)};
const transport=${keychainMode?'null':'installInheritedNativeMemoryTransport(3)'};let daemon,caps,helper,releaseWrite,heldWrite=false;
process.on('message',async m=>{try{if(m.kind==='start'){
const client=new NativeDeviceClient({executable:m.executable,configPath:m.config,installationID:m.installationId,identityMode:${JSON.stringify(keychainMode?'production':'laboratory-native')}});const identity=await client.loadOnly(20000);process.send({kind:'identity',fingerprint:identity.fingerprint,policy:identity.policy});
if(m.offer)await pairDevice({dataDir:m.dataDir,client,trust:m.trust,offerId:m.offer.offerId,code:m.offer.code,name:'Own native QA',capabilities:m.operations,timeoutMs:20000,pollIntervalMs:30});
helper=new CuaHelperProcess({executable:m.cuaHelper,mode:${JSON.stringify(cuaMode)}});helper.onEvent(event=>{if(event.event==='session_started'||event.event==='session_ended')process.send({kind:'cua-event',event});});
caps=createLocalCapabilities({dataDir:m.dataDir,policy:new LocalCapabilityPolicy({version:1,bots:[{botId:m.botId,label:'Own QA',operations:m.operations.filter(x=>x.startsWith('mac.cua.')),browserOrigins:[],cuaMaxSessionSeconds:120}]}),files:{policy:SelectedFilesPolicy.load(m.files,m.installationId)},cua:{transport:()=>helper}});
const handlers=new Map(caps.handlers),append=handlers.get('mac.file.append');handlers.set('mac.file.append',async(args,context)=>{if(args.line==='unknown-once'&&!heldWrite){heldWrite=true;process.send({kind:'before-unknown-write'});await new Promise(done=>{releaseWrite=done;});}const result=await append(args,context);if(args.line==='unknown-once')process.send({kind:'unknown-write-effect-completed'});return result;});
daemon=new MacDeviceDaemon({dataDir:m.dataDir,client,trust:m.trust,pollTimeoutMs:20000,handlers});daemon.start(()=>{});process.send({kind:'started'});
}else if(m.kind==='fixture'){if(${JSON.stringify(cuaMode)}!=='fixture')throw Error('fixture control is forbidden in native mode');const result=await helper.request({op:'fixture',command:m.command},new AbortController().signal,5000);process.send({kind:'fixture',requestId:m.requestId,result});}
else if(m.kind==='release-unknown-write'){releaseWrite?.();}
else if(m.kind==='stop'){await daemon?.stop();await caps?.close();await helper?.close(3000);transport?.restore();process.disconnect();}
}catch{process.send({kind:'failed'});process.exitCode=1;process.disconnect();}});`;
  const dataDir=join(root,'agent');mkdirSync(dataDir,{mode:0o700});
  const operations=[FILE_READ,FILE_APPEND,CUA_STATUS,CUA_OBSERVE,CUA_CONTROL];
  const startAgent=async offer=>{
    agent=spawn(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),stdio:['ignore','ignore','pipe','pipe','ipc'],env:{PATH:'/usr/bin:/bin'}});
    agent.stderr.on('data',data=>{if(process.env.DEXTER_QA_DEBUG==='1')process.stderr.write(data);});agent.on('message',message=>{messages.push(message);if(process.env.DEXTER_QA_DEBUG==='1')console.error('QA agent',message.kind);});
    if(transport){const bytes=transport.envelope(config);agent.stdio[3].end(bytes,()=>bytes.fill(0));}else agent.stdio[3].end();
    agent.send({kind:'start',executable,config,installationId:services.store.hostId,botId:bot.id,dataDir,trust,operations,files:policy,cuaHelper:resolve('../build/cua/out/Products/Debug/dexter-cua-helper'),offer});
    assert.notEqual(agent.pid,process.pid);
  };
  console.error('QA phase pair');const offer=services.devicesAdmin.pairingBundle({kind:'pair'});await startAgent(offer);
  await until(()=>services.devicesAdmin.pendingClaims().length===1||messages.some(m=>m.kind==='failed'));assert.equal(messages.some(m=>m.kind==='failed'),false);
  const claim=services.devicesAdmin.pendingClaims()[0];assert.equal(claim.clientFingerprint,peer.fingerprint);if(keychainMode)await operatorWait('pair-pin-compared','Compare fresh helper public fingerprint '+peer.fingerprint+' with the pending claim. Approve this QA identity only.');const approved=services.devicesAdmin.approveClaim(claim.claimId);const deviceId=approved.deviceId;
  await until(()=>services.devicesHttp.get(deviceId).presence==='online'||messages.some(m=>m.kind==='failed'));assert.equal(messages.some(m=>m.kind==='failed'),false);
  console.error('QA phase owner HTTP');const app=createHostApp(services.store,{runtime:services.runtime,devices:services.peersHttp,deviceRoutes:services.deviceRoutesHttp,deviceGrants:services.deviceGrantsHttp});
  server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});await new Promise(done=>server.once('listening',done));const baseURL=`http://127.0.0.1:${server.address().port}`;
  const patch=async(tool,requestId,revision=null,status='active')=>{
    const input={expectedHostId:services.store.hostId,clientRequestId:requestId,botId:bot.id,deviceId,tool,expectedRevision:revision,status};
    const response=await fetch(baseURL+'/v1/device-routes',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});assert.equal(response.status,200);return response.json();
  };
  const routes={};for(const tool of operations)routes[tool]=await patch(tool,'publish-'+tool);
  assert.equal(services.store.getGrant(bot.id,FILE_READ,deviceId),null);
  let noAlias=false;behavior=async e=>{noAlias=!e.tools.some(t=>t.title?.startsWith(FILE_READ));};
  let turn=services.runtime.startTurn(thread.id,{clientRequestId:'before-grant',content:'QA'}).turn;requestedTurns.add(turn.id);await services.runtime.waitForTurn(turn.id);assert.equal(noAlias,true);
  for(const tool of operations)services.devicesAdmin.grant({botId:bot.id,tool,destination:deviceId,policy:'allow'});
  let sequence=0;const run=async (fn,approveStatus=false)=>{behavior=fn;const turn=services.runtime.startTurn(thread.id,{clientRequestId:'qa-'+(++sequence),content:'QA synthetic conversation'}).turn;requestedTurns.add(turn.id);
    const approval=approveStatus?(async()=>{let action;await until(()=>{action=services.store.listActions().find(a=>a.state==='awaiting_approval'&&a.request.tool===CUA_STATUS);return Boolean(action);});assert.equal(action.request.botId,bot.id);assert.equal(action.request.threadId,thread.id);assert.equal(action.request.destination,deviceId);
      const response=await fetch(baseURL+'/v1/actions/'+action.id+'/decisions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision:'allow',requestHash:action.requestHash})});assert.equal(response.status,200);})():Promise.resolve();void approval.catch(()=>{});
    assert.equal((await services.runtime.waitForTurn(turn.id,60000)).state,'completed');await approval;return turn;};
  console.error('QA phase selected read');let readReceipt;
  await run(async e=>{const reply=await e.tool(FILE_READ,{name:'own.txt'},'read-own');assert.equal(reply.isError,false);readReceipt=reply.structuredContent;assert.equal(readReceipt.result.result.text,'own QA file\n');assert.equal((await e.tool(FILE_READ,{name:'own.txt'},'read-own')).structuredContent.actionId,readReceipt.actionId);});
  await run(async e=>{const a=await e.tool(FILE_APPEND,{name:'own.txt',line:'once'},'append-own');assert.equal(a.structuredContent.status,'succeeded');await e.tool(FILE_APPEND,{name:'own.txt',line:'once'},'append-own');});assert.equal(readFileSync(selected,'utf8'),'own QA file\nonce\n');
  console.error('QA phase CUA '+cuaMode);if(cuaMode==='native')await operatorWait('calibrated-by-operator','Grant current macOS permissions to this fresh QA helper if needed; complete its real false -> true -> false lock calibration and final local confirmation. No --calibrated flag or TCC reset.');let statusReceipt,observeReceipt,controlReceipt;
  await run(async e=>{statusReceipt=(await e.tool(CUA_STATUS,{},'consent-request')).structuredContent;assert.equal(statusReceipt.result.result.state,'consent_pending');},true);
  if(cuaMode==='fixture'){agent.send({kind:'fixture',command:'approve_consent',requestId:'approve'});await until(()=>messages.some(m=>m.kind==='fixture'&&m.requestId==='approve'));assert.equal(messages.find(m=>m.requestId==='approve').result.ok,true);}else{await operatorWait('own-surface-approved','Choose only Macagent Own Surface QA in the native consent panel, approve it, and check the visible Stop indicator.');await until(()=>messages.some(m=>m.kind==='cua-event'&&m.event.event==='session_started'));const sessionEvent=messages.find(m=>m.kind==='cua-event'&&m.event.event==='session_started').event;assert.equal(sessionEvent.session.surfaceLabel,'Macagent Own Surface QA');assert.equal(sessionEvent.session.indicatorVisible,true);}
  await run(async e=>{const active=(await e.tool(CUA_STATUS,{},'session-status')).structuredContent;assert.equal(active.result.result.state,'active');const surfaceId=active.result.result.session.surfaceId;
    observeReceipt=(await e.tool(CUA_OBSERVE,{surfaceId,maxNodes:100},'observe-own')).structuredContent;assert.equal(observeReceipt.status,'succeeded');
    let elementId='el_1';if(cuaMode==='native'){assert.equal(observeReceipt.result.result.surface.label,'Macagent Own Surface QA');const button=observeReceipt.result.result.nodes.find(n=>n.role==='AXButton'&&n.title==='QA Press once');assert.ok(button,'Only the explicit owned QA button may be pressed');elementId=button.elementId;}
    controlReceipt=(await e.tool(CUA_CONTROL,{surfaceId,elementId,action:'press'},'press-own')).structuredContent;assert.equal(controlReceipt.status,'succeeded');
    const replay=(await e.tool(CUA_CONTROL,{surfaceId,elementId:'el_1',action:'press'},'press-own')).structuredContent;assert.equal(replay.actionId,controlReceipt.actionId);
  },true);
  if(cuaMode==='fixture'){agent.send({kind:'fixture',command:'stop',requestId:'stop'});await until(()=>messages.some(m=>m.requestId==='stop'));}else{await until(()=>JSON.parse(readFileSync(join(root,'own-window-state.json'),'utf8')).pressCount===1);await operatorWait('operator-stopped','Click Stop in the native helper indicator. Confirm it ends; no rollback is asserted.');await until(()=>messages.some(m=>m.kind==='cua-event'&&m.event.event==='session_ended'&&m.event.reason==='operator_stop'));}
  // An admitted selected-file write may occur after host cancellation. Persist unknown, never promise rollback/replay.
  behavior=async e=>{try{await e.tool(FILE_APPEND,{name:'own.txt',line:'unknown-once'},'unknown-write');}catch{/* RPC interruption does not prove rollback. */}};
  const unknownInput={clientRequestId:'qa-unknown-write',content:'QA one bounded uncertain write'},unknownTurn=services.runtime.startTurn(thread.id,unknownInput).turn;requestedTurns.add(unknownTurn.id);
  await until(()=>messages.some(m=>m.kind==='before-unknown-write'));
  const unknownAction=services.store.listActions().find(a=>a.request.arguments.line==='unknown-once');assert.equal(unknownAction.state,'running');
  services.runtime.cancelTurn(unknownTurn.id);await services.runtime.waitForTurn(unknownTurn.id);await until(()=>services.store.getAction(unknownAction.id).state==='unknown');
  agent.send({kind:'release-unknown-write'});await until(()=>messages.some(m=>m.kind==='unknown-write-effect-completed'));
  assert.equal(readFileSync(selected,'utf8'),'own QA file\nonce\nunknown-once\n');
  assert.equal(services.runtime.startTurn(thread.id,unknownInput).turn.id,unknownTurn.id);
  const unknownReplay=await fetch(baseURL+'/v1/actions/'+unknownAction.id+'/dispatch',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(unknownReplay.status,403);
  services.devicesAdmin.grant({botId:bot.id,tool:FILE_READ,destination:deviceId,policy:'deny'});await run(async e=>assert.equal(e.tools.some(t=>t.title?.startsWith(FILE_READ)),false));
  const suspended=await patch(FILE_APPEND,'suspend-append',routes[FILE_APPEND].route.revision,'suspended');await run(async e=>assert.equal(e.tools.some(t=>t.title?.startsWith(FILE_APPEND)),false));
  console.error('QA phase offline/restart');await stopAgent();const realNow=services.store.now.bind(services.store);services.store.now=()=>realNow()+services.store.deviceTtlMs+1;await until(()=>services.devicesHttp.get(deviceId).presence==='stale',10000);
  const actionsBefore=services.store.listActions().length;
  await patch(FILE_APPEND,'resume-append',suspended.route.revision);
  await run(async e=>{const reply=await e.tool(FILE_APPEND,{name:'own.txt',line:'offline'},'offline');assert.equal(reply.isError,true);});assert.equal(services.store.listActions().length,actionsBefore);
  services.store.now=realNow;const previousSeen=services.devicesHttp.get(deviceId).lastSeenAt;await startAgent(null);await until(()=>messages.filter(m=>m.kind==='started').length>=2||messages.some(m=>m.kind==='failed'));await until(()=>services.devicesHttp.get(deviceId).presence==='online'&&services.devicesHttp.get(deviceId).lastSeenAt>previousSeen||messages.some(m=>m.kind==='failed'));assert.equal(messages.some(m=>m.kind==='failed'),false);
  const originalReceipt=await fetch(baseURL+'/v1/device-routes/receipts/publish-mac.file.read');assert.deepEqual(await originalReceipt.json(),routes[FILE_READ]);
  assert.equal(readFileSync(selected,'utf8'),'own QA file\nonce\nunknown-once\n');assert.equal(services.store.getAction(unknownAction.id).state,'unknown');
  services.devicesHttp.revoke(deviceId);await run(async e=>assert.equal(e.tools.some(t=>t.title?.startsWith(FILE_APPEND)),false));
  assert.ok(tls.length>6);assert.ok(tls.every(s=>s.protocol==='TLSv1.3'&&!s.resumed&&s.fingerprint===peer.fingerprint));
  assert.ok(messages.filter(m=>m.kind==='identity').length>=2);assert.ok(messages.filter(m=>m.kind==='identity').every(m=>m.policy===(keychainMode?'secure_enclave_data_protection_keychain_device_only':'cli_forwarding_laboratory_memory_only')&&m.fingerprint===peer.fingerprint));
  const proof={status:'passed',scope:'QA engine/selected own file + actual Swift CLI/TLS1.3/MCP/HostServices/HTTP; CUA '+cuaMode+'; identity '+(keychainMode?'fresh laboratory Keychain':'memory-only laboratory'),realKeychain:keychainMode,realTCC:cuaMode==='native',realCUASurface:cuaMode==='native',keychainQaNamespace:keychainMode?laboratoryID:null,keychainCleanupRequired:keychainMode,operatorConfiguration:keychainMode?config:null,realProviderInference:false,firstCapability:FILE_READ,selectedFileReadReceipt:readReceipt,CUA:{statusReceipt,observeReceipt,controlReceipt,fixtureConsent:cuaMode==='fixture',fixtureStop:cuaMode==='fixture'},tlsConnections:tls.length,tls13Only:true,tlsResumption:false,daemonRestarts:1,originalReceiptRecovered:true,noImplicitGrant:true,offlinePreclaimNoAction:true,revokeSuppressesAlias:true,appendExactlyOnce:true,unknownWrite:{state:'unknown',observedOwnEffectCount:1,automaticReplay:false,turnReplayOriginal:true,boundDispatchRefused:true,rollbackClaim:false},canonicalActions:services.store.listActions().length,conversationResponseObserved:services.store.listMessages(thread.id).some(m=>m.content.includes('canonical device receipts'))};
  await stopAgent();await new Promise(done=>server.close(done));server=null;await services.shutdown({graceMs:10000});
  proof.ownedProcessesAndHostDrained=true;writeFileSync(resolve(cuaMode==='native'||keychainMode?'../proof-native-operator.json':'../proof-native-harness.json'),JSON.stringify(proof,null,2)+'\n');
});
